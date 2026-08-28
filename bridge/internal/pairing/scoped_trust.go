package pairing

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/config"
	pairingcontracts "convenewire.dev/contracts/generated/go/pairing"
)

const (
	maxScopedCAPEMBytes = 8 << 10
	privateCAPath       = "/.well-known/convenewire/bridge-ca.pem"
)

var installationIDPattern = regexp.MustCompile(`^install_[A-Za-z0-9_-]{16,128}$`)

type ScopedPrivateTrustDescriptor struct {
	Mode                string `json:"mode"`
	Origin              string `json:"origin"`
	InstallationID      string `json:"installationId"`
	TrustEpoch          int64  `json:"trustEpoch"`
	CACertificateSHA256 string `json:"caCertificateSha256"`
}

type ScopedPrivateTrust struct {
	ScopedPrivateTrustDescriptor
	CACertificatePEM string                      `json:"caCertificatePem"`
	Rotation         *ScopedPrivateTrustRotation `json:"rotation,omitempty"`
}

type ScopedPrivateTrustRotation struct {
	Next                   ScopedPrivateTrust `json:"next"`
	OverlapEndsAt          string             `json:"overlapEndsAt"`
	AcknowledgeOperationID string             `json:"acknowledgeOperationId"`
	Acknowledged           bool               `json:"acknowledged"`
}

func (trust ScopedPrivateTrust) validate(expectedOrigin string, now time.Time) (*x509.Certificate, error) {
	certificate, _, err := trust.certificates(expectedOrigin, now)
	return certificate, err
}

func (trust ScopedPrivateTrust) certificates(
	expectedOrigin string,
	now time.Time,
) (*x509.Certificate, *x509.Certificate, error) {
	if trust.Mode != "private_scoped_ca" || !installationIDPattern.MatchString(trust.InstallationID) ||
		trust.TrustEpoch < 1 || trust.TrustEpoch > 2_147_483_647 ||
		!isLowerHexDigest(trust.CACertificateSHA256) {
		return nil, nil, fmt.Errorf("scoped private trust descriptor is invalid")
	}
	origin, err := exactHTTPSOrigin(trust.Origin)
	if err != nil || origin != expectedOrigin {
		return nil, nil, fmt.Errorf("scoped private trust origin does not match the configured Server")
	}
	certificate, err := parseSingleCA([]byte(trust.CACertificatePEM), now)
	if err != nil {
		return nil, nil, err
	}
	digest := sha256.Sum256(certificate.Raw)
	expected, err := hex.DecodeString(trust.CACertificateSHA256)
	if err != nil || subtle.ConstantTimeCompare(digest[:], expected) != 1 {
		return nil, nil, fmt.Errorf("scoped private CA digest mismatch")
	}
	if trust.Rotation == nil {
		return certificate, nil, nil
	}
	rotation := trust.Rotation
	if rotation.Next.Rotation != nil ||
		rotation.Next.Origin != trust.Origin ||
		rotation.Next.InstallationID != trust.InstallationID ||
		rotation.Next.TrustEpoch != trust.TrustEpoch+1 ||
		rotation.Next.CACertificateSHA256 == trust.CACertificateSHA256 ||
		!pairingSessionOperationIDPattern.MatchString(rotation.AcknowledgeOperationID) {
		return nil, nil, fmt.Errorf("scoped private CA rotation state is invalid")
	}
	overlapEndsAt, err := time.Parse(time.RFC3339, rotation.OverlapEndsAt)
	if err != nil || !now.Before(overlapEndsAt) {
		return nil, nil, fmt.Errorf("scoped private CA rotation overlap is expired")
	}
	nextCertificate, err := rotation.Next.validate(expectedOrigin, now)
	if err != nil {
		return nil, nil, fmt.Errorf("scoped private CA rotation next trust is invalid: %w", err)
	}
	return certificate, nextCertificate, nil
}

