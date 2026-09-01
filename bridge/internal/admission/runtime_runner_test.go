package admission

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/config"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	contracts "convenewire.dev/contracts/generated/go"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func TestGovernedRuntimeRunnerUsesExactWorkspaceAndClosesOutcome(t *testing.T) {
	tests := []struct {
		name    string
		events  []bridgeruntime.Event
		want    RuntimeOutcome
		emitErr error
		wantErr error
	}{
		{name: "completed", events: runtimeStatusEvents(contracts.Working, contracts.Completed), want: RuntimeOutcomeCompleted},
		{name: "failed", events: runtimeStatusEvents(contracts.Working, contracts.Failed), want: RuntimeOutcomeFailed},
		{name: "canceled", events: runtimeStatusEvents(contracts.Working, contracts.Canceled), want: RuntimeOutcomeCanceled},
		{name: "input required", events: runtimeStatusEvents(contracts.Working, contracts.InputRequired), want: RuntimeOutcomeInputRequired},
		{name: "no terminal", events: runtimeStatusEvents(contracts.Working), want: RuntimeOutcomeUnknown,
			wantErr: ErrRuntimeOutcomeMissing},
		{name: "terminal delivery failure", events: runtimeStatusEvents(contracts.Completed), want: RuntimeOutcomeCompleted,
			emitErr: errors.New("delivery failed")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			coordinator, rig, request := governedCoordinatorFixture(t)
			ticket, err := coordinator.Prepare(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			decision, err := coordinator.Start(context.Background(), ticket)
			if err != nil {
				t.Fatal(err)
			}
			configured := config.AgentConfig{Name: "Builder", Adapter: "codex", RuntimeKind: "codex",
				PresetVersion: config.CurrentPresetVersion, Command: []string{"codex", "app-server"},
				EnvAllowlist: []string{"PATH"}, Workspace: "/ordinary", Sandbox: "workspace-write"}
			var used config.AgentConfig
			var usedIdentity bridgeruntime.GovernedProcessIdentity
			processes := &runnerProcessTrackerStub{}
			capture := &runnerCaptureStub{beforeCapture: func() error {
				if rig.stopCalls != 0 {
					return errors.New("capture ran after admission stop")
				}
				return nil
			}}
			adapter := &governedFakeAdapter{events: test.events}
			runner, err := newGovernedRuntimeRunner(coordinator,
				map[string]config.AgentConfig{ticket.manifest.Scope.AgentID: configured}, nil, processes, capture,
				func(agent config.AgentConfig, _ bridgeruntime.RuntimeSessionStore,
					tracker bridgeruntime.GovernedProcessTracker,
					identity bridgeruntime.GovernedProcessIdentity) bridgeruntime.Adapter {
					used = agent
					usedIdentity = identity
					if tracker != processes {
						t.Fatal("runner changed process tracker")
					}
					return adapter
				})
			if err != nil {
				t.Fatal(err)
			}
			runner.now = func() time.Time { return runtimeFenceNow.Add(time.Minute) }
			var emitted []bridgeruntime.Event
			view, runErr := runner.Run(context.Background(), ticket, decision,
				func(_ context.Context, event bridgeruntime.Event) error {
					if event.Status != nil && *event.Status != contracts.Working && rig.stopCalls != 1 {
						return errors.New("terminal emitted before admission stop")
					}
					emitted = append(emitted, event)
					if test.emitErr != nil && event.Status != nil && *event.Status != contracts.Working {
						return test.emitErr
					}
					return nil
				})
			wantErr := test.wantErr
			if test.emitErr != nil {
				wantErr = test.emitErr
			}
			if !errors.Is(runErr, wantErr) || used.Workspace != rig.prepared.Path ||
				configured.Workspace != "/ordinary" || !reflect.DeepEqual(emitted, test.events) || rig.stopCalls != 1 ||
				view.State != RuntimeAdmissionStopped || view.Outcome == nil || *view.Outcome != test.want ||
				usedIdentity.RunID != ticket.manifest.Scope.RunID ||
				usedIdentity.AdmissionDigest != decision.View.AdmissionDigest ||
				decision.View.StartDigest == nil || usedIdentity.StartDigest != *decision.View.StartDigest ||
				capture.calls != boolInt(test.want == RuntimeOutcomeCompleted) {
				t.Fatalf("view=%+v err=%v workspace=%q emitted=%v stops=%d", view, runErr, used.Workspace, emitted, rig.stopCalls)
			}
		})
	}
}

