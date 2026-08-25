package delivery

import (
	"context"
	"os"
	"path/filepath"
	"strings"
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
		TraceID:           "trace_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
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

func TestInboxRejectsNewRunsWithoutTraceIdentity(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, traceID := range []string{"", " \t\n", "trace_invalid!"} {
		request := contracts.RunRequestedPayload{
			RunID:             "run_01K4Z6J7Y8N9P0Q1R2S3T4TRACE",
			TraceID:           traceID,
			TargetAgentID:     "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
			DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
			IdempotencyKey:    "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
		}
		if _, _, err := inbox.Accept(request, time.Now()); err == nil {
			t.Fatalf("accepted a new Run with trace ID %q", traceID)
		}
	}
}

func TestInboxRejectsUnsafeRunIdentity(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, runID := range []string{"run_short", "run_/abcdefg", "room_01K4Z6J7Y8N9P0Q1R2S3T4V5W6"} {
		request := contracts.RunRequestedPayload{
			RunID: runID, TraceID: "trace_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
			TargetAgentID:     "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
			DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
			IdempotencyKey:    "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
		}
		if _, _, err := inbox.Accept(request, time.Now()); err == nil {
			t.Fatalf("accepted unsafe Run ID %q", runID)
		}
	}
}

func TestInboxAcceptsBase64URLIdentifiersWithLeadingSymbols(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for index, identifiers := range []struct {
		runID   string
		traceID string
	}{
		{runID: "run_-abcdefg", traceID: "trace__abcdefg"},
		{runID: "run__abcdefg", traceID: "trace_-abcdefg"},
	} {
		request := contracts.RunRequestedPayload{
			RunID: identifiers.runID, TraceID: identifiers.traceID,
			TargetAgentID:     "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
			DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
			IdempotencyKey:    "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5W6_" + string(rune('a'+index)),
		}
		if _, duplicate, err := inbox.Accept(request, time.Now()); err != nil || duplicate {
			t.Fatalf("base64url identifiers were rejected: duplicate=%v err=%v", duplicate, err)
		}
	}
}

func TestInboxOpenProtectsDirectoryAndListRejectsUnsafeEntries(t *testing.T) {
	t.Run("directory permissions", func(t *testing.T) {
		directory := filepath.Join(t.TempDir(), "inbox")
		if err := os.Mkdir(directory, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(directory); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(directory)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o700 {
			t.Fatalf("inbox mode=%#o, want 0700", info.Mode().Perm())
		}
	})

	t.Run("filename identity mismatch", func(t *testing.T) {
		inbox, err := Open(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		record := Record{
			RunID: "run_record_identity", IdempotencyKey: "idem_record_identity",
			Request: contracts.RunRequestedPayload{
				RunID: "run_record_identity", TraceID: "trace_record_identity",
				TargetAgentID: "agent_record_identity",
			},
			State: StateCompleted,
		}
		if err := writeNew(inbox.path("run_filename_identity"), record); err != nil {
			t.Fatal(err)
		}
		if _, err := inbox.List(); err == nil || !strings.Contains(err.Error(), "filename does not match") {
			t.Fatalf("unexpected filename mismatch result: %v", err)
		}
	})

	t.Run("symbolic link", func(t *testing.T) {
		root := t.TempDir()
		inbox, err := Open(filepath.Join(root, "inbox"))
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(root, "outside.json")
		if err := os.WriteFile(target, []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, inbox.path("run_symbolic_link")); err != nil {
			t.Fatal(err)
		}
		if _, err := inbox.List(); err == nil || !strings.Contains(err.Error(), "symbolic link") {
			t.Fatalf("unexpected symbolic-link result: %v", err)
		}
	})
}
