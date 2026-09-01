package admission

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	"convenewire.dev/bridge/internal/repository"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	"convenewire.dev/bridge/internal/verification"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type governedVerificationPreparer interface {
	MaterializeVerificationCandidate(context.Context, execution.RepositoryCheckpoint, string) (string, error)
}

type governedVerificationProfiles interface {
	Resolve(verification.Reference) (verification.ResolvedProfile, error)
}

type governedVerificationJournal interface {
	PutTerminal(verification.TerminalRecord) error
	Terminal(string) (*verification.TerminalRecord, error)
	PutReceipt(execution.VerificationReceipt) error
	Receipt(string) (*execution.VerificationReceipt, error)
}

type governedVerificationTransport interface {
	Begin(context.Context, execution.RepositoryOperationRequest) (verification.Admission, error)
	PublishLog(context.Context, execution.GovernedExecutionManifest,
		execution.RepositoryOperationRequest, string, []byte) (artifact.PublishResult, error)
	Retain(context.Context, execution.VerificationReceipt) (verification.RetainedReceipt, error)
}

// GovernedVerificationCoordinator is the sole join between a sealed captured
// candidate, owner-local verifier processes and Central receipt authority.
// It never changes Run or Node state and never mutates the owner source checkout.
type GovernedVerificationCoordinator struct {
	bindings  governedBindings
	preparer  governedVerificationPreparer
	profiles  governedVerificationProfiles
	journal   governedVerificationJournal
	fence     governedCaptureFence
	processes governedCaptureProcess
	transport governedVerificationTransport
	runner    verification.Runner
	now       func() time.Time
}

func NewGovernedVerificationCoordinator(bindings *repository.BindingStore,
	preparer *repository.Preparer, profiles *verification.ProfileStore,
	journal *verification.Journal, fence *RuntimeFenceStore,
	processes *GovernedProcessStore, transport *verification.Client) (*GovernedVerificationCoordinator, error) {
	return newGovernedVerificationCoordinator(bindings, preparer, profiles, journal,
		fence, &RuntimeProcessCompletion{store: processes}, transport, verification.Runner{})
}

func newGovernedVerificationCoordinator(bindings governedBindings,
	preparer governedVerificationPreparer, profiles governedVerificationProfiles,
	journal governedVerificationJournal, fence governedCaptureFence,
	processes governedCaptureProcess, transport governedVerificationTransport,
	runner verification.Runner) (*GovernedVerificationCoordinator, error) {
	if bindings == nil || preparer == nil || profiles == nil || journal == nil ||
		fence == nil || processes == nil || transport == nil {
		return nil, ErrAdmissionInvalid
	}
	return &GovernedVerificationCoordinator{bindings: bindings, preparer: preparer,
		profiles: profiles, journal: journal, fence: fence, processes: processes,
		transport: transport, runner: runner, now: time.Now}, nil
}

func (c *GovernedVerificationCoordinator) VerifyCaptured(ctx context.Context,
	ticket GovernedAdmissionTicket, decision GovernedStartDecision,
	checkpoint execution.RepositoryCheckpoint) ([]verification.RetainedReceipt, error) {
	if c == nil || c.now == nil || ctx == nil || !decision.Invoke ||
		decision.View.State != RuntimeAdmissionStarting || decision.View.StartDigest == nil ||
		decision.workspace == "" || decision.workspace != ticket.prepared.Path ||
		decision.View.Spec != ticket.admission.Spec ||
		decision.View.AdmissionDigest != ticket.admission.AdmissionDigest {
		return nil, ErrAdmissionInvalid
	}
	manifest, err := DecodeGovernedManifest(ticket.request)
	if err != nil || !reflect.DeepEqual(manifest, ticket.manifest) ||
		checkpoint.Scope != execution.RepositoryCheckpointScope(manifest.Scope) ||
		checkpoint.RepositoryID != manifest.Repository.RepositoryID ||
		checkpoint.BindingID != manifest.Repository.BindingID ||
		checkpoint.WorkspaceRef != manifest.Workspace.WorkspaceRef ||
		checkpoint.WorkspaceGeneration != manifest.Workspace.WorkspaceGeneration ||
		checkpoint.InputDigest != manifest.InputDigest {
		return nil, ErrAdmissionChanged
	}
	current, err := c.fence.Get(manifest.Scope.RunID)
	if err != nil {
		return nil, err
	}
	if current.State != RuntimeAdmissionStarting || current.StartDigest == nil ||
		current.Spec != decision.View.Spec || current.AdmissionDigest != decision.View.AdmissionDigest ||
		*current.StartDigest != *decision.View.StartDigest {
		return nil, ErrAdmissionChanged
	}
	identity := bridgeruntime.GovernedProcessIdentity{RunID: current.Spec.RunID,
		AdmissionDigest: current.AdmissionDigest, StartDigest: *current.StartDigest}
	if err := c.processes.RequireFinished(identity); err != nil {
		return nil, err
	}
	profiles := requiredVerificationProfiles(manifest.VerificationProfiles)
	if len(profiles) == 0 {
		return []verification.RetainedReceipt{}, nil
	}
	now := c.now().UTC()
	if now.IsZero() || c.bindings.CheckTaskGrant(ctx, manifest, execution.Verify, now) != nil {
		return nil, ErrProfileDenied
	}
	capture, err := capturePublication(manifest)
	if err != nil {
		return nil, err
	}
	receipts := make([]verification.RetainedReceipt, 0, len(profiles))
	err = c.runner.WithRunRoot(ctx, func(runRoot string) error {
		for index, pin := range profiles {
			operation, err := verificationOperation(manifest, checkpoint,
				capture.Operation.Plan.RootTaskID, pin)
			if err != nil {
				return err
			}
			retained, err := c.verifyOne(ctx, manifest, checkpoint,
				capture.Operation, operation, pin, runRoot, index)
			if err != nil {
				return err
			}
			receipts = append(receipts, retained)
		}
		return nil
	})
	return receipts, err
}

