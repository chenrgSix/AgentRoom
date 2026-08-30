package controller

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"convenewire.dev/convenewirectl/internal/releaseimage"
)

type fakeRunner struct {
	commands                        []Command
	failOnce                        map[string]int
	hook                            func(Command)
	rotationAcknowledgementResponse string
	activeServerImageID             string
	activeCaddyImageID              string
	configuredServerImageID         string
	configuredCaddyImageID          string
	runtimeBuildIdentity            string
	activeRuntimeReleaseVersion     string
	activeRuntimeSourceCommit       string
	serverStopped                   bool
	caddyStopped                    bool
	stopServerAfterUp               bool
	stopCaddyAfterUp                bool
	runtimeImageStore               string
	unavailableImageReferences      map[string]bool
	backupSequence                  int
}

func (runner *fakeRunner) Run(_ context.Context, command Command) (string, error) {
	runner.commands = append(runner.commands, command)
	if runner.hook != nil {
		runner.hook(command)
	}
	joined := command.Name + " " + strings.Join(command.Args, " ")
	for token, remaining := range runner.failOnce {
		if remaining > 0 && strings.Contains(joined, token) {
			runner.failOnce[token] = remaining - 1
			return "bounded failure", fmt.Errorf("injected %s failure", token)
		}
	}
	if command.Name == "docker" && len(command.Args) >= 1 && command.Args[0] == "version" {
		return "27.5.1\n", nil
	}
	if command.Name == "docker" && len(command.Args) >= 3 &&
		command.Args[0] == "compose" && command.Args[1] == "version" {
		return "2.33.1\n", nil
	}
	if command.Name == "docker" && len(command.Args) >= 3 &&
		command.Args[0] == "image" && command.Args[1] == "inspect" {
		reference := command.Args[len(command.Args)-1]
		if runner.unavailableImageReferences[reference] ||
			!runner.runtimeImageReferenceAvailable(reference) {
			return "", fmt.Errorf("unknown test runtime image reference %q", reference)
		}
		if strings.Contains(joined, "{{.Id}}") {
			if imageID := testRuntimeImageID(reference); imageID != "" {
				return imageID + "\n", nil
			}
			return "", fmt.Errorf("unknown test runtime image reference %q", reference)
		}
		return "linux/amd64\n", nil
	}
	if command.Name == "docker" && strings.Contains(joined, " up -d ") {
		for index, argument := range command.Args {
			if argument != "--env-file" || index+1 >= len(command.Args) {
				continue
			}
			value, err := os.ReadFile(command.Args[index+1])
			if err != nil {
				break
			}
			for _, line := range strings.Split(string(value), "\n") {
				key, rawValue, found := strings.Cut(line, "=")
				if !found {
					continue
				}
				switch key {
				case "CONVENE_WIRE_RELEASE_VERSION":
					runner.activeRuntimeReleaseVersion = strings.Trim(rawValue, `"`)
				case "CONVENE_WIRE_SOURCE_COMMIT":
					runner.activeRuntimeSourceCommit = strings.Trim(rawValue, `"`)
				case "CONVENE_WIRE_SERVER_IMAGE":
					runner.configuredServerImageID = testRuntimeImageID(strings.Trim(rawValue, `"`))
				case "CONVENE_WIRE_CADDY_IMAGE":
					runner.configuredCaddyImageID = testRuntimeImageID(strings.Trim(rawValue, `"`))
				}
			}
			break
		}
		runner.serverStopped = runner.stopServerAfterUp
		runner.caddyStopped = runner.stopCaddyAfterUp
	}
	if command.Name == "docker" && len(command.Args) >= 5 &&
		command.Args[0] == "container" && command.Args[1] == "inspect" {
		if strings.Contains(joined, strings.Repeat("a", 64)) {
			if runner.activeServerImageID != "" {
				return runner.activeServerImageID + "\n", nil
			}
			return runner.configuredServerImageID + "\n", nil
		}
		if runner.activeCaddyImageID != "" {
			return runner.activeCaddyImageID + "\n", nil
		}
		return runner.configuredCaddyImageID + "\n", nil
	}
	if command.Name == "docker" && len(command.Args) >= 2 &&
		command.Args[0] == "exec" {
		if runner.runtimeBuildIdentity != "" {
			return runner.runtimeBuildIdentity, nil
		}
		return fmt.Sprintf(
			"convenewire_build_info{release_version=%q,source_commit=%q} 1\n",
			runner.activeRuntimeReleaseVersion,
			runner.activeRuntimeSourceCommit,
		), nil
	}
	if strings.Contains(joined, " images ") {
		return `{"Repository":"convenewire/server","Tag":"target"}` + "\n", nil
	}
	if strings.Contains(joined, " ps --quiet agentroom") {
		if runner.serverStopped {
			return "", nil
		}
		return strings.Repeat("a", 64) + "\n", nil
	}
	if strings.Contains(joined, " ps --quiet caddy") {
		if runner.caddyStopped {
			return "", nil
		}
		return strings.Repeat("b", 64) + "\n", nil
	}
	if strings.Contains(joined, " ps ") {
		return `[{"Service":"agentroom","State":"running"}]` + "\n", nil
	}
	if strings.Contains(joined, "device_private_ca_rotation_acknowledgements") {
		if runner.rotationAcknowledgementResponse != "" {
			return runner.rotationAcknowledgementResponse, nil
		}
		return `{"eligible":0,"acknowledged":0}`, nil
	}
	if command.Name == "bash" && strings.Contains(joined, "compose-backup.sh") {
		runner.backupSequence++
		backupDirectory := command.Env["CONVENE_WIRE_BACKUP_DIR"]
		if err := os.MkdirAll(backupDirectory, 0o700); err != nil {
			return "", err
		}
		backupPath := filepath.Join(
			backupDirectory,
			fmt.Sprintf("convene-wire-test-%03d.sqlite", runner.backupSequence),
		)
		contents := []byte(fmt.Sprintf("verified-backup-%03d\n", runner.backupSequence))
		if err := os.WriteFile(backupPath, contents, 0o600); err != nil {
			return "", err
		}
		digest := sha256.Sum256(contents)
		return fmt.Sprintf(
			"%s  %s\n",
			hex.EncodeToString(digest[:]),
			backupPath,
		), nil
	}
	if command.Name == "bash" && strings.Contains(joined, "compose-restore.sh") {
		return "Set CONVENE_WIRE_DATABASE_PATH=/data/restored.sqlite, then run docker compose up -d.\n", nil
	}
	return "", nil
}

func (runner *fakeRunner) runtimeImageReferenceAvailable(reference string) bool {
	isConfigDigest := runtimeImageIDPattern.MatchString(reference)
	isManifestDigest := runtimeImagePattern.MatchString(reference)
	switch runner.runtimeImageStore {
	case "containerd":
		return isManifestDigest
	case "both":
		return isConfigDigest || isManifestDigest
	default:
		return isConfigDigest
	}
}

func testRuntimeImageID(reference string) string {
	if runtimeImageIDPattern.MatchString(reference) {
		return reference
	}
	if runtimeImagePattern.MatchString(reference) {
		_, digest, _ := strings.Cut(reference, "@")
		return digest
	}
	return ""
}

func writeTestCA(t *testing.T, path string, now time.Time) string {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "ConveneWire test CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	der, err := x509.CreateCertificate(cryptorand.Reader, template, template, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	value := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(path, value, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(der)
	return hex.EncodeToString(digest[:])
}

func startHostReadinessServer(
	t *testing.T,
	hostname string,
	now time.Time,
) (string, string, string) {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(11), Subject: pkix.Name{CommonName: "ConveneWire readiness CA"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	caDER, err := x509.CreateCertificate(
		cryptorand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	caCertificate, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), cryptorand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(12), Subject: pkix.Name{CommonName: hostname},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(12 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:    []string{hostname},
	}
	leafDER, err := x509.CreateCertificate(
		cryptorand.Reader, leafTemplate, caCertificate, &leafKey.PublicKey, caKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	leafKeyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: leafKeyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/health/ready":
			response.WriteHeader(http.StatusOK)
		case "/ws/bridge":
			response.WriteHeader(http.StatusUnauthorized)
		default:
			http.NotFound(response, request)
		}
	}))
	server.TLS = &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}}
	server.StartTLS()
	t.Cleanup(server.Close)
	_, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "https://"))
	if err != nil {
		t.Fatal(err)
	}
	caPath := filepath.Join(t.TempDir(), "root.crt")
	if err := os.WriteFile(
		caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0o600,
	); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(caDER)
	return "https://" + net.JoinHostPort(hostname, port), caPath, hex.EncodeToString(digest[:])
}

func testDependencies(runner *fakeRunner, output *bytes.Buffer) Dependencies {
	return Dependencies{
		Runner: runner, GOOS: "linux", GOARCH: "amd64",
		Random:         bytes.NewReader(bytes.Repeat([]byte{0x5a}, 256)),
		Now:            func() time.Time { return time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC) },
		CheckPorts:     func(string, ...int) error { return nil },
		FreeSpace:      func(string) (uint64, error) { return 4 << 30, nil },
		CheckReadiness: func(context.Context, ReadinessInput) error { return nil },
		Output:         output,
	}
}

func installOptions(releaseDir, dataRoot string) InstallOptions {
	checksums, err := os.ReadFile(filepath.Join(releaseDir, "SHA256SUMS"))
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(checksums)
	return InstallOptions{
		ReleaseDir: releaseDir, ChecksumsSHA256: hex.EncodeToString(digest[:]),
		DataRoot: dataRoot,
		Mode:     "local", Domain: "localhost",
		PublicOrigin: "https://localhost:19443",
		HTTPPort:     19080, HTTPSPort: 19443,
		ProjectName: "convenewire-test",
	}
}

