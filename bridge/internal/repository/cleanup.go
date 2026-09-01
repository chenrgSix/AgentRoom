package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"convenewire.dev/bridge/internal/durablefs"
	execution "convenewire.dev/contracts/generated/go/execution"
)

var ErrCleanupUnknown = errors.New("repository cleanup is incomplete or changed; retain it for inspection")
var ErrWorkspaceRetired = errors.New("repository workspace has entered explicit cleanup and cannot be prepared again")

// CleanupScope is local adapter input, not a wire permission. The admission
// owner must authorize this exact scope and hold its existing stopped-Run fence
// throughout the callback. A checkpoint, lease closure or clean directory alone
// must never satisfy that fence.
type CleanupScope struct {
	OperationID, CheckpointID, CheckpointDigest       string
	RepositoryID, BindingID, RunID, AgentID, DeviceID string
	WorkspaceRef, Generation, ManifestDigest          string
	PlanID, NodeKey, TaskID                           string
	PlanRevision                                      int64
}

type CleanupAuthority interface {
	// Implementations must synchronously invoke the action exactly once while
	// holding current local authorization and the existing stopped-Run fence.
	WithCleanupAuthority(context.Context, CleanupScope, func() error) error
}

// CleanupPreview is LOCAL ONLY: paths describe exact recorded targets, never
// targets accepted back from a request. Its digest is content, not permission.
type CleanupPreview struct {
	Version          int      `json:"version"`
	OperationID      string   `json:"operationId"`
	CheckpointID     string   `json:"checkpointId"`
	CheckpointDigest string   `json:"checkpointDigest"`
	CaptureDigest    string   `json:"captureDigest"`
	PreparedDigest   string   `json:"preparedDigest"`
	RunID            string   `json:"runId"`
	WorkspaceRef     string   `json:"workspaceRef"`
	Generation       string   `json:"generation"`
	ManifestDigest   string   `json:"manifestDigest"`
	Path             string   `json:"path"`
	GitDirectory     string   `json:"gitDirectory"`
	Branch           string   `json:"branch"`
	ExpectedHead     string   `json:"expectedHead"`
	AttemptIdentity  string   `json:"attemptIdentity"`
	GitIdentity      string   `json:"gitIdentity"`
	WorkIdentity     string   `json:"workIdentity"`
	SnapshotDigest   string   `json:"snapshotDigest"`
	IndexDigest      string   `json:"indexDigest"`
	RetainedPaths    []string `json:"retainedPaths"`
	Digest           string   `json:"digest"`
}

type CleanupRequest struct {
	OperationID           string                         `json:"operationId"`
	Checkpoint            execution.RepositoryCheckpoint `json:"checkpoint"`
	ExpectedPreviewDigest string                         `json:"expectedPreviewDigest"`
}

type cleanupIntent struct {
	Kind          string         `json:"kind"`
	Version       int            `json:"version"`
	RequestDigest string         `json:"requestDigest"`
	Preview       CleanupPreview `json:"preview"`
}

type cleanupStep struct {
	OperationID   string `json:"operationId"`
	PreviewDigest string `json:"previewDigest"`
	Step          string `json:"step"`
}

// CleanupReceipt is an immutable local tombstone, not a Task/Run outcome or a
// claim that all caches/checkpoint storage were purged. Exact replay is read-only.
type CleanupReceipt struct {
	Version          int       `json:"version"`
	OperationID      string    `json:"operationId"`
	PreviewDigest    string    `json:"previewDigest"`
	CheckpointID     string    `json:"checkpointId"`
	CheckpointDigest string    `json:"checkpointDigest"`
	RunID            string    `json:"runId"`
	WorkspaceRef     string    `json:"workspaceRef"`
	RemovedWorktree  string    `json:"removedWorktree"`
	RemovedBranch    string    `json:"removedBranch"`
	RetainedPaths    []string  `json:"retainedPaths"`
	CompletedAt      time.Time `json:"completedAt"`
	Digest           string    `json:"digest"`
}

type cleanupEvidence struct {
	checkpoint  execution.RepositoryCheckpoint
	publication CapturePublication
	captured    CapturedRepository
	prepared    preparationIntent
	candidate   preparedCandidate
	ready       PreparedWorkspace
	observation captureIntent
}

