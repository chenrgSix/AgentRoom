package delivery

import (
	"context"
	"errors"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/admission"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
)

func TestGovernedHandlerUsesExistingInboxRuntimeEventsAndReplay(t *testing.T) {
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC)
	admitted := &governedAdmissionStub{decision: admission.GovernedStartDecision{Invoke: true}}
	runner := &governedRunnerStub{events: runtimeStatusEventsForDelivery(contracts.Working, contracts.Completed)}
	resolverCalls := 0
	executor := &RuntimeExecutor{Inbox: inbox, ResolveArtifacts: func(contracts.RunRequestedPayload) ([]bridgeruntime.VerifiedArtifactAlias, error) {
		resolverCalls++
		return nil, errors.New("ordinary Artifact resolver must not run")
	}}
	governed := &GovernedHandler{Inbox: inbox, Admission: admitted, Runner: runner, Executor: executor,
		Now: func() time.Time { return now }}
	handler := Handler{Governed: governed}
	message := governedRunMessage("run_governed_delivery01", "agent_governed_delivery01")
	var sent []any
	if err := handler.Handle(context.Background(), message, func(_ context.Context, value any) error {
		sent = append(sent, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if admitted.prepareCalls != 1 || admitted.startCalls != 1 || runner.calls != 1 || resolverCalls != 0 || len(sent) != 3 {
		t.Fatalf("prepare=%d start=%d runner=%d resolver=%d sent=%d", admitted.prepareCalls,
			admitted.startCalls, runner.calls, resolverCalls, len(sent))
	}
	accepted, acceptedOK := sent[0].(contracts.RunAcceptedMessage)
	working, workingOK := sent[1].(contracts.RunStatusMessage)
	completed, completedOK := sent[2].(contracts.RunStatusMessage)
	if !acceptedOK || !workingOK || !completedOK || accepted.Payload.Sequence != 1 ||
		working.Payload.Status != contracts.Working || working.Payload.Sequence != 2 ||
		completed.Payload.Status != contracts.Completed || completed.Payload.Sequence != 3 {
		t.Fatalf("unexpected governed delivery: %#v", sent)
	}
	record, err := inbox.Get(message.Payload.RunID)
	if err != nil || record.State != StateCompleted || record.LastSequence != 3 {
		t.Fatalf("record=%+v err=%v", record, err)
	}

	var replayed []any
	if err := handler.Handle(context.Background(), message, func(_ context.Context, value any) error {
		replayed = append(replayed, value)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if admitted.prepareCalls != 1 || admitted.startCalls != 1 || runner.calls != 1 || len(replayed) != 3 {
		t.Fatalf("duplicate prepare=%d start=%d runner=%d replayed=%d", admitted.prepareCalls,
			admitted.startCalls, runner.calls, len(replayed))
	}
}

func TestGovernedHandlerFailsClosedOrRetriesBeforeRuntime(t *testing.T) {
	t.Run("non-retryable preparation", func(t *testing.T) {
		handler, inbox, admitted, runner, message := governedHandlerFixture(t)
		admitted.prepareErr = admission.ErrAdmissionNotCurrent
		var sent []any
		if err := handler.Handle(context.Background(), message, collectGoverned(&sent)); err != nil {
			t.Fatal(err)
		}
		assertGovernedFailure(t, inbox, message, sent)
		if admitted.startCalls != 0 || runner.calls != 0 {
			t.Fatalf("start=%d runner=%d", admitted.startCalls, runner.calls)
		}
	})

	t.Run("retryable preparation", func(t *testing.T) {
		handler, inbox, admitted, runner, message := governedHandlerFixture(t)
		admitted.prepareErr = admission.ErrInputUnavailable
		var sent []any
		if err := handler.Handle(context.Background(), message, collectGoverned(&sent)); !errors.Is(err, admission.ErrInputUnavailable) || len(sent) != 0 {
			t.Fatalf("error=%v sent=%v", err, sent)
		}
		record, err := inbox.Get(message.Payload.RunID)
		if err != nil || record.State != StatePreparing {
			t.Fatalf("record=%+v err=%v", record, err)
		}
		admitted.prepareErr = nil
		admitted.decision = admission.GovernedStartDecision{Invoke: true}
		runner.events = runtimeStatusEventsForDelivery(contracts.Completed)
		if err := handler.Handle(context.Background(), message, collectGoverned(&sent)); err != nil {
			t.Fatal(err)
		}
		if admitted.prepareCalls != 2 || admitted.startCalls != 1 || runner.calls != 1 || len(sent) != 2 {
			t.Fatalf("prepare=%d start=%d runner=%d sent=%d", admitted.prepareCalls,
				admitted.startCalls, runner.calls, len(sent))
		}
	})

	t.Run("current start denied", func(t *testing.T) {
		handler, inbox, admitted, runner, message := governedHandlerFixture(t)
		admitted.startErr = admission.ErrAdmissionNotCurrent
		var sent []any
		if err := handler.Handle(context.Background(), message, collectGoverned(&sent)); err != nil {
			t.Fatal(err)
		}
		assertGovernedFailure(t, inbox, message, sent)
		if runner.calls != 0 {
			t.Fatalf("runner=%d", runner.calls)
		}
	})

	t.Run("possible start response failure", func(t *testing.T) {
		handler, inbox, admitted, runner, message := governedHandlerFixture(t)
		admitted.startErr = errors.Join(admission.ErrAdmissionPossibleStart, errors.New("durable read failed"))
		var sent []any
		if err := handler.Handle(context.Background(), message, collectGoverned(&sent)); !errors.Is(err, ErrGovernedRuntimeAmbiguous) || runner.calls != 0 || len(sent) != 1 {
			t.Fatalf("error=%v runner=%d sent=%d", err, runner.calls, len(sent))
		}
		record, err := inbox.Get(message.Payload.RunID)
		if err != nil || record.State != StateAccepted || record.LastSequence != 1 {
			t.Fatalf("record=%+v err=%v", record, err)
		}
	})

	t.Run("non-invoke possible start", func(t *testing.T) {
		handler, inbox, admitted, runner, message := governedHandlerFixture(t)
		var sent []any
		if err := handler.Handle(context.Background(), message, collectGoverned(&sent)); !errors.Is(err, ErrGovernedRuntimeAmbiguous) || runner.calls != 0 || len(sent) != 1 {
			t.Fatalf("error=%v runner=%d sent=%d", err, runner.calls, len(sent))
		}
		record, err := inbox.Get(message.Payload.RunID)
		if err != nil || record.State != StateAccepted {
			t.Fatalf("record=%+v err=%v", record, err)
		}
		if admitted.prepareCalls != 1 || admitted.startCalls != 1 {
			t.Fatalf("prepare=%d start=%d", admitted.prepareCalls, admitted.startCalls)
		}
	})
}

type governedAdmissionStub struct {
	prepareCalls int
	startCalls   int
	prepareErr   error
	startErr     error
	decision     admission.GovernedStartDecision
}

func (s *governedAdmissionStub) Prepare(context.Context,
	contracts.RunRequestedPayload) (admission.GovernedAdmissionTicket, error) {
	s.prepareCalls++
	return admission.GovernedAdmissionTicket{}, s.prepareErr
}

func (s *governedAdmissionStub) Start(context.Context,
	admission.GovernedAdmissionTicket) (admission.GovernedStartDecision, error) {
	s.startCalls++
	return s.decision, s.startErr
}

type governedRunnerStub struct {
	events []bridgeruntime.Event
	err    error
	calls  int
}

func (s *governedRunnerStub) Run(ctx context.Context, _ admission.GovernedAdmissionTicket,
	_ admission.GovernedStartDecision, emit bridgeruntime.EmitFunc) (admission.RuntimeAdmissionView, error) {
	s.calls++
	for _, event := range s.events {
		if err := emit(ctx, event); err != nil {
			return admission.RuntimeAdmissionView{}, err
		}
	}
	return admission.RuntimeAdmissionView{}, s.err
}

func governedHandlerFixture(t *testing.T) (Handler, *Inbox, *governedAdmissionStub,
	*governedRunnerStub, contracts.RunRequestedMessage) {
	t.Helper()
	inbox, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	admitted := &governedAdmissionStub{}
	runner := &governedRunnerStub{}
	executor := &RuntimeExecutor{Inbox: inbox}
	governed := &GovernedHandler{Inbox: inbox, Admission: admitted, Runner: runner, Executor: executor,
		Now: func() time.Time { return time.Date(2026, 9, 1, 8, 0, 0, 0, time.UTC) }}
	return Handler{Governed: governed}, inbox, admitted, runner,
		governedRunMessage("run_governed_failure01", "agent_governed_failure01")
}

func governedRunMessage(runID, agentID string) contracts.RunRequestedMessage {
	message := testRunMessage(runID, agentID)
	message.Payload.ContextManifest = &contracts.ContextManifest{Execution: &contracts.Execution{}}
	return message
}

func collectGoverned(target *[]any) Sender {
	return func(_ context.Context, value any) error {
		*target = append(*target, value)
		return nil
	}
}

func assertGovernedFailure(t *testing.T, inbox *Inbox, message contracts.RunRequestedMessage, sent []any) {
	t.Helper()
	if len(sent) != 2 {
		t.Fatalf("sent=%#v", sent)
	}
	if _, ok := sent[0].(contracts.RunAcceptedMessage); !ok {
		t.Fatalf("first message=%T", sent[0])
	}
	failed, ok := sent[1].(contracts.RunStatusMessage)
	if !ok || failed.Payload.Status != contracts.Failed || failed.Payload.Error == nil ||
		failed.Payload.Error.Code != "GOVERNED_ADMISSION_DENIED" {
		t.Fatalf("failed=%#v", sent[1])
	}
	record, err := inbox.Get(message.Payload.RunID)
	if err != nil || record.State != StateFailed || record.LastSequence != 2 {
		t.Fatalf("record=%+v err=%v", record, err)
	}
}

func runtimeStatusEventsForDelivery(statuses ...contracts.RunExecutionStatus) []bridgeruntime.Event {
	events := make([]bridgeruntime.Event, 0, len(statuses))
	for _, status := range statuses {
		status := status
		events = append(events, bridgeruntime.Event{Status: &status})
	}
	return events
}
