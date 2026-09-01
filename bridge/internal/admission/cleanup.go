package admission

import (
	"context"
	"time"

	"convenewire.dev/bridge/internal/repository"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type governedCleanupBindings interface {
	WithCleanupGrantAuthority(context.Context, string, repository.CleanupScope,
		time.Time, func() error) error
}

type governedCleanupFence interface {
	WithStoppedRun(context.Context, repository.CleanupScope, StoppedRunAuthority) error
}

type governedCleanupProcess interface {
	RequireFinished(bridgeruntime.GovernedProcessIdentity) error
}

type governedCleanupPreparer interface {
	PreviewCleanup(context.Context, string, execution.RepositoryCheckpoint,
		repository.CleanupAuthority) (repository.CleanupPreview, error)
	CleanupWorkspace(context.Context, repository.CleanupRequest,
		repository.CleanupAuthority) (repository.CleanupReceipt, error)
}

// GovernedCleanupAuthority joins one cleanup-only owner grant, the exact
// stopped-Run fence and physical process absence. It contains no paths and
// grants authority only during the repository primitive's callback.
type GovernedCleanupAuthority struct {
	bindings governedCleanupBindings
	fence    governedCleanupFence
	process  governedCleanupProcess
	grantID  string
	now      func() time.Time
}

func NewGovernedCleanupAuthority(bindings *repository.BindingStore,
	fence *RuntimeFenceStore, processes *GovernedProcessStore,
	grantID string) (*GovernedCleanupAuthority, error) {
	return newGovernedCleanupAuthority(bindings, fence,
		&RuntimeProcessCompletion{store: processes}, grantID)
}

func newGovernedCleanupAuthority(bindings governedCleanupBindings,
	fence governedCleanupFence, process governedCleanupProcess,
	grantID string) (*GovernedCleanupAuthority, error) {
	if bindings == nil || fence == nil || process == nil || grantID == "" {
		return nil, ErrAdmissionInvalid
	}
	return &GovernedCleanupAuthority{bindings: bindings, fence: fence,
		process: process, grantID: grantID, now: time.Now}, nil
}

func (a *GovernedCleanupAuthority) WithCleanupAuthority(ctx context.Context,
	scope repository.CleanupScope, action func() error) error {
	if a == nil || a.now == nil || action == nil {
		return ErrAdmissionInvalid
	}
	return a.bindings.WithCleanupGrantAuthority(ctx, a.grantID, scope,
		a.now().UTC(), func() error {
			return a.fence.WithStoppedRun(ctx, scope, func(view RuntimeAdmissionView) error {
				identity := bridgeruntime.GovernedProcessIdentity{RunID: view.Spec.RunID,
					AdmissionDigest: view.AdmissionDigest, StartDigest: *view.StartDigest}
				if err := a.process.RequireFinished(identity); err != nil {
					return err
				}
				return action()
			})
		})
}

// GovernedCleanupCoordinator exposes only preview and exact confirmed
// retirement. The checkpoint determines every path and scope.
type GovernedCleanupCoordinator struct {
	preparer  governedCleanupPreparer
	authority *GovernedCleanupAuthority
}

func NewGovernedCleanupCoordinator(preparer *repository.Preparer,
	authority *GovernedCleanupAuthority) (*GovernedCleanupCoordinator, error) {
	if preparer == nil || authority == nil {
		return nil, ErrAdmissionInvalid
	}
	return &GovernedCleanupCoordinator{preparer: preparer, authority: authority}, nil
}

func (c *GovernedCleanupCoordinator) Preview(ctx context.Context, operationID string,
	checkpoint execution.RepositoryCheckpoint) (repository.CleanupPreview, error) {
	if c == nil || c.preparer == nil || c.authority == nil {
		return repository.CleanupPreview{}, ErrAdmissionInvalid
	}
	return c.preparer.PreviewCleanup(ctx, operationID, checkpoint, c.authority)
}

func (c *GovernedCleanupCoordinator) Execute(ctx context.Context,
	request repository.CleanupRequest) (repository.CleanupReceipt, error) {
	if c == nil || c.preparer == nil || c.authority == nil {
		return repository.CleanupReceipt{}, ErrAdmissionInvalid
	}
	return c.preparer.CleanupWorkspace(ctx, request, c.authority)
}
