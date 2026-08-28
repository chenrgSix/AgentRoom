package controller

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultPrivateCAOverlap = 24 * time.Hour
	minimumPrivateCAOverlap = time.Hour
	maximumPrivateCAOverlap = 30 * 24 * time.Hour
)

type PrivateCARotationOptions struct {
	DataRoot string
	Overlap  time.Duration
}

type privateCARotationOffer struct {
	SchemaVersion     int                        `json:"schemaVersion"`
	CurrentTrustEpoch int                        `json:"currentTrustEpoch"`
	NextTrust         privateCARotationNextTrust `json:"nextTrust"`
	CACertificatePEM  string                     `json:"caCertificatePem"`
	OverlapEndsAt     string                     `json:"overlapEndsAt"`
}

type privateCARotationNextTrust struct {
	Mode                string `json:"mode"`
	Origin              string `json:"origin"`
	InstallationID      string `json:"installationId"`
	TrustEpoch          int    `json:"trustEpoch"`
	CACertificateSHA256 string `json:"caCertificateSha256"`
}

type privateCARotationAcknowledgements struct {
	Eligible     int `json:"eligible"`
	Acknowledged int `json:"acknowledged"`
}

func privateCAID(installationID string, epoch int) string {
	digest := sha256.Sum256([]byte(installationID))
	return fmt.Sprintf("convenewire-%d-%s", epoch, hex.EncodeToString(digest[:8]))
}

func activePrivateCAID(manifest Manifest) string {
	if manifest.PrivateCAID != "" {
		return manifest.PrivateCAID
	}
	// Schema-v2 installations created before named authorities used Caddy's
	// built-in local authority. Keeping that exact ID preserves their root.
	return "local"
}

func privateCARootPath(manifest Manifest, caID string) string {
	return filepath.Join(
		manifest.DataRoot,
		"caddy", "data", "caddy", "pki", "authorities", caID, "root.crt",
	)
}

func privateCaddyTLSProfile(caIDs ...string) ([]byte, error) {
	if len(caIDs) < 1 || len(caIDs) > 2 {
		return nil, fmt.Errorf("private Caddy TLS profile requires one or two authorities")
	}
	seen := make(map[string]struct{}, len(caIDs))
	var value strings.Builder
	value.WriteString("tls {\n")
	for _, caID := range caIDs {
		if !privateCAIDPattern.MatchString(caID) {
			return nil, fmt.Errorf("private Caddy authority ID is invalid")
		}
		if _, duplicate := seen[caID]; duplicate {
			return nil, fmt.Errorf("private Caddy authority IDs must be distinct")
		}
		seen[caID] = struct{}{}
		fmt.Fprintf(&value, "  issuer internal {\n    ca %s\n  }\n", caID)
	}
	value.WriteString(`}

handle /.well-known/convenewire/bridge-ca.pem {
  rewrite * /bridge-ca.pem
  root * /run/agentroom/trust
  header Content-Type application/x-pem-file
  header Cache-Control "public, max-age=300"
  file_server
}
`)
	return []byte(value.String()), nil
}

func privateCaddyPKIProfile(caIDs ...string) ([]byte, error) {
	if len(caIDs) < 1 || len(caIDs) > 2 {
		return nil, fmt.Errorf("private Caddy PKI profile requires one or two authorities")
	}
	seen := make(map[string]struct{}, len(caIDs))
	var value strings.Builder
	value.WriteString("pki {\n")
	for _, caID := range caIDs {
		if !privateCAIDPattern.MatchString(caID) {
			return nil, fmt.Errorf("private Caddy authority ID is invalid")
		}
		if _, duplicate := seen[caID]; duplicate {
			return nil, fmt.Errorf("private Caddy authority IDs must be distinct")
		}
		seen[caID] = struct{}{}
		fmt.Fprintf(&value, "  ca %s\n", caID)
	}
	value.WriteString("}\n")
	return []byte(value.String()), nil
}

