package console

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/identity"
	"convenewire.dev/bridge/internal/pairing"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
)

func genericEditorFixture(t *testing.T) (*Service, string, config.Config) {
	t.Helper()
	directory := t.TempDir()
	configPath := filepath.Join(directory, "bridge.json")
	configuration := config.Config{
		SchemaVersion: config.CurrentSchemaVersion,
		ServerURL:     "http://127.0.0.1:3000", DeviceName: "Generic Editor Bridge",
		DataDir: filepath.Join(directory, "data"),
		Agents: []config.AgentConfig{{
			Name: "Owner CLI", Role: "Builder", Adapter: "generic", RuntimeKind: "generic",
			PresetVersion: 2, Command: []string{"owner-cli", "--policy", "strict", "--output", "jsonl"},
			Workspace: directory, WorkspaceAlias: "Private Workspace", Sandbox: "owner-managed",
			OutputProtocol: "agentroom-jsonl-v1", EnvAllowlist: []string{"PATH", "OWNER_TOKEN_NAME", "CUSTOM_HOME"},
		}, {
			Name: "Sibling CLI", Role: "Reviewer", Adapter: "generic", RuntimeKind: "generic",
			Command: []string{"sibling-cli", "--read-only"}, Workspace: directory, WorkspaceAlias: "Sibling",
			EnvAllowlist: []string{"PATH"},
		}},
	}
	if err := config.Save(configPath, configuration); err != nil {
		t.Fatal(err)
	}
	if err := pairing.Save(configuration.DataDir, pairing.Credential{
		ServerURL: configuration.ServerURL, DeviceID: "device_generic_editor", TeamID: "team_generic_editor",
		OwnerMemberID: "member_generic_editor", Token: "local-fixture-secret",
	}); err != nil {
		t.Fatal(err)
	}
	service, err := New(Options{
		ConfigPath: configPath, DataDir: configuration.DataDir, Workspace: directory, Token: "generic-editor-token",
	}, inertDependencies())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	return service, configPath, configuration
}

func genericEditorInput(agent config.AgentConfig) RuntimeInput {
	return RuntimeInput{
		Kind: "generic", Enabled: true, Name: agent.Name, Role: agent.Role,
		ExecutablePath: agent.Command[0], Workspace: agent.Workspace, WorkspaceAlias: agent.WorkspaceAlias,
	}
}

func TestGenericAgentEditPreservesConfigurationIdentityAndRuntimeScope(t *testing.T) {
	service, configPath, before := genericEditorFixture(t)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	agentID := service.State().Agents[0].AgentID
	beforeScope, err := bridgeruntime.AgentRuntimeScopeID(before.Agents[0])
	if err != nil {
		t.Fatal(err)
	}
	input := genericEditorInput(before.Agents[0])
	input.Name, input.Role, input.WorkspaceAlias = "Renamed CLI", "Planner", "Safe Alias"
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+agentID, input)
	var view AgentView
	if err := json.NewDecoder(response.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("Generic metadata edit failed: %d", response.StatusCode)
	}
	if view.AgentID != agentID || view.Kind != "generic" || view.Name != input.Name ||
		view.WorkspaceFilesystemPolicy != "runtime-managed" || view.WorkspaceNetworkPolicy != "runtime-managed" {
		t.Fatalf("Generic edit changed identity or policy: %#v", view)
	}
	want := cloneConfiguration(before)
	want.Agents[0].Name, want.Agents[0].Role, want.Agents[0].WorkspaceAlias = input.Name, input.Role, input.WorkspaceAlias
	persisted, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(persisted, want) {
		t.Fatalf("Generic edit rebuilt owner configuration:\ngot %#v\nwant %#v", persisted, want)
	}
	afterScope, err := bridgeruntime.AgentRuntimeScopeID(persisted.Agents[0])
	if err != nil || afterScope != beforeScope {
		t.Fatalf("metadata edit invalidated Runtime binding: %q -> %q (%v)", beforeScope, afterScope, err)
	}
	if service.State().BridgeRunning {
		t.Fatal("editing a stopped Generic Agent started the Bridge")
	}
	service.Close()
	reloaded, err := New(Options{
		ConfigPath: configPath, DataDir: before.DataDir, Workspace: before.Agents[0].Workspace, Token: "reload-generic-token",
	}, inertDependencies())
	if err != nil {
		t.Fatal(err)
	}
	defer reloaded.Close()
	if reloaded.State().Agents[0].AgentID != agentID || reloaded.State().Agents[0].Kind != "generic" {
		t.Fatal("Generic identity or kind changed after Console reload")
	}
}

func TestGenericAgentEditAllowsExplicitWorkspaceChangeWithoutRebuildingRuntime(t *testing.T) {
	service, configPath, before := genericEditorFixture(t)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	input := genericEditorInput(before.Agents[0])
	input.Workspace, input.WorkspaceAlias = t.TempDir(), "Different Workspace"
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+service.State().Agents[0].AgentID, input)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("explicit Generic Workspace edit failed: %d", response.StatusCode)
	}
	persisted, err := config.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	want := cloneConfiguration(before)
	want.Agents[0].Workspace, want.Agents[0].WorkspaceAlias = input.Workspace, input.WorkspaceAlias
	if !reflect.DeepEqual(persisted, want) {
		t.Fatalf("Workspace edit changed unrelated Generic configuration: %#v", persisted)
	}
	beforeScope, _ := bridgeruntime.AgentRuntimeScopeID(before.Agents[0])
	afterScope, _ := bridgeruntime.AgentRuntimeScopeID(persisted.Agents[0])
	if beforeScope == afterScope {
		t.Fatal("explicit Workspace change did not change Runtime scope")
	}
}

