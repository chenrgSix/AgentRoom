package console

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"runtime"
	"sync"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/enrollment"
	"convenewire.dev/bridge/internal/operations"
	"convenewire.dev/bridge/internal/pairing"
)

// Opt-in real Console editor fixture. Its temporary credentials are synthetic;
// Runtime discovery, probing and execution never invoke an installed tool.
func TestGenericEditorBrowserFixture(t *testing.T) {
	if os.Getenv("CONVENE_WIRE_GENERIC_EDITOR_UI_FIXTURE") != "1" {
		t.Skip("opt-in isolated Generic editor browser fixture")
	}
	dependencies := inertDependencies()
	dependencies.DiscoverRuntime = func(string) RuntimeDiscovery { return RuntimeDiscovery{} }
	dependencies.ProbeRuntime = func(context.Context, config.AgentConfig) RuntimeProbeResult {
		return RuntimeProbeResult{Code: "FIXTURE_NO_RUNTIME"}
	}
	service, configuration := pairedRecoveryService(t, dependencies)
	generic := config.AgentConfig{
		Name: "Generic Worker", Role: "Builder", Adapter: "generic", RuntimeKind: "generic",
		Command:   []string{configuration.Agents[0].Command[0], "--policy", "owner policy with spaces"},
		Workspace: configuration.Agents[0].Workspace, WorkspaceAlias: "Custom Workspace",
		EnvAllowlist:   []string{"PATH", "OWNER_PROVIDER_TOKEN"},
		OutputProtocol: config.OutputProtocolConveneWireJSONLV1,
	}
	configuration.Agents[0] = generic
	service.mu.Lock()
	err := service.replaceConfigurationLocked(configuration)
	service.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	agentID := service.State().Agents[0].AgentID
	finished := make(chan struct{})
	var stop sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("POST /fixture/stop", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
		stop.Do(func() { close(finished) })
	})
	mux.Handle("/", service.Handler())
	server := httptest.NewServer(mux)
	defer server.Close()
	fmt.Printf("GENERIC_EDITOR_FIXTURE_URL=%s/?token=%s\n", server.URL, service.Token())
	select {
	case <-finished:
	case <-time.After(20 * time.Minute):
		t.Fatal("browser fixture timed out")
	}
	persisted, err := config.Load(service.options.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	want := generic
	want.Name = "Renamed Generic Worker"
	if len(persisted.Agents) != 2 || !reflect.DeepEqual(persisted.Agents[0], want) ||
		!reflect.DeepEqual(persisted.Agents[1], configuration.Agents[1]) ||
		service.State().Agents[0].AgentID != agentID {
		t.Fatal("browser rename did not preserve the complete Generic configuration and identities")
	}
}

// Opt-in first-run fixture: an empty temporary configuration and no central or
// Runtime calls. It keeps visual acceptance independent from a real Device.
func TestSetupBrowserFixture(t *testing.T) {
	if os.Getenv("AGENTROOM_SETUP_UI_FIXTURE") != "1" {
		t.Skip("opt-in isolated setup browser fixture")
	}
	service, _, _ := newTestService(t, inertDependencies())
	finished := make(chan struct{})
	var stop sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("POST /fixture/stop", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
		stop.Do(func() { close(finished) })
	})
	mux.Handle("/", service.Handler())
	server := httptest.NewServer(mux)
	defer server.Close()
	fmt.Printf("SETUP_FIXTURE_URL=%s/?token=%s\n", server.URL, service.Token())
	select {
	case <-finished:
	case <-time.After(20 * time.Minute):
		t.Fatal("browser fixture timed out")
	}
}

// Opt-in browser fixture: temporary config, fake credentials, and no central
// network calls. Control routes exist only in this test, never in the binary.
func TestPairingBrowserFixture(t *testing.T) {
	if os.Getenv("AGENTROOM_PAIRING_UI_FIXTURE") != "1" {
		t.Skip("opt-in isolated browser fixture")
	}
	var mu sync.Mutex
	var decision chan bool
	dependencies := inertDependencies()
	switch os.Getenv("AGENTROOM_DISCOVERY_FIXTURE") {
	case "missing":
		dependencies.DiscoverRuntime = func(string) RuntimeDiscovery { return RuntimeDiscovery{} }
	case "fallback":
		dependencies.DiscoverRuntime = func(kind string) RuntimeDiscovery {
			homeDirectory, _ := os.UserHomeDir()
			return discoverRuntimeFrom(kind, runtime.GOOS, runtimeCandidates(kind, runtime.GOOS, homeDirectory, os.Getenv), missingRuntime)
		}
	}
	dependencies.Enroll = func(ctx context.Context, cfg config.Config, show func(enrollment.Challenge)) (pairing.Credential, error) {
		result := make(chan bool, 1)
		mu.Lock()
		decision = result
		mu.Unlock()
		show(enrollment.Challenge{UserCode: "ABCD-1234", ExpiresAt: time.Now().Add(10 * time.Minute)})
		select {
		case accepted := <-result:
			if !accepted {
				return pairing.Credential{}, fmt.Errorf("Fixture: central service unavailable")
			}
			return approvedRecoveryCredential(cfg), nil
		case <-ctx.Done():
			return pairing.Credential{}, ctx.Err()
		}
	}
	dependencies.PairDevice = func(ctx context.Context, cfg config.Config, _ pairing.SessionInput, show func(pairing.SessionStatus)) (pairing.Credential, error) {
		result := make(chan bool, 1)
		mu.Lock()
		decision = result
		mu.Unlock()
		show(pairing.SessionStatus{State: "claimed", VerificationPhrase: "VIOLET-RIVER-42", ExpiresAt: time.Now().Add(10 * time.Minute)})
		select {
		case accepted := <-result:
			if !accepted {
				return pairing.Credential{}, fmt.Errorf("Fixture: pairing rejected by target Central")
			}
			return approvedRecoveryCredential(cfg), nil
		case <-ctx.Done():
			return pairing.Credential{}, ctx.Err()
		}
	}
	dependencies.RunBridge = func(ctx context.Context, _ config.Config, _ pairing.Credential, observer operations.Observer) error {
		observer.Connection(operations.ConnectionEvent{State: operations.ConnectionOnline, At: time.Now()})
		<-ctx.Done()
		return nil
	}
	service, _ := pairedRecoveryService(t, dependencies)
	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	var stop sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("POST /fixture/expire", func(response http.ResponseWriter, _ *http.Request) {
		service.mu.Lock()
		service.state.JoinExpiresAt = time.Now().Add(-time.Second).Format(time.RFC3339Nano)
		service.mu.Unlock()
		response.WriteHeader(http.StatusNoContent)
	})
	for _, path := range []string{"approve", "fail"} {
		mux.HandleFunc("POST /fixture/"+path, func(response http.ResponseWriter, _ *http.Request) {
			mu.Lock()
			defer mu.Unlock()
			if decision == nil {
				response.WriteHeader(http.StatusConflict)
				return
			}
			select {
			case decision <- path == "approve":
				response.WriteHeader(http.StatusNoContent)
			default:
				response.WriteHeader(http.StatusConflict)
			}
		})
	}
	mux.HandleFunc("POST /fixture/stop", func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
		stop.Do(func() { close(finished) })
	})
	mux.Handle("/", service.Handler())
	server := httptest.NewServer(mux)
	defer server.Close()
	fmt.Printf("PAIRING_FIXTURE_URL=%s/?token=%s\n", server.URL, service.Token())
	select {
	case <-finished:
	case <-time.After(20 * time.Minute):
		t.Fatal("browser fixture timed out")
	}
}
