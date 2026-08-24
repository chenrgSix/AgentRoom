package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

func TestCodexAdapterMapsAppServerEventsToRuntimeEvents(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "success")
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: t.TempDir(), Sandbox: "workspace-write", EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
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
	if len(events) != 4 || events[1].Output == nil || events[1].Output.Content != "Implemented." ||
		events[2].Reply != "Implemented." || events[2].Assessment == nil ||
		events[2].Assessment.GoalSatisfied == nil || !*events[2].Assessment.GoalSatisfied ||
		*events[3].Status != contracts.Completed {
		t.Fatalf("unexpected events: %#v", events)
	}
}

func TestCodexAppServerParserStreamsAndResetsAcrossAgentMessages(t *testing.T) {
	parser := newCodexAppServerParser(config.AgentConfig{
		Workspace: t.TempDir(), Sandbox: "workspace-write",
	}, "implement it")
	consumeCodexFixture(t, parser, `{"id":1,"result":{"userAgent":"fixture"}}`)
	consumeCodexFixture(t, parser, `{"id":2,"result":{"thread":{"id":"thread-1"}}}`)
	consumeCodexFixture(t, parser, `{"id":3,"result":{"turn":{"id":"turn-1"}}}`)

	first := consumeCodexFixture(t, parser, `{"method":"item/agentMessage/delta","params":{`+
		`"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":"`+
		strings.Repeat("A", 80)+`"}}`)
	if first == nil || first.Reset || first.Content != strings.Repeat("A", 16) {
		t.Fatalf("unexpected first Codex preview: %#v", first)
	}
	second := consumeCodexFixture(t, parser, `{"method":"item/agentMessage/delta","params":{`+
		`"threadId":"thread-1","turnId":"turn-1","itemId":"item-2","delta":"`+
		strings.Repeat("B", 80)+`"}}`)
	if second == nil || !second.Reset || second.Content != strings.Repeat("B", 16) {
		t.Fatalf("unexpected reset Codex preview: %#v", second)
	}
}

func TestCodexAppServerParserWithholdsSecretsAndRejectsInteractiveRequests(t *testing.T) {
	parser := newCodexAppServerParser(config.AgentConfig{
		Workspace: t.TempDir(), Sandbox: "read-only",
	}, "inspect it")
	consumeCodexFixture(t, parser, `{"id":1,"result":{"userAgent":"fixture"}}`)
	consumeCodexFixture(t, parser, `{"id":2,"result":{"thread":{"id":"thread-1"}}}`)
	consumeCodexFixture(t, parser, `{"id":3,"result":{"turn":{"id":"turn-1"}}}`)
	secret := strings.Repeat("visible ", 12) + "token=very-sensitive-value" + strings.Repeat(" trailing", 12)
	delta := consumeCodexFixture(t, parser, `{"method":"item/agentMessage/delta","params":{`+
		`"threadId":"thread-1","turnId":"turn-1","itemId":"item-1","delta":`+quotedJSON(t, secret)+`}}`)
	if delta == nil || strings.Contains(delta.Content, "very-sensitive") {
		t.Fatalf("secret escaped Codex preview: %#v", delta)
	}
	_, responses, err := parser.consume([]byte(`{"id":41,"method":"item/commandExecution/requestApproval","params":{}}`))
	if err != nil || len(responses) != 1 || !strings.Contains(fmt.Sprint(responses[0]), "cannot answer interactive") {
		t.Fatalf("interactive Codex request was not rejected safely: %#v, %v", responses, err)
	}
}

func consumeCodexFixture(t *testing.T, parser *codexAppServerParser, source string) *OutputDelta {
	t.Helper()
	delta, _, err := parser.consume([]byte(source))
	if err != nil {
		t.Fatal(err)
	}
	return delta
}

func TestCodexAdapterRejectsIncompatibleAppServerStream(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "malformed")
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: t.TempDir(), Sandbox: "workspace-write", EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
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