func BootstrapScopedPrivateTrust(
	ctx context.Context,
	descriptor ScopedPrivateTrustDescriptor,
	now time.Time,
) (ScopedPrivateTrust, error) {
	origin, err := exactHTTPSOrigin(descriptor.Origin)
	if err != nil || descriptor.Mode != "private_scoped_ca" ||
		!installationIDPattern.MatchString(descriptor.InstallationID) ||
		descriptor.TrustEpoch < 1 || descriptor.TrustEpoch > 2_147_483_647 ||
		!isLowerHexDigest(descriptor.CACertificateSHA256) {
		return ScopedPrivateTrust{}, fmt.Errorf("private pairing trust descriptor is invalid")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: true, // Bootstrap fetch sends no secret and accepts only the out-of-band CA digest below.
	}
	bootstrapClient := &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fmt.Errorf("private CA bootstrap redirects are forbidden")
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+privateCAPath, nil)
	if err != nil {
		return ScopedPrivateTrust{}, fmt.Errorf("create private CA bootstrap request: %w", err)
	}
	request.Header.Set("accept", "application/x-pem-file")
	response, err := bootstrapClient.Do(request)
	if err != nil {
		return ScopedPrivateTrust{}, fmt.Errorf("fetch private CA bootstrap: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return ScopedPrivateTrust{}, fmt.Errorf("private CA bootstrap returned status %d", response.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("content-type"))
	if err != nil || mediaType != "application/x-pem-file" {
		return ScopedPrivateTrust{}, fmt.Errorf("private CA bootstrap content type is invalid")
	}
	if response.ContentLength > maxScopedCAPEMBytes {
		return ScopedPrivateTrust{}, fmt.Errorf("private CA bootstrap exceeds %d bytes", maxScopedCAPEMBytes)
	}
	source, err := io.ReadAll(io.LimitReader(response.Body, maxScopedCAPEMBytes+1))
	if err != nil {
		return ScopedPrivateTrust{}, fmt.Errorf("read private CA bootstrap: %w", err)
	}
	if len(source) > maxScopedCAPEMBytes {
		return ScopedPrivateTrust{}, fmt.Errorf("private CA bootstrap exceeds %d bytes", maxScopedCAPEMBytes)
	}
	certificate, err := parseSingleCA(source, now)
	if err != nil {
		return ScopedPrivateTrust{}, err
	}
	canonicalPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
	staged := ScopedPrivateTrust{
		ScopedPrivateTrustDescriptor: descriptor,
		CACertificatePEM:             string(canonicalPEM),
	}
	if _, err := staged.validate(origin, now); err != nil {
		return ScopedPrivateTrust{}, err
	}
	verifiedClient, err := newScopedHTTPClient(origin, staged, now)
	if err != nil {
		return ScopedPrivateTrust{}, err
	}
	verifiedClient.Timeout = 10 * time.Second
	healthRequest, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/api/health/ready", nil)
	if err != nil {
		return ScopedPrivateTrust{}, fmt.Errorf("create private trust verification request: %w", err)
	}
	healthResponse, err := verifiedClient.Do(healthRequest)
	if err != nil {
		return ScopedPrivateTrust{}, fmt.Errorf("verify private CA chain: %w", err)
	}
	defer healthResponse.Body.Close()
	if healthResponse.StatusCode != http.StatusOK {
		return ScopedPrivateTrust{}, fmt.Errorf("private trust verification returned status %d", healthResponse.StatusCode)
	}
	return staged, nil
}

// MigrateScopedPrivateTrustOrigin verifies a replacement HTTPS origin through
// the already pinned private CA before changing any credential field. It sends
// no Device credential to the candidate and leaves persistence to the caller so
// the credential and owner-authored configuration can be replaced together.
func MigrateScopedPrivateTrustOrigin(
	ctx context.Context,
	credential Credential,
	targetOrigin string,
	now time.Time,
) (Credential, error) {
	current := credential.ScopedPrivateTrust
	if current == nil {
		return Credential{}, fmt.Errorf("scoped private trust is required for origin migration")
	}
	currentOrigin, err := exactHTTPSOrigin(credential.ServerURL)
	if err != nil {
		return Credential{}, fmt.Errorf("current scoped private origin is invalid: %w", err)
	}
	if current.Rotation != nil {
		return Credential{}, fmt.Errorf("finish the active private CA rotation before changing origin")
	}
	if _, err := current.validate(currentOrigin, now); err != nil {
		return Credential{}, fmt.Errorf("current scoped private trust is invalid: %w", err)
	}
	target, err := exactHTTPSOrigin(strings.TrimSpace(targetOrigin))
	if err != nil {
		return Credential{}, fmt.Errorf("target scoped private origin is invalid: %w", err)
	}
	if target == currentOrigin {
		return credential, nil
	}
	descriptor := current.ScopedPrivateTrustDescriptor
	descriptor.Origin = target
	migratedTrust, err := BootstrapScopedPrivateTrust(ctx, descriptor, now)
	if err != nil {
		return Credential{}, fmt.Errorf("verify target scoped private origin: %w", err)
	}
	migrated := credential
	migrated.ServerURL = target
	migrated.ScopedPrivateTrust = &migratedTrust
	if err := validateCredentialTrust(migrated); err != nil {
		return Credential{}, err
	}
	return migrated, nil
}

func newScopedHTTPClient(
	expectedOrigin string,
	trust ScopedPrivateTrust,
	now time.Time,
) (*http.Client, error) {
	origin, err := exactHTTPSOrigin(expectedOrigin)
	if err != nil {
		return nil, err
	}
	certificate, nextCertificate, err := trust.certificates(origin, now)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
	if nextCertificate != nil {
		roots.AddCert(nextCertificate)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    roots,
	}
	return &http.Client{
		Transport: originScopedTransport{origin: origin, base: transport},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return fmt.Errorf("scoped private trust redirects are forbidden")
		},
	}, nil
}

