package pairing

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	pairingcontracts "convenewire.dev/contracts/generated/go/pairing"
)

type privateTLSServer struct {
	Server        *httptest.Server
	CAPEM         []byte
	CACertificate *x509.Certificate
	Digest        string
}

func newPrivateTLSServer(t *testing.T, handler http.Handler) privateTLSServer {
	t.Helper()
	now := time.Now().UTC()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ConveneWire test CA"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCertificate, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "127.0.0.1"},
		NotBefore: now.Add(-time.Hour), NotAfter: now.Add(12 * time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:    []string{"localhost"},
	}
	leafDER, err := x509.CreateCertificate(
		rand.Reader, leafTemplate, caCertificate, &leafKey.PublicKey, caKey,
	)
	if err != nil {
		t.Fatal(err)
	}
	leafKeyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: leafKeyDER}),
	)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{certificate},
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	digest := sha256.Sum256(caDER)
	return privateTLSServer{
		Server:        server,
		CAPEM:         pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		CACertificate: caCertificate,
		Digest:        hex.EncodeToString(digest[:]),
	}
}

func TestScopedPrivateTrustRotationStagesAcknowledgesAndPromotesAfterNewChain(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	next := newPrivateTLSServer(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	var caPEM []byte
	var offer pairingcontracts.DevicePairingPrivateCARotationOffer
	var acknowledgementBodies [][]byte
	ackAttempts := 0
	offerAvailable := true
	current := newPrivateTLSServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "Bearer device-secret" {
			t.Errorf("rotation request omitted the Device credential")
		}
		switch request.URL.Path {
		case privateCAPath:
			response.Header().Set("content-type", "application/x-pem-file")
			_, _ = response.Write(caPEM)
		case "/api/health/ready":
			response.WriteHeader(http.StatusOK)
		case "/api/bridge/private-ca-rotation":
			if !offerAvailable {
				response.WriteHeader(http.StatusNoContent)
				return
			}
			response.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(response).Encode(offer)
		case "/api/bridge/private-ca-rotation/acknowledge":
			body, _ := io.ReadAll(request.Body)
			acknowledgementBodies = append(acknowledgementBodies, body)
			ackAttempts++
			if ackAttempts == 1 {
				panic(http.ErrAbortHandler)
			}
			response.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(response, request)
		}
	}))
	caPEM = current.CAPEM
	currentTrust := ScopedPrivateTrust{
		ScopedPrivateTrustDescriptor: ScopedPrivateTrustDescriptor{
			Mode: "private_scoped_ca", Origin: current.Server.URL,
			InstallationID: "install_0123456789abcdefghijklmn",
			TrustEpoch:     1, CACertificateSHA256: current.Digest,
		},
		CACertificatePEM: string(current.CAPEM),
	}
	offer = pairingcontracts.DevicePairingPrivateCARotationOffer{
		CurrentTrustEpoch: 1,
		NextTrust: pairingcontracts.NextTrustClass{
			Mode: pairingcontracts.PrivateScopedCA, Origin: current.Server.URL,
			InstallationID: currentTrust.InstallationID,
			TrustEpoch:     2, CACertificateSha256: next.Digest,
		},
		CACertificatePem: string(next.CAPEM),
		OverlapEndsAt:    now.Add(time.Hour),
	}
	directory := t.TempDir()
	credential := Credential{
		ServerURL: current.Server.URL, DeviceID: "device_private", TeamID: "team_private",
		OwnerMemberID: "member_private", Token: "device-secret",
		ScopedPrivateTrust: &currentTrust,
	}
	if err := Save(directory, credential); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{ServerURL: current.Server.URL, DataDir: directory}
	_, changed, err := SyncScopedPrivateTrustRotation(context.Background(), cfg, credential, now)
	if !changed || err == nil || !strings.Contains(err.Error(), "acknowledge") {
		t.Fatalf("lost acknowledgement response did not preserve staged state: changed=%v err=%v", changed, err)
	}
	staged, err := Load(directory)
	if err != nil || staged.ScopedPrivateTrust.Rotation == nil ||
		staged.ScopedPrivateTrust.Rotation.Acknowledged {
		t.Fatalf("next CA was not staged before acknowledgement: %#v %v", staged, err)
	}
	operationID := staged.ScopedPrivateTrust.Rotation.AcknowledgeOperationID
	acknowledged, changed, err := SyncScopedPrivateTrustRotation(
		context.Background(), cfg, staged, now,
	)
	if err != nil || !changed || !acknowledged.ScopedPrivateTrust.Rotation.Acknowledged {
		t.Fatalf("rotation acknowledgement did not converge: %#v changed=%v err=%v", acknowledged, changed, err)
	}
	if len(acknowledgementBodies) != 2 ||
		!bytes.Equal(acknowledgementBodies[0], acknowledgementBodies[1]) ||
		!bytes.Contains(acknowledgementBodies[1], []byte(operationID)) {
		t.Fatalf("rotation acknowledgement did not reuse its proof: %q", acknowledgementBodies)
	}

	offerAvailable = false
	if _, changed, err := SyncScopedPrivateTrustRotation(
		context.Background(), cfg, acknowledged, now,
	); changed || err == nil || !strings.Contains(err.Error(), "disappeared") {
		t.Fatalf("lost overlap did not fail closed: changed=%v err=%v", changed, err)
	}
	promoted, err := promoteScopedPrivateTrustIfServed(
		directory,
		acknowledged,
		&tls.ConnectionState{VerifiedChains: [][]*x509.Certificate{{next.CACertificate}}},
	)
	if err != nil || !promoted {
		t.Fatalf("new verified chain did not promote trust: promoted=%v err=%v", promoted, err)
	}
	loaded, err := Load(directory)
	if err != nil || loaded.ScopedPrivateTrust.TrustEpoch != 2 ||
		loaded.ScopedPrivateTrust.Rotation != nil ||
		loaded.ScopedPrivateTrust.CACertificateSHA256 != next.Digest {
		t.Fatalf("old CA was not retired after new-chain success: %#v %v", loaded, err)
	}
}

