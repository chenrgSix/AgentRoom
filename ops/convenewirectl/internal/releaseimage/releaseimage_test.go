package releaseimage

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const (
	testReleaseVersion = "v0.4.0-test.1"
	testSourceCommit   = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testPlatform       = "linux/amd64"
	testBuilderID      = "https://github.com/chenrgSix/AgentRoom/actions/runs/123"
)

type rawOCIFixtureOptions struct {
	repository     string
	platform       string
	releaseVersion string
	sourceCommit   string
	omitSBOM       bool
	sbomRepository string
}

type finalizedFixture struct {
	bundleRoot       string
	archivePath      string
	metadataPath     string
	metadataRelative string
	metadata         Metadata
}

func TestFinalizeAndVerifyBundle(t *testing.T) {
	fixture := createFinalizedFixture(t)

	verified, err := VerifyBundle(
		fixture.bundleRoot,
		fixture.metadataRelative,
		testReleaseVersion,
		testSourceCommit,
		"amd64",
	)
	if err != nil {
		t.Fatalf("VerifyBundle() error = %v", err)
	}
	if verified.Archive != fixture.metadata.Archive || verified.ArchiveSHA256 != fixture.metadata.ArchiveSHA256 {
		t.Fatalf("VerifyBundle() metadata = %#v, want archive identity %#v", verified, fixture.metadata)
	}
	if len(verified.Images) != 2 {
		t.Fatalf("VerifyBundle() image count = %d, want 2", len(verified.Images))
	}
	if verified.SchemaVersion != 2 {
		t.Fatalf("VerifyBundle() schema version = %d, want 2", verified.SchemaVersion)
	}
	scan, err := scanArchive(fixture.archivePath, true)
	if err != nil {
		t.Fatalf("scan finalized archive: %v", err)
	}
	dockerManifest, err := decodeDockerManifest(scan.SmallFiles["manifest.json"])
	if err != nil {
		t.Fatalf("decode finalized Docker manifest: %v", err)
	}
	for _, role := range []string{ServerRole, CaddyRole} {
		image, ok := verified.Image(role)
		if !ok {
			t.Fatalf("VerifyBundle() omitted %s image", role)
		}
		if image.Reference != image.Repository+"@"+image.Digest {
			t.Fatalf("VerifyBundle() %s reference = %q, want digest-only reference", role, image.Reference)
		}
		if !sha256Pattern.MatchString(image.RuntimeReference) {
			t.Fatalf("VerifyBundle() %s runtime reference = %q, want config digest", role, image.RuntimeReference)
		}
		matched := false
		for _, item := range dockerManifest {
			if len(item.RepoTags) == 1 && item.RepoTags[0] == image.Repository+":"+testReleaseVersion {
				matched = item.Config == dockerBlobPath(image.RuntimeReference)
			}
		}
		if !matched {
			t.Fatalf("Docker manifest does not bind %s runtime reference %q", role, image.RuntimeReference)
		}
		if image.SBOM.PredicateType != SPDXPredicateType {
			t.Fatalf("VerifyBundle() %s SBOM predicate = %q", role, image.SBOM.PredicateType)
		}
	}
}

