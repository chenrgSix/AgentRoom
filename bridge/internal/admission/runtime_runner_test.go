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
			adapter := &governedFakeAdapter{events: test.events}
			runner, err := newGovernedRuntimeRunner(coordinator,
				map[string]config.AgentConfig{ticket.manifest.Scope.AgentID: configured}, nil,
				func(agent config.AgentConfig, _ bridgeruntime.RuntimeSessionStore) bridgeruntime.Adapter {
					used = agent
					return adapter
				})
			if err != nil {
				t.Fatal(err)
			}
			runner.now = func() time.Time { return runtimeFenceNow.Add(time.Minute) }
			var emitted []bridgeruntime.Event
			view, runErr := runner.Run(context.Background(), ticket, decision,
				func(_ context.Context, event bridgeruntime.Event) error {
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
				view.State != RuntimeAdmissionStopped || view.Outcome == nil || *view.Outcome != test.want {
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
	}}, nil, func(config.AgentConfig, bridgeruntime.RuntimeSessionStore) bridgeruntime.Adapter { return nil })
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
	}}, nil, func(config.AgentConfig, bridgeruntime.RuntimeSessionStore) bridgeruntime.Adapter { return adapter })
	if err != nil {
		t.Fatal(err)
	}
	runner.now = func() time.Time { return runtimeFenceNow.Add(time.Minute) }
	view, err := runner.Run(context.Background(), ticket, decision, func(context.Context, bridgeruntime.Event) error { return nil })
	if !errors.Is(err, ErrAdmissionChanged) || view.Outcome == nil || *view.Outcome != RuntimeOutcomeCompleted || rig.stopCalls != 1 {
		t.Fatalf("post-terminal view=%+v err=%v stops=%d", view, err, rig.stopCalls)
	}
	replay := decision
	replay.Invoke = false
	if _, err := runner.Run(context.Background(), ticket, replay, func(context.Context, bridgeruntime.Event) error { return nil }); !errors.Is(err, ErrAdmissionInvalid) || adapter.calls != 1 || rig.stopCalls != 1 {
		t.Fatalf("replay error=%v adapterCalls=%d stopCalls=%d", err, adapter.calls, rig.stopCalls)
	}
}

type governedFakeAdapter struct {
	events []bridgeruntime.Event
	calls  int
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
