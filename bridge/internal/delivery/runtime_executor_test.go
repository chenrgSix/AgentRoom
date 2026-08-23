package delivery

import (
	"context"
	"strings"
	"testing"
	"time"

	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

func TestRuntimeExecutorPersistsAndSequencesEvents(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	request := contracts.RunRequestedPayload{
		RunID: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6", TargetAgentID: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
		DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5W6", IdempotencyKey: "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
	}
	record, _, err := inbox.Accept(request, now)
	if err != nil {
		t.Fatal(err)
	}
	working := contracts.Working
	completed := contracts.Completed
	goalSatisfied := true
	adapter := &bridgeruntime.FakeAdapter{}
	if err := adapter.Enqueue(bridgeruntime.FakeScript{Events: []bridgeruntime.Event{
		{Status: &working}, {
			Reply:      "done token=very-sensitive-value",
			Assessment: &contracts.Assessment{GoalSatisfied: &goalSatisfied},
		}, {Status: &completed},
	}}); err != nil {
		t.Fatal(err)
	}
	executor := RuntimeExecutor{
		Inbox: inbox, Now: func() time.Time { return now },
		Adapters: map[string]bridgeruntime.Adapter{request.TargetAgentID: adapter},
	}
	var sent []any
	if err := executor.Execute(context.Background(), record, func(_ context.Context, value any) error {
		sent = append(sent, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 3 {
		t.Fatalf("sent %d events, want 3", len(sent))
	}
	reply, ok := sent[1].(contracts.RunReplyMessage)
	if !ok || reply.Payload.Assessment == nil ||
		reply.Payload.Assessment.GoalSatisfied == nil ||
		!*reply.Payload.Assessment.GoalSatisfied {
		t.Fatalf("assessment was not transported: %#v", sent[1])
	}
	latest, err := inbox.Get(request.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.State != StateCompleted || latest.LastSequence != 4 {
		t.Fatalf("unexpected persisted record: %#v", latest)
	}
	for _, event := range latest.Events {
		if strings.Contains(string(event), "very-sensitive") {
			t.Fatalf("secret persisted in durable Bridge event: %s", event)
		}
	}
}

func TestRuntimeExecutorRecoversUnfinishedRunAsUnknown(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	request := contracts.RunRequestedPayload{
		RunID: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W7", TargetAgentID: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
		DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5W7", IdempotencyKey: "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
	}
	record, _, err := inbox.Accept(request, now)
	if err != nil {
		t.Fatal(err)
	}
	working := contracts.RunStatusMessage{
		ProtocolVersion: "1.0", Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{RunID: record.RunID, AgentID: request.TargetAgentID, Sequence: 2, Status: contracts.Working},
	}
	if _, err := inbox.AppendEvent(record.RunID, StateWorking, 2, working, now); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(inbox.directory)
	if err != nil {
		t.Fatal(err)
	}
	executor := RuntimeExecutor{Inbox: reopened, Now: func() time.Time { return now }}
	var replayed []any
	if err := executor.Recover(context.Background(), func(_ context.Context, value any) error {
		replayed = append(replayed, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	latest, err := reopened.Get(record.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.State != StateOutcomeUnknown || latest.LastSequence != 3 || len(replayed) != 3 {
		t.Fatalf("unexpected recovery: record=%#v replayed=%d", latest, len(replayed))
	}
}