func (p *Preparer) cleanupEvidence(ctx context.Context, operationID string, checkpoint execution.RepositoryCheckpoint) (cleanupEvidence, error) {
	var evidence cleanupEvidence
	if err := p.checkOwner(); err != nil {
		return evidence, err
	}
	if err := ctx.Err(); err != nil {
		return evidence, err
	}
	if !localID.MatchString(operationID) {
		return evidence, ErrInvalid
	}
	raw, err := json.Marshal(checkpoint)
	if err != nil || len(raw) > 512<<10 {
		return evidence, ErrLimit
	}
	if err := json.Unmarshal(raw, &evidence.checkpoint); err != nil {
		return evidence, ErrInvalid
	}
	evidence.publication, evidence.captured, _, err = p.confirmedCapture(ctx, evidence.checkpoint)
	if err != nil {
		return evidence, err
	}
	captured := evidence.captured
	evidence.prepared, evidence.candidate, evidence.ready, err = p.capturePreparation(CaptureRequest{OperationID: captured.OperationID,
		WorkspaceRef: captured.WorkspaceRef, PreparedDigest: captured.PreparedDigest,
		ExpectedGeneration: captured.WorkspaceGeneration, ManifestDigest: captured.ManifestDigest})
	if err != nil {
		return evidence, err
	}
	if err := readJSONSized(p.claimPath("operation", captured.OperationID), &evidence.observation, 32<<20); err != nil {
		return evidence, err
	}
	observed := evidence.observation
	if observed.Kind != "capture" || observed.Version != 1 || observed.Request.OperationID != captured.OperationID ||
		observed.Request.WorkspaceRef != captured.WorkspaceRef || observed.Request.PreparedDigest != captured.PreparedDigest ||
		observed.ObservedHead != captured.ObservedHead || digest(observed.Snapshot) != captured.SnapshotDigest {
		return evidence, ErrChanged
	}
	return evidence, nil
}

func (e cleanupEvidence) scope(operationID string) CleanupScope {
	m := e.publication.Manifest
	return CleanupScope{OperationID: operationID, CheckpointID: e.checkpoint.CheckpointID, CheckpointDigest: e.checkpoint.Digest,
		RepositoryID: m.Repository.RepositoryID, BindingID: m.Repository.BindingID, RunID: m.Scope.RunID, AgentID: m.Scope.AgentID, DeviceID: m.Scope.DeviceID,
		WorkspaceRef: m.Workspace.WorkspaceRef, Generation: e.captured.WorkspaceGeneration, ManifestDigest: m.ManifestDigest,
		PlanID: m.Scope.PlanID, PlanRevision: m.Scope.PlanRevision, NodeKey: m.Scope.NodeKey, TaskID: m.Scope.TaskID}
}

// InspectCleanupScope resolves an owner-selected checkpoint only through the
// retained local capture history. It returns no path and performs no mutation;
// callers still need a cleanup grant, the stopped-Run fence, process absence and
// an exact reviewed preview before retirement.
func (p *Preparer) InspectCleanupScope(ctx context.Context, operationID string,
	checkpoint execution.RepositoryCheckpoint) (CleanupScope, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	evidence, err := p.cleanupEvidence(ctx, operationID, checkpoint)
	if err != nil {
		return CleanupScope{}, err
	}
	return evidence.scope(operationID), nil
}

func underCleanupAuthority(ctx context.Context, authority CleanupAuthority, scope CleanupScope, action func() error) error {
	if authority == nil {
		return ErrInvalid
	}
	called := false
	open := true
	var callbackMu sync.Mutex
	var actionErr error
	err := authority.WithCleanupAuthority(ctx, scope, func() error {
		callbackMu.Lock()
		defer callbackMu.Unlock()
		if !open || called {
			actionErr = ErrInvalid
			return actionErr
		}
		called = true
		if err := ctx.Err(); err != nil {
			actionErr = err
			return err
		}
		actionErr = action()
		return actionErr
	})
	callbackMu.Lock()
	defer callbackMu.Unlock()
	open = false
	if err != nil {
		return err
	}
	if !called {
		return ErrInvalid
	}
	return actionErr
}

