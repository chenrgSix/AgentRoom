package controller

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type PrivateHostnameMigrationOptions struct {
	DataRoot string
	Hostname string
}

type privateHostnameMigrationSnapshot struct {
	environment     []byte
	override        []byte
	trustDescriptor []byte
	trustCAPEM      []byte
}

func (controller *Controller) MigratePrivateHostname(
	ctx context.Context,
	raw PrivateHostnameMigrationOptions,
) error {
	installation, err := openInstallation(raw.DataRoot)
	if err != nil {
		return err
	}
	manifest := installation.Manifest
	if manifest.SchemaVersion != manifestSchemaVersion || manifest.Mode != "direct_https" ||
		manifest.TLSProfile != "private_scoped_ca" || manifest.LastSuccessfulStep != "ready" ||
		manifest.TrustEpoch < 1 || !hashPattern.MatchString(manifest.CACertificateSHA256) ||
		net.ParseIP(manifest.Domain) == nil {
		return actionError(
			"PRIVATE_HOSTNAME_MIGRATION_INELIGIBLE",
			"only a ready scoped-private literal-IP installation can migrate to a stable hostname",
			"Run convenewirectl doctor and use the original IP installation; hostname, public, manual and legacy origins are not rewritten by this operation.",
			nil,
		)
	}
	hostname := strings.ToLower(strings.TrimSpace(raw.Hostname))
	if !validDomain(hostname) || net.ParseIP(hostname) != nil || isLoopbackHost(hostname) {
		return actionError(
			"PRIVATE_HOSTNAME_INVALID",
			"target hostname must be one non-loopback DNS or mDNS name, not an IP address",
			"Use a stable name such as central.example.net or central.local without a scheme, port, path or wildcard.",
			nil,
		)
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
		return actionError("PRIVATE_HOSTNAME_SECRET_INVALID", "Owner recovery authority is missing, malformed, or unsafe", "Restore the exact original 0600 recovery file before changing the Central hostname.", err)
	}
	if manifest.LegacyServerToken {
		if err := validateSecret(installation.ServerSecretPath); err != nil {
			return actionError("PRIVATE_HOSTNAME_SECRET_INVALID", "legacy Server Token authority is missing, malformed, or unsafe", "Restore the exact original 0600 Token file before changing the Central hostname.", err)
		}
	}
	if err := rejectPrivateHostnameMigrationDuringRotation(installation); err != nil {
		return err
	}

	targetOrigin := (&url.URL{Scheme: "https", Host: hostname}).String()
	if manifest.HTTPSPort != 443 {
		targetOrigin = (&url.URL{
			Scheme: "https",
			Host:   net.JoinHostPort(hostname, strconv.Itoa(manifest.HTTPSPort)),
		}).String()
	}
	options := InstallOptions{
		ReleaseDir:        manifest.ReleaseDir,
		ChecksumsPath:     filepath.Join(manifest.ReleaseDir, "SHA256SUMS"),
		ChecksumsSHA256:   manifest.ReleaseDigest,
		DataRoot:          manifest.DataRoot,
		Mode:              manifest.Mode,
		TLSProfile:        manifest.TLSProfile,
		Domain:            hostname,
		PublicOrigin:      targetOrigin,
		HTTPPort:          manifest.HTTPPort,
		HTTPSPort:         manifest.HTTPSPort,
		LegacyServerToken: manifest.LegacyServerToken,
		ProjectName:       manifest.ProjectName,
	}
	options, err = controller.normalizeInstallOptions(options)
	if err != nil {
		return err
	}
	candidateManifest := manifest
	candidateManifest.Domain = options.Domain
	candidateManifest.PublicOrigin = options.PublicOrigin
	candidateManifest.UpdatedAt = controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
	candidate := installation
	candidate.Manifest = candidateManifest
	candidateRoot, err := os.MkdirTemp(filepath.Join(manifest.DataRoot, "control"), ".hostname-")
	if err != nil {
		return actionError("PRIVATE_HOSTNAME_CONFIG_FAILED", "could not create isolated hostname configuration", "Repair control-directory permissions; the current installation remains unchanged.", err)
	}
	defer os.RemoveAll(candidateRoot)
	candidate.EnvironmentPath = filepath.Join(candidateRoot, "convenewire.env")
	candidate.OverridePath = filepath.Join(candidateRoot, "compose.override.yaml")
	if err := renderConfiguration(options, manifest.ReleaseVersion, candidate); err != nil {
		return actionError("PRIVATE_HOSTNAME_CONFIG_FAILED", "could not render isolated hostname configuration", "The current manifest, trust and running topology remain unchanged.", err)
	}
	environment, err := installationEnvironment(candidate)
	if err != nil {
		return err
	}
	if _, err := controller.runCompose(ctx, candidate, environment, "config", "--quiet"); err != nil {
		return actionError("PRIVATE_HOSTNAME_COMPOSE_INVALID", "Docker Compose rejected the hostname candidate", "Correct the selected hostname or installed release; no running state was changed.", err)
	}
	snapshot, err := snapshotPrivateHostnameMigration(installation)
	if err != nil {
		return actionError("PRIVATE_HOSTNAME_SNAPSHOT_FAILED", "could not snapshot current generated control and public trust files", "Restore the exact installation files and retry before changing the running hostname.", err)
	}
	rollback := func(cause error) error {
		restoreErr := restorePrivateHostnameMigration(installation, snapshot)
		restartErr := error(nil)
		readinessErr := error(nil)
		if restoreErr == nil {
			oldEnvironment, environmentErr := installationEnvironment(installation)
			if environmentErr != nil {
				restartErr = environmentErr
			} else {
				_, restartErr = controller.runCompose(
					ctx, installation, oldEnvironment,
					"up", "-d", "--wait", "--wait-timeout", "180",
				)
			}
			if restartErr == nil {
				readinessErr = controller.dependencies.CheckReadiness(ctx, ReadinessInput{
					PublicOrigin:     manifest.PublicOrigin,
					LocalCARoot:      privateCARootPath(manifest, activePrivateCAID(manifest)),
					TLSProfile:       manifest.TLSProfile,
					ExpectedCADigest: manifest.CACertificateSHA256,
					Timeout:          30 * time.Second,
				})
			}
		}
		joined := errors.Join(cause, restoreErr, restartErr, readinessErr)
		if restoreErr != nil || restartErr != nil || readinessErr != nil {
			return actionError(
				"PRIVATE_HOSTNAME_ROLLBACK_FAILED",
				"hostname migration failed and the previous topology did not fully converge",
				"Preserve the manifest and control files; restore the old origin before retrying or changing trust state.",
				joined,
			)
		}
		return actionError(
			"PRIVATE_HOSTNAME_MIGRATION_FAILED",
			"hostname candidate failed and the previous origin was restored",
			"Correct name resolution or target hostname routing, then retry the same explicit migration.",
			joined,
		)
	}
	if _, err := publishPrivateTrust(candidate, candidateManifest, controller.dependencies.Now()); err != nil {
		return rollback(err)
	}
	if _, err := controller.runCompose(
		ctx, candidate, environment,
		"up", "-d", "--build", "--wait", "--wait-timeout", "180",
	); err != nil {
		return rollback(err)
	}
	targetReadiness := ReadinessInput{
		PublicOrigin:     candidateManifest.PublicOrigin,
		LocalCARoot:      privateCARootPath(candidateManifest, activePrivateCAID(candidateManifest)),
		TLSProfile:       candidateManifest.TLSProfile,
		ExpectedCADigest: candidateManifest.CACertificateSHA256,
		Timeout:          defaultReadyTimeout,
	}
	if err := controller.dependencies.CheckReadiness(ctx, targetReadiness); err != nil {
		return rollback(err)
	}
	if err := renderConfiguration(options, manifest.ReleaseVersion, installation); err != nil {
		return rollback(err)
	}
	canonicalEnvironment, err := installationEnvironment(installation)
	if err != nil {
		return rollback(err)
	}
	if _, err := controller.runCompose(
		ctx, installation, canonicalEnvironment,
		"up", "-d", "--wait", "--wait-timeout", "180",
	); err != nil {
		return rollback(err)
	}
	if err := controller.dependencies.CheckReadiness(ctx, targetReadiness); err != nil {
		return rollback(err)
	}
	candidateManifest.LastSuccessfulStep = "ready"
	if err := saveManifest(installation.ManifestPath, candidateManifest); err != nil {
		return rollback(err)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Migrated scoped-private Central from %s to %s.\nInstallation ID: %s\nCA: %s; trust epoch: %d (unchanged).\nDevice credentials and Team data were preserved.\n",
		manifest.PublicOrigin, candidateManifest.PublicOrigin,
		candidateManifest.InstallationID,
		redactedDigest(candidateManifest.CACertificateSHA256), candidateManifest.TrustEpoch,
	)
	return nil
}

