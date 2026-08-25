package runtime

import (
	"strings"
	"testing"

	contracts "agentroom.dev/contracts/generated/go"
)

func TestRuntimePromptProjectsNamedContextAndExactRoutingAgents(t *testing.T) {
	targetName := "Builder"
	alice := "Alice"
	reviewer := "Reviewer"
	prompt := runtimePrompt(contracts.RunRequestedPayload{
		Instruction:      "Implement the queue fix.",
		TriggerMessageID: "msg_trigger_12345678",
		TargetAgentName:  &targetName,
		RoutingAgents: []contracts.RoutingAgent{
			{AgentID: "agent_reviewer_12345678", Name: "Reviewer"},
			{AgentID: "agent_qa_123456789012", Name: "QA Lead"},
		},
		ContextMessages: []contracts.ContextMessage{
			{
				MessageID: "msg_context_12345678", SenderID: "member_alice_12345678",
				SenderName: &alice, Content: "Keep delivery durable.",
			},
			{
				MessageID: "msg_context_23456789", SenderID: "agent_reviewer_12345678",
				SenderName: &reviewer, Content: "Use exact names.",
			},
			{
				MessageID: "msg_trigger_12345678", SenderID: "member_alice_12345678",
				SenderName: &alice, Content: "Implement the queue fix.",
			},
		},
	})
	for _, expected := range []string{
		"Your Agent name is Builder.",
		"Reviewer; QA Lead",
		"prefix one exact full name with @",
		"[Alice]: Keep delivery durable.",
		"[Reviewer]: Use exact names.",
		"Current request:\nImplement the queue fix.",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("prompt omitted %q:\n%s", expected, prompt)
		}
	}
	if strings.Count(prompt, "Implement the queue fix.") != 1 {
		t.Fatalf("trigger was duplicated in context:\n%s", prompt)
	}
	if strings.Contains(prompt, "@Reviewer") || strings.Contains(prompt, "@all") {
		t.Fatalf("prompt template contained an executable mention command:\n%s", prompt)
	}
}

func TestRuntimePromptPreservesLegacyInstructionWithoutProjection(t *testing.T) {
	if prompt := runtimePrompt(contracts.RunRequestedPayload{Instruction: "  hello team  "}); prompt != "hello team" {
		t.Fatalf("unexpected legacy prompt: %q", prompt)
	}
}

func TestTaskSessionContextKeepsOnlyUnconsumedRoomDeltas(t *testing.T) {
	sequence41 := int64(41)
	sequence42 := int64(42)
	sequence43 := int64(43)
	messages := []contracts.ContextMessage{
		{MessageID: "msg_old_12345678", Sequence: &sequence41, Content: "already consumed"},
		{MessageID: "msg_boundary_12345678", Sequence: &sequence42, Content: "at cursor"},
		{MessageID: "msg_new_12345678", Sequence: &sequence43, Content: "new delta"},
		{MessageID: "msg_legacy_12345678", Content: "legacy without sequence"},
	}
	filtered := contextAfterCursor(messages, 42)
	if len(filtered) != 2 || filtered[0].MessageID != "msg_new_12345678" ||
		filtered[1].MessageID != "msg_legacy_12345678" {
		t.Fatalf("Task Session cursor repeated or skipped Room context: %#v", filtered)
	}
}