func checksumPin(releaseDir string) string {
	value, err := os.ReadFile(filepath.Join(releaseDir, "SHA256SUMS"))
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func createRelease(t *testing.T, parent, version string, dataSchema int) string {
	return createReleaseForTarget(t, parent, version, dataSchema, "linux", "amd64")
}

func createReleaseForTarget(t *testing.T, parent, version string, dataSchema int, targetOS, targetArch string) string {
	t.Helper()
	releaseDir := filepath.Join(parent, strings.ReplaceAll(version, ".", "_")+"_"+targetOS+"_"+targetArch)
	files := map[string]string{
		"convenewire-central-release.json": fmt.Sprintf(
			"{\"schemaVersion\":1,\"releaseVersion\":%q,\"dataSchemaVersion\":%d,\"sourceCommit\":%q,\"targetOS\":%q,\"targetArch\":%q}\n",
			version, dataSchema, strings.Repeat("a", 40), targetOS, targetArch,
		),
		"compose.yaml":                       "services: {}\n",
		"Dockerfile":                         "FROM scratch\n",
		"package.json":                       "{}\n",
		"package-lock.json":                  "{}\n",
		"deploy/Caddyfile":                   "https://example.invalid {}\n",
		"deploy/tls/public-ca.caddy":         "tls {\n  issuer acme\n}\n",
		"deploy/tls/private-scoped-ca.caddy": "tls internal\n",
		"deploy/tls/internal-ca.caddy":       "tls internal\n",
		"deploy/tls/legacy-auto.caddy":       "# legacy\n",
		"deploy/tls/pki-none.caddy":          "# no named authorities\n",
		"scripts/compose-backup.sh":          "#!/usr/bin/env bash\nexit 0\n",
		"scripts/compose-restore.sh":         "#!/usr/bin/env bash\nexit 0\n",
		"apps/server/source.ts":              "export {};\n",
	}
	for name, value := range files {
		path := filepath.Join(releaseDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	var checksums strings.Builder
	for _, name := range names {
		value := sha256.Sum256([]byte(files[name]))
		fmt.Fprintf(&checksums, "%s  %s\n", hex.EncodeToString(value[:]), name)
	}
	if err := os.WriteFile(filepath.Join(releaseDir, "SHA256SUMS"), []byte(checksums.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return releaseDir
}

func createOCIRelease(t *testing.T, parent, version string, dataSchema int) string {
	t.Helper()
	releaseDir := createRelease(t, parent, version, dataSchema)
	const sourceCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	type testDescriptor struct {
		MediaType   string            `json:"mediaType"`
		Digest      string            `json:"digest"`
		Size        int64             `json:"size"`
		Annotations map[string]string `json:"annotations,omitempty"`
		Platform    map[string]string `json:"platform,omitempty"`
	}
	blobs := map[string][]byte{}
	images := make([]releaseimage.ImageMetadata, 0, 2)
	descriptors := make([]testDescriptor, 0, 2)
	addBlob := func(value []byte) testDescriptor {
		digest := sha256.Sum256(value)
		hexDigest := hex.EncodeToString(digest[:])
		blobs[hexDigest] = value
		return testDescriptor{Digest: "sha256:" + hexDigest, Size: int64(len(value))}
	}
	attestations := map[string][]byte{}
	for _, identity := range []struct {
		role       string
		repository string
	}{
		{role: releaseimage.ServerRole, repository: releaseimage.ServerRepository},
		{role: releaseimage.CaddyRole, repository: releaseimage.CaddyRepository},
	} {
		configBytes, err := json.Marshal(map[string]any{
			"architecture": "amd64", "os": "linux",
			"config": map[string]any{"Labels": map[string]string{
				"org.opencontainers.image.revision": sourceCommit,
				"org.opencontainers.image.version":  version,
				"org.opencontainers.image.title":    identity.repository,
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		config := addBlob(configBytes)
		config.MediaType = releaseimage.OCIConfigMediaType
		manifestBytes, err := json.Marshal(map[string]any{
			"schemaVersion": 2,
			"mediaType":     releaseimage.OCIManifestMediaType,
			"config":        config,
			"layers":        []any{},
		})
		if err != nil {
			t.Fatal(err)
		}
		manifest := addBlob(manifestBytes)
		manifest.MediaType = releaseimage.OCIManifestMediaType
		manifest.Annotations = map[string]string{
			"io.containerd.image.name":          "docker.io/" + identity.repository + ":" + version,
			"org.opencontainers.image.ref.name": version,
		}
		manifest.Platform = map[string]string{"os": "linux", "architecture": "amd64"}
		descriptors = append(descriptors, manifest)
		sbomBytes, err := json.MarshalIndent(map[string]any{
			"_type": "https://in-toto.io/Statement/v1",
			"subject": []any{map[string]any{
				"name":   identity.repository,
				"digest": map[string]string{"sha256": strings.TrimPrefix(manifest.Digest, "sha256:")},
			}},
			"predicateType": releaseimage.SPDXPredicateType,
			"predicate": map[string]any{
				"spdxVersion": "SPDX-2.3", "SPDXID": "SPDXRef-DOCUMENT", "packages": []any{},
			},
		}, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		sbomBytes = append(sbomBytes, '\n')
		sbomPath := "attestations/" + identity.role + ".sbom.spdx.json"
		attestations[sbomPath] = sbomBytes
		sbomDigest := sha256.Sum256(sbomBytes)
		images = append(images, releaseimage.ImageMetadata{
			Role: identity.role, Repository: identity.repository,
			Digest: manifest.Digest, Reference: identity.repository + "@" + manifest.Digest,
			RuntimeReference: config.Digest,
			SBOM: releaseimage.Attestation{
				Path: sbomPath, SHA256: hex.EncodeToString(sbomDigest[:]),
				PredicateType: releaseimage.SPDXPredicateType,
			},
		})
	}
	provenanceSubjects := make([]any, 0, len(images))
	for _, image := range images {
		provenanceSubjects = append(provenanceSubjects, map[string]any{
			"name":   image.Repository,
			"digest": map[string]string{"sha256": strings.TrimPrefix(image.Digest, "sha256:")},
		})
	}
	provenanceBytes, err := json.MarshalIndent(map[string]any{
		"_type": "https://in-toto.io/Statement/v1", "subject": provenanceSubjects,
		"predicateType": releaseimage.SLSAPredicateType,
		"predicate": map[string]any{
			"buildDefinition": map[string]any{
				"buildType": "https://convenewire.dev/buildtypes/central-oci-bundle/v1",
				"externalParameters": map[string]string{
					"releaseVersion": version, "sourceCommit": sourceCommit, "platform": "linux/amd64",
				},
				"resolvedDependencies": []any{map[string]any{
					"uri":    releaseimage.SourceRepositoryURI,
					"digest": map[string]string{"gitCommit": sourceCommit},
				}, map[string]any{
					"uri": "oci://" + releaseimage.SBOMGenerator,
					"digest": map[string]string{
						"sha256": strings.TrimPrefix(strings.SplitN(releaseimage.SBOMGenerator, "@", 2)[1], "sha256:"),
					},
				}},
			},
			"runDetails": map[string]any{"builder": map[string]string{"id": "test://controller"}},
		},
	}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	provenanceBytes = append(provenanceBytes, '\n')
	const provenancePath = "attestations/provenance.slsa.json"
	attestations[provenancePath] = provenanceBytes
	provenanceDigest := sha256.Sum256(provenanceBytes)

	indexBytes, err := json.Marshal(map[string]any{
		"schemaVersion": 2, "mediaType": releaseimage.OCIIndexMediaType, "manifests": descriptors,
	})
	if err != nil {
		t.Fatal(err)
	}
	dockerManifest := make([]any, 0, len(images))
	for _, image := range images {
		dockerManifest = append(dockerManifest, map[string]any{
			"Config":   "blobs/sha256/" + strings.TrimPrefix(image.RuntimeReference, "sha256:"),
			"RepoTags": []string{image.Repository + ":" + version},
			"Layers":   []string{},
		})
	}
	dockerManifestBytes, err := json.Marshal(dockerManifest)
	if err != nil {
		t.Fatal(err)
	}
	versionWithoutPrefix := strings.TrimPrefix(version, "v")
	archiveName := "convenewire-central-image_" + versionWithoutPrefix + "_linux_amd64.oci.tar"
	metadataName := "convenewire-central-image_" + versionWithoutPrefix + "_linux_amd64.metadata.json"
	imageDir := filepath.Join(releaseDir, "image")
	if err := os.MkdirAll(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	archivePath := filepath.Join(imageDir, archiveName)
	archiveFile, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	tarWriter := tar.NewWriter(archiveFile)
	entries := map[string][]byte{
		"oci-layout":    []byte("{\"imageLayoutVersion\":\"1.0.0\"}\n"),
		"index.json":    append(indexBytes, '\n'),
		"manifest.json": append(dockerManifestBytes, '\n'),
	}
	for digest, value := range blobs {
		entries["blobs/sha256/"+digest] = value
	}
	for name, value := range attestations {
		entries[name] = value
	}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value := entries[name]
		if err := tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(value)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write(value); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := archiveFile.Close(); err != nil {
		t.Fatal(err)
	}
	archiveSHA, err := digestFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	metadata := releaseimage.Metadata{
		SchemaVersion:  releaseimage.MetadataSchemaVersion,
		ReleaseVersion: version, SourceCommit: sourceCommit, Platform: "linux/amd64",
		Archive: "image/" + archiveName, ArchiveSHA256: archiveSHA,
		Images: images, BuilderID: "test://controller", SBOMGenerator: releaseimage.SBOMGenerator,
		Provenance: releaseimage.Attestation{
			Path: provenancePath, SHA256: hex.EncodeToString(provenanceDigest[:]),
			PredicateType: releaseimage.SLSAPredicateType,
		},
	}
	metadataBytes, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(imageDir, metadataName), append(metadataBytes, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	releaseMetadata := fmt.Sprintf(
		"{\"schemaVersion\":2,\"releaseVersion\":%q,\"dataSchemaVersion\":%d,\"sourceCommit\":%q,\"targetOS\":\"linux\",\"targetArch\":\"amd64\",\"imageMetadata\":%q}\n",
		version, dataSchema, sourceCommit, "image/"+metadataName,
	)
	if err := os.WriteFile(filepath.Join(releaseDir, "convenewire-central-release.json"), []byte(releaseMetadata), 0o644); err != nil {
		t.Fatal(err)
	}
	rewriteTestReleaseChecksums(t, releaseDir)
	return releaseDir
}

func rewriteTestReleaseChecksums(t *testing.T, releaseDir string) {
	t.Helper()
	names := []string{}
	err := filepath.WalkDir(releaseDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Base(path) == "SHA256SUMS" {
			return nil
		}
		relative, err := filepath.Rel(releaseDir, path)
		if err != nil {
			return err
		}
		names = append(names, relative)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	var checksums strings.Builder
	for _, name := range names {
		digest, err := digestFile(filepath.Join(releaseDir, name))
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&checksums, "%s  %s\n", digest, name)
	}
	if err := os.WriteFile(filepath.Join(releaseDir, "SHA256SUMS"), []byte(checksums.String()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func requireActionCode(t *testing.T, err error, code string) *ActionError {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s error", code)
	}
	var action *ActionError
	if !errors.As(err, &action) {
		t.Fatalf("expected ActionError, got %T: %v", err, err)
	}
	if action.Code != code {
		t.Fatalf("expected %s, got %s: %v", code, action.Code, err)
	}
	return action
}

func TestReleaseVerificationAcceptsOneLegacyMetadataNameAndRejectsBoth(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	currentPath := filepath.Join(releaseDir, "convenewire-central-release.json")
	legacyPath := filepath.Join(releaseDir, "agentroom-central-release.json")
	if err := os.Rename(currentPath, legacyPath); err != nil {
		t.Fatal(err)
	}
	rewriteTestReleaseChecksums(t, releaseDir)
	metadata, _, err := verifyRelease(
		releaseDir, filepath.Join(releaseDir, "SHA256SUMS"), checksumPin(releaseDir),
	)
	if err != nil || metadata.ReleaseVersion != "v1.2.3" {
		t.Fatalf("intact pre-rename release metadata was rejected: %+v %v", metadata, err)
	}
	legacy, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(currentPath, legacy, 0o644); err != nil {
		t.Fatal(err)
	}
	rewriteTestReleaseChecksums(t, releaseDir)
	requireActionCode(t, func() error {
		_, _, err := verifyRelease(
			releaseDir, filepath.Join(releaseDir, "SHA256SUMS"), checksumPin(releaseDir),
		)
		return err
	}(), "RELEASE_METADATA_INVALID")
}

func TestInstallIsReentrantAndKeepsSecretsOutOfConfiguration(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	var output bytes.Buffer
	portChecks := 0
	dependencies := testDependencies(runner, &output)
	dependencies.CheckPorts = func(bind string, ports ...int) error {
		portChecks++
		if bind != "127.0.0.1" || len(ports) != 2 {
			t.Fatalf("unexpected port check: %s %v", bind, ports)
		}
		return nil
	}
	control := New(dependencies)
	first, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	secretBefore, err := os.ReadFile(first.OwnerSecretPath)
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(first.OwnerSecretPath); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("owner secret mode: %v %v", info, err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "data", "agent-room.sqlite"), []byte("database-marker"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifestBefore := first.Manifest
	second, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	secretAfter, _ := os.ReadFile(second.OwnerSecretPath)
	if !bytes.Equal(secretBefore, secretAfter) {
		t.Fatal("reentry changed the Owner recovery secret")
	}
	if marker, _ := os.ReadFile(filepath.Join(dataRoot, "data", "agent-room.sqlite")); string(marker) != "database-marker" {
		t.Fatal("reentry changed the existing database")
	}
	if second.Manifest.InstalledAt != manifestBefore.InstalledAt || second.Manifest.ReleaseDigest != manifestBefore.ReleaseDigest {
		t.Fatal("reentry changed installation identity")
	}
	if portChecks != 1 {
		t.Fatalf("running reentry must not claim service ports again: %d", portChecks)
	}
	environment, _ := os.ReadFile(second.EnvironmentPath)
	if bytes.Contains(environment, bytes.TrimSpace(secretBefore)) || bytes.Contains(environment, []byte("CONVENE_WIRE_BRIDGE_SERVER_TOKEN")) {
		t.Fatal("generated environment retained a plaintext authority secret")
	}
	if !bytes.Contains(environment, []byte("CONVENE_WIRE_BIND_ADDRESS=127.0.0.1")) {
		t.Fatal("local install did not bind ingress to loopback")
	}
	override, _ := os.ReadFile(second.OverridePath)
	if !bytes.Contains(override, []byte("data-init:")) || !bytes.Contains(override, []byte(filepath.Join(dataRoot, "data"))) {
		t.Fatal("override did not bind the selected data root through the init boundary")
	}
	if strings.Contains(output.String(), strings.TrimSpace(string(secretBefore))) {
		t.Fatal("operator output disclosed the Owner recovery secret")
	}
}

func TestOCIInstallLoadsExactImagesAndDisablesBuildAndPull(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installation, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	if !hasPinnedRuntimeImages(installation.Manifest) || installation.Manifest.SourceCommit != strings.Repeat("a", 40) {
		t.Fatalf("OCI identity was not committed: %+v", installation.Manifest)
	}
	environment, err := os.ReadFile(installation.EnvironmentPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		`CONVENE_WIRE_RELEASE_VERSION="v1.2.3"`,
		`CONVENE_WIRE_SOURCE_COMMIT="` + strings.Repeat("a", 40) + `"`,
		`CONVENE_WIRE_SERVER_IMAGE="sha256:`,
		`CONVENE_WIRE_CADDY_IMAGE="sha256:`,
	} {
		if !bytes.Contains(environment, []byte(expected)) {
			t.Fatalf("closed environment omits %q:\n%s", expected, environment)
		}
	}
	loadIndex, configIndex, upIndex, runtimeIdentityIndex, inspectCount := -1, -1, -1, -1, 0
	for index, command := range runner.commands {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, "docker image load --input ") {
			loadIndex = index
		}
		if strings.Contains(joined, " config --quiet") {
			configIndex = index
		}
		if strings.Contains(joined, "docker image inspect --format") {
			inspectCount++
		}
		if strings.Contains(joined, " up -d ") {
			upIndex = index
			if !strings.Contains(joined, "--no-build --pull never") || strings.Contains(joined, " --build") {
				t.Fatalf("OCI install weakened offline startup: %s", joined)
			}
		}
		if strings.Contains(joined, " ps --quiet agentroom") {
			runtimeIdentityIndex = index
		}
		if command.Name == "docker" && len(command.Args) >= 2 && command.Args[0] == "pull" {
			t.Fatalf("OCI install requested a network pull: %s", joined)
		}
	}
	if loadIndex < 0 || inspectCount != 6 || configIndex <= loadIndex ||
		upIndex <= configIndex || runtimeIdentityIndex <= upIndex {
		t.Fatalf("unexpected load/verify/config/start/identity order: load=%d inspect=%d config=%d up=%d identity=%d", loadIndex, inspectCount, configIndex, upIndex, runtimeIdentityIndex)
	}
}

func TestOCIInstallSelectsContainerdManifestDigestPair(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	metadata, _, err := verifyRelease(
		releaseDir,
		filepath.Join(releaseDir, "SHA256SUMS"),
		checksumPin(releaseDir),
	)
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{
		failOnce:          map[string]int{},
		runtimeImageStore: "containerd",
	}
	installation, err := New(testDependencies(runner, &bytes.Buffer{})).Install(
		context.Background(),
		installOptions(releaseDir, filepath.Join(root, "state")),
	)
	if err != nil {
		t.Fatal(err)
	}
	server, _ := metadata.RuntimeImages.Image(releaseimage.ServerRole)
	caddy, _ := metadata.RuntimeImages.Image(releaseimage.CaddyRole)
	if installation.Manifest.ServerImage != server.Reference ||
		installation.Manifest.CaddyImage != caddy.Reference {
		t.Fatalf("containerd install did not persist the complete manifest-digest pair: %+v", installation.Manifest)
	}
	environment, err := os.ReadFile(installation.EnvironmentPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		`CONVENE_WIRE_SERVER_IMAGE="` + server.Reference + `"`,
		`CONVENE_WIRE_CADDY_IMAGE="` + caddy.Reference + `"`,
	} {
		if !bytes.Contains(environment, []byte(expected)) {
			t.Fatalf("containerd environment omits %q:\n%s", expected, environment)
		}
	}
}

func TestOCIInstallRejectsPartialRuntimeImageGenerationsBeforeConfiguration(t *testing.T) {
	tests := []struct {
		name  string
		store string
		role  string
	}{
		{name: "partial classic pair", store: "classic", role: releaseimage.CaddyRole},
		{name: "partial containerd pair", store: "containerd", role: releaseimage.CaddyRole},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
			metadata, _, err := verifyRelease(
				releaseDir,
				filepath.Join(releaseDir, "SHA256SUMS"),
				checksumPin(releaseDir),
			)
			if err != nil {
				t.Fatal(err)
			}
			image, _ := metadata.RuntimeImages.Image(test.role)
			unavailable := image.RuntimeReference
			if test.store == "containerd" {
				unavailable = image.Reference
			}
			runner := &fakeRunner{
				failOnce:                   map[string]int{},
				runtimeImageStore:          test.store,
				unavailableImageReferences: map[string]bool{unavailable: true},
			}
			dataRoot := filepath.Join(root, "state")
			_, err = New(testDependencies(runner, &bytes.Buffer{})).Install(
				context.Background(),
				installOptions(releaseDir, dataRoot),
			)
			requireActionCode(t, err, "RUNTIME_IMAGE_VERIFY_FAILED")
			manifest, found, loadErr := loadManifest(installationPaths(dataRoot).ManifestPath)
			if loadErr != nil || !found || manifest.LastSuccessfulStep != "secrets_ready" ||
				!runtimeImagesUnresolved(manifest) {
				t.Fatalf("partial image generation crossed the selection boundary: %+v found=%t err=%v", manifest, found, loadErr)
			}
			if _, statErr := os.Stat(installationPaths(dataRoot).EnvironmentPath); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("partial image generation rendered an environment: %v", statErr)
			}
			for _, command := range runner.commands {
				joined := command.Name + " " + strings.Join(command.Args, " ")
				if strings.Contains(joined, " config --quiet") || strings.Contains(joined, " up -d ") {
					t.Fatalf("partial image generation reached Compose: %s", joined)
				}
			}
		})
	}
}

func TestOCIInstallReentryNeverSwitchesPersistedRuntimeImageGeneration(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installed, err := control.Install(
		context.Background(),
		installOptions(releaseDir, dataRoot),
	)
	if err != nil {
		t.Fatal(err)
	}
	original := installed.Manifest
	runner.runtimeImageStore = "containerd"
	_, err = control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	requireActionCode(t, err, "RUNTIME_IMAGE_VERIFY_FAILED")
	current, found, loadErr := loadManifest(installed.ManifestPath)
	if loadErr != nil || !found || !manifestsEqualIgnoringUpdatedAt(current, original) {
		t.Fatalf("reentry switched the persisted runtime image generation: %+v found=%t err=%v", current, found, loadErr)
	}
}

func TestOCIReadyReentryBackfillsSourceCommitWithoutRegressingOnImageFailure(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installed, err := control.Install(
		context.Background(),
		installOptions(releaseDir, dataRoot),
	)
	if err != nil {
		t.Fatal(err)
	}
	historical := installed.Manifest
	historical.SourceCommit = ""
	if err := saveManifest(installed.ManifestPath, historical); err != nil {
		t.Fatal(err)
	}
	runner.runtimeImageStore = "containerd"
	_, err = control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	requireActionCode(t, err, "RUNTIME_IMAGE_VERIFY_FAILED")
	current, found, loadErr := loadManifest(installed.ManifestPath)
	if loadErr != nil || !found || current.LastSuccessfulStep != "ready" ||
		current.SourceCommit != strings.Repeat("a", 40) ||
		current.ServerImage != historical.ServerImage ||
		current.CaddyImage != historical.CaddyImage {
		t.Fatalf("historical ready reentry regressed after image failure: %+v found=%t err=%v", current, found, loadErr)
	}
}

func TestOCIInstallSelectionCASFailureStaysUnresolvedAndRetries(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	paths := installationPaths(dataRoot)
	runner := &fakeRunner{failOnce: map[string]int{}}
	platformInspections := 0
	injected := false
	runner.hook = func(command Command) {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if injected || !strings.Contains(joined, "{{.Os}}/{{.Architecture}}") {
			return
		}
		platformInspections++
		if platformInspections != 2 {
			return
		}
		manifest, found, err := loadManifest(paths.ManifestPath)
		if err != nil || !found || !runtimeImagesUnresolved(manifest) {
			t.Fatalf("selection CAS injection saw an invalid boundary: %+v found=%t err=%v", manifest, found, err)
		}
		manifest.Generation++
		if err := saveManifest(paths.ManifestPath, manifest); err != nil {
			t.Fatal(err)
		}
		injected = true
	}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	_, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	requireActionCode(t, err, "MANIFEST_WRITE_FAILED")
	manifest, found, loadErr := loadManifest(paths.ManifestPath)
	if loadErr != nil || !found || manifest.LastSuccessfulStep != "secrets_ready" ||
		!runtimeImagesUnresolved(manifest) {
		t.Fatalf("selection CAS failure crossed its unresolved boundary: %+v found=%t err=%v", manifest, found, loadErr)
	}
	if _, statErr := os.Stat(paths.EnvironmentPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("selection CAS failure rendered an environment: %v", statErr)
	}
	runner.hook = nil
	result, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	if result.Manifest.LastSuccessfulStep != "ready" || !hasPinnedRuntimeImages(result.Manifest) {
		t.Fatalf("selection CAS retry did not converge: %+v", result.Manifest)
	}
}

func TestRuntimeImageManifestCompatibilityRequiresOneReferenceGeneration(t *testing.T) {
	serverRuntime := "sha256:" + strings.Repeat("1", 64)
	caddyRuntime := "sha256:" + strings.Repeat("2", 64)
	serverLegacy := releaseimage.ServerRepository + "@sha256:" + strings.Repeat("3", 64)
	caddyLegacy := releaseimage.CaddyRepository + "@sha256:" + strings.Repeat("4", 64)
	metadata := ReleaseMetadata{
		SchemaVersion: releaseSchemaVersion,
		RuntimeImages: releaseimage.Metadata{
			Platform: "linux/amd64",
			Images: []releaseimage.ImageMetadata{
				{
					Role: releaseimage.ServerRole, Reference: serverLegacy,
					RuntimeReference: serverRuntime,
				},
				{
					Role: releaseimage.CaddyRole, Reference: caddyLegacy,
					RuntimeReference: caddyRuntime,
				},
			},
		},
	}

	runtimeManifest := Manifest{}
	applyRuntimeImages(&runtimeManifest, metadata)
	if !runtimeImagesUnresolved(runtimeManifest) {
		t.Fatalf("unresolved manifest selected a Docker-specific generation: %+v", runtimeManifest)
	}
	applySelectedRuntimeImages(&runtimeManifest, metadata, serverRuntime, caddyRuntime)
	if runtimeManifest.ServerImage != serverRuntime ||
		runtimeManifest.CaddyImage != caddyRuntime ||
		runtimeManifest.RuntimeImagePlatform != metadata.RuntimeImages.Platform {
		t.Fatalf("new manifest did not select OCI config IDs: %+v", runtimeManifest)
	}
	if !runtimeImagesMatch(runtimeManifest, metadata) {
		t.Fatal("new raw image-ID pair did not match its verified metadata")
	}

	legacyManifest := runtimeManifest
	legacyManifest.ServerImage = serverLegacy
	legacyManifest.CaddyImage = caddyLegacy
	if !runtimeImagesMatch(legacyManifest, metadata) {
		t.Fatal("complete legacy repo@manifest pair was not accepted")
	}

	mixedManifest := runtimeManifest
	mixedManifest.CaddyImage = caddyLegacy
	if runtimeImagesMatch(mixedManifest, metadata) {
		t.Fatal("mixed raw and legacy reference generations matched")
	}
	wrongRuntimeManifest := runtimeManifest
	wrongRuntimeManifest.CaddyImage = "sha256:" + strings.Repeat("5", 64)
	if runtimeImagesMatch(wrongRuntimeManifest, metadata) {
		t.Fatal("unverified raw image ID matched")
	}
}

func TestManifestValidationAcceptsOnlyCompleteRuntimeReferenceGenerations(t *testing.T) {
	serverRuntime := "sha256:" + strings.Repeat("1", 64)
	caddyRuntime := "sha256:" + strings.Repeat("2", 64)
	serverLegacy := releaseimage.ServerRepository + "@sha256:" + strings.Repeat("3", 64)
	caddyLegacy := releaseimage.CaddyRepository + "@sha256:" + strings.Repeat("4", 64)
	base := Manifest{
		SchemaVersion:  manifestSchemaVersion,
		InstallationID: "install_" + strings.Repeat("a", 16),
		Mode:           "local", TLSProfile: "local",
		RuntimeImagePlatform: "linux/amd64",
	}
	tests := []struct {
		name   string
		server string
		caddy  string
		valid  bool
	}{
		{name: "raw image ID pair", server: serverRuntime, caddy: caddyRuntime, valid: true},
		{name: "legacy repo digest pair", server: serverLegacy, caddy: caddyLegacy, valid: true},
		{name: "raw Server with legacy Caddy", server: serverRuntime, caddy: caddyLegacy},
		{name: "legacy Server with raw Caddy", server: serverLegacy, caddy: caddyRuntime},
		{name: "swapped legacy roles", server: caddyLegacy, caddy: serverLegacy},
		{name: "incomplete raw pair", server: serverRuntime},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			manifest := base
			manifest.ServerImage = test.server
			manifest.CaddyImage = test.caddy
			err := validateManifest(manifest)
			if test.valid && err != nil {
				t.Fatalf("valid runtime reference pair rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid runtime reference pair accepted")
			}
		})
	}
}

func TestOCIInstallRequiresExactActiveRuntimeBeforeReady(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*fakeRunner)
	}{
		{
			name: "both services stopped",
			configure: func(runner *fakeRunner) {
				runner.stopServerAfterUp = true
				runner.stopCaddyAfterUp = true
			},
		},
		{
			name: "only Caddy stopped",
			configure: func(runner *fakeRunner) {
				runner.stopCaddyAfterUp = true
			},
		},
		{
			name: "Server image drift",
			configure: func(runner *fakeRunner) {
				runner.activeServerImageID = "sha256:" + strings.Repeat("e", 64)
			},
		},
		{
			name: "Server build identity drift",
			configure: func(runner *fakeRunner) {
				runner.runtimeBuildIdentity = "convenewire_build_info{release_version=\"v9.9.9\",source_commit=\"" + strings.Repeat("f", 40) + "\"} 1\n"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
			dataRoot := filepath.Join(root, "state")
			runner := &fakeRunner{failOnce: map[string]int{}}
			test.configure(runner)
			_, err := New(testDependencies(runner, &bytes.Buffer{})).Install(
				context.Background(),
				installOptions(releaseDir, dataRoot),
			)
			requireActionCode(t, err, "INSTALL_RUNTIME_MISMATCH")
			manifest, found, loadErr := loadManifest(installationPaths(dataRoot).ManifestPath)
			if loadErr != nil || !found || manifest.LastSuccessfulStep == "ready" {
				t.Fatalf("runtime drift reached ready manifest: %+v found=%t err=%v", manifest, found, loadErr)
			}
		})
	}
}

func TestLegacyReleaseKeepsExplicitSourceBuildBoundary(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	runner := &fakeRunner{failOnce: map[string]int{}}
	installation, err := New(testDependencies(runner, &bytes.Buffer{})).Install(
		context.Background(), installOptions(releaseDir, filepath.Join(root, "state")),
	)
	if err != nil {
		t.Fatal(err)
	}
	if hasPinnedRuntimeImages(installation.Manifest) || installation.Manifest.SourceCommit != strings.Repeat("a", 40) {
		t.Fatalf("legacy release crossed the compatibility boundary: %+v", installation.Manifest)
	}
	environment, err := os.ReadFile(installation.EnvironmentPath)
	if err != nil || !bytes.Contains(environment, []byte(`CONVENE_WIRE_RELEASE_VERSION="v1.2.3"`)) ||
		!bytes.Contains(environment, []byte(`CONVENE_WIRE_SOURCE_COMMIT="`+strings.Repeat("a", 40)+`"`)) {
		t.Fatalf("legacy release omitted verified build identity: %s err=%v", environment, err)
	}
	foundBuild := false
	for _, command := range runner.commands {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, "docker image load") {
			t.Fatalf("schema-v1 release unexpectedly loaded an OCI bundle: %s", joined)
		}
		if strings.Contains(joined, " up -d --build") {
			foundBuild = true
		}
	}
	if !foundBuild {
		t.Fatal("schema-v1 release did not preserve the source-build compatibility path")
	}
}

func TestOCIInstallLoadFailureStopsBeforeCompose(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{"image load": 1}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	_, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	requireActionCode(t, err, "RUNTIME_IMAGE_LOAD_FAILED")
	for _, command := range runner.commands {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, " config --quiet") || strings.Contains(joined, " up -d") {
			t.Fatalf("failed image load crossed the Compose boundary: %s", joined)
		}
	}
	manifest, found, loadErr := loadManifest(installationPaths(dataRoot).ManifestPath)
	if loadErr != nil || !found || manifest.LastSuccessfulStep != "secrets_ready" {
		t.Fatalf("load failure was not retry-safe: %+v found=%v err=%v", manifest, found, loadErr)
	}
}

func TestOCIReleasePlatformMismatchFailsBeforeDockerLoad(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	metadataPath := filepath.Join(releaseDir, "image", "convenewire-central-image_1.2.3_linux_amd64.metadata.json")
	value, err := os.ReadFile(metadataPath)
	if err != nil {
		t.Fatal(err)
	}
	var metadata releaseimage.Metadata
	if err := json.Unmarshal(value, &metadata); err != nil {
		t.Fatal(err)
	}
	metadata.Platform = "linux/arm64"
	value, err = json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(metadataPath, append(value, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	rewriteTestReleaseChecksums(t, releaseDir)
	runner := &fakeRunner{failOnce: map[string]int{}}
	_, err = New(testDependencies(runner, &bytes.Buffer{})).Install(
		context.Background(), installOptions(releaseDir, filepath.Join(root, "state")),
	)
	requireActionCode(t, err, "RELEASE_IMAGE_INVALID")
	for _, command := range runner.commands {
		if command.Name == "docker" && len(command.Args) >= 2 && command.Args[0] == "image" && command.Args[1] == "load" {
			t.Fatal("invalid platform reached docker image load")
		}
	}
}

func TestOCIDoctorFailsClosedWhenPinnedImageIsMissing(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot)); err != nil {
		t.Fatal(err)
	}
	runner.failOnce["image inspect"] = 1
	requireActionCode(t, control.Doctor(context.Background(), dataRoot), "RUNTIME_IMAGE_MISSING")
}

func TestConcurrentLifecycleMutationFailsBusyBeforeSecondCommand(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(
		context.Background(), installOptions(releaseDir, dataRoot),
	); err != nil {
		t.Fatal(err)
	}

	backupStarted := make(chan struct{})
	finishBackup := make(chan struct{})
	runner.hook = func(command Command) {
		if command.Name == "bash" && strings.Contains(
			strings.Join(command.Args, " "), "compose-backup.sh",
		) {
			close(backupStarted)
			<-finishBackup
		}
	}
	backupResult := make(chan error, 1)
	go func() {
		backupResult <- control.Backup(context.Background(), dataRoot)
	}()
	<-backupStarted
	requireActionCode(
		t,
		control.Uninstall(context.Background(), dataRoot),
		"LIFECYCLE_BUSY",
	)
	close(finishBackup)
	if err := <-backupResult; err != nil {
		t.Fatalf("owning lifecycle operation failed after contention: %v", err)
	}
}

func TestReadinessDialsLocalIngressWhileVerifyingRecordedHostname(t *testing.T) {
	now := time.Now().UTC()
	origin, caPath, digest := startHostReadinessServer(
		t, "central-unresolvable.invalid", now,
	)
	if err := checkReadiness(context.Background(), ReadinessInput{
		PublicOrigin: origin, LocalCARoot: caPath,
		TLSProfile: "private_scoped_ca", ExpectedCADigest: digest,
		Timeout: 2 * time.Second,
	}); err != nil {
		t.Fatalf("host-local readiness depended on external DNS or DHCP routing: %v", err)
	}
}

func TestBackupPassesCurrentAndLegacyReleaseEnvironmentAliases(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	options := installOptions(releaseDir, dataRoot)
	options.LegacyServerToken = true
	if _, err := control.Install(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	if err := control.Backup(context.Background(), dataRoot); err != nil {
		t.Fatal(err)
	}
	var backup Command
	for _, command := range runner.commands {
		if command.Name == "bash" && strings.Contains(strings.Join(command.Args, " "), "compose-backup.sh") {
			backup = command
		}
	}
	expectedDirectory := filepath.Join(dataRoot, "exports")
	if backup.Name == "" || backup.Env["CONVENE_WIRE_BACKUP_DIR"] != expectedDirectory ||
		backup.Env["AGENT_ROOM_BACKUP_DIR"] != expectedDirectory ||
		backup.Env["CONVENE_WIRE_BRIDGE_SERVER_TOKEN"] == "" ||
		backup.Env["CONVENE_WIRE_BRIDGE_SERVER_TOKEN"] != backup.Env["AGENT_ROOM_BRIDGE_SERVER_TOKEN"] {
		t.Fatalf("backup did not preserve current and legacy release aliases: %#v", backup.Env)
	}
}

func TestInstallRecoversEveryRecordedExternalCrashCut(t *testing.T) {
	tests := []struct {
		name          string
		failToken     string
		readinessFail bool
		lastStep      string
	}{
		{name: "compose validation", failToken: " config --quiet", lastStep: "configuration_ready"},
		{name: "service start", failToken: " up -d --build", lastStep: "compose_validated"},
		{name: "readiness", readinessFail: true, lastStep: "services_started"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			releaseDir := createRelease(t, root, "v1.2.3", 1)
			dataRoot := filepath.Join(root, "state")
			runner := &fakeRunner{failOnce: map[string]int{}}
			if test.failToken != "" {
				runner.failOnce[test.failToken] = 1
			}
			var output bytes.Buffer
			dependencies := testDependencies(runner, &output)
			readinessCalls := 0
			dependencies.CheckReadiness = func(context.Context, ReadinessInput) error {
				readinessCalls++
				if test.readinessFail && readinessCalls == 1 {
					return fmt.Errorf("injected readiness loss")
				}
				return nil
			}
			control := New(dependencies)
			_, firstError := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
			if firstError == nil {
				t.Fatal("first install unexpectedly passed")
			}
			paths := installationPaths(dataRoot)
			secretBefore, err := os.ReadFile(paths.OwnerSecretPath)
			if err != nil {
				t.Fatal(err)
			}
			manifest, found, err := loadManifest(paths.ManifestPath)
			if err != nil || !found || manifest.LastSuccessfulStep != test.lastStep {
				t.Fatalf("unexpected crash cut: %+v found=%v err=%v", manifest, found, err)
			}
			result, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
			if err != nil {
				t.Fatal(err)
			}
			secretAfter, _ := os.ReadFile(result.OwnerSecretPath)
			if !bytes.Equal(secretBefore, secretAfter) {
				t.Fatal("crash recovery regenerated authority secret")
			}
			if result.Manifest.LastSuccessfulStep != "ready" {
				t.Fatalf("recovery did not converge: %s", result.Manifest.LastSuccessfulStep)
			}
		})
	}
}

func TestInstallReusesOnlyAnEmptyBootstrapControlDirectory(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "bootstrap")
	if err := os.MkdirAll(filepath.Join(dataRoot, "control"), 0o700); err != nil {
		t.Fatal(err)
	}
	control := New(testDependencies(&fakeRunner{failOnce: map[string]int{}}, &bytes.Buffer{}))
	if _, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot)); err != nil {
		t.Fatal(err)
	}

	occupied := filepath.Join(root, "occupied")
	if err := os.MkdirAll(filepath.Join(occupied, "control"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(occupied, "control", "unknown"), []byte("state"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireActionCode(t, func() error {
		_, err := control.Install(context.Background(), installOptions(releaseDir, occupied))
		return err
	}(), "EXISTING_DATA_WITHOUT_MANIFEST")
}

func TestReleaseAndInstallConflictsFailClosed(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	wrongPin := installOptions(releaseDir, filepath.Join(root, "wrong-pin"))
	wrongPin.ChecksumsSHA256 = strings.Repeat("0", 64)
	requireActionCode(t, func() error {
		_, err := control.Install(context.Background(), wrongPin)
		return err
	}(), "CHECKSUM_PIN_MISMATCH")
	if _, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot)); err != nil {
		t.Fatal(err)
	}
	changed := installOptions(releaseDir, dataRoot)
	changed.HTTPSPort = 20443
	changed.PublicOrigin = "https://localhost:20443"
	requireActionCode(t, func() error {
		_, err := control.Install(context.Background(), changed)
		return err
	}(), "INSTALL_CONFLICT")
	if err := os.WriteFile(filepath.Join(releaseDir, "unchecked"), []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	requireActionCode(t, func() error {
		_, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
		return err
	}(), "RELEASE_CHECKSUM_MISMATCH")
}

func TestLifecycleRefusesReleaseDriftBeforeExecutingReleaseContent(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot)); err != nil {
		t.Fatal(err)
	}
	commandCount := len(runner.commands)
	if err := os.WriteFile(filepath.Join(releaseDir, "scripts", "compose-backup.sh"), []byte("tampered\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	requireActionCode(t, control.Backup(context.Background(), dataRoot), "RELEASE_CHECKSUM_MISMATCH")
	if len(runner.commands) != commandCount+2 {
		t.Fatalf("release drift should run only host probes, got %d new commands", len(runner.commands)-commandCount)
	}
	for _, command := range runner.commands[commandCount:] {
		if command.Name == "bash" {
			t.Fatal("release drift executed a release-owned lifecycle script")
		}
	}
}

func TestSupportedHostAndNetworkModeValidation(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	for _, host := range []struct{ goos, goarch string }{
		{goos: "linux", goarch: "amd64"},
		{goos: "linux", goarch: "arm64"},
		{goos: "darwin", goarch: "amd64"},
		{goos: "darwin", goarch: "arm64"},
	} {
		t.Run(host.goos+"-"+host.goarch, func(t *testing.T) {
			hostRelease := createReleaseForTarget(t, root, "v1.2.3", 1, host.goos, host.goarch)
			dependencies := testDependencies(&fakeRunner{failOnce: map[string]int{}}, &bytes.Buffer{})
			dependencies.GOOS, dependencies.GOARCH = host.goos, host.goarch
			options := installOptions(hostRelease, filepath.Join(root, host.goos+host.goarch))
			if _, err := New(dependencies).Install(context.Background(), options); err != nil {
				t.Fatal(err)
			}
		})
	}
	unsupported := testDependencies(&fakeRunner{failOnce: map[string]int{}}, &bytes.Buffer{})
	unsupported.GOOS = "windows"
	requireActionCode(t, func() error {
		_, err := New(unsupported).Install(context.Background(), installOptions(releaseDir, filepath.Join(root, "windows")))
		return err
	}(), "HOST_UNSUPPORTED")
	darwinRelease := createReleaseForTarget(t, root, "v1.2.4", 1, "darwin", "arm64")
	requireActionCode(t, func() error {
		_, err := New(testDependencies(&fakeRunner{failOnce: map[string]int{}}, &bytes.Buffer{})).Install(
			context.Background(), installOptions(darwinRelease, filepath.Join(root, "wrong-target")))
		return err
	}(), "RELEASE_TARGET_MISMATCH")
	direct := installOptions(releaseDir, filepath.Join(root, "direct"))
	direct.Mode = "direct_https"
	direct.Domain = "team.example.com"
	direct.PublicOrigin = "https://team.example.com:19443"
	if _, err := New(testDependencies(&fakeRunner{failOnce: map[string]int{}}, &bytes.Buffer{})).Install(context.Background(), direct); err != nil {
		t.Fatal(err)
	}
	value, _ := os.ReadFile(filepath.Join(direct.DataRoot, "control", "agentroom.env"))
	if !bytes.Contains(value, []byte("CONVENE_WIRE_BIND_ADDRESS=0.0.0.0")) {
		t.Fatal("direct_https did not publish through the direct bind boundary")
	}
}

func TestBackupRestoreAndUninstallDelegateWithoutPurgingData(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	var output bytes.Buffer
	control := New(testDependencies(runner, &output))
	installation, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(root, "verified.sqlite")
	if err := os.WriteFile(backup, []byte("verified"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := control.Backup(context.Background(), dataRoot); err != nil {
		t.Fatal(err)
	}
	if err := control.Restore(context.Background(), dataRoot, backup, "restored.sqlite"); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dataRoot, "data", "keep-me")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := control.Uninstall(context.Background(), dataRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("ordinary uninstall removed data")
	}
	if _, err := os.Stat(installation.OwnerSecretPath); err != nil {
		t.Fatal("ordinary uninstall removed recovery material")
	}
	if _, err := os.Stat(installation.EnvironmentPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("ordinary uninstall retained generated runtime configuration")
	}
	manifest, _, _ := loadManifest(installation.ManifestPath)
	if manifest.LastSuccessfulStep != "uninstalled" {
		t.Fatalf("uninstall state not recorded: %s", manifest.LastSuccessfulStep)
	}
	for _, command := range runner.commands {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, " down ") && strings.Contains(joined, " -v") {
			t.Fatal("ordinary uninstall requested volume deletion")
		}
		if command.Name == "bash" && command.Env["COMPOSE_FILE"] == "" {
			t.Fatal("delegated lifecycle script omitted the generated Compose model")
		}
	}
}

func TestUpgradeRequiresBackupAndCommitsOnlyAfterReadiness(t *testing.T) {
	root := t.TempDir()
	currentRelease := createRelease(t, root, "v1.2.3", 1)
	targetRelease := createRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(context.Background(), installOptions(currentRelease, dataRoot)); err != nil {
		t.Fatal(err)
	}
	start := len(runner.commands)
	if err := control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}
	manifest, _, _ := loadManifest(installationPaths(dataRoot).ManifestPath)
	if manifest.ReleaseVersion != "v1.3.0" || manifest.DataSchemaVersion != 2 || manifest.LastSuccessfulStep != "ready" {
		t.Fatalf("target release was not committed: %+v", manifest)
	}
	commands := runner.commands[start:]
	backupIndex, upIndex := -1, -1
	for index, command := range commands {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, "compose-backup.sh") {
			backupIndex = index
		}
		if strings.Contains(joined, " up -d --build") {
			upIndex = index
		}
	}
	if backupIndex < 0 || upIndex < 0 || backupIndex >= upIndex {
		t.Fatalf("verified backup did not precede target start: backup=%d up=%d", backupIndex, upIndex)
	}
}

func seedUpgradeJournal(
	t *testing.T,
	installation Installation,
	targetRelease string,
	phase string,
) upgradeJournal {
	t.Helper()
	metadata, digest, err := verifyRelease(
		targetRelease,
		filepath.Join(targetRelease, "SHA256SUMS"),
		checksumPin(targetRelease),
	)
	if err != nil {
		t.Fatal(err)
	}
	target := installation.Manifest
	target.ReleaseVersion = metadata.ReleaseVersion
	target.SourceCommit = metadata.SourceCommit
	target.ReleaseDir = targetRelease
	target.ReleaseDigest = digest
	target.DataSchemaVersion = metadata.DataSchemaVersion
	applyRuntimeImages(&target, metadata)
	server, _ := metadata.RuntimeImages.Image(releaseimage.ServerRole)
	caddy, _ := metadata.RuntimeImages.Image(releaseimage.CaddyRole)
	applySelectedRuntimeImages(
		&target,
		metadata,
		server.RuntimeReference,
		caddy.RuntimeReference,
	)
	target.LastSuccessfulStep = "upgrade_validating"
	target.UpdatedAt = time.Date(2026, 8, 28, 1, 3, 0, 0, time.UTC).
		Format(time.RFC3339Nano)
	backupDirectory := filepath.Join(installation.Manifest.DataRoot, "exports")
	if err := os.MkdirAll(backupDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(backupDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(backupDirectory, "convene-wire-seeded.sqlite")
	backupContents := []byte("seeded-upgrade-backup\n")
	if err := os.WriteFile(backupPath, backupContents, 0o600); err != nil {
		t.Fatal(err)
	}
	backupDigest := sha256.Sum256(backupContents)
	journal := newUpgradeJournal(
		installation.Manifest,
		target,
		backupReceipt{
			Path: backupPath, SHA256: hex.EncodeToString(backupDigest[:]),
			Size: int64(len(backupContents)),
		},
		time.Date(2026, 8, 28, 1, 3, 0, 0, time.UTC),
	)
	journal.Phase = phase
	if err := saveUpgradeJournal(installation.UpgradeJournalPath, journal); err != nil {
		t.Fatal(err)
	}
	return journal
}

func TestUpgradeResumesOnlyExactTargetAfterReadyBeforeCanonicalCrash(t *testing.T) {
	root := t.TempDir()
	currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
	targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
	otherRelease := createOCIRelease(t, root, "v1.4.0", 3)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installation, err := control.Install(
		context.Background(),
		installOptions(currentRelease, dataRoot),
	)
	if err != nil {
		t.Fatal(err)
	}
	seedUpgradeJournal(t, installation, targetRelease, upgradePhaseTargetReady)

	requireActionCode(
		t,
		control.Status(context.Background(), dataRoot),
		"UPGRADE_RECOVERY_REQUIRED",
	)
	requireActionCode(t, func() error {
		_, err := control.Install(
			context.Background(),
			installOptions(currentRelease, dataRoot),
		)
		return err
	}(), "UPGRADE_RECOVERY_REQUIRED")
	requireActionCode(t, control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: otherRelease,
		ChecksumsSHA256: checksumPin(otherRelease),
	}), "UPGRADE_RECOVERY_TARGET_MISMATCH")

	restarted := New(testDependencies(runner, &bytes.Buffer{}))
	if err := restarted.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}
	manifest, _, err := loadManifest(installation.ManifestPath)
	if err != nil || manifest.ReleaseVersion != "v1.3.0" ||
		manifest.LastSuccessfulStep != "ready" {
		t.Fatalf("recovered target was not committed: %+v err=%v", manifest, err)
	}
	if _, found, err := loadUpgradeJournal(installation.UpgradeJournalPath); err != nil || found {
		t.Fatalf("completed recovery retained its journal: found=%t err=%v", found, err)
	}
	for _, command := range runner.commands {
		if command.Name == "bash" && strings.Contains(
			strings.Join(command.Args, " "),
			"compose-backup.sh",
		) {
			t.Fatal("same-target recovery repeated the already-recorded backup phase")
		}
	}
}

func TestUpgradeRecoversAfterCanonicalConfigurationWriteFailure(t *testing.T) {
	root := t.TempDir()
	currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
	targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installation, err := control.Install(
		context.Background(),
		installOptions(currentRelease, dataRoot),
	)
	if err != nil {
		t.Fatal(err)
	}
	previousEnvironment, err := os.ReadFile(installation.EnvironmentPath)
	if err != nil {
		t.Fatal(err)
	}
	sabotageCanonicalWrite := true
	runner.hook = func(command Command) {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if !sabotageCanonicalWrite || !strings.Contains(joined, " up -d --no-build") {
			return
		}
		sabotageCanonicalWrite = false
		if err := os.Remove(installation.EnvironmentPath); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(installation.EnvironmentPath, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	requireActionCode(t, control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}), "UPGRADE_COMMIT_FAILED")
	manifest, _, err := loadManifest(installation.ManifestPath)
	if err != nil || manifest.ReleaseVersion != "v1.2.3" {
		t.Fatalf("failed canonical write changed the old manifest: %+v err=%v", manifest, err)
	}
	journal, found, err := loadUpgradeJournal(installation.UpgradeJournalPath)
	if err != nil || !found || journal.Phase != upgradePhaseTargetReady {
		t.Fatalf("failed canonical write lost its ready journal: %+v %t %v", journal, found, err)
	}
	if err := os.RemoveAll(installation.EnvironmentPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installation.EnvironmentPath, previousEnvironment, 0o600); err != nil {
		t.Fatal(err)
	}

	restarted := New(testDependencies(runner, &bytes.Buffer{}))
	if err := restarted.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}
	manifest, _, _ = loadManifest(installation.ManifestPath)
	if manifest.ReleaseVersion != "v1.3.0" || manifest.LastSuccessfulStep != "ready" {
		t.Fatalf("canonical write recovery did not commit target: %+v", manifest)
	}
	backupCount := 0
	for _, command := range runner.commands {
		if command.Name == "bash" && strings.Contains(
			strings.Join(command.Args, " "),
			"compose-backup.sh",
		) {
			backupCount++
		}
	}
	if backupCount != 1 {
		t.Fatalf("upgrade recovery repeated or skipped the verified backup: %d", backupCount)
	}
}

func TestUpgradeCleansCommittedTargetJournalWithoutReplayingMutation(t *testing.T) {
	root := t.TempDir()
	currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
	targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installation, err := control.Install(
		context.Background(),
		installOptions(currentRelease, dataRoot),
	)
	if err != nil {
		t.Fatal(err)
	}
	journal := seedUpgradeJournal(
		t,
		installation,
		targetRelease,
		upgradePhaseTargetReady,
	)
	committed := journal.Target
	committed.Generation++
	committed.LastSuccessfulStep = "ready"
	if err := saveManifest(installation.ManifestPath, committed); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(journal.Backup.Path); err != nil {
		t.Fatal(err)
	}
	runner.activeRuntimeReleaseVersion = committed.ReleaseVersion
	runner.activeRuntimeSourceCommit = committed.SourceCommit
	runner.activeServerImageID = testRuntimeImageID(committed.ServerImage)
	runner.activeCaddyImageID = testRuntimeImageID(committed.CaddyImage)
	start := len(runner.commands)
	if err := control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}
	assertNoBackupOrUpgradeMutation(t, runner.commands[start:])
	if _, found, err := loadUpgradeJournal(installation.UpgradeJournalPath); err != nil || found {
		t.Fatalf("committed target cleanup retained journal: found=%t err=%v", found, err)
	}
}

