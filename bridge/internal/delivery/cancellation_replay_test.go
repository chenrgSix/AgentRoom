package delivery

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	contracts "convenewire.dev/contracts/generated/go"
)

func TestCanceledRunReplayTerminatesMatchingRecordsAndRejectsIdentityDrift(t *testing.T) {
	now := time.Date(2026, time.August, 29, 9, 0, 0, 0, time.UTC)
	tests := []struct {
		name        string
		state       State
		status      contracts.RunExecutionStatus
		cancelTrace string
		wantError   string
		wantStaged  bool
		wantSent    int
	}{
		{
			name:  "non-terminal durable record",
			state: StateWorking, status: contracts.Working,
			cancelTrace: "trace_cancel_fail_closed_12345678",
			wantSent:    3,
		},
		{
			name:  "mismatched cancellation identity",
			state: StateCompleted, status: contracts.Completed,
			cancelTrace: "trace_cancel_different_12345678",
			wantError:   "identity mismatch",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			inbox, err := Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			request := contracts.RunRequestedPayload{
				RunID:          "run_cancel_fail_closed_12345678",
				TraceID:        "trace_cancel_fail_closed_12345678",
				TargetAgentID:  "agent_cancel_fail_closed_12345678",
				IdempotencyKey: "idem_cancel_fail_closed_12345678",
			}
			record, _, err := inbox.Accept(request, now)
			if err != nil {
				t.Fatal(err)
			}
			status := contracts.RunStatusMessage{
				ProtocolVersion: "1.0",
				MessageID:       "msg_cancel_fail_closed_12345678",
				Timestamp:       now,
				Type:            contracts.RunStatus,
				Payload: contracts.RunStatusPayload{
					RunID: record.RunID, TraceID: record.Request.TraceID,
					AgentID: record.Request.TargetAgentID, Sequence: 2,
					Status: test.status,
				},
			}
			if _, err := inbox.AppendEvent(
				record.RunID, test.state, 2, status, now,
			); err != nil {
				t.Fatal(err)
			}
			var sent []any
			err = (RuntimeExecutor{Inbox: inbox}).ReplayCanceledRun(
				context.Background(),
				contracts.RunCancelRequestedMessage{
					ProtocolVersion: "1.0",
					MessageID:       "msg_cancel_fail_signal_12345678",
					Timestamp:       now,
					Type:            contracts.RunCancelRequested,
					Payload: contracts.RunCancelRequestedPayload{
						RunID: record.RunID, TraceID: test.cancelTrace,
						AgentID: record.Request.TargetAgentID, Reason: "retry",
					},
				},
				func(_ context.Context, value any) error {
					sent = append(sent, value)
					return nil
				},
			)
			if test.wantError == "" && err != nil {
				t.Fatalf("ReplayCanceledRun unexpectedly failed: %v", err)
			}
			if test.wantError != "" &&
				(err == nil || !strings.Contains(err.Error(), test.wantError)) {
				t.Fatalf("ReplayCanceledRun error=%v, want %q", err, test.wantError)
			}
			if len(sent) != test.wantSent {
				t.Fatalf("cancellation emitted %d messages, want %d", len(sent), test.wantSent)
			}
			staged, stagedErr := inbox.HasCancellation(record.Request)
			if stagedErr != nil {
				t.Fatal(stagedErr)
			}
			if staged != test.wantStaged {
				t.Fatalf("cancellation staged=%t, want %t", staged, test.wantStaged)
			}
			if test.wantSent > 0 {
				latest, latestErr := inbox.Get(record.RunID)
				if latestErr != nil || latest.State != StateCanceled || latest.LastSequence != 3 {
					t.Fatalf("cancellation did not become durable: %#v err=%v", latest, latestErr)
				}
			}
		})
	}
}