func TestBootstrapScopedPrivateTrustSendsNoSecretAndScopesEveryRequest(t *testing.T) {
	var caPEM []byte
	var bootstrapRequests atomic.Int32
	server := newPrivateTLSServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "" ||
			request.Header.Get(config.ServerTokenHeader) != "" ||
			request.Header.Get("cookie") != "" {
			t.Errorf("bootstrap or health request carried a credential")
		}
		switch request.URL.Path {
		case privateCAPath:
			bootstrapRequests.Add(1)
			response.Header().Set("content-type", "application/x-pem-file")
			_, _ = response.Write(caPEM)
		case "/api/health/ready":
			response.WriteHeader(http.StatusOK)
		default:
			http.NotFound(response, request)
		}
	}))
	caPEM = server.CAPEM
	descriptor := ScopedPrivateTrustDescriptor{
		Mode: "private_scoped_ca", Origin: server.Server.URL,
		InstallationID: "install_0123456789abcdefghijklmn",
		TrustEpoch:     1, CACertificateSHA256: server.Digest,
	}
	trust, err := BootstrapScopedPrivateTrust(context.Background(), descriptor, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if bootstrapRequests.Load() != 1 || trust.CACertificatePEM != string(server.CAPEM) {
		t.Fatalf("unexpected scoped bootstrap result: %#v", trust)
	}
	if _, err := http.DefaultClient.Get(server.Server.URL + "/api/health/ready"); err == nil {
		t.Fatal("bootstrap must not mutate operating-system trust")
	}
	credential := Credential{
		ServerURL: server.Server.URL, DeviceID: "device_private", Token: "device-secret",
		ScopedPrivateTrust: &trust,
	}
	client := HTTPClientForCredential(
		config.Config{ServerURL: server.Server.URL}, credential,
	)
	response, err := client.Get(server.Server.URL + "/api/health/ready")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	otherOrigin := "https://127.0.0.1:1"
	if _, err := client.Get(otherOrigin + "/api/health/ready"); err == nil ||
		!strings.Contains(err.Error(), "outside its exact origin") {
		t.Fatalf("scoped client accepted another origin: %v", err)
	}
	directory := t.TempDir()
	if err := Save(directory, credential); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(directory)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ScopedPrivateTrust == nil || loaded.ScopedPrivateTrust.CACertificateSHA256 != server.Digest {
		t.Fatalf("scoped trust did not survive owner-only persistence: %#v", loaded)
	}
	if info, err := os.Stat(filepath.Join(directory, credentialFilename)); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("credential trust state is not owner-only: %v %v", info, err)
	}
}

func TestBootstrapScopedPrivateTrustRejectsDigestRedirectAndCertificateCount(t *testing.T) {
	tests := []struct {
		name        string
		digest      func(privateTLSServer) string
		serve       func(http.ResponseWriter, *http.Request, []byte)
		expectError string
	}{
		{
			name:   "digest mismatch",
			digest: func(privateTLSServer) string { return strings.Repeat("b", 64) },
			serve: func(response http.ResponseWriter, _ *http.Request, ca []byte) {
				response.Header().Set("content-type", "application/x-pem-file")
				_, _ = response.Write(ca)
			},
			expectError: "digest mismatch",
		},
		{
			name:   "redirect",
			digest: func(server privateTLSServer) string { return server.Digest },
			serve: func(response http.ResponseWriter, request *http.Request, _ []byte) {
				http.Redirect(response, request, "/other", http.StatusFound)
			},
			expectError: "redirects are forbidden",
		},
		{
			name:   "multiple certificates",
			digest: func(server privateTLSServer) string { return server.Digest },
			serve: func(response http.ResponseWriter, _ *http.Request, ca []byte) {
				response.Header().Set("content-type", "application/x-pem-file")
				_, _ = response.Write(append(append([]byte{}, ca...), ca...))
			},
			expectError: "exactly one certificate",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var caPEM []byte
			server := newPrivateTLSServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path == privateCAPath {
					test.serve(response, request, caPEM)
					return
				}
				response.WriteHeader(http.StatusOK)
			}))
			caPEM = server.CAPEM
			descriptor := ScopedPrivateTrustDescriptor{
				Mode: "private_scoped_ca", Origin: server.Server.URL,
				InstallationID: "install_0123456789abcdefghijklmn",
				TrustEpoch:     1, CACertificateSHA256: test.digest(server),
			}
			if _, err := BootstrapScopedPrivateTrust(
				context.Background(), descriptor, time.Now(),
			); err == nil || !strings.Contains(err.Error(), test.expectError) {
				t.Fatalf("expected %q, got %v", test.expectError, err)
			}
		})
	}
}

