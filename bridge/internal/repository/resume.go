package repository

import (
	"context"
	"encoding/json"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

// Only PrepareFromCheckpoint can supply this private, verified preparation
// input. Ordinary Prepare cannot impersonate a checkpoint through PatchInput.
type checkpointResumePin struct {
	RequestDigest      string `json:"requestDigest"`
	CheckpointID       string `json:"checkpointId"`
	CheckpointDigest   string `json:"checkpointDigest"`
	CaptureOperationID string `json:"captureOperationId"`
	CaptureDigest      string `json:"captureDigest"`
	SourceRunID        string `json:"sourceRunId"`
	SourceWorkspaceRef string `json:"sourceWorkspaceRef"`
	CandidateTree      string `json:"candidateTree"`
	PatchDigest        string `json:"patchDigest"`
	PatchBytes         int64  `json:"patchBytes"`
}

type checkpointResume struct {
	pin   checkpointResumePin
	patch []byte
}

func validPreparationVersion(intent preparationIntent) bool {
	if intent.Version == 2 {
		return intent.Resume == nil
	}
	if intent.Version != 3 || intent.Resume == nil {
		return false
	}
	pin := intent.Resume
	return sha256ID.MatchString(pin.RequestDigest) && sha256ID.MatchString(pin.CheckpointDigest) &&
		sha256ID.MatchString(pin.CaptureDigest) && sha256ID.MatchString(pin.PatchDigest) &&
		localID.MatchString(pin.CheckpointID) && localID.MatchString(pin.CaptureOperationID) &&
		localID.MatchString(pin.SourceRunID) && localID.MatchString(pin.SourceWorkspaceRef) &&
		pin.SourceRunID != intent.RunID && pin.SourceWorkspaceRef != intent.WorkspaceRef &&
		validObject(pin.CandidateTree, intent.Source.ObjectFormat) && pin.PatchBytes > 0 && pin.PatchBytes <= maximumCapturedPatch
}

func (resume *checkpointResume) checkInputs(inputs []PatchInput, limit int64) error {
	var used int64
	for _, input := range inputs {
		expansion, err := patchExpansionBound(input.Bytes, limit-used)
		if err != nil {
			return err
		}
		used += expansion
	}
	_, err := patchExpansionBound(resume.patch, limit-used)
	return err
}

// Digests bind exact content, not an authenticated principal or current grant.
func executionValueDigest(value any, field string) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	if field != "" {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return "", err
		}
		delete(fields, field)
		raw, err = json.Marshal(fields)
		if err != nil {
			return "", err
		}
	}
	return wire.ExecutionDigest(raw)
}

func resumeManifest(operation execution.RepositoryOperationRequest) (execution.GovernedExecutionManifest, error) {
	var manifest execution.GovernedExecutionManifest
	raw, err := json.Marshal(operation)
	if err != nil || wire.ValidateExecutionCommand("repositoryOperation", raw) != nil ||
		operation.Action.Kind != execution.Prepare || operation.Action.Prepare == nil ||
		operation.Action.Prepare.ResumeCheckpointID == nil || operation.Execution == nil {
		return manifest, ErrInvalid
	}
	key, err := executionValueDigest(operation, "requestDigest")
	if err != nil || key != operation.RequestDigest {
		return manifest, ErrConflict
	}
	raw, err = json.Marshal(operation.Action.Prepare.Manifest)
	if err != nil || wire.ValidateExecutionCommand("executionManifest", raw) != nil || json.Unmarshal(raw, &manifest) != nil {
		return manifest, ErrInvalid
	}
	key, err = executionValueDigest(manifest, "manifestDigest")
	if err != nil || key != manifest.ManifestDigest {
		return manifest, ErrConflict
	}
	inputs, err := executionValueDigest(manifest.Inputs, "")
	scope := manifest.Scope
	if err != nil || inputs != manifest.InputDigest || *operation.Execution != execution.RepositoryOperationRequestExecution(scope) ||
		operation.Grant != execution.RepositoryOperationRequestGrant(manifest.Grant) ||
		operation.RepositoryID != manifest.Repository.RepositoryID || operation.BindingID != manifest.Repository.BindingID ||
		operation.DeviceID != scope.DeviceID || operation.Plan.PlanID != scope.PlanID || operation.Plan.Revision != scope.PlanRevision ||
		operation.Plan.Digest != scope.PlanDigest || operation.Plan.ApprovalOperationID != scope.ApprovalOperationID || operation.Plan.RoomID != scope.RoomID ||
		manifest.Repository.GrantID != manifest.Grant.GrantID || manifest.Repository.GrantRevision != manifest.Grant.Revision ||
		operation.ExpectedGeneration != manifest.Workspace.WorkspaceGeneration || manifest.Workspace.Mode != execution.IsolatedWorktree {
		return manifest, ErrConflict
	}
	deadline, err := time.Parse(time.RFC3339Nano, operation.Deadline)
	issued, issuedErr := time.Parse(time.RFC3339Nano, manifest.Workspace.IssuedAt)
	if err != nil || issuedErr != nil || !deadline.After(issued) {
		return manifest, ErrInvalid
	}
	for _, ceiling := range []string{manifest.Deadline, manifest.Grant.ExpiresAt, manifest.Workspace.ExpiresAt} {
		limit, err := time.Parse(time.RFC3339Nano, ceiling)
		if err != nil || deadline.After(limit) {
			return manifest, ErrConflict
		}
	}
	return manifest, nil
}

