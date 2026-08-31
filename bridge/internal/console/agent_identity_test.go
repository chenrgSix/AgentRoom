package console

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"convenewire.dev/bridge/internal/config"
)

func TestAgentRenameThenReuseNameAllocatesDistinctIdentity(t *testing.T) {
	for _, failSave := range []bool{false, true} {
		name := "save succeeds"
		if failSave {
			name = "failed save then retry"
		}
		t.Run(name, func(t *testing.T) {
			service, configPath, before := genericEditorFixture(t)
			server := httptest.NewServer(service.Handler())
			defer server.Close()
			originalID := service.State().Agents[0].AgentID
			edit := genericEditorInput(before.Agents[0])
			edit.Name = "Renamed Owner CLI"
			response := consoleRequest(t, server.URL, service.Token(), http.MethodPut, "/api/agents/"+originalID, edit)
			response.Body.Close()
			if response.StatusCode != http.StatusOK {
				t.Fatalf("rename=%d", response.StatusCode)
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			input := RuntimeInput{
				Kind: "codex", Name: before.Agents[0].Name, Role: "New runtime", ExecutablePath: executable,
				Workspace: before.Agents[0].Workspace, WorkspaceAlias: "New Agent Workspace",
			}
			if failSave {
				replace := service.dependencies.ReplaceConfig
				service.dependencies.ReplaceConfig = func(string, config.Config) error { return errors.New("injected save failure") }
				response = consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/agents", input)
				response.Body.Close()
				if response.StatusCode != http.StatusInternalServerError {
					t.Fatalf("failed save=%d", response.StatusCode)
				}
				if state := service.State(); len(state.Agents) != len(before.Agents) || state.Agents[0].AgentID != originalID {
					t.Fatal("failed save changed the active roster")
				}
				service.dependencies.ReplaceConfig = replace
			}
			response = consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/agents", input)
			var created AgentView
			if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != http.StatusCreated {
				t.Fatalf("create=%d", response.StatusCode)
			}
			if created.AgentID == originalID || created.Kind != "codex" || created.Name != input.Name {
				t.Fatalf("new profile shares or projects the old identity: %#v", created)
			}
			assertUnique := func(state State) {
				seen := map[string]bool{}
				for _, agent := range state.Agents {
					if seen[agent.AgentID] {
						t.Fatal("distinct configured Agents share an identity")
					}
					seen[agent.AgentID] = true
				}
				if state.Agents[0].AgentID != originalID {
					t.Fatal("rename rotated the original identity")
				}
			}
			assertUnique(service.State())
			service.Close()
			reloaded, err := New(Options{ConfigPath: configPath, DataDir: before.DataDir, Token: "reload-test"}, inertDependencies())
			if err != nil {
				t.Fatal(err)
			}
			defer reloaded.Close()
			assertUnique(reloaded.State())
		})
	}
}
