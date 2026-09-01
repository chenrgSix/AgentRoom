package delivery

import (
	"context"
	"errors"
	"fmt"
	"time"

	"convenewire.dev/bridge/internal/admission"
)

var ErrGovernedRecoveryInconsistent = errors.New("governed Runtime recovery inventory is inconsistent")

// GovernedRecoveryFence is the durable possible-start inventory. Stop closes
// only the exact start digest after process fencing has completed.
type GovernedRecoveryFence interface {
	List() ([]admission.RuntimeAdmissionView, error)
	Stop(string, string, string, admission.RuntimeOutcome, time.Time) (admission.RuntimeAdmissionView, error)
}

// GovernedProcessFencer must return nil only after the exact recorded Runtime
// process tree is absent. A missing or unverifiable process identity is an
// error, not proof that the process stopped.
type GovernedProcessFencer interface {
	FenceAll(context.Context) error
	FenceAndWait(context.Context, admission.RuntimeAdmissionView) error
}

// GovernedRecovery joins Inbox and possible-start inventory before ordinary
// restart recovery is allowed to mutate either. It never re-invokes a Runtime.
type GovernedRecovery struct {
	Inbox     *Inbox
	Fence     GovernedRecoveryFence
	Processes GovernedProcessFencer
	Executor  *RuntimeExecutor
	Now       func() time.Time
}

// RecoverAll is the production composition point: governed process/fence
// recovery must finish before ordinary Inbox records can be recovered.
func (r *GovernedRecovery) RecoverAll(ctx context.Context, send Sender) error {
	if err := r.Recover(ctx, send); err != nil {
		return err
	}
	return r.Executor.recover(ctx, send, true)
}

func (r *GovernedRecovery) Recover(ctx context.Context, send Sender) error {
	if r == nil || r.Inbox == nil || r.Fence == nil || r.Processes == nil || r.Executor == nil ||
		r.Executor.Inbox != r.Inbox || send == nil {
		return ErrGovernedExecutionUnsupported
	}
	if err := r.Processes.FenceAll(ctx); err != nil {
		return err
	}
	records, err := r.Inbox.List()
	if err != nil {
		return err
	}
	views, err := r.Fence.List()
	if err != nil {
		return err
	}
	viewsByRun := make(map[string]admission.RuntimeAdmissionView, len(views))
	for _, view := range views {
		if _, duplicate := viewsByRun[view.Spec.RunID]; duplicate {
			return ErrGovernedRecoveryInconsistent
		}
		if err := validateGovernedRecoveryView(view); err != nil {
			return err
		}
		viewsByRun[view.Spec.RunID] = view
	}
	governedByRun := make(map[string]Record)
	var inventoryErr error
	for _, record := range records {
		if !isGovernedRequest(record.Request) {
			continue
		}
		if err := validateRecoveryRecord(record); err != nil {
			inventoryErr = errors.Join(inventoryErr, fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, record.RunID))
			continue
		}
		governedByRun[record.RunID] = record
		view, exists := viewsByRun[record.RunID]
		if exists {
			if err := admission.ValidateRuntimeAdmissionRequest(record.Request, view); err != nil {
				inventoryErr = errors.Join(inventoryErr, fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, record.RunID))
			}
		}
		if err := validateGovernedRecoveryState(record, view, exists); err != nil {
			inventoryErr = errors.Join(inventoryErr, err)
		}
	}
	for runID, view := range viewsByRun {
		if _, exists := governedByRun[runID]; !exists {
			inventoryErr = errors.Join(inventoryErr, fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, runID))
		}
		if view.State != admission.RuntimeAdmissionClaimed && view.State != admission.RuntimeAdmissionStarting &&
			view.State != admission.RuntimeAdmissionStopped {
			inventoryErr = errors.Join(inventoryErr, fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, runID))
		}
	}

	// Even inconsistent Inbox state cannot justify leaving an exact durable
	// possible-start process alive. Fence every starting record before returning
	// the inventory error that keeps the Bridge offline.
	for _, view := range views {
		if view.State != admission.RuntimeAdmissionStarting {
			continue
		}
		if view.StartDigest == nil {
			inventoryErr = errors.Join(inventoryErr, fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, view.Spec.RunID))
			continue
		}
		if err := r.Processes.FenceAndWait(ctx, view); err != nil {
			return errors.Join(inventoryErr, err)
		}
		closed, err := r.Fence.Stop(view.Spec.RunID, view.AdmissionDigest, *view.StartDigest,
			admission.RuntimeOutcomeUnknown, r.now())
		if err != nil {
			return errors.Join(inventoryErr, err)
		}
		if closed.Spec != view.Spec || closed.AdmissionDigest != view.AdmissionDigest ||
			closed.State != admission.RuntimeAdmissionStopped || closed.StartDigest == nil ||
			*closed.StartDigest != *view.StartDigest || closed.Outcome == nil ||
			*closed.Outcome != admission.RuntimeOutcomeUnknown {
			return errors.Join(inventoryErr, ErrGovernedRecoveryInconsistent)
		}
		viewsByRun[view.Spec.RunID] = closed
	}
	if inventoryErr != nil {
		return inventoryErr
	}

	for _, record := range records {
		if !isGovernedRequest(record.Request) {
			continue
		}
		view, hasView := viewsByRun[record.RunID]
		canceled, err := r.Inbox.HasCancellation(record.Request)
		if err != nil {
			return err
		}
		if canceled && !isTerminalState(record.State) {
			if err := r.Executor.cancelTombstonedRecord(ctx, record, send); err != nil {
				return err
			}
			continue
		}
		if isTerminalState(record.State) {
			if err := r.replay(ctx, record, send); err != nil {
				return err
			}
			if err := r.Executor.clearTerminalCancellationFence(record.Request); err != nil {
				return err
			}
			continue
		}
		if record.State == StatePreparing || !hasView || view.State == admission.RuntimeAdmissionClaimed {
			continue
		}
		if view.State != admission.RuntimeAdmissionStopped {
			return ErrGovernedRecoveryInconsistent
		}
		if err := r.recoverUnknown(ctx, record, send); err != nil {
			return err
		}
	}
	return nil
}

