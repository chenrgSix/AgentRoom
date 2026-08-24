package runtime

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

func TestPiAdapterExtractsFinalAssistantReplyAndAssessment(t *testing.T) {
	output := strings.Join([]string{
		`{"type":"session","version":3}`,
		`{"type":"message_start","message":{"role":"assistant","content":[]}}`,
		`{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Useful review.\n<agentroom-assessment>{\"goalSatisfied\":true,\"confidence\":0.9}</agentroom-assessment>"}],"stopReason":"stop"}}`,
	}, "\n")
	events := executePiFixture(t, output)
	if len(events) != 3 || events[1].Reply != "Useful review." ||
		events[1].Assessment == nil || events[1].Assessment.GoalSatisfied == nil ||
		!*events[1].Assessment.GoalSatisfied || events[2].Status == nil ||
		*events[2].Status != contracts.Completed {
		t.Fatalf("unexpected Pi events: %#v", events)
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
