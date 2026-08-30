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
	if err := controller.verifyInstalledRelease(installation); err != nil {
		return err
	}
	if err := controller.inspectRuntimeImages(ctx, installation.Manifest); err != nil {
		return actionError("RUNTIME_IMAGE_MISSING", "the exact digest-pinned Central runtime images are unavailable", "Restore them only from the checksum-verified installed release archive; do not pull tags or rebuild source.", err)
	}
	environment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	if err := controller.verifyActiveRuntimeIdentity(ctx, installation, environment, false); err != nil {
		return actionError("ACTIVE_RUNTIME_MISMATCH", "the running Central revision does not match the installed digest and build identity", "Do not restart, rebuild, or pull tags. Retry only a pending exact upgrade, or restore the checksum-verified installed release.", err)
	}
	output, err := controller.runCompose(ctx, installation, environment,
		"ps", "--all", "--format", "json")
	if err != nil {
		return actionError("STATUS_FAILED", "could not read the ConveneWire Compose state", "Check Docker access and run convenewirectl doctor with the same data root.", err)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Release: %s\nOrigin: %s\nTLS profile: %s\nInstallation ID: %s\nLast successful step: %s\nCompose state:\n%s",
		installation.Manifest.ReleaseVersion, installation.Manifest.PublicOrigin,
		manifestTLSProfile(installation.Manifest), printableInstallationID(installation.Manifest),
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
	if err := controller.verifyInstalledRelease(installation); err != nil {
		return err
	}
	if err := controller.inspectRuntimeImages(ctx, installation.Manifest); err != nil {
		return actionError("RUNTIME_IMAGE_MISSING", "the exact digest-pinned Central runtime images are unavailable", "Restore them only from the checksum-verified installed release archive; do not pull tags or rebuild source.", err)
	}
	if err := inspectPrivateFile(installation.ManifestPath); err != nil {
		return actionError("MANIFEST_INVALID", "installation manifest permissions are unsafe", "Restore mode 0600 and ownership before continuing.", err)
	}
	if err := validateSecret(installation.OwnerSecretPath); err != nil {
		return actionError("SECRET_INVALID", "Owner recovery secret is missing, malformed, or unsafe", "Restore the exact original 0600 recovery file; never generate a replacement for an existing Owner.", err)
	}
	if installation.Manifest.LegacyServerToken {
		if err := validateSecret(installation.ServerSecretPath); err != nil {
			return actionError("SECRET_INVALID", "legacy Server Token is missing, malformed, or unsafe", "Restore the exact original 0600 Token file or complete an explicit token-free migration.", err)
		}
	}
	environment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	if _, err := controller.runCompose(ctx, installation, environment, "config", "--quiet"); err != nil {
		return actionError("COMPOSE_INVALID", "the installed Compose model is invalid", "Restore generated control files by retrying the exact install command.", err)
	}
	if err := controller.verifyActiveRuntimeIdentity(ctx, installation, environment, true); err != nil {
		return actionError("ACTIVE_RUNTIME_MISMATCH", "the running Central revision does not match the installed digest and build identity", "Do not accept HTTPS readiness alone. Retry only a pending exact upgrade, or restore the checksum-verified installed release.", err)
	}
	readiness := ReadinessInput{
		PublicOrigin:     installation.Manifest.PublicOrigin,
		LocalCARoot:      privateCARootPath(installation.Manifest, activePrivateCAID(installation.Manifest)),
		TLSProfile:       installation.Manifest.TLSProfile,
		ExpectedCADigest: installation.Manifest.CACertificateSHA256,
		Timeout:          30 * time.Second,
	}
	if installation.Manifest.TLSProfile == "private_scoped_ca" {
		if _, err := publishPrivateTrust(installation, installation.Manifest, controller.dependencies.Now()); err != nil {
			return actionError("PRIVATE_TRUST_INVALID", "the scoped private trust descriptor disagrees with Caddy or the manifest", "Restore the recorded Caddy state or complete an authenticated overlap rotation; do not overwrite the digest.", err)
		}
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
	ctx, releaseLifecycle, err := acquireLifecycleLock(ctx, dataRoot)
	if err != nil {
		return err
	}
	defer func() { _ = releaseLifecycle() }()
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := controller.verifyInstalledRelease(installation); err != nil {
		return err
	}
	_, output, err := controller.createVerifiedBackup(ctx, installation)
	if err != nil {
		return err
	}
	fmt.Fprint(controller.dependencies.Output, ensureTrailingNewline(output))
	return nil
}

func (controller *Controller) createVerifiedBackup(
	ctx context.Context,
	installation Installation,
) (backupReceipt, string, error) {
	if err := controller.inspectRuntimeImages(ctx, installation.Manifest); err != nil {
		return backupReceipt{}, "", actionError(
			"BACKUP_RUNTIME_MISMATCH",
			"the installed digest-pinned runtime images are unavailable",
			"Restore them only from the checksum-verified installed release before creating an upgrade backup.",
			err,
		)
	}
	environment, err := scriptEnvironment(installation)
	if err != nil {
		return backupReceipt{}, "", err
	}
	if err := controller.verifyActiveRuntimeIdentity(ctx, installation, environment, true); err != nil {
		return backupReceipt{}, "", actionError(
			"BACKUP_RUNTIME_MISMATCH",
			"the running Central revision does not match the installation manifest",
			"Restore both exact running services and their build identity before creating an upgrade backup.",
			err,
		)
	}
	backupDirectory := filepath.Join(installation.Manifest.DataRoot, "exports")
	environment["CONVENE_WIRE_BACKUP_DIR"] = backupDirectory
	environment["AGENT_ROOM_BACKUP_DIR"] = backupDirectory
	output, err := controller.dependencies.Runner.Run(ctx, Command{
		Dir: installation.Manifest.ReleaseDir, Env: environment, Name: "bash",
		Args: []string{filepath.Join(installation.Manifest.ReleaseDir, "scripts", "compose-backup.sh")},
	})
	if err != nil {
		return backupReceipt{}, "", actionError("BACKUP_FAILED", "the existing verified SQLite backup path failed", "Inspect the bounded error, keep the running database unchanged, and retry after correcting Docker or storage state.", err)
	}
	receipt, err := parseBackupReceipt(installation.Manifest.DataRoot, output)
	if err != nil {
		return backupReceipt{}, "", actionError(
			"BACKUP_RECEIPT_INVALID",
			"the backup command did not produce one durable checksum-bound host backup",
			"Keep the running revision unchanged, repair backup storage, and retry; upgrade recovery cannot rely on an unbound path.",
			err,
		)
	}
	if err := syncBackupReceipt(installation.Manifest.DataRoot, receipt); err != nil {
		return backupReceipt{}, "", actionError(
			"BACKUP_RECEIPT_INVALID",
			"the checksum-bound host backup could not cross its durability boundary",
			"Keep the running revision unchanged, repair backup storage, and retry before any upgrade.",
			err,
		)
	}
	return receipt, output, nil
}

func (controller *Controller) Restore(ctx context.Context, dataRoot, backupPath, targetName string) error {
	ctx, releaseLifecycle, err := acquireLifecycleLock(ctx, dataRoot)
	if err != nil {
		return err
	}
	defer func() { _ = releaseLifecycle() }()
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	absoluteBackup, err := filepath.Abs(strings.TrimSpace(backupPath))
	if err != nil || absoluteBackup != filepath.Clean(backupPath) {
		return actionError("RESTORE_PATH_INVALID", "restore source must be an absolute file path", "Pass the verified absolute backup path printed by convenewirectl backup.", err)
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
	if err := controller.verifyInstalledRelease(installation); err != nil {
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
	ctx, releaseLifecycle, err := acquireLifecycleLock(ctx, dataRoot)
	if err != nil {
		return err
	}
	defer func() { _ = releaseLifecycle() }()
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := controller.verifyInstalledRelease(installation); err != nil {
		return err
	}
	environment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	if _, err := controller.runCompose(ctx, installation, environment, "down", "--remove-orphans"); err != nil {
		return actionError("UNINSTALL_FAILED", "ConveneWire containers could not be removed safely", "Resolve Docker access or container errors and retry; no data volume or host data was requested for deletion.", err)
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
		"ConveneWire containers and generated runtime configuration were removed.\nPreserved data root: %s\nPreserved recovery file: %s\nNo purge was performed.\n",
		installation.Manifest.DataRoot, installation.OwnerSecretPath,
	)
	return nil
}

func (controller *Controller) Upgrade(ctx context.Context, raw UpgradeOptions) error {
	ctx, releaseLifecycle, err := acquireLifecycleLock(ctx, raw.DataRoot)
	if err != nil {
		return err
	}
	defer func() { _ = releaseLifecycle() }()
	current, err := openInstallationUnchecked(raw.DataRoot)
	if err != nil {
		return err
	}
	journal, recovering, err := loadUpgradeJournal(current.UpgradeJournalPath)
	if err != nil {
		return err
	}
	if current.Manifest.LastSuccessfulStep != "ready" {
		return actionError("UPGRADE_STATE_INVALID", "only a ready installation can be upgraded", "Recover the current release with install and doctor before changing revisions.", nil)
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := controller.verifyInstalledRelease(current); err != nil {
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
	if metadata.TargetOS != controller.dependencies.GOOS || metadata.TargetArch != controller.dependencies.GOARCH {
		return actionError("RELEASE_TARGET_MISMATCH", "target release does not match this host", "Use the target Central archive published for this host operating system and architecture.", nil)
	}
	if recovering {
		unresolvedPreparedTarget := journal.Phase == upgradePhasePrepared &&
			runtimeImagesUnresolved(journal.Target) &&
			metadata.SchemaVersion == releaseSchemaVersion
		if releaseDir != journal.Target.ReleaseDir || digest != journal.Target.ReleaseDigest ||
			metadata.ReleaseVersion != journal.Target.ReleaseVersion ||
			metadata.SourceCommit != journal.Target.SourceCommit ||
			metadata.DataSchemaVersion != journal.Target.DataSchemaVersion ||
			(!unresolvedPreparedTarget && !runtimeImagesMatch(journal.Target, metadata)) {
			return actionError(
				"UPGRADE_RECOVERY_TARGET_MISMATCH",
				"the requested upgrade does not match the durable interrupted target",
				"Retry with the exact recorded target release directory and published SHA256SUMS digest; rollback or a different target is not inferred.",
				nil,
			)
		}
		return controller.continueUpgrade(ctx, current, metadata, &journal)
	}
	if current.Manifest.SchemaVersion == legacyManifestSchemaVersion && metadata.SchemaVersion == releaseSchemaVersion {
		return actionError(
			"UPGRADE_MANIFEST_MIGRATION_REQUIRED",
			"a legacy installation manifest cannot safely record digest-pinned runtime images",
			"Complete the explicit inspected TLS-profile manifest migration first, then retry the schema-v2 upgrade. ConveneWire will not infer trust identity during an image upgrade.",
			nil,
		)
	}
	if hasPinnedRuntimeImages(current.Manifest) && metadata.SchemaVersion == legacyReleaseSchemaVersion {
		return actionError(
			"UPGRADE_IMAGE_AUTHORITY_DOWNGRADE",
			"a digest-pinned installation cannot downgrade to a legacy source-build release",
			"Select a schema-v2 Central release that carries verified OCI image metadata. Network pulls and source-build fallback remain disabled.",
			nil,
		)
	}
	if metadata.ReleaseVersion == current.Manifest.ReleaseVersion && digest == current.Manifest.ReleaseDigest {
		return actionError("UPGRADE_NOT_NEEDED", "target release is already active", "Run convenewirectl doctor instead of changing installation state.", nil)
	}
	if metadata.DataSchemaVersion < current.Manifest.DataSchemaVersion {
		return actionError("UPGRADE_SCHEMA_INCOMPATIBLE", "target release owns an older data schema", "Select a forward-compatible release; automatic database downgrade is not supported.", nil)
	}
	if err := validateSecret(current.OwnerSecretPath); err != nil {
		return actionError("UPGRADE_SECRET_INVALID", "upgrade stopped because the Owner recovery secret is missing, malformed, or unsafe", "Restore the exact original 0600 recovery file before retrying; never generate a replacement for an existing Owner.", err)
	}
	if current.Manifest.LegacyServerToken {
		if err := validateSecret(current.ServerSecretPath); err != nil {
			return actionError("UPGRADE_SECRET_INVALID", "upgrade stopped because the legacy Server Token is missing, malformed, or unsafe", "Restore the exact original 0600 Token file or complete an explicit token-free migration before retrying.", err)
		}
	}
	backup, backupOutput, err := controller.createVerifiedBackup(ctx, current)
	if err != nil {
		return actionError("UPGRADE_BACKUP_FAILED", "upgrade stopped because the required verified backup failed", "Correct the backup failure before changing any running revision.", err)
	}
	fmt.Fprint(controller.dependencies.Output, ensureTrailingNewline(backupOutput))
	targetManifest := current.Manifest
	targetManifest.ReleaseVersion = metadata.ReleaseVersion
	targetManifest.SourceCommit = metadata.SourceCommit
	targetManifest.ReleaseDir = releaseDir
	targetManifest.ReleaseDigest = digest
	targetManifest.DataSchemaVersion = metadata.DataSchemaVersion
	applyRuntimeImages(&targetManifest, metadata)
	targetManifest.LastSuccessfulStep = "upgrade_validating"
	targetManifest.UpdatedAt = controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
	journal = newUpgradeJournal(
		current.Manifest,
		targetManifest,
		backup,
		controller.dependencies.Now(),
	)
	if err := saveUpgradeJournal(current.UpgradeJournalPath, journal); err != nil {
		return actionError(
			"UPGRADE_JOURNAL_WRITE_FAILED",
			"the durable upgrade recovery boundary could not be established",
			"No target image or service mutation was attempted. Repair control-directory permissions and retry the same target.",
			err,
		)
	}
	return controller.continueUpgrade(ctx, current, metadata, &journal)
}

func (controller *Controller) continueUpgrade(
	ctx context.Context,
	current Installation,
	metadata ReleaseMetadata,
	journal *upgradeJournal,
) error {
	committed := manifestIsCommittedUpgradeTarget(current.Manifest, journal.Target)
	if committed && journal.Phase != upgradePhaseTargetReady {
		return actionError(
			"UPGRADE_RECOVERY_STATE_MISMATCH",
			"the committed target has an upgrade journal that never recorded target readiness",
			"Do not remove or rewrite either file. Restore their exact matching copies before recovery.",
			nil,
		)
	}
	if !committed && !manifestsEqualIgnoringUpdatedAt(current.Manifest, journal.Previous) {
		return actionError(
			"UPGRADE_RECOVERY_STATE_MISMATCH",
			"the installation manifest matches neither revision in the pending upgrade journal",
			"Do not overwrite the manifest or journal. Restore their exact matching copies before recovery.",
			nil,
		)
	}
	if committed {
		if err := controller.inspectRuntimeImages(ctx, current.Manifest); err != nil {
			return actionError("UPGRADE_CLEANUP_RUNTIME_MISMATCH", "the committed target runtime images are unavailable", "Restore the exact target image bundle before completing journal cleanup.", err)
		}
		environment, err := installationEnvironment(current)
		if err != nil {
			return err
		}
		if err := controller.verifyActiveRuntimeIdentity(ctx, current, environment, true); err != nil {
			return actionError("UPGRADE_CLEANUP_RUNTIME_MISMATCH", "the committed target runtime identity is not active", "Restore both exact target services and build identity before completing journal cleanup.", err)
		}
		if err := removeUpgradeJournal(current.UpgradeJournalPath); err != nil {
			return actionError("UPGRADE_CLEANUP_FAILED", "the target manifest is committed but its completed upgrade journal remains", "Retry the same target upgrade after repairing only the journal directory.", err)
		}
		fmt.Fprintf(controller.dependencies.Output,
			"Recovered completed ConveneWire upgrade from %s to %s.\nOrigin: %s\n",
			journal.Previous.ReleaseVersion,
			current.Manifest.ReleaseVersion,
			current.Manifest.PublicOrigin,
		)
		return nil
	}
	if err := verifyBackupReceipt(journal.Previous.DataRoot, journal.Backup); err != nil {
		return actionError(
			"UPGRADE_BACKUP_INVALID",
			"the durable backup required by the pending upgrade is missing or changed",
			"Restore the exact receipt-bound backup file before retrying this target; no image or service mutation was attempted.",
			err,
		)
	}
	targetManifest := journal.Target
	candidateRoot, err := os.MkdirTemp(
		filepath.Join(targetManifest.DataRoot, "control"),
		".upgrade-",
	)
	if err != nil {
		return actionError("UPGRADE_CONFIG_FAILED", "could not create an isolated target configuration", "Check control-directory permissions; the pending exact target remains recorded.", err)
	}
	defer os.RemoveAll(candidateRoot)
	target := current
	target.Manifest = targetManifest
	target.EnvironmentPath = filepath.Join(candidateRoot, "agentroom.env")
	target.OverridePath = filepath.Join(candidateRoot, "compose.override.yaml")
	options := InstallOptions{
		ReleaseDir: targetManifest.ReleaseDir,
		ChecksumsPath: filepath.Join(
			targetManifest.ReleaseDir,
			"SHA256SUMS",
		),
		ChecksumsSHA256:   targetManifest.ReleaseDigest,
		DataRoot:          targetManifest.DataRoot,
		Mode:              targetManifest.Mode,
		Domain:            targetManifest.Domain,
		PublicOrigin:      targetManifest.PublicOrigin,
		TLSProfile:        targetManifest.TLSProfile,
		HTTPPort:          targetManifest.HTTPPort,
		HTTPSPort:         targetManifest.HTTPSPort,
		LegacyServerToken: targetManifest.LegacyServerToken,
		ProjectName:       targetManifest.ProjectName,
	}
	selectedTarget, err := controller.ensureReleaseImagesLoaded(ctx, target, metadata)
	if err != nil {
		return err
	}
	if !manifestsEqualIgnoringUpdatedAt(selectedTarget, targetManifest) {
		selectedTarget.UpdatedAt = controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
		journal.Target = selectedTarget
		journal.UpdatedAt = selectedTarget.UpdatedAt
		if err := saveUpgradeJournal(current.UpgradeJournalPath, *journal); err != nil {
			return actionError(
				"UPGRADE_JOURNAL_WRITE_FAILED",
				"the loaded target image generation could not be recorded in the durable upgrade journal",
				"No target configuration or service mutation was attempted. Repair the journal path and retry only this exact target; the verified images may remain in Docker's local store.",
				err,
			)
		}
		targetManifest = selectedTarget
		target.Manifest = targetManifest
	}
	if err := renderConfiguration(options, metadata.ReleaseVersion, target); err != nil {
		return actionError("UPGRADE_CONFIG_FAILED", "could not render the isolated target configuration", "Repair the reported host condition and retry only the pending exact target.", err)
	}
	environment, err := installationEnvironment(target)
	if err != nil {
		return err
	}
	if _, err := controller.runCompose(ctx, target, environment, "config", "--quiet"); err != nil {
		return actionError("UPGRADE_COMPOSE_INVALID", "target release Compose validation failed", "The required backup and upgrade journal remain. Repair the host and retry only this target.", err)
	}
	if _, err := controller.runCompose(ctx, target, environment,
		composeUpArguments(targetManifest, true)...); err != nil {
		state := controller.activeRevisionState(ctx, target, environment)
		return actionError("UPGRADE_START_FAILED", "target release did not reach the Compose running boundary; active image state: "+state, "The verified backup and upgrade journal were preserved. Retry only this exact target after correcting the reported failure.", err)
	}
	if err := advanceUpgradeJournal(
		current.UpgradeJournalPath,
		journal,
		upgradePhaseServicesStarted,
		controller.dependencies.Now(),
	); err != nil {
		return actionError("UPGRADE_JOURNAL_WRITE_FAILED", "target services started but durable upgrade progress could not be updated", "Do not run another lifecycle action. Repair the journal path and retry only this exact target.", err)
	}
	if target.Manifest.TLSProfile == "private_scoped_ca" {
		if _, err := publishPrivateTrust(target, target.Manifest, controller.dependencies.Now()); err != nil {
			state := controller.activeRevisionState(ctx, target, environment)
			return actionError("UPGRADE_PRIVATE_TRUST_FAILED", "target release changed or invalidated scoped private trust; active image state: "+state, "Preserve the journal and Caddy state; retry only the recorded target after restoring authenticated trust.", err)
		}
	}
	readiness := ReadinessInput{
		PublicOrigin:     target.Manifest.PublicOrigin,
		LocalCARoot:      privateCARootPath(target.Manifest, activePrivateCAID(target.Manifest)),
		TLSProfile:       target.Manifest.TLSProfile,
		ExpectedCADigest: target.Manifest.CACertificateSHA256,
		Timeout:          defaultReadyTimeout,
	}
	if err := controller.dependencies.CheckReadiness(ctx, readiness); err != nil {
		state := controller.activeRevisionState(ctx, target, environment)
		return actionError("UPGRADE_READINESS_FAILED", "target release failed HTTPS readiness; active image state: "+state, "The verified backup and upgrade journal remain. Retry only the recorded target after correcting readiness.", err)
	}
	if err := controller.verifyActiveRuntimeIdentity(ctx, target, environment, true); err != nil {
		return actionError("UPGRADE_RUNTIME_MISMATCH", "target HTTPS became ready but its active image or build identity is not the recorded target", "Keep the journal and checksum-verified archive; do not commit or pull a replacement image.", err)
	}
	if err := advanceUpgradeJournal(
		current.UpgradeJournalPath,
		journal,
		upgradePhaseTargetReady,
		controller.dependencies.Now(),
	); err != nil {
		return actionError("UPGRADE_JOURNAL_WRITE_FAILED", "target is ready but durable upgrade progress could not be updated", "Do not run another lifecycle action. Repair the journal path and retry only this exact target.", err)
	}
	canonicalTarget := current
	canonicalTarget.Manifest = targetManifest
	if err := renderConfiguration(options, metadata.ReleaseVersion, canonicalTarget); err != nil {
		return actionError("UPGRADE_COMMIT_FAILED", "target is ready but canonical control configuration could not be committed", "The journal blocks other lifecycle actions. Repair control-directory permissions and retry only this exact target.", err)
	}
	if !committed {
		if err := controller.recordStep(&targetManifest, current.ManifestPath, "ready"); err != nil {
			return err
		}
	}
	if err := removeUpgradeJournal(current.UpgradeJournalPath); err != nil {
		return actionError("UPGRADE_CLEANUP_FAILED", "the target manifest is committed but its completed upgrade journal remains", "Retry the same target upgrade to re-verify the active revision and remove only the completed journal.", err)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Upgraded ConveneWire from %s to %s after a verified backup.\nOrigin: %s\n",
		journal.Previous.ReleaseVersion,
		targetManifest.ReleaseVersion,
		targetManifest.PublicOrigin,
	)
	return nil
}

func manifestTLSProfile(manifest Manifest) string {
	if manifest.SchemaVersion == legacyManifestSchemaVersion || manifest.TLSProfile == "" {
		return "legacy_unclassified"
	}
	return manifest.TLSProfile
}

func printableInstallationID(manifest Manifest) string {
	if manifest.InstallationID == "" {
		return "legacy-unavailable"
	}
	return manifest.InstallationID
}

func (controller *Controller) activeRevisionState(ctx context.Context, installation Installation, environment map[string]string) string {
	output, err := controller.runCompose(ctx, installation, environment,
		"images", "--format", "json", "agentroom")
	if err != nil {
		return "unknown (image inspection failed)"
	}
	value := strings.TrimSpace(output)
	if value == "" {
		return "no convenewire image reported"
	}
	if len(value) > 500 {
		value = value[:500]
	}
	return strings.ReplaceAll(value, "\n", " ")
}

func openInstallation(dataRoot string) (Installation, error) {
	installation, err := openInstallationUnchecked(dataRoot)
	if err != nil {
		return Installation{}, err
	}
	if err := rejectPendingUpgrade(installation); err != nil {
		return Installation{}, err
	}
	return installation, nil
}

func openInstallationUnchecked(dataRoot string) (Installation, error) {
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
		return Installation{}, actionError("INSTALLATION_NOT_FOUND", "no ConveneWire installation manifest exists at the selected data root", "Run convenewirectl install or select the original data root.", nil)
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

func (controller *Controller) verifyInstalledRelease(installation Installation) error {
	metadata, digest, err := verifyRelease(
		installation.Manifest.ReleaseDir,
		filepath.Join(installation.Manifest.ReleaseDir, "SHA256SUMS"),
		installation.Manifest.ReleaseDigest,
	)
	if err != nil {
		return err
	}
	if metadata.TargetOS != controller.dependencies.GOOS || metadata.TargetArch != controller.dependencies.GOARCH {
		return actionError("RELEASE_TARGET_MISMATCH", "installed release target no longer matches this host", "Use the installation on its original host architecture or perform a documented migration with the matching central release.", nil)
	}
	if metadata.ReleaseVersion != installation.Manifest.ReleaseVersion ||
		metadata.DataSchemaVersion != installation.Manifest.DataSchemaVersion ||
		digest != installation.Manifest.ReleaseDigest ||
		(installation.Manifest.SourceCommit != "" && metadata.SourceCommit != installation.Manifest.SourceCommit) ||
		!runtimeImagesMatch(installation.Manifest, metadata) {
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
