package console

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/pairing"
)

func newTestService(
	t *testing.T,
	dependencies Dependencies,
) (*Service, string, string) {
	t.Helper()
	directory := t.TempDir()
	service, err := New(Options{
		ConfigPath: filepath.Join(directory, "bridge.json"),
		DataDir:    filepath.Join(directory, "data"),
		Workspace:  directory,
		Token:      "test-console-token",
	}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	return service, directory, filepath.Join(directory, "bridge.json")
}

func inertDependencies() Dependencies {
	return Dependencies{
		Enroll: func(context.Context, config.Config, func(enrollment.Challenge)) (pairing.Credential, error) {
			return pairing.Credential{}, context.Canceled
		},
		SaveConfig:     config.Save,
		ReplaceConfig:  config.Replace,
		SaveCredential: pairing.Save,
		RunBridge: func(ctx context.Context, _ config.Config, _ pairing.Credential) error {
			<-ctx.Done()
			return ctx.Err()
		},
	}
}

func TestConsoleServesEmbeddedUIAndRequiresBearerTokenForAPI(t *testing.T) {
	service, _, _ := newTestService(t, inertDependencies())
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	response, err := http.Get(server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	source, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !bytes.Contains(source, []byte("连接本机智能体")) {
		t.Fatalf("unexpected Console page: %d %s", response.StatusCode, source)
	}
	if response.Header.Get("content-security-policy") == "" {
		t.Fatal("expected Console content security policy")
	}

	unauthorized, err := http.Get(server.URL + "/api/state")
	if err != nil {
		t.Fatal(err)
	}
	unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", unauthorized.StatusCode)
	}

	request, _ := http.NewRequest(http.MethodGet, server.URL+"/api/state", nil)
	request.Header.Set("authorization", "Bearer "+service.Token())
	authorized, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(authorized.Body)
	authorized.Body.Close()
	if authorized.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", authorized.StatusCode, body)
	}
	if bytes.Contains(body, []byte(service.Token())) {
		t.Fatal("Console state must not expose its bearer token")
	}
	if !bytes.Contains(body, []byte(`"agents":[]`)) {
		t.Fatalf("Console must serialize an empty Agent list as an array: %s", body)
	}
}

func TestEnrollmentUsesStrictRuntimePresetsAndStartsManagedBridge(t *testing.T) {
	approved := make(chan struct{})
	bridgeStarted := make(chan struct{}, 1)
	bridgeStopped := make(chan struct{}, 1)
	dependencies := Dependencies{
		Enroll: func(ctx context.Context, _ config.Config, show func(enrollment.Challenge)) (pairing.Credential, error) {
			show(enrollment.Challenge{
				JoinRequestID: "join_test",
				UserCode:      "ABCD-EFGH",
				ExpiresAt:     time.Now().Add(time.Minute),
			})
			select {
			case <-ctx.Done():
				return pairing.Credential{}, ctx.Err()
			case <-approved:
				return pairing.Credential{
					ServerURL:     "http://127.0.0.1:3000",
					DeviceID:      "device_test",
					TeamID:        "team_test",
					OwnerMemberID: "member_test",
					Token:         "credential-secret",
				}, nil
			}
		},
		SaveConfig:     config.Save,
		ReplaceConfig:  config.Replace,
		SaveCredential: pairing.Save,
		RunBridge: func(ctx context.Context, _ config.Config, _ pairing.Credential) error {
			bridgeStarted <- struct{}{}
			<-ctx.Done()
			bridgeStopped <- struct{}{}
			return ctx.Err()
		},
	}
	service, directory, configPath := newTestService(t, dependencies)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	executablePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	payload := EnrollmentInput{
		ServerURL:  "http://127.0.0.1:3000",
		DeviceName: "Alice Local Bridge",
		Runtimes: []RuntimeInput{{
			Kind: "codex", Enabled: true, Name: "Local Codex", Role: "Builder",
			ExecutablePath: executablePath, Workspace: directory, Sandbox: "read-only",
		}, {
			Kind: "pi", Enabled: true, Name: "Local Pi", Role: "Reviewer",
			ExecutablePath: executablePath, Workspace: directory,
			CredentialEnvironmentVar: "ANTHROPIC_API_KEY",
		}},
	}
	startResponse := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/enrollment/start", payload)
	if startResponse.StatusCode != http.StatusAccepted {
		body, _ := io.ReadAll(startResponse.Body)
		startResponse.Body.Close()
		t.Fatalf("expected 202, got %d: %s", startResponse.StatusCode, body)
	}
	startResponse.Body.Close()
	waitState(t, service, func(state State) bool {
		return state.Phase == PhaseApproval && state.JoinCode == "ABCD-EFGH"
	})
	close(approved)
	waitState(t, service, func(state State) bool {
		return state.Phase == PhaseRunning && state.Paired && state.BridgeRunning
	})
	select {
	case <-bridgeStarted:
	case <-time.After(time.Second):
		t.Fatal("managed Bridge did not start after approval")
	}

	loaded, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Agents) != 2 {
		t.Fatalf("expected two configured Agents, got %d", len(loaded.Agents))
	}
	if strings.Join(loaded.Agents[0].Command[1:], " ") != "exec --json --sandbox read-only -" {
		t.Fatalf("unexpected Codex command: %#v", loaded.Agents[0].Command)
	}
	if strings.Join(loaded.Agents[1].Command[1:], " ") != "--print --no-tools --no-extensions --no-skills --no-context-files --no-session" {
		t.Fatalf("unexpected Pi command: %#v", loaded.Agents[1].Command)
	}
	if !contains(loaded.Agents[1].EnvAllowlist, "ANTHROPIC_API_KEY") {
		t.Fatal("expected the explicit Pi credential variable in the allowlist")
	}
	credential, err := pairing.Load(loaded.DataDir)
	if err != nil || credential.Token != "credential-secret" {
		t.Fatal("expected persisted enrollment credential")
	}
	stateBody, _ := json.Marshal(service.State())
	if bytes.Contains(stateBody, []byte(credential.Token)) {
		t.Fatal("public Console state exposed the device credential")
	}

	updated := payload
	updated.Runtimes = []RuntimeInput{{
		Kind: "pi", Enabled: true, Name: "Local Pi Updated", Role: "Reviewer",
		ExecutablePath: executablePath, Workspace: directory,
	}}
	updateResponse := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/config", updated)
	if updateResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(updateResponse.Body)
		updateResponse.Body.Close()
		t.Fatalf("expected config update, got %d: %s", updateResponse.StatusCode, body)
	}
	updateResponse.Body.Close()
	select {
	case <-bridgeStopped:
	case <-time.After(time.Second):
		t.Fatal("old Bridge process did not stop during configuration update")
	}
	select {
	case <-bridgeStarted:
	case <-time.After(time.Second):
		t.Fatal("Bridge did not restart with updated configuration")
	}
	loaded, err = config.Load(configPath)
	if err != nil || len(loaded.Agents) != 1 || loaded.Agents[0].Name != "Local Pi Updated" {
		t.Fatalf("unexpected updated config: %#v, %v", loaded, err)
	}

	wrongServer := updated
	wrongServer.ServerURL = "http://127.0.0.1:3001"
	rejected := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/config", wrongServer)
	if rejected.StatusCode != http.StatusConflict {
		t.Fatalf("expected paired server change to be rejected, got %d", rejected.StatusCode)
	}
	rejected.Body.Close()

	stopResponse := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/bridge/stop", nil)
	stopResponse.Body.Close()
	select {
	case <-bridgeStopped:
	case <-time.After(time.Second):
		t.Fatal("Bridge process did not receive Console cancellation")
	}
}