func TestVerifyBundleRejectsDockerManifestMismatch(t *testing.T) {
	tests := []struct {
		name          string
		mutate        func([]dockerManifestItem) []dockerManifestItem
		wantSubstring string
	}{
		{
			name: "extra image",
			mutate: func(items []dockerManifestItem) []dockerManifestItem {
				return append(items, items[0])
			},
			wantSubstring: "must contain exactly the declared runtime images",
		},
		{
			name: "extra role tag",
			mutate: func(items []dockerManifestItem) []dockerManifestItem {
				items[0].RepoTags = append(items[0].RepoTags, "example.invalid/extra:latest")
				return items
			},
			wantSubstring: "exactly one role tag",
		},
		{
			name: "duplicate role tag",
			mutate: func(items []dockerManifestItem) []dockerManifestItem {
				items[1].RepoTags = append([]string(nil), items[0].RepoTags...)
				return items
			},
			wantSubstring: "duplicate role tag",
		},
		{
			name: "unexpected role tag",
			mutate: func(items []dockerManifestItem) []dockerManifestItem {
				items[0].RepoTags[0] = "example.invalid/server:" + testReleaseVersion
				return items
			},
			wantSubstring: "unexpected role tag",
		},
		{
			name: "duplicate config",
			mutate: func(items []dockerManifestItem) []dockerManifestItem {
				items[1].Config = items[0].Config
				return items
			},
			wantSubstring: "duplicate config path",
		},
		{
			name: "wrong config",
			mutate: func(items []dockerManifestItem) []dockerManifestItem {
				items[0].Config = items[0].Layers[0]
				return items
			},
			wantSubstring: "config for server does not match OCI manifest",
		},
		{
			name: "layer order",
			mutate: func(items []dockerManifestItem) []dockerManifestItem {
				items[0].Layers[0], items[0].Layers[1] = items[0].Layers[1], items[0].Layers[0]
				return items
			},
			wantSubstring: "layers for server do not match OCI manifest order",
		},
		{
			name: "extra layer",
			mutate: func(items []dockerManifestItem) []dockerManifestItem {
				items[0].Layers = append(items[0].Layers, items[0].Layers[0])
				return items
			},
			wantSubstring: "layers for server do not match OCI manifest order",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := createFinalizedFixture(t)
			scan, err := scanArchive(fixture.archivePath, true)
			if err != nil {
				t.Fatal(err)
			}
			var manifest []dockerManifestItem
			if err := decodeStrict(scan.SmallFiles["manifest.json"], &manifest); err != nil {
				t.Fatal(err)
			}
			manifest = test.mutate(manifest)
			value := append(mustJSON(t, manifest), '\n')
			rewriteTarEntry(t, fixture.archivePath, "manifest.json", &value)
			rebindFixtureArchive(t, &fixture)

			_, err = VerifyBundle(fixture.bundleRoot, fixture.metadataRelative, testReleaseVersion, testSourceCommit, "amd64")
			if err == nil || !strings.Contains(err.Error(), test.wantSubstring) {
				t.Fatalf("VerifyBundle() error = %v, want substring %q", err, test.wantSubstring)
			}
		})
	}
}

func TestVerifyBundleRejectsMissingOrExtendedDockerManifest(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		fixture := createFinalizedFixture(t)
		rewriteTarEntry(t, fixture.archivePath, "manifest.json", nil)
		rebindFixtureArchive(t, &fixture)

		_, err := VerifyBundle(fixture.bundleRoot, fixture.metadataRelative, testReleaseVersion, testSourceCommit, "amd64")
		if err == nil || !strings.Contains(err.Error(), "Docker manifest.json is invalid") {
			t.Fatalf("VerifyBundle() error = %v, want missing Docker manifest rejection", err)
		}
	})

	t.Run("unknown field", func(t *testing.T) {
		fixture := createFinalizedFixture(t)
		scan, err := scanArchive(fixture.archivePath, true)
		if err != nil {
			t.Fatal(err)
		}
		var manifest []map[string]any
		if err := json.Unmarshal(scan.SmallFiles["manifest.json"], &manifest); err != nil {
			t.Fatal(err)
		}
		manifest[0]["Parent"] = strings.Repeat("a", 64)
		value := append(mustJSON(t, manifest), '\n')
		rewriteTarEntry(t, fixture.archivePath, "manifest.json", &value)
		rebindFixtureArchive(t, &fixture)

		_, err = VerifyBundle(fixture.bundleRoot, fixture.metadataRelative, testReleaseVersion, testSourceCommit, "amd64")
		if err == nil || !strings.Contains(err.Error(), "Docker manifest.json is invalid") {
			t.Fatalf("VerifyBundle() error = %v, want extended Docker manifest rejection", err)
		}
	})
}

