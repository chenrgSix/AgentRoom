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
	"reflect"
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
	if response.StatusCode != http.StatusOK ||
		!bytes.Contains(source, []byte(`id="setup-intro"`)) ||
		!bytes.Contains(source, []byte(`id="configured-view"`)) {
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
		`id="app-sidebar"`, `id="overview-page"`, `id="agents-page"`,
		`id="settings-page"`, `id="connection-summary"`, `id="overview-agent-list"`,
		`id="connection-state"`, `id="trust-mode"`, `id="login-startup"`,
		`id="export-diagnostics"`, `id="check-update"`, `id="bridge-version"`,
		`id="add-agent"`, `id="agent-modal-backdrop"`, `id="agent-form"`,
		`id="codex-use-detected"`, `id="codex-preflight"`,
		`id="agent-use-detected"`, `id="agent-preflight"`,
		`id="pi-permission-policy"`, `id="agent-pi-permission-policy"`,
		`id="codex-session-ownership-policy"`, `id="agent-codex-session-ownership-policy"`,
		`id="edit-connection"`, `id="connection-modal-backdrop"`,
		`id="connection-form"`, `id="connection-server-url"`,
		`id="server-token"`, `id="current-server-token"`,
		`id="connection-server-token"`, `id="clear-server-token"`,
		`id="connection-trust-mode"`, `id="connection-fingerprint"`,
		`id="share-reasoning-summaries"`, `id="connection-share-reasoning-summaries"`,
		`id="current-reasoning-sharing"`,
		`id="agent-discovery-status"`, `id="agent-discovery-help"`, `id="agent-install-link"`,
		`id="codex-session-guide"`, `id="codex-session-guide-title"`,
		`id="close-codex-session-guide"`, `id="acknowledge-codex-session-guide"`,
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
	if bytes.Count(javascript, []byte(`request("/api/runtime-preflight"`)) != 1 ||
		!bytes.Contains(javascript, []byte(`elements["agent-use-detected"]`)) {
		t.Fatal("draft Runtime preflight and detected-value action must remain explicit")
	}
	presentation, err := staticFiles.ReadFile("static/bridge-presentation.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(html, []byte("权限跟随本机 Pi")) ||
		!bytes.Contains(presentation, []byte("跟随本机策略")) {
		t.Fatal("Console must disclose that managed Pi follows owner-controlled local permissions")
	}
	if bytes.Count(html, []byte(`data-open-codex-session-guide`)) != 3 ||
		!bytes.Contains(html, []byte(`>使用说明</button>`)) ||
		!bytes.Contains(html, []byte("AgentRoom Bridge 使用说明")) ||
		!bytes.Contains(html, []byte("Bridge 是做什么的")) ||
		!bytes.Contains(html, []byte("日常怎么用")) ||
		!bytes.Contains(html, []byte("Codex 会话说明")) ||
		!bytes.Contains(html, []byte(`aria-label="关闭使用说明"`)) ||
		bytes.Count(html, []byte("当前 Bridge 不与 Codex Desktop/CLI 共享同一个 App Server")) != 2 ||
		!bytes.Contains(html, []byte("CODEX_SESSION_IN_USE")) ||
		!bytes.Contains(html, []byte("CODEX_SESSION_RESUME_FAILED")) ||
		!bytes.Contains(html, []byte("当前 AgentRoom 版本没有启用共享 daemon")) ||
		!bytes.Contains(html, []byte("一条消息不等于一个新会话")) ||
		bytes.Count(html, []byte(`value="preserve_and_retry"`)) != 2 ||
		bytes.Count(html, []byte(`value="start_new"`)) != 2 ||
		!bytes.Contains(html, []byte("旧 Codex 会话不会被删除")) ||
		!bytes.Contains(javascript, []byte("codexSessionConflictPolicy")) ||
		!bytes.Contains(javascript, []byte("applyCodexSessionConflictPolicy")) ||
		!bytes.Contains(html, []byte(`aria-describedby="codex-session-ownership-policy"`)) ||
		!bytes.Contains(html, []byte(`aria-describedby="agent-codex-session-ownership-policy"`)) ||
		bytes.Contains(html, []byte(`aria-describedby="agent-codex-session-ownership-policy agent-pi-permission-policy"`)) ||
		!bytes.Contains(javascript, []byte(`applyAgentRuntimePolicy(`)) ||
		!bytes.Contains(javascript, []byte(`applyEnrollmentCodexPolicy(enabled, elements["codex-enabled"])`)) ||
		!bytes.Contains(javascript, []byte(`createSessionGuideController(`)) ||
		!bytes.Contains(javascript, []byte(`document.querySelectorAll("[data-open-codex-session-guide]")`)) {
		t.Fatal("Codex settings must expose the selection-scoped warning and embedded Task Session guide")
	}
	if !bytes.Contains(javascript, []byte("request(agentId ? `/api/agents/")) ||
		bytes.Contains(javascript, []byte(`request(editMode ? "/api/config"`)) {
		t.Fatal("Agent editor must target one Agent endpoint instead of replacing the whole configuration")
	}
	if bytes.Count(javascript, []byte(`request("/api/connection-settings"`)) != 1 ||
		!bytes.Contains(html, []byte("只更新本机 Bridge")) ||
		!bytes.Contains(javascript, []byte("serverTokenConfigured")) {
		t.Fatal("connection editor must use its dedicated endpoint and disclose its narrow ownership")
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
		ServerURL:   "http://127.0.0.1:3000",
		ServerToken: strings.Repeat("e", 32),
		DeviceName:  "Alice Local Bridge",
		Runtimes: []RuntimeInput{{
			Kind: "codex", Enabled: true, Name: "Local Codex", Role: "Builder",
			ExecutablePath: executablePath, Workspace: directory, Sandbox: "read-only",
			CodexSessionConflictPolicy: config.CodexSessionConflictStartNew,
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
	if loaded.SchemaVersion != config.CurrentSchemaVersion || loaded.ServerToken != payload.ServerToken ||
		loaded.Agents[0].RuntimeKind != "codex" || loaded.Agents[1].RuntimeKind != "pi" ||
		loaded.Agents[0].PresetVersion != config.CurrentPresetVersion ||
		loaded.Agents[1].PresetVersion != config.CurrentPresetVersion {
		t.Fatalf("Runtime preset versions were not persisted: %#v", loaded)
	}
	if strings.Join(loaded.Agents[0].Command[1:], " ") != "app-server --listen stdio://" ||
		loaded.Agents[0].Sandbox != "read-only" ||
		loaded.Agents[0].CodexSessionConflictPolicy != config.CodexSessionConflictStartNew {
		t.Fatalf("unexpected Codex command: %#v", loaded.Agents[0].Command)
	}
	if strings.Join(loaded.Agents[1].Command[1:], " ") != "--mode json --print" {
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
	if bytes.Contains(stateBody, []byte(credential.Token)) || bytes.Contains(stateBody, []byte(payload.ServerToken)) ||
		!bytes.Contains(stateBody, []byte(`"serverTokenConfigured":true`)) {
		t.Fatal("public Console state exposed a credential or omitted the central Token status")
	}

	updated := payload
	updated.ServerToken = ""
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
	if err != nil || len(loaded.Agents) != 1 || loaded.Agents[0].Name != "Local Pi Updated" ||
		loaded.ServerToken != payload.ServerToken {
		t.Fatalf("unexpected updated config: %#v, %v", loaded, err)
	}

	changedServer := updated
	changedServer.ServerURL = "http://127.0.0.1:3001"
	changed := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/config", changedServer)
	if changed.StatusCode != http.StatusOK {
		t.Fatalf("expected paired server change to succeed, got %d", changed.StatusCode)
	}
	changed.Body.Close()
	waitSignal(t, bridgeStopped, "old Bridge stop after server change")
	waitSignal(t, bridgeStarted, "Bridge restart after server change")

	stopResponse := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/bridge/stop", nil)
	stopResponse.Body.Close()
	select {
	case <-bridgeStopped:
	case <-time.After(time.Second):
		t.Fatal("Bridge process did not receive Console cancellation")
	}
}

func TestConnectionSettingsPreserveAgentsAndCredentialAcrossLifecycle(t *testing.T) {
	directory := t.TempDir()
	executablePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "bridge.json")
	dataDir := filepath.Join(directory, "data")
	initial := config.Config{
		SchemaVersion:   config.CurrentSchemaVersion,
		ServerURL:       "http://127.0.0.1:3000",
		ServerToken:     strings.Repeat("i", 32),
		ServerTrustMode: config.TrustSystemCA,
		DeviceName:      "Movable Bridge",
		DataDir:         dataDir,
		Agents: []config.AgentConfig{
			{
				Name: "Local Codex", Role: "Builder", Adapter: "codex", RuntimeKind: "codex",
				PresetVersion: config.CurrentPresetVersion,
				Command:       config.CodexPresetCommand(executablePath), Sandbox: "workspace-write",
				Workspace: directory, EnvAllowlist: []string{"HOME", "PATH", "CODEX_HOME"},
			},
			{
				Name: "Local Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi",
				PresetVersion: config.CurrentPresetVersion,
				Command:       config.PiPresetCommand(executablePath), Workspace: directory,
				EnvAllowlist: []string{"HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_TELEMETRY"},
			},
		},
	}
	if err := config.Save(configPath, initial); err != nil {
		t.Fatal(err)
	}
	credential := pairing.Credential{
		ServerURL: initial.ServerURL, DeviceID: "device_move", TeamID: "team_move",
		OwnerMemberID: "member_move", Token: "unchanged-secret",
	}
	if err := pairing.Save(dataDir, credential); err != nil {
		t.Fatal(err)
	}
	started := make(chan config.Config, 3)
	stopped := make(chan struct{}, 3)
	dependencies := inertDependencies()
	dependencies.RunBridge = func(
		ctx context.Context,
		configuration config.Config,
		_ pairing.Credential,
		_ operations.Observer,
	) error {
		started <- configuration
		<-ctx.Done()
		stopped <- struct{}{}
		return ctx.Err()
	}
	service, err := New(Options{
		ConfigPath: configPath, DataDir: dataDir, Workspace: directory, Token: "settings-token",
	}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	if running := waitConfigSignal(t, started, "initial Bridge start"); running.ServerURL != initial.ServerURL {
		t.Fatalf("Bridge started with unexpected URL: %s", running.ServerURL)
	}
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/connection-settings", ConnectionSettingsInput{
		ServerURL:       "http://127.0.0.1:3443",
		ServerToken:     strings.Repeat("r", 32),
		ServerTrustMode: config.TrustSystemCA,
	})
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected connection settings update, got %d", response.StatusCode)
	}
	waitSignal(t, stopped, "Bridge stop after connection settings update")
	if restarted := waitConfigSignal(t, started, "Bridge restart after connection update"); restarted.ServerURL != "http://127.0.0.1:3443" || restarted.ServerToken != strings.Repeat("r", 32) {
		t.Fatalf("Bridge restarted with stale connection settings: %#v", restarted)
	}
	persisted, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(persisted.Agents, initial.Agents) || persisted.DeviceName != initial.DeviceName ||
		persisted.ServerToken != strings.Repeat("r", 32) {
		t.Fatal("connection settings update replaced unrelated Bridge configuration")
	}
	persistedCredential, err := pairing.Load(dataDir)
	if err != nil || !reflect.DeepEqual(persistedCredential, credential) {
		t.Fatalf("connection settings update changed Device credential: %#v, %v", persistedCredential, err)
	}
	if state := service.State(); state.ServerURL != "http://127.0.0.1:3443" ||
		!state.ServerTokenConfigured || !state.BridgeRunning {
		t.Fatalf("unexpected updated Console state: %#v", state)
	}
	stateBody, _ := json.Marshal(service.State())
	if bytes.Contains(stateBody, []byte(strings.Repeat("r", 32))) {
		t.Fatal("public Console state exposed the central Server Token")
	}

	service.mu.Lock()
	epoch := service.bridgeEpoch
	service.mu.Unlock()
	unchanged := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/connection-settings", ConnectionSettingsInput{
		ServerURL:       "http://127.0.0.1:3443",
		ServerTrustMode: config.TrustSystemCA,
	})
	unchanged.Body.Close()
	service.mu.Lock()
	unchangedEpoch := service.bridgeEpoch
	service.mu.Unlock()
	if unchanged.StatusCode != http.StatusOK || unchangedEpoch != epoch {
		t.Fatal("saving unchanged connection settings restarted the Bridge")
	}

	service.StopBridge()
	waitSignal(t, stopped, "Bridge stop before offline connection update")
	offline := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/connection-settings", ConnectionSettingsInput{
		ServerURL:               "https://team.example.com:9443",
		ClearServerToken:        true,
		ServerTrustMode:         config.TrustPinnedSHA256,
		ServerCertificateSHA256: strings.Repeat("a", 64),
	})
	offline.Body.Close()
	if offline.StatusCode != http.StatusOK || service.State().BridgeRunning || service.State().ServerTokenConfigured {
		t.Fatal("editing an offline Bridge unexpectedly started it")
	}
	persisted, err = config.Load(configPath)
	if err != nil || persisted.ServerToken != "" {
		t.Fatalf("clearing the central Server Token was not persisted: %#v, %v", persisted, err)
	}

	invalidToken := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/connection-settings", ConnectionSettingsInput{
		ServerURL:               "https://team.example.com:9443",
		ServerToken:             "too-short",
		ServerTrustMode:         config.TrustPinnedSHA256,
		ServerCertificateSHA256: strings.Repeat("a", 64),
	})
	invalidToken.Body.Close()
	if invalidToken.StatusCode != http.StatusBadRequest || service.State().ServerTokenConfigured {
		t.Fatal("invalid central Server Token changed persisted state")
	}

	invalid := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/connection-settings", ConnectionSettingsInput{
		ServerURL:       "http://team.example.com:3000",
		ServerTrustMode: config.TrustSystemCA,
	})
	invalid.Body.Close()
	if invalid.StatusCode != http.StatusBadRequest || service.State().ServerURL != "https://team.example.com:9443" {
		t.Fatal("invalid central service URL changed persisted state")
	}

	service.mu.Lock()
	service.state.Agents[0].ActiveRuns = 1
	service.mu.Unlock()
	blocked := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/connection-settings", ConnectionSettingsInput{
		ServerURL:       "https://team.example.com:10443",
		ServerTrustMode: config.TrustSystemCA,
	})
	blocked.Body.Close()
	if blocked.StatusCode != http.StatusConflict || service.State().ServerURL != "https://team.example.com:9443" {
		t.Fatal("active Team work did not fence connection settings editing")
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
	agentID := service.State().Agents[0].AgentID
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/runtime-tests", map[string]string{"agentId": agentID})
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
	conflict := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/runtime-tests", map[string]string{"agentId": agentID})
	conflict.Body.Close()
	if conflict.StatusCode != http.StatusConflict || probeCalls != 1 {
		t.Fatal("active Team task did not fence Runtime self-test")
	}
}

