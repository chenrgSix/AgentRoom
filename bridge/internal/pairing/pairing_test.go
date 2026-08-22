package pairing

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"agentroom.dev/bridge/internal/config"
)

func TestExchangeStoresCredentialWithOwnerOnlyPermissions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/bridge/pair" {
			http.NotFound(response, request)
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
	cfg := config.Config{ServerURL: server.URL, DeviceName: "Alice Mac", DataDir: directory}
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
