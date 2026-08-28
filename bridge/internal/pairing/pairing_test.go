package pairing

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"convenewire.dev/bridge/internal/config"
)

func TestHTTPClientUsesSystemRootsOrExplicitPin(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	systemCA := config.Config{ServerURL: server.URL, ServerTrustMode: config.TrustSystemCA}
	if _, err := HTTPClient(systemCA).Get(server.URL); err == nil {
		t.Fatal("system_ca must reject the test server's untrusted certificate")
	}
	fingerprint := sha256.Sum256(server.Certificate().Raw)
	pinned := config.Config{
		ServerURL: server.URL, ServerTrustMode: config.TrustPinnedSHA256,
		ServerCertificateSHA256: hex.EncodeToString(fingerprint[:]),
	}
	response, err := HTTPClient(pinned).Get(server.URL)
	if err != nil {
		t.Fatalf("matching explicit pin should be accepted: %v", err)
	}
	response.Body.Close()
	wrong := pinned
	wrong.ServerCertificateSHA256 = string(make([]byte, 64))
	if _, err := HTTPClient(wrong).Get(server.URL); err == nil {
		t.Fatal("wrong explicit pin must be rejected")
	}
}

func TestExchangeStoresCredentialWithOwnerOnlyPermissions(t *testing.T) {
	serverToken := "central-server-token-12345678901234567890"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/bridge/pair" {
			http.NotFound(response, request)
			return
		}
		if request.Header.Get(config.ServerTokenHeader) != serverToken {
			http.Error(response, "missing central Server Token", http.StatusUnauthorized)
			return
		}
		response.Header().Set("content-type", "application/json")
		json.NewEncoder(response).Encode(map[string]any{
			"device": map[string]string{
				"deviceId": "device_test", "teamId": "team_test", "ownerMemberId": "member_test",
			},
			"credential": map[string]any{"token": "secret-token", "expiresAt": nil},
		})
	}))
	defer server.Close()
	directory := t.TempDir()
	cfg := config.Config{ServerURL: server.URL, ServerToken: serverToken, DeviceName: "Alice Mac", DataDir: directory}
	credential, err := Exchange(context.Background(), cfg, "one-time-code")
	if err != nil {
		t.Fatal(err)
	}
	if credential.DeviceID != "device_test" {
		t.Fatalf("unexpected device ID %q", credential.DeviceID)
	}
	info, err := os.Stat(filepath.Join(directory, credentialFilename))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("credential permissions are %o", info.Mode().Perm())
	}
	if _, err := Exchange(context.Background(), cfg, "second-code"); err == nil {
		t.Fatal("expected existing credential to prevent overwrite")
	}
}