// A renewed binding has a different destination Run and validity interval. Its
// exact upstream receipt, Artifact, repository, slot and order must not change.
func resumeInputSources(manifest execution.GovernedExecutionManifest) ([]execution.GovernedExecutionManifestInput, error) {
	result := append([]execution.GovernedExecutionManifestInput{}, manifest.Inputs...)
	bindings, slots := map[string]bool{}, map[string]bool{}
	for index, input := range result {
		issued, err := time.Parse(time.RFC3339Nano, input.IssuedAt)
		expires, expiresErr := time.Parse(time.RFC3339Nano, input.ExpiresAt)
		deadline, _ := time.Parse(time.RFC3339Nano, manifest.Deadline)
		if input.PlanID != manifest.Scope.PlanID || input.PlanRevision != manifest.Scope.PlanRevision ||
			input.DestinationTaskID != manifest.Scope.TaskID || input.DestinationRunID != manifest.Scope.RunID ||
			input.DestinationAgentID != manifest.Scope.AgentID || input.DestinationDeviceID != manifest.Scope.DeviceID ||
			bindings[input.BindingID] || slots[input.InputSlot] || err != nil || expiresErr != nil || !expires.After(issued) || expires.After(deadline) {
			return nil, ErrConflict
		}
		bindings[input.BindingID], slots[input.InputSlot] = true, true
		input.BindingID, input.DestinationRunID, input.IssuedAt, input.ExpiresAt = "", "", "", ""
		result[index] = input
	}
	return result, nil
}

func compatibleResume(previous, next execution.GovernedExecutionManifest) bool {
	old, current := previous.Scope, next.Scope
	if old.RunID == current.RunID || current.DispatchGeneration <= old.DispatchGeneration ||
		current.TaskRevision < old.TaskRevision || current.PlanControlRevision < old.PlanControlRevision ||
		previous.Workspace.WorkspaceRef == next.Workspace.WorkspaceRef || previous.Workspace.LeaseID == next.Workspace.LeaseID ||
		previous.Workspace.WorkspaceGeneration == next.Workspace.WorkspaceGeneration {
		return false
	}
	old.RunID, old.DispatchGeneration, old.TaskRevision, old.PlanControlRevision = current.RunID, current.DispatchGeneration, current.TaskRevision, current.PlanControlRevision
	// A renewed local grant is checked by admission. It cannot change the code,
	// runtime profile, scope or verification/output contract under this resume.
	repository := previous.Repository
	repository.GrantID, repository.GrantRevision = next.Repository.GrantID, next.Repository.GrantRevision
	if old != current || repository != next.Repository || digest(previous.ScopePolicy) != digest(next.ScopePolicy) ||
		digest(previous.VerificationProfiles) != digest(next.VerificationProfiles) || digest(previous.Outputs) != digest(next.Outputs) {
		return false
	}
	before, err := resumeInputSources(previous)
	after, nextErr := resumeInputSources(next)
	if err != nil || nextErr != nil || digest(before) != digest(after) {
		return false
	}
	oldBindings := map[string]bool{}
	for _, input := range previous.Inputs {
		oldBindings[input.BindingID] = true
	}
	for _, input := range next.Inputs {
		if oldBindings[input.BindingID] {
			// Input bindings are immutable Run-scoped grants, not reusable names.
			return false
		}
	}
	return true
}