func TestRuntimeDraftPreflightDoesNotPersistOrRestartAndFencesConcurrentWork(t *testing.T) {
	directory := t.TempDir()
	executablePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "bridge.json")
	dataDir := filepath.Join(directory, "data")
	loaded := config.Config{
		SchemaVersion: config.CurrentSchemaVersion,
		ServerURL:     "http://127.0.0.1:3000", DeviceName: "Draft Bridge", DataDir: dataDir,
		Agents: []config.AgentConfig{{
			Name: "Existing Codex", Role: "Builder", Adapter: "codex", RuntimeKind: "codex",
			PresetVersion: config.CurrentPresetVersion,
			Command:       config.CodexPresetCommand(executablePath), Workspace: directory, Sandbox: "workspace-write",
		}},
	}
	if err := config.Save(configPath, loaded); err != nil {
		t.Fatal(err)
	}
	if err := pairing.Save(dataDir, pairing.Credential{
		ServerURL: loaded.ServerURL, DeviceID: "device_draft", TeamID: "team_draft",
		OwnerMemberID: "member_draft", Token: "secret",
	}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	probeStarted := make(chan struct{}, 1)
	releaseProbe := make(chan struct{})
	probeCalls := 0
	replaceCalls := 0
	bridgeStarts := 0
	dependencies := inertDependencies()
	dependencies.ReplaceConfig = func(path string, configuration config.Config) error {
		replaceCalls++
		return config.Replace(path, configuration)
	}
	dependencies.RunBridge = func(context.Context, config.Config, pairing.Credential, operations.Observer) error {
		bridgeStarts++
		return nil
	}
	dependencies.ProbeRuntime = func(_ context.Context, agent config.AgentConfig) RuntimeProbeResult {
		probeCalls++
		if agent.Name != "Draft Pi" || agent.RuntimeKind != "pi" || agent.Command[0] != executablePath {
			t.Errorf("preflight did not use the submitted draft: %#v", agent)
		}
		probeStarted <- struct{}{}
		<-releaseProbe
		return RuntimeProbeResult{Passed: true, Code: "RUNTIME_PROBE_OK", DurationMillis: 9}
	}
	service, err := New(Options{
		ConfigPath: configPath, DataDir: dataDir, Workspace: directory, Token: "draft-token",
	}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	draft := RuntimeInput{
		Kind: "pi", Enabled: true, Name: "Draft Pi", Role: "Reviewer",
		ExecutablePath: executablePath, Workspace: directory,
	}
	payload, err := json.Marshal(draft)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(
		http.MethodPost,
		server.URL+"/api/runtime-preflight",
		bytes.NewReader(payload),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("authorization", "Bearer "+service.Token())
	request.Header.Set("content-type", "application/json")
	responseResult := make(chan *http.Response, 1)
	errorResult := make(chan error, 1)
	go func() {
		response, requestErr := http.DefaultClient.Do(request)
		if requestErr != nil {
			errorResult <- requestErr
			return
		}
		responseResult <- response
	}()
	select {
	case <-probeStarted:
	case requestErr := <-errorResult:
		t.Fatal(requestErr)
	case <-time.After(time.Second):
		t.Fatal("draft preflight did not start")
	}

	for path, body := range map[string]any{
		"/api/runtime-preflight": draft,
		"/api/runtime-tests":     map[string]string{"agentId": service.State().Agents[0].AgentID},
		"/api/agents":            draft,
		"/api/enrollment/start":  nil,
	} {
		conflict := consoleRequest(t, server.URL, service.Token(), http.MethodPost, path, body)
		conflict.Body.Close()
		if conflict.StatusCode != http.StatusConflict {
			t.Fatalf("active preflight did not fence %s: %d", path, conflict.StatusCode)
		}
	}
	close(releaseProbe)
	var response *http.Response
	select {
	case response = <-responseResult:
	case requestErr := <-errorResult:
		t.Fatal(requestErr)
	case <-time.After(time.Second):
		t.Fatal("draft preflight did not finish")
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || probeCalls != 1 {
		t.Fatalf("unexpected draft preflight result: status=%d calls=%d", response.StatusCode, probeCalls)
	}
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) || replaceCalls != 0 || bridgeStarts != 0 {
		t.Fatalf("preflight mutated client state: replace=%d starts=%d", replaceCalls, bridgeStarts)
	}

	service.mu.Lock()
	service.state.Agents[0].ActiveRuns = 1
	service.mu.Unlock()
	blocked := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/runtime-preflight", draft)
	blocked.Body.Close()
	if blocked.StatusCode != http.StatusConflict || probeCalls != 1 {
		t.Fatal("active Team task did not fence draft preflight")
	}
}

func TestAgentEndpointsAddAndEditOneStableIdentity(t *testing.T) {
	directory := t.TempDir()
	executablePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "bridge.json")
	dataDir := filepath.Join(directory, "data")
	loaded := config.Config{
		SchemaVersion: config.CurrentSchemaVersion,
		ServerURL:     "http://127.0.0.1:3000",
		DeviceName:    "Agent Editor Bridge",
		DataDir:       dataDir,
		Agents: []config.AgentConfig{{
			Name: "First Codex", Role: "Builder", Adapter: "codex", RuntimeKind: "codex",
			PresetVersion: config.CurrentPresetVersion,
			Command:       config.CodexPresetCommand(executablePath), Sandbox: "workspace-write",
			Workspace: directory,
		}},
	}
	if err := config.Save(configPath, loaded); err != nil {
		t.Fatal(err)
	}
	if err := pairing.Save(dataDir, pairing.Credential{
		ServerURL: loaded.ServerURL, DeviceID: "device_editor", TeamID: "team_editor",
		OwnerMemberID: "member_editor", Token: "secret",
	}); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 3)
	stopped := make(chan struct{}, 3)
	dependencies := inertDependencies()
	dependencies.RunBridge = func(ctx context.Context, _ config.Config, _ pairing.Credential, _ operations.Observer) error {
		started <- struct{}{}
		<-ctx.Done()
		stopped <- struct{}{}
		return ctx.Err()
	}
	service, err := New(Options{
		ConfigPath: configPath, DataDir: dataDir, Workspace: directory, Token: "editor-token",
	}, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	firstID := service.State().Agents[0].AgentID
	if firstID == "" {
		t.Fatal("Console state omitted the immutable Agent identity")
	}
	if _, err := service.StartBridge(); err != nil {
		t.Fatal(err)
	}
	waitSignal(t, started, "initial Bridge start")
	added := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/agents", RuntimeInput{
		Kind: "codex", Name: "Second Codex", Role: "Reviewer",
		ExecutablePath: executablePath, Workspace: directory, Sandbox: "read-only",
		CodexSessionConflictPolicy: config.CodexSessionConflictStartNew,
	})
	var addedView AgentView
	if err := json.NewDecoder(added.Body).Decode(&addedView); err != nil {
		t.Fatal(err)
	}
	added.Body.Close()
	if added.StatusCode != http.StatusCreated || addedView.AgentID == "" || addedView.AgentID == firstID ||
		addedView.CodexSessionConflictPolicy != config.CodexSessionConflictStartNew {
		t.Fatalf("unexpected added Agent: %d %#v", added.StatusCode, addedView)
	}
	waitSignal(t, stopped, "old Bridge stop after Agent addition")
	waitSignal(t, started, "Bridge restart after Agent addition")
	service.StopBridge()
	waitSignal(t, stopped, "Bridge stop before offline Agent edit")

	edited := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+firstID, RuntimeInput{
		Kind: "pi", Name: "Renamed First", Role: "Planner",
		ExecutablePath: executablePath, Workspace: directory,
		CredentialEnvironmentVar: "ANTHROPIC_API_KEY",
	})
	var editedView AgentView
	if err := json.NewDecoder(edited.Body).Decode(&editedView); err != nil {
		t.Fatal(err)
	}
	edited.Body.Close()
	if edited.StatusCode != http.StatusOK || editedView.AgentID != firstID ||
		editedView.Name != "Renamed First" || editedView.Kind != "pi" {
		t.Fatalf("unexpected edited Agent: %d %#v", edited.StatusCode, editedView)
	}
	if service.State().BridgeRunning {
		t.Fatal("editing a stopped Bridge unexpectedly started it")
	}
	persisted, err := config.Load(configPath)
	if err != nil || len(persisted.Agents) != 2 || persisted.Agents[1].Name != "Second Codex" ||
		persisted.Agents[1].CodexSessionConflictPolicy != config.CodexSessionConflictStartNew {
		t.Fatalf("unexpected persisted Agents: %#v, %v", persisted.Agents, err)
	}
	reloaded, err := New(Options{
		ConfigPath: configPath, DataDir: dataDir, Workspace: directory, Token: "reload-token",
	}, inertDependencies())
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	if reloaded.State().Agents[0].AgentID != firstID {
		t.Fatal("Agent rename changed identity after Console reload")
	}

	service.mu.Lock()
	service.state.Agents[0].ActiveRuns = 1
	service.mu.Unlock()
	conflict := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/agents", RuntimeInput{
		Kind: "pi", Name: "Blocked Pi", Role: "Reviewer",
		ExecutablePath: executablePath, Workspace: directory,
	})
	conflict.Body.Close()
	if conflict.StatusCode != http.StatusConflict {
		t.Fatalf("active Team task did not fence Agent creation: %d", conflict.StatusCode)
	}
	service.mu.Lock()
	service.state.Agents[0].ActiveRuns = 0
	service.runtimeTests[firstID] = struct{}{}
	service.mu.Unlock()
	selfTestConflict := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+firstID, RuntimeInput{
		Kind: "pi", Name: "Blocked Rename", Role: "Planner",
		ExecutablePath: executablePath, Workspace: directory,
	})
	selfTestConflict.Body.Close()
	if selfTestConflict.StatusCode != http.StatusConflict {
		t.Fatalf("Runtime self-test did not fence Agent editing: %d", selfTestConflict.StatusCode)
	}
}