func SyncScopedPrivateTrustRotation(
	ctx context.Context,
	cfg config.Config,
	credential Credential,
	now time.Time,
) (Credential, bool, error) {
	if credential.ScopedPrivateTrust == nil {
		return credential, false, nil
	}
	client, err := newScopedHTTPClient(cfg.ServerURL, *credential.ScopedPrivateTrust, now)
	if err != nil {
		return credential, false, err
	}
	client.Timeout = 10 * time.Second
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		strings.TrimRight(cfg.ServerURL, "/")+"/api/bridge/private-ca-rotation",
		nil,
	)
	if err != nil {
		return credential, false, err
	}
	request.Header.Set("authorization", "Bearer "+credential.Token)
	response, err := client.Do(request)
	if err != nil {
		return credential, false, fmt.Errorf("fetch private CA rotation: %w", err)
	}
	defer response.Body.Close()
	if promoted, promoteErr := promoteScopedPrivateTrustIfServed(
		cfg.DataDir,
		credential,
		response.TLS,
	); promoted || promoteErr != nil {
		return credential, promoted, promoteErr
	}
	if response.StatusCode == http.StatusNoContent {
		if credential.ScopedPrivateTrust.Rotation != nil {
			return credential, false, fmt.Errorf("private CA rotation offer disappeared before the new chain was served")
		}
		return credential, false, nil
	}
	if response.StatusCode == http.StatusNotFound && credential.ScopedPrivateTrust.Rotation == nil {
		// A pin-valid older Central has no rotation endpoint. Once an overlap is
		// staged, the same response is rejected below instead of becoming a
		// downgrade path.
		return credential, false, nil
	}
	if response.StatusCode != http.StatusOK {
		return credential, false, fmt.Errorf("private CA rotation returned status %d", response.StatusCode)
	}
	source, err := io.ReadAll(io.LimitReader(response.Body, 16_385))
	if err != nil {
		return credential, false, fmt.Errorf("read private CA rotation: %w", err)
	}
	if len(source) > 16_384 {
		return credential, false, fmt.Errorf("private CA rotation response is too large")
	}
	var offer pairingcontracts.DevicePairingPrivateCARotationOffer
	if err := decodePairingResponse(source, &offer); err != nil {
		return credential, false, fmt.Errorf("decode private CA rotation: %w", err)
	}
	staged, err := stageScopedPrivateTrustRotation(credential, offer, now)
	if err != nil {
		return credential, false, err
	}
	changed := staged.ScopedPrivateTrust.Rotation != credential.ScopedPrivateTrust.Rotation
	if changed {
		if err := Replace(cfg.DataDir, credential, staged); err != nil {
			return credential, false, fmt.Errorf("stage private CA rotation: %w", err)
		}
		credential = staged
	}
	rotation := credential.ScopedPrivateTrust.Rotation
	if rotation.Acknowledged {
		return credential, changed, nil
	}
	acknowledgement := pairingcontracts.DevicePairingPrivateCARotationAcknowledgeRequest{
		OperationID:               rotation.AcknowledgeOperationID,
		ExpectedCurrentTrustEpoch: credential.ScopedPrivateTrust.TrustEpoch,
		AcceptedNextTrustEpoch:    rotation.Next.TrustEpoch,
		CACertificateSha256:       rotation.Next.CACertificateSHA256,
	}
	body, err := json.Marshal(acknowledgement)
	if err != nil {
		return credential, changed, err
	}
	ackRequest, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		strings.TrimRight(cfg.ServerURL, "/")+"/api/bridge/private-ca-rotation/acknowledge",
		bytes.NewReader(body),
	)
	if err != nil {
		return credential, changed, err
	}
	ackRequest.Header.Set("authorization", "Bearer "+credential.Token)
	ackRequest.Header.Set("content-type", "application/json")
	ackResponse, err := client.Do(ackRequest)
	if err != nil {
		return credential, changed, fmt.Errorf("acknowledge private CA rotation: %w", err)
	}
	ackResponse.Body.Close()
	if ackResponse.StatusCode != http.StatusNoContent {
		return credential, changed, fmt.Errorf("private CA rotation acknowledgement returned status %d", ackResponse.StatusCode)
	}
	acknowledged := credential
	acknowledgedTrust := *credential.ScopedPrivateTrust
	acknowledgedRotation := *acknowledgedTrust.Rotation
	acknowledgedRotation.Acknowledged = true
	acknowledgedTrust.Rotation = &acknowledgedRotation
	acknowledged.ScopedPrivateTrust = &acknowledgedTrust
	if err := Replace(cfg.DataDir, credential, acknowledged); err != nil {
		return credential, true, fmt.Errorf("persist private CA rotation acknowledgement: %w", err)
	}
	return acknowledged, true, nil
}

