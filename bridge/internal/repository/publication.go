package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

// CaptureOutputDescription selects one approved output. Path selects a captured
// report locally; patch/commit outputs have no path. It never identifies a live file.
type CaptureOutputDescription struct {
	SlotKey string `json:"slotKey"`
	Title   string `json:"title"`
	Summary string `json:"summary"`
	Path    string `json:"path,omitempty"`
}

// CapturePublication is a local durable intent. Shared wire shapes are reused;
// report selectors resolve only inside the sealed candidate and frozen scope,
// never to an arbitrary live file, absolute source path or replacement policy.
type CapturePublication struct {
	CaptureDigest string                               `json:"captureDigest"`
	Manifest      execution.GovernedExecutionManifest  `json:"manifest"`
	Operation     execution.RepositoryOperationRequest `json:"operation"`
	Outputs       []CaptureOutputDescription           `json:"outputs"`
}

type CaptureTransport interface {
	CaptureCheckpoint(context.Context, string) (*execution.RepositoryCheckpoint, error)
	PublishCapture(context.Context, artifact.CapturePublishInput) (artifact.PublishResult, error)
	SealCaptureCheckpoint(context.Context, execution.RepositoryCheckpoint) (execution.RepositoryCheckpoint, error)
}

func checkpointDigest(checkpoint execution.RepositoryCheckpoint) (string, error) {
	raw, err := json.Marshal(checkpoint)
	if err != nil {
		return "", err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return "", err
	}
	delete(fields, "digest")
	unsigned, err := json.Marshal(fields)
	if err != nil {
		return "", err
	}
	return wire.ExecutionDigest(unsigned)
}

func validCheckpoint(checkpoint execution.RepositoryCheckpoint) bool {
	raw, err := json.Marshal(checkpoint)
	if err != nil || wire.ValidateExecutionCommand("executionCheckpoint", raw) != nil {
		return false
	}
	expected, err := checkpointDigest(checkpoint)
	return err == nil && expected == checkpoint.Digest
}

func (p *Preparer) publicationCapture(input CapturePublication) (CapturedRepository, error) {
	var captured CapturedRepository
	if err := readJSONSized(p.claimPath("capture", input.Operation.OperationID), &captured, 32<<20); err != nil {
		return captured, err
	}
	claimed := captured.Digest
	captured.Digest = ""
	if digest(captured) != claimed {
		return captured, ErrChanged
	}
	captured.Digest = claimed
	manifest := input.Manifest
	if captured.Digest != input.CaptureDigest || captured.ManifestDigest != manifest.ManifestDigest ||
		captured.RunID != manifest.Scope.RunID || captured.WorkspaceRef != manifest.Workspace.WorkspaceRef ||
		captured.WorkspaceGeneration != input.Operation.ExpectedGeneration ||
		captured.RepositoryID != manifest.Repository.RepositoryID || captured.BindingID != manifest.Repository.BindingID ||
		captured.BaseCommit != manifest.Repository.BaseCommit {
		return captured, ErrConflict
	}
	prepared, _, _, err := p.capturePreparation(CaptureRequest{OperationID: captured.OperationID,
		WorkspaceRef: captured.WorkspaceRef, PreparedDigest: captured.PreparedDigest,
		ExpectedGeneration: captured.WorkspaceGeneration, ManifestDigest: captured.ManifestDigest})
	if err != nil {
		return captured, err
	}
	if digest(prepared.ScopePolicy) != digest(manifest.ScopePolicy) {
		return captured, ErrConflict
	}
	patchInputs := []inputPin{}
	for _, input := range manifest.Inputs {
		if input.Artifact.Kind == execution.Patch {
			patchInputs = append(patchInputs, inputPin{BindingID: input.BindingID, SHA256: input.Artifact.ContentDigest,
				Bytes: int(input.Artifact.ByteLength)})
		}
	}
	if digest(patchInputs) != digest(prepared.Inputs) {
		return captured, ErrConflict
	}
	issued, err := time.Parse(time.RFC3339Nano, manifest.Workspace.IssuedAt)
	if err != nil {
		return captured, ErrInvalid
	}
	deadline, err := time.Parse(time.RFC3339Nano, input.Operation.Deadline)
	if err != nil || captured.CapturedAt.Before(issued) || captured.CapturedAt.After(deadline) {
		return captured, ErrConflict
	}
	return captured, nil
}

