package delivery

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

func reasoningConsentFixture(t *testing.T, share bool) (RuntimeExecutor, Record) {
	t.Helper()
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	record, _, err := inbox.Accept(contracts.RunRequestedPayload{
		RunID: "run_consent123", TargetAgentID: "agent_consent123", TraceID: "trace_consent123",
		DeliveryAttemptID: "delivery_consent123", IdempotencyKey: "idem_consent123",
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	working, completed := contracts.Working, contracts.Completed
	adapter := &bridgeruntime.FakeAdapter{}
	if err := adapter.Enqueue(bridgeruntime.FakeScript{Events: []bridgeruntime.Event{
		{Status: &working},
		{Activity: &bridgeruntime.Activity{ID: "sensitive-activity-id", Kind: "reasoning", Phase: "updated", Label: "private label", Content: "PRIVATE_SUMMARY_MARKER"}},
		{Activity: &bridgeruntime.Activity{ID: "sensitive-activity-id", Kind: "reasoning", Phase: "completed", Label: "private label"}},
		{Activity: &bridgeruntime.Activity{ID: "tool-safe", Kind: "tool", Phase: "completed", Label: "Read"}},
		{Output: &bridgeruntime.OutputDelta{Content: "public output"}},
		{Reply: "public reply"},
		{Status: &completed},
	}}); err != nil {
		t.Fatal(err)
	}
	return RuntimeExecutor{Inbox: inbox, Adapters: map[string]bridgeruntime.Adapter{record.Request.TargetAgentID: adapter}, ShareReasoningSummaries: share}, record
}

func TestRuntimeExecutorWithholdsReasoningBeforePersistenceAndSequenceAllocation(t *testing.T) {
	executor, record := reasoningConsentFixture(t, false)
	var sent []json.RawMessage
	if err := executor.Execute(context.Background(), record, func(_ context.Context, value any) error {
		source, err := json.Marshal(value)
		sent = append(sent, source)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	stored, err := executor.Inbox.Get(record.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.State != StateCompleted || stored.LastSequence != 6 || len(stored.Events) != 5 || len(sent) != 5 {
		t.Fatalf("withholding changed output or sequence: %#v", stored)
	}
	for index, source := range stored.Events {
		var event struct {
			Payload struct {
				Sequence int64
				Kind     string
			}
		}
		if err := json.Unmarshal(source, &event); err != nil {
			t.Fatal(err)
		}
		if event.Payload.Sequence != int64(index+2) || event.Payload.Kind == "reasoning" || strings.Contains(string(source), "PRIVATE_SUMMARY_MARKER") {
			t.Fatalf("unconsented activity persisted or sequence skipped: %s", source)
		}
		var persisted, transported any
		if err := json.Unmarshal(source, &persisted); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(sent[index], &transported); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(persisted, transported) {
			t.Fatal("sent and persisted events differ")
		}
	}
}

func TestRuntimeExecutorRecoveryMasksPreviouslyStoredSummariesWithoutSequenceGaps(t *testing.T) {
	executor, record := reasoningConsentFixture(t, true)
	if err := executor.Execute(context.Background(), record, func(context.Context, any) error { return nil }); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(executor.Inbox.directory)
	if err != nil {
		t.Fatal(err)
	}
	executor.Inbox = reopened
	executor.ShareReasoningSummaries = false
	var sent []json.RawMessage
	if err := executor.Recover(context.Background(), func(_ context.Context, value any) error {
		source, err := json.Marshal(value)
		sent = append(sent, source)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 8 {
		t.Fatalf("recovery lost events: %d", len(sent))
	}
	masked := 0
	for index, source := range sent {
		var event struct {
			Type    string
			Payload struct {
				Sequence   int64
				Kind       string
				Content    *string
				Label      *string
				ActivityID string
			}
		}
		if err := json.Unmarshal(source, &event); err != nil {
			t.Fatal(err)
		}
		if event.Payload.Sequence != int64(index+1) {
			t.Fatalf("replay skipped a sequence: %s", source)
		}
		for _, forbidden := range []string{"PRIVATE_SUMMARY_MARKER", "private label", "sensitive-activity-id"} {
			if strings.Contains(string(source), forbidden) {
				t.Fatalf("recovery leaked %s", forbidden)
			}
		}
		if event.Payload.Kind == "reasoning" {
			masked++
			if event.Payload.Content != nil || event.Payload.Label == nil || *event.Payload.Label != "Summary sharing disabled" {
				t.Fatalf("invalid private placeholder: %s", source)
			}
		}
	}
	if masked != 2 {
		t.Fatalf("expected two sequence-preserving placeholders, got %d", masked)
	}
	stored, err := reopened.Get(record.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(stored.Events[1]), "PRIVATE_SUMMARY_MARKER") {
		t.Fatal("local history was rewritten")
	}
}
