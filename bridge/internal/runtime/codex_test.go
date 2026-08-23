package runtime

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

func TestCodexAdapterMapsJSONLToRuntimeEvents(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "success")
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "exec", "--json"},
		Workspace: t.TempDir(), EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
	}}
	var events []Event
	if err := adapter.Execute(context.Background(), Request{Run: contracts.RunRequestedPayload{
		Instruction: "implement it",
	}}, func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[1].Reply != "Implemented." ||
		events[1].Assessment == nil || events[1].Assessment.GoalSatisfied == nil ||
		!*events[1].Assessment.GoalSatisfied || *events[2].Status != contracts.Completed {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestCodexAdapterRejectsIncompatibleJSONL(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "malformed")
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "exec", "--json"},
		Workspace: t.TempDir(), EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed || terminal.Error.Code != "CODEX_PROTOCOL_INVALID" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
}

func TestCodexAdapterRejectsUnsafeConfiguration(t *testing.T) {
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{"codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox"},
		Workspace: t.TempDir(),
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Error == nil || terminal.Error.Code != "CODEX_COMMAND_INVALID" {
		t.Fatalf("unexpected terminal event: %#v", terminal)
	}
}

func TestCodexAdapterClassifiesExitWithoutLeakingStderr(t *testing.T) {
	const seededSecret = "seeded-codex-secret"
	t.Setenv("AGENTROOM_CODEX_HELPER", "failure:"+seededSecret)
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "exec", "--json"},
		Workspace: t.TempDir(), EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Error == nil || terminal.Error.Code != "CODEX_EXIT_FAILED" ||
		terminal.Error.Details["exitCode"] != 23 ||
		terminal.Error.Details["category"] != "configuration" ||
		terminal.Error.Details["stderrCaptured"] != true {
		t.Fatalf("unexpected safe Codex failure: %#v", terminal)
	}
	encoded, err := json.Marshal(terminal.Error)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), seededSecret) {
		t.Fatalf("Codex stderr leaked through protocol error: %s", encoded)
	}
}

func TestCodexHelperProcess(t *testing.T) {
	switch os.Getenv("AGENTROOM_CODEX_HELPER") {
	case "success":
		fmt.Println(`{"type":"thread.started","thread_id":"019d-thread"}`)
		fmt.Println(`{"type":"turn.started"}`)
		fmt.Println(`{"type":"item.completed","item":{"type":"agent_message","text":"Implemented.\n<agentroom-assessment>{\"goalSatisfied\":true,\"confidence\":0.9}</agentroom-assessment>"}}`)
		fmt.Println(`{"type":"turn.completed"}`)
		os.Exit(0)
	case "malformed":
		fmt.Println(`not-json`)
		os.Exit(0)
	default:
		if strings.HasPrefix(os.Getenv("AGENTROOM_CODEX_HELPER"), "failure:") {
			fmt.Fprintln(os.Stderr, "EPERM operation not permitted: "+os.Getenv("AGENTROOM_CODEX_HELPER"))
			os.Exit(23)
		}
	}
}