func TestStatusAndDoctorRejectActiveRuntimeIdentityDrift(t *testing.T) {
	root := t.TempDir()
	releaseDir := createOCIRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	dependencies := testDependencies(runner, &bytes.Buffer{})
	readinessChecks := 0
	dependencies.CheckReadiness = func(context.Context, ReadinessInput) error {
		readinessChecks++
		return nil
	}
	control := New(dependencies)
	if _, err := control.Install(
		context.Background(),
		installOptions(releaseDir, dataRoot),
	); err != nil {
		t.Fatal(err)
	}
	runner.serverStopped = true
	runner.caddyStopped = true
	beforeStoppedStatus := len(runner.commands)
	if err := control.Status(context.Background(), dataRoot); err != nil {
		t.Fatalf("status rejected a fully stopped installation: %v", err)
	}
	for _, command := range runner.commands[beforeStoppedStatus:] {
		if command.Name == "docker" && len(command.Args) > 0 && command.Args[0] == "exec" {
			t.Fatal("status queried Server build identity while both services were stopped")
		}
	}
	runner.serverStopped = false
	requireActionCode(
		t,
		control.Status(context.Background(), dataRoot),
		"ACTIVE_RUNTIME_MISMATCH",
	)
	runner.caddyStopped = false
	runner.activeServerImageID = "sha256:" + strings.Repeat("e", 64)
	requireActionCode(
		t,
		control.Status(context.Background(), dataRoot),
		"ACTIVE_RUNTIME_MISMATCH",
	)
	runner.activeServerImageID = ""
	runner.runtimeBuildIdentity = fmt.Sprintf(
		"convenewire_build_info{release_version=%q,source_commit=%q} 1\n",
		"v9.9.9",
		strings.Repeat("f", 40),
	)
	readinessChecks = 0
	requireActionCode(
		t,
		control.Doctor(context.Background(), dataRoot),
		"ACTIVE_RUNTIME_MISMATCH",
	)
	if readinessChecks != 0 {
		t.Fatal("doctor accepted HTTPS readiness before active build identity")
	}
}

