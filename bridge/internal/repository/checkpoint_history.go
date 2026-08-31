package repository

import (
	"context"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
)

// Local confirmation is historical evidence, never renewed execution or
// deletion authority. Callers must separately enforce their current fence.
func (p *Preparer) confirmedCapture(ctx context.Context, checkpoint execution.RepositoryCheckpoint) (CapturePublication, CapturedRepository, []byte, error) {
	var publication CapturePublication
	var captured CapturedRepository
	if !validCheckpoint(checkpoint) {
		return publication, captured, nil, ErrConflict
	}
	for _, kind := range []string{"checkpoint", "checkpoint-proposal"} {
		var receipt execution.RepositoryCheckpoint
		if err := readJSON(p.claimPath(kind, checkpoint.OperationID), &receipt); err != nil {
			return publication, captured, nil, err
		}
		if digest(receipt) != digest(checkpoint) {
			return publication, captured, nil, ErrConflict
		}
	}
	if err := readJSONSized(p.claimPath("capture-publication", checkpoint.OperationID), &publication, 2<<20); err != nil {
		return publication, captured, nil, err
	}
	if err := artifact.ValidateCaptureContext(publication.Manifest, publication.Operation); err != nil {
		return publication, captured, nil, err
	}
	var err error
	captured, err = p.publicationCapture(publication)
	if err != nil {
		return publication, captured, nil, err
	}
	if err := validateCaptureOutputs(publication); err != nil {
		return publication, captured, nil, err
	}
	patch, err := p.readCapturedPatchLocked(ctx, checkpoint.OperationID, captured.Digest)
	if err != nil {
		return publication, captured, nil, err
	}
	outputs, err := p.captureOutputSources(ctx, publication, captured, patch)
	if err != nil || !checkpointMatchesCapture(checkpoint, publication, captured, outputs) {
		return publication, captured, nil, ErrChanged
	}
	return publication, captured, patch, nil
}
