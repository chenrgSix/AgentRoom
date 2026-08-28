package pairing

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
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

	"agentroom.dev/bridge/internal/config"
)

type privateTLSServer struct {
	Server *httptest.Server
	CAPEM  []byte
	Digest string
}

func newPrivateTLSServer(t *testing.T, handler http.Handler) privateTLSServer {
	t.Helper()
	now := time.Now().UTC()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "AgentRoom test CA"},
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
		Server: server,
		CAPEM:  pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		Digest: hex.EncodeToString(digest[:]),
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