func TestPinnedBackupAndUpgradeRejectCurrentRuntimeDriftBeforeMutation(t *testing.T) {
	tests := []struct {
		name      string
		configure func(*fakeRunner)
	}{
		{
			name: "both services stopped",
			configure: func(runner *fakeRunner) {
				runner.serverStopped = true
				runner.caddyStopped = true
			},
		},
		{
			name: "partial runtime",
			configure: func(runner *fakeRunner) {
				runner.caddyStopped = true
			},
		},
		{
			name: "active image drift",
			configure: func(runner *fakeRunner) {
				runner.activeServerImageID = "sha256:" + strings.Repeat("e", 64)
			},
		},
		{
			name: "active build identity drift",
			configure: func(runner *fakeRunner) {
				runner.runtimeBuildIdentity = "convenewire_build_info{release_version=\"v9.9.9\",source_commit=\"" + strings.Repeat("f", 40) + "\"} 1\n"
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
			targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
			dataRoot := filepath.Join(root, "state")
			runner := &fakeRunner{failOnce: map[string]int{}}
			control := New(testDependencies(runner, &bytes.Buffer{}))
			if _, err := control.Install(
				context.Background(),
				installOptions(currentRelease, dataRoot),
			); err != nil {
				t.Fatal(err)
			}
			test.configure(runner)

			backupStart := len(runner.commands)
			requireActionCode(
				t,
				control.Backup(context.Background(), dataRoot),
				"BACKUP_RUNTIME_MISMATCH",
			)
			assertNoBackupOrUpgradeMutation(t, runner.commands[backupStart:])

			upgradeStart := len(runner.commands)
			requireActionCode(t, control.Upgrade(context.Background(), UpgradeOptions{
				DataRoot: dataRoot, ReleaseDir: targetRelease,
				ChecksumsSHA256: checksumPin(targetRelease),
			}), "UPGRADE_BACKUP_FAILED")
			assertNoBackupOrUpgradeMutation(t, runner.commands[upgradeStart:])
			if _, found, err := loadUpgradeJournal(
				installationPaths(dataRoot).UpgradeJournalPath,
			); err != nil || found {
				t.Fatalf("failed current runtime preflight created a journal: found=%t err=%v", found, err)
			}
		})
	}
}