func validateCaptureOutputs(input CapturePublication) error {
	if len(input.Outputs) == 0 || len(input.Outputs) > 32 {
		return ErrInvalid
	}
	approved := map[string]execution.GovernedExecutionManifestOutput{}
	for _, slot := range input.Manifest.Outputs {
		if _, exists := approved[slot.SlotKey]; exists {
			return ErrInvalid
		}
		approved[slot.SlotKey] = slot
	}
	selected := map[string]bool{}
	for _, output := range input.Outputs {
		slot, exists := approved[output.SlotKey]
		if !exists || selected[output.SlotKey] ||
			strings.TrimSpace(output.Title) == "" || len(output.Title) > 160 ||
			strings.TrimSpace(output.Summary) == "" || len(output.Summary) > 4000 {
			return ErrInvalid
		}
		if slot.Kind == execution.Patch || slot.Kind == execution.Commit {
			if output.Path != "" {
				return ErrInvalid
			}
		} else if _, _, err := reportMedia(slot.Kind, output.Path); err != nil {
			return err
		}
		selected[output.SlotKey] = true
	}
	for _, slot := range approved {
		if slot.Required && !selected[slot.SlotKey] {
			return ErrInvalid
		}
	}
	return nil
}

// ValidateCapturePublicationIntent validates only frozen wire metadata and
// output selection. It performs no filesystem access, local authorization or
// network IO and therefore grants no capture authority.
func ValidateCapturePublicationIntent(manifest execution.GovernedExecutionManifest,
	operation execution.RepositoryOperationRequest, outputs []CaptureOutputDescription) error {
	if err := artifact.ValidateCaptureContext(manifest, operation); err != nil {
		return err
	}
	frozen := CapturePublication{Manifest: manifest, Operation: operation, Outputs: outputs}
	return validateCaptureOutputs(frozen)
}

