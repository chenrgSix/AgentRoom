package pairing

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
)

func TestParseSessionLinkRequiresCanonicalSecretBearingLink(t *testing.T) {
	expiresAt := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	claimSecret := strings.Repeat("a", 43)
	values := url.Values{
		"origin":           {"https://team.example"},
		"pairingSessionId": {"pairing_12345678"},
		"expiresAt":        {expiresAt.Format(time.RFC3339)},
	}
	raw := "agentroom://pair-device?" + values.Encode() + "#claimSecret=" + claimSecret

	parsed, err := ParseSessionLink(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.ServerURL != "https://team.example" || parsed.PairingSessionID != "pairing_12345678" ||
		parsed.ClaimSecret != claimSecret || !parsed.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("unexpected parsed link: %#v", parsed)
	}

	httpsValues := url.Values{
		"pairingSessionId": {"pairing_12345678"},
		"expiresAt":        {expiresAt.Format(time.RFC3339)},
	}
	if _, err := ParseSessionLink(
		"https://team.example/device-pairing?" + httpsValues.Encode() + "#claimSecret=" + claimSecret,
	); err != nil {
		t.Fatalf("HTTPS fallback link should be accepted: %v", err)
	}

	invalid := []string{
		"agentroom://pair-device?" + values.Encode() + "&claimSecret=" + claimSecret,
		raw + "&extra=value",
		strings.Replace(raw, "https%3A%2F%2Fteam.example", "http%3A%2F%2Fteam.example", 1),
		strings.Replace(raw, "pair-device", "other", 1),
	}
	for _, candidate := range invalid {
		if _, err := ParseSessionLink(candidate); err == nil {
			t.Fatalf("expected link to be rejected: %s", candidate)
		}
	}
}