func TestUpgradeRecoveryRejectsMissingOrChangedReceiptBackupBeforeMutation(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(string) error
	}{
		{name: "deleted", mutate: os.Remove},
		{
			name: "changed",
			mutate: func(path string) error {
				return os.WriteFile(path, []byte("changed-upgrade-backup\n"), 0o600)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
			targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
			dataRoot := filepath.Join(root, "state")
			runner := &fakeRunner{failOnce: map[string]int{}}
			control := New(testDependencies(runner, &bytes.Buffer{}))
			installation, err := control.Install(
				context.Background(),
				installOptions(currentRelease, dataRoot),
			)
			if err != nil {
				t.Fatal(err)
			}
			journal := seedUpgradeJournal(
				t,
				installation,
				targetRelease,
				upgradePhaseTargetReady,
			)
			if err := test.mutate(journal.Backup.Path); err != nil {
				t.Fatal(err)
			}
			start := len(runner.commands)
			requireActionCode(t, control.Upgrade(context.Background(), UpgradeOptions{
				DataRoot: dataRoot, ReleaseDir: targetRelease,
				ChecksumsSHA256: checksumPin(targetRelease),
			}), "UPGRADE_BACKUP_INVALID")
			assertNoBackupOrUpgradeMutation(t, runner.commands[start:])
			manifest, _, err := loadManifest(installation.ManifestPath)
			if err != nil || manifest.ReleaseVersion != "v1.2.3" {
				t.Fatalf("invalid backup recovery changed the previous manifest: %+v err=%v", manifest, err)
			}
		})
	}
}

func assertNoBackupOrUpgradeMutation(t *testing.T, commands []Command) {
	t.Helper()
	for _, command := range commands {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, "compose-backup.sh") ||
			strings.Contains(joined, "docker image load --input") ||
			strings.Contains(joined, " up -d ") {
			t.Fatalf("failed preflight reached backup or target mutation: %s", joined)
		}
	}
}

func TestUpgradeFromLegacyReleaseLoadsOCIOnlyAfterVerifiedBackup(t *testing.T) {
	root := t.TempDir()
	currentRelease := createRelease(t, root, "v1.2.3", 1)
	targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(context.Background(), installOptions(currentRelease, dataRoot)); err != nil {
		t.Fatal(err)
	}
	journalPresentAtMutation := false
	journalBoundBeforeTargetConfig := false
	runner.hook = func(command Command) {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, " config --quiet") {
			journal, found, err := loadUpgradeJournal(
				installationPaths(dataRoot).UpgradeJournalPath,
			)
			if err != nil || !found || !hasPinnedRuntimeImages(journal.Target) {
				t.Fatalf("target configuration preceded durable runtime selection: %+v found=%t err=%v", journal, found, err)
			}
			journalBoundBeforeTargetConfig = true
		}
		if !strings.Contains(joined, "docker image load --input") {
			return
		}
		if _, err := os.Stat(installationPaths(dataRoot).UpgradeJournalPath); err != nil {
			t.Fatalf("upgrade mutated Docker before durable journal: %v", err)
		}
		journalPresentAtMutation = true
	}
	start := len(runner.commands)
	if err := control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}
	manifest, _, err := loadManifest(installationPaths(dataRoot).ManifestPath)
	if err != nil || manifest.ReleaseVersion != "v1.3.0" || !hasPinnedRuntimeImages(manifest) ||
		manifest.SourceCommit != strings.Repeat("a", 40) {
		t.Fatalf("OCI upgrade identity was not committed: %+v err=%v", manifest, err)
	}
	backupIndex, loadIndex, upIndex := -1, -1, -1
	for index, command := range runner.commands[start:] {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		switch {
		case strings.Contains(joined, "compose-backup.sh"):
			backupIndex = index
		case strings.Contains(joined, "docker image load --input"):
			loadIndex = index
		case strings.Contains(joined, " up -d "):
			upIndex = index
			if !strings.Contains(joined, "--no-build --pull never") || strings.Contains(joined, " --build") {
				t.Fatalf("OCI upgrade weakened offline startup: %s", joined)
			}
		}
	}
	if backupIndex < 0 || loadIndex <= backupIndex || upIndex <= loadIndex {
		t.Fatalf("upgrade order is unsafe: backup=%d load=%d up=%d", backupIndex, loadIndex, upIndex)
	}
	if !journalPresentAtMutation {
		t.Fatal("OCI upgrade never proved its pre-mutation journal boundary")
	}
	if !journalBoundBeforeTargetConfig {
		t.Fatal("OCI upgrade never proved its post-load runtime journal binding")
	}
}