// PrepareFromCheckpoint creates a NEW local attempt from an explicitly selected
// canonical checkpoint previously confirmed on this Bridge. It neither starts
// a Runtime nor establishes that an old Runtime stopped. The caller must hold
// the existing stopped-Run/explicit-retry fence and current local authorization
// throughout the call. BRG-071/RUN-018 must supply that production admission.
// No old working directory is read, reset, cleaned or attached to the new Run.
func (p *Preparer) PrepareFromCheckpoint(ctx context.Context, source Source, operation execution.RepositoryOperationRequest,
	checkpoint execution.RepositoryCheckpoint, inputs []PatchInput) (PreparedWorkspace, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.checkOwner(); err != nil {
		return PreparedWorkspace{}, err
	}
	if err := ctx.Err(); err != nil {
		return PreparedWorkspace{}, err
	}
	frozenInputs, err := freezeInputs(inputs, p.git.limits.SnapshotBytes)
	if err != nil {
		return PreparedWorkspace{}, err
	}
	inputs = frozenInputs
	// Freeze nested caller-owned wire values before reading receipts or Git IO.
	raw, err := json.Marshal(struct {
		Operation  execution.RepositoryOperationRequest `json:"operation"`
		Checkpoint execution.RepositoryCheckpoint       `json:"checkpoint"`
	}{operation, checkpoint})
	if err != nil || len(raw) > 1<<20 {
		return PreparedWorkspace{}, ErrLimit
	}
	var frozen struct {
		Operation  execution.RepositoryOperationRequest `json:"operation"`
		Checkpoint execution.RepositoryCheckpoint       `json:"checkpoint"`
	}
	if err := json.Unmarshal(raw, &frozen); err != nil {
		return PreparedWorkspace{}, ErrInvalid
	}
	operation, checkpoint = frozen.Operation, frozen.Checkpoint
	manifest, err := resumeManifest(operation)
	if err != nil {
		return PreparedWorkspace{}, err
	}
	if !validCheckpoint(checkpoint) || *operation.Action.Prepare.ResumeCheckpointID != checkpoint.CheckpointID {
		return PreparedWorkspace{}, ErrConflict
	}
	var confirmed, proposed execution.RepositoryCheckpoint
	for _, receipt := range []struct {
		kind  string
		value *execution.RepositoryCheckpoint
	}{{"checkpoint", &confirmed}, {"checkpoint-proposal", &proposed}} {
		if err := readJSON(p.claimPath(receipt.kind, checkpoint.OperationID), receipt.value); err != nil {
			return PreparedWorkspace{}, err
		}
		if digest(*receipt.value) != digest(checkpoint) {
			return PreparedWorkspace{}, ErrConflict
		}
	}
	var publication CapturePublication
	if err := readJSONSized(p.claimPath("capture-publication", checkpoint.OperationID), &publication, 2<<20); err != nil {
		return PreparedWorkspace{}, err
	}
	if err := artifact.ValidateCaptureContext(publication.Manifest, publication.Operation); err != nil {
		return PreparedWorkspace{}, err
	}
	if !compatibleResume(publication.Manifest, manifest) || operation.Plan != publication.Operation.Plan {
		return PreparedWorkspace{}, ErrConflict
	}
	captured, err := p.publicationCapture(publication)
	if err != nil || !checkpointMatchesCapture(checkpoint, publication, captured) {
		return PreparedWorkspace{}, ErrChanged
	}
	var prepared preparationIntent
	if err := readJSON(p.claimPath("workspace", captured.WorkspaceRef), &prepared); err != nil || prepared.Source != source {
		return PreparedWorkspace{}, ErrChanged
	}
	issued, _ := time.Parse(time.RFC3339Nano, manifest.Workspace.IssuedAt)
	if issued.Before(captured.CapturedAt) {
		return PreparedWorkspace{}, ErrConflict
	}
	patch, err := p.readCapturedPatchLocked(ctx, checkpoint.OperationID, captured.Digest)
	if err != nil {
		return PreparedWorkspace{}, err
	}
	if len(patch) == 0 {
		return PreparedWorkspace{}, ErrInvalid
	}
	provided := []inputPin{}
	for _, input := range inputs {
		provided = append(provided, inputPin{input.BindingID, input.SHA256, len(input.Bytes)})
	}
	expected := []inputPin{}
	for _, input := range manifest.Inputs {
		if input.Artifact.Kind == execution.Patch {
			expected = append(expected, inputPin{input.BindingID, input.Artifact.ContentDigest, int(input.Artifact.ByteLength)})
		}
	}
	if digest(provided) != digest(expected) {
		return PreparedWorkspace{}, ErrConflict
	}
	resume := &checkpointResume{pin: checkpointResumePin{RequestDigest: operation.RequestDigest,
		CheckpointID: checkpoint.CheckpointID, CheckpointDigest: checkpoint.Digest, CaptureOperationID: checkpoint.OperationID,
		CaptureDigest: captured.Digest, SourceRunID: captured.RunID, SourceWorkspaceRef: captured.WorkspaceRef,
		CandidateTree: captured.CandidateTree, PatchDigest: captured.PatchDigest, PatchBytes: captured.PatchBytes}, patch: patch}
	return p.prepareLocked(ctx, source, Preparation{OperationID: operation.OperationID, RunID: manifest.Scope.RunID,
		RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID, BaseCommit: manifest.Repository.BaseCommit,
		WorkspaceRef: manifest.Workspace.WorkspaceRef, Generation: manifest.Workspace.WorkspaceGeneration,
		ManifestDigest: manifest.ManifestDigest, Inputs: inputs, ScopePolicy: execution.ManifestScopePolicy(manifest.ScopePolicy)}, resume)
}
