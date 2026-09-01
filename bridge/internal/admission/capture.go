package admission

import (
	"context"
	"reflect"
	"time"

	"convenewire.dev/bridge/internal/repository"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type governedCapturePreparer interface {
	Capture(context.Context, repository.CaptureRequest) (repository.CapturedRepository, error)
	PublishCaptured(context.Context, repository.CapturePublication, repository.CaptureTransport) (execution.RepositoryCheckpoint, error)
}

type governedCaptureFence interface {
	Get(string) (RuntimeAdmissionView, error)
}

type governedCaptureProcess interface {
	RequireFinished(bridgeruntime.GovernedProcessIdentity) error
}

// GovernedCaptureCoordinator is the sole production join from a completed,
// physically absent governed Runtime to the existing immutable repository
// capture/publication primitives. It does not emit a Run terminal event,
// propose a Result, verify code, or authorize cleanup.
type GovernedCaptureCoordinator struct {
	bindings  governedBindings
	preparer  governedCapturePreparer
	fence     governedCaptureFence
	processes governedCaptureProcess
	transport repository.CaptureTransport
	now       func() time.Time
}

func NewGovernedCaptureCoordinator(bindings *repository.BindingStore, preparer *repository.Preparer,
	fence *RuntimeFenceStore, processes *GovernedProcessStore,
	transport repository.CaptureTransport) (*GovernedCaptureCoordinator, error) {
	return newGovernedCaptureCoordinator(bindings, preparer, fence,
		&RuntimeProcessCompletion{store: processes}, transport)
}

func newGovernedCaptureCoordinator(bindings governedBindings, preparer governedCapturePreparer,
	fence governedCaptureFence, processes governedCaptureProcess,
	transport repository.CaptureTransport) (*GovernedCaptureCoordinator, error) {
	if bindings == nil || preparer == nil || fence == nil || processes == nil || transport == nil {
		return nil, ErrAdmissionInvalid
	}
	return &GovernedCaptureCoordinator{bindings: bindings, preparer: preparer, fence: fence,
		processes: processes, transport: transport, now: time.Now}, nil
}

// CaptureCompleted requires the exact still-starting admission and a finished
// process journal. Central remains authoritative for whether the Run and
// isolated lease are still eligible when publication begins.
func (c *GovernedCaptureCoordinator) CaptureCompleted(ctx context.Context, ticket GovernedAdmissionTicket,
	decision GovernedStartDecision) (execution.RepositoryCheckpoint, error) {
	var empty execution.RepositoryCheckpoint
	if c == nil || c.now == nil || !decision.Invoke || decision.View.State != RuntimeAdmissionStarting ||
		decision.View.StartDigest == nil || decision.workspace == "" || decision.workspace != ticket.prepared.Path ||
		decision.View.Spec != ticket.admission.Spec || decision.View.AdmissionDigest != ticket.admission.AdmissionDigest {
		return empty, ErrAdmissionInvalid
	}
	manifest, err := DecodeGovernedManifest(ticket.request)
	if err != nil || !reflect.DeepEqual(manifest, ticket.manifest) || manifest.Capture == nil ||
		manifest.Capture.OperationID == decision.View.Spec.PreparedOperationID {
		return empty, ErrAdmissionChanged
	}
	current, err := c.fence.Get(manifest.Scope.RunID)
	if err != nil {
		return empty, err
	}
	if current.State != RuntimeAdmissionStarting || current.StartDigest == nil ||
		current.Spec != decision.View.Spec || current.AdmissionDigest != decision.View.AdmissionDigest ||
		*current.StartDigest != *decision.View.StartDigest {
		return empty, ErrAdmissionChanged
	}
	identity := bridgeruntime.GovernedProcessIdentity{RunID: current.Spec.RunID,
		AdmissionDigest: current.AdmissionDigest, StartDigest: *current.StartDigest}
	if err := c.processes.RequireFinished(identity); err != nil {
		return empty, err
	}
	now := c.now().UTC()
	if now.IsZero() {
		return empty, ErrAdmissionInvalid
	}
	if err := c.bindings.CheckTaskGrant(ctx, manifest, execution.Capture, now); err != nil {
		return empty, err
	}
	publication, err := capturePublication(manifest)
	if err != nil {
		return empty, err
	}
	captured, err := c.preparer.Capture(ctx, repository.CaptureRequest{
		OperationID: publication.Operation.OperationID, WorkspaceRef: current.Spec.WorkspaceRef,
		PreparedDigest: current.Spec.PreparedIntentDigest, ExpectedGeneration: current.Spec.WorkspaceGeneration,
		ManifestDigest: current.Spec.ManifestDigest,
	})
	if err != nil {
		return empty, err
	}
	publication.CaptureDigest = captured.Digest
	checkpoint, err := c.preparer.PublishCaptured(ctx, publication, c.transport)
	if err != nil {
		return empty, err
	}
	if checkpoint.OperationID != publication.Operation.OperationID || checkpoint.Scope.RunID != current.Spec.RunID ||
		checkpoint.WorkspaceRef != current.Spec.WorkspaceRef || checkpoint.WorkspaceGeneration != current.Spec.WorkspaceGeneration ||
		checkpoint.RepositoryID != current.Spec.RepositoryID || checkpoint.BindingID != current.Spec.BindingID {
		return empty, ErrAdmissionChanged
	}
	return checkpoint, nil
}

func capturePublication(manifest execution.GovernedExecutionManifest) (repository.CapturePublication, error) {
	var publication repository.CapturePublication
	if manifest.Capture == nil {
		return publication, ErrAdmissionInvalid
	}
	scope := execution.RepositoryOperationRequestExecution(manifest.Scope)
	operation := execution.RepositoryOperationRequest{Version: 1, OperationID: manifest.Capture.OperationID,
		Plan: execution.RepositoryOperationRequestPlan{PlanID: scope.PlanID, Revision: scope.PlanRevision,
			Digest: scope.PlanDigest, ApprovalOperationID: scope.ApprovalOperationID,
			RoomID: scope.RoomID, RootTaskID: manifest.Capture.RootTaskID},
		Execution: &scope, RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID,
		DeviceID: scope.DeviceID, Grant: execution.RepositoryOperationRequestGrant(manifest.Grant),
		ExpectedGeneration: manifest.Workspace.WorkspaceGeneration, Deadline: manifest.Deadline,
		Action: execution.ActionClass{Kind: execution.Capture,
			Capture: &execution.ActionCapture{ManifestDigest: manifest.ManifestDigest}}}
	requestDigest, err := executionDigest(operation, "requestDigest")
	if err != nil {
		return publication, ErrAdmissionInvalid
	}
	operation.RequestDigest = requestDigest
	outputs := make([]repository.CaptureOutputDescription, 0, len(manifest.Capture.Outputs))
	for _, output := range manifest.Capture.Outputs {
		path := ""
		if output.Path != nil {
			path = *output.Path
		}
		outputs = append(outputs, repository.CaptureOutputDescription{SlotKey: output.SlotKey,
			Title: output.Title, Summary: output.Summary, Path: path})
	}
	publication = repository.CapturePublication{Manifest: manifest, Operation: operation, Outputs: outputs}
	if err := repository.ValidateCapturePublicationIntent(manifest, operation, outputs); err != nil {
		return repository.CapturePublication{}, err
	}
	return publication, nil
}