func rejectPrivateHostnameMigrationDuringRotation(installation Installation) error {
	for _, path := range []string{installation.TrustRotationPath, installation.RotationJournalPath} {
		_, err := os.Lstat(path)
		if err == nil {
			return actionError(
				"PRIVATE_HOSTNAME_ROTATION_ACTIVE",
				"private CA rotation state exists",
				"Complete or recover the current trust rotation before changing the Central hostname.",
				nil,
			)
		}
		if !errors.Is(err, os.ErrNotExist) {
			return actionError("PRIVATE_HOSTNAME_ROTATION_INVALID", "private CA rotation state could not be inspected", "Repair trust/control permissions without deleting rotation state.", err)
		}
	}
	return nil
}

func snapshotPrivateHostnameMigration(installation Installation) (privateHostnameMigrationSnapshot, error) {
	read := func(path string, maximum int64) ([]byte, error) {
		value, err := readBoundedFile(path, maximum)
		if err != nil {
			return nil, fmt.Errorf("snapshot %s: %w", filepath.Base(path), err)
		}
		return value, nil
	}
	environment, err := read(installation.EnvironmentPath, 1<<20)
	if err != nil {
		return privateHostnameMigrationSnapshot{}, err
	}
	override, err := read(installation.OverridePath, 1<<20)
	if err != nil {
		return privateHostnameMigrationSnapshot{}, err
	}
	descriptor, err := read(installation.TrustDescriptorPath, 16<<10)
	if err != nil {
		return privateHostnameMigrationSnapshot{}, err
	}
	caPEM, err := read(installation.TrustCAPEMPath, 16<<10)
	if err != nil {
		return privateHostnameMigrationSnapshot{}, err
	}
	return privateHostnameMigrationSnapshot{
		environment: environment, override: override,
		trustDescriptor: descriptor, trustCAPEM: caPEM,
	}, nil
}

func restorePrivateHostnameMigration(
	installation Installation,
	snapshot privateHostnameMigrationSnapshot,
) error {
	return errors.Join(
		writeAtomic(installation.EnvironmentPath, snapshot.environment, 0o600),
		writeAtomic(installation.OverridePath, snapshot.override, 0o600),
		writeAtomic(installation.TrustDescriptorPath, snapshot.trustDescriptor, 0o644),
		writeAtomic(installation.TrustCAPEMPath, snapshot.trustCAPEM, 0o644),
	)
}