func (c *GovernedVerificationCoordinator) verifyOne(ctx context.Context,
	manifest execution.GovernedExecutionManifest, checkpoint execution.RepositoryCheckpoint,
	captureOperation, operation execution.RepositoryOperationRequest,
	pin execution.GovernedExecutionManifestVerificationProfile, runRoot string,
	index int) (verification.RetainedReceipt, error) {
	if receipt, err := c.journal.Receipt(operation.OperationID); err != nil {
		return verification.RetainedReceipt{}, err
	} else if receipt != nil {
		return c.transport.Retain(ctx, *receipt)
	}
	terminal, err := c.journal.Terminal(operation.OperationID)
	if err != nil {
		return verification.RetainedReceipt{}, err
	}
	if terminal == nil {
		resolved, err := c.profiles.Resolve(verification.Reference{ProfileID: pin.ProfileID,
			Revision: pin.Revision, Digest: pin.Digest})
		if err != nil {
			return verification.RetainedReceipt{}, err
		}
		profileRoot := filepath.Join(runRoot, "profile-"+verificationIndex(index))
		if err := os.Mkdir(profileRoot, 0o700); err != nil {
			return verification.RetainedReceipt{}, err
		}
		workspace, err := c.preparer.MaterializeVerificationCandidate(ctx, checkpoint, profileRoot)
		if err != nil {
			return verification.RetainedReceipt{}, err
		}
		if _, err := c.transport.Begin(ctx, operation); err != nil {
			return verification.RetainedReceipt{}, err
		}
		// Resolve the immutable executable and recheck the current local grant
		// again after Central admission and immediately before process start.
		resolved, err = c.profiles.Resolve(resolved.Reference)
		if err != nil || c.bindings.CheckTaskGrant(ctx, manifest, execution.Verify,
			c.now().UTC()) != nil {
			return verification.RetainedReceipt{}, ErrProfileDenied
		}
		result, err := c.runner.RunInRoot(ctx, resolved, workspace, runRoot)
		if err != nil {
			return verification.RetainedReceipt{}, err
		}
		record := verification.TerminalRecord{Version: 1, Operation: operation,
			Checkpoint: checkpoint, Result: result}
		if err := c.journal.PutTerminal(record); err != nil {
			return verification.RetainedReceipt{}, err
		}
		terminal = &record
	}
	if !reflect.DeepEqual(terminal.Operation, operation) ||
		!reflect.DeepEqual(terminal.Checkpoint, checkpoint) {
		return verification.RetainedReceipt{}, ErrAdmissionChanged
	}
	log, err := c.transport.PublishLog(ctx, manifest, captureOperation,
		operation.OperationID, terminal.Result.Log)
	if err != nil {
		return verification.RetainedReceipt{}, err
	}
	receipt, err := verificationReceipt(operation, checkpoint, terminal.Result, log)
	if err != nil {
		return verification.RetainedReceipt{}, err
	}
	if err := c.journal.PutReceipt(receipt); err != nil {
		return verification.RetainedReceipt{}, err
	}
	return c.transport.Retain(ctx, receipt)
}

func requiredVerificationProfiles(input []execution.GovernedExecutionManifestVerificationProfile) []execution.GovernedExecutionManifestVerificationProfile {
	result := make([]execution.GovernedExecutionManifestVerificationProfile, 0, len(input))
	for _, profile := range input {
		if profile.Required {
			result = append(result, profile)
		}
	}
	slices.SortFunc(result, func(a, b execution.GovernedExecutionManifestVerificationProfile) int {
		if a.ProfileID < b.ProfileID {
			return -1
		}
		if a.ProfileID > b.ProfileID {
			return 1
		}
		return 0
	})
	return result
}