func stageScopedPrivateTrustRotation(
	credential Credential,
	offer pairingcontracts.DevicePairingPrivateCARotationOffer,
	now time.Time,
) (Credential, error) {
	current := credential.ScopedPrivateTrust
	if current == nil || offer.CurrentTrustEpoch != current.TrustEpoch ||
		offer.NextTrust.Mode != pairingcontracts.PrivateScopedCA ||
		offer.NextTrust.Origin != current.Origin ||
		offer.NextTrust.InstallationID != current.InstallationID ||
		offer.NextTrust.TrustEpoch != current.TrustEpoch+1 ||
		offer.NextTrust.CACertificateSha256 == current.CACertificateSHA256 ||
		!isLowerHexDigest(offer.NextTrust.CACertificateSha256) ||
		!now.Before(offer.OverlapEndsAt) || offer.OverlapEndsAt.After(now.Add(30*24*time.Hour)) {
		return credential, fmt.Errorf("private CA rotation offer does not extend current trust")
	}
	certificate, err := parseSingleCA([]byte(offer.CACertificatePem), now)
	if err != nil {
		return credential, err
	}
	digest := sha256.Sum256(certificate.Raw)
	expected, _ := hex.DecodeString(offer.NextTrust.CACertificateSha256)
	if subtle.ConstantTimeCompare(digest[:], expected) != 1 {
		return credential, fmt.Errorf("private CA rotation certificate digest mismatch")
	}
	next := ScopedPrivateTrust{
		ScopedPrivateTrustDescriptor: ScopedPrivateTrustDescriptor{
			Mode: string(offer.NextTrust.Mode), Origin: offer.NextTrust.Origin,
			InstallationID:      offer.NextTrust.InstallationID,
			TrustEpoch:          offer.NextTrust.TrustEpoch,
			CACertificateSHA256: offer.NextTrust.CACertificateSha256,
		},
		CACertificatePEM: string(pem.EncodeToMemory(&pem.Block{
			Type: "CERTIFICATE", Bytes: certificate.Raw,
		})),
	}
	if current.Rotation != nil {
		if current.Rotation.Next.CACertificateSHA256 != next.CACertificateSHA256 ||
			current.Rotation.OverlapEndsAt != offer.OverlapEndsAt.Format(time.RFC3339) {
			return credential, fmt.Errorf("private CA rotation offer changed during overlap")
		}
		return credential, nil
	}
	operationID, err := randomPairingID("op")
	if err != nil {
		return credential, err
	}
	updated := credential
	updatedTrust := *current
	updatedTrust.Rotation = &ScopedPrivateTrustRotation{
		Next: next, OverlapEndsAt: offer.OverlapEndsAt.Format(time.RFC3339),
		AcknowledgeOperationID: operationID,
	}
	updated.ScopedPrivateTrust = &updatedTrust
	if _, _, err := updatedTrust.certificates(current.Origin, now); err != nil {
		return credential, err
	}
	return updated, nil
}

