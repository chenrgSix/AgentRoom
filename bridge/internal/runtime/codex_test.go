package runtime

import (
	"context"
	"fmt"
	"os"
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
	if len(events) != 3 || events[1].Reply != "Implemented." || *events[2].Status != contracts.Completed {
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

func TestCodexHelperProcess(t *testing.T) {
	switch os.Getenv("AGENTROOM_CODEX_HELPER") {
	case "success":
		fmt.Println(`{"type":"thread.started","thread_id":"019d-thread"}`)
		fmt.Println(`{"type":"turn.started"}`)
		fmt.Println(`{"type":"item.completed","item":{"type":"agent_message","text":"Implemented."}}`)
		fmt.Println(`{"type":"turn.completed"}`)
		os.Exit(0)
	case "malformed":
		fmt.Println(`not-json`)
		os.Exit(0)
	}
}