func TestRecoveryConsumesAcceptedCancellationTombstoneBeforePreparation(t *testing.T) {
	now := time.Date(2026, time.August, 29, 9, 30, 0, 0, time.UTC)
	directory := t.TempDir()
	inbox, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	request := contracts.RunRequestedPayload{
		RunID:          "run_cancel_recover_cut_12345678",
		TraceID:        "trace_cancel_recover_cut_12345678",
		TargetAgentID:  "agent_cancel_recover_cut_12345678",
		IdempotencyKey: "idem_cancel_recover_cut_12345678",
	}
	if _, err := inbox.RecordCancellation(contracts.RunCancelRequestedMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_cancel_recover_cut_12345678",
		Timestamp:       now,
		Type:            contracts.RunCancelRequested,
		Payload: contracts.RunCancelRequestedPayload{
			RunID: request.RunID, TraceID: request.TraceID,
			AgentID: request.TargetAgentID, Reason: "recover crash cut",
		},
	}, now); err != nil {
		t.Fatal(err)
	}
	if _, duplicate, err := inbox.Accept(request, now); err != nil || duplicate {
		t.Fatalf("persist accepted crash cut duplicate=%t err=%v", duplicate, err)
	}

	reopened, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	prepareCalls := 0
	var sent []any
	executor := RuntimeExecutor{
		Inbox: reopened,
		Prepare: func(
			context.Context,
			contracts.RunRequestedPayload,
		) ([]contracts.VerifiedArtifactMaterializationReceipt, error) {
			prepareCalls++
			return nil, nil
		},
		Now: func() time.Time { return now.Add(time.Second) },
	}
	if err := executor.Recover(
		context.Background(),
		func(_ context.Context, value any) error {
			sent = append(sent, value)
			return nil
		},
	); err != nil {
		t.Fatal(err)
	}
	if prepareCalls != 0 {
		t.Fatalf("tombstoned recovery entered preparation %d times", prepareCalls)
	}
	if len(sent) != 2 {
		t.Fatalf("tombstoned recovery sent %d messages: %#v", len(sent), sent)
	}
	accepted, acceptedOK := sent[0].(contracts.RunAcceptedMessage)
	terminal, terminalOK := sent[1].(contracts.RunStatusMessage)
	if !acceptedOK || !terminalOK ||
		accepted.Payload.RunID != request.RunID ||
		accepted.Payload.TraceID != request.TraceID ||
		terminal.Payload.RunID != request.RunID ||
		terminal.Payload.TraceID != request.TraceID ||
		terminal.Payload.Sequence != 2 || terminal.Payload.Status != contracts.Canceled {
		t.Fatalf("tombstoned recovery did not converge as canceled: %#v", sent)
	}
	latest, err := reopened.Get(request.RunID)
	if err != nil || latest.State != StateCanceled || latest.LastSequence != 2 {
		t.Fatalf("recovered cancellation is not durable: %#v err=%v", latest, err)
	}
	staged, err := reopened.HasCancellation(request)
	if err != nil || staged {
		t.Fatalf("successful recovery retained tombstone=%t err=%v", staged, err)
	}
}

