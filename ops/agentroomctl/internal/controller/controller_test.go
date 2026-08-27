package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type fakeRunner struct {
	commands []Command
	failOnce map[string]int
}

func (runner *fakeRunner) Run(_ context.Context, command Command) (string, error) {
	runner.commands = append(runner.commands, command)
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
		return `{"Repository":"agentroom/server","Tag":"target"}` + "\n", nil
	}
	if strings.Contains(joined, " ps ") {
		return `[{"Service":"agentroom","State":"running"}]` + "\n", nil
	}
	if command.Name == "bash" && strings.Contains(joined, "compose-backup.sh") {
		return strings.Repeat("a", 64) + "  /safe/agent-room.sqlite\n", nil
	}
	if command.Name == "bash" && strings.Contains(joined, "compose-restore.sh") {
		return "Set AGENT_ROOM_DATABASE_PATH=/data/restored.sqlite, then run docker compose up -d.\n", nil
	}
	return "", nil
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
		ProjectName: "agentroom-test",
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
		"agentroom-central-release.json": fmt.Sprintf(
			"{\"schemaVersion\":1,\"releaseVersion\":%q,\"dataSchemaVersion\":%d,\"sourceCommit\":%q,\"targetOS\":%q,\"targetArch\":%q}\n",
			version, dataSchema, strings.Repeat("a", 40), targetOS, targetArch,
		),
		"compose.yaml":               "services: {}\n",
		"Dockerfile":                 "FROM scratch\n",
		"package.json":               "{}\n",
		"package-lock.json":          "{}\n",
		"deploy/Caddyfile":           "https://example.invalid {}\n",
		"scripts/compose-backup.sh":  "#!/usr/bin/env bash\nexit 0\n",
		"scripts/compose-restore.sh": "#!/usr/bin/env bash\nexit 0\n",
		"apps/server/source.ts":      "export {};\n",
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
	if bytes.Contains(environment, bytes.TrimSpace(secretBefore)) || bytes.Contains(environment, []byte("AGENT_ROOM_BRIDGE_SERVER_TOKEN")) {
		t.Fatal("generated environment retained a plaintext authority secret")
	}
	if !bytes.Contains(environment, []byte("AGENT_ROOM_BIND_ADDRESS=127.0.0.1")) {
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
	if !bytes.Contains(value, []byte("AGENT_ROOM_BIND_ADDRESS=0.0.0.0")) {
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
	if !strings.Contains(action.Message, "agentroom/server") {
		t.Fatalf("failed upgrade omitted active image state: %s", action.Message)
	}
	manifest, _, _ := loadManifest(installationPaths(dataRoot).ManifestPath)
	if manifest.ReleaseVersion != "v1.2.3" {
		t.Fatalf("failed upgrade changed the committed manifest: %s", manifest.ReleaseVersion)
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
