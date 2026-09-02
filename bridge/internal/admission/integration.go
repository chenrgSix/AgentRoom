package admission

import (
	"context"
	"errors"
	"reflect"
	"time"

	bridgeintegration "convenewire.dev/bridge/internal/integration"
	"convenewire.dev/bridge/internal/repository"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type governedIntegrationBindings interface {
	CheckIntegrationGrant(context.Context, execution.RepositoryOperationRequest, time.Time) error
	ResolveSource(context.Context, string, string, int) (repository.Source, error)
}

type governedIntegrationPreparer interface {
	IntegrateExactTarget(context.Context, repository.Source, execution.RepositoryOperationRequest,
		execution.RepositoryCheckpoint) (string, error)
	InspectIntegrationTarget(context.Context, repository.Source, string) (string, error)
}

type governedIntegrationJournal interface {
	PutIntent(bridgeintegration.IntentRecord) error
	Intent(string) (*bridgeintegration.IntentRecord, error)
	PutReceipt(execution.RepositoryOperationReceipt) error
	Receipt(string) (*execution.RepositoryOperationReceipt, error)
}

type governedIntegrationTransport interface {
	Get(context.Context, string) (bridgeintegration.Admission, error)
	Retain(context.Context, execution.RepositoryOperationReceipt) (bridgeintegration.RetainedReceipt, error)
}

// GovernedIntegrationCoordinator is the only Bridge component allowed to join
// a Central integration admission to the local atomic Git effect. Its durable
// intent is installed before CAS and its immutable receipt is replayed without
// running Git again.
type GovernedIntegrationCoordinator struct {
	bindings  governedIntegrationBindings
	preparer  governedIntegrationPreparer
	journal   governedIntegrationJournal
	transport governedIntegrationTransport
	now       func() time.Time
}

func NewGovernedIntegrationCoordinator(bindings *repository.BindingStore,
	preparer *repository.Preparer, journal *bridgeintegration.Journal,
	transport *bridgeintegration.Client) (*GovernedIntegrationCoordinator, error) {
	return newGovernedIntegrationCoordinator(bindings, preparer, journal, transport)
}

func newGovernedIntegrationCoordinator(bindings governedIntegrationBindings,
	preparer governedIntegrationPreparer, journal governedIntegrationJournal,
	transport governedIntegrationTransport) (*GovernedIntegrationCoordinator, error) {
	if bindings == nil || preparer == nil || journal == nil || transport == nil {
		return nil, ErrAdmissionInvalid
	}
	return &GovernedIntegrationCoordinator{bindings: bindings, preparer: preparer,
		journal: journal, transport: transport, now: time.Now}, nil
}

func (c *GovernedIntegrationCoordinator) Execute(ctx context.Context,
	operationID string) (bridgeintegration.RetainedReceipt, error) {
	if c == nil || c.now == nil || ctx == nil {
		return bridgeintegration.RetainedReceipt{}, ErrAdmissionInvalid
	}
	admission, err := c.transport.Get(ctx, operationID)
	if err != nil {
		return bridgeintegration.RetainedReceipt{}, err
	}
	if receipt, err := c.journal.Receipt(operationID); err != nil {
		return bridgeintegration.RetainedReceipt{}, err
	} else if receipt != nil {
		return c.transport.Retain(ctx, *receipt)
	}
	intent, err := c.journal.Intent(operationID)
	if err != nil {
		return bridgeintegration.RetainedReceipt{}, err
	}
	if intent != nil && !reflect.DeepEqual(intent.Admission, admission) {
		return bridgeintegration.RetainedReceipt{}, ErrAdmissionChanged
	}
	now := c.now().UTC()
	if now.IsZero() {
		return bridgeintegration.RetainedReceipt{}, ErrAdmissionInvalid
	}
	source, sourceErr := c.bindings.ResolveSource(ctx, admission.Operation.BindingID,
		admission.Operation.RepositoryID, 1)
	if intent != nil {
		return c.recoverOrExecute(ctx, admission, source, sourceErr, now)
	}
	if sourceErr != nil || c.bindings.CheckIntegrationGrant(ctx, admission.Operation, now) != nil {
		return c.retainTerminal(ctx, admission, execution.PurpleFailed,
			"INTEGRATION_LOCAL_AUTHORITY_UNAVAILABLE", now)
	}
	if err := c.journal.PutIntent(bridgeintegration.IntentRecord{Version: 1, Admission: admission}); err != nil {
		return bridgeintegration.RetainedReceipt{}, err
	}
	return c.executeCAS(ctx, admission, source, now)
}

func (c *GovernedIntegrationCoordinator) recoverOrExecute(ctx context.Context,
	admission bridgeintegration.Admission, source repository.Source, sourceErr error,
	now time.Time) (bridgeintegration.RetainedReceipt, error) {
	if sourceErr != nil {
		return c.retainTerminal(ctx, admission, execution.PurpleOutcomeUnknown,
			"INTEGRATION_RECOVERY_UNAVAILABLE", now)
	}
	action := admission.Operation.Action.Integrate
	current, err := c.preparer.InspectIntegrationTarget(ctx, source, action.Target.TargetRef)
	if err != nil {
		return c.retainTerminal(ctx, admission, execution.PurpleOutcomeUnknown,
			"INTEGRATION_RECOVERY_UNAVAILABLE", now)
	}
	if current == action.CandidateCommit {
		return c.retainTerminal(ctx, admission, execution.PurpleSucceeded, "", now)
	}
	if current != action.Target.ExpectedCommit {
		return c.retainTerminal(ctx, admission, execution.PurpleOutcomeUnknown,
			"INTEGRATION_TARGET_OUTCOME_UNKNOWN", now)
	}
	return c.executeCAS(ctx, admission, source, now)
}

func (c *GovernedIntegrationCoordinator) executeCAS(ctx context.Context,
	admission bridgeintegration.Admission, source repository.Source,
	now time.Time) (bridgeintegration.RetainedReceipt, error) {
	if err := c.bindings.CheckIntegrationGrant(ctx, admission.Operation, now); err != nil {
		return c.retainTerminal(ctx, admission, execution.PurpleFailed,
			"INTEGRATION_LOCAL_AUTHORITY_UNAVAILABLE", now)
	}
	_, err := c.preparer.IntegrateExactTarget(ctx, source, admission.Operation, admission.Checkpoint)
	if err == nil {
		return c.retainTerminal(ctx, admission, execution.PurpleSucceeded, "", c.now().UTC())
	}
	state, code := integrationFailure(err)
	return c.retainTerminal(ctx, admission, state, code, c.now().UTC())
}

func integrationFailure(err error) (execution.RepositoryOperationReceiptState, string) {
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return execution.FluffyCanceled, "INTEGRATION_CANCELED"
	case errors.Is(err, repository.ErrIntegrationTargetMoved):
		return execution.PurpleFailed, "INTEGRATION_TARGET_MOVED"
	case errors.Is(err, repository.ErrIntegrationTargetCheckedOut):
		return execution.PurpleFailed, "INTEGRATION_TARGET_CHECKED_OUT"
	case errors.Is(err, repository.ErrIntegrationNonFastForward):
		return execution.PurpleFailed, "INTEGRATION_NON_FAST_FORWARD"
	case errors.Is(err, repository.ErrIntegrationOutcomeUnknown):
		return execution.PurpleOutcomeUnknown, "INTEGRATION_TARGET_OUTCOME_UNKNOWN"
	default:
		return execution.PurpleFailed, "INTEGRATION_LOCAL_EFFECT_FAILED"
	}
}