func TestAgentEditPreservesOwnerControlledPiPolicy(t *testing.T) {
	directory := t.TempDir()
	executablePath, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(directory, "bridge.json")
	dataDir := filepath.Join(directory, "data")
	loaded := config.Config{
		SchemaVersion: config.CurrentSchemaVersion,
		ServerURL:     "http://127.0.0.1:3000",
		DeviceName:    "Pi Policy Bridge",
		DataDir:       dataDir,
		Agents: []config.AgentConfig{{
			Name: "Local Pi", Role: "Reviewer", Adapter: "generic", RuntimeKind: "pi",
			PresetVersion: config.CurrentPresetVersion,
			Command: config.PiPresetCommand(
				executablePath, "--approve", "--tools", "read,grep,find,ls",
			),
			Workspace: directory,
		}},
	}
	if err := config.Save(configPath, loaded); err != nil {
		t.Fatal(err)
	}
	if err := pairing.Save(dataDir, pairing.Credential{
		ServerURL: loaded.ServerURL, DeviceID: "device_pi_policy", TeamID: "team_pi_policy",
		OwnerMemberID: "member_pi_policy", Token: "secret",
	}); err != nil {
		t.Fatal(err)
	}
	service, err := New(Options{
		ConfigPath: configPath, DataDir: dataDir, Workspace: directory, Token: "pi-policy-token",
	}, inertDependencies())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	agentID := service.State().Agents[0].AgentID
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+agentID, RuntimeInput{
		Kind: "pi", Name: "Renamed Pi", Role: "Implementation",
		ExecutablePath: executablePath, Workspace: directory,
	})
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("unexpected Pi edit status: %d", response.StatusCode)
	}
	persisted, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(persisted.Agents[0].Command[1:], " ") !=
		"--mode json --print --approve --tools read,grep,find,ls" {
		t.Fatalf("Pi edit changed owner-controlled policy: %#v", persisted.Agents[0].Command)
	}
}

func waitSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func waitConfigSignal(t *testing.T, signal <-chan config.Config, description string) config.Config {
	t.Helper()
	select {
	case configuration := <-signal:
		return configuration
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %s", description)
		return config.Config{}
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