func TestCodexAdapterTerminatesAppServerAtDeadline(t *testing.T) {
	t.Setenv("AGENTROOM_CODEX_HELPER", "hang")
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: t.TempDir(), Sandbox: "workspace-write", EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
	}}
	var terminal Event
	if err := adapter.Execute(context.Background(), Request{Run: contracts.RunRequestedPayload{
		Instruction: "wait", Deadline: time.Now().Add(150 * time.Millisecond),
	}}, func(_ context.Context, event Event) error {
		terminal = event
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if terminal.Status == nil || *terminal.Status != contracts.Failed ||
		terminal.Error == nil || terminal.Error.Code != "CODEX_TIMEOUT" {
		t.Fatalf("unexpected Codex deadline result: %#v", terminal)
	}
}

func TestCodexAdapterRejectsUnsafeConfiguration(t *testing.T) {
	adapter := CodexAdapter{Config: config.AgentConfig{
		Command:   []string{"codex", "app-server", "--dangerously-bypass-approvals-and-sandbox"},
		Workspace: t.TempDir(), Sandbox: "workspace-write",
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
		Command:   []string{os.Args[0], "-test.run=TestCodexHelperProcess", "--", "app-server", "--listen", "stdio://"},
		Workspace: t.TempDir(), Sandbox: "workspace-write", EnvAllowlist: []string{"AGENTROOM_CODEX_HELPER"},
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
		runCodexAppServerFixture(t, true)
		return
	case "hang":
		runCodexAppServerFixture(t, false)
		return
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

func runCodexAppServerFixture(t *testing.T, complete bool) {
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		var request struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			os.Exit(2)
		}
		switch request.ID {
		case 1:
			_ = encoder.Encode(map[string]any{"id": 1, "result": map[string]any{"userAgent": "fixture"}})
		case 2:
			var params struct {
				Cwd            string `json:"cwd"`
				Sandbox        string `json:"sandbox"`
				ApprovalPolicy string `json:"approvalPolicy"`
				Ephemeral      bool   `json:"ephemeral"`
			}
			if json.Unmarshal(request.Params, &params) != nil || params.Cwd == "" ||
				params.Sandbox != "workspace-write" || params.ApprovalPolicy != "never" || !params.Ephemeral {
				os.Exit(3)
			}
			_ = encoder.Encode(map[string]any{"id": 2, "result": map[string]any{
				"thread": map[string]any{"id": "019d-thread"},
			}})
		case 3:
			var params struct {
				ThreadID string `json:"threadId"`
				Input    []struct {
					Text string `json:"text"`
				} `json:"input"`
			}
			expectedInput := "implement it"
			if !complete {
				expectedInput = "wait"
			}
			if json.Unmarshal(request.Params, &params) != nil || params.ThreadID != "019d-thread" ||
				len(params.Input) != 1 || params.Input[0].Text != expectedInput {
				os.Exit(4)
			}
			_ = encoder.Encode(map[string]any{"id": 3, "result": map[string]any{
				"turn": map[string]any{"id": "turn-1", "status": "inProgress"},
			}})
			if !complete {
				continue
			}
			_ = encoder.Encode(map[string]any{"method": "item/agentMessage/delta", "params": map[string]any{
				"threadId": "019d-thread", "turnId": "turn-1", "itemId": "item-1", "delta": "Implemented.",
			}})
			_ = encoder.Encode(map[string]any{"method": "item/completed", "params": map[string]any{
				"threadId": "019d-thread", "turnId": "turn-1", "completedAtMs": 1,
				"item": map[string]any{"id": "item-1", "type": "agentMessage", "text": "Implemented.\n<agentroom-assessment>{\"goalSatisfied\":true,\"confidence\":0.9}</agentroom-assessment>"},
			}})
			_ = encoder.Encode(map[string]any{"method": "turn/completed", "params": map[string]any{
				"threadId": "019d-thread", "turn": map[string]any{"id": "turn-1", "status": "completed", "items": []any{}},
			}})
		}
	}
}
