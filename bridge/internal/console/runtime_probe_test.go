package console

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
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
