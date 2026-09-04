package console

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"regexp"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/pairing"
)

func browserTrustCredential(t *testing.T, isCA bool) (pairing.Credential, []byte) {
	t.Helper()
	now := time.Now().UTC()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(42),
		Subject:               pkix.Name{CommonName: "ConveneWire private browser test CA"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(time.Hour),
		IsCA:                  isCA,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
	}
	if isCA {
		template.KeyUsage |= x509.KeyUsageCertSign
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(der)
	const origin = "https://central.example"
	return pairing.Credential{
		ServerURL: origin,
		DeviceID:  "device_private_browser_test",
		TeamID:    "team_private_browser_test",
		Token:     "device-secret-must-not-project",
		ScopedPrivateTrust: &pairing.ScopedPrivateTrust{
			ScopedPrivateTrustDescriptor: pairing.ScopedPrivateTrustDescriptor{
				Mode:                "private_scoped_ca",
				Origin:              origin,
				InstallationID:      "install_1234567890abcdef",
				TrustEpoch:          2,
				CACertificateSHA256: hex.EncodeToString(digest[:]),
			},
			CACertificatePEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		},
	}, der
}

func TestBrowserTrustSetupUsesExactValidatedPublicCA(t *testing.T) {
	credential, der := browserTrustCredential(t, true)
	view := browserTrustSetupView(credential, time.Now())
	if view == nil {
		t.Fatal("valid private trust did not project a browser setup")
	}
	digest := sha256.Sum256(der)
	if view.CACertificateSHA256 != hex.EncodeToString(digest[:]) {
		t.Fatalf("unexpected projected digest %q", view.CACertificateSHA256)
	}
	encodedMatch := regexp.MustCompile(`FromBase64String\('([^']+)'\)`).FindStringSubmatch(view.WindowsPowerShellCommand)
	if len(encodedMatch) != 2 {
		t.Fatal("install command did not contain one embedded certificate")
	}
	decoded, err := base64.StdEncoding.DecodeString(encodedMatch[1])
	if err != nil || string(decoded) != string(der) {
		t.Fatal("install command certificate does not match retained DER bytes")
	}
	for _, required := range []string{
		"SHA256", "Get-FileHash", "-user -f -addstore Root", "$LASTEXITCODE",
		"[Guid]::NewGuid()", "finally", "Remove-Item -LiteralPath $tmp",
		"[Environment]::SystemDirectory",
	} {
		if !strings.Contains(view.WindowsPowerShellCommand, required) {
			t.Fatalf("install command omitted safety boundary %q", required)
		}
	}
	for _, required := range []string{"-user -delstore Root", "$LASTEXITCODE", "SystemDirectory"} {
		if !strings.Contains(view.WindowsRemovalPowerShellCommand, required) {
			t.Fatalf("removal command omitted safety boundary %q", required)
		}
	}
	for _, prohibited := range []string{
		credential.Token, credential.DeviceID, credential.TeamID, credential.ServerURL,
		"clientEntry", "room_", "repository", "BEGIN PRIVATE KEY",
	} {
		if strings.Contains(view.WindowsPowerShellCommand, prohibited) ||
			strings.Contains(view.WindowsRemovalPowerShellCommand, prohibited) {
			t.Fatalf("browser trust projection exposed prohibited value %q", prohibited)
		}
	}
}

func TestBrowserTrustSetupFailsClosedForInvalidTrust(t *testing.T) {
	valid, _ := browserTrustCredential(t, true)
	nonCA, _ := browserTrustCredential(t, false)
	badPEM := valid
	badPEMTrust := *valid.ScopedPrivateTrust
	badPEMTrust.CACertificatePEM = "not-a-certificate"
	badPEM.ScopedPrivateTrust = &badPEMTrust
	badDigest := valid
	badDigestTrust := *valid.ScopedPrivateTrust
	badDigestTrust.CACertificateSHA256 = strings.Repeat("a", 64)
	badDigest.ScopedPrivateTrust = &badDigestTrust
	wrongOrigin := valid
	wrongOrigin.ServerURL = "https://other.example"

	for name, credential := range map[string]pairing.Credential{
		"public or absent": {},
		"malformed PEM":    badPEM,
		"digest mismatch":  badDigest,
		"non CA":           nonCA,
		"origin mismatch":  wrongOrigin,
	} {
		t.Run(name, func(t *testing.T) {
			if view := browserTrustSetupView(credential, time.Now()); view != nil {
				t.Fatalf("invalid credential exposed browser trust setup: %#v", view)
			}
		})
	}
}