func ensurePrivateCaddyProfiles(installation Installation) error {
	current := activePrivateCAID(installation.Manifest)
	currentOnly, err := privateCaddyTLSProfile(current)
	if err != nil {
		return err
	}
	nextID := privateCAID(installation.Manifest.InstallationID, installation.Manifest.TrustEpoch+1)
	overlap, err := privateCaddyTLSProfile(current, nextID)
	if err != nil {
		return err
	}
	currentPKI, err := privateCaddyPKIProfile(current)
	if err != nil {
		return err
	}
	overlapPKI, err := privateCaddyPKIProfile(current, nextID)
	if err != nil {
		return err
	}
	if err := ensureExactCurrentOrOverlapFile(
		installation.CaddyPKIProfilePath, currentPKI, overlapPKI,
	); err != nil {
		return fmt.Errorf("private Caddy PKI profile: %w", err)
	}
	if err := ensureExactCurrentOrOverlapFile(
		installation.CaddyTLSProfilePath, currentOnly, overlap,
	); err != nil {
		return fmt.Errorf("private Caddy TLS profile: %w", err)
	}
	return nil
}

func ensureExactCurrentOrOverlapFile(path string, currentOnly, overlap []byte) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return writeAtomic(path, currentOnly, 0o644)
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 16<<10 {
		return fmt.Errorf("profile is not a bounded regular file")
	}
	value, err := readBoundedFile(path, 16<<10)
	if err != nil {
		return err
	}
	if !bytes.Equal(value, currentOnly) && !bytes.Equal(value, overlap) {
		return fmt.Errorf("profile disagrees with the installation epoch")
	}
	return nil
}

func writePrivateCaddyProfiles(installation Installation, caIDs ...string) error {
	pkiValue, err := privateCaddyPKIProfile(caIDs...)
	if err != nil {
		return err
	}
	tlsValue, err := privateCaddyTLSProfile(caIDs...)
	if err != nil {
		return err
	}
	if err := writeAtomic(installation.CaddyPKIProfilePath, pkiValue, 0o644); err != nil {
		return err
	}
	return writeAtomic(installation.CaddyTLSProfilePath, tlsValue, 0o644)
}

func validatePrivateRotationInstallation(installation Installation) error {
	manifest := installation.Manifest
	if manifest.SchemaVersion != manifestSchemaVersion || manifest.Mode != "direct_https" ||
		manifest.TLSProfile != "private_scoped_ca" || manifest.TrustEpoch < 1 ||
		!hashPattern.MatchString(manifest.CACertificateSHA256) ||
		manifest.LastSuccessfulStep != "ready" {
		return actionError(
			"PRIVATE_ROTATION_INELIGIBLE",
			"only a ready scoped-private installation with recorded CA trust can rotate",
			"Run convenewirectl doctor and complete the original private installation before rotating its CA.",
			nil,
		)
	}
	return nil
}

func parseSingleCA(value []byte, now time.Time) (*x509.Certificate, string, error) {
	if len(value) > 8<<10 {
		return nil, "", fmt.Errorf("CA certificate exceeds the rotation bound")
	}
	block, remainder := pem.Decode(value)
	if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 ||
		len(bytes.TrimSpace(remainder)) != 0 {
		return nil, "", fmt.Errorf("expected exactly one unadorned PEM certificate")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, "", err
	}
	if !certificate.BasicConstraintsValid || !certificate.IsCA ||
		certificate.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, "", fmt.Errorf("certificate is not a constrained signing CA")
	}
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) {
		return nil, "", fmt.Errorf("CA certificate is outside its validity window")
	}
	digest := sha256.Sum256(certificate.Raw)
	return certificate, hex.EncodeToString(digest[:]), nil
}

func validatePrivateCARotationOffer(
	offer privateCARotationOffer,
	manifest Manifest,
	now time.Time,
) error {
	if offer.SchemaVersion != 1 || offer.CurrentTrustEpoch != manifest.TrustEpoch ||
		offer.NextTrust.Mode != "private_scoped_ca" ||
		offer.NextTrust.Origin != manifest.PublicOrigin ||
		offer.NextTrust.InstallationID != manifest.InstallationID ||
		offer.NextTrust.TrustEpoch != manifest.TrustEpoch+1 ||
		!hashPattern.MatchString(offer.NextTrust.CACertificateSHA256) ||
		offer.NextTrust.CACertificateSHA256 == manifest.CACertificateSHA256 {
		return fmt.Errorf("private CA rotation descriptor is invalid")
	}
	overlapEndsAt, err := time.Parse(time.RFC3339Nano, offer.OverlapEndsAt)
	if err != nil || !now.Before(overlapEndsAt) || overlapEndsAt.After(now.Add(maximumPrivateCAOverlap)) {
		return fmt.Errorf("private CA rotation overlap is invalid or expired")
	}
	certificate, digest, err := parseSingleCA([]byte(offer.CACertificatePEM), now)
	if err != nil || digest != offer.NextTrust.CACertificateSHA256 {
		return fmt.Errorf("private CA rotation certificate does not match its digest")
	}
	canonical := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
	if !bytes.Equal(canonical, []byte(offer.CACertificatePEM)) {
		return fmt.Errorf("private CA rotation certificate is not canonical PEM")
	}
	return nil
}