// PublishCaptured requires the caller's current local authorization, exact
// still-starting admission and finished-process proof. It only reads sealed
// capture bytes, retains an immutable publication intent before network IO, and
// never marks the Run/Task complete.
// Exact retry queries the checkpoint before uploading or repeating a seal.
func (p *Preparer) PublishCaptured(ctx context.Context, input CapturePublication, transport CaptureTransport) (execution.RepositoryCheckpoint, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.checkOwner(); err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	if err := ctx.Err(); err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	if transport == nil {
		return execution.RepositoryCheckpoint{}, ErrInvalid
	}
	raw, err := json.Marshal(input)
	if err != nil || len(raw) > 2<<20 {
		return execution.RepositoryCheckpoint{}, ErrLimit
	}
	// Detach all nested caller-owned slices before retention and network IO.
	var frozen CapturePublication
	if err := json.Unmarshal(raw, &frozen); err != nil {
		return execution.RepositoryCheckpoint{}, ErrInvalid
	}
	input = frozen
	if err := artifact.ValidateCaptureContext(input.Manifest, input.Operation); err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	if err := validateCaptureOutputs(input); err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	patch, err := p.readCapturedPatchLocked(ctx, input.Operation.OperationID, input.CaptureDigest)
	if err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	captured, err := p.publicationCapture(input)
	if err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	outputs, err := p.captureOutputSources(ctx, input, captured, patch)
	if err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	operationID := input.Operation.OperationID
	if err := ensureExactJSON(p.claimPath("capture-publication", operationID), input); err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	proposalPath := p.claimPath("checkpoint-proposal", operationID)
	var proposal execution.RepositoryCheckpoint
	proposalErr := readJSON(proposalPath, &proposal)
	if proposalErr != nil && !errors.Is(proposalErr, os.ErrNotExist) {
		return proposal, proposalErr
	}
	if proposalErr == nil && (!validCheckpoint(proposal) || !checkpointMatchesCapture(proposal, input, captured, outputs)) {
		return execution.RepositoryCheckpoint{}, ErrChanged
	}
	receiptPath := p.claimPath("checkpoint", operationID)
	var receipt execution.RepositoryCheckpoint
	if err := readJSON(receiptPath, &receipt); err == nil {
		if proposalErr != nil || !validCheckpoint(receipt) || digest(receipt) != digest(proposal) {
			return receipt, ErrChanged
		}
		return receipt, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return receipt, err
	}
	observed, err := transport.CaptureCheckpoint(ctx, operationID)
	if err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	if observed != nil {
		if proposalErr != nil || !validCheckpoint(*observed) || digest(*observed) != digest(proposal) {
			return receipt, ErrConflict
		}
		if err := ensureExactJSON(receiptPath, observed); err != nil {
			return receipt, err
		}
		return *observed, nil
	}
	if errors.Is(proposalErr, os.ErrNotExist) {
		proposal = execution.RepositoryCheckpoint{CheckpointID: "checkpoint_" + digest([]string{operationID, input.CaptureDigest}),
			OperationID: operationID, Scope: execution.RepositoryCheckpointScope(input.Manifest.Scope),
			RepositoryID: captured.RepositoryID, BindingID: captured.BindingID, BaseCommit: captured.BaseCommit,
			CandidateCommit: captured.CandidateCommit, CandidateTree: captured.CandidateTree,
			InputDigest: input.Manifest.InputDigest, WorkspaceRef: captured.WorkspaceRef,
			WorkspaceGeneration: captured.WorkspaceGeneration, Outputs: []execution.RepositoryCheckpointOutput{},
			CapturedAt: captured.CapturedAt.UTC().Format(time.RFC3339Nano)}
		seenArtifacts := map[string]bool{}
		for index, output := range input.Outputs {
			selected := outputs[index]
			if err := p.checkOwner(); err != nil {
				return receipt, err
			}
			result, err := transport.PublishCapture(ctx, artifact.CapturePublishInput{
				Manifest: input.Manifest, Operation: input.Operation, SlotKey: output.SlotKey, Title: output.Title, Summary: output.Summary,
				Source: selected.source})
			if err != nil {
				return receipt, err
			}
			if result.SHA256 != selected.source.SHA256 || result.Revision < 1 || result.ContentID == "" || seenArtifacts[result.ArtifactID] {
				return receipt, ErrChanged
			}
			seenArtifacts[result.ArtifactID] = true
			proposal.Outputs = append(proposal.Outputs, execution.RepositoryCheckpointOutput{SlotKey: output.SlotKey,
				Artifact: execution.OutputArtifact{ArtifactID: result.ArtifactID, ArtifactRevision: result.Revision, Kind: selected.kind,
					ContentDigest: selected.source.SHA256, ByteLength: int64(len(selected.source.Bytes))}})
		}
		proposal.Digest, err = checkpointDigest(proposal)
		if err != nil || !validCheckpoint(proposal) {
			return receipt, ErrChanged
		}
		if err := ensureExactJSON(proposalPath, proposal); err != nil {
			return receipt, err
		}
	}
	if err := p.checkOwner(); err != nil {
		return receipt, err
	}
	receipt, err = transport.SealCaptureCheckpoint(ctx, proposal)
	if err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	if !validCheckpoint(receipt) || digest(receipt) != digest(proposal) {
		return execution.RepositoryCheckpoint{}, ErrConflict
	}
	if err := ensureExactJSON(receiptPath, receipt); err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	return receipt, nil
}

func checkpointMatchesCapture(checkpoint execution.RepositoryCheckpoint, input CapturePublication, captured CapturedRepository, outputs []capturedOutput) bool {
	if checkpoint.CheckpointID != "checkpoint_"+digest([]string{captured.OperationID, input.CaptureDigest}) ||
		checkpoint.OperationID != captured.OperationID || checkpoint.Scope != execution.RepositoryCheckpointScope(input.Manifest.Scope) ||
		checkpoint.RepositoryID != captured.RepositoryID || checkpoint.BindingID != captured.BindingID ||
		checkpoint.BaseCommit != captured.BaseCommit || checkpoint.CandidateCommit != captured.CandidateCommit || checkpoint.CandidateTree != captured.CandidateTree ||
		checkpoint.InputDigest != input.Manifest.InputDigest || checkpoint.WorkspaceRef != captured.WorkspaceRef ||
		checkpoint.WorkspaceGeneration != captured.WorkspaceGeneration || checkpoint.CapturedAt != captured.CapturedAt.UTC().Format(time.RFC3339Nano) ||
		len(checkpoint.Outputs) != len(input.Outputs) || len(outputs) != len(input.Outputs) {
		return false
	}
	for index, output := range checkpoint.Outputs {
		selected := outputs[index]
		if output.SlotKey != selected.slotKey || output.Artifact.Kind != selected.kind ||
			output.Artifact.ContentDigest != selected.source.SHA256 || output.Artifact.ByteLength != int64(len(selected.source.Bytes)) {
			return false
		}
	}
	return true
}