func TestVerifyBundleRejectsRuntimeReferenceMismatch(t *testing.T) {
	fixture := createFinalizedFixture(t)
	fixture.metadata.Images[0].RuntimeReference = "sha256:" + strings.Repeat("f", 64)
	if err := writeJSONAtomic(fixture.metadataPath, fixture.metadata, 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := VerifyBundle(fixture.bundleRoot, fixture.metadataRelative, testReleaseVersion, testSourceCommit, "amd64")
	if err == nil || !strings.Contains(err.Error(), "runtime reference for server does not match OCI config digest") {
		t.Fatalf("VerifyBundle() error = %v, want runtime-reference binding rejection", err)
	}
}

func TestFinalizeRejectsMissingOrMisboundSBOM(t *testing.T) {
	tests := []struct {
		name          string
		fixture       rawOCIFixtureOptions
		wantSubstring string
	}{
		{
			name:          "missing",
			fixture:       rawOCIFixtureOptions{omitSBOM: true},
			wantSubstring: "does not contain an SPDX SBOM attestation",
		},
		{
			name:          "wrong subject",
			fixture:       rawOCIFixtureOptions{sbomRepository: "example.invalid/not-convenewire"},
			wantSubstring: "SPDX SBOM is not bound",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			serverOptions := test.fixture
			serverOptions.repository = ServerRepository
			server := filepath.Join(root, "server.oci.tar")
			writeRawBuildKitOCI(t, server, serverOptions)
			caddy := filepath.Join(root, "caddy.oci.tar")
			writeRawBuildKitOCI(t, caddy, rawOCIFixtureOptions{repository: CaddyRepository})

			_, err := Finalize(finalizeOptions(root, server, caddy))
			if err == nil || !strings.Contains(err.Error(), test.wantSubstring) {
				t.Fatalf("Finalize() error = %v, want substring %q", err, test.wantSubstring)
			}
		})
	}
}

func TestFinalizeRejectsRawImageIdentityMismatch(t *testing.T) {
	tests := []struct {
		name          string
		fixture       rawOCIFixtureOptions
		wantSubstring string
	}{
		{
			name:          "source",
			fixture:       rawOCIFixtureOptions{sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
			wantSubstring: "source, version, or platform label is invalid",
		},
		{
			name:          "platform",
			fixture:       rawOCIFixtureOptions{platform: "linux/arm64"},
			wantSubstring: "has no primary linux/amd64 manifest",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			serverOptions := test.fixture
			serverOptions.repository = ServerRepository
			server := filepath.Join(root, "server.oci.tar")
			writeRawBuildKitOCI(t, server, serverOptions)
			caddy := filepath.Join(root, "caddy.oci.tar")
			writeRawBuildKitOCI(t, caddy, rawOCIFixtureOptions{repository: CaddyRepository})

			_, err := Finalize(finalizeOptions(root, server, caddy))
			if err == nil || !strings.Contains(err.Error(), test.wantSubstring) {
				t.Fatalf("Finalize() error = %v, want substring %q", err, test.wantSubstring)
			}
		})
	}
}

func TestFinalizeRejectsUnsafeRawArchivePath(t *testing.T) {
	root := t.TempDir()
	server := filepath.Join(root, "server.oci.tar")
	writeTarEntries(t, server, map[string][]byte{"../escape": []byte("unsafe")})
	caddy := filepath.Join(root, "caddy.oci.tar")
	writeRawBuildKitOCI(t, caddy, rawOCIFixtureOptions{repository: CaddyRepository})

	_, err := Finalize(finalizeOptions(root, server, caddy))
	if err == nil || !strings.Contains(err.Error(), "unsafe path") {
		t.Fatalf("Finalize() error = %v, want unsafe path rejection", err)
	}
}