func TestGovernedRuntimeRunnerClosesUnknownAfterInvokeSetupFailure(t *testing.T) {
	coordinator, rig, request := governedCoordinatorFixture(t)
	ticket, err := coordinator.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := coordinator.Start(context.Background(), ticket)
	if err != nil {
		t.Fatal(err)
	}
	runner, err := newGovernedRuntimeRunner(coordinator, map[string]config.AgentConfig{ticket.manifest.Scope.AgentID: {
		Name: "Builder", Adapter: "codex", RuntimeKind: "codex", Command: []string{"codex", "app-server"},
	}}, nil, &runnerProcessTrackerStub{}, nil, func(config.AgentConfig, bridgeruntime.RuntimeSessionStore,
		bridgeruntime.GovernedProcessTracker, bridgeruntime.GovernedProcessIdentity) bridgeruntime.Adapter {
		return nil
	})
	if err == nil {
		t.Fatal("runner accepted missing capture coordinator")
	}
	runner, err = newGovernedRuntimeRunner(coordinator, map[string]config.AgentConfig{ticket.manifest.Scope.AgentID: {
		Name: "Builder", Adapter: "codex", RuntimeKind: "codex", Command: []string{"codex", "app-server"},
	}}, nil, &runnerProcessTrackerStub{}, &runnerCaptureStub{}, func(config.AgentConfig, bridgeruntime.RuntimeSessionStore,
		bridgeruntime.GovernedProcessTracker, bridgeruntime.GovernedProcessIdentity) bridgeruntime.Adapter {
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	runner.now = func() time.Time { return runtimeFenceNow.Add(time.Minute) }
	view, err := runner.Run(context.Background(), ticket, decision, func(context.Context, bridgeruntime.Event) error { return nil })
	if !errors.Is(err, ErrProfileDenied) || view.Outcome == nil || *view.Outcome != RuntimeOutcomeUnknown || rig.stopCalls != 1 {
		t.Fatalf("view=%+v err=%v stopCalls=%d", view, err, rig.stopCalls)
	}
}

func TestGovernedRuntimeRunnerRejectsReplayAndPostTerminalEvents(t *testing.T) {
	coordinator, rig, request := governedCoordinatorFixture(t)
	ticket, err := coordinator.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := coordinator.Start(context.Background(), ticket)
	if err != nil {
		t.Fatal(err)
	}
	completed, working := contracts.Completed, contracts.Working
	adapter := &governedFakeAdapter{events: []bridgeruntime.Event{{Status: &completed}, {Status: &working}}}
	runner, err := newGovernedRuntimeRunner(coordinator, map[string]config.AgentConfig{ticket.manifest.Scope.AgentID: {
		Name: "Builder", Adapter: "codex", RuntimeKind: "codex", Command: []string{"codex", "app-server"},
	}}, nil, &runnerProcessTrackerStub{}, nil, func(config.AgentConfig, bridgeruntime.RuntimeSessionStore,
		bridgeruntime.GovernedProcessTracker, bridgeruntime.GovernedProcessIdentity) bridgeruntime.Adapter {
		return adapter
	})
	if err == nil {
		t.Fatal("runner accepted missing capture coordinator")
	}
	capture := &runnerCaptureStub{}
	runner, err = newGovernedRuntimeRunner(coordinator, map[string]config.AgentConfig{ticket.manifest.Scope.AgentID: {
		Name: "Builder", Adapter: "codex", RuntimeKind: "codex", Command: []string{"codex", "app-server"},
	}}, nil, &runnerProcessTrackerStub{}, capture, func(config.AgentConfig, bridgeruntime.RuntimeSessionStore,
		bridgeruntime.GovernedProcessTracker, bridgeruntime.GovernedProcessIdentity) bridgeruntime.Adapter {
		return adapter
	})
	if err != nil {
		t.Fatal(err)
	}
	runner.now = func() time.Time { return runtimeFenceNow.Add(time.Minute) }
	view, err := runner.Run(context.Background(), ticket, decision, func(context.Context, bridgeruntime.Event) error { return nil })
	if !errors.Is(err, ErrAdmissionChanged) || view.Outcome == nil || *view.Outcome != RuntimeOutcomeCompleted ||
		rig.stopCalls != 1 || capture.calls != 0 {
		t.Fatalf("post-terminal view=%+v err=%v stops=%d", view, err, rig.stopCalls)
	}
	replay := decision
	replay.Invoke = false
	if _, err := runner.Run(context.Background(), ticket, replay, func(context.Context, bridgeruntime.Event) error { return nil }); !errors.Is(err, ErrAdmissionInvalid) || adapter.calls != 1 || rig.stopCalls != 1 {
		t.Fatalf("replay error=%v adapterCalls=%d stopCalls=%d", err, adapter.calls, rig.stopCalls)
	}
}

func TestGovernedRuntimeRunnerDowngradesCaptureFailureBeforeTerminalDelivery(t *testing.T) {
	coordinator, rig, request := governedCoordinatorFixture(t)
	ticket, err := coordinator.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := coordinator.Start(context.Background(), ticket)
	if err != nil {
		t.Fatal(err)
	}
	captureErr := errors.New("capture unavailable")
	capture := &runnerCaptureStub{err: captureErr, beforeCapture: func() error {
		if rig.stopCalls != 0 {
			return errors.New("capture ran after admission stop")
		}
		return nil
	}}
	completed := contracts.Completed
	runner, err := newGovernedRuntimeRunner(coordinator, map[string]config.AgentConfig{ticket.manifest.Scope.AgentID: {
		Name: "Builder", Adapter: "codex", RuntimeKind: "codex", Command: []string{"codex", "app-server"},
	}}, nil, &runnerProcessTrackerStub{}, capture, func(config.AgentConfig, bridgeruntime.RuntimeSessionStore,
		bridgeruntime.GovernedProcessTracker, bridgeruntime.GovernedProcessIdentity) bridgeruntime.Adapter {
		return &governedFakeAdapter{events: []bridgeruntime.Event{{Status: &completed}}}
	})
	if err != nil {
		t.Fatal(err)
	}
	runner.now = func() time.Time { return runtimeFenceNow.Add(time.Minute) }
	var emitted bridgeruntime.Event
	view, err := runner.Run(context.Background(), ticket, decision, func(_ context.Context, event bridgeruntime.Event) error {
		if rig.stopCalls != 1 {
			return errors.New("terminal emitted before admission stop")
		}
		emitted = event
		return nil
	})
	if err != nil || capture.calls != 1 || view.Outcome == nil || *view.Outcome != RuntimeOutcomeCompleted ||
		emitted.Status == nil || *emitted.Status != contracts.OutcomeUnknown || emitted.Error == nil ||
		emitted.Error.Code != "GOVERNED_CAPTURE_OUTCOME_UNKNOWN" || emitted.Error.Retryable {
		t.Fatalf("view=%+v err=%v captureCalls=%d emitted=%+v", view, err, capture.calls, emitted)
	}
}

type governedFakeAdapter struct {
	events []bridgeruntime.Event
	calls  int
}

type runnerProcessTrackerStub struct{}

type runnerCaptureStub struct {
	calls         int
	err           error
	beforeCapture func() error
}

func (s *runnerCaptureStub) CaptureCompleted(context.Context, GovernedAdmissionTicket,
	GovernedStartDecision) (execution.RepositoryCheckpoint, error) {
	s.calls++
	if s.beforeCapture != nil {
		if err := s.beforeCapture(); err != nil {
			return execution.RepositoryCheckpoint{}, err
		}
	}
	return execution.RepositoryCheckpoint{}, s.err
}

func (*runnerProcessTrackerStub) PrepareProcess(bridgeruntime.GovernedProcessIdentity) (bridgeruntime.GovernedProcessLease, error) {
	return nil, errors.New("fake adapter must not create a process lease")
}

func (*governedFakeAdapter) Name() string { return "codex" }
func (*governedFakeAdapter) Capabilities() bridgeruntime.Capabilities {
	return bridgeruntime.Capabilities{}
}
func (a *governedFakeAdapter) Execute(ctx context.Context, _ bridgeruntime.Request, emit bridgeruntime.EmitFunc) error {
	a.calls++
	for _, event := range a.events {
		if err := emit(ctx, event); err != nil {
			return err
		}
	}
	return nil
}

func runtimeStatusEvents(statuses ...contracts.RunExecutionStatus) []bridgeruntime.Event {
	events := make([]bridgeruntime.Event, 0, len(statuses))
	for _, status := range statuses {
		status := status
		events = append(events, bridgeruntime.Event{Status: &status})
	}
	return events
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
