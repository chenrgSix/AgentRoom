package controller

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type BrowserTransportMigrationOptions struct {
	DataRoot string
	Mode     string
}

type browserTransportSnapshot struct {
	environment []byte
	override    []byte
}

func (controller *Controller) MigrateBrowserTransport(
	ctx context.Context,
	raw BrowserTransportMigrationOptions,
) error {
	ctx, releaseLifecycle, err := acquireLifecycleLock(ctx, raw.DataRoot)
	if err != nil {
		return err
	}
	defer func() { _ = releaseLifecycle() }()
	installation, err := openInstallation(raw.DataRoot)
	if err != nil {
		return err
	}
	manifest := installation.Manifest
	targetMode := raw.Mode
	if targetMode != "lan_http" && targetMode != "direct_https" {
		return actionError("BROWSER_TRANSPORT_INVALID", "browser transport mode must be lan_http or direct_https", "Use lan_http for convenient unencrypted LAN browser access or direct_https for browser HTTPS.", nil)
	}
	if manifest.SchemaVersion != manifestSchemaVersion ||
		(manifest.Mode != "direct_https" && manifest.Mode != "lan_http") ||
		manifest.TLSProfile != "private_scoped_ca" || manifest.LastSuccessfulStep != "ready" ||
		manifest.TrustEpoch < 1 || !hashPattern.MatchString(manifest.CACertificateSHA256) {
		return actionError("BROWSER_TRANSPORT_INELIGIBLE", "only a ready scoped-private LAN/direct installation can change browser transport", "Run convenewirectl doctor and retain the exact private HTTPS Bridge authority before changing browser access.", nil)
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := controller.verifyInstalledRelease(installation); err != nil {
		return err
	}
	if err := inspectPrivateFile(installation.ManifestPath); err != nil {
		return actionError("MANIFEST_INVALID", "installation manifest permissions are unsafe", "Restore mode 0600 and ownership before continuing.", err)
	}
	if err := validateSecret(installation.OwnerSecretPath); err != nil {
		return actionError("BROWSER_TRANSPORT_SECRET_INVALID", "Owner recovery authority is missing, malformed, or unsafe", "Restore the exact original 0600 recovery file before changing browser access.", err)
	}
	if manifest.LegacyServerToken {
		if err := validateSecret(installation.ServerSecretPath); err != nil {
			return actionError("BROWSER_TRANSPORT_SECRET_INVALID", "legacy Server Token authority is missing, malformed, or unsafe", "Restore the exact original 0600 Token file before changing browser access.", err)
		}
	}
	if err := rejectPrivateHostnameMigrationDuringRotation(installation); err != nil {
		return actionError("BROWSER_TRANSPORT_ROTATION_ACTIVE", "private CA rotation state exists", "Complete or recover the trust rotation before changing browser access.", err)
	}
	currentEnvironment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	if err := controller.verifyActiveRuntimeIdentity(ctx, installation, currentEnvironment, true); err != nil {
		return actionError("BROWSER_TRANSPORT_RUNTIME_MISMATCH", "the running Central revision is not the recorded release", "Restore the exact installed runtime before changing browser access.", err)
	}
	currentReadiness := readinessForManifest(manifest, 30*time.Second)
	if err := controller.dependencies.CheckReadiness(ctx, currentReadiness); err != nil {
		return actionError("BROWSER_TRANSPORT_CURRENT_UNREADY", "current browser and Bridge ingress did not pass readiness", "Restore current readiness before attempting a browser transport migration.", err)
	}
	if manifest.Mode == targetMode {
		fmt.Fprintf(controller.dependencies.Output, "Browser transport is already %s.\nBrowser: %s\nBridge: %s\n",
			targetMode, currentReadiness.BrowserOrigin, currentReadiness.PublicOrigin)
		return nil
	}

	candidateManifest := manifest
	candidateManifest.Mode = targetMode
	candidateManifest.UpdatedAt = controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
	options := installOptionsForManifest(candidateManifest)
	candidate := installation
	candidate.Manifest = candidateManifest
	candidateRoot, err := os.MkdirTemp(filepath.Join(manifest.DataRoot, "control"), ".browser-transport-")
	if err != nil {
		return actionError("BROWSER_TRANSPORT_CONFIG_FAILED", "could not create isolated browser transport configuration", "Repair control-directory permissions; the current installation remains unchanged.", err)
	}
	defer os.RemoveAll(candidateRoot)
	candidate.EnvironmentPath = filepath.Join(candidateRoot, "convenewire.env")
	candidate.OverridePath = filepath.Join(candidateRoot, "compose.override.yaml")
	if err := renderConfiguration(options, manifest.ReleaseVersion, candidate); err != nil {
		return actionError("BROWSER_TRANSPORT_CONFIG_FAILED", "could not render isolated browser transport configuration", "The current manifest and running topology remain unchanged.", err)
	}
	environment, err := installationEnvironment(candidate)
	if err != nil {
		return err
	}
	if _, err := controller.runCompose(ctx, candidate, environment, "config", "--quiet"); err != nil {
		return actionError("BROWSER_TRANSPORT_COMPOSE_INVALID", "Docker Compose rejected the browser transport candidate", "Restore the exact installed release; no running state was changed.", err)
	}
	snapshot, err := snapshotBrowserTransport(installation)
	if err != nil {
		return actionError("BROWSER_TRANSPORT_SNAPSHOT_FAILED", "could not snapshot current generated control files", "Restore the exact control files before changing the running topology.", err)
	}
	rollback := func(cause error) error {
		restoreErr := restoreBrowserTransport(installation, snapshot)
		restartErr := error(nil)
		readinessErr := error(nil)
		if restoreErr == nil {
			oldEnvironment, environmentErr := installationEnvironment(installation)
			if environmentErr != nil {
				restartErr = environmentErr
			} else {
				_, restartErr = controller.runCompose(ctx, installation, oldEnvironment,
					composeUpArguments(manifest, false)...)
			}
			if restartErr == nil {
				readinessErr = controller.dependencies.CheckReadiness(ctx, currentReadiness)
			}
		}
		joined := errors.Join(cause, restoreErr, restartErr, readinessErr)
		if restoreErr != nil || restartErr != nil || readinessErr != nil {
			return actionError("BROWSER_TRANSPORT_ROLLBACK_FAILED", "browser transport migration failed and the previous topology did not fully converge", "Preserve the manifest and control files; restore the old transport before retrying.", joined)
		}
		return actionError("BROWSER_TRANSPORT_MIGRATION_FAILED", "browser transport candidate failed and the previous topology was restored", "Correct the bounded readiness or Compose failure, then retry the same explicit migration.", joined)
	}
	if _, err := controller.runCompose(ctx, candidate, environment,
		composeUpArguments(candidateManifest, true)...); err != nil {
		return rollback(err)
	}
	targetReadiness := readinessForManifest(candidateManifest, defaultReadyTimeout)
	if err := controller.dependencies.CheckReadiness(ctx, targetReadiness); err != nil {
		return rollback(err)
	}
	canonicalCandidate := installation
	canonicalCandidate.Manifest = candidateManifest
	if err := renderConfiguration(options, manifest.ReleaseVersion, canonicalCandidate); err != nil {
		return rollback(err)
	}
	canonicalEnvironment, err := installationEnvironment(canonicalCandidate)
	if err != nil {
		return rollback(err)
	}
	if _, err := controller.runCompose(ctx, canonicalCandidate, canonicalEnvironment,
		composeUpArguments(candidateManifest, false)...); err != nil {
		return rollback(err)
	}
	if err := controller.dependencies.CheckReadiness(ctx, targetReadiness); err != nil {
		return rollback(err)
	}
	if err := controller.verifyActiveRuntimeIdentity(ctx, canonicalCandidate, canonicalEnvironment, true); err != nil {
		return rollback(err)
	}
	if err := saveManifestCAS(installation.ManifestPath, &candidateManifest); err != nil {
		return rollback(err)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Browser transport migrated from %s to %s.\nBrowser: %s\nBridge: %s\n%s\nCA and Device authority: unchanged.\n",
		manifest.Mode, candidateManifest.Mode, targetReadiness.BrowserOrigin, targetReadiness.PublicOrigin,
		browserTransportNotice(candidateManifest.Mode))
	return nil
}

func installOptionsForManifest(manifest Manifest) InstallOptions {
	return InstallOptions{
		ReleaseDir: manifest.ReleaseDir, ChecksumsPath: filepath.Join(manifest.ReleaseDir, "SHA256SUMS"),
		ChecksumsSHA256: manifest.ReleaseDigest, DataRoot: manifest.DataRoot,
		Mode: manifest.Mode, TLSProfile: manifest.TLSProfile, Domain: manifest.Domain,
		PublicOrigin: manifest.PublicOrigin, HTTPPort: manifest.HTTPPort, HTTPSPort: manifest.HTTPSPort,
		LegacyServerToken: manifest.LegacyServerToken, ProjectName: manifest.ProjectName,
	}
}

func readinessForManifest(manifest Manifest, timeout time.Duration) ReadinessInput {
	return ReadinessInput{
		PublicOrigin:  manifest.PublicOrigin,
		BrowserOrigin: browserOrigin(manifest.Mode, manifest.Domain, manifest.HTTPPort, manifest.PublicOrigin),
		LocalCARoot:   privateCARootPath(manifest, activePrivateCAID(manifest)),
		TLSProfile:    manifest.TLSProfile, ExpectedCADigest: manifest.CACertificateSHA256,
		Timeout: timeout,
	}
}

func snapshotBrowserTransport(installation Installation) (browserTransportSnapshot, error) {
	environment, err := readBoundedFile(installation.EnvironmentPath, 1<<20)
	if err != nil {
		return browserTransportSnapshot{}, err
	}
	override, err := readBoundedFile(installation.OverridePath, 1<<20)
	if err != nil {
		return browserTransportSnapshot{}, err
	}
	return browserTransportSnapshot{environment: environment, override: override}, nil
}

func restoreBrowserTransport(installation Installation, snapshot browserTransportSnapshot) error {
	return errors.Join(
		writeAtomic(installation.EnvironmentPath, snapshot.environment, 0o600),
		writeAtomic(installation.OverridePath, snapshot.override, 0o600),
	)
}
