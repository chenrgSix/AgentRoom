package runtime

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

var (
	piHelperSessionID   = flag.String("session-id", "", "Pi helper session id")
	piHelperSessionName = flag.String("name", "", "Pi helper session name")
)

func TestPiAdapterExtractsFinalAssistantReplyAndAssessment(t *testing.T) {
	output := strings.Join([]string{
		`{"type":"session","version":3}`,
		`{"type":"message_start","message":{"role":"assistant","content":[]}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Useful review.\n<agentroom-assessment>{\"goalSatisfied\":true,\"confidence\":0.9}</agentroom-assessment>"}],"stopReason":"stop"}}`,
	}, "\n")
	events := executePiFixture(t, output)
	if len(events) != 4 || events[1].Output == nil ||
		events[1].Output.Content != "Useful review." ||
		events[2].Reply != "Useful review." || events[2].Assessment == nil ||
		events[2].Assessment.GoalSatisfied == nil ||
		!*events[2].Assessment.GoalSatisfied || events[3].Status == nil ||
		*events[3].Status != contracts.Completed {
		t.Fatalf("unexpected Pi events: %#v", events)
	}
}

func TestPiAdapterProjectsBoundedToolLifecycleAndReturnsFinalReply(t *testing.T) {
	output := strings.Join([]string{
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"I will inspect it."},{"type":"toolCall","name":"read"}],"stopReason":"toolUse"}}`,
		`{"type":"tool_execution_start","toolName":"read"}`,
		`{"type":"tool_execution_end","toolName":"read","isError":false}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"The project uses Go and TypeScript."}],"stopReason":"stop"}}`,
	}, "\n")
	events := executePiFixture(t, output)
	if len(events) != 6 || events[1].Activity == nil ||
		events[1].Activity.Kind != "tool" || events[1].Activity.Phase != "started" ||
		events[1].Activity.Label != "read" || events[2].Activity == nil ||
		events[2].Activity.Phase != "completed" || events[3].Output == nil ||
		events[3].Output.Content != "The project uses Go and TypeScript." ||
		events[4].Reply != "The project uses Go and TypeScript." ||
		events[5].Status == nil || *events[5].Status != contracts.Completed {
		t.Fatalf("unexpected Pi tool lifecycle projection: %#v", events)
	}
}

func TestPiAdapterProjectsExplicitThinkingDeltas(t *testing.T) {
	output := strings.Join([]string{
		`{"type":"message_start","message":{"role":"assistant","content":[]}}`,
		`{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"Inspecting the request."}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"stopReason":"stop"}}`,
	}, "\n")
	events := executePiFixture(t, output)
	if len(events) != 6 || events[1].Activity == nil ||
		events[1].Activity.Kind != "reasoning" ||
		events[1].Activity.Content != "Inspecting the request." ||
		events[2].Activity == nil || events[2].Activity.Phase != "completed" ||
		events[3].Output == nil || events[4].Reply != "Done." ||
		events[5].Status == nil || *events[5].Status != contracts.Completed {
		t.Fatalf("unexpected Pi thinking projection: %#v", events)
	}
}

func TestPiAdapterEmitsPreviewBeforeFinalReply(t *testing.T) {
	t.Setenv("AGENTROOM_PI_HELPER", "stream")
	adapter := PiAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestPiHelperProcess", "--"},
		Workspace: t.TempDir(), EnvAllowlist: []string{"AGENTROOM_PI_HELPER"},
	}}
	var previewAt time.Time
	var replyAt time.Time
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		if event.Output != nil && previewAt.IsZero() {
			previewAt = time.Now()
		}
		if event.Reply != "" {
			replyAt = time.Now()
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if previewAt.IsZero() || replyAt.IsZero() || !previewAt.Before(replyAt) {
		t.Fatalf("preview was not emitted before final reply: preview=%s reply=%s", previewAt, replyAt)
	}
}

func TestPiAdapterUsesStableRoomAgentSession(t *testing.T) {
	t.Setenv("AGENTROOM_PI_HELPER", "session")
	workspace := t.TempDir()
	t.Setenv("AGENTROOM_PI_WORKSPACE", workspace)
	name := "我的 Pi"
	adapter := PiAdapter{Config: config.AgentConfig{
		Command:   []string{os.Args[0], "-test.run=TestPiHelperProcess"},
		Workspace: workspace, EnvAllowlist: []string{"AGENTROOM_PI_HELPER", "AGENTROOM_PI_WORKSPACE"},
		RuntimeKind: "pi", PresetVersion: config.CurrentPresetVersion,
	}}
	request := Request{Run: contracts.RunRequestedPayload{
		RoomID: "room_alpha", TargetAgentID: "agent_pi", TargetAgentName: &name,
	}}
	var reply string
	if err := adapter.Execute(context.Background(), request, func(_ context.Context, event Event) error {
		if event.Reply != "" {
			reply = event.Reply
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if reply != "Session resumed." {
		t.Fatalf("unexpected Pi session reply: %q", reply)
	}
	first := piSessionID("room_alpha", "agent_pi", workspace)
	if first != piSessionID("room_alpha", "agent_pi", workspace) ||
		first == piSessionID("room_beta", "agent_pi", workspace) ||
		first == piSessionID("room_alpha", "agent_other", workspace) ||
		first == piSessionID("room_alpha", "agent_pi", t.TempDir()) {
		t.Fatalf("Pi session identity is not stable and scoped: %q", first)
	}
}

func TestInsertPiSessionArgumentsPrecedesOptionTerminator(t *testing.T) {
	arguments := insertPiSessionArguments(
		[]string{"--mode", "json", "--", "literal-message"},
		"--session-id", "session-id",
	)
	expected := []string{"--mode", "json", "--session-id", "session-id", "--", "literal-message"}
	if !slices.Equal(arguments, expected) {
		t.Fatalf("Pi session selector was not inserted before --: %#v", arguments)
	}
}

func TestPiHelperProcess(t *testing.T) {
	if os.Getenv("AGENTROOM_PI_HELPER") == "session" {
		expectedID := piSessionID("room_alpha", "agent_pi", os.Getenv("AGENTROOM_PI_WORKSPACE"))
		expectedName := piSessionName(contracts.RunRequestedPayload{
			RoomID: "room_alpha", TargetAgentName: stringPointer("我的 Pi"),
		})
		if *piHelperSessionID != expectedID || *piHelperSessionName != expectedName {
			os.Exit(3)
		}
		fmt.Println(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Session resumed."}],"stopReason":"stop"}}`)
		os.Exit(0)
	}
	if os.Getenv("AGENTROOM_PI_HELPER") != "stream" {
		return
	}
	text := strings.Repeat("streaming ", 12)
	encoded, err := json.Marshal(text)
	if err != nil {
		os.Exit(2)
	}
	fmt.Println(`{"type":"message_start","message":{"role":"assistant","content":[]}}`)
	fmt.Println(`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":` + string(encoded) + `}}`)
	_ = os.Stdout.Sync()
	time.Sleep(200 * time.Millisecond)
	fmt.Println(`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":` +
		string(encoded) + `}],"stopReason":"stop"}}`)
	os.Exit(0)
}

