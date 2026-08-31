package console

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
)

func presetOwnerProfile(t *testing.T, kind string) config.AgentConfig {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	agent := config.AgentConfig{
		Name: "Owner " + kind, Role: "Builder", RuntimeKind: kind, PresetVersion: config.CurrentPresetVersion,
		Workspace: t.TempDir(), WorkspaceAlias: "Owner Workspace",
	}
	if kind == "codex" {
		agent.Adapter, agent.Sandbox = "codex", "workspace-write"
		agent.CodexSessionConflictPolicy = config.CodexSessionConflictPreserveAndRetry
		agent.Command = config.CodexPresetCommand(executable)
		agent.EnvAllowlist = []string{"HOME", "PATH", "CODEX_HOME", "OPENAI_API_KEY", "HTTPS_PROXY"}
	} else {
		agent.Adapter = "generic"
		agent.Command = config.PiPresetCommand(executable, "--approve", "--tools", "read,grep")
		agent.EnvAllowlist = []string{"HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_TELEMETRY", "ANTHROPIC_API_KEY", "HTTPS_PROXY"}
	}
	return agent
}

func TestPresetMetadataEditPreservesCompleteProfileAndScope(t *testing.T) {
	for _, kind := range []string{"codex", "pi"} {
		for _, available := range []bool{true, false} {
			t.Run(kind+map[bool]string{true: " available", false: " unavailable"}[available], func(t *testing.T) {
				before := presetOwnerProfile(t, kind)
				if !available {
					before.Command[0] = "owner-runtime-not-currently-installed"
				}
				configuration := config.Config{
					SchemaVersion: config.CurrentSchemaVersion, ServerURL: "http://127.0.0.1:3000", DeviceName: "Editor",
					DataDir: filepath.Join(before.Workspace, "data"), Agents: []config.AgentConfig{before},
				}
				configPath := filepath.Join(before.Workspace, "bridge.json")
				if err := config.Save(configPath, configuration); err != nil {
					t.Fatal(err)
				}
				if err := pairing.Save(configuration.DataDir, pairing.Credential{
					ServerURL: configuration.ServerURL, DeviceID: "device_editor_12345678", TeamID: "team_editor_12345678",
					OwnerMemberID: "member_editor_12345678", Token: "isolated-fixture-only",
				}); err != nil {
					t.Fatal(err)
				}
				service, err := New(Options{ConfigPath: configPath, DataDir: configuration.DataDir, Token: "editor-test"}, inertDependencies())
				if err != nil {
					t.Fatal(err)
				}
				defer service.Close()
				server := httptest.NewServer(service.Handler())
				defer server.Close()
				view := service.State().Agents[0]
				draft := RuntimeInput{
					Kind: view.Kind, Enabled: true, Name: view.Name + " renamed", Role: view.Role,
					ExecutablePath: view.ExecutablePath, Workspace: view.Workspace, WorkspaceAlias: view.WorkspaceAlias,
				}
				if kind == "codex" {
					draft.Sandbox = view.Sandbox
					draft.CodexSessionConflictPolicy = before.ResolvedCodexSessionConflictPolicy()
				}
				if kind == "pi" {
					draft.CredentialEnvironmentVar = view.CredentialEnvironmentVar
				}
				response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+view.AgentID, draft)
				response.Body.Close()
				if response.StatusCode != http.StatusOK {
					t.Fatalf("edit=%d", response.StatusCode)
				}
				persisted, err := config.Load(configPath)
				if err != nil {
					t.Fatal(err)
				}
				oldScope, err := bridgeruntime.AgentRuntimeScopeID(before)
				if err != nil {
					t.Fatal(err)
				}
				newScope, err := bridgeruntime.AgentRuntimeScopeID(persisted.Agents[0])
				if err != nil || oldScope != newScope {
					t.Fatalf("metadata changed scope: %v", err)
				}
				before.Name = draft.Name
				if !reflect.DeepEqual(persisted.Agents[0], before) {
					t.Fatalf("metadata edit changed owner profile: %#v", persisted.Agents[0])
				}
			})
		}
	}
}

func TestPresetExplicitEditsOnlyChangeSelectedPolicy(t *testing.T) {
	pi := presetOwnerProfile(t, "pi")
	input := RuntimeInput{Kind: "pi", Name: pi.Name, Role: pi.Role, ExecutablePath: pi.Command[0], Workspace: pi.Workspace, WorkspaceAlias: pi.WorkspaceAlias}
	for _, selected := range []string{"OPENAI_API_KEY", "HTTPS_PROXY", ""} {
		input.CredentialEnvironmentVar = selected
		edited, err := editPresetRuntime(pi, input)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_TELEMETRY"}
		if selected != "" {
			want = append(want, selected)
		}
		want = appendUnique(want, "HTTPS_PROXY")
		if !reflect.DeepEqual(edited.EnvAllowlist, want) || !reflect.DeepEqual(edited.Command, pi.Command) {
			t.Fatal("explicit edit changed unrelated policy")
		}
		if selected != "" && piCredentialEnvironment(edited.EnvAllowlist) != selected {
			t.Fatal("selected credential was not retained in the editor projection")
		}
	}
	input.CredentialEnvironmentVar = "bad=value"
	if _, err := editPresetRuntime(pi, input); err == nil {
		t.Fatal("invalid credential name accepted")
	}
	codex := presetOwnerProfile(t, "codex")
	edited, err := editPresetRuntime(codex, RuntimeInput{
		Kind: "codex", Name: codex.Name, Role: codex.Role, ExecutablePath: codex.Command[0], Workspace: codex.Workspace,
		WorkspaceAlias: codex.WorkspaceAlias, Sandbox: "read-only", CodexSessionConflictPolicy: config.CodexSessionConflictStartNew,
	})
	if err != nil {
		t.Fatal(err)
	}
	codex.Sandbox, codex.CodexSessionConflictPolicy = "read-only", config.CodexSessionConflictStartNew
	if !reflect.DeepEqual(edited, codex) {
		t.Fatal("explicit Codex policy reset owner configuration")
	}
}