func TestVerifyBundleRejectsArchiveSHA256Tamper(t *testing.T) {
	fixture := createFinalizedFixture(t)
	archive, err := os.OpenFile(fixture.archivePath, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := archive.Write([]byte("tamper")); err != nil {
		_ = archive.Close()
		t.Fatal(err)
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}

	_, err = VerifyBundle(fixture.bundleRoot, fixture.metadataRelative, testReleaseVersion, testSourceCommit, "amd64")
	if err == nil || !strings.Contains(err.Error(), "archive SHA-256 does not match") {
		t.Fatalf("VerifyBundle() error = %v, want archive SHA-256 rejection", err)
	}
}

func TestVerifyBundleRejectsCallerIdentityMismatch(t *testing.T) {
	fixture := createFinalizedFixture(t)
	tests := []struct {
		name         string
		release      string
		sourceCommit string
		architecture string
	}{
		{name: "release", release: "v0.4.0-other", sourceCommit: testSourceCommit, architecture: "amd64"},
		{name: "source", release: testReleaseVersion, sourceCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", architecture: "amd64"},
		{name: "platform", release: testReleaseVersion, sourceCommit: testSourceCommit, architecture: "arm64"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := VerifyBundle(fixture.bundleRoot, fixture.metadataRelative, test.release, test.sourceCommit, test.architecture)
			if err == nil || !strings.Contains(err.Error(), "does not match Central metadata") {
				t.Fatalf("VerifyBundle() error = %v, want release/source/platform mismatch", err)
			}
		})
	}
}

func TestVerifyBundleRejectsMutableSBOMGenerator(t *testing.T) {
	fixture := createFinalizedFixture(t)
	fixture.metadata.SBOMGenerator = "docker.io/docker/buildkit-syft-scanner:stable-1"
	if err := writeJSONAtomic(fixture.metadataPath, fixture.metadata, 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := VerifyBundle(
		fixture.bundleRoot,
		fixture.metadataRelative,
		testReleaseVersion,
		testSourceCommit,
		"amd64",
	)
	if err == nil || !strings.Contains(err.Error(), "metadata identity is invalid") {
		t.Fatalf("VerifyBundle() error = %v, want pinned SBOM generator rejection", err)
	}
}

func TestVerifyBundleRejectsUnreferencedBlob(t *testing.T) {
	fixture := createFinalizedFixture(t)
	extra := []byte("not referenced by either runtime image")
	extraDigest := digestBytes(extra)
	rewriteTarWithExtraEntry(
		t,
		fixture.archivePath,
		"blobs/sha256/"+extraDigest,
		extra,
	)
	fixture.metadata.ArchiveSHA256 = mustDigestFile(t, fixture.archivePath)
	if err := writeJSONAtomic(fixture.metadataPath, fixture.metadata, 0o644); err != nil {
		t.Fatalf("write updated metadata: %v", err)
	}

	_, err := VerifyBundle(fixture.bundleRoot, fixture.metadataRelative, testReleaseVersion, testSourceCommit, "amd64")
	if err == nil || !strings.Contains(err.Error(), "contains unreferenced blob") {
		t.Fatalf("VerifyBundle() error = %v, want unreferenced blob rejection", err)
	}
}

func TestDockerVerifierKeepsTheMacOSBashBoundary(t *testing.T) {
	scriptPath := filepath.Join("..", "..", "scripts", "verify-central-image-docker.sh")
	sourceBytes, err := os.ReadFile(scriptPath)
	if err != nil {
		t.Fatalf("read Docker verifier: %v", err)
	}
	source := string(sourceBytes)
	for _, forbidden := range []string{"mapfile ", "$(sha256sum "} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("Docker verifier uses a non-portable primitive %q", forbidden)
		}
	}
	for _, required := range []string{
		"sha256_file()",
		"command -v shasum",
		"while IFS= read -r reference",
		"references[${#references[@]}]=${reference}",
	} {
		if !strings.Contains(source, required) {
			t.Fatalf("Docker verifier omitted Bash 3.2 compatibility fragment %q", required)
		}
	}
}

func createFinalizedFixture(t *testing.T) finalizedFixture {
	t.Helper()
	root := t.TempDir()
	server := filepath.Join(root, "raw-server.oci.tar")
	caddy := filepath.Join(root, "raw-caddy.oci.tar")
	writeRawBuildKitOCI(t, server, rawOCIFixtureOptions{repository: ServerRepository})
	writeRawBuildKitOCI(t, caddy, rawOCIFixtureOptions{repository: CaddyRepository})
	options := finalizeOptions(root, server, caddy)
	metadata, err := Finalize(options)
	if err != nil {
		t.Fatalf("Finalize() error = %v", err)
	}
	return finalizedFixture{
		bundleRoot:       root,
		archivePath:      options.OutputArchive,
		metadataPath:     options.OutputMetadata,
		metadataRelative: "image/runtime.metadata.json",
		metadata:         metadata,
	}
}

