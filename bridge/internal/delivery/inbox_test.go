package delivery

import (
	"context"
	"testing"
	"time"

	contracts "agentroom.dev/contracts/generated/go"
)

func TestDuplicateDeliveryIsAcknowledgedButRunsOnce(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	runCount := 0
	ackCount := 0
	handler := Handler{
		Inbox: inbox,
		OnNew: func(context.Context, Record, Sender) error {
			runCount++
			return nil
		},
		Now: func() time.Time { return time.Date(2026, 8, 22, 10, 0, 0, 0, time.UTC) },
	}
	message := contracts.RunRequestedMessage{Payload: contracts.RunRequestedPayload{
		RunID:             "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
		TargetAgentID:     "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
		DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
		IdempotencyKey:    "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
	}}
	send := func(context.Context, any) error { ackCount++; return nil }
	if err := handler.Handle(context.Background(), message, send); err != nil {
		t.Fatal(err)
	}
	if err := handler.Handle(context.Background(), message, send); err != nil {
		t.Fatal(err)
	}
	if runCount != 1 || ackCount != 2 {
		t.Fatalf("runCount=%d ackCount=%d", runCount, ackCount)
	}
	reopened, err := Open(inbox.directory)
	if err != nil {
		t.Fatal(err)
	}
	if _, duplicate, err := reopened.Accept(message.Payload, time.Now()); err != nil || !duplicate {
		t.Fatalf("restart did not preserve deduplication: duplicate=%v err=%v", duplicate, err)
	}
}
