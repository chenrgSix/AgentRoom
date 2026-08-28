package controller

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type fakeRunner struct {
	commands                        []Command
	failOnce                        map[string]int
	hook                            func(Command)
	rotationAcknowledgementResponse string
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
	if strings.Contains(joined, " images ") {
		return `{"Repository":"convenewire/server","Tag":"target"}` + "\n", nil
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
		return strings.Repeat("a", 64) + "  /safe/agent-room.sqlite\n", nil
	}
	if command.Name == "bash" && strings.Contains(joined, "compose-restore.sh") {
		return "Set CONVENE_WIRE_DATABASE_PATH=/data/restored.sqlite, then run docker compose up -d.\n", nil
	}
	return "", nil
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