func validateGovernedRecoveryState(record Record, view admission.RuntimeAdmissionView, exists bool) error {
	if !exists {
		if record.State == StateWorking {
			return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, record.RunID)
		}
		return nil
	}
	switch view.State {
	case admission.RuntimeAdmissionClaimed:
		if record.State == StateWorking {
			return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, record.RunID)
		}
	case admission.RuntimeAdmissionStarting, admission.RuntimeAdmissionStopped:
		if record.State == StatePreparing {
			return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, record.RunID)
		}
	default:
		return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, record.RunID)
	}
	return nil
}

func validateGovernedRecoveryView(view admission.RuntimeAdmissionView) error {
	claimedAt, claimedErr := time.Parse(time.RFC3339Nano, view.ClaimedAt)
	if claimedErr != nil {
		return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, view.Spec.RunID)
	}
	switch view.State {
	case admission.RuntimeAdmissionClaimed:
		if view.StartDigest != nil || view.AuthorityCheckedAt != nil || view.Outcome != nil || view.StoppedAt != nil {
			return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, view.Spec.RunID)
		}
	case admission.RuntimeAdmissionStarting:
		if view.StartDigest == nil || view.AuthorityCheckedAt == nil || view.Outcome != nil || view.StoppedAt != nil {
			return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, view.Spec.RunID)
		}
		authorizedAt, err := time.Parse(time.RFC3339Nano, *view.AuthorityCheckedAt)
		if err != nil || authorizedAt.Before(claimedAt) {
			return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, view.Spec.RunID)
		}
	case admission.RuntimeAdmissionStopped:
		if view.StartDigest == nil || view.AuthorityCheckedAt == nil || view.Outcome == nil || view.StoppedAt == nil {
			return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, view.Spec.RunID)
		}
		authorizedAt, authorizedErr := time.Parse(time.RFC3339Nano, *view.AuthorityCheckedAt)
		stoppedAt, stoppedErr := time.Parse(time.RFC3339Nano, *view.StoppedAt)
		if authorizedErr != nil || stoppedErr != nil || authorizedAt.Before(claimedAt) || stoppedAt.Before(authorizedAt) ||
			!validGovernedRecoveryOutcome(*view.Outcome) {
			return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, view.Spec.RunID)
		}
	default:
		return fmt.Errorf("%w: %s", ErrGovernedRecoveryInconsistent, view.Spec.RunID)
	}
	return nil
}

func validGovernedRecoveryOutcome(outcome admission.RuntimeOutcome) bool {
	switch outcome {
	case admission.RuntimeOutcomeCompleted, admission.RuntimeOutcomeFailed, admission.RuntimeOutcomeCanceled,
		admission.RuntimeOutcomeInputRequired, admission.RuntimeOutcomeUnknown:
		return true
	default:
		return false
	}
}

func (r *GovernedRecovery) recoverUnknown(ctx context.Context, record Record, send Sender) error {
	var persisted []any
	if err := r.Executor.emitUnknown(ctx, record, func(_ context.Context, value any) error {
		persisted = append(persisted, value)
		return nil
	}, "GOVERNED_RUNTIME_RESTARTED"); err != nil {
		return err
	}
	if len(persisted) != 1 {
		return ErrGovernedRecoveryInconsistent
	}
	return r.replay(ctx, record, send)
}

func (r *GovernedRecovery) replay(ctx context.Context, record Record, send Sender) error {
	if err := send(ctx, governedAccepted(record, r.now())); err != nil {
		return err
	}
	return r.Executor.Replay(ctx, record, send)
}

func (r *GovernedRecovery) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}
