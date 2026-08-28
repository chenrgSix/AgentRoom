package delivery

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	contracts "convenewire.dev/contracts/generated/go"
)

var errExplicitTestCancel = errors.New("explicit test cancellation")

type sentEvent struct {
	runID  string
	status contracts.RunExecutionStatus
	typeID string
}

func TestHandlerSerializesOneAgentWhileOtherAgentsRemainParallel(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gate := NewAgentExecutionGate()
	executor := RuntimeExecutor{Inbox: inbox}
	starts := make(chan string, 8)
	releaseFirst := make(chan struct{})
	duplicateCount := 0
	var duplicateMu sync.Mutex
	handler := Handler{
		Inbox: inbox,
		Gate:  gate,
		OnNew: func(_ context.Context, record Record, _ Sender) error {
			starts <- record.RunID
			if record.RunID == "run_isolation_first" {
				<-releaseFirst
			}
			return nil
		},
		OnDuplicate: func(context.Context, Record, Sender) error {
			duplicateMu.Lock()
			duplicateCount++
			duplicateMu.Unlock()
			return nil
		},
		OnQueuedCanceled: executor.CancelQueued,
		IsExplicitCancel: func(ctx context.Context) bool {
			return errors.Is(context.Cause(ctx), errExplicitTestCancel)
		},
	}

	sent := make(chan sentEvent, 16)
	send := func(_ context.Context, value any) error {
		switch message := value.(type) {
		case contracts.RunAcceptedMessage:
			sent <- sentEvent{runID: message.Payload.RunID, typeID: "accepted"}
		case contracts.RunStatusMessage:
			sent <- sentEvent{
				runID: message.Payload.RunID, status: message.Payload.Status, typeID: "status",
			}
		}
		return nil
	}

	firstDone := runHandler(t, handler, context.Background(),
		testRunMessage("run_isolation_first", "agent_isolation_a"), send)
	waitForStart(t, starts, "run_isolation_first")

	secondContext, cancelSecond := context.WithCancelCause(context.Background())
	secondDone := runHandler(t, handler, secondContext,
		testRunMessage("run_isolation_second", "agent_isolation_a"), send)
	waitForSent(t, sent, "run_isolation_second", "accepted", "")
	waitForGateQueue(t, gate, "agent_isolation_a", 1)

	thirdDone := runHandler(t, handler, context.Background(),
		testRunMessage("run_isolation_third", "agent_isolation_a"), send)
	waitForSent(t, sent, "run_isolation_third", "accepted", "")
	waitForGateQueue(t, gate, "agent_isolation_a", 2)

	duplicateDone := runHandler(t, handler, context.Background(),
		testRunMessage("run_isolation_third", "agent_isolation_a"), send)
	waitDone(t, duplicateDone)
	duplicateMu.Lock()
	if duplicateCount != 1 {
		t.Fatalf("duplicate delivery entered execution scheduling: %d", duplicateCount)
	}
	duplicateMu.Unlock()
	waitForGateQueue(t, gate, "agent_isolation_a", 2)

	otherDone := runHandler(t, handler, context.Background(),
		testRunMessage("run_isolation_other", "agent_isolation_b"), send)
	waitForStart(t, starts, "run_isolation_other")
	waitDone(t, otherDone)

	cancelSecond(errExplicitTestCancel)
	waitForSent(t, sent, "run_isolation_second", "status", contracts.Canceled)
	waitDone(t, secondDone)
	waitForGateQueue(t, gate, "agent_isolation_a", 1)
	secondRecord, err := inbox.Get("run_isolation_second")
	if err != nil {
		t.Fatal(err)
	}
	if secondRecord.State != StateCanceled || secondRecord.LastSequence != 2 {
		t.Fatalf("queued cancellation did not persist terminal state: %#v", secondRecord)
	}

	close(releaseFirst)
	waitDone(t, firstDone)
	waitForStart(t, starts, "run_isolation_third")
	waitDone(t, thirdDone)
	select {
	case unexpected := <-starts:
		t.Fatalf("unexpected duplicate or canceled Runtime start: %s", unexpected)
	default:
	}
}

func TestQueuedConnectionLossDoesNotStartRuntimeAndRecoversDeterministically(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gate := NewAgentExecutionGate()
	release, err := gate.Acquire(context.Background(), "agent_reconnect")
	if err != nil {
		t.Fatal(err)
	}
	started := 0
	executor := RuntimeExecutor{Inbox: inbox}
	handler := Handler{
		Inbox: inbox, Gate: gate,
		OnNew: func(context.Context, Record, Sender) error {
			started++
			return nil
		},
		OnQueuedCanceled: executor.CancelQueued,
		IsExplicitCancel: func(ctx context.Context) bool {
			return errors.Is(context.Cause(ctx), errExplicitTestCancel)
		},
	}
	connectionContext, disconnect := context.WithCancel(context.Background())
	done := runHandler(t, handler, connectionContext,
		testRunMessage("run_reconnect_queued", "agent_reconnect"),
		func(context.Context, any) error { return nil },
	)
	waitForGateQueue(t, gate, "agent_reconnect", 1)
	disconnect()
	waitDone(t, done)
	release()
	if started != 0 {
		t.Fatalf("connection loss started a queued Runtime: %d", started)
	}

	if err := executor.Recover(context.Background(), func(context.Context, any) error {
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	record, err := inbox.Get("run_reconnect_queued")
	if err != nil {
		t.Fatal(err)
	}
	if record.State != StateOutcomeUnknown || record.LastSequence != 2 {
		t.Fatalf("queued reconnect outcome did not converge deterministically: %#v", record)
	}
}

func testRunMessage(runID, agentID string) contracts.RunRequestedMessage {
	return contracts.RunRequestedMessage{Payload: contracts.RunRequestedPayload{
		RunID: runID, TraceID: "trace_" + runID[4:], TargetAgentID: agentID,
		DeliveryAttemptID: "delivery_" + runID[4:], IdempotencyKey: "idem_" + runID[4:],
	}}
}

func runHandler(
	t *testing.T,
	handler Handler,
	ctx context.Context,
	message contracts.RunRequestedMessage,
	send Sender,
) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- handler.Handle(ctx, message, send) }()
	return done
}

func waitForStart(t *testing.T, starts <-chan string, expected string) {
	t.Helper()
	select {
	case actual := <-starts:
		if actual != expected {
			t.Fatalf("Runtime start=%s, want %s", actual, expected)
		}
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for Runtime start %s", expected)
	}
}

func waitForSent(
	t *testing.T,
	events <-chan sentEvent,
	runID string,
	typeID string,
	status contracts.RunExecutionStatus,
) {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case event := <-events:
			if event.runID == runID && event.typeID == typeID &&
				(status == "" || event.status == status) {
				return
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s event for %s", typeID, runID)
		}
	}
}

func waitForGateQueue(t *testing.T, gate *AgentExecutionGate, agentID string, count int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		gate.mu.Lock()
		actual := len(gate.queues[agentID])
		gate.mu.Unlock()
		if actual == count {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("Agent queue did not reach %d", count)
}

func waitDone(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for handler")
	}
}