func (c *GovernedIntegrationCoordinator) retainTerminal(ctx context.Context,
	admission bridgeintegration.Admission, state execution.RepositoryOperationReceiptState,
	errorCode string, now time.Time) (bridgeintegration.RetainedReceipt, error) {
	operation, checkpoint := admission.Operation, admission.Checkpoint
	action := operation.Action.Integrate
	generation, checkpointID := operation.ExpectedGeneration, checkpoint.CheckpointID
	candidateCommit, candidateTree := action.CandidateCommit, action.CandidateTree
	target := execution.RepositoryOperationReceiptTarget(action.Target)
	var errorPointer *string
	if errorCode != "" {
		errorPointer = &errorCode
	}
	receipt := execution.RepositoryOperationReceipt{Version: 1,
		OperationID: operation.OperationID, RequestDigest: operation.RequestDigest,
		Kind: execution.Integrate, RepositoryID: operation.RepositoryID,
		BindingID: operation.BindingID, DeviceID: operation.DeviceID, State: state,
		ObservedGeneration: &generation, CheckpointID: &checkpointID,
		VerificationID: nil, CandidateCommit: &candidateCommit, CandidateTree: &candidateTree,
		Target: &target, ProviderObservationID: nil, ErrorCode: errorPointer,
		RecordedAt: now.Format(time.RFC3339Nano)}
	if err := c.journal.PutReceipt(receipt); err != nil {
		return bridgeintegration.RetainedReceipt{}, err
	}
	return c.transport.Retain(ctx, receipt)
}
