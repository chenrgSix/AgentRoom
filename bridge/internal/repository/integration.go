package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

var (
	ErrIntegrationTargetMoved      = errors.New("integration target no longer equals the approved commit")
	ErrIntegrationTargetCheckedOut = errors.New("integration target is checked out in a worktree")
	ErrIntegrationNonFastForward   = errors.New("integration candidate is not a strict fast-forward")
	ErrIntegrationOutcomeUnknown   = errors.New("integration target outcome is unknown")
)

// IntegrateExactTarget imports the exact sealed candidate and asks Git to move
// one owner-approved local branch with an atomic expected-old update. It never
// merges, resets a checkout, runs hooks, changes HEAD or touches a remote.
func (p *Preparer) IntegrateExactTarget(ctx context.Context, source Source,
	operation execution.RepositoryOperationRequest, checkpoint execution.RepositoryCheckpoint) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ctx == nil {
		return "", ErrInvalid
	}
	if err := p.checkOwner(); err != nil {
		return "", err
	}
	action, err := validateIntegrationEvidence(operation, checkpoint)
	if err != nil {
		return "", err
	}
	if !validGrantTarget(action.Target.TargetRef) || !validObject(action.Target.ExpectedCommit, source.ObjectFormat) ||
		!validObject(action.CandidateCommit, source.ObjectFormat) || !validObject(action.CandidateTree, source.ObjectFormat) {
		return "", ErrInvalid
	}
	if err := p.git.checkSource(ctx, source); err != nil {
		return "", integrationContextError(ctx, err)
	}
	_, captured, _, err := p.confirmedCapture(ctx, checkpoint)
	if err != nil {
		return "", integrationContextError(ctx, err)
	}
	if captured.CandidateCommit != action.CandidateCommit || captured.CandidateTree != action.CandidateTree {
		return "", ErrChanged
	}
	current, err := p.integrationTarget(ctx, source, action.Target.TargetRef)
	if err != nil || current != action.Target.ExpectedCommit {
		return "", ErrIntegrationTargetMoved
	}
	checkedOut, err := p.integrationTargetCheckedOut(ctx, source, action.Target.TargetRef)
	if err != nil {
		return "", integrationContextError(ctx, err)
	}
	if checkedOut {
		return "", ErrIntegrationTargetCheckedOut
	}
	sealed, err := p.verifiedCapturedSource(ctx, captured)
	if err != nil {
		return "", integrationContextError(ctx, err)
	}
	bundle, err := p.readCommitBundleLocked(ctx, captured, sealed)
	if err != nil {
		return "", integrationContextError(ctx, err)
	}
	headerEnd := bytes.Index(bundle, []byte("\n\n"))
	if headerEnd < 0 || headerEnd > 64<<10 || len(bundle)-headerEnd-2 > artifact.MaximumSourceBytes {
		return "", ErrChanged
	}
	if _, err := p.git.run(ctx, source.Root, bytes.NewReader(bundle[headerEnd+2:]), 16<<10,
		"index-pack", "--stdin", "--fix-thin"); err != nil {
		return "", integrationContextError(ctx, err)
	}
	if err := p.git.checkSource(ctx, source); err != nil {
		return "", integrationContextError(ctx, err)
	}
	tree, err := p.git.text(ctx, source.Root, "rev-parse", action.CandidateCommit+"^{tree}")
	if err != nil {
		return "", integrationContextError(ctx, err)
	}
	if tree != action.CandidateTree {
		return "", ErrChanged
	}
	if action.CandidateCommit == action.Target.ExpectedCommit {
		return "", ErrIntegrationNonFastForward
	}
	if _, err := p.git.run(ctx, source.Root, nil, 16<<10, "merge-base", "--is-ancestor",
		action.Target.ExpectedCommit, action.CandidateCommit); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", ErrIntegrationNonFastForward
	}
	checkedOut, err = p.integrationTargetCheckedOut(ctx, source, action.Target.TargetRef)
	if err != nil {
		return "", integrationContextError(ctx, err)
	}
	if checkedOut {
		return "", ErrIntegrationTargetCheckedOut
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	_, updateErr := p.git.run(ctx, source.Root, nil, 16<<10, "update-ref",
		action.Target.TargetRef, action.CandidateCommit, action.Target.ExpectedCommit)
	if updateErr == nil {
		confirmation, cancel := context.WithTimeout(context.Background(), p.git.limits.CommandTimeout)
		defer cancel()
		return p.confirmIntegrationTarget(confirmation, source, action)
	}
	// Git may have completed the atomic write while cancellation raced process
	// collection. Inspect only this exact ref under a fresh bounded context.
	recovery, cancel := context.WithTimeout(context.Background(), p.git.limits.CommandTimeout)
	defer cancel()
	current, inspectErr := p.integrationTarget(recovery, source, action.Target.TargetRef)
	if inspectErr == nil && current == action.CandidateCommit {
		return action.CandidateCommit, nil
	}
	if inspectErr == nil && current == action.Target.ExpectedCommit {
		return "", updateErr
	}
	if inspectErr == nil {
		return "", ErrIntegrationTargetMoved
	}
	return "", ErrIntegrationOutcomeUnknown
}