func TestOCIUpgradePersistsContainerdManifestDigestPair(t *testing.T) {
	root := t.TempDir()
	currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
	targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{
		failOnce:          map[string]int{},
		runtimeImageStore: "containerd",
	}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(
		context.Background(),
		installOptions(currentRelease, dataRoot),
	); err != nil {
		t.Fatal(err)
	}
	if err := control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}
	metadata, _, err := verifyRelease(
		targetRelease,
		filepath.Join(targetRelease, "SHA256SUMS"),
		checksumPin(targetRelease),
	)
	if err != nil {
		t.Fatal(err)
	}
	server, _ := metadata.RuntimeImages.Image(releaseimage.ServerRole)
	caddy, _ := metadata.RuntimeImages.Image(releaseimage.CaddyRole)
	manifest, found, err := loadManifest(installationPaths(dataRoot).ManifestPath)
	if err != nil || !found || manifest.ServerImage != server.Reference ||
		manifest.CaddyImage != caddy.Reference || manifest.LastSuccessfulStep != "ready" {
		t.Fatalf("containerd upgrade did not commit one manifest-digest pair: %+v found=%t err=%v", manifest, found, err)
	}
}

func TestOCIUpgradePartialSelectionKeepsPreparedJournalAndRetriesWithoutBackup(t *testing.T) {
	root := t.TempDir()
	currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
	targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	current, err := control.Install(
		context.Background(),
		installOptions(currentRelease, dataRoot),
	)
	if err != nil {
		t.Fatal(err)
	}
	metadata, _, err := verifyRelease(
		targetRelease,
		filepath.Join(targetRelease, "SHA256SUMS"),
		checksumPin(targetRelease),
	)
	if err != nil {
		t.Fatal(err)
	}
	caddy, _ := metadata.RuntimeImages.Image(releaseimage.CaddyRole)
	runner.unavailableImageReferences = map[string]bool{caddy.RuntimeReference: true}
	err = control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	})
	requireActionCode(t, err, "RUNTIME_IMAGE_VERIFY_FAILED")
	manifest, found, loadErr := loadManifest(current.ManifestPath)
	if loadErr != nil || !found || !manifestsEqualIgnoringUpdatedAt(manifest, current.Manifest) {
		t.Fatalf("partial upgrade selection changed the active manifest: %+v found=%t err=%v", manifest, found, loadErr)
	}
	journal, found, loadErr := loadUpgradeJournal(current.UpgradeJournalPath)
	if loadErr != nil || !found || journal.Phase != upgradePhasePrepared ||
		!runtimeImagesUnresolved(journal.Target) {
		t.Fatalf("partial upgrade selection lost its unresolved prepared boundary: %+v found=%t err=%v", journal, found, loadErr)
	}
	runner.unavailableImageReferences = nil
	if err := control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}
	if runner.backupSequence != 1 {
		t.Fatalf("runtime selection recovery repeated the verified backup: %d", runner.backupSequence)
	}
}

func TestOCIUpgradeRuntimeJournalBindFailureStopsBeforeConfigurationAndRetries(t *testing.T) {
	root := t.TempDir()
	currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
	targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	current, err := control.Install(
		context.Background(),
		installOptions(currentRelease, dataRoot),
	)
	if err != nil {
		t.Fatal(err)
	}
	journalBackup := current.UpgradeJournalPath + ".test-backup"
	platformInspections := 0
	sawTargetLoad := false
	injected := false
	runner.hook = func(command Command) {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, "docker image load --input") {
			sawTargetLoad = true
		}
		if injected || !sawTargetLoad ||
			!strings.Contains(joined, "{{.Os}}/{{.Architecture}}") {
			return
		}
		platformInspections++
		if platformInspections != 2 {
			return
		}
		journal, found, err := loadUpgradeJournal(current.UpgradeJournalPath)
		if err != nil || !found || journal.Phase != upgradePhasePrepared ||
			!runtimeImagesUnresolved(journal.Target) {
			t.Fatalf("journal bind injection saw an invalid boundary: %+v found=%t err=%v", journal, found, err)
		}
		if err := os.Rename(current.UpgradeJournalPath, journalBackup); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(current.UpgradeJournalPath, 0o700); err != nil {
			t.Fatal(err)
		}
		injected = true
	}
	start := len(runner.commands)
	err = control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	})
	requireActionCode(t, err, "UPGRADE_JOURNAL_WRITE_FAILED")
	for _, command := range runner.commands[start:] {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, " config --quiet") || strings.Contains(joined, " up -d ") {
			t.Fatalf("journal bind failure reached target configuration or services: %s", joined)
		}
	}
	manifest, found, loadErr := loadManifest(current.ManifestPath)
	if loadErr != nil || !found || !manifestsEqualIgnoringUpdatedAt(manifest, current.Manifest) {
		t.Fatalf("journal bind failure changed the active manifest: %+v found=%t err=%v", manifest, found, loadErr)
	}
	if err := os.Remove(current.UpgradeJournalPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(journalBackup, current.UpgradeJournalPath); err != nil {
		t.Fatal(err)
	}
	journal, found, loadErr := loadUpgradeJournal(current.UpgradeJournalPath)
	if loadErr != nil || !found || journal.Phase != upgradePhasePrepared ||
		!runtimeImagesUnresolved(journal.Target) {
		t.Fatalf("failed journal bind did not preserve the prepared target: %+v found=%t err=%v", journal, found, loadErr)
	}
	runner.hook = nil
	if err := control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}
	if runner.backupSequence != 1 {
		t.Fatalf("journal bind recovery repeated the verified backup: %d", runner.backupSequence)
	}
}

func TestUpgradeRejectsSchemaV2ImagesUntilLegacyManifestIsExplicitlyMigrated(t *testing.T) {
	root := t.TempDir()
	currentRelease := createRelease(t, root, "v1.2.3", 1)
	targetRelease := createOCIRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installation, err := control.Install(context.Background(), installOptions(currentRelease, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	legacy := convertInstalledManifestToLegacy(t, installation)
	start := len(runner.commands)
	requireActionCode(t, control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}), "UPGRADE_MANIFEST_MIGRATION_REQUIRED")

	manifest, _, err := loadManifest(installation.ManifestPath)
	if err != nil || manifest.SchemaVersion != legacyManifestSchemaVersion ||
		manifest.ReleaseVersion != legacy.ReleaseVersion || hasPinnedRuntimeImages(manifest) {
		t.Fatalf("rejected legacy upgrade changed the manifest: %+v err=%v", manifest, err)
	}
	for _, command := range runner.commands[start:] {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, "compose-backup.sh") ||
			strings.Contains(joined, "docker image load") || strings.Contains(joined, " up -d") {
			t.Fatalf("legacy manifest rejection crossed the mutation boundary: %s", joined)
		}
	}
}

func TestUpgradePreservesLegacyManifestForSchemaV1Release(t *testing.T) {
	root := t.TempDir()
	currentRelease := createRelease(t, root, "v1.2.3", 1)
	targetRelease := createRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installation, err := control.Install(context.Background(), installOptions(currentRelease, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	convertInstalledManifestToLegacy(t, installation)
	if err := control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}); err != nil {
		t.Fatal(err)
	}

	manifest, _, err := loadManifest(installation.ManifestPath)
	if err != nil || manifest.SchemaVersion != legacyManifestSchemaVersion ||
		manifest.ReleaseVersion != "v1.3.0" || hasPinnedRuntimeImages(manifest) {
		t.Fatalf("schema-v1 compatibility upgrade was not preserved: %+v err=%v", manifest, err)
	}
}

func TestUpgradeRejectsPinnedOCIInstallationDowngradeToLegacySourceBuild(t *testing.T) {
	root := t.TempDir()
	currentRelease := createOCIRelease(t, root, "v1.2.3", 1)
	targetRelease := createRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	installation, err := control.Install(context.Background(), installOptions(currentRelease, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	if !hasPinnedRuntimeImages(installation.Manifest) {
		t.Fatal("test precondition omitted pinned runtime images")
	}
	start := len(runner.commands)
	requireActionCode(t, control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}), "UPGRADE_IMAGE_AUTHORITY_DOWNGRADE")

	manifest, _, err := loadManifest(installation.ManifestPath)
	if err != nil || manifest.ReleaseVersion != installation.Manifest.ReleaseVersion ||
		manifest.ServerImage != installation.Manifest.ServerImage ||
		manifest.CaddyImage != installation.Manifest.CaddyImage ||
		manifest.RuntimeImagePlatform != installation.Manifest.RuntimeImagePlatform {
		t.Fatalf("rejected authority downgrade changed the manifest: %+v err=%v", manifest, err)
	}
	for _, command := range runner.commands[start:] {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, "compose-backup.sh") ||
			strings.Contains(joined, "docker image load") || strings.Contains(joined, " up -d") {
			t.Fatalf("authority downgrade rejection crossed the mutation boundary: %s", joined)
		}
	}
}

func TestFailedUpgradeReportsActiveImageAndPreservesOldManifest(t *testing.T) {
	root := t.TempDir()
	currentRelease := createRelease(t, root, "v1.2.3", 1)
	targetRelease := createRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(context.Background(), installOptions(currentRelease, dataRoot)); err != nil {
		t.Fatal(err)
	}
	runner.failOnce[" up -d --build"] = 1
	err := control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	})
	action := requireActionCode(t, err, "UPGRADE_START_FAILED")
	if !strings.Contains(action.Message, "convenewire/server") {
		t.Fatalf("failed upgrade omitted active image state: %s", action.Message)
	}
	manifest, _, _ := loadManifest(installationPaths(dataRoot).ManifestPath)
	if manifest.ReleaseVersion != "v1.2.3" {
		t.Fatalf("failed upgrade changed the committed manifest: %s", manifest.ReleaseVersion)
	}
}

func TestUpgradeRejectsMalformedOwnerSecretBeforeBackupOrCompose(t *testing.T) {
	root := t.TempDir()
	currentRelease := createRelease(t, root, "v1.2.3", 1)
	targetRelease := createRelease(t, root, "v1.3.0", 2)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(context.Background(), installOptions(currentRelease, dataRoot)); err != nil {
		t.Fatal(err)
	}
	paths := installationPaths(dataRoot)
	if err := os.WriteFile(paths.OwnerSecretPath, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	start := len(runner.commands)
	requireActionCode(t, control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}), "UPGRADE_SECRET_INVALID")
	for _, command := range runner.commands[start:] {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if command.Name == "bash" || strings.Contains(joined, " config --quiet") || strings.Contains(joined, " up -d") {
			t.Fatalf("invalid recovery secret crossed the upgrade mutation boundary: %s", joined)
		}
	}
	if info, err := os.Stat(paths.OwnerSecretPath); err != nil || info.Size() != 0 {
		t.Fatalf("upgrade regenerated or replaced the invalid recovery secret: %v %v", info, err)
	}
	manifest, _, _ := loadManifest(paths.ManifestPath)
	if manifest.ReleaseVersion != "v1.2.3" || manifest.LastSuccessfulStep != "ready" {
		t.Fatalf("secret preflight failure changed the committed manifest: %+v", manifest)
	}
}

