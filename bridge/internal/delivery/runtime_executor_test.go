package delivery

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agentroom.dev/bridge/internal/operations"
	bridgeruntime "agentroom.dev/bridge/internal/runtime"
	contracts "agentroom.dev/contracts/generated/go"
)

func rawRunEvent(t *testing.T, value any) json.RawMessage {
	t.Helper()
	source, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return json.RawMessage(source)
}

func TestRuntimeExecutorPersistsAndSequencesEvents(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	request := contracts.RunRequestedPayload{
		RunID: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6", TargetAgentID: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
		TraceID:           "trace_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
		DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5W6", IdempotencyKey: "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
	}
	record, _, err := inbox.Accept(request, now)
	if err != nil {
		t.Fatal(err)
	}
	working := contracts.Working
	completed := contracts.Completed
	session := &contracts.LogicalSessionStatus{
		Disposition: contracts.Resumed, ContextCursor: 42,
	}
	goalSatisfied := true
	adapter := &bridgeruntime.FakeAdapter{}
	if err := adapter.Enqueue(bridgeruntime.FakeScript{Events: []bridgeruntime.Event{
		{Status: &working}, {
			Activity: &bridgeruntime.Activity{
				ID: "reasoning-1", Kind: "reasoning", Phase: "updated",
				Label: "Thinking", Content: "checking token=very-sensitive-value",
			},
		}, {
			Output: &bridgeruntime.OutputDelta{Content: "working token=very-sensitive-value"},
		}, {
			Reply:      "done token=very-sensitive-value",
			Assessment: &contracts.Assessment{GoalSatisfied: &goalSatisfied},
		}, {Status: &completed, Session: session},
	}}); err != nil {
		t.Fatal(err)
	}
	var runtimeEvents []operations.RuntimeEvent
	executor := RuntimeExecutor{
		Inbox: inbox, Now: func() time.Time { return now },
		Adapters: map[string]bridgeruntime.Adapter{request.TargetAgentID: adapter},
		Observer: operations.Observer{OnRuntime: func(event operations.RuntimeEvent) {
			runtimeEvents = append(runtimeEvents, event)
		}},
	}
	var sent []any
	if err := executor.Execute(context.Background(), record, func(_ context.Context, value any) error {
		sent = append(sent, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 5 {
		t.Fatalf("sent %d events, want 5", len(sent))
	}
	if len(runtimeEvents) != 2 || runtimeEvents[0].ActiveDelta != 1 ||
		runtimeEvents[1].ActiveDelta != -1 || runtimeEvents[1].State != operations.RuntimeIdle ||
		runtimeEvents[1].LastStatus != string(contracts.Completed) || runtimeEvents[1].ErrorCode != "" {
		t.Fatalf("unexpected local Runtime projection: %#v", runtimeEvents)
	}
	activity, ok := sent[1].(contracts.RunActivityMessage)
	if !ok || activity.Payload.Content == nil ||
		strings.Contains(*activity.Payload.Content, "very-sensitive") {
		t.Fatalf("activity was not safely transported: %#v", sent[1])
	}
	output, ok := sent[2].(contracts.RunOutputDeltaMessage)
	if !ok || strings.Contains(output.Payload.Content, "very-sensitive") {
		t.Fatalf("output delta was not safely transported: %#v", sent[2])
	}
	reply, ok := sent[3].(contracts.RunReplyMessage)
	if !ok || reply.Payload.Assessment == nil ||
		reply.Payload.Assessment.GoalSatisfied == nil ||
		!*reply.Payload.Assessment.GoalSatisfied {
		t.Fatalf("assessment was not transported: %#v", sent[3])
	}
	terminal, ok := sent[4].(contracts.RunStatusMessage)
	if !ok || terminal.Payload.Session == nil ||
		terminal.Payload.Session.Disposition != contracts.Resumed ||
		terminal.Payload.Session.ContextCursor != 42 {
		t.Fatalf("logical Task Session status was not transported: %#v", sent[4])
	}
	latest, err := inbox.Get(request.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.State != StateCompleted || latest.LastSequence != 6 {
		t.Fatalf("unexpected persisted record: %#v", latest)
	}
	for _, event := range latest.Events {
		if strings.Contains(string(event), "very-sensitive") {
			t.Fatalf("secret persisted in durable Bridge event: %s", event)
		}
	}
	var replayed []any
	if err := executor.Replay(context.Background(), latest, func(_ context.Context, value any) error {
		replayed = append(replayed, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(replayed) != 5 {
		t.Fatalf("replayed %d events, want 5", len(replayed))
	}
	rawOutput, ok := replayed[1].(json.RawMessage)
	var replayEnvelope struct {
		Type string `json:"type"`
	}
	if !ok || json.Unmarshal(rawOutput, &replayEnvelope) != nil ||
		replayEnvelope.Type != string(contracts.RunActivity) {
		t.Fatalf("replay omitted activity: %#v", replayed)
	}
}

func TestRuntimeExecutorCanceledProjectionIsIdleWithoutError(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	request := contracts.RunRequestedPayload{
		RunID: "run_01K4Z6J7Y8N9P0Q1R2S3T4V5X1", TargetAgentID: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5X1",
		TraceID:           "trace_01K4Z6J7Y8N9P0Q1R2S3T4V5X1",
		DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5X1", IdempotencyKey: "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5X1",
	}
	record, _, err := inbox.Accept(request, now)
	if err != nil {
		t.Fatal(err)
	}
	canceled := contracts.Canceled
	adapter := &bridgeruntime.FakeAdapter{}
	if err := adapter.Enqueue(bridgeruntime.FakeScript{Events: []bridgeruntime.Event{{Status: &canceled}}}); err != nil {
		t.Fatal(err)
	}
	var runtimeEvents []operations.RuntimeEvent
	executor := RuntimeExecutor{
		Inbox: inbox, Now: func() time.Time { return now },
		Adapters: map[string]bridgeruntime.Adapter{request.TargetAgentID: adapter},
		Observer: operations.Observer{OnRuntime: func(event operations.RuntimeEvent) {
			runtimeEvents = append(runtimeEvents, event)
		}},
	}
	if err := executor.Execute(context.Background(), record, func(context.Context, any) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(runtimeEvents) != 2 || runtimeEvents[1].State != operations.RuntimeIdle || runtimeEvents[1].ErrorCode != "" {
		t.Fatalf("unexpected canceled Runtime projection: %#v", runtimeEvents)
	}
}

func TestRuntimeExecutorPersistsClarificationAsRecoverableBoundary(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	request := contracts.RunRequestedPayload{
		RunID: "run_clarification_12345678", TargetAgentID: "agent_clarification_12345678",
		TraceID:           "trace_clarification_12345678",
		DeliveryAttemptID: "delivery_clarification_12345678",
		IdempotencyKey:    "idem_clarification_12345678",
	}
	record, _, err := inbox.Accept(request, now)
	if err != nil {
		t.Fatal(err)
	}
	working := contracts.Working
	inputRequired := contracts.InputRequired
	adapter := &bridgeruntime.FakeAdapter{}
	if err := adapter.Enqueue(bridgeruntime.FakeScript{Events: []bridgeruntime.Event{
		{Status: &working},
		{Status: &inputRequired, Clarification: &contracts.TaskClarificationRequest{
			Kind: contracts.Task, Question: "Which region?", Choices: []string{"EU", "US"},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	var runtimeEvents []operations.RuntimeEvent
	executor := RuntimeExecutor{
		Inbox: inbox, Now: func() time.Time { return now },
		Adapters: map[string]bridgeruntime.Adapter{request.TargetAgentID: adapter},
		Observer: operations.Observer{OnRuntime: func(event operations.RuntimeEvent) {
			runtimeEvents = append(runtimeEvents, event)
		}},
	}
	var sent []any
	if err := executor.Execute(context.Background(), record, func(_ context.Context, value any) error {
		sent = append(sent, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	status, ok := sent[1].(contracts.RunStatusMessage)
	if len(sent) != 2 || !ok || status.Payload.Clarification == nil ||
		status.Payload.Clarification.Question != "Which region?" ||
		len(runtimeEvents) != 2 || runtimeEvents[1].State != operations.RuntimeIdle ||
		runtimeEvents[1].ErrorCode != "" {
		t.Fatalf("Task clarification was not projected safely: sent=%#v runtime=%#v", sent, runtimeEvents)
	}
	latest, err := inbox.Get(request.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.State != StateInputRequired || latest.LastSequence != 3 {
		t.Fatalf("clarification boundary was not durable: %#v", latest)
	}
	var replayed []any
	if err := executor.Recover(context.Background(), func(_ context.Context, value any) error {
		replayed = append(replayed, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if after, _ := inbox.Get(request.RunID); after.LastSequence != 3 || len(replayed) != 3 {
		t.Fatalf("recovery replaced Task clarification with an unknown outcome: %#v %#v", after, replayed)
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
		TraceID:           "trace_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
		DeliveryAttemptID: "delivery_01K4Z6J7Y8N9P0Q1R2S3T4V5W7", IdempotencyKey: "idem_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
	}
	record, _, err := inbox.Accept(request, now)
	if err != nil {
		t.Fatal(err)
	}
	working := contracts.RunStatusMessage{
		ProtocolVersion: "1.0", Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{RunID: record.RunID, TraceID: request.TraceID, AgentID: request.TargetAgentID, Sequence: 2, Status: contracts.Working},
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

func TestRuntimeExecutorQuarantinesTerminalIncompatibleRecordsAndRecoversValidRecords(t *testing.T) {
	directory := t.TempDir()
	inbox, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	legacyRecords := []Record{{
		RunID: "run_legacy_terminal", IdempotencyKey: "idem_legacy_terminal",
		Request: contracts.RunRequestedPayload{
			RunID: "run_legacy_terminal", TargetAgentID: "agent_legacy_terminal",
		},
		State: StateCompleted, LastSequence: 4, AcceptedAt: now, UpdatedAt: now,
	}, {
		RunID: "run_terminal_missing_trace", IdempotencyKey: "idem_terminal_missing_trace",
		Request: contracts.RunRequestedPayload{
			RunID: "run_terminal_missing_trace", TraceID: "trace_terminal_missing_trace",
			TargetAgentID: "agent_terminal_missing_trace",
		},
		State: StateOutcomeUnknown, LastSequence: 2, AcceptedAt: now, UpdatedAt: now,
		Events: []json.RawMessage{rawRunEvent(t, contracts.RunStatusMessage{
			ProtocolVersion: "1.0", Type: contracts.RunStatus,
			Payload: contracts.RunStatusPayload{
				RunID: "run_terminal_missing_trace", AgentID: "agent_terminal_missing_trace",
				Sequence: 2, Status: contracts.OutcomeUnknown,
			},
		})},
	}, {
		RunID: "run_terminal_mismatch", IdempotencyKey: "idem_terminal_mismatch",
		Request: contracts.RunRequestedPayload{
			RunID: "run_terminal_mismatch", TraceID: "trace_terminal_mismatch",
			TargetAgentID: "agent_terminal_mismatch",
		},
		State: StateFailed, LastSequence: 2, AcceptedAt: now, UpdatedAt: now,
		Events: []json.RawMessage{rawRunEvent(t, contracts.RunReplyMessage{
			ProtocolVersion: "1.0", Type: contracts.RunReply,
			Payload: contracts.RunReplyPayload{
				RunID: "run_terminal_mismatch", TraceID: "trace_other_mismatch",
				AgentID: "agent_terminal_mismatch", Sequence: 2, Content: "mismatch",
			},
		})},
	}}
	for _, record := range legacyRecords {
		if err := writeNew(inbox.path(record.RunID), record); err != nil {
			t.Fatal(err)
		}
	}
	validRequest := contracts.RunRequestedPayload{
		RunID: "run_valid_trace", TraceID: "trace_valid_recovery",
		TargetAgentID: "agent_valid_trace", DeliveryAttemptID: "delivery_valid_trace",
		IdempotencyKey: "idem_valid_trace",
	}
	valid, _, err := inbox.Accept(validRequest, now)
	if err != nil {
		t.Fatal(err)
	}
	working := contracts.RunStatusMessage{
		ProtocolVersion: "1.0", Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID: valid.RunID, TraceID: validRequest.TraceID,
			AgentID: validRequest.TargetAgentID, Sequence: 2, Status: contracts.Working,
		},
	}
	if _, err := inbox.AppendEvent(valid.RunID, StateWorking, 2, working, now); err != nil {
		t.Fatal(err)
	}
	reply := contracts.RunReplyMessage{
		ProtocolVersion: "1.0", Type: contracts.RunReply,
		Payload: contracts.RunReplyPayload{
			RunID: valid.RunID, TraceID: validRequest.TraceID,
			AgentID: validRequest.TargetAgentID, Sequence: 3, Content: "valid replay",
		},
	}
	if _, err := inbox.AppendEvent(valid.RunID, StateWorking, 3, reply, now); err != nil {
		t.Fatal(err)
	}
	handoff := contracts.RunHandoffRequestedMessage{
		ProtocolVersion: "1.0", Type: contracts.RunHandoffRequested,
		Payload: contracts.RunHandoffRequestedPayload{
			RunID: valid.RunID, TraceID: validRequest.TraceID,
			AgentID: validRequest.TargetAgentID, Sequence: 4,
			HandoffID: "handoff_valid_recovery", TargetAgentID: "agent_valid_target",
			Summary: "valid handoff replay",
		},
	}
	if _, err := inbox.AppendEvent(valid.RunID, StateWorking, 4, handoff, now); err != nil {
		t.Fatal(err)
	}
	completed := contracts.RunStatusMessage{
		ProtocolVersion: "1.0", Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID: valid.RunID, TraceID: validRequest.TraceID,
			AgentID: validRequest.TargetAgentID, Sequence: 5, Status: contracts.Completed,
		},
	}
	if _, err := inbox.AppendEvent(valid.RunID, StateCompleted, 5, completed, now); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	var sent []any
	if err := (RuntimeExecutor{Inbox: reopened, Now: func() time.Time { return now }}).Recover(
		context.Background(),
		func(_ context.Context, value any) error {
			sent = append(sent, value)
			return nil
		},
	); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 5 {
		t.Fatalf("sent %d valid recovery messages, want 5", len(sent))
	}
	for _, value := range sent {
		source, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Payload struct {
				RunID   string `json:"runId"`
				TraceID string `json:"traceId"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(source, &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Payload.RunID != valid.RunID || envelope.Payload.TraceID != validRequest.TraceID {
			t.Fatalf("unexpected recovery message: %s", source)
		}
	}
	quarantineDirectory := filepath.Join(directory, incompatibleTraceQuarantineDirectory)
	info, err := os.Stat(quarantineDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("quarantine mode=%#o, want 0700", info.Mode().Perm())
	}
	for _, legacy := range legacyRecords {
		if _, err := os.Stat(reopened.path(legacy.RunID)); !os.IsNotExist(err) {
			t.Fatalf("legacy record remains active: %s", legacy.RunID)
		}
		quarantinedPath := filepath.Join(quarantineDirectory, legacy.RunID+".json")
		quarantined, err := reopened.load(quarantinedPath)
		if err != nil {
			t.Fatal(err)
		}
		if quarantined.RunID != legacy.RunID || quarantined.State != legacy.State {
			t.Fatalf("quarantine changed record: %#v", quarantined)
		}
		fileInfo, err := os.Stat(quarantinedPath)
		if err != nil {
			t.Fatal(err)
		}
		if fileInfo.Mode().Perm() != 0o600 {
			t.Fatalf("quarantined record mode=%#o, want 0600", fileInfo.Mode().Perm())
		}
	}
	remaining, err := reopened.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(remaining) != 1 || remaining[0].RunID != valid.RunID {
		t.Fatalf("unexpected active inbox after recovery: %#v", remaining)
	}
	var repeated []any
	if err := (RuntimeExecutor{Inbox: reopened, Now: func() time.Time { return now }}).Recover(
		context.Background(),
		func(_ context.Context, value any) error {
			repeated = append(repeated, value)
			return nil
		},
	); err != nil {
		t.Fatal(err)
	}
	if len(repeated) != 5 {
		t.Fatalf("repeated recovery sent %d valid messages, want 5", len(repeated))
	}
	quarantinedEntries, err := os.ReadDir(quarantineDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if len(quarantinedEntries) != len(legacyRecords) {
		t.Fatalf("repeated recovery duplicated quarantine records: %d", len(quarantinedEntries))
	}
}

func TestRuntimeExecutorRejectsActiveIncompatibleMetadataBeforeSending(t *testing.T) {
	now := time.Date(2026, 8, 23, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		record Record
	}{
		{
			name: "bad nonempty request trace",
			record: Record{
				RunID: "run_active_bad_trace", IdempotencyKey: "idem_active_bad_trace",
				Request: contracts.RunRequestedPayload{
					RunID: "run_active_bad_trace", TraceID: "trace_invalid!",
					TargetAgentID: "agent_active_bad_trace",
				},
				State: StateAccepted, LastSequence: 1, AcceptedAt: now, UpdatedAt: now,
			},
		},
		{
			name: "missing event trace",
			record: Record{
				RunID: "run_active_missing_event", IdempotencyKey: "idem_active_missing_event",
				Request: contracts.RunRequestedPayload{
					RunID: "run_active_missing_event", TraceID: "trace_active_missing_event",
					TargetAgentID: "agent_active_missing_event",
				},
				State: StateWorking, LastSequence: 2, AcceptedAt: now, UpdatedAt: now,
				Events: []json.RawMessage{rawRunEvent(t, contracts.RunStatusMessage{
					ProtocolVersion: "1.0", Type: contracts.RunStatus,
					Payload: contracts.RunStatusPayload{
						RunID: "run_active_missing_event", AgentID: "agent_active_missing_event",
						Sequence: 2, Status: contracts.Working,
					},
				})},
			},
		},
		{
			name: "mismatched event identity",
			record: Record{
				RunID: "run_active_mismatch", IdempotencyKey: "idem_active_mismatch",
				Request: contracts.RunRequestedPayload{
					RunID: "run_active_mismatch", TraceID: "trace_active_mismatch",
					TargetAgentID: "agent_active_mismatch",
				},
				State: StateWorking, LastSequence: 2, AcceptedAt: now, UpdatedAt: now,
				Events: []json.RawMessage{rawRunEvent(t, contracts.RunReplyMessage{
					ProtocolVersion: "1.0", Type: contracts.RunReply,
					Payload: contracts.RunReplyPayload{
						RunID: "run_other_mismatch", TraceID: "trace_other_mismatch",
						AgentID: "agent_active_mismatch", Sequence: 2, Content: "mismatch",
					},
				})},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			directory := t.TempDir()
			inbox, err := Open(directory)
			if err != nil {
				t.Fatal(err)
			}
			validRequest := contracts.RunRequestedPayload{
				RunID: "run_00000000_valid", TraceID: "trace_00000000_valid",
				TargetAgentID: "agent_00000000_valid", DeliveryAttemptID: "delivery_00000000_valid",
				IdempotencyKey: "idem_00000000_valid",
			}
			if _, _, err := inbox.Accept(validRequest, now); err != nil {
				t.Fatal(err)
			}
			if err := writeNew(inbox.path(test.record.RunID), test.record); err != nil {
				t.Fatal(err)
			}
			var sent []any
			err = (RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now }}).Recover(
				context.Background(),
				func(_ context.Context, value any) error {
					sent = append(sent, value)
					return nil
				},
			)
			if err == nil || !strings.Contains(err.Error(), "active inbox record has incompatible trace metadata") {
				t.Fatalf("unexpected active incompatibility error: %v", err)
			}
			if len(sent) != 0 {
				t.Fatalf("sent %d messages before active incompatibility failed", len(sent))
			}
			if _, err := os.Stat(inbox.path(test.record.RunID)); err != nil {
				t.Fatalf("active incompatible record moved: %v", err)
			}
			if _, err := os.Stat(filepath.Join(directory, incompatibleTraceQuarantineDirectory)); !os.IsNotExist(err) {
				t.Fatalf("active incompatible record created quarantine: %v", err)
			}
		})
	}
}
