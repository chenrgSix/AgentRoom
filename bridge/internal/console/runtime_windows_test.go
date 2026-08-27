//go:build windows

package console

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"agentroom.dev/bridge/internal/config"
)

func TestWindowsRuntimeDiscoveryAndPreflightAcceptNPMCommandShim(t *testing.T) {
	directory := t.TempDir()
	commandShim := filepath.Join(directory, "codex.cmd")
	if err := os.WriteFile(commandShim, []byte("@exit /b 0\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	discovered := discoverRuntimeFrom("codex", runtime.GOOS, nil, func(string) (string, error) {
		return commandShim, nil
	})
	if discovered.Path != commandShim || discovered.Source != "PATH" {
		t.Fatalf("native Windows discovery rejected command shim: %#v", discovered)
	}

	dependencies := inertDependencies()
	dependencies.ProbeRuntime = func(_ context.Context, agent config.AgentConfig) RuntimeProbeResult {
		if agent.RuntimeKind != "codex" || len(agent.Command) == 0 || agent.Command[0] != commandShim {
			t.Errorf("preflight received wrong Runtime command: %#v", agent)
		}
		return RuntimeProbeResult{Passed: true, Code: "RUNTIME_PROBE_OK"}
	}
	service, _, _ := newTestService(t, dependencies)
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	response := consoleRequest(t, server.URL, service.Token(), http.MethodPost, "/api/runtime-preflight", RuntimeInput{
		Kind: "codex", Enabled: true, Name: "Windows Codex", Role: "Builder",
		ExecutablePath: commandShim, Workspace: directory, Sandbox: "workspace-write",
	})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("Windows command shim preflight failed: status=%d body=%s", response.StatusCode, body)
	}
}