func loadPrivateCARotationOffer(path string, manifest Manifest, now time.Time) (privateCARotationOffer, bool, error) {
	offer, found, err := readPrivateCARotationOffer(path)
	if err != nil || !found {
		return offer, found, err
	}
	if err := validatePrivateCARotationOffer(offer, manifest, now); err != nil {
		return privateCARotationOffer{}, false, err
	}
	return offer, true, nil
}

func readPrivateCARotationOffer(path string) (privateCARotationOffer, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return privateCARotationOffer{}, false, nil
	}
	if err != nil {
		return privateCARotationOffer{}, false, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 16<<10 {
		return privateCARotationOffer{}, false, fmt.Errorf("private CA rotation file is unsafe")
	}
	value, err := readBoundedFile(path, 16<<10)
	if err != nil {
		return privateCARotationOffer{}, false, err
	}
	var offer privateCARotationOffer
	if err := decodeStrictJSON(value, &offer); err != nil {
		return privateCARotationOffer{}, false, err
	}
	return offer, true, nil
}

func writePrivateCARotationOffer(path string, offer privateCARotationOffer, mode fs.FileMode) error {
	value, err := json.MarshalIndent(offer, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(path, append(value, '\n'), mode)
}

func (controller *Controller) reloadCaddy(
	ctx context.Context,
	installation Installation,
	environment map[string]string,
) error {
	if _, err := controller.runCompose(ctx, installation, environment,
		"exec", "-T", "caddy", "caddy", "reload",
		"--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"); err != nil {
		return err
	}
	_, err := controller.runCompose(ctx, installation, environment,
		"up", "-d", "--wait", "--wait-timeout", "180", "caddy")
	return err
}

func (controller *Controller) PreparePrivateCARotation(
	ctx context.Context,
	raw PrivateCARotationOptions,
) error {
	installation, err := openInstallation(raw.DataRoot)
	if err != nil {
		return err
	}
	if err := validatePrivateRotationInstallation(installation); err != nil {
		return err
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := controller.verifyInstalledRelease(installation); err != nil {
		return err
	}
	overlap := raw.Overlap
	if overlap == 0 {
		overlap = defaultPrivateCAOverlap
	}
	if overlap < minimumPrivateCAOverlap || overlap > maximumPrivateCAOverlap {
		return actionError("PRIVATE_ROTATION_OVERLAP_INVALID", "private CA overlap must be from 1 hour through 30 days", "Use a bounded duration such as 24h.", nil)
	}
	now := controller.dependencies.Now().UTC()
	if _, found, journalErr := loadPrivateCARotationOffer(
		installation.RotationJournalPath, installation.Manifest, now,
	); journalErr != nil || found {
		return actionError("PRIVATE_ROTATION_IN_PROGRESS", "a private CA activation journal already exists", "Retry convenewirectl trust-rotation activate before preparing another epoch.", journalErr)
	}
	if offer, found, offerErr := loadPrivateCARotationOffer(
		installation.TrustRotationPath, installation.Manifest, now,
	); offerErr != nil {
		return actionError("PRIVATE_ROTATION_INVALID", "the existing private CA rotation offer is invalid", "Do not overwrite it. Restore the exact controller state or complete explicit recovery.", offerErr)
	} else if found {
		fmt.Fprintf(controller.dependencies.Output,
			"Private CA epoch %d is already staged through %s (CA %s).\n",
			offer.NextTrust.TrustEpoch, offer.OverlapEndsAt,
			redactedDigest(offer.NextTrust.CACertificateSHA256),
		)
		return nil
	}
	currentID := activePrivateCAID(installation.Manifest)
	nextID := privateCAID(installation.Manifest.InstallationID, installation.Manifest.TrustEpoch+1)
	if err := writePrivateCaddyProfiles(installation, currentID, nextID); err != nil {
		return actionError("PRIVATE_ROTATION_CONFIG_FAILED", "could not stage the two-authority Caddy profile", "Repair trust-directory permissions and retry before activating any new CA.", err)
	}
	environment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	if err := controller.reloadCaddy(ctx, installation, environment); err != nil {
		return actionError("PRIVATE_ROTATION_CA_FAILED", "Caddy did not provision the next private CA", "The current authority remains first and the operation is safe to retry after inspecting Caddy.", err)
	}
	certificate, _, digest, err := loadSingleCACertificate(
		privateCARootPath(installation.Manifest, nextID), now,
	)
	if err != nil {
		return actionError("PRIVATE_ROTATION_CA_FAILED", "the next Caddy authority did not expose one valid public root", "Inspect Caddy logs and retry; do not create or install a CA manually.", err)
	}
	offer := privateCARotationOffer{
		SchemaVersion: 1, CurrentTrustEpoch: installation.Manifest.TrustEpoch,
		NextTrust: privateCARotationNextTrust{
			Mode: "private_scoped_ca", Origin: installation.Manifest.PublicOrigin,
			InstallationID:      installation.Manifest.InstallationID,
			TrustEpoch:          installation.Manifest.TrustEpoch + 1,
			CACertificateSHA256: digest,
		},
		CACertificatePEM: string(pem.EncodeToMemory(&pem.Block{
			Type: "CERTIFICATE", Bytes: certificate.Raw,
		})),
		OverlapEndsAt: now.Add(overlap).Format(time.RFC3339Nano),
	}
	if err := writePrivateCARotationOffer(installation.TrustRotationPath, offer, 0o644); err != nil {
		return actionError("PRIVATE_ROTATION_OFFER_FAILED", "could not atomically publish the authenticated next-CA offer", "The current CA remains active. Repair trust-directory permissions and retry.", err)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Staged private CA epoch %d through %s (CA %s).\nNext: keep Bridges online, then run convenewirectl trust-rotation activate after every eligible Device acknowledges.\n",
		offer.NextTrust.TrustEpoch, offer.OverlapEndsAt, redactedDigest(digest),
	)
	return nil
}

const privateCARotationAcknowledgementScript = `
const Database = require("better-sqlite3");
const database = new Database(process.env.CONVENE_WIRE_DATABASE_PATH || "/data/agent-room.sqlite", { readonly: true });
const installationId = process.argv[1];
const currentEpoch = Number(process.argv[2]);
const nextEpoch = Number(process.argv[3]);
const row = database.prepare(` + "`" + `
  WITH eligible(device_id) AS (
    SELECT d.device_id
    FROM devices d
    WHERE d.status = 'active' AND EXISTS (
      SELECT 1 FROM device_pairing_sessions s
      WHERE s.device_id = d.device_id AND s.state = 'consumed'
        AND s.trust_mode = 'private_scoped_ca'
        AND s.pairing_session_id = (
          SELECT latest.pairing_session_id
          FROM device_pairing_sessions latest
          WHERE latest.device_id = d.device_id AND latest.state = 'consumed'
            AND latest.trust_mode = 'private_scoped_ca'
          ORDER BY latest.consumed_at DESC
          LIMIT 1
        )
        AND s.trust_installation_id = ? AND s.trust_epoch <= ?
        AND (
          s.trust_epoch = ? OR EXISTS (
            SELECT 1 FROM device_private_ca_rotation_acknowledgements prior
            WHERE prior.device_id = d.device_id
              AND prior.installation_id = ?
              AND prior.accepted_next_trust_epoch = ?
          )
        )
    )
  )
  SELECT COUNT(*) AS eligible,
    COALESCE(SUM(CASE WHEN acknowledged.device_id IS NULL THEN 0 ELSE 1 END), 0) AS acknowledged
  FROM eligible
  LEFT JOIN device_private_ca_rotation_acknowledgements acknowledged
    ON acknowledged.device_id = eligible.device_id
    AND acknowledged.installation_id = ?
    AND acknowledged.accepted_next_trust_epoch = ?
` + "`" + `).get(installationId, currentEpoch, currentEpoch, installationId, currentEpoch, installationId, nextEpoch);
process.stdout.write(JSON.stringify(row));
`

func (controller *Controller) privateCARotationAcknowledgements(
	ctx context.Context,
	installation Installation,
	offer privateCARotationOffer,
) (privateCARotationAcknowledgements, error) {
	environment, err := installationEnvironment(installation)
	if err != nil {
		return privateCARotationAcknowledgements{}, err
	}
	output, err := controller.runCompose(ctx, installation, environment,
		"exec", "-T", "agentroom", "node", "-e",
		privateCARotationAcknowledgementScript,
		offer.NextTrust.InstallationID,
		fmt.Sprint(offer.CurrentTrustEpoch),
		fmt.Sprint(offer.NextTrust.TrustEpoch),
	)
	if err != nil {
		return privateCARotationAcknowledgements{}, err
	}
	var status privateCARotationAcknowledgements
	if err := decodeStrictJSON([]byte(strings.TrimSpace(output)), &status); err != nil ||
		status.Eligible < 0 || status.Acknowledged < 0 || status.Acknowledged > status.Eligible {
		return privateCARotationAcknowledgements{}, fmt.Errorf("rotation acknowledgement status is invalid")
	}
	return status, nil
}

func (controller *Controller) ActivatePrivateCARotation(ctx context.Context, dataRoot string) error {
	installation, err := openInstallation(dataRoot)
	if err != nil {
		return err
	}
	if err := validatePrivateRotationInstallation(installation); err != nil {
		return err
	}
	if err := controller.validateHost(ctx); err != nil {
		return err
	}
	if err := controller.verifyInstalledRelease(installation); err != nil {
		return err
	}
	now := controller.dependencies.Now().UTC()
	completed, completedFound, completedErr := readPrivateCARotationOffer(
		installation.RotationJournalPath,
	)
	if completedErr != nil {
		return actionError("PRIVATE_ROTATION_INVALID", "the private CA activation journal is invalid", "Preserve the journal and restore the exact controller state before retrying.", completedErr)
	}
	if completedFound && completed.NextTrust.Mode == "private_scoped_ca" &&
		completed.NextTrust.Origin == installation.Manifest.PublicOrigin &&
		completed.NextTrust.InstallationID == installation.Manifest.InstallationID &&
		completed.NextTrust.TrustEpoch == installation.Manifest.TrustEpoch &&
		completed.NextTrust.CACertificateSHA256 == installation.Manifest.CACertificateSHA256 &&
		activePrivateCAID(installation.Manifest) == privateCAID(
			installation.Manifest.InstallationID, installation.Manifest.TrustEpoch,
		) {
		readiness := ReadinessInput{
			PublicOrigin:     installation.Manifest.PublicOrigin,
			LocalCARoot:      privateCARootPath(installation.Manifest, activePrivateCAID(installation.Manifest)),
			TLSProfile:       "private_scoped_ca",
			ExpectedCADigest: installation.Manifest.CACertificateSHA256,
			Timeout:          30 * time.Second,
		}
		if err := controller.dependencies.CheckReadiness(ctx, readiness); err != nil {
			return actionError("PRIVATE_ROTATION_CLEANUP_FAILED", "the committed private CA did not pass readiness while cleaning its journal", "Preserve the activation journal and restore HTTPS readiness before retrying.", err)
		}
		if err := os.Remove(installation.TrustRotationPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return actionError("PRIVATE_ROTATION_CLEANUP_FAILED", "the completed private CA offer could not be retired", "Repair trust-directory permissions and retry activation.", err)
		}
		if err := os.Remove(installation.RotationJournalPath); err != nil {
			return actionError("PRIVATE_ROTATION_CLEANUP_FAILED", "the completed private CA journal could not be retired", "Repair control-directory permissions and retry activation.", err)
		}
		fmt.Fprintf(controller.dependencies.Output,
			"Private CA epoch %d was already activated; completed recovery-journal cleanup.\n",
			installation.Manifest.TrustEpoch,
		)
		return nil
	}
	offer, journalFound, journalErr := loadPrivateCARotationOffer(
		installation.RotationJournalPath, installation.Manifest, now,
	)
	if journalErr != nil {
		return actionError("PRIVATE_ROTATION_INVALID", "the private CA activation journal is invalid", "Preserve the journal and restore the exact controller state before retrying.", journalErr)
	}
	if !journalFound {
		var found bool
		offer, found, err = loadPrivateCARotationOffer(
			installation.TrustRotationPath, installation.Manifest, now,
		)
		if err != nil || !found {
			return actionError("PRIVATE_ROTATION_NOT_PREPARED", "no valid private CA rotation offer is staged", "Run convenewirectl trust-rotation prepare first and keep the old CA available through activation.", err)
		}
		acknowledgements, ackErr := controller.privateCARotationAcknowledgements(ctx, installation, offer)
		if ackErr != nil {
			return actionError("PRIVATE_ROTATION_ACK_CHECK_FAILED", "could not inspect Device rotation acknowledgements", "Keep the current CA active, ensure Server is healthy, and retry.", ackErr)
		}
		if acknowledgements.Acknowledged != acknowledgements.Eligible {
			return actionError(
				"PRIVATE_ROTATION_ACK_PENDING",
				fmt.Sprintf("%d of %d eligible Devices acknowledged the next CA", acknowledgements.Acknowledged, acknowledgements.Eligible),
				"Keep eligible Bridges online or explicitly revoke retired Devices, then retry before the overlap expires.",
				nil,
			)
		}
		if err := writePrivateCARotationOffer(installation.RotationJournalPath, offer, 0o600); err != nil {
			return actionError("PRIVATE_ROTATION_JOURNAL_FAILED", "could not establish the activation recovery journal", "Repair control-directory permissions; the current CA remains active.", err)
		}
	}
	nextID := privateCAID(installation.Manifest.InstallationID, offer.NextTrust.TrustEpoch)
	currentID := activePrivateCAID(installation.Manifest)
	environment, err := installationEnvironment(installation)
	if err != nil {
		return err
	}
	if err := writePrivateCaddyProfiles(installation, nextID); err != nil {
		return actionError("PRIVATE_ROTATION_CONFIG_FAILED", "could not select the acknowledged next Caddy authority", "The activation journal preserves the exact candidate for retry.", err)
	}
	rollback := func(cause error) error {
		profileErr := writePrivateCaddyProfiles(installation, currentID, nextID)
		restartErr := error(nil)
		if profileErr == nil {
			restartErr = controller.reloadCaddy(ctx, installation, environment)
		}
		if profileErr != nil || restartErr != nil {
			return actionError("PRIVATE_ROTATION_ROLLBACK_FAILED", "the next CA failed and Caddy rollback did not converge", "Preserve the activation journal and Caddy data; restore the current-first overlap profile before retrying.", errors.Join(cause, profileErr, restartErr))
		}
		_ = os.Remove(installation.RotationJournalPath)
		return actionError("PRIVATE_ROTATION_READINESS_FAILED", "the acknowledged next CA failed HTTPS readiness and the current CA was restored", "Inspect Caddy and origin routing, then retry activation before the overlap expires.", cause)
	}
	if err := controller.reloadCaddy(ctx, installation, environment); err != nil {
		return rollback(err)
	}
	readiness := ReadinessInput{
		PublicOrigin: installation.Manifest.PublicOrigin,
		LocalCARoot:  privateCARootPath(installation.Manifest, nextID),
		TLSProfile:   "private_scoped_ca", ExpectedCADigest: offer.NextTrust.CACertificateSHA256,
		Timeout: defaultReadyTimeout,
	}
	if err := controller.dependencies.CheckReadiness(ctx, readiness); err != nil {
		return rollback(err)
	}
	if err := os.Remove(installation.TrustRotationPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return actionError("PRIVATE_ROTATION_COMMIT_FAILED", "the next CA is serving but the old live offer could not be retired", "Preserve the activation journal and repair trust-directory permissions before retrying.", err)
	}
	candidate := installation.Manifest
	candidate.TrustEpoch = offer.NextTrust.TrustEpoch
	candidate.CACertificateSHA256 = offer.NextTrust.CACertificateSHA256
	candidate.PrivateCAID = nextID
	candidate.LastSuccessfulStep = "ready"
	candidate.UpdatedAt = controller.dependencies.Now().UTC().Format(time.RFC3339Nano)
	if _, err := publishPrivateTrust(installation, candidate, controller.dependencies.Now()); err != nil {
		return actionError("PRIVATE_ROTATION_COMMIT_FAILED", "the next CA is serving but its public trust artifacts could not be committed", "Preserve the activation journal and repair trust-directory permissions before retrying.", err)
	}
	if err := saveManifest(installation.ManifestPath, candidate); err != nil {
		return actionError("PRIVATE_ROTATION_COMMIT_FAILED", "the next CA is serving but the manifest could not be committed", "Preserve the activation journal and repair control-directory permissions before retrying.", err)
	}
	if err := os.Remove(installation.RotationJournalPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return actionError("PRIVATE_ROTATION_CLEANUP_FAILED", "private CA activation completed but its recovery journal remains", "Retry activation to verify and remove only the completed journal.", err)
	}
	fmt.Fprintf(controller.dependencies.Output,
		"Activated private CA epoch %d (CA %s); the old authority is no longer served or published.\n",
		candidate.TrustEpoch, redactedDigest(candidate.CACertificateSHA256),
	)
	return nil
}
