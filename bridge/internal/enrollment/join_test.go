package enrollment

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"agentroom.dev/bridge/internal/config"
)

func TestJoinShowsCodePollsAndReturnsCredential(t *testing.T) {
	var claims atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/api/bridge/join-requests":
			if request.Method != http.MethodPost {
				t.Fatalf("unexpected method %s", request.Method)
			}
			var body map[string]string
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["deviceName"] != "Alice Mac" || body["agentName"] != "Local Codex" {
				t.Fatalf("unexpected join body %#v", body)
			}
			json.NewEncoder(response).Encode(map[string]any{
				"joinRequestId":  "joinreq_test",
				"userCode":       "ABCD-1234",
				"pollToken":      "poll-token-with-at-least-forty-characters-123",
				"expiresAt":      "2099-01-01T00:00:00Z",
				"pollIntervalMs": 100,
			})
		case "/api/bridge/join-requests/joinreq_test/claim":
			if claims.Add(1) == 1 {
				response.WriteHeader(http.StatusAccepted)
				json.NewEncoder(response).Encode(map[string]string{"status": "pending"})
				return
			}
			json.NewEncoder(response).Encode(map[string]any{
				"status": "paired",
				"device": map[string]string{
					"deviceId":      "device_test",
					"teamId":        "team_test",
					"ownerMemberId": "member_test",
				},
				"credential": map[string]any{
					"token":     "poll-token-with-at-least-forty-characters-123",
					"expiresAt": nil,
				},
			})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	cfg := config.Config{
		ServerURL: server.URL, DeviceName: "Alice Mac", DataDir: t.TempDir(),
		Agents: []config.AgentConfig{{
			Name: "Local Codex", Role: "Codex implementer", Adapter: "codex",
			Command: []string{"codex", "exec", "--json", "-"}, Workspace: t.TempDir(),
		}},
	}
	var shown Challenge
	credential, err := Join(context.Background(), cfg, func(challenge Challenge) {
		shown = challenge
	})
	if err != nil {
		t.Fatal(err)
	}
	if shown.UserCode != "ABCD-1234" {
		t.Fatalf("unexpected user code %q", shown.UserCode)
	}
	if credential.DeviceID != "device_test" || credential.TeamID != "team_test" {
		t.Fatalf("unexpected credential %#v", credential)
	}
	if claims.Load() != 2 {
		t.Fatalf("expected two claims, got %d", claims.Load())
	}
}
