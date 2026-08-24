package console

import (
	"archive/zip"
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

	"agentroom.dev/bridge/internal/autostart"
	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/diagnostics"
	"agentroom.dev/bridge/internal/enrollment"
	"agentroom.dev/bridge/internal/operations"
	"agentroom.dev/bridge/internal/pairing"
	"agentroom.dev/bridge/internal/updatecheck"
)

type fakeLoginStartup struct {
	state autostart.State
	calls int
}

func (f *fakeLoginStartup) State() (autostart.State, error) { return f.state, nil }

func (f *fakeLoginStartup) SetEnabled(_ context.Context, enabled bool) (autostart.State, error) {
	f.calls++
	f.state = autostart.State{Supported: true, Enabled: enabled, PlistPath: "/safe/LaunchAgent.plist"}
	return f.state, nil
}

type countingUpdateChecker struct {
	calls int
}

func (c *countingUpdateChecker) Check(_ context.Context, current string) (updatecheck.Result, error) {
	c.calls++
	return updatecheck.Result{
		CurrentVersion: current, LatestVersion: "v0.3.0", CurrentComparable: true,
		UpdateAvailable: true, ReleaseURL: "https://github.com/chenrgSix/AgentRoom/releases/tag/v0.3.0",
	}, nil
}

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
		RunBridge: func(ctx context.Context, _ config.Config, _ pairing.Credential, _ operations.Observer) error {
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

func TestEmbeddedUIExposesOperationsWithoutAutomaticUpdateChecks(t *testing.T) {
	html, err := staticFiles.ReadFile("static/index.html")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{
		`id="connection-state"`, `id="trust-mode"`, `id="login-startup"`,
		`id="export-diagnostics"`, `id="check-update"`, `id="bridge-version"`,
	} {
		if !bytes.Contains(html, []byte(id)) {
			t.Fatalf("embedded UI omitted %s", id)
		}
	}
	javascript, err := staticFiles.ReadFile("static/app.js")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Count(javascript, []byte(`request("/api/update/check"`)) != 1 {
		t.Fatal("update check must exist only in the explicit click handler")
	}
	if bytes.Count(javascript, []byte(`request("/api/runtime-tests"`)) != 1 ||
		!bytes.Contains(javascript, []byte("测试运行")) {
		t.Fatal("Runtime self-test must exist only behind an explicit Agent-row action")
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
		RunBridge: func(ctx context.Context, _ config.Config, _ pairing.Credential, _ operations.Observer) error {
			bridgeStarted <- struct{}{}
			<-ctx.Done()
			bridgeStopped <- struct{}{}
			return ctx.Err()
		},
	}
	service, directory, configPath := newTestService(t, dependencies)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	executablePath := filepath.Join(directory, "runtime")
	if err := os.WriteFile(executablePath, []byte("test runtime"), 0o700); err != nil {
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
	if loaded.SchemaVersion != config.CurrentSchemaVersion ||
		loaded.Agents[0].RuntimeKind != "codex" || loaded.Agents[1].RuntimeKind != "pi" ||
		loaded.Agents[0].PresetVersion != config.CurrentPresetVersion ||
		loaded.Agents[1].PresetVersion != config.CurrentPresetVersion {
		t.Fatalf("Runtime preset versions were not persisted: %#v", loaded)
	}
	if strings.Join(loaded.Agents[0].Command[1:], " ") != "exec --json --sandbox read-only -" {
		t.Fatalf("unexpected Codex command: %#v", loaded.Agents[0].Command)
	}
	if strings.Join(loaded.Agents[1].Command[1:], " ") != "--mode json --print --no-tools --no-extensions --no-skills --no-context-files --no-session" {
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

func TestRuntimeSelfTestIsExplicitBoundedAndSafelyProjected(t *testing.T) {
	directory := t.TempDir()
	executablePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "bridge.json")
	loaded := config.Config{
		SchemaVersion: config.CurrentSchemaVersion,
		ServerURL:     "http://127.0.0.1:3000", DeviceName: "Probe Bridge",
		DataDir: filepath.Join(directory, "data"),
		Agents: []config.AgentConfig{{
			Name: "Local Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi",
			PresetVersion: config.CurrentPresetVersion,
			Command:       []string{executablePath}, Workspace: directory,
		}},
	}
	if err := config.Save(configPath, loaded); err != nil {
		t.Fatal(err)
	}
	probeCalls := 0
	dependencies := inertDependencies()
	dependencies.ProbeRuntime = func(_ context.Context, agent config.AgentConfig) RuntimeProbeResult {
		probeCalls++
		if agent.Name != "Local Pi" {
			t.Fatalf("wrong Runtime selected: %#v", agent)
		}
		exitCode := 7
		return RuntimeProbeResult{
			Passed: false, Code: "RUNTIME_EXIT_FAILED", Category: "configuration",
			ExitCode: &exitCode, StderrCaptured: true, DurationMillis: 12,
		}
	}
	service, err := New(Options{
		ConfigPath: configPath, DataDir: loaded.DataDir, Workspace: directory,
		Token: "probe-token",
	}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	stateResponse := consoleRequest(t, server.URL, service.Token(), http.MethodGet, "/api/state", nil)
	stateResponse.Body.Close()
	if probeCalls != 0 {
		t.Fatal("state polling must never run a Runtime self-test")
	}
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/runtime-tests", map[string]string{"agentName": "Local Pi"})
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || probeCalls != 1 {
		t.Fatalf("unexpected Runtime test response: %d %s", response.StatusCode, body)
	}
	if !bytes.Contains(body, []byte(`"code":"RUNTIME_EXIT_FAILED"`)) ||
		!bytes.Contains(body, []byte(`"category":"configuration"`)) ||
		!bytes.Contains(body, []byte(`"exitCode":7`)) ||
		bytes.Contains(body, []byte("stderr content")) {
		t.Fatalf("unsafe or incomplete Runtime test projection: %s", body)
	}

	service.mu.Lock()
	service.state.Agents[0].ActiveRuns = 1
	service.mu.Unlock()
	conflict := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/runtime-tests", map[string]string{"agentName": "Local Pi"})
	conflict.Body.Close()
	if conflict.StatusCode != http.StatusConflict || probeCalls != 1 {
		t.Fatal("active Team task did not fence Runtime self-test")
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
	dependencies.RunBridge = func(ctx context.Context, _ config.Config, _ pairing.Credential, _ operations.Observer) error {
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

func TestOperationalObserverProjectsConnectionRuntimeAndFencesOldEpoch(t *testing.T) {
	directory := t.TempDir()
	configPath := filepath.Join(directory, "bridge.json")
	dataDir := filepath.Join(directory, "data")
	executablePath := filepath.Join(directory, "runtime")
	if err := os.WriteFile(executablePath, []byte("test runtime"), 0o700); err != nil {
		t.Fatal(err)
	}
	loaded := config.Config{
		ServerURL: "http://127.0.0.1:3000", DeviceName: "Projection Bridge", DataDir: dataDir,
		Agents: []config.AgentConfig{{
			Name: "Projected Agent", Role: "Test", Adapter: "generic",
			Command: []string{executablePath}, Workspace: directory,
		}},
	}
	if err := config.Save(configPath, loaded); err != nil {
		t.Fatal(err)
	}
	if err := pairing.Save(dataDir, pairing.Credential{
		ServerURL: loaded.ServerURL, DeviceID: "device_projection", TeamID: "team_projection",
		OwnerMemberID: "member_projection", Token: "secret",
	}); err != nil {
		t.Fatal(err)
	}
	observers := make(chan operations.Observer, 2)
	dependencies := inertDependencies()
	dependencies.RunBridge = func(ctx context.Context, _ config.Config, _ pairing.Credential, observer operations.Observer) error {
		observers <- observer
		<-ctx.Done()
		return ctx.Err()
	}
	service, err := New(Options{ConfigPath: configPath, DataDir: dataDir, Workspace: directory, Version: "v0.2.0"}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	first := <-observers
	now := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	first.Connection(operations.ConnectionEvent{At: now, State: operations.ConnectionOnline})
	first.Runtime(operations.RuntimeEvent{
		At: now, AgentName: "Projected Agent", AgentID: "agent_private_id", RunID: "run_private_id",
		State: operations.RuntimeWorking, ActiveDelta: 1, LastStatus: "working",
	})
	state := service.State()
	if state.Connection.State != operations.ConnectionOnline || state.Version != "v0.2.0" ||
		len(state.Agents) != 1 || state.Agents[0].RuntimeState != "working" || state.Agents[0].ActiveRuns != 1 {
		t.Fatalf("unexpected operational projection: %#v", state)
	}
	first.Runtime(operations.RuntimeEvent{
		At: now.Add(time.Second), AgentName: "Projected Agent",
		State: operations.RuntimeIdle, ActiveDelta: -1, LastStatus: "completed",
	})
	if err := os.Remove(executablePath); err != nil {
		t.Fatal(err)
	}
	if state = service.State(); state.Agents[0].ExecutableReady || state.Agents[0].RuntimeState != "unavailable" {
		t.Fatalf("moved Runtime executable was not detected: %#v", state.Agents[0])
	}
	service.StopBridge()
	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	second := <-observers
	first.Connection(operations.ConnectionEvent{At: now.Add(time.Second), State: operations.ConnectionOnline})
	if state = service.State(); state.Connection.State == operations.ConnectionOnline {
		t.Fatal("old Bridge epoch changed the new lifecycle projection")
	}
	second.Connection(operations.ConnectionEvent{At: now.Add(2 * time.Second), State: operations.ConnectionOnline})
	if state = service.State(); state.Connection.State != operations.ConnectionOnline {
		t.Fatalf("current Bridge observer was ignored: %#v", state.Connection)
	}
}

func TestLoginStartupDiagnosticsAndUpdateAreExplicitAuthenticatedActions(t *testing.T) {
	startup := &fakeLoginStartup{state: autostart.State{Supported: true}}
	checker := &countingUpdateChecker{}
	diagnosticsDirectory := t.TempDir()
	directory := t.TempDir()
	dependencies := inertDependencies()
	dependencies.LoginStartup = startup
	dependencies.UpdateChecker = checker
	service, err := New(Options{
		ConfigPath: filepath.Join(directory, "bridge.json"), DataDir: filepath.Join(directory, "data"),
		Workspace: directory, Token: "settings-token", Version: "v0.2.0",
		DiagnosticsDir: diagnosticsDirectory,
	}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	stateResponse := consoleRequest(t, server.URL, service.Token(), http.MethodGet, "/api/state", nil)
	stateResponse.Body.Close()
	if checker.calls != 0 {
		t.Fatal("state polling must not perform an update check")
	}
	loginResponse := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/login-startup", map[string]bool{"enabled": true})
	loginResponse.Body.Close()
	if loginResponse.StatusCode != http.StatusOK || startup.calls != 1 || !service.State().LoginStartup.Enabled {
		t.Fatalf("login startup action did not converge: status=%d calls=%d state=%#v", loginResponse.StatusCode, startup.calls, service.State().LoginStartup)
	}
	updateResponse := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/update/check", nil)
	updateResponse.Body.Close()
	if updateResponse.StatusCode != http.StatusOK || checker.calls != 1 {
		t.Fatalf("manual update check was not exactly once: status=%d calls=%d", updateResponse.StatusCode, checker.calls)
	}

	service.mu.Lock()
	service.state.Connection.LastError = "Bearer abcdefghijklmnop /Users/alice/private token=very-secret-value"
	service.state.TeamID = "team_private_identifier"
	service.state.DeviceID = "device_private_identifier"
	service.events = append(service.events, diagnostics.Event{
		At: time.Now().UTC().Format(time.RFC3339Nano), Type: "connection.retrying",
		Message: "sk-1234567890abcdefghijkl /Users/alice/private prompt-sensitive reply-sensitive",
	})
	service.mu.Unlock()
	diagnosticsResponse := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/diagnostics/export", nil)
	var exported diagnostics.Result
	if err := json.NewDecoder(diagnosticsResponse.Body).Decode(&exported); err != nil {
		t.Fatal(err)
	}
	diagnosticsResponse.Body.Close()
	if diagnosticsResponse.StatusCode != http.StatusCreated {
		t.Fatalf("unexpected diagnostics status %d", diagnosticsResponse.StatusCode)
	}
	if exported.Path != "" {
		t.Fatalf("diagnostics API exposed an absolute export path: %#v", exported)
	}
	archive, err := zip.OpenReader(filepath.Join(diagnosticsDirectory, exported.Filename))
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	var extracted strings.Builder
	for _, entry := range archive.File {
		reader, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(&extracted, reader)
		reader.Close()
	}
	for _, forbidden := range []string{"abcdefghijklmnop", "very-secret-value", "sk-", "/Users/alice", "team_private_identifier", "device_private_identifier", "prompt-sensitive", "reply-sensitive"} {
		if strings.Contains(extracted.String(), forbidden) {
			t.Fatalf("diagnostics exposed %q: %s", forbidden, extracted.String())
		}
	}

	unauthorized, err := http.Post(server.URL+"/api/update/check", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	unauthorized.Body.Close()
	if unauthorized.StatusCode != http.StatusUnauthorized || checker.calls != 1 {
		t.Fatal("unauthorized update check reached the checker")
	}
}

func TestBuildConfigSupportsSystemCAAndLegacyFingerprintInference(t *testing.T) {
	directory := t.TempDir()
	executablePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := EnrollmentInput{
		ServerURL: "https://team.example.com", ServerTrustMode: config.TrustSystemCA,
		DeviceName: "TLS Bridge",
		Runtimes: []RuntimeInput{{
			Kind: "codex", Enabled: true, Name: "Codex", Role: "Builder",
			ExecutablePath: executablePath, Workspace: directory,
		}},
	}
	systemCA, err := buildConfig(base, filepath.Join(directory, "data"))
	if err != nil || systemCA.ResolvedTrustMode() != config.TrustSystemCA {
		t.Fatalf("system CA config failed: %#v, %v", systemCA, err)
	}
	legacy := base
	legacy.ServerTrustMode = ""
	legacy.ServerCertificateSHA256 = strings.Repeat("a", 64)
	pinned, err := buildConfig(legacy, filepath.Join(directory, "legacy-data"))
	if err != nil || pinned.ResolvedTrustMode() != config.TrustPinnedSHA256 {
		t.Fatalf("legacy pin inference failed: %#v, %v", pinned, err)
	}
	ambiguous := base
	ambiguous.ServerCertificateSHA256 = strings.Repeat("b", 64)
	if _, err := buildConfig(ambiguous, filepath.Join(directory, "ambiguous-data")); err == nil {
		t.Fatal("system CA with a fingerprint must be rejected")
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