// PreviewCleanup performs no mutation. It refuses uncollected changes, moved
// refs, foreign worktrees and unavailable current/stopped-Run authority.
func (p *Preparer) PreviewCleanup(ctx context.Context, operationID string, checkpoint execution.RepositoryCheckpoint, authority CleanupAuthority) (CleanupPreview, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var preview CleanupPreview
	if authority == nil {
		return preview, ErrInvalid
	}
	evidence, err := p.cleanupEvidence(ctx, operationID, checkpoint)
	if err != nil {
		return preview, err
	}
	err = underCleanupAuthority(ctx, authority, evidence.scope(operationID), func() error {
		for _, path := range []string{p.claimPath("operation", operationID), p.claimPath("cleanup-workspace", evidence.ready.WorkspaceRef)} {
			if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
				return ErrConflict
			}
		}
		var err error
		preview, err = p.inspectCleanup(ctx, operationID, evidence)
		return err
	})
	return preview, err
}

// CleanupWorkspace retires only the exact captured worktree and owned branch.
// The authoritative checkpoint, private Git objects and scratch remain retained.
// There is no arbitrary path argument, recursive root removal or Run transition.
func (p *Preparer) CleanupWorkspace(ctx context.Context, request CleanupRequest, authority CleanupAuthority) (CleanupReceipt, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var receipt CleanupReceipt
	if authority == nil || !sha256ID.MatchString(request.ExpectedPreviewDigest) {
		return receipt, ErrInvalid
	}
	evidence, err := p.cleanupEvidence(ctx, request.OperationID, request.Checkpoint)
	if err != nil {
		return receipt, err
	}
	request.Checkpoint = evidence.checkpoint
	key := digest(request)
	err = underCleanupAuthority(ctx, authority, evidence.scope(request.OperationID), func() error {
		operationPath := p.claimPath("operation", request.OperationID)
		var intent cleanupIntent
		loadErr := readJSON(operationPath, &intent)
		if loadErr == nil {
			if intent.Kind != "cleanup" || intent.Version != 1 || intent.RequestDigest != key ||
				intent.Preview.Digest != request.ExpectedPreviewDigest || !validCleanupPreview(intent.Preview) {
				return ErrConflict
			}
		} else if !errors.Is(loadErr, os.ErrNotExist) {
			return loadErr
		} else {
			if err := p.requireUnretiredWorkspace(evidence.ready.WorkspaceRef); err != nil {
				return err
			}
			preview, err := p.inspectCleanup(ctx, request.OperationID, evidence)
			if err != nil {
				return err
			}
			if preview.Digest != request.ExpectedPreviewDigest {
				return ErrConflict
			}
			intent = cleanupIntent{Kind: "cleanup", Version: 1, RequestDigest: key, Preview: preview}
			if err := ensureExactJSON(operationPath, intent); err != nil {
				return err
			}
		}
		if err := ensureExactJSON(p.claimPath("cleanup-workspace", evidence.ready.WorkspaceRef), cleanupStep{request.OperationID, intent.Preview.Digest, "claimed"}); err != nil {
			return err
		}
		detached, deleted, err := p.cleanupSteps(intent.Preview)
		if err != nil {
			return err
		}
		if err := readJSON(p.claimPath("cleanup", request.OperationID), &receipt); err == nil {
			if !detached || !deleted || !cleanupReceiptMatches(receipt, intent.Preview) {
				return ErrChanged
			}
			return nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		// The immutable intent exists before any Git mutation. A fresh invocation
		// inspects actual topology; it never assumes that a lost response failed.
		preview := intent.Preview
		if !p.cleanupPreviewMatchesEvidence(preview, evidence) {
			return ErrChanged
		}
		if err := p.finishCleanup(ctx, preview, evidence); err != nil {
			return err
		}
		receipt = CleanupReceipt{Version: 1, OperationID: request.OperationID, PreviewDigest: preview.Digest,
			CheckpointID: preview.CheckpointID, CheckpointDigest: preview.CheckpointDigest, RunID: preview.RunID,
			WorkspaceRef: preview.WorkspaceRef, RemovedWorktree: preview.Path, RemovedBranch: preview.Branch,
			RetainedPaths: append([]string{}, preview.RetainedPaths...), CompletedAt: time.Now().UTC()}
		receipt.Digest = digest(receipt)
		return ensureExactJSON(p.claimPath("cleanup", request.OperationID), receipt)
	})
	return receipt, err
}

func validCleanupPreview(preview CleanupPreview) bool {
	key := preview.Digest
	preview.Digest = ""
	return preview.Version == 1 && sha256ID.MatchString(key) && digest(preview) == key
}

func cleanupReceiptMatches(receipt CleanupReceipt, preview CleanupPreview) bool {
	key := receipt.Digest
	receipt.Digest = ""
	return digest(receipt) == key && receipt.Version == 1 && !receipt.CompletedAt.IsZero() &&
		receipt.OperationID == preview.OperationID && receipt.PreviewDigest == preview.Digest && receipt.CheckpointID == preview.CheckpointID &&
		receipt.CheckpointDigest == preview.CheckpointDigest && receipt.RunID == preview.RunID && receipt.WorkspaceRef == preview.WorkspaceRef &&
		receipt.RemovedWorktree == preview.Path && receipt.RemovedBranch == preview.Branch && digest(receipt.RetainedPaths) == digest(preview.RetainedPaths)
}

func (p *Preparer) requireUnretiredWorkspace(workspaceRef string) error {
	if _, err := os.Lstat(p.claimPath("cleanup-workspace", workspaceRef)); err == nil {
		return ErrWorkspaceRetired
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (p *Preparer) cleanupSteps(preview CleanupPreview) (bool, bool, error) {
	states := [2]bool{}
	for index, step := range []struct{ kind, label string }{{"cleanup-detached", "detached"}, {"cleanup-ref", "ref_deleted"}} {
		var recorded cleanupStep
		err := readJSON(p.claimPath(step.kind, preview.OperationID), &recorded)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || recorded != (cleanupStep{preview.OperationID, preview.Digest, step.label}) {
			return false, false, ErrChanged
		}
		states[index] = true
	}
	if states[1] && !states[0] {
		return false, false, ErrChanged
	}
	return states[0], states[1], nil
}

func (p *Preparer) finishCleanup(ctx context.Context, preview CleanupPreview, evidence cleanupEvidence) error {
	if err := p.checkOwner(); err != nil {
		return err
	}
	if err := p.checkCandidate(evidence.prepared, evidence.candidate); err != nil {
		return err
	}
	detached, deleted, err := p.cleanupSteps(preview)
	if err != nil {
		return err
	}
	workExists, refExists, err := p.cleanupTopology(ctx, preview)
	if err != nil {
		return errors.Join(ErrCleanupUnknown, err)
	}
	if (detached && workExists) || (deleted && refExists) {
		return ErrCleanupUnknown
	}
	if workExists {
		// No partially deleted or newly modified tree is retried with --force.
		current, err := p.inspectCleanup(ctx, preview.OperationID, evidence)
		if err != nil || current.Digest != preview.Digest {
			return errors.Join(ErrCleanupUnknown, err)
		}
		_, commandErr := p.git.run(ctx, preview.GitDirectory, nil, 16<<10, "worktree", "remove", "--force", "--", preview.Path)
		workExists, refExists, err = p.cleanupTopology(ctx, preview)
		if err != nil || workExists {
			return errors.Join(ErrCleanupUnknown, commandErr, err)
		}
	}
	if err := syncTree(preview.GitDirectory); err != nil {
		return err
	}
	if err := durablefs.SyncDirectory(filepath.Dir(preview.Path)); err != nil {
		return err
	}
	if err := ensureExactJSON(p.claimPath("cleanup-detached", preview.OperationID), cleanupStep{preview.OperationID, preview.Digest, "detached"}); err != nil {
		return err
	}
	if refExists {
		// Git's expected-old-object check is the final ref fence. Never force a
		// moved branch or remove a different branch discovered after preview.
		_, commandErr := p.git.run(ctx, preview.GitDirectory, nil, 16<<10, "update-ref", "-d", preview.Branch, preview.ExpectedHead)
		workExists, refExists, err = p.cleanupTopology(ctx, preview)
		if err != nil || workExists || refExists {
			return errors.Join(ErrCleanupUnknown, commandErr, err)
		}
	}
	if err := syncTree(preview.GitDirectory); err != nil {
		return err
	}
	return ensureExactJSON(p.claimPath("cleanup-ref", preview.OperationID), cleanupStep{preview.OperationID, preview.Digest, "ref_deleted"})
}
