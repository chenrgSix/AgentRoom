package runtime

import (
	"context"
	"strings"
	"testing"

	"agentroom.dev/bridge/internal/config"
	contracts "agentroom.dev/contracts/generated/go"
)

func roomContextFixture() contracts.RunRequestedPayload {
	taskID := "task_room_context"
	sequence41 := int64(41)
	sequence42 := int64(42)
	return contracts.RunRequestedPayload{
		RunID: "run_room_context", RoomID: "room_context",
		TaskID: &taskID, TargetAgentID: "agent_context",
		TriggerMessageID: "msg_current_12345678",
		Instruction:      "Handle the current request exactly once.",
		Session: &contracts.LogicalSessionRequest{
			Scope: contracts.Task, ResumePolicy: contracts.ResumeOrStart,
			ContextCursor: 43,
		},
		ContextMessages: []contracts.ContextMessage{},
		RoomContextBundle: &contracts.ServerRoomContextBundle{
			TargetThroughSequence:       43,
			PriorContextThroughSequence: 42,
			RequestMessageID:            "msg_current_12345678",
			Checkpoint: &contracts.RollingRoomCheckpoint{
				CheckpointID:          "checkpoint_room_context_12345678",
				FromSequenceExclusive: 0, ThroughSequence: 40,
				Summary:            "The Room selected a compatible wire format.",
				SourceMessageCount: 40, SourceDigest: strings.Repeat("a", 64),
				PromptVersion: "room-memory-v1", ModelFingerprint: "test-model-v1",
				BuildKind:            contracts.Incremental,
				ProvenanceMessageIDS: []string{"msg_provenance_12345678"},
			},
			RawTail: contracts.RoomContextRawTail{
				FromSequenceExclusive: 40, ThroughSequenceInclusive: 42,
				MessageCount: 2, Utf8Bytes: int64(len("message forty-one") + len("message forty-two")),
				Messages: []contracts.Message{
					{MessageID: "msg_context_41_12345678", SenderID: "member_context", Content: "message forty-one", Sequence: &sequence41},
					{MessageID: "msg_context_42_12345678", SenderID: "member_context", Content: "message forty-two", Sequence: &sequence42},
				},
			},
		},
	}
}

func TestRoomContextCoverageSelectsStartedResumedAndRecreatedIntervals(t *testing.T) {
	started, receipt, err := prepareRoomContextForSession(
		roomContextFixture(), RuntimeSessionBinding{}, contracts.Started,
	)
	if err != nil || receipt == nil || receipt.CheckpointID == nil ||
		receipt.RawMessageCount != 2 || receipt.CoverageThroughSequence != 43 {
		t.Fatalf("started coverage was not complete: run=%#v receipt=%#v err=%v", started, receipt, err)
	}
	prompt := runtimePrompt(started)
	for _, expected := range []string{
		"compatible wire format", "message forty-one", "message forty-two",
		"Current request:\nHandle the current request exactly once.",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("started prompt omitted %q: %s", expected, prompt)
		}
	}

	resumed, receipt, err := prepareRoomContextForSession(
		roomContextFixture(), RuntimeSessionBinding{LastRoomSequence: 41}, contracts.Resumed,
	)
	if err != nil || receipt == nil || receipt.CheckpointID != nil ||
		receipt.BaseContextCursor != 41 || receipt.RawFromSequenceExclusive != 41 ||
		receipt.RawMessageCount != 1 || len(resumed.RoomContextBundle.RawTail.Messages) != 1 ||
		resumed.RoomContextBundle.RawTail.Messages[0].Content != "message forty-two" {
		t.Fatalf("resumed coverage delta was wrong: run=%#v receipt=%#v err=%v", resumed, receipt, err)
	}
	resumedPrompt := runtimePrompt(resumed)
	if strings.Contains(resumedPrompt, "compatible wire format") ||
		strings.Contains(resumedPrompt, "message forty-one") ||
		!strings.Contains(resumedPrompt, "message forty-two") {
		t.Fatalf("resumed prompt did not contain the exact delta: %s", resumedPrompt)
	}

	replacement, receipt, err := prepareRoomContextForSession(
		roomContextFixture(), RuntimeSessionBinding{LastRoomSequence: 30}, contracts.Resumed,
	)
	if err != nil || receipt == nil || receipt.CheckpointID == nil ||
		receipt.RawMessageCount != 2 || replacement.RoomContextBundle.Checkpoint == nil {
		t.Fatalf("newer checkpoint did not replace the stale base: receipt=%#v err=%v", receipt, err)
	}

	recreated, receipt, err := prepareRoomContextForSession(
		roomContextFixture(), RuntimeSessionBinding{LastRoomSequence: 99}, contracts.Recreated,
	)
	if err != nil || receipt == nil || receipt.BaseContextCursor != 0 ||
		receipt.CheckpointID == nil || receipt.CoverageThroughSequence != 43 ||
		recreated.RoomContextBundle.Checkpoint == nil {
		t.Fatalf("recreated coverage retained native state: receipt=%#v err=%v", receipt, err)
	}
}

func TestRoomContextCoverageRejectsGapOverlapTruncationAndFutureState(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*contracts.RunRequestedPayload)
	}{
		{"target mismatch", func(run *contracts.RunRequestedPayload) { run.RoomContextBundle.TargetThroughSequence = 44 }},
		{"request overlap", func(run *contracts.RunRequestedPayload) {
			run.ContextMessages = []contracts.ContextMessage{{MessageID: "msg_legacy_overlap", Content: "duplicate"}}
		}},
		{"checkpoint gap", func(run *contracts.RunRequestedPayload) { run.RoomContextBundle.RawTail.FromSequenceExclusive = 39 }},
		{"truncated count", func(run *contracts.RunRequestedPayload) { run.RoomContextBundle.RawTail.MessageCount = 1 }},
		{"wrong bytes", func(run *contracts.RunRequestedPayload) { run.RoomContextBundle.RawTail.Utf8Bytes++ }},
		{"raw gap", func(run *contracts.RunRequestedPayload) { *run.RoomContextBundle.RawTail.Messages[1].Sequence = 43 }},
		{"trigger duplicated", func(run *contracts.RunRequestedPayload) {
			run.RoomContextBundle.RawTail.Messages[1].MessageID = run.TriggerMessageID
		}},
		{"future checkpoint", func(run *contracts.RunRequestedPayload) { run.RoomContextBundle.Checkpoint.ThroughSequence = 43 }},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			run := roomContextFixture()
			testCase.mutate(&run)
			if _, _, err := prepareRoomContextForSession(
				run, RuntimeSessionBinding{}, contracts.Started,
			); err == nil {
				t.Fatal("invalid Room context coverage was accepted")
			}
		})
	}
}

func TestGenericAdapterRejectsCoverageBeforeStartingRuntime(t *testing.T) {
	adapter := GenericAdapter{Config: config.AgentConfig{Command: []string{"must-not-start"}}}
	var events []Event
	if err := adapter.Execute(context.Background(), Request{Run: roomContextFixture()}, func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].Status == nil || *events[0].Status != contracts.Failed ||
		events[0].Error == nil || events[0].Error.Code != "ROOM_CONTEXT_UNSUPPORTED" {
		t.Fatalf("Generic adapter did not fail closed: %#v", events)
	}
}