func TestDoctorRejectsMalformedOwnerSecretBeforeReadiness(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	readinessChecks := 0
	dependencies := testDependencies(runner, &bytes.Buffer{})
	dependencies.CheckReadiness = func(context.Context, ReadinessInput) error {
		readinessChecks++
		return nil
	}
	control := New(dependencies)
	if _, err := control.Install(context.Background(), installOptions(releaseDir, dataRoot)); err != nil {
		t.Fatal(err)
	}
	readinessChecks = 0
	paths := installationPaths(dataRoot)
	if err := os.WriteFile(paths.OwnerSecretPath, []byte("not-a-valid-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	requireActionCode(t, control.Doctor(context.Background(), dataRoot), "SECRET_INVALID")
	if readinessChecks != 0 {
		t.Fatal("doctor reached network readiness with a malformed recovery secret")
	}
}

func TestUpgradeRejectsAnotherHostTargetBeforeBackup(t *testing.T) {
	root := t.TempDir()
	currentRelease := createRelease(t, root, "v1.2.3", 1)
	targetRelease := createReleaseForTarget(t, root, "v1.3.0", 2, "darwin", "arm64")
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	control := New(testDependencies(runner, &bytes.Buffer{}))
	if _, err := control.Install(context.Background(), installOptions(currentRelease, dataRoot)); err != nil {
		t.Fatal(err)
	}
	start := len(runner.commands)
	requireActionCode(t, control.Upgrade(context.Background(), UpgradeOptions{
		DataRoot: dataRoot, ReleaseDir: targetRelease,
		ChecksumsSHA256: checksumPin(targetRelease),
	}), "RELEASE_TARGET_MISMATCH")
	for _, command := range runner.commands[start:] {
		if command.Name == "bash" {
			t.Fatal("target mismatch triggered an upgrade backup or release script")
		}
	}
}

func TestDirectHTTPSDefaultsToPublicCAAndRejectsIneligibleHosts(t *testing.T) {
	control := New(testDependencies(&fakeRunner{failOnce: map[string]int{}}, &bytes.Buffer{}))
	base := InstallOptions{
		ReleaseDir: "/tmp/release", ChecksumsSHA256: strings.Repeat("a", 64),
		DataRoot: "/tmp/state", Mode: "direct_https", Domain: "team.example.com",
		PublicOrigin: "https://team.example.com:9443", HTTPPort: 9080, HTTPSPort: 9443,
	}
	normalized, err := control.normalizeInstallOptions(base)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := resolveInstallTLSProfile(normalized, Manifest{}, false)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.TLSProfile != "public_ca" {
		t.Fatalf("expected public_ca default, got %q", resolved.TLSProfile)
	}

	ipOrigin := base
	ipOrigin.Domain = "192.0.2.25"
	ipOrigin.PublicOrigin = "https://192.0.2.25:9443"
	normalized, err = control.normalizeInstallOptions(ipOrigin)
	if err != nil {
		t.Fatal(err)
	}
	_, err = resolveInstallTLSProfile(normalized, Manifest{}, false)
	requireActionCode(t, err, "PUBLIC_CA_HOST_INVALID")

	ipOrigin.TLSProfile = "private_scoped_ca"
	normalized, err = control.normalizeInstallOptions(ipOrigin)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err = resolveInstallTLSProfile(normalized, Manifest{}, false)
	if err != nil || resolved.TLSProfile != "private_scoped_ca" {
		t.Fatalf("private IP scoped profile: %+v %v", resolved, err)
	}

	local := base
	local.Mode = "local"
	local.Domain = "localhost"
	local.PublicOrigin = "https://localhost:9443"
	local.TLSProfile = "manual_ca"
	_, err = control.normalizeInstallOptions(local)
	requireActionCode(t, err, "TLS_PROFILE_INVALID")
}

func TestPrivateScopedInstallPublishesStableBoundedTrust(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	writtenDigest := ""
	runner := &fakeRunner{failOnce: map[string]int{}}
	runner.hook = func(command Command) {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if strings.Contains(joined, " up ") {
			manifest, found, err := loadManifest(installationPaths(dataRoot).ManifestPath)
			if err != nil || !found {
				t.Fatalf("load private manifest from start hook: found=%v err=%v", found, err)
			}
			caPath := privateCARootPath(manifest, activePrivateCAID(manifest))
			if _, err := os.Stat(caPath); errors.Is(err, os.ErrNotExist) {
				writtenDigest = writeTestCA(t, caPath, now)
			}
		}
	}
	var output bytes.Buffer
	dependencies := testDependencies(runner, &output)
	var readiness ReadinessInput
	dependencies.CheckReadiness = func(_ context.Context, input ReadinessInput) error {
		readiness = input
		return nil
	}
	control := New(dependencies)
	options := installOptions(releaseDir, dataRoot)
	options.Mode = "direct_https"
	options.TLSProfile = "private_scoped_ca"
	options.Domain = "192.0.2.25"
	options.PublicOrigin = "https://192.0.2.25:19443"
	installation, err := control.Install(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	manifest := installation.Manifest
	if manifest.SchemaVersion != 2 || !installIDPattern.MatchString(manifest.InstallationID) || manifest.TrustEpoch != 1 {
		t.Fatalf("unexpected trust identity: %+v", manifest)
	}
	if manifest.CACertificateSHA256 != writtenDigest || readiness.ExpectedCADigest != writtenDigest || readiness.TLSProfile != "private_scoped_ca" {
		t.Fatalf("private digest/readiness mismatch: manifest=%+v readiness=%+v", manifest, readiness)
	}
	descriptorBytes, err := os.ReadFile(installation.TrustDescriptorPath)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor deploymentTrustDescriptor
	if err := decodeStrictJSON(descriptorBytes, &descriptor); err != nil {
		t.Fatal(err)
	}
	if descriptor.Origin != options.PublicOrigin || descriptor.InstallationID != manifest.InstallationID ||
		descriptor.TrustEpoch != 1 || descriptor.CACertificateSHA256 != writtenDigest {
		t.Fatalf("unexpected descriptor: %+v", descriptor)
	}
	if _, _, digest, err := loadSingleCACertificate(installation.TrustCAPEMPath, now); err != nil || digest != writtenDigest {
		t.Fatalf("canonical public CA artifact: digest=%s err=%v", digest, err)
	}
	if bytes.Contains(descriptorBytes, []byte("PRIVATE KEY")) || strings.Contains(output.String(), writtenDigest) {
		t.Fatal("private material or full CA digest escaped the bounded deployment projection")
	}
	firstID := manifest.InstallationID
	second, err := control.Install(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if second.Manifest.InstallationID != firstID || second.Manifest.TrustEpoch != 1 {
		t.Fatal("reentry changed the stable private trust identity")
	}
	environment, err := os.ReadFile(installation.EnvironmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(environment, []byte(installation.CaddyTLSProfilePath)) ||
		!bytes.Contains(environment, []byte(installation.CaddyPKIProfilePath)) ||
		!bytes.Contains(environment, []byte("/run/agentroom/trust/deployment-trust.json")) ||
		!bytes.Contains(environment, []byte("/run/agentroom/trust/deployment-trust-rotation.json")) {
		t.Fatalf("private profile was not rendered: %s", environment)
	}
	profile, err := os.ReadFile(installation.CaddyTLSProfilePath)
	if err != nil || !bytes.Contains(profile, []byte("ca "+manifest.PrivateCAID)) ||
		bytes.Count(profile, []byte("issuer internal")) != 1 ||
		!bytes.Contains(profile, []byte("/.well-known/convenewire/bridge-ca.pem")) ||
		!bytes.Contains(profile, []byte("/.well-known/agentroom/bridge-ca.pem")) {
		t.Fatalf("private authority profile was not exact: %s err=%v", profile, err)
	}
	pkiProfile, err := os.ReadFile(installation.CaddyPKIProfilePath)
	if err != nil || !bytes.Contains(pkiProfile, []byte("ca "+manifest.PrivateCAID)) ||
		bytes.Count(pkiProfile, []byte("ca ")) != 1 {
		t.Fatalf("private PKI profile was not exact: %s err=%v", pkiProfile, err)
	}
}

func TestPrivateCaddyProfileMigratesLegacyPublicPathWithoutChangingAuthority(t *testing.T) {
	root := t.TempDir()
	installation := installationPaths(root)
	installation.Manifest = Manifest{
		SchemaVersion:  manifestSchemaVersion,
		InstallationID: "install_0123456789abcdefghijklmn",
		TrustEpoch:     1, PrivateCAID: "agentroom-1-77cb3afc1117cbe0",
	}
	if err := os.MkdirAll(installation.TrustDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	legacy, err := privateCaddyTLSProfileForPaths(
		[]string{"/.well-known/agentroom/bridge-ca.pem"}, installation.Manifest.PrivateCAID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(installation.CaddyTLSProfilePath, legacy, 0o644); err != nil {
		t.Fatal(err)
	}
	pki, err := privateCaddyPKIProfile(installation.Manifest.PrivateCAID)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeAtomic(installation.CaddyPKIProfilePath, pki, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensurePrivateCaddyProfiles(installation); err != nil {
		t.Fatal(err)
	}
	migrated, err := os.ReadFile(installation.CaddyTLSProfilePath)
	if err != nil || bytes.Count(migrated, []byte("issuer internal")) != 1 ||
		bytes.Count(migrated, []byte("ca "+installation.Manifest.PrivateCAID)) != 1 ||
		!bytes.Contains(migrated, []byte("/.well-known/convenewire/bridge-ca.pem")) ||
		!bytes.Contains(migrated, []byte("/.well-known/agentroom/bridge-ca.pem")) {
		t.Fatalf("legacy public path did not migrate to dual compatibility: %s err=%v", migrated, err)
	}
}

func TestPrivateHostnameMigrationPreservesIdentityAuthorityAndDataBoundary(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	runner := &fakeRunner{failOnce: map[string]int{}}
	runner.hook = provisionConfiguredPrivateCAs(t, dataRoot, now, map[string]string{})
	var output bytes.Buffer
	dependencies := testDependencies(runner, &output)
	readiness := []ReadinessInput{}
	dependencies.CheckReadiness = func(_ context.Context, input ReadinessInput) error {
		readiness = append(readiness, input)
		return nil
	}
	control := New(dependencies)
	installed, err := control.Install(context.Background(), privateScopedOptions(releaseDir, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	before := installed.Manifest
	beforeCA, err := os.ReadFile(installed.TrustCAPEMPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := control.MigratePrivateHostname(context.Background(), PrivateHostnameMigrationOptions{
		DataRoot: dataRoot,
		Hostname: "Central.Local",
	}); err != nil {
		t.Fatal(err)
	}
	after, found, err := loadManifest(installed.ManifestPath)
	if err != nil || !found {
		t.Fatalf("load migrated manifest: found=%v err=%v", found, err)
	}
	if after.Domain != "central.local" || after.PublicOrigin != "https://central.local:19443" {
		t.Fatalf("hostname migration did not commit exact target origin: %+v", after)
	}
	expected := before
	expected.Generation = after.Generation
	expected.Domain = after.Domain
	expected.PublicOrigin = after.PublicOrigin
	expected.UpdatedAt = after.UpdatedAt
	if after != expected {
		t.Fatalf("hostname migration changed identity or lifecycle fields:\nbefore=%+v\nafter=%+v", before, after)
	}
	afterCA, err := os.ReadFile(installed.TrustCAPEMPath)
	if err != nil || !bytes.Equal(beforeCA, afterCA) {
		t.Fatal("hostname migration replaced the private CA artifact")
	}
	descriptorBytes, err := os.ReadFile(installed.TrustDescriptorPath)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor deploymentTrustDescriptor
	if err := decodeStrictJSON(descriptorBytes, &descriptor); err != nil ||
		descriptor.Origin != after.PublicOrigin ||
		descriptor.InstallationID != before.InstallationID ||
		descriptor.TrustEpoch != before.TrustEpoch ||
		descriptor.CACertificateSHA256 != before.CACertificateSHA256 {
		t.Fatalf("hostname migration changed scoped trust authority: %+v err=%v", descriptor, err)
	}
	environment, err := os.ReadFile(installed.EnvironmentPath)
	if err != nil || !bytes.Contains(environment, []byte(`CONVENE_WIRE_DOMAIN="central.local"`)) ||
		!bytes.Contains(environment, []byte(`CONVENE_WIRE_PUBLIC_ORIGIN="https://central.local:19443"`)) {
		t.Fatalf("canonical hostname environment was not committed: %s err=%v", environment, err)
	}
	if len(readiness) < 3 || readiness[len(readiness)-1].PublicOrigin != after.PublicOrigin ||
		readiness[len(readiness)-1].ExpectedCADigest != before.CACertificateSHA256 {
		t.Fatalf("target did not pass exact same-CA readiness: %+v", readiness)
	}
	if strings.Contains(output.String(), before.CACertificateSHA256) {
		t.Fatal("hostname migration output disclosed the full CA digest")
	}
	for _, command := range runner.commands {
		if command.Name == "bash" {
			t.Fatal("hostname migration invoked a data migration or backup script")
		}
	}
}

func TestPrivateHostnameMigrationRejectsRotationAndRestoresOldTopologyOnFailure(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	runner := &fakeRunner{failOnce: map[string]int{}}
	runner.hook = provisionConfiguredPrivateCAs(t, dataRoot, now, map[string]string{})
	dependencies := testDependencies(runner, &bytes.Buffer{})
	dependencies.CheckReadiness = func(_ context.Context, input ReadinessInput) error {
		if strings.Contains(input.PublicOrigin, "central.local") {
			return fmt.Errorf("injected target hostname failure")
		}
		return nil
	}
	control := New(dependencies)
	installed, err := control.Install(context.Background(), privateScopedOptions(releaseDir, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installed.TrustRotationPath, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	requireActionCode(t, control.MigratePrivateHostname(context.Background(), PrivateHostnameMigrationOptions{
		DataRoot: dataRoot, Hostname: "central.local",
	}), "PRIVATE_HOSTNAME_ROTATION_ACTIVE")
	if err := os.Remove(installed.TrustRotationPath); err != nil {
		t.Fatal(err)
	}
	beforeManifest, err := os.ReadFile(installed.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	beforeEnvironment, _ := os.ReadFile(installed.EnvironmentPath)
	beforeOverride, _ := os.ReadFile(installed.OverridePath)
	beforeDescriptor, _ := os.ReadFile(installed.TrustDescriptorPath)
	beforeCA, _ := os.ReadFile(installed.TrustCAPEMPath)
	requireActionCode(t, control.MigratePrivateHostname(context.Background(), PrivateHostnameMigrationOptions{
		DataRoot: dataRoot, Hostname: "central.local",
	}), "PRIVATE_HOSTNAME_MIGRATION_FAILED")
	for path, expected := range map[string][]byte{
		installed.ManifestPath:        beforeManifest,
		installed.EnvironmentPath:     beforeEnvironment,
		installed.OverridePath:        beforeOverride,
		installed.TrustDescriptorPath: beforeDescriptor,
		installed.TrustCAPEMPath:      beforeCA,
	} {
		actual, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(actual, expected) {
			t.Fatalf("rollback did not restore %s: %v", filepath.Base(path), err)
		}
	}
	for _, hostname := range []string{"192.0.2.99", "localhost", "bad host"} {
		requireActionCode(t, control.MigratePrivateHostname(context.Background(), PrivateHostnameMigrationOptions{
			DataRoot: dataRoot, Hostname: hostname,
		}), "PRIVATE_HOSTNAME_INVALID")
	}
}

func privateScopedOptions(releaseDir, dataRoot string) InstallOptions {
	options := installOptions(releaseDir, dataRoot)
	options.Mode = "direct_https"
	options.TLSProfile = "private_scoped_ca"
	options.Domain = "192.0.2.25"
	options.PublicOrigin = "https://192.0.2.25:19443"
	return options
}

func provisionConfiguredPrivateCAs(
	t *testing.T,
	dataRoot string,
	now time.Time,
	digests map[string]string,
) func(Command) {
	t.Helper()
	return func(command Command) {
		joined := command.Name + " " + strings.Join(command.Args, " ")
		if !strings.Contains(joined, " up ") && !strings.Contains(joined, " restart ") {
			return
		}
		installation := installationPaths(dataRoot)
		manifest, found, err := loadManifest(installation.ManifestPath)
		if err != nil || !found {
			t.Fatalf("load private manifest from Caddy hook: found=%v err=%v", found, err)
		}
		profile, err := os.ReadFile(installation.CaddyTLSProfilePath)
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range strings.Split(string(profile), "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "ca ") {
				continue
			}
			caID := strings.TrimSpace(strings.TrimPrefix(line, "ca "))
			path := privateCARootPath(manifest, caID)
			if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
				digests[caID] = writeTestCA(t, path, now)
			}
		}
	}
}

func TestPrivateCARotationWaitsForAcknowledgementsAndCommitsNextAuthority(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	digests := map[string]string{}
	runner := &fakeRunner{failOnce: map[string]int{}}
	runner.hook = provisionConfiguredPrivateCAs(t, dataRoot, now, digests)
	var output bytes.Buffer
	dependencies := testDependencies(runner, &output)
	var readiness []ReadinessInput
	dependencies.CheckReadiness = func(_ context.Context, input ReadinessInput) error {
		readiness = append(readiness, input)
		return nil
	}
	control := New(dependencies)
	options := privateScopedOptions(releaseDir, dataRoot)
	installed, err := control.Install(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	currentDigest := installed.Manifest.CACertificateSHA256
	if err := control.PreparePrivateCARotation(context.Background(), PrivateCARotationOptions{
		DataRoot: dataRoot,
		Overlap:  2 * time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	offerBefore, err := os.ReadFile(installed.TrustRotationPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := control.PreparePrivateCARotation(context.Background(), PrivateCARotationOptions{
		DataRoot: dataRoot,
		Overlap:  2 * time.Hour,
	}); err != nil {
		t.Fatal(err)
	}
	offerAfter, _ := os.ReadFile(installed.TrustRotationPath)
	if !bytes.Equal(offerBefore, offerAfter) {
		t.Fatal("idempotent prepare changed the staged CA or overlap")
	}
	var offer privateCARotationOffer
	if err := decodeStrictJSON(offerBefore, &offer); err != nil {
		t.Fatal(err)
	}
	if offer.CurrentTrustEpoch != 1 || offer.NextTrust.TrustEpoch != 2 ||
		offer.NextTrust.CACertificateSHA256 == currentDigest ||
		strings.Contains(string(offerBefore), "PRIVATE KEY") {
		t.Fatalf("unexpected bounded rotation offer: %+v", offer)
	}
	profile, _ := os.ReadFile(installed.CaddyTLSProfilePath)
	if bytes.Count(profile, []byte("issuer internal")) != 2 {
		t.Fatalf("prepare did not stage exactly two authorities: %s", profile)
	}
	pkiProfile, _ := os.ReadFile(installed.CaddyPKIProfilePath)
	if bytes.Count(pkiProfile, []byte("ca ")) != 2 {
		t.Fatalf("prepare did not declare exactly two PKI authorities: %s", pkiProfile)
	}
	runner.rotationAcknowledgementResponse = `{"eligible":2,"acknowledged":1}`
	requireActionCode(t, control.ActivatePrivateCARotation(context.Background(), dataRoot), "PRIVATE_ROTATION_ACK_PENDING")
	manifest, _, _ := loadManifest(installed.ManifestPath)
	if manifest.TrustEpoch != 1 || manifest.CACertificateSHA256 != currentDigest {
		t.Fatal("pending acknowledgements changed active trust")
	}
	runner.rotationAcknowledgementResponse = `{"eligible":2,"acknowledged":2}`
	if err := control.ActivatePrivateCARotation(context.Background(), dataRoot); err != nil {
		t.Fatal(err)
	}
	manifest, _, _ = loadManifest(installed.ManifestPath)
	if manifest.TrustEpoch != 2 || manifest.CACertificateSHA256 != offer.NextTrust.CACertificateSHA256 ||
		manifest.PrivateCAID != privateCAID(manifest.InstallationID, 2) {
		t.Fatalf("rotation did not commit the exact next authority: %+v", manifest)
	}
	profile, _ = os.ReadFile(installed.CaddyTLSProfilePath)
	if bytes.Count(profile, []byte("issuer internal")) != 1 ||
		!bytes.Contains(profile, []byte("ca "+manifest.PrivateCAID)) {
		t.Fatalf("activation did not retire the old served authority: %s", profile)
	}
	pkiProfile, _ = os.ReadFile(installed.CaddyPKIProfilePath)
	if bytes.Count(pkiProfile, []byte("ca ")) != 1 ||
		!bytes.Contains(pkiProfile, []byte("ca "+manifest.PrivateCAID)) {
		t.Fatalf("activation did not retire the old PKI declaration: %s", pkiProfile)
	}
	for _, path := range []string{installed.TrustRotationPath, installed.RotationJournalPath} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("completed rotation retained %s: %v", path, err)
		}
	}
	descriptorBytes, err := os.ReadFile(installed.TrustDescriptorPath)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor deploymentTrustDescriptor
	if err := decodeStrictJSON(descriptorBytes, &descriptor); err != nil ||
		descriptor.TrustEpoch != 2 || descriptor.CACertificateSHA256 != manifest.CACertificateSHA256 {
		t.Fatalf("published descriptor did not advance: %+v err=%v", descriptor, err)
	}
	lastReadiness := readiness[len(readiness)-1]
	if lastReadiness.ExpectedCADigest != manifest.CACertificateSHA256 ||
		lastReadiness.LocalCARoot != privateCARootPath(manifest, manifest.PrivateCAID) {
		t.Fatalf("activation readiness did not pin the next CA: %+v", lastReadiness)
	}
	if strings.Contains(output.String(), currentDigest) || strings.Contains(output.String(), manifest.CACertificateSHA256) {
		t.Fatal("rotation output disclosed a full CA digest")
	}
	if _, err := control.Install(context.Background(), options); err != nil {
		t.Fatalf("post-rotation install reentry did not preserve epoch 2: %v", err)
	}
}

func TestPrivateCARotationRestoresCurrentFirstOverlapAfterReadinessFailure(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	runner := &fakeRunner{failOnce: map[string]int{}, rotationAcknowledgementResponse: `{"eligible":0,"acknowledged":0}`}
	runner.hook = provisionConfiguredPrivateCAs(t, dataRoot, now, map[string]string{})
	dependencies := testDependencies(runner, &bytes.Buffer{})
	initialDigest := ""
	dependencies.CheckReadiness = func(_ context.Context, input ReadinessInput) error {
		if initialDigest != "" && input.ExpectedCADigest != initialDigest {
			return fmt.Errorf("injected next-chain failure")
		}
		return nil
	}
	control := New(dependencies)
	installed, err := control.Install(context.Background(), privateScopedOptions(releaseDir, dataRoot))
	if err != nil {
		t.Fatal(err)
	}
	initialDigest = installed.Manifest.CACertificateSHA256
	if err := control.PreparePrivateCARotation(context.Background(), PrivateCARotationOptions{DataRoot: dataRoot}); err != nil {
		t.Fatal(err)
	}
	requireActionCode(t, control.ActivatePrivateCARotation(context.Background(), dataRoot), "PRIVATE_ROTATION_READINESS_FAILED")
	manifest, _, _ := loadManifest(installed.ManifestPath)
	if manifest.TrustEpoch != 1 || manifest.CACertificateSHA256 != initialDigest {
		t.Fatal("failed activation changed the manifest trust authority")
	}
	profile, _ := os.ReadFile(installed.CaddyTLSProfilePath)
	currentID := activePrivateCAID(manifest)
	nextID := privateCAID(manifest.InstallationID, 2)
	if !bytes.Contains(profile, []byte("ca "+currentID)) ||
		!bytes.Contains(profile, []byte("ca "+nextID)) ||
		bytes.Index(profile, []byte("ca "+currentID)) > bytes.Index(profile, []byte("ca "+nextID)) {
		t.Fatalf("rollback did not restore current-first overlap: %s", profile)
	}
	if _, err := os.Stat(installed.TrustRotationPath); err != nil {
		t.Fatal("failed activation removed the live offer")
	}
	if _, err := os.Stat(installed.RotationJournalPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("successful rollback retained an activation journal")
	}
}

func TestLegacyManifestIsReadableButCannotBeRelabeled(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "installation.json")
	legacy := Manifest{
		SchemaVersion:  legacyManifestSchemaVersion,
		ReleaseVersion: "v1.2.3", ReleaseDir: "/release", ReleaseDigest: strings.Repeat("a", 64),
		DataSchemaVersion: 1, DataRoot: "/state", Mode: "direct_https", Domain: "192.0.2.25",
		PublicOrigin: "https://192.0.2.25:9443", HTTPPort: 9080, HTTPSPort: 9443,
		ProjectName: "agentroom", LastSuccessfulStep: "ready",
	}
	if err := saveManifest(path, legacy); err != nil {
		t.Fatal(err)
	}
	loaded, found, err := loadManifest(path)
	if err != nil || !found || manifestTLSProfile(loaded) != "legacy_unclassified" {
		t.Fatalf("legacy manifest classification: %+v %t %v", loaded, found, err)
	}
	_, err = resolveInstallTLSProfile(InstallOptions{Mode: "direct_https", TLSProfile: "private_scoped_ca"}, loaded, true)
	requireActionCode(t, err, "TLS_PROFILE_MIGRATION_REQUIRED")
	preserved, err := resolveInstallTLSProfile(InstallOptions{Mode: "direct_https"}, loaded, true)
	if err != nil || preserved.TLSProfile != "" {
		t.Fatalf("legacy reentry was not preserved: %+v %v", preserved, err)
	}
}

func convertInstalledManifestToLegacy(
	t *testing.T,
	installation Installation,
) Manifest {
	t.Helper()
	legacy := installation.Manifest
	legacy.SchemaVersion = legacyManifestSchemaVersion
	legacy.TLSProfile = ""
	legacy.InstallationID = ""
	legacy.TrustEpoch = 0
	legacy.CACertificateSHA256 = ""
	legacy.PrivateCAID = ""
	if err := saveManifest(installation.ManifestPath, legacy); err != nil {
		t.Fatal(err)
	}
	legacyInstallation := installation
	legacyInstallation.Manifest = legacy
	if err := renderConfiguration(InstallOptions{
		ReleaseDir: legacy.ReleaseDir, DataRoot: legacy.DataRoot,
		Mode: legacy.Mode, TLSProfile: "", Domain: legacy.Domain,
		PublicOrigin: legacy.PublicOrigin,
		HTTPPort:     legacy.HTTPPort, HTTPSPort: legacy.HTTPSPort,
		LegacyServerToken: legacy.LegacyServerToken,
		ProjectName:       legacy.ProjectName,
	}, legacy.ReleaseVersion, legacyInstallation); err != nil {
		t.Fatal(err)
	}
	return legacy
}

func TestLegacyPublicCAMigrationRequiresSystemTrustAndCommitsSchemaV2(t *testing.T) {
	root := t.TempDir()
	releaseDir := createRelease(t, root, "v1.2.3", 1)
	dataRoot := filepath.Join(root, "state")
	runner := &fakeRunner{failOnce: map[string]int{}}
	var output bytes.Buffer
	dependencies := testDependencies(runner, &output)
	readinessCalls := 0
	dependencies.CheckReadiness = func(_ context.Context, input ReadinessInput) error {
		readinessCalls++
		if input.TLSProfile != "public_ca" {
			t.Fatalf("legacy public inspection weakened system trust: %+v", input)
		}
		return nil
	}
	control := New(dependencies)
	options := installOptions(releaseDir, dataRoot)
	options.Mode = "direct_https"
	options.Domain = "team.example.com"
	options.PublicOrigin = "https://team.example.com:19443"
	installation, err := control.Install(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	convertInstalledManifestToLegacy(t, installation)
	readinessCalls = 0
	if err := control.MigrateLegacyPublicCA(context.Background(), dataRoot); err != nil {
		t.Fatal(err)
	}
	if readinessCalls != 2 {
		t.Fatalf("migration did not inspect system trust before and after configuration: %d", readinessCalls)
	}
	manifest, _, _ := loadManifest(installation.ManifestPath)
	if manifest.SchemaVersion != manifestSchemaVersion || manifest.TLSProfile != "public_ca" ||
		!installIDPattern.MatchString(manifest.InstallationID) || manifest.TrustEpoch != 0 ||
		manifest.CACertificateSHA256 != "" || manifest.PrivateCAID != "" {
		t.Fatalf("legacy public migration did not commit a bounded schema-v2 identity: %+v", manifest)
	}
	environment, _ := os.ReadFile(installation.EnvironmentPath)
	if !bytes.Contains(environment, []byte("public-ca.caddy")) ||
		bytes.Contains(environment, []byte("legacy-auto.caddy")) {
		t.Fatalf("migration did not select the explicit public profile: %s", environment)
	}
	if !strings.Contains(output.String(), "public_ca") {
		t.Fatal("migration output omitted the inspected profile")
	}

	blockedRoot := filepath.Join(root, "blocked-state")
	blockedRunner := &fakeRunner{failOnce: map[string]int{}}
	blockedDependencies := testDependencies(blockedRunner, &bytes.Buffer{})
	blockInspection := false
	blockedDependencies.CheckReadiness = func(context.Context, ReadinessInput) error {
		if blockInspection {
			return fmt.Errorf("untrusted legacy chain")
		}
		return nil
	}
	blockedControl := New(blockedDependencies)
	blockedOptions := options
	blockedOptions.DataRoot = blockedRoot
	blocked, err := blockedControl.Install(context.Background(), blockedOptions)
	if err != nil {
		t.Fatal(err)
	}
	legacy := convertInstalledManifestToLegacy(t, blocked)
	blockInspection = true
	requireActionCode(t, blockedControl.MigrateLegacyPublicCA(context.Background(), blockedRoot), "TLS_PROFILE_NOT_PUBLIC")
	unchanged, _, _ := loadManifest(blocked.ManifestPath)
	if unchanged.SchemaVersion != legacy.SchemaVersion || unchanged.TLSProfile != "" || unchanged.InstallationID != "" {
		t.Fatal("failed public trust inspection relabeled the legacy manifest")
	}
}

func TestPrivateCAParserRejectsMultipleCertificates(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "root.crt")
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	writeTestCA(t, path, now)
	value, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(value, value...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := loadSingleCACertificate(path, now); err == nil {
		t.Fatal("multiple CA certificates were accepted")
	}
}

func TestManifestContainsNoSecretFields(t *testing.T) {
	value, err := json.Marshal(Manifest{})
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ToLower(string(value))
	for _, forbidden := range []string{
		"tokenvalue", "secretvalue", "credentialplaintext", "workspacepath", "runtimecommand",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("manifest schema contains forbidden secret/local field %q: %s", forbidden, value)
		}
	}
}