func finalizeOptions(root, server, caddy string) FinalizeOptions {
	return FinalizeOptions{
		Images: []RawImage{
			{Role: ServerRole, Repository: ServerRepository, Archive: server},
			{Role: CaddyRole, Repository: CaddyRepository, Archive: caddy},
		},
		OutputArchive:      filepath.Join(root, "image", "runtime.oci.tar"),
		OutputMetadata:     filepath.Join(root, "image", "runtime.metadata.json"),
		EmbeddedArchive:    "image/runtime.oci.tar",
		ReleaseVersion:     testReleaseVersion,
		SourceCommit:       testSourceCommit,
		Platform:           testPlatform,
		BuilderID:          testBuilderID,
		BuildInvocationURI: testBuilderID + "/attempts/1",
	}
}

func writeRawBuildKitOCI(t *testing.T, filename string, options rawOCIFixtureOptions) {
	t.Helper()
	if options.platform == "" {
		options.platform = testPlatform
	}
	if options.releaseVersion == "" {
		options.releaseVersion = testReleaseVersion
	}
	if options.sourceCommit == "" {
		options.sourceCommit = testSourceCommit
	}
	if options.sbomRepository == "" {
		options.sbomRepository = options.repository
	}
	osName, architecture, ok := strings.Cut(options.platform, "/")
	if !ok {
		t.Fatalf("fixture platform %q is invalid", options.platform)
	}

	blobs := map[string][]byte{}
	addBlob := func(mediaType string, value []byte) descriptor {
		digest := digestBytes(value)
		blobs[digest] = value
		return descriptor{MediaType: mediaType, Digest: "sha256:" + digest, Size: int64(len(value))}
	}

	config := imageConfig{Architecture: architecture, OS: osName}
	config.Config.Labels = map[string]string{
		"org.opencontainers.image.revision": options.sourceCommit,
		"org.opencontainers.image.version":  options.releaseVersion,
		"org.opencontainers.image.title":    options.repository,
	}
	configDescriptor := addBlob(OCIConfigMediaType, mustJSON(t, config))
	layerDescriptor := addBlob("application/vnd.oci.image.layer.v1.tar", []byte("runtime layer one for "+options.repository))
	secondLayerDescriptor := addBlob("application/vnd.oci.image.layer.v1.tar", []byte("runtime layer two for "+options.repository))
	manifest := imageManifest{
		SchemaVersion: 2,
		MediaType:     OCIManifestMediaType,
		Config:        configDescriptor,
		Layers:        []descriptor{layerDescriptor, secondLayerDescriptor},
	}
	primary := addBlob(OCIManifestMediaType, mustJSON(t, manifest))
	primary.Platform = &platform{Architecture: architecture, OS: osName}

	inner := imageIndex{SchemaVersion: 2, MediaType: OCIIndexMediaType, Manifests: []descriptor{primary}}
	if !options.omitSBOM {
		predicate := mustJSON(t, map[string]any{
			"spdxVersion": "SPDX-2.3",
			"SPDXID":      "SPDXRef-DOCUMENT",
			"packages":    []any{},
		})
		statement := inTotoStatement{
			Type:          "https://in-toto.io/Statement/v1",
			PredicateType: SPDXPredicateType,
			Subject: []subject{{
				Name: options.sbomRepository,
				Digest: map[string]string{
					"sha256": strings.TrimPrefix(primary.Digest, "sha256:"),
				},
			}},
			Predicate: predicate,
		}
		sbom := addBlob(InTotoMediaType, mustJSON(t, statement))
		sbom.Annotations = map[string]string{"in-toto.io/predicate-type": SPDXPredicateType}
		attestationConfig := addBlob(OCIConfigMediaType, []byte("{}"))
		attestationManifest := imageManifest{
			SchemaVersion: 2,
			MediaType:     OCIManifestMediaType,
			Config:        attestationConfig,
			Layers:        []descriptor{sbom},
		}
		attestation := addBlob(OCIManifestMediaType, mustJSON(t, attestationManifest))
		attestation.Annotations = map[string]string{
			"vnd.docker.reference.type":   "attestation-manifest",
			"vnd.docker.reference.digest": primary.Digest,
		}
		attestation.Platform = &platform{Architecture: "unknown", OS: "unknown"}
		inner.Manifests = append(inner.Manifests, attestation)
	}

	innerDescriptor := addBlob(OCIIndexMediaType, mustJSON(t, inner))
	root := imageIndex{SchemaVersion: 2, MediaType: OCIIndexMediaType, Manifests: []descriptor{innerDescriptor}}
	entries := map[string][]byte{
		"oci-layout": []byte("{\"imageLayoutVersion\":\"1.0.0\"}\n"),
		"index.json": append(mustJSON(t, root), '\n'),
	}
	for digest, value := range blobs {
		entries["blobs/sha256/"+digest] = value
	}
	writeTarEntries(t, filename, entries)
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func writeTarEntries(t *testing.T, filename string, entries map[string][]byte) {
	t.Helper()
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value := entries[name]
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(value))}); err != nil {
			_ = writer.Close()
			_ = file.Close()
			t.Fatal(err)
		}
		if _, err := writer.Write(value); err != nil {
			_ = writer.Close()
			_ = file.Close()
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func rewriteTarWithExtraEntry(t *testing.T, filename, extraName string, extra []byte) {
	t.Helper()
	source, err := os.Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	temporary := filename + ".rewrite"
	destination, err := os.Create(temporary)
	if err != nil {
		_ = source.Close()
		t.Fatal(err)
	}
	reader := tar.NewReader(source)
	writer := tar.NewWriter(destination)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			closeTarRewrite(source, writer, destination)
			t.Fatal(err)
		}
		cloned := *header
		if err := writer.WriteHeader(&cloned); err != nil {
			closeTarRewrite(source, writer, destination)
			t.Fatal(err)
		}
		if header.Size > 0 {
			if _, err := io.CopyN(writer, reader, header.Size); err != nil {
				closeTarRewrite(source, writer, destination)
				t.Fatal(err)
			}
		}
	}
	if err := writer.WriteHeader(&tar.Header{Name: extraName, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(extra))}); err != nil {
		closeTarRewrite(source, writer, destination)
		t.Fatal(err)
	}
	if _, err := writer.Write(extra); err != nil {
		closeTarRewrite(source, writer, destination)
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		_ = writer.Close()
		_ = destination.Close()
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		_ = destination.Close()
		t.Fatal(err)
	}
	if err := destination.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, filename); err != nil {
		t.Fatal(err)
	}
}

