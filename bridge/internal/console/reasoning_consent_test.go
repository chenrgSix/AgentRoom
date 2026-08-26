package console

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
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
	update := func(token string, expected int) {
		t.Helper()
		response := consoleRequest(t, server.URL, token, http.MethodPut, "/api/connection-settings", input)
		response.Body.Close()
		if response.StatusCode != expected {
			t.Fatalf("status=%d want=%d", response.StatusCode, expected)
		}
	}
	update("not-authorized", http.StatusUnauthorized)
	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	update(service.Token(), http.StatusConflict)
	service.StopBridge()
	update(service.Token(), http.StatusConflict)
	close(exit)
	waitState(t, service, func(state State) bool { return state.Enrollment.CanRequest })
	update(service.Token(), http.StatusOK)
	loaded, err := config.Load(service.options.ConfigPath)
	if err != nil || !loaded.ShareReasoningSummaries || !service.State().ShareReasoningSummaries || !reflect.DeepEqual(loaded.Agents, previous.Agents) {
		t.Fatalf("consent save damaged configuration: %v", err)
	}
	if service.State().BridgeRunning {
		t.Fatal("changing consent started a stopped Bridge")
	}
	reopened, err := New(Options{ConfigPath: service.options.ConfigPath}, inertDependencies())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if !reopened.State().ShareReasoningSummaries {
		t.Fatal("consent did not survive restart")
	}
	input.ShareReasoningSummaries = nil
	input.ServerToken = "new-central-token-12345678901234567890"
	update(service.Token(), http.StatusOK)
	if !service.State().ShareReasoningSummaries {
		t.Fatal("unrelated edit revoked consent")
	}
	input.ServerURL = "http://127.0.0.1:3001"
	update(service.Token(), http.StatusOK)
	if service.State().ShareReasoningSummaries {
		t.Fatal("changed endpoint inherited consent")
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
