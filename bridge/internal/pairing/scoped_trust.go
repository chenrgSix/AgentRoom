package pairing

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
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
)

const (
	maxScopedCAPEMBytes = 8 << 10
	privateCAPath       = "/.well-known/agentroom/bridge-ca.pem"
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
	CACertificatePEM string `json:"caCertificatePem"`
}

func (trust ScopedPrivateTrust) validate(expectedOrigin string, now time.Time) (*x509.Certificate, error) {
	if trust.Mode != "private_scoped_ca" || !installationIDPattern.MatchString(trust.InstallationID) ||
		trust.TrustEpoch < 1 || trust.TrustEpoch > 2_147_483_647 ||
		!isLowerHexDigest(trust.CACertificateSHA256) {
		return nil, fmt.Errorf("scoped private trust descriptor is invalid")
	}
	origin, err := exactHTTPSOrigin(trust.Origin)
	if err != nil || origin != expectedOrigin {
		return nil, fmt.Errorf("scoped private trust origin does not match the configured Server")
	}
	certificate, err := parseSingleCA([]byte(trust.CACertificatePEM), now)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(certificate.Raw)
	expected, err := hex.DecodeString(trust.CACertificateSHA256)
	if err != nil || subtle.ConstantTimeCompare(digest[:], expected) != 1 {
		return nil, fmt.Errorf("scoped private CA digest mismatch")
	}
	return certificate, nil
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

func newScopedHTTPClient(
	expectedOrigin string,
	trust ScopedPrivateTrust,
	now time.Time,
) (*http.Client, error) {
	origin, err := exactHTTPSOrigin(expectedOrigin)
	if err != nil {
		return nil, err
	}
	certificate, err := trust.validate(origin, now)
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	roots.AddCert(certificate)
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