func rewriteTarEntry(t *testing.T, filename, entryName string, replacement *[]byte) {
	t.Helper()
	source, err := os.Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	temporary := filename + ".rewrite"
	destination, err := os.Create(temporary)
	if err != nil {
		_ = source.Close()
		t.Fatal(err)
	}
	reader := tar.NewReader(source)
	writer := tar.NewWriter(destination)
	found := false
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			closeTarRewrite(source, writer, destination)
			t.Fatal(err)
		}
		if header.Name == entryName {
			found = true
			if replacement != nil {
				if err := writer.WriteHeader(&tar.Header{Name: entryName, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(len(*replacement))}); err != nil {
					closeTarRewrite(source, writer, destination)
					t.Fatal(err)
				}
				if _, err := writer.Write(*replacement); err != nil {
					closeTarRewrite(source, writer, destination)
					t.Fatal(err)
				}
			}
			continue
		}
		cloned := *header
		if err := writer.WriteHeader(&cloned); err != nil {
			closeTarRewrite(source, writer, destination)
			t.Fatal(err)
		}
		if header.Size > 0 {
			if _, err := io.CopyN(writer, reader, header.Size); err != nil {
				closeTarRewrite(source, writer, destination)
				t.Fatal(err)
			}
		}
	}
	if !found {
		closeTarRewrite(source, writer, destination)
		t.Fatalf("tar entry %q was not found", entryName)
	}
	if err := source.Close(); err != nil {
		_ = writer.Close()
		_ = destination.Close()
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		_ = destination.Close()
		t.Fatal(err)
	}
	if err := destination.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, filename); err != nil {
		t.Fatal(err)
	}
}

func rebindFixtureArchive(t *testing.T, fixture *finalizedFixture) {
	t.Helper()
	fixture.metadata.ArchiveSHA256 = mustDigestFile(t, fixture.archivePath)
	if err := writeJSONAtomic(fixture.metadataPath, fixture.metadata, 0o644); err != nil {
		t.Fatal(err)
	}
}

func closeTarRewrite(source *os.File, writer *tar.Writer, destination *os.File) {
	_ = source.Close()
	_ = writer.Close()
	_ = destination.Close()
}

func mustDigestFile(t *testing.T, filename string) string {
	t.Helper()
	digest, err := digestFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	return digest
}
