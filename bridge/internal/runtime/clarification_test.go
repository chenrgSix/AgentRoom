package runtime

import (
	"strings"
	"testing"

	contracts "convenewire.dev/contracts/generated/go"
)

func TestParseTaskClarificationEnvelope(t *testing.T) {
	visible, clarification := parseTaskClarificationEnvelope(
		`<agentroom-clarification>{"kind":"task","question":"Which region?","choices":["EU","US"]}</agentroom-clarification>`,
	)
	if visible != "" || clarification == nil || clarification.Kind != contracts.Task ||
		clarification.Question != "Which region?" || len(clarification.Choices) != 2 {
		t.Fatalf("unexpected Task clarification: visible=%q value=%#v", visible, clarification)
	}
}

func TestTaskClarificationEnvelopeRejectsApprovalShape(t *testing.T) {
	source := `<agentroom-clarification>{"kind":"task","question":"Run shell?","approvalKind":"shell"}</agentroom-clarification>`
	visible, clarification := parseTaskClarificationEnvelope(source)
	if clarification != nil || visible != source {
		t.Fatalf("approval-shaped envelope crossed Task clarification boundary: %q %#v", visible, clarification)
	}
}

func TestTaskRuntimePromptSeparatesClarificationFromLocalApproval(t *testing.T) {
	taskID := "task_alpha"
	prompt := runtimePrompt(contracts.RunRequestedPayload{
		TaskID: &taskID, Instruction: "Continue the migration.",
	})
	for _, expected := range []string{
		"specific piece of human domain information",
		"agentroom-clarification",
		"filesystem, shell, network, tool, Runtime, or permission approval",
		"those decisions stay local",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("Task prompt omitted %q:\n%s", expected, prompt)
		}
	}
}
