package console

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
)

func memberEntryService(t *testing.T, origin string, open func(string, string, string) error, enabled bool) *Service {
	t.Helper()
	deps := inertDependencies()
	deps.OpenClientEntry = open
	s, dir, _ := newTestService(t, deps)
	cfg := config.Config{SchemaVersion: config.CurrentSchemaVersion, ServerURL: origin, DataDir: filepath.Join(dir, "member-data"), DeviceName: "Client laptop"}
	cred := pairing.Credential{ServerURL: origin, DeviceID: "device_member123", TeamID: "team_member123", OwnerMemberID: "member_person123", Token: strings.Repeat("d", 43)}
	if enabled {
		cred.ClientAccessSecret = strings.Repeat("h", 43)
	}
	if err := pairing.Save(cfg.DataDir, cred); err != nil {
		t.Fatal(err)
	}
	cred.ClientAccessSecret = ""
	s.mu.Lock()
	s.configuration = &cfg
	s.credential = &cred
	s.mu.Unlock()
	return s
}

func TestClientEntryAuthenticatesBothProofsAndNeverReturnsTicketToConsole(t *testing.T) {
	var requests atomic.Int32
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var body map[string]string
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		if r.Header.Get("authorization") != "Bearer "+strings.Repeat("d", 43) || body["clientAccessSecret"] != strings.Repeat("h", 43) {
			t.Error("missing independent credentials")
		}
		if strings.HasSuffix(r.URL.Path, "/rooms") {
			writeJSON(w, 200, map[string]any{"teamId": "team_member123", "teamName": "Team", "memberId": "member_person123", "displayName": "Member", "rooms": []map[string]string{{"roomId": "room_member123", "name": "Build"}}})
			return
		}
		if body["roomId"] != "room_member123" {
			t.Error("lost selected Room")
		}
		w.Header().Set(clientBrowserOriginHeader, "http://127.0.0.1:40080")
		writeJSON(w, 200, map[string]any{"ticket": strings.Repeat("t", 43), "expiresAt": time.Now().Add(time.Minute)})
	}))
	defer central.Close()
	var opens atomic.Int32
	s := memberEntryService(t, central.URL, func(origin, browserOrigin, ticket string) error {
		if origin != central.URL || browserOrigin != "http://127.0.0.1:40080" || ticket != strings.Repeat("t", 43) {
			t.Error("wrong browser target")
		}
		opens.Add(1)
		return nil
	}, true)
	local := httptest.NewServer(s.Handler())
	defer local.Close()
	for _, route := range []string{"/api/client-access", "/api/client-access/open"} {
		method := "GET"
		var payload any
		if strings.HasSuffix(route, "/open") {
			method = "POST"
			payload = map[string]string{"roomId": "room_member123"}
		}
		unauthorized := consoleRequest(t, local.URL, "wrong", method, route, payload)
		unauthorized.Body.Close()
		if unauthorized.StatusCode != 401 {
			t.Fatal("unauthenticated Console entry")
		}
		response := consoleRequest(t, local.URL, s.Token(), method, route, payload)
		source, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatalf("entry failed: %s", source)
		}
		if strings.Contains(string(source), strings.Repeat("t", 43)) || strings.Contains(string(source), strings.Repeat("h", 43)) {
			t.Fatal("Console response disclosed a proof")
		}
	}
	if opens.Load() != 1 || requests.Load() != 2 || !s.State().ClientAccessAvailable {
		t.Fatal("unexpected entry state")
	}
	state, _ := json.Marshal(s.State())
	if strings.Contains(string(state), strings.Repeat("h", 43)) {
		t.Fatal("status disclosed human proof")
	}
	legacy := memberEntryService(t, central.URL, func(string, string, string) error { t.Fatal("legacy device opened browser"); return nil }, false)
	legacyLocal := httptest.NewServer(legacy.Handler())
	defer legacyLocal.Close()
	response := consoleRequest(t, legacyLocal.URL, legacy.Token(), "POST", "/api/client-access/open", map[string]string{})
	response.Body.Close()
	if response.StatusCode != 409 || requests.Load() != 2 || legacy.State().ClientAccessAvailable {
		t.Fatal("legacy device silently received human authority")
	}
}

func TestClientEntryRejectsLatePairingResponseAndCentralRedirect(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release
		writeJSON(w, 200, map[string]any{"ticket": strings.Repeat("t", 43), "expiresAt": time.Now().Add(time.Minute)})
	}))
	defer central.Close()
	s := memberEntryService(t, central.URL, func(string, string, string) error { t.Error("stale pairing opened browser"); return nil }, true)
	local := httptest.NewServer(s.Handler())
	defer local.Close()
	result := make(chan int, 1)
	go func() {
		response := consoleRequest(t, local.URL, s.Token(), "POST", "/api/client-access/open", map[string]string{})
		response.Body.Close()
		result <- response.StatusCode
	}()
	<-started
	s.mu.Lock()
	s.joinEpoch++
	s.mu.Unlock()
	close(release)
	if <-result != 409 {
		t.Fatal("stale pairing was accepted")
	}
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Store(true); w.WriteHeader(200) }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	redirectService := memberEntryService(t, redirect.URL, func(string, string, string) error { t.Error("redirect opened browser"); return nil }, true)
	redirectLocal := httptest.NewServer(redirectService.Handler())
	defer redirectLocal.Close()
	response := consoleRequest(t, redirectLocal.URL, redirectService.Token(), "POST", "/api/client-access/open", map[string]string{})
	response.Body.Close()
	if response.StatusCode != 502 || leaked.Load() {
		t.Fatal("Central redirected independent credentials")
	}
}

func TestClientEntryFallsBackToAuthenticatedBridgeOriginForOlderCentral(t *testing.T) {
	central := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ticket":    strings.Repeat("t", 43),
			"expiresAt": time.Now().Add(time.Minute),
		})
	}))
	defer central.Close()
	opened := false
	service := memberEntryService(t, central.URL, func(bridgeOrigin, browserOrigin, ticket string) error {
		opened = true
		if bridgeOrigin != central.URL || browserOrigin != central.URL || ticket != strings.Repeat("t", 43) {
			t.Fatalf("older Central fallback changed identity: bridge=%q browser=%q", bridgeOrigin, browserOrigin)
		}
		return nil
	}, true)
	local := httptest.NewServer(service.Handler())
	defer local.Close()
	response := consoleRequest(t, local.URL, service.Token(), http.MethodPost,
		"/api/client-access/open", map[string]string{})
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !opened {
		t.Fatalf("older Central entry was not opened: status=%d", response.StatusCode)
	}
}