func stringPointer(value string) *string {
	return &value
}

func TestPiStreamParserBatchesTextAndResetsAfterToolUse(t *testing.T) {
	parser := &piStreamParser{}
	consumePiLine(t, parser, `{"type":"message_start","message":{"role":"assistant","content":[]}}`)
	consumePiLine(t, parser, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"`+
		strings.Repeat("A", 80)+`"}}`)
	first, err := parser.outputDelta(false)
	if err != nil || first == nil || first.Reset || first.Content != strings.Repeat("A", 16) {
		t.Fatalf("unexpected first preview: %#v, %v", first, err)
	}
	consumePiLine(t, parser, `{"type":"message_end","message":{"role":"assistant","content":[`+
		`{"type":"text","text":"`+strings.Repeat("A", 80)+`"},{"type":"toolCall"}],"stopReason":"toolUse"}}`)
	consumePiLine(t, parser, `{"type":"message_start","message":{"role":"assistant","content":[]}}`)
	consumePiLine(t, parser, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"`+
		strings.Repeat("B", 80)+`"}}`)
	second, err := parser.outputDelta(false)
	if err != nil || second == nil || !second.Reset || second.Content != strings.Repeat("B", 16) {
		t.Fatalf("unexpected reset preview: %#v, %v", second, err)
	}
}

