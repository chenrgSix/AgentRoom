package console

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
)

func TestProbeRuntimeAcceptsExpectedReplyAndNeverReturnsProcessOutput(t *testing.T) {
	ready := `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"AGENTROOM_READY"}],"stopReason":"stop"}}`
	passed := ProbeRuntime(context.Background(), config.AgentConfig{
		Adapter: "generic", RuntimeKind: "pi",
		Command:   []string{"/usr/bin/printf", "%s", ready},
		Workspace: t.TempDir(),
	})
	if !passed.Passed || passed.Code != "RUNTIME_PROBE_OK" {
		t.Fatalf("unexpected successful probe: %#v", passed)
	}

	failed := ProbeRuntime(context.Background(), config.AgentConfig{
		Adapter: "generic", RuntimeKind: "pi",
		Command:   []string{"/bin/sh", "-c", "echo token=must-not-leak >&2; exit 7"},
		Workspace: t.TempDir(),
	})
	encoded, err := json.Marshal(failed)
	if err != nil {
		t.Fatal(err)
	}
	if failed.Passed || failed.ExitCode == nil || *failed.ExitCode != 7 ||
		string(encoded) == "" || strings.Contains(string(encoded), "must-not-leak") {
		t.Fatalf("unsafe failed probe projection: %s", encoded)
	}
}

func TestProbeRuntimeHonorsCallerDeadline(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	started := time.Now()
	result := ProbeRuntime(ctx, config.AgentConfig{
		Adapter: "generic", RuntimeKind: "pi",
		Command: []string{"/bin/sh", "-c", "sleep 2"}, Workspace: t.TempDir(),
	})
	if result.Passed || result.Code != "RUNTIME_TIMEOUT" || time.Since(started) > time.Second {
		t.Fatalf("probe did not honor caller deadline: %#v", result)
	}
}

func TestManagedPiProbeTemporarilyDisablesLocalPermissions(t *testing.T) {
	workspace := t.TempDir()
	executable := filepath.Join(workspace, "pi")
	script := `#!/bin/sh
printf '%s\n' "$@" > probe-args.txt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"AGENTROOM_READY"}],"stopReason":"stop"}}'
`
	if err := os.WriteFile(executable, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	result := ProbeRuntime(context.Background(), config.AgentConfig{
		Adapter: "generic", RuntimeKind: "pi", PresetVersion: config.CurrentPresetVersion,
		Command: config.PiPresetCommand(
			executable, "--approve", "--tools", "read,write,bash",
		),
		Workspace: workspace,
	})
	if !result.Passed {
		t.Fatalf("managed Pi probe failed: %#v", result)
	}
	arguments, err := os.ReadFile(filepath.Join(workspace, "probe-args.txt"))
	if err != nil {
		t.Fatal(err)
	}
	expected := strings.Join([]string{
		"--mode", "json", "--print", "--no-session", "--no-tools", "--no-extensions",
		"--no-skills", "--no-context-files", "--no-approve", "",
	}, "\n")
	if string(arguments) != expected {
		t.Fatalf("probe inherited owner permissions: %q", arguments)
	}
}