func TestConsoleRejectsNonLoopbackListenerAndUnsafeRuntimeInput(t *testing.T) {
	if listener, err := ListenLoopback("0.0.0.0:0"); err == nil {
		listener.Close()
		t.Fatal("expected public Console listener to be rejected")
	}
	directory := t.TempDir()
	executablePath, _ := os.Executable()
	_, err := buildConfig(EnrollmentInput{
		ServerURL:  "http://127.0.0.1:3000",
		DeviceName: "Test Bridge",
		Runtimes: []RuntimeInput{{
			Kind: "pi", Enabled: true, Name: "Pi", Role: "Reviewer",
			ExecutablePath: executablePath, Workspace: directory,
			CredentialEnvironmentVar: "bad=value",
		}},
	}, filepath.Join(directory, "data"))
	if err == nil {
		t.Fatal("expected unsafe environment variable name to be rejected")
	}
}

func TestLifecycleMethodsShareStartStopStateWithDesktopShell(t *testing.T) {
	directory := t.TempDir()
	configPath := filepath.Join(directory, "bridge.json")
	dataDir := filepath.Join(directory, "data")
	executablePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	loaded := config.Config{
		ServerURL:  "http://127.0.0.1:3000",
		DeviceName: "Desktop Test Bridge",
		DataDir:    dataDir,
		Agents: []config.AgentConfig{{
			Name: "Desktop Agent", Role: "Test", Adapter: "generic",
			Command: []string{executablePath}, Workspace: directory,
		}},
	}
	if err := config.Save(configPath, loaded); err != nil {
		t.Fatal(err)
	}
	if err := pairing.Save(dataDir, pairing.Credential{
		ServerURL: loaded.ServerURL, DeviceID: "device_desktop",
		TeamID: "team_desktop", OwnerMemberID: "member_desktop", Token: "secret",
	}); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 2)
	stopped := make(chan struct{}, 2)
	dependencies := inertDependencies()
	dependencies.RunBridge = func(ctx context.Context, _ config.Config, _ pairing.Credential) error {
		started <- struct{}{}
		<-ctx.Done()
		stopped <- struct{}{}
		return ctx.Err()
	}
	service, err := New(Options{
		ConfigPath: configPath, DataDir: dataDir, Workspace: directory,
	}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)

	state, err := service.StartBridge()
	if err != nil || !state.BridgeRunning || state.Phase != PhaseRunning {
		t.Fatalf("unexpected started state: %#v, %v", state, err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("desktop lifecycle did not start Bridge")
	}
	state, err = service.StartBridge()
	if err != nil || !state.BridgeRunning {
		t.Fatalf("duplicate start must be idempotent: %#v, %v", state, err)
	}
	select {
	case <-started:
		t.Fatal("duplicate start launched a second Bridge")
	case <-time.After(20 * time.Millisecond):
	}

	state = service.StopBridge()
	if state.BridgeRunning || state.Phase != PhaseReady {
		t.Fatalf("unexpected stopped state: %#v", state)
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("desktop lifecycle did not cancel Bridge")
	}
}

func consoleRequest(
	t *testing.T,
	serverURL string,
	token string,
	method string,
	path string,
	payload any,
) *http.Response {
	t.Helper()
	var body io.Reader
	if payload != nil {
		source, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		body = bytes.NewReader(source)
	}
	request, err := http.NewRequest(method, serverURL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("authorization", "Bearer "+token)
	if payload != nil {
		request.Header.Set("content-type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func waitState(t *testing.T, service *Service, accept func(State) bool) State {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		state := service.State()
		if accept(state) {
			return state
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for Console state: %#v", service.State())
	return State{}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