func promoteScopedPrivateTrustIfServed(
	dataDir string,
	credential Credential,
	state *tls.ConnectionState,
) (bool, error) {
	trust := credential.ScopedPrivateTrust
	if trust == nil || trust.Rotation == nil || state == nil {
		return false, nil
	}
	servedDigest := ""
	for _, chain := range state.VerifiedChains {
		if len(chain) == 0 {
			continue
		}
		digest := sha256.Sum256(chain[len(chain)-1].Raw)
		candidate := hex.EncodeToString(digest[:])
		if candidate == trust.Rotation.Next.CACertificateSHA256 {
			servedDigest = candidate
			break
		}
	}
	if servedDigest == "" {
		return false, nil
	}
	if !trust.Rotation.Acknowledged {
		return false, fmt.Errorf("private CA switched before the staged trust was acknowledged")
	}
	promoted := credential
	next := trust.Rotation.Next
	next.Rotation = nil
	promoted.ScopedPrivateTrust = &next
	if err := Replace(dataDir, credential, promoted); err != nil {
		return false, fmt.Errorf("promote private CA rotation: %w", err)
	}
	return true, nil
}

type originScopedTransport struct {
	origin string
	base   http.RoundTripper
}

func (transport originScopedTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	origin, err := requestOrigin(request.URL)
	if err != nil || origin != transport.origin {
		return nil, fmt.Errorf("scoped private trust rejected a request outside its exact origin")
	}
	return transport.base.RoundTrip(request)
}

type errorTransport struct{ err error }

func (transport errorTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, transport.err
}

func parseSingleCA(source []byte, now time.Time) (*x509.Certificate, error) {
	block, remainder := pem.Decode(source)
	if block == nil || block.Type != "CERTIFICATE" || len(block.Headers) != 0 ||
		len(bytes.TrimSpace(remainder)) != 0 {
		return nil, fmt.Errorf("private CA bootstrap must contain exactly one certificate")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse private CA bootstrap: %w", err)
	}
	if !certificate.BasicConstraintsValid || !certificate.IsCA ||
		certificate.KeyUsage&x509.KeyUsageCertSign == 0 {
		return nil, fmt.Errorf("private CA bootstrap is not a constrained signing CA")
	}
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) {
		return nil, fmt.Errorf("private CA bootstrap is outside its validity window")
	}
	return certificate, nil
}

func exactHTTPSOrigin(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.String() != value {
		return "", fmt.Errorf("origin must be one exact HTTPS origin")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func requestOrigin(value *url.URL) (string, error) {
	scheme := strings.ToLower(value.Scheme)
	if scheme == "wss" {
		scheme = "https"
	}
	if scheme != "https" || value.Host == "" || value.User != nil {
		return "", fmt.Errorf("request origin is invalid")
	}
	return scheme + "://" + value.Host, nil
}

func isLowerHexDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, character := range value {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}

func canonicalTrustEpoch(value string) (int64, error) {
	if value == "" || (len(value) > 1 && value[0] == '0') {
		return 0, fmt.Errorf("trust epoch is invalid")
	}
	epoch, err := strconv.ParseInt(value, 10, 32)
	if err != nil || epoch < 1 {
		return 0, fmt.Errorf("trust epoch is invalid")
	}
	return epoch, nil
}