func validateIntegrationEvidence(operation execution.RepositoryOperationRequest,
	checkpoint execution.RepositoryCheckpoint) (*execution.IntegrateClass, error) {
	raw, err := json.Marshal(operation)
	if err != nil || wire.ValidateExecutionCommand("repositoryOperation", raw) != nil {
		return nil, ErrInvalid
	}
	requestDigest, err := executionValueDigest(operation, "requestDigest")
	if err != nil || requestDigest != operation.RequestDigest || operation.Execution == nil ||
		operation.Action.Kind != execution.Integrate || operation.Action.Integrate == nil || !validCheckpoint(checkpoint) {
		return nil, ErrInvalid
	}
	action, scope := operation.Action.Integrate, operation.Execution
	if operation.RepositoryID != checkpoint.RepositoryID || operation.BindingID != checkpoint.BindingID ||
		operation.DeviceID != scope.DeviceID || operation.ExpectedGeneration != checkpoint.WorkspaceGeneration ||
		action.Target.RepositoryID != operation.RepositoryID || action.CandidateCommit != checkpoint.CandidateCommit ||
		action.CandidateTree != checkpoint.CandidateTree || action.InputDigest != checkpoint.InputDigest ||
		checkpoint.Scope != execution.RepositoryCheckpointScope(*scope) || operation.Plan.PlanID != scope.PlanID ||
		operation.Plan.Revision != scope.PlanRevision || operation.Plan.Digest != scope.PlanDigest || operation.Plan.RoomID != scope.RoomID {
		return nil, ErrChanged
	}
	return action, nil
}

func (p *Preparer) integrationTarget(ctx context.Context, source Source, targetRef string) (string, error) {
	if err := p.git.checkSource(ctx, source); err != nil {
		return "", integrationContextError(ctx, err)
	}
	return p.git.text(ctx, source.Root, "show-ref", "--verify", "--hash", targetRef)
}

func integrationContextError(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func (p *Preparer) confirmIntegrationTarget(ctx context.Context, source Source, action *execution.IntegrateClass) (string, error) {
	current, err := p.integrationTarget(ctx, source, action.Target.TargetRef)
	if err != nil {
		return "", ErrIntegrationOutcomeUnknown
	}
	if current != action.CandidateCommit {
		return "", ErrIntegrationOutcomeUnknown
	}
	return current, nil
}

func (p *Preparer) integrationTargetCheckedOut(ctx context.Context, source Source, targetRef string) (bool, error) {
	raw, err := p.git.run(ctx, source.Root, nil, 256<<10, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return false, err
	}
	record := map[string]string{}
	paths := map[string]bool{}
	for _, field := range strings.Split(string(raw), "\x00") {
		if field == "" {
			if len(record) == 0 {
				continue
			}
			path := filepath.Clean(filepath.FromSlash(record["worktree"]))
			if !filepath.IsAbs(path) || paths[path] || len(paths) >= 256 {
				return false, ErrChanged
			}
			paths[path] = true
			if record["branch"] == targetRef {
				return true, nil
			}
			record = map[string]string{}
			continue
		}
		key, value, _ := strings.Cut(field, " ")
		if _, exists := record[key]; exists {
			return false, ErrChanged
		}
		switch key {
		case "worktree", "HEAD", "branch", "bare", "detached", "locked", "prunable":
		default:
			return false, ErrChanged
		}
		record[key] = value
	}
	if len(record) != 0 {
		return false, ErrChanged
	}
	return false, nil
}
