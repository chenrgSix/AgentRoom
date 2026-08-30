package delivery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/operations"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
)

func terminalDeliveryFixture(t *testing.T, events []bridgeruntime.Event) (RuntimeExecutor, Record, *bridgeruntime.FakeAdapter) {
	t.Helper()
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 31, 12, 0, 0, 0, time.UTC)
	record, _, err := inbox.Accept(contracts.RunRequestedPayload{
		RunID: "run_terminal_delivery_12345678", TraceID: "trace_terminal_delivery_12345678",
		TargetAgentID: "agent_terminal_delivery_12345678", IdempotencyKey: "idem_terminal_delivery_12345678",
		DeliveryAttemptID: "delivery_terminal_delivery_12345678",
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	adapter := &bridgeruntime.FakeAdapter{}
	if err := adapter.Enqueue(bridgeruntime.FakeScript{Events: events}); err != nil {
		t.Fatal(err)
	}
	return RuntimeExecutor{
		Inbox: inbox, Adapters: map[string]bridgeruntime.Adapter{record.Request.TargetAgentID: adapter},
		Now: func() time.Time { return now },
	}, record, adapter
}

func durableDeliveryBytes(t *testing.T, inbox *Inbox, runID string) []byte {
	t.Helper()
	source, err := os.ReadFile(inbox.path(runID))
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func assertExactDeliveryReplay(t *testing.T, sent []any, record Record) {
	t.Helper()
	if len(sent) != len(record.Events)+1 {
		t.Fatalf("replay sent %d messages, want acceptance and %d original events", len(sent), len(record.Events))
	}
	accepted, ok := sent[0].(contracts.RunAcceptedMessage)
	if !ok || accepted.Payload.Sequence != 1 || accepted.Payload.RunID != record.RunID {
		t.Fatalf("replay did not begin with original Run acceptance: %#v", sent[0])
	}
	for index, expected := range record.Events {
		canonicalExpected, err := json.Marshal(expected)
		if err != nil {
			t.Fatal(err)
		}
		actual, err := json.Marshal(sent[index+1])
		if err != nil || !bytes.Equal(actual, canonicalExpected) {
			t.Fatalf("replayed event %d changed: got=%s want=%s err=%v", index, actual, expected, err)
		}
	}
}

func TestRuntimeExecutorPreservesDurableBoundaryAfterTerminalSendFailure(t *testing.T) {
	for _, status := range []contracts.RunExecutionStatus{
		contracts.Completed, contracts.Failed, contracts.Canceled, contracts.InputRequired, contracts.OutcomeUnknown,
	} {
		t.Run(string(status), func(t *testing.T) {
			working := contracts.Working
			terminal := bridgeruntime.Event{Status: &status}
			wantRuntimeState := operations.RuntimeIdle
			wantErrorCode := ""
			if status == contracts.Failed || status == contracts.OutcomeUnknown {
				wantRuntimeState = operations.RuntimeError
				wantErrorCode = "ORIGINAL_RUNTIME_BOUNDARY"
				terminal.Error = &contracts.ConveneWireError{Code: wantErrorCode, Message: "Original Runtime boundary.", Retryable: false}
			}
			if status == contracts.InputRequired {
				terminal.Clarification = &contracts.TaskClarificationRequest{
					Kind: contracts.Task, Question: "Which region?", Choices: []string{"EU", "US"},
				}
			}
			if status == contracts.Completed {
				terminal.Session = &contracts.LogicalSessionStatus{Disposition: contracts.Resumed, ContextCursor: 42}
			}
			executor, record, adapter := terminalDeliveryFixture(t, []bridgeruntime.Event{{Status: &working}, terminal})
			var observed []operations.RuntimeEvent
			executor.Observer.OnRuntime = func(event operations.RuntimeEvent) { observed = append(observed, event) }
			sendFailure := errors.New("terminal transport failed")
			var persistedBeforeFailure []byte
			var attempts []any
			err := executor.Execute(context.Background(), record, func(_ context.Context, value any) error {
				attempts = append(attempts, value)
				if message, ok := value.(contracts.RunStatusMessage); ok && message.Payload.Sequence == 3 {
					persistedBeforeFailure = durableDeliveryBytes(t, executor.Inbox, record.RunID)
					return fmt.Errorf("write terminal status: %w", sendFailure)
				}
				return nil
			})
			latest, loadErr := executor.Inbox.Get(record.RunID)
			if loadErr != nil {
				t.Fatal(loadErr)
			}
			if latest.State != stateForStatus(status) || latest.LastSequence != 3 || len(latest.Events) != 2 {
				t.Fatalf("delivery failure rewrote durable %s: state=%s sequence=%d events=%d", status, latest.State, latest.LastSequence, len(latest.Events))
			}
			if !errors.Is(err, sendFailure) {
				t.Fatalf("Execute error=%v, want original delivery failure", err)
			}
			if len(attempts) != 2 || !bytes.Equal(persistedBeforeFailure, durableDeliveryBytes(t, executor.Inbox, record.RunID)) {
				t.Fatalf("terminal send failure appended or retried an event: attempts=%d", len(attempts))
			}
			if len(observed) != 2 || observed[1].ActiveDelta != -1 || observed[1].LastStatus != string(status) ||
				observed[1].State != wantRuntimeState || observed[1].ErrorCode != wantErrorCode {
				t.Fatalf("delivery failure replaced the Runtime observation: %#v", observed)
			}

			reopened, err := Open(executor.Inbox.directory)
			if err != nil {
				t.Fatal(err)
			}
			recovered := RuntimeExecutor{Inbox: reopened, Adapters: executor.Adapters, Now: executor.Now}
			for attempt := 0; attempt < 2; attempt++ {
				var replayed []any
				if err := recovered.Recover(context.Background(), func(_ context.Context, value any) error {
					replayed = append(replayed, value)
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				assertExactDeliveryReplay(t, replayed, latest)
			}
			var duplicated []any
			handler := Handler{Inbox: reopened, OnNew: recovered.Execute, OnDuplicate: recovered.Replay}
			if err := handler.Handle(context.Background(), contracts.RunRequestedMessage{Payload: record.Request}, func(_ context.Context, value any) error {
				duplicated = append(duplicated, value)
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			assertExactDeliveryReplay(t, duplicated, latest)
			if len(adapter.Requests()) != 1 || !bytes.Equal(persistedBeforeFailure, durableDeliveryBytes(t, reopened, record.RunID)) {
				t.Fatal("recovery or duplicate delivery reran the Runtime or changed its durable result")
			}
		})
	}
}

func TestRuntimeExecutorKeepsCancellationFenceUntilTerminalReplaySucceeds(t *testing.T) {
	working, canceled := contracts.Working, contracts.Canceled
	executor, record, adapter := terminalDeliveryFixture(t, []bridgeruntime.Event{{Status: &working}, {Status: &canceled}})
	sendFailure := errors.New("canceled terminal transport failed")
	err := executor.Execute(context.Background(), record, func(_ context.Context, value any) error {
		message := value.(contracts.RunStatusMessage)
		if message.Payload.Status == contracts.Working {
			_, err := executor.Inbox.RecordCancellation(contracts.RunCancelRequestedMessage{
				ProtocolVersion: "1.0", Type: contracts.RunCancelRequested,
				MessageID: "msg_terminal_cancel_12345678", Timestamp: executor.now(),
				Payload: contracts.RunCancelRequestedPayload{
					RunID: record.RunID, AgentID: record.Request.TargetAgentID,
					TraceID: record.Request.TraceID, Reason: "cancel active Runtime",
				},
			}, executor.now())
			return err
		}
		return sendFailure
	})
	if !errors.Is(err, sendFailure) {
		t.Fatalf("Execute error=%v, want terminal delivery failure", err)
	}
	latest, err := executor.Inbox.Get(record.RunID)
	if err != nil || latest.State != StateCanceled || latest.LastSequence != 3 {
		t.Fatalf("canceled result was not preserved: state=%s sequence=%d err=%v", latest.State, latest.LastSequence, err)
	}
	beforeReplay := durableDeliveryBytes(t, executor.Inbox, record.RunID)
	reopened, err := Open(executor.Inbox.directory)
	if err != nil {
		t.Fatal(err)
	}
	recovered := RuntimeExecutor{Inbox: reopened, Now: executor.Now}
	if staged, err := reopened.HasCancellation(record.Request); err != nil || !staged {
		t.Fatalf("failed delivery removed cancellation fence: staged=%t err=%v", staged, err)
	}
	failedReplayAttempts := 0
	if err := recovered.Recover(context.Background(), func(_ context.Context, value any) error {
		failedReplayAttempts++
		source, err := json.Marshal(value)
		if err != nil {
			return err
		}
		var message contracts.RunStatusMessage
		if err := json.Unmarshal(source, &message); err != nil {
			return err
		}
		if message.Payload.Status == contracts.Canceled {
			return sendFailure
		}
		return nil
	}); !errors.Is(err, sendFailure) {
		t.Fatalf("failed recovery error=%v, want transport failure", err)
	}
	if failedReplayAttempts != 3 {
		t.Fatalf("failure occurred before terminal replay: attempts=%d", failedReplayAttempts)
	}
	if staged, err := reopened.HasCancellation(record.Request); err != nil || !staged {
		t.Fatalf("failed replay removed cancellation fence: staged=%t err=%v", staged, err)
	}
	var replayed []any
	if err := recovered.Recover(context.Background(), func(_ context.Context, value any) error {
		replayed = append(replayed, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	assertExactDeliveryReplay(t, replayed, latest)
	if staged, err := reopened.HasCancellation(record.Request); err != nil || staged {
		t.Fatalf("successful replay did not clear cancellation fence: staged=%t err=%v", staged, err)
	}
	if len(adapter.Requests()) != 1 || !bytes.Equal(beforeReplay, durableDeliveryBytes(t, reopened, record.RunID)) {
		t.Fatal("cancellation recovery changed the Runtime outcome or invoked it again")
	}
}

func TestRuntimeExecutorUnfinishedSendFailureStillPersistsUnknown(t *testing.T) {
	for _, failOutput := range []bool{false, true} {
		t.Run(fmt.Sprintf("output=%t", failOutput), func(t *testing.T) {
			working, completed := contracts.Working, contracts.Completed
			events := []bridgeruntime.Event{{Status: &working}}
			if failOutput {
				events = append(events, bridgeruntime.Event{Output: &bridgeruntime.OutputDelta{Content: "Unfinished output"}})
			}
			events = append(events, bridgeruntime.Event{Status: &completed})
			executor, record, adapter := terminalDeliveryFixture(t, events)
			err := executor.Execute(context.Background(), record, func(_ context.Context, value any) error {
				if message, ok := value.(contracts.RunStatusMessage); ok {
					if message.Payload.Status == contracts.OutcomeUnknown {
						return nil
					}
					if !failOutput {
						return errors.New("working status transport failed")
					}
				}
				if _, ok := value.(contracts.RunOutputDeltaMessage); ok {
					return errors.New("output transport failed")
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			latest, err := executor.Inbox.Get(record.RunID)
			wantSequence := int64(3)
			if failOutput {
				wantSequence = 4
			}
			if err != nil || latest.State != StateOutcomeUnknown || latest.LastSequence != wantSequence || len(adapter.Requests()) != 1 {
				t.Fatalf("unfinished failure lost unknown-outcome handling: %#v err=%v", latest, err)
			}
			var terminal contracts.RunStatusMessage
			if err := json.Unmarshal(latest.Events[len(latest.Events)-1], &terminal); err != nil || terminal.Payload.Error == nil ||
				terminal.Payload.Status != contracts.OutcomeUnknown || terminal.Payload.Error.Code != "RUNTIME_EXECUTION_UNKNOWN" {
				t.Fatalf("unfinished execution has an incorrect terminal event: %#v err=%v", terminal, err)
			}
		})
	}
}