func verificationOperation(manifest execution.GovernedExecutionManifest,
	checkpoint execution.RepositoryCheckpoint, rootTaskID string,
	profile execution.GovernedExecutionManifestVerificationProfile) (execution.RepositoryOperationRequest, error) {
	scope := execution.RepositoryOperationRequestExecution(manifest.Scope)
	identity, err := executionDigest(struct {
		Kind       string `json:"kind"`
		Checkpoint string `json:"checkpoint"`
		ProfileID  string `json:"profileId"`
		Revision   int64  `json:"revision"`
		Digest     string `json:"digest"`
	}{"verification", checkpoint.Digest, profile.ProfileID, profile.Revision, profile.Digest}, "")
	if err != nil {
		return execution.RepositoryOperationRequest{}, err
	}
	operation := execution.RepositoryOperationRequest{Version: 1,
		OperationID: "op_verification_" + identity,
		Plan: execution.RepositoryOperationRequestPlan{PlanID: scope.PlanID,
			Revision: scope.PlanRevision, Digest: scope.PlanDigest,
			ApprovalOperationID: scope.ApprovalOperationID, RoomID: scope.RoomID,
			RootTaskID: rootTaskID}, Execution: &scope,
		RepositoryID: manifest.Repository.RepositoryID,
		BindingID:    manifest.Repository.BindingID, DeviceID: scope.DeviceID,
		Grant:              execution.RepositoryOperationRequestGrant(manifest.Grant),
		ExpectedGeneration: manifest.Workspace.WorkspaceGeneration,
		Deadline:           manifest.Deadline, Action: execution.ActionClass{Kind: execution.Verify,
			Verify: &execution.VerifyClass{CandidateCommit: checkpoint.CandidateCommit,
				CandidateTree: checkpoint.CandidateTree, InputDigest: checkpoint.InputDigest,
				Profile: execution.VerifyProfile{ProfileID: profile.ProfileID,
					Revision: profile.Revision, Digest: profile.Digest}}}}
	operation.RequestDigest, err = executionDigest(operation, "requestDigest")
	return operation, err
}

func verificationReceipt(operation execution.RepositoryOperationRequest,
	checkpoint execution.RepositoryCheckpoint, result verification.Result,
	log artifact.PublishResult) (execution.VerificationReceipt, error) {
	action := operation.Action.Verify
	if action == nil || len(result.Log) == 0 {
		return execution.VerificationReceipt{}, ErrAdmissionInvalid
	}
	deviceID := operation.DeviceID
	var exitCode *int64
	if result.ExitCode != nil {
		value := int64(*result.ExitCode)
		exitCode = &value
	}
	receipt := execution.VerificationReceipt{Version: 1,
		OperationID: operation.OperationID, RequestDigest: operation.RequestDigest,
		Plan:         execution.VerificationReceiptPlan(operation.Plan),
		Execution:    (*execution.VerificationReceiptExecution)(operation.Execution),
		RepositoryID: operation.RepositoryID, BindingID: &operation.BindingID,
		Authority:       execution.Authority{Kind: execution.Bridge, DeviceID: &deviceID},
		CandidateCommit: checkpoint.CandidateCommit, CandidateTree: checkpoint.CandidateTree,
		InputDigest:          checkpoint.InputDigest,
		Profile:              execution.VerificationReceiptProfile(action.Profile),
		StartedAt:            result.StartedAt.UTC().Format(time.RFC3339Nano),
		FinishedAt:           result.FinishedAt.UTC().Format(time.RFC3339Nano),
		DurationMilliseconds: result.DurationMilliseconds, ExitCode: exitCode,
		Outcome: execution.Outcome(result.Outcome),
		LogArtifact: &execution.LogArtifact{ArtifactID: log.ArtifactID,
			ArtifactRevision: log.Revision, ContentDigest: log.SHA256,
			ByteLength: int64(len(result.Log)), Kind: execution.TestResult}}
	identity, err := executionDigest(struct {
		OperationID string `json:"operationId"`
		Request     string `json:"requestDigest"`
		Outcome     string `json:"outcome"`
		FinishedAt  string `json:"finishedAt"`
	}{receipt.OperationID, receipt.RequestDigest, string(receipt.Outcome), receipt.FinishedAt}, "")
	if err != nil {
		return execution.VerificationReceipt{}, err
	}
	receipt.VerificationID = "verification_" + identity
	return receipt, nil
}

func verificationIndex(index int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	if index < 0 || index >= len(alphabet) {
		return "overflow"
	}
	return string(alphabet[index])
}
