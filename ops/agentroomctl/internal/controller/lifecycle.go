package controller

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var restoreNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*\.sqlite$`)

type UpgradeOptions struct {
	DataRoot        string
	ReleaseDir      string
	ChecksumsPath   string
	ChecksumsSHA256 string
}

func (controller *Controller) Status(ctx context.Context, dataRoot string) error {
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := verifyInstalledRelease(installation); err != nil {
		return err
	}
	environment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	output, err := controller.runCompose(ctx, installation, environment,
		"ps", "--all", "--format", "json")
	if err != nil {
		return actionError("STATUS_FAILED", "could not read the AgentRoom Compose state", "Check Docker access and run agentroomctl doctor with the same data root.", err)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Release: %s\nOrigin: %s\nLast successful step: %s\nCompose state:\n%s",
		installation.Manifest.ReleaseVersion, installation.Manifest.PublicOrigin,
		installation.Manifest.LastSuccessfulStep, ensureTrailingNewline(output),
	)
	return nil
}

func (controller *Controller) Doctor(ctx context.Context, dataRoot string) error {
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := verifyInstalledRelease(installation); err != nil {
		return err
	}
	if err := inspectPrivateFile(installation.ManifestPath); err != nil {
		return actionError("MANIFEST_INVALID", "installation manifest permissions are unsafe", "Restore mode 0600 and ownership before continuing.", err)
	}
	if err := inspectPrivateFile(installation.OwnerSecretPath); err != nil {
		return actionError("SECRET_INVALID", "Owner recovery secret permissions are unsafe", "Restore the original 0600 recovery file; never generate a replacement for an existing Owner.", err)
	}
	if installation.Manifest.LegacyServerToken {
		if err := inspectPrivateFile(installation.ServerSecretPath); err != nil {
			return actionError("SECRET_INVALID", "legacy Server Token permissions are unsafe", "Restore the original 0600 Token file or complete an explicit token-free migration.", err)
		}
	}
	environment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	if _, err := controller.runCompose(ctx, installation, environment, "config", "--quiet"); err != nil {
		return actionError("COMPOSE_INVALID", "the installed Compose model is invalid", "Restore generated control files by retrying the exact install command.", err)
	}
	readiness := ReadinessInput{
		PublicOrigin: installation.Manifest.PublicOrigin,
		LocalCARoot:  filepath.Join(installation.Manifest.DataRoot, "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt"),
		Timeout:      30 * time.Second,
	}
	if err := controller.dependencies.CheckReadiness(ctx, readiness); err != nil {
		return actionError("READINESS_FAILED", "HTTPS readiness or WebSocket ingress is unavailable", "Inspect docker compose logs for caddy and agentroom; check DNS, ports, certificate trust, and public-origin agreement.", err)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"PASS: %s at %s\nRelease checksums, private files, Compose model, HTTPS readiness, and WebSocket ingress are valid.\n",
		installation.Manifest.ReleaseVersion, installation.Manifest.PublicOrigin,
	)
	return nil
}

func (controller *Controller) Backup(ctx context.Context, dataRoot string) error {
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := verifyInstalledRelease(installation); err != nil {
		return err
	}
	environment, err := scriptEnvironment(installation)
	if err != nil {
		return err
	}
	environment["AGENT_ROOM_BACKUP_DIR"] = filepath.Join(installation.Manifest.DataRoot, "exports")
	output, err := controller.dependencies.Runner.Run(ctx, Command{
		Dir: installation.Manifest.ReleaseDir, Env: environment, Name: "bash",
		Args: []string{filepath.Join(installation.Manifest.ReleaseDir, "scripts", "compose-backup.sh")},
	})
	if err != nil {
		return actionError("BACKUP_FAILED", "the existing verified SQLite backup path failed", "Inspect the bounded error, keep the running database unchanged, and retry after correcting Docker or storage state.", err)
	}
	fmt.Fprint(controller.dependencies.Output, ensureTrailingNewline(output))
	return nil
}

func (controller *Controller) Restore(ctx context.Context, dataRoot, backupPath, targetName string) error {
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	absoluteBackup, err := filepath.Abs(strings.TrimSpace(backupPath))
	if err != nil || absoluteBackup != filepath.Clean(backupPath) {
		return actionError("RESTORE_PATH_INVALID", "restore source must be an absolute file path", "Pass the verified absolute backup path printed by agentroomctl backup.", err)
	}
	info, err := os.Lstat(absoluteBackup)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return actionError("RESTORE_PATH_INVALID", "restore source must be a real regular file", "Use an existing verified SQLite backup, not a directory or symbolic link.", err)
	}
	if targetName != "" && !restoreNamePattern.MatchString(targetName) {
		return actionError("RESTORE_TARGET_INVALID", "restore target must be a plain .sqlite filename", "Remove path separators and use a unique name ending in .sqlite.", nil)
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := verifyInstalledRelease(installation); err != nil {
		return err
	}
	environment, err := scriptEnvironment(installation)
	if err != nil {
		return err
	}
	arguments := []string{
		filepath.Join(installation.Manifest.ReleaseDir, "scripts", "compose-restore.sh"),
		absoluteBackup,
	}
	if targetName != "" {
		arguments = append(arguments, targetName)
	}
	output, err := controller.dependencies.Runner.Run(ctx, Command{
		Dir: installation.Manifest.ReleaseDir, Env: environment, Name: "bash", Args: arguments,
	})
	if err != nil {
		return actionError("RESTORE_FAILED", "the existing staged SQLite restore path failed", "Keep the current database selection unchanged, correct the reported validation or stopped-service boundary, and retry.", err)
	}
	fmt.Fprint(controller.dependencies.Output, ensureTrailingNewline(output))
	return nil
}

func (controller *Controller) Uninstall(ctx context.Context, dataRoot string) error {
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := verifyInstalledRelease(installation); err != nil {
		return err
	}
	environment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	if _, err := controller.runCompose(ctx, installation, environment, "down", "--remove-orphans"); err != nil {
		return actionError("UNINSTALL_FAILED", "AgentRoom containers could not be removed safely", "Resolve Docker access or container errors and retry; no data volume or host data was requested for deletion.", err)
	}
	for _, path := range []string{installation.EnvironmentPath, installation.OverridePath} {
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return actionError("UNINSTALL_CONFIG_FAILED", "containers stopped but generated control configuration could not be removed", "Repair control-directory permissions; data, recovery material, backups, and certificate state remain preserved.", err)
		}
	}
	manifest := installation.Manifest
	if err := controller.recordStep(&manifest, installation.ManifestPath, "uninstalled"); err != nil {
		return err
	}
	fmt.Fprintf(controller.dependencies.Output,
		"AgentRoom containers and generated runtime configuration were removed.\nPreserved data root: %s\nPreserved recovery file: %s\nNo purge was performed.\n",
		installation.Manifest.DataRoot, installation.OwnerSecretPath,
	)
	return nil
}

func (controller *Controller) Upgrade(ctx context.Context, raw UpgradeOptions) error {
	current, err := openInstallation(raw.DataRoot)
	if err != nil {
		return err
	}
	if current.Manifest.LastSuccessfulStep != "ready" {
		return actionError("UPGRADE_STATE_INVALID", "only a ready installation can be upgraded", "Recover the current release with install and doctor before changing revisions.", nil)
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := verifyInstalledRelease(current); err != nil {
		return err
	}
	releaseDir, err := filepath.Abs(strings.TrimSpace(raw.ReleaseDir))
	if err != nil {
		return actionError("RELEASE_PATH_INVALID", "target release directory is invalid", "Pass an extracted checksum-pinned central release.", err)
	}
	checksumsPath := raw.ChecksumsPath
	if checksumsPath == "" {
		checksumsPath = filepath.Join(releaseDir, "SHA256SUMS")
	} else if checksumsPath, err = filepath.Abs(checksumsPath); err != nil {
		return actionError("CHECKSUM_PATH_INVALID", "target checksum path is invalid", "Use SHA256SUMS from the same target release.", err)
	}
	if filepath.Dir(checksumsPath) != releaseDir || filepath.Base(checksumsPath) != "SHA256SUMS" {
		return actionError("CHECKSUM_PATH_INVALID", "target SHA256SUMS must belong to the release root", "Use the checksum file shipped inside the target release.", nil)
	}
	pinnedDigest := strings.ToLower(strings.TrimSpace(raw.ChecksumsSHA256))
	if !hashPattern.MatchString(pinnedDigest) {
		return actionError("CHECKSUM_PIN_INVALID", "a published target SHA256SUMS digest is required", "Pass the separately published 64-character SHA-256 value for the target release.", nil)
	}
	metadata, digest, err := verifyRelease(releaseDir, checksumsPath, pinnedDigest)
	if err != nil {
		return err
	}
	if metadata.ReleaseVersion == current.Manifest.ReleaseVersion && digest == current.Manifest.ReleaseDigest {
		return actionError("UPGRADE_NOT_NEEDED", "target release is already active", "Run agentroomctl doctor instead of changing installation state.", nil)
	}
	if metadata.DataSchemaVersion < current.Manifest.DataSchemaVersion {
		return actionError("UPGRADE_SCHEMA_INCOMPATIBLE", "target release owns an older data schema", "Select a forward-compatible release; automatic database downgrade is not supported.", nil)
	}
	if err := controller.Backup(ctx, current.Manifest.DataRoot); err != nil {
		return actionError("UPGRADE_BACKUP_FAILED", "upgrade stopped because the required verified backup failed", "Correct the backup failure before changing any running revision.", err)
	}
	targetManifest := current.Manifest
	targetManifest.ReleaseVersion = metadata.ReleaseVersion
	targetManifest.ReleaseDir = releaseDir
	targetManifest.ReleaseDigest = digest
	targetManifest.DataSchemaVersion = metadata.DataSchemaVersion
	targetManifest.LastSuccessfulStep = "upgrade_validating"
	targetManifest.UpdatedAt = controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
	candidateRoot, err := os.MkdirTemp(filepath.Join(current.Manifest.DataRoot, "control"), ".upgrade-")
	if err != nil {
		return actionError("UPGRADE_CONFIG_FAILED", "could not create an isolated target configuration", "Check control-directory permissions; the current revision remains recorded.", err)
	}
	defer os.RemoveAll(candidateRoot)
	target := current
	target.Manifest = targetManifest
	target.EnvironmentPath = filepath.Join(candidateRoot, "agentroom.env")
	target.OverridePath = filepath.Join(candidateRoot, "compose.override.yaml")
	options := InstallOptions{
		ReleaseDir: releaseDir, ChecksumsPath: checksumsPath,
		ChecksumsSHA256: pinnedDigest,
		DataRoot:        targetManifest.DataRoot, Mode: targetManifest.Mode,
		Domain: targetManifest.Domain, PublicOrigin: targetManifest.PublicOrigin,
		HTTPPort: targetManifest.HTTPPort, HTTPSPort: targetManifest.HTTPSPort,
		LegacyServerToken: targetManifest.LegacyServerToken,
		ProjectName:       targetManifest.ProjectName,
	}
	if err := renderConfiguration(options, metadata.ReleaseVersion, target); err != nil {
		return actionError("UPGRADE_CONFIG_FAILED", "could not render the isolated target configuration", "The current manifest and generated configuration remain unchanged.", err)
	}
	environment, err := installationEnvironment(target)
	if err != nil {
		return err
	}
	if _, err := controller.runCompose(ctx, target, environment, "config", "--quiet"); err != nil {
		return actionError("UPGRADE_COMPOSE_INVALID", "target release Compose validation failed", "The required backup exists and the current running revision was not changed.", err)
	}
	if _, err := controller.runCompose(ctx, target, environment,
		"up", "-d", "--build", "--wait", "--wait-timeout", "180"); err != nil {
		state := controller.activeRevisionState(ctx, target, environment)
		return actionError("UPGRADE_START_FAILED", "target release did not reach the Compose running boundary; active image state: "+state, "The verified backup and old manifest were preserved. Run doctor before deciding whether a forward repair or documented database/image rollback is safe.", err)
	}
	readiness := ReadinessInput{
		PublicOrigin: target.Manifest.PublicOrigin,
		LocalCARoot:  filepath.Join(target.Manifest.DataRoot, "caddy", "data", "caddy", "pki", "authorities", "local", "root.crt"),
		Timeout:      defaultReadyTimeout,
	}
	if err := controller.dependencies.CheckReadiness(ctx, readiness); err != nil {
		state := controller.activeRevisionState(ctx, target, environment)
		return actionError("UPGRADE_READINESS_FAILED", "target release failed HTTPS readiness; active image state: "+state, "The verified backup and old manifest were preserved. Inspect the target logs and respect the forward-only migration rollback boundary.", err)
	}
	if err := renderConfiguration(options, metadata.ReleaseVersion, current); err != nil {
		return actionError("UPGRADE_COMMIT_FAILED", "target is ready but canonical control configuration could not be committed", "Do not start another upgrade; preserve the candidate release and repair control-directory permissions.", err)
	}
	targetManifest.LastSuccessfulStep = "ready"
	if err := controller.recordStep(&targetManifest, current.ManifestPath, "ready"); err != nil {
		return err
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Upgraded AgentRoom from %s to %s after a verified backup.\nOrigin: %s\n",
		current.Manifest.ReleaseVersion, targetManifest.ReleaseVersion,
		targetManifest.PublicOrigin,
	)
	return nil
}

func (controller *Controller) activeRevisionState(ctx context.Context, installation Installation, environment map[string]string) string {
	output, err := controller.runCompose(ctx, installation, environment,
		"images", "--format", "json", "agentroom")
	if err != nil {
		return "unknown (image inspection failed)"
	}
	value := strings.TrimSpace(output)
	if value == "" {
		return "no agentroom image reported"
	}
	if len(value) > 500 {
		value = value[:500]
	}
	return strings.ReplaceAll(value, "\n", " ")
}

func openInstallation(dataRoot string) (Installation, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(dataRoot))
	if err != nil {
		return Installation{}, actionError("DATA_ROOT_INVALID", "data root is invalid", "Pass the exact persistent data root used during installation.", err)
	}
	installation := installationPaths(absolute)
	manifest, found, err := loadManifest(installation.ManifestPath)
	if err != nil {
		return Installation{}, err
	}
	if !found {
		return Installation{}, actionError("INSTALLATION_NOT_FOUND", "no AgentRoom installation manifest exists at the selected data root", "Run agentroomctl install or select the original data root.", nil)
	}
	if manifest.DataRoot != absolute {
		return Installation{}, actionError("MANIFEST_INVALID", "manifest data root does not match its resolved location", "Use the original data root; moving an installation requires an explicit future migration.", nil)
	}
	installation.Manifest = manifest
	return installation, nil
}

func scriptEnvironment(installation Installation) (map[string]string, error) {
	environment, err := installationEnvironment(installation)
	if err != nil {
		return nil, err
	}
	environment["COMPOSE_FILE"] = filepath.Join(installation.Manifest.ReleaseDir, "compose.yaml") + string(os.PathListSeparator) + installation.OverridePath
	environment["COMPOSE_ENV_FILES"] = installation.EnvironmentPath
	environment["COMPOSE_PROJECT_NAME"] = installation.Manifest.ProjectName
	return environment, nil
}

func verifyInstalledRelease(installation Installation) error {
	metadata, digest, err := verifyRelease(
		installation.Manifest.ReleaseDir,
		filepath.Join(installation.Manifest.ReleaseDir, "SHA256SUMS"),
		installation.Manifest.ReleaseDigest,
	)
	if err != nil {
		return err
	}
	if metadata.ReleaseVersion != installation.Manifest.ReleaseVersion ||
		metadata.DataSchemaVersion != installation.Manifest.DataSchemaVersion ||
		digest != installation.Manifest.ReleaseDigest {
		return actionError("RELEASE_DRIFT", "installed release content differs from the recorded manifest", "Restore the checksum-pinned release directory before any lifecycle command.", nil)
	}
	return nil
}

func inspectPrivateFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s must be a private regular file; mode is %s", path, info.Mode())
	}
	return nil
}

func ensureTrailingNewline(value string) string {
	if strings.HasSuffix(value, "\n") {
		return value
	}
	return value + "\n"
}

func ParsePort(value string) (int, error) {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return 0, fmt.Errorf("port must be from 1 to 65535")
	}
	return port, nil
}
