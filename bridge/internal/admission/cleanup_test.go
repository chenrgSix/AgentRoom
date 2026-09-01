package admission

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/repository"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type cleanupBindingsStub struct {
	order   *[]string
	grantID string
	scope   repository.CleanupScope
	err     error
}

func (s cleanupBindingsStub) WithCleanupGrantAuthority(_ context.Context, grant string,
	scope repository.CleanupScope, _ time.Time, action func() error) error {
	*s.order = append(*s.order, "grant")
	if s.err != nil {
		return s.err
	}
	if grant != s.grantID || !reflect.DeepEqual(scope, s.scope) {
		return repository.ErrGrantDenied
	}
	return action()
}

type cleanupFenceStub struct {
	order *[]string
	scope repository.CleanupScope
	view  RuntimeAdmissionView
	err   error
}

func (s cleanupFenceStub) WithStoppedRun(_ context.Context, scope repository.CleanupScope,
	action StoppedRunAuthority) error {
	*s.order = append(*s.order, "stopped")
	if s.err != nil {
		return s.err
	}
	if !reflect.DeepEqual(scope, s.scope) {
		return ErrAdmissionNotCurrent
	}
	return action(s.view)
}

type cleanupProcessStub struct {
	order    *[]string
	identity bridgeruntime.GovernedProcessIdentity
	err      error
}

func (s cleanupProcessStub) RequireFinished(identity bridgeruntime.GovernedProcessIdentity) error {
	*s.order = append(*s.order, "process")
	if s.err != nil {
		return s.err
	}
	if identity != s.identity {
		return ErrAdmissionChanged
	}
	return nil
}

func TestGovernedCleanupAuthorityHoldsGrantStopAndProcessProof(t *testing.T) {
	scope := repository.CleanupScope{OperationID: "op_cleanup_authority0001",
		CheckpointID: "checkpoint_authority0001", CheckpointDigest: repeatDigest("a"),
		RunID: "run_cleanupauthority0001", RepositoryID: "repo_cleanupauthority0001",
		BindingID: "repobind_cleanupauthority0001", PlanID: "plan_cleanupauthority0001",
		PlanRevision: 1, NodeKey: "Build", TaskID: "task_cleanupauthority0001",
		AgentID: "agent_cleanupauthority0001", DeviceID: "device_cleanupauthority0001",
		WorkspaceRef: "workspace_cleanupauthority0001", Generation: repeatDigest("b"),
		ManifestDigest: repeatDigest("c")}
	startDigest := repeatDigest("d")
	view := RuntimeAdmissionView{Spec: RuntimeAdmissionSpec{RunID: scope.RunID},
		AdmissionDigest: repeatDigest("e"), StartDigest: &startDigest}
	identity := bridgeruntime.GovernedProcessIdentity{RunID: scope.RunID,
		AdmissionDigest: view.AdmissionDigest, StartDigest: startDigest}
	order := []string{}
	authority, err := newGovernedCleanupAuthority(
		cleanupBindingsStub{order: &order, grantID: "cleanupgrant_authority0001", scope: scope},
		cleanupFenceStub{order: &order, scope: scope, view: view},
		cleanupProcessStub{order: &order, identity: identity}, "cleanupgrant_authority0001")
	if err != nil {
		t.Fatal(err)
	}
	authority.now = func() time.Time { return runtimeFenceNow }
	if err := authority.WithCleanupAuthority(context.Background(), scope, func() error {
		order = append(order, "cleanup")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(order, []string{"grant", "stopped", "process", "cleanup"}) {
		t.Fatalf("order=%v", order)
	}
}

func TestGovernedCleanupAuthorityFailsBeforeMutation(t *testing.T) {
	scope := repository.CleanupScope{RunID: "run_cleanupdenied0001"}
	denied := errors.New("denied")
	for name, configure := range map[string]func(*cleanupBindingsStub, *cleanupFenceStub, *cleanupProcessStub){
		"grant":   func(v *cleanupBindingsStub, _ *cleanupFenceStub, _ *cleanupProcessStub) { v.err = denied },
		"stopped": func(_ *cleanupBindingsStub, v *cleanupFenceStub, _ *cleanupProcessStub) { v.err = denied },
		"process": func(_ *cleanupBindingsStub, _ *cleanupFenceStub, v *cleanupProcessStub) { v.err = denied },
	} {
		t.Run(name, func(t *testing.T) {
			order := []string{}
			start := repeatDigest("a")
			view := RuntimeAdmissionView{Spec: RuntimeAdmissionSpec{RunID: scope.RunID},
				AdmissionDigest: repeatDigest("b"), StartDigest: &start}
			bindings := cleanupBindingsStub{order: &order, grantID: "cleanupgrant_denied0001", scope: scope}
			fence := cleanupFenceStub{order: &order, scope: scope, view: view}
			process := cleanupProcessStub{order: &order, identity: bridgeruntime.GovernedProcessIdentity{
				RunID: scope.RunID, AdmissionDigest: view.AdmissionDigest, StartDigest: start}}
			configure(&bindings, &fence, &process)
			authority, err := newGovernedCleanupAuthority(bindings, fence, process, "cleanupgrant_denied0001")
			if err != nil {
				t.Fatal(err)
			}
			mutated := false
			if err := authority.WithCleanupAuthority(context.Background(), scope,
				func() error { mutated = true; return nil }); !errors.Is(err, denied) || mutated {
				t.Fatalf("order=%v mutated=%t err=%v", order, mutated, err)
			}
		})
	}
}

func repeatDigest(value string) string {
	result := ""
	for len(result) < 64 {
		result += value
	}
	return result[:64]
}

var _ governedCleanupPreparer = (*cleanupPreparerCompileStub)(nil)

type cleanupPreparerCompileStub struct{}

func (*cleanupPreparerCompileStub) PreviewCleanup(context.Context, string,
	execution.RepositoryCheckpoint, repository.CleanupAuthority) (repository.CleanupPreview, error) {
	return repository.CleanupPreview{}, nil
}

func (*cleanupPreparerCompileStub) CleanupWorkspace(context.Context, repository.CleanupRequest,
	repository.CleanupAuthority) (repository.CleanupReceipt, error) {
	return repository.CleanupReceipt{}, nil
}