func TestGenericAgentEditRejectsRuntimeRewritesWithoutMutation(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name   string
		edit   func(*RuntimeInput)
		status int
	}{
		{"codex conversion", func(input *RuntimeInput) { input.Kind, input.ExecutablePath = "codex", executable }, http.StatusConflict},
		{"pi conversion", func(input *RuntimeInput) { input.Kind, input.ExecutablePath = "pi", executable }, http.StatusConflict},
		{"missing kind", func(input *RuntimeInput) { input.Kind = "" }, http.StatusConflict},
		{"executable replacement", func(input *RuntimeInput) { input.ExecutablePath = executable }, http.StatusBadRequest},
		{"sandbox injection", func(input *RuntimeInput) { input.Sandbox = "workspace-write" }, http.StatusBadRequest},
		{"conflict policy injection", func(input *RuntimeInput) { input.CodexSessionConflictPolicy = config.CodexSessionConflictStartNew }, http.StatusBadRequest},
		{"environment injection", func(input *RuntimeInput) { input.CredentialEnvironmentVar = "ANTHROPIC_API_KEY" }, http.StatusBadRequest},
		{"invalid workspace", func(input *RuntimeInput) { input.Workspace = filepath.Join(t.TempDir(), "absent") }, http.StatusBadRequest},
		{"empty workspace", func(input *RuntimeInput) { input.Workspace = "" }, http.StatusBadRequest},
		{"unsafe alias", func(input *RuntimeInput) { input.WorkspaceAlias = "/private/owner" }, http.StatusBadRequest},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			service, configPath, before := genericEditorFixture(t)
			server := httptest.NewServer(service.Handler())
			defer server.Close()
			agentID := service.State().Agents[0].AgentID
			beforeBytes, err := os.ReadFile(configPath)
			if err != nil {
				t.Fatal(err)
			}
			input := genericEditorInput(before.Agents[0])
			input.Name = "Rejected Rename"
			scenario.edit(&input)
			response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+agentID, input)
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode != scenario.status {
				t.Fatalf("unexpected rejection status: %d %s", response.StatusCode, body)
			}
			if scenario.status == http.StatusConflict && !strings.Contains(string(body), "Runtime kind") {
				t.Fatalf("cross-kind rejection did not explain the boundary: %s", body)
			}
			afterBytes, err := os.ReadFile(configPath)
			if err != nil || string(beforeBytes) != string(afterBytes) {
				t.Fatalf("rejected edit changed persisted configuration: %v", err)
			}
			if service.State().Agents[0].Name != before.Agents[0].Name || service.State().Agents[0].AgentID != agentID {
				t.Fatal("rejected edit changed active Agent identity")
			}
			identities, err := identity.LoadOrCreate(before.DataDir, before.Agents)
			if err != nil || identities[input.Name] != "" || identities[before.Agents[0].Name] != agentID {
				t.Fatalf("rejected edit rebound the display name: %#v (%v)", identities, err)
			}
		})
	}
}

func TestAgentCreationStillAcceptsCodexAndPiPresets(t *testing.T) {
	service, configPath, before := genericEditorFixture(t)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"codex", "pi"} {
		response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/agents", RuntimeInput{
			Kind: kind, Name: "New " + kind, Role: "Reviewer", ExecutablePath: executable, Workspace: before.Agents[0].Workspace,
		})
		var view AgentView
		if err := json.NewDecoder(response.Body).Decode(&view); err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusCreated || view.Kind != kind || view.AgentID == "" {
			t.Fatalf("new %s preset failed: %d %#v", kind, response.StatusCode, view)
		}
	}
	persisted, err := config.Load(configPath)
	if err != nil || len(persisted.Agents) != 4 || !reflect.DeepEqual(persisted.Agents[:2], before.Agents) {
		t.Fatalf("preset creation changed existing Generic profiles: %#v (%v)", persisted, err)
	}
}

func TestGenericAgentEditRejectsUnexposedRuntimeFields(t *testing.T) {
	service, configPath, before := genericEditorFixture(t)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	beforeBytes, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	for field, value := range map[string]any{
		"command": []string{"replacement", "--unsafe"}, "envAllowlist": []string{"SECRET"},
		"outputProtocol": "", "adapter": "codex", "presetVersion": 5,
	} {
		t.Run(field, func(t *testing.T) {
			encoded, err := json.Marshal(genericEditorInput(before.Agents[0]))
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]any
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatal(err)
			}
			payload[field] = value
			response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+service.State().Agents[0].AgentID, payload)
			response.Body.Close()
			if response.StatusCode != http.StatusBadRequest {
				t.Fatalf("unexposed Runtime field was accepted: %d", response.StatusCode)
			}
			afterBytes, err := os.ReadFile(configPath)
			if err != nil || string(beforeBytes) != string(afterBytes) {
				t.Fatalf("invalid edit changed configuration: %v", err)
			}
		})
	}
}
