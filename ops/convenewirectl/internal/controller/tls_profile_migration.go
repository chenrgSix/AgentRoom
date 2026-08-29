package controller

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"
)

func (controller *Controller) MigrateLegacyPublicCA(ctx context.Context, dataRoot string) error {
	ctx, releaseLifecycle, err := acquireLifecycleLock(ctx, dataRoot)
	if err != nil {
		return err
	}
	defer func() { _ = releaseLifecycle() }()
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	manifest := installation.Manifest
	if manifest.SchemaVersion != legacyManifestSchemaVersion || manifest.Mode != "direct_https" ||
		manifest.LastSuccessfulStep != "ready" || !publicCAHostname(manifest.Domain) {
		return actionError(
			"TLS_PROFILE_MIGRATION_INELIGIBLE",
			"only a ready legacy direct-HTTPS installation on a public DNS hostname can be inspected for public-CA migration",
			"Keep private/manual installations unclassified until an explicit scoped re-pair or enterprise trust migration is selected.",
			nil,
		)
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := controller.verifyInstalledRelease(installation); err != nil {
		return err
	}
	preflight := ReadinessInput{
		PublicOrigin: manifest.PublicOrigin,
		TLSProfile:   "public_ca",
		Timeout:      30 * time.Second,
	}
	if err := controller.dependencies.CheckReadiness(ctx, preflight); err != nil {
		return actionError(
			"TLS_PROFILE_NOT_PUBLIC",
			"the legacy origin did not pass system-only public certificate validation",
			"Do not relabel or fall back. Keep the installation legacy_unclassified and inspect its existing certificate authority.",
			err,
		)
	}
	installationID, err := newInstallationID(controller.dependencies.Random)
	if err != nil {
		return actionError("INSTALLATION_ID_FAILED", "could not generate the stable installation identity", "Check the host random source and retry before changing configuration.", err)
	}
	candidate := manifest
	candidate.SchemaVersion = manifestSchemaVersion
	candidate.TLSProfile = "public_ca"
	candidate.InstallationID = installationID
	candidate.TrustEpoch = 0
	candidate.CACertificateSHA256 = ""
	candidate.PrivateCAID = ""
	candidate.UpdatedAt = controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
	candidateInstallation := installation
	candidateInstallation.Manifest = candidate
	options := InstallOptions{
		ReleaseDir: manifest.ReleaseDir, DataRoot: manifest.DataRoot,
		Mode: manifest.Mode, TLSProfile: candidate.TLSProfile,
		Domain: manifest.Domain, PublicOrigin: manifest.PublicOrigin,
		HTTPPort: manifest.HTTPPort, HTTPSPort: manifest.HTTPSPort,
		LegacyServerToken: manifest.LegacyServerToken,
		ProjectName:       manifest.ProjectName,
	}
	previousEnvironment, err := os.ReadFile(installation.EnvironmentPath)
	if err != nil {
		return actionError("TLS_PROFILE_MIGRATION_CONFIG_FAILED", "could not snapshot the current generated environment", "Restore the original control files and retry.", err)
	}
	previousOverride, err := os.ReadFile(installation.OverridePath)
	if err != nil {
		return actionError("TLS_PROFILE_MIGRATION_CONFIG_FAILED", "could not snapshot the current Compose override", "Restore the original control files and retry.", err)
	}
	rollback := func(cause error) error {
		environmentErr := writeAtomic(installation.EnvironmentPath, previousEnvironment, 0o600)
		overrideErr := writeAtomic(installation.OverridePath, previousOverride, 0o600)
		restartErr := error(nil)
		if environmentErr == nil && overrideErr == nil {
			environment, environmentLoadErr := installationEnvironment(installation)
			if environmentLoadErr != nil {
				restartErr = environmentLoadErr
			} else {
				_, restartErr = controller.runCompose(ctx, installation, environment,
					composeUpArguments(installation.Manifest, false, "caddy")...)
			}
		}
		return actionError(
			"TLS_PROFILE_MIGRATION_FAILED",
			"the inspected public-CA migration did not converge and the legacy control files were restored",
			"Confirm the legacy origin remains healthy, inspect Caddy, and retry only after correcting the bounded failure.",
			errors.Join(cause, environmentErr, overrideErr, restartErr),
		)
	}
	if err := renderConfiguration(options, manifest.ReleaseVersion, candidateInstallation); err != nil {
		return rollback(err)
	}
	environment, err := installationEnvironment(candidateInstallation)
	if err != nil {
		return rollback(err)
	}
	if _, err := controller.runCompose(ctx, candidateInstallation, environment, "config", "--quiet"); err != nil {
		return rollback(err)
	}
	if _, err := controller.runCompose(ctx, candidateInstallation, environment,
		composeUpArguments(candidateInstallation.Manifest, false, "caddy")...); err != nil {
		return rollback(err)
	}
	if err := controller.dependencies.CheckReadiness(ctx, ReadinessInput{
		PublicOrigin: candidate.PublicOrigin,
		TLSProfile:   "public_ca",
		Timeout:      defaultReadyTimeout,
	}); err != nil {
		return rollback(err)
	}
	if err := saveManifestCAS(installation.ManifestPath, &candidate); err != nil {
		return actionError(
			"TLS_PROFILE_MIGRATION_COMMIT_FAILED",
			"the public-CA profile is ready but the schema-v2 manifest could not be committed",
			"Do not start another lifecycle operation; repair manifest permissions and rerun this exact migration.",
			err,
		)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Migrated inspected legacy HTTPS state to public_ca with installation ID %s.\n",
		candidate.InstallationID,
	)
	return nil
}