func TestMigrateScopedPrivateTrustOriginKeepsAuthorityAndSendsNoCredential(t *testing.T) {
	var caPEM []byte
	var credentialSeen atomic.Bool
	server := newPrivateTLSServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("authorization") != "" || request.Header.Get("cookie") != "" ||
			request.Header.Get(config.ServerTokenHeader) != "" {
			credentialSeen.Store(true)
		}
		switch request.URL.Path {
		case privateCAPath:
			response.Header().Set("content-type", "application/x-pem-file")
			_, _ = response.Write(caPEM)
		case "/api/health/ready":
			response.WriteHeader(http.StatusOK)
		default:
			http.NotFound(response, request)
		}
	}))
	caPEM = server.CAPEM
	currentOrigin := server.Server.URL
	targetOrigin := strings.Replace(currentOrigin, "127.0.0.1", "localhost", 1)
	credential := Credential{
		ServerURL: currentOrigin, DeviceID: "device_private", TeamID: "team_private",
		OwnerMemberID: "member_private", Token: "device-secret",
		ScopedPrivateTrust: &ScopedPrivateTrust{
			ScopedPrivateTrustDescriptor: ScopedPrivateTrustDescriptor{
				Mode: "private_scoped_ca", Origin: currentOrigin,
				InstallationID: "install_0123456789abcdefghijklmn",
				TrustEpoch:     3, CACertificateSHA256: server.Digest,
			},
			CACertificatePEM: string(server.CAPEM),
		},
	}
	migrated, err := MigrateScopedPrivateTrustOrigin(
		context.Background(), credential, targetOrigin, time.Now(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if credentialSeen.Load() {
		t.Fatal("origin migration sent a credential before target trust was verified")
	}
	if migrated.ServerURL != targetOrigin || migrated.ScopedPrivateTrust.Origin != targetOrigin ||
		migrated.DeviceID != credential.DeviceID || migrated.TeamID != credential.TeamID ||
		migrated.OwnerMemberID != credential.OwnerMemberID || migrated.Token != credential.Token ||
		migrated.ScopedPrivateTrust.InstallationID != credential.ScopedPrivateTrust.InstallationID ||
		migrated.ScopedPrivateTrust.TrustEpoch != credential.ScopedPrivateTrust.TrustEpoch ||
		migrated.ScopedPrivateTrust.CACertificateSHA256 != server.Digest {
		t.Fatalf("origin migration changed credential authority: %#v", migrated)
	}
}

func TestMigrateScopedPrivateTrustOriginRejectsDifferentCAAndActiveRotation(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	current := newPrivateTLSServer(t, http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusOK)
	}))
	var targetPEM []byte
	target := newPrivateTLSServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == privateCAPath {
			response.Header().Set("content-type", "application/x-pem-file")
			_, _ = response.Write(targetPEM)
			return
		}
		response.WriteHeader(http.StatusOK)
	}))
	targetPEM = target.CAPEM
	trust := ScopedPrivateTrust{
		ScopedPrivateTrustDescriptor: ScopedPrivateTrustDescriptor{
			Mode: "private_scoped_ca", Origin: current.Server.URL,
			InstallationID: "install_0123456789abcdefghijklmn",
			TrustEpoch:     1, CACertificateSHA256: current.Digest,
		},
		CACertificatePEM: string(current.CAPEM),
	}
	credential := Credential{ServerURL: current.Server.URL, Token: "device-secret", ScopedPrivateTrust: &trust}
	if _, err := MigrateScopedPrivateTrustOrigin(
		context.Background(), credential, target.Server.URL, now,
	); err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("different CA was accepted: %v", err)
	}

	rotating := credential
	rotatingTrust := trust
	rotatingTrust.Rotation = &ScopedPrivateTrustRotation{}
	rotating.ScopedPrivateTrust = &rotatingTrust
	if _, err := MigrateScopedPrivateTrustOrigin(
		context.Background(), rotating, target.Server.URL, now,
	); err == nil || !strings.Contains(err.Error(), "active private CA rotation") {
		t.Fatalf("active or malformed rotation was accepted: %v", err)
	}
	if _, err := MigrateScopedPrivateTrustOrigin(
		context.Background(), credential, "http://localhost:40000", now,
	); err == nil || !strings.Contains(err.Error(), "target scoped private origin is invalid") {
		t.Fatalf("non-HTTPS target was accepted: %v", err)
	}
}