func TestSessionClientRecoversClaimAndPollResponseLossWithoutChangingProof(t *testing.T) {
	const (
		pairingSessionID = "pairing_12345678"
	)
	claimSecret := strings.Repeat("c", 43)
	var mutex sync.Mutex
	claimBodies := make([]map[string]any, 0, 2)
	pollBodies := make([]map[string]any, 0, 3)
	sessionExpiresAt := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get(config.ServerTokenHeader) != "" || request.Header.Get("authorization") != "" {
			t.Errorf("anonymous pairing must not send a central credential")
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		mutex.Lock()
		defer mutex.Unlock()
		switch request.URL.Path {
		case "/api/device-pairing-sessions/" + pairingSessionID + "/claim":
			claimBodies = append(claimBodies, body)
			if strings.Contains(fmt.Sprint(body), "/private/workspace") ||
				strings.Contains(fmt.Sprint(body), "PRIVATE_ENV") ||
				strings.Contains(fmt.Sprint(body), "Builder") {
				t.Errorf("claim crossed the local configuration boundary: %#v", body)
			}
			if len(claimBodies) == 1 {
				response.WriteHeader(http.StatusOK)
				_, _ = response.Write([]byte(`{"pairingSessionId":`))
				return
			}
			writePairingJSON(t, response, map[string]any{
				"pairingSessionId": pairingSessionID,
				"pairingAttemptId": body["pairingAttemptId"],
				"state":            "claimed", "verificationPhrase": "VIOLET-RIVER-42",
				"expiresAt":      sessionExpiresAt.Format(time.RFC3339),
				"pollIntervalMs": 500,
			})
		case "/api/device-pairing-sessions/" + pairingSessionID + "/poll":
			pollBodies = append(pollBodies, body)
			if len(pollBodies) == 1 {
				response.WriteHeader(http.StatusOK)
				_, _ = response.Write([]byte(`{"state":`))
				return
			}
			if len(pollBodies) == 2 {
				response.WriteHeader(http.StatusAccepted)
				writePairingJSON(t, response, map[string]any{
					"pairingSessionId": pairingSessionID,
					"pairingAttemptId": body["pairingAttemptId"],
					"state":            "claimed", "verificationPhrase": "VIOLET-RIVER-42",
					"expiresAt": sessionExpiresAt.Format(time.RFC3339), "retryAfterMs": 500,
				})
				return
			}
			writePairingJSON(t, response, map[string]any{
				"pairingSessionId": pairingSessionID,
				"pairingAttemptId": body["pairingAttemptId"],
				"state":            "consumed", "credentialSource": "poll_secret",
				"deviceId": "device_test1234", "teamId": "team_test1234", "ownerMemberId": "member_owner123",
			})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	expiresAt := sessionExpiresAt.Format(time.RFC3339)
	link := "agentroom://pair-device?" + url.Values{
		"origin": {server.URL}, "pairingSessionId": {pairingSessionID}, "expiresAt": {expiresAt},
	}.Encode() + "#claimSecret=" + claimSecret
	var shown SessionStatus
	credential, err := (SessionClient{
		BridgeVersion: "v0.2.0-rc.3", RetryDelay: time.Millisecond,
	}).Pair(context.Background(), validPairingConfig(server.URL), SessionInput{Link: link}, func(status SessionStatus) {
		shown = status
	})
	if err != nil {
		t.Fatal(err)
	}
	if shown.PairingSessionID != pairingSessionID || shown.VerificationPhrase != "VIOLET-RIVER-42" {
		t.Fatalf("unexpected status projection: %#v", shown)
	}
	if len(claimBodies) != 2 || !reflect.DeepEqual(claimBodies[0], claimBodies[1]) {
		t.Fatalf("claim retry changed its idempotency proof: %#v", claimBodies)
	}
	if len(pollBodies) != 3 || !reflect.DeepEqual(pollBodies[0], pollBodies[1]) ||
		!reflect.DeepEqual(pollBodies[1], pollBodies[2]) {
		t.Fatalf("poll retry changed its proof: %#v", pollBodies)
	}
	pollSecret := claimBodies[0]["pollSecret"]
	if credential.Token != pollSecret || credential.DeviceID != "device_test1234" || credential.TeamID != "team_test1234" ||
		credential.OwnerMemberID != "member_owner123" {
		t.Fatalf("poll secret was not promoted as the exact credential: %#v", credential)
	}
	if got := sortedKeys(claimBodies[0]); !reflect.DeepEqual(got, []string{
		"claimSecret", "device", "operationId", "pairingAttemptId", "pairingSessionId", "pollSecret",
	}) {
		t.Fatalf("unexpected claim fields: %v", got)
	}
	device, ok := claimBodies[0]["device"].(map[string]any)
	if !ok || !reflect.DeepEqual(sortedKeys(device), []string{
		"bridgeVersion", "displayName", "platform", "supportsScopedPrivateTrust",
	}) || device["supportsScopedPrivateTrust"] != true {
		t.Fatalf("claim Device metadata is not closed: %#v", claimBodies[0]["device"])
	}
}

func TestSessionClientClaimsWithManualShortCode(t *testing.T) {
	var claimBody map[string]any
	var pollSecret string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get(config.ServerTokenHeader) != "" || request.Header.Get("authorization") != "" {
			t.Errorf("manual pairing must not send a central credential")
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		switch request.URL.Path {
		case "/api/device-pairing-session-claims":
			claimBody = body
			pollSecret, _ = body["pollSecret"].(string)
			writePairingJSON(t, response, map[string]any{
				"pairingSessionId": "pairing_87654321", "pairingAttemptId": body["pairingAttemptId"],
				"state": "claimed", "verificationPhrase": "SILVER-FOREST-42",
				"expiresAt": time.Now().UTC().Add(time.Minute).Format(time.RFC3339), "pollIntervalMs": 500,
			})
		case "/api/device-pairing-sessions/pairing_87654321/poll":
			writePairingJSON(t, response, map[string]any{
				"pairingSessionId": "pairing_87654321", "pairingAttemptId": body["pairingAttemptId"],
				"state": "consumed", "credentialSource": "poll_secret",
				"deviceId": "device_manual12", "teamId": "team_test1234", "ownerMemberId": "member_owner123",
			})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	credential, err := (SessionClient{BridgeVersion: "dev", RetryDelay: time.Millisecond}).Pair(
		context.Background(), validPairingConfig(server.URL), SessionInput{ShortCode: "BCDF-GHJK-MN"}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if credential.Token != pollSecret || credential.DeviceID != "device_manual12" {
		t.Fatalf("unexpected credential: %#v", credential)
	}
	if got := sortedKeys(claimBody); !reflect.DeepEqual(got, []string{
		"device", "operationId", "pairingAttemptId", "pollSecret", "shortCode",
	}) {
		t.Fatalf("manual claim leaked or omitted fields: %v", got)
	}
}

func TestSessionClientBootstrapsPrivateTrustBeforeSendingClaimProof(t *testing.T) {
	claimSecret := strings.Repeat("p", 43)
	expiresAt := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	var caPEM []byte
	var claimCount int
	var server privateTLSServer
	server = newPrivateTLSServer(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case privateCAPath:
			if request.Header.Get("authorization") != "" || request.Header.Get(config.ServerTokenHeader) != "" {
				t.Fatal("private bootstrap sent a credential")
			}
			response.Header().Set("content-type", "application/x-pem-file")
			_, _ = response.Write(caPEM)
		case "/api/health/ready":
			response.WriteHeader(http.StatusOK)
		case "/api/device-pairing-sessions/pairing_private123/claim":
			claimCount++
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["claimSecret"] != claimSecret {
				t.Fatal("private claim did not carry the exact link proof after TLS verification")
			}
			trustBody, ok := body["trust"].(map[string]any)
			if !ok || trustBody["origin"] != server.Server.URL ||
				trustBody["installationId"] != "install_0123456789abcdefghijklmn" ||
				trustBody["caCertificateSha256"] != server.Digest || trustBody["trustEpoch"] != float64(1) {
				t.Fatalf("private trust echo is invalid: %#v", body["trust"])
			}
			device := body["device"].(map[string]any)
			if device["supportsScopedPrivateTrust"] != true {
				t.Fatal("private claim omitted Bridge scoped-trust capability")
			}
			writePairingJSON(t, response, map[string]any{
				"pairingSessionId": "pairing_private123", "pairingAttemptId": body["pairingAttemptId"],
				"state": "claimed", "verificationPhrase": "CEDAR-LAKE-21",
				"expiresAt": expiresAt.Format(time.RFC3339), "pollIntervalMs": 500,
			})
		case "/api/device-pairing-sessions/pairing_private123/poll":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			writePairingJSON(t, response, map[string]any{
				"pairingSessionId": "pairing_private123", "pairingAttemptId": body["pairingAttemptId"],
				"state": "consumed", "credentialSource": "poll_secret",
				"deviceId": "device_private123", "teamId": "team_private123",
				"ownerMemberId": "member_private123",
			})
		default:
			http.NotFound(response, request)
		}
	}))
	caPEM = server.CAPEM
	fragment := url.Values{
		"claimSecret":         {claimSecret},
		"trustMode":           {"private_scoped_ca"},
		"trustOrigin":         {server.Server.URL},
		"installationId":      {"install_0123456789abcdefghijklmn"},
		"trustEpoch":          {"1"},
		"caCertificateSha256": {server.Digest},
	}
	link := "agentroom://pair-device?" + url.Values{
		"origin": {server.Server.URL}, "pairingSessionId": {"pairing_private123"},
		"expiresAt": {expiresAt.Format(time.RFC3339)},
	}.Encode() + "#" + fragment.Encode()
	credential, err := (SessionClient{
		BridgeVersion: "v0.4.0-qa028.1", RetryDelay: time.Millisecond,
	}).Pair(context.Background(), validPairingConfig(server.Server.URL), SessionInput{Link: link}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if claimCount != 1 || credential.ScopedPrivateTrust == nil ||
		credential.ScopedPrivateTrust.CACertificateSHA256 != server.Digest {
		t.Fatalf("private trust was not installed only after consumption: %#v", credential)
	}

	wrongFragment := fragment
	wrongFragment.Set("caCertificateSha256", strings.Repeat("b", 64))
	wrongLink := "agentroom://pair-device?" + url.Values{
		"origin": {server.Server.URL}, "pairingSessionId": {"pairing_private124"},
		"expiresAt": {expiresAt.Format(time.RFC3339)},
	}.Encode() + "#" + wrongFragment.Encode()
	if _, err := (SessionClient{BridgeVersion: "v0.4.0-qa028.1"}).Pair(
		context.Background(), validPairingConfig(server.Server.URL), SessionInput{Link: wrongLink}, nil,
	); err == nil || !strings.Contains(err.Error(), "digest mismatch") {
		t.Fatalf("expected private digest failure before claim, got %v", err)
	}
	if claimCount != 1 {
		t.Fatal("digest mismatch sent a claim proof")
	}
}

func validPairingConfig(serverURL string) config.Config {
	return config.Config{
		SchemaVersion: config.CurrentSchemaVersion,
		ServerURL:     serverURL, ServerToken: strings.Repeat("server-token-", 3),
		DeviceName: "Alice Mac", DataDir: "/private/agentroom-data",
		Agents: []config.AgentConfig{{
			Name: "Builder", Role: "builder", Adapter: "codex", RuntimeKind: "codex",
			PresetVersion: config.CurrentPresetVersion, Command: []string{"codex", "app-server", "PRIVATE_ENV"},
			Workspace: "/private/workspace", WorkspaceAlias: "Customer Alpha", Sandbox: "workspace-write",
		}},
	}
}

func writePairingJSON(t *testing.T, response http.ResponseWriter, value any) {
	t.Helper()
	response.Header().Set("content-type", "application/json")
	if err := json.NewEncoder(response).Encode(value); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

func sortedKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	for index := 1; index < len(keys); index++ {
		for cursor := index; cursor > 0 && keys[cursor] < keys[cursor-1]; cursor-- {
			keys[cursor], keys[cursor-1] = keys[cursor-1], keys[cursor]
		}
	}
	return keys
}