func TestPiStreamParserWithholdsSplitSecretsAndAssessment(t *testing.T) {
	parser := &piStreamParser{}
	consumePiLine(t, parser, `{"type":"message_start","message":{"role":"assistant","content":[]}}`)
	text := strings.Repeat("visible ", 12) + "token=very-sensitive-value" +
		strings.Repeat(" trailing", 12) + assessmentOpen + `{"goalSatisfied":true}` + assessmentClose
	consumePiLine(t, parser, `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":`+
		quotedJSON(t, text)+`}}`)
	delta, err := parser.outputDelta(false)
	if err != nil || delta == nil {
		t.Fatalf("expected safe preview: %#v, %v", delta, err)
	}
	if strings.Contains(delta.Content, "very-sensitive") || strings.Contains(delta.Content, "agentroom-assessment") {
		t.Fatalf("private content escaped preview: %q", delta.Content)
	}
}

func TestPiAdapterRejectsProviderToolProtocolLeak(t *testing.T) {
	leaked := `I will inspect the repository.<]minimax[><tool_call>` +
		`<tool_name>bash</tool_name><parameters><command>ls</command></parameters></tool_call>`
	output := `{"type":"message_end","message":{"role":"assistant","content":[` +
		`{"type":"text","text":` + quotedJSON(t, leaked) + `}],"stopReason":"stop"}}`
	events := executePiFixture(t, output)
	if len(events) != 2 || events[1].Status == nil || *events[1].Status != contracts.Failed ||
		events[1].Error == nil || events[1].Error.Code != "RUNTIME_PROTOCOL_INVALID" ||
		events[1].Error.Details["category"] != "model" {
		t.Fatalf("unexpected Pi protocol failure: %#v", events)
	}
	for _, event := range events {
		if event.Reply != "" ||
			(event.Error != nil && strings.Contains(event.Error.Message, "minimax")) {
			t.Fatalf("provider protocol content escaped the adapter: %#v", events)
		}
	}
}

func TestPiAdapterRejectsMalformedOrMissingAssistantEvents(t *testing.T) {
	for name, output := range map[string]string{
		"malformed":    `{not-json}`,
		"no assistant": `{"type":"message_end","message":{"role":"user","content":[]}}`,
		"unfinished tool call": `{"type":"message_end","message":{"role":"assistant","content":[` +
			`{"type":"text","text":"I will inspect it."},{"type":"toolCall"}],"stopReason":"toolUse"}}`,
	} {
		t.Run(name, func(t *testing.T) {
			events := executePiFixture(t, output)
			terminal := events[len(events)-1]
			if terminal.Status == nil || *terminal.Status != contracts.Failed ||
				terminal.Error == nil || terminal.Error.Code != "RUNTIME_PROTOCOL_INVALID" {
				t.Fatalf("unexpected terminal event: %#v", terminal)
			}
		})
	}
}

func executePiFixture(t *testing.T, output string) []Event {
	t.Helper()
	adapter := PiAdapter{Config: config.AgentConfig{
		Command: []string{"/usr/bin/printf", "%s", output}, Workspace: t.TempDir(),
	}}
	var events []Event
	if err := adapter.Execute(context.Background(), Request{}, func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return events
}

func quotedJSON(t *testing.T, value string) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func consumePiLine(t *testing.T, parser *piStreamParser, line string) bool {
	t.Helper()
	final, err := parser.consume([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	return final
}