func TestCancellationTombstoneSurvivesWriteLossAndClearsAfterSuccess(t *testing.T) {
	now := time.Date(2026, time.August, 29, 9, 45, 0, 0, time.UTC)
	directory := t.TempDir()
	inbox, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	requested := contracts.RunCancelRequestedMessage{
		ProtocolVersion: "1.0",
		MessageID:       "msg_cancel_pre_admission_12345678",
		Timestamp:       now,
		Type:            contracts.RunCancelRequested,
		Payload: contracts.RunCancelRequestedPayload{
			RunID:   "run_cancel_pre_admission_12345678",
			TraceID: "trace_cancel_pre_admission_12345678",
			AgentID: "agent_cancel_pre_admission_12345678",
			Reason:  "cancel before delivery",
		},
	}
	executor := RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now }}
	var first contracts.RunStatusMessage
	writeLost := errors.New("terminal write lost")
	if err := executor.ReplayCanceledRun(
		context.Background(), requested,
		func(_ context.Context, value any) error {
			var ok bool
			first, ok = value.(contracts.RunStatusMessage)
			if !ok {
				t.Fatalf("pre-admission cancellation emitted %T", value)
			}
			return writeLost
		},
	); !errors.Is(err, writeLost) {
		t.Fatalf("first cancellation write error=%v", err)
	}
	staged, err := inbox.HasCancellation(contracts.RunRequestedPayload{
		RunID: requested.Payload.RunID, TraceID: requested.Payload.TraceID,
		TargetAgentID: requested.Payload.AgentID,
	})
	if err != nil || !staged {
		t.Fatalf("failed write retained tombstone=%t err=%v", staged, err)
	}
	reopened, err := Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	executor = RuntimeExecutor{Inbox: reopened, Now: func() time.Time { return now }}
	var sent []contracts.RunStatusMessage
	for attempt := 0; attempt < 2; attempt++ {
		if err := executor.ReplayCanceledRun(
			context.Background(), requested,
			func(_ context.Context, value any) error {
				status, ok := value.(contracts.RunStatusMessage)
				if !ok {
					t.Fatalf("pre-admission cancellation emitted %T", value)
				}
				sent = append(sent, status)
				return nil
			},
		); err != nil {
			t.Fatal(err)
		}
		staged, err = reopened.HasCancellation(contracts.RunRequestedPayload{
			RunID: requested.Payload.RunID, TraceID: requested.Payload.TraceID,
			TargetAgentID: requested.Payload.AgentID,
		})
		if err != nil || staged {
			t.Fatalf("successful write retained tombstone=%t err=%v", staged, err)
		}
	}
	if len(sent) != 2 || first != sent[0] ||
		sent[0].Payload != sent[1].Payload ||
		sent[0].Payload.RunID != requested.Payload.RunID ||
		sent[0].Payload.TraceID != requested.Payload.TraceID ||
		sent[0].Payload.AgentID != requested.Payload.AgentID ||
		sent[0].Payload.Sequence != 1 || sent[0].Payload.Status != contracts.Canceled {
		t.Fatalf("pre-admission terminal replay drifted: first=%#v sent=%#v", first, sent)
	}
}

func TestStageCancellationDoesNotLeaveFenceOnTerminalRecord(t *testing.T) {
	now := time.Date(2026, time.August, 29, 10, 0, 0, 0, time.UTC)
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	request := contracts.RunRequestedPayload{
		RunID:          "run_cancel_terminal_fence_12345678",
		TraceID:        "trace_cancel_terminal_fence_12345678",
		TargetAgentID:  "agent_cancel_terminal_fence_12345678",
		IdempotencyKey: "idem_cancel_terminal_fence_12345678",
	}
	record, _, err := inbox.Accept(request, now)
	if err != nil {
		t.Fatal(err)
	}
	terminal := contracts.RunStatusMessage{
		ProtocolVersion: "1.0", MessageID: "msg_cancel_terminal_fence_12345678",
		Timestamp: now, Type: contracts.RunStatus,
		Payload: contracts.RunStatusPayload{
			RunID: request.RunID, TraceID: request.TraceID,
			AgentID: request.TargetAgentID, Sequence: 2,
			Status: contracts.Completed,
		},
	}
	if _, err := inbox.AppendEvent(
		record.RunID, StateCompleted, 2, terminal, now,
	); err != nil {
		t.Fatal(err)
	}
	executor := RuntimeExecutor{Inbox: inbox, Now: func() time.Time { return now }}
	if err := executor.StageCancellation(contracts.RunCancelRequestedMessage{
		ProtocolVersion: "1.0", MessageID: "msg_cancel_terminal_signal_12345678",
		Timestamp: now, Type: contracts.RunCancelRequested,
		Payload: contracts.RunCancelRequestedPayload{
			RunID: request.RunID, TraceID: request.TraceID,
			AgentID: request.TargetAgentID, Reason: "terminal race",
		},
	}); err != nil {
		t.Fatal(err)
	}
	staged, err := inbox.HasCancellation(request)
	if err != nil || staged {
		t.Fatalf("terminal cancellation retained fence=%t err=%v", staged, err)
	}
}
