package console

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/pairing"
)

func TestReasoningConsentDefaultsAndEndpointScope(t *testing.T) {
	yes, no := true, false
	previous := config.Config{ServerURL: "https://old.example.com", ShareReasoningSummaries: true}
	for _, item := range []struct {
		url      string
		explicit *bool
		want     bool
	}{
		{previous.ServerURL, nil, true}, {previous.ServerURL, &no, false},
		{"https://new.example.com", nil, false}, {"https://new.example.com", &yes, true},
	} {
		if got := reasoningConsentForUpdate(previous, item.url, item.explicit); got != item.want {
			t.Fatalf("wrong consent for %#v", item)
		}
	}
	service, cfg := pairedRecoveryService(t, inertDependencies())
	if service.State().ShareReasoningSummaries || cfg.ShareReasoningSummaries {
		t.Fatal("legacy configuration granted consent")
	}
	input := EnrollmentInput{ServerURL: cfg.ServerURL, DeviceName: cfg.DeviceName, Runtimes: []RuntimeInput{{Kind: "codex", Enabled: true, Name: "Codex", Role: "Builder", ExecutablePath: cfg.Agents[0].Command[0], Workspace: cfg.Agents[0].Workspace}}}
	for _, explicit := range []*bool{nil, &no, &yes} {
		input.ShareReasoningSummaries = explicit
		built, err := buildConfig(input, cfg.DataDir)
		if err != nil || built.ShareReasoningSummaries != (explicit != nil && *explicit) {
			t.Fatalf("setup granted wrong consent: %v", err)
		}
	}
}

func TestReasoningConsentRequiresAuthenticatedStoppedDrainedBridge(t *testing.T) {
	exit := make(chan struct{})
	dependencies := inertDependencies()
	dependencies.RunBridge = func(ctx context.Context, _ config.Config, _ pairing.Credential, _ operations.Observer) error {
		<-ctx.Done()
		<-exit
		return nil
	}
	service, previous := pairedRecoveryService(t, dependencies)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	yes := true
	input := ConnectionSettingsInput{ServerURL: previous.ServerURL, ShareReasoningSummaries: &yes}
	if !service.State().ReasoningEditable {
		t.Fatal("stopped and drained paired Bridge must expose editable reasoning consent")
	}
	update := func(token string, expected int) {
		t.Helper()
		response := consoleRequest(t, server.URL, token, http.MethodPut, "/api/connection-settings", input)
		response.Body.Close()
		if response.StatusCode != expected {
			t.Fatalf("status=%d want=%d", response.StatusCode, expected)
		}
	}
	prepare := func(expected int) {
		t.Helper()
		response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/reasoning-consent/prepare", nil)
		response.Body.Close()
		if response.StatusCode != expected {
			t.Fatalf("prepare status=%d want=%d", response.StatusCode, expected)
		}
	}
	update("not-authorized", http.StatusUnauthorized)
	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	if service.State().ReasoningEditable {
		t.Fatal("running Bridge exposed editable reasoning consent")
	}
	update(service.Token(), http.StatusConflict)
	service.mu.Lock()
	service.state.Agents[0].ActiveRuns = 1
	service.mu.Unlock()
	prepare(http.StatusConflict)
	if !service.State().BridgeRunning {
		t.Fatal("privacy preparation interrupted an active Run")
	}
	service.mu.Lock()
	service.state.Agents[0].ActiveRuns = 0
	service.mu.Unlock()
	prepared := make(chan int, 1)
	go func() {
		response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/reasoning-consent/prepare", nil)
		response.Body.Close()
		prepared <- response.StatusCode
	}()
	waitState(t, service, func(state State) bool { return !state.BridgeRunning })
	if service.State().ReasoningEditable {
		t.Fatal("stopping Bridge exposed consent before its worker drained")
	}
	update(service.Token(), http.StatusConflict)
	close(exit)
	select {
	case status := <-prepared:
		if status != http.StatusOK {
			t.Fatalf("prepare status=%d want=%d", status, http.StatusOK)
		}
	case <-time.After(time.Second):
		t.Fatal("privacy preparation did not return after the Bridge drained")
	}
	waitState(t, service, func(state State) bool { return state.ReasoningEditable })
	update(service.Token(), http.StatusOK)
	loaded, err := config.Load(service.options.ConfigPath)
	if err != nil || !loaded.ShareReasoningSummaries || !service.State().ShareReasoningSummaries || !reflect.DeepEqual(loaded.Agents, previous.Agents) {
		t.Fatalf("consent save damaged configuration: %v", err)
	}
	if service.State().BridgeRunning {
		t.Fatal("changing consent started a stopped Bridge")
	}
	input.ShareReasoningSummaries = nil
	input.ServerToken = "new-central-token-12345678901234567890"
	update(service.Token(), http.StatusOK)
	if !service.State().ShareReasoningSummaries {
		t.Fatal("unrelated edit revoked consent")
	}
	input.ServerURL = "http://127.0.0.1:3001"
	update(service.Token(), http.StatusConflict)
	if !service.State().ShareReasoningSummaries || service.State().ServerURL != previous.ServerURL {
		t.Fatal("rejected cross-origin edit changed privacy consent or Central origin")
	}
	service.Close()
	reopened, err := New(Options{ConfigPath: service.options.ConfigPath}, inertDependencies())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if !reopened.State().ShareReasoningSummaries {
		t.Fatal("consent did not survive restart")
	}
}

func TestReasoningConsentSaveFailureKeepsPreviousPermission(t *testing.T) {
	dependencies := inertDependencies()
	dependencies.ReplaceConfig = func(string, config.Config) error { return errors.New("save failed") }
	service, previous := pairedRecoveryService(t, dependencies)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	yes := true
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/connection-settings", ConnectionSettingsInput{ServerURL: previous.ServerURL, ShareReasoningSummaries: &yes})
	response.Body.Close()
	loaded, err := config.Load(service.options.ConfigPath)
	if response.StatusCode != http.StatusInternalServerError || err != nil || loaded.ShareReasoningSummaries || service.State().ShareReasoningSummaries {
		t.Fatal("failed save granted permission")
	}
}
