package repository

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

func (p *Preparer) cleanupPreview(operationID string, evidence cleanupEvidence) CleanupPreview {
	r, c, observed := evidence.ready, evidence.candidate, evidence.observation
	preview := CleanupPreview{Version: 1, OperationID: operationID, CheckpointID: evidence.checkpoint.CheckpointID,
		CheckpointDigest: evidence.checkpoint.Digest, CaptureDigest: evidence.captured.Digest, PreparedDigest: r.IntentDigest,
		RunID: r.RunID, WorkspaceRef: r.WorkspaceRef, Generation: evidence.captured.WorkspaceGeneration, ManifestDigest: evidence.captured.ManifestDigest,
		Path: r.Path, GitDirectory: r.GitDirectory, Branch: r.Branch, ExpectedHead: observed.ObservedHead,
		AttemptIdentity: c.AttemptIdentity, GitIdentity: c.GitIdentity, WorkIdentity: r.WorkIdentity,
		SnapshotDigest: evidence.captured.SnapshotDigest, IndexDigest: observed.IndexDigest,
		RetainedPaths: []string{r.GitDirectory, filepath.Join(p.attemptPath(r.WorkspaceRef), "scratch"), p.capturePath(evidence.captured.OperationID)}}
	preview.Digest = digest(preview)
	return preview
}

func (p *Preparer) cleanupPreviewMatchesEvidence(preview CleanupPreview, evidence cleanupEvidence) bool {
	return validCleanupPreview(preview) && digest(preview) == digest(p.cleanupPreview(preview.OperationID, evidence))
}

func (p *Preparer) inspectCleanup(ctx context.Context, operationID string, evidence cleanupEvidence) (CleanupPreview, error) {
	var empty CleanupPreview
	if err := p.checkOwner(); err != nil {
		return empty, err
	}
	head, err := p.observeCaptureHead(ctx, evidence.prepared, evidence.candidate, evidence.ready)
	if err != nil || head != evidence.observation.ObservedHead {
		return empty, ErrChanged
	}
	baseline, err := p.git.entries(ctx, evidence.ready.GitDirectory, evidence.ready.outputBase(), evidence.prepared.Source.ObjectFormat)
	if err != nil {
		return empty, err
	}
	modes, index, err := p.git.captureIndex(ctx, evidence.ready, head, evidence.prepared.Source.ObjectFormat, baseline)
	if err != nil || index != evidence.observation.IndexDigest {
		return empty, ErrChanged
	}
	// Hash working bytes, including ignored/untracked content, not just status.
	// The stopped-Run authority remains held over both checks and later deletion.
	for count := 0; count < 2; count++ {
		snapshot, err := p.git.snapshotWork(ctx, evidence.ready.Path, evidence.prepared.Source.ObjectFormat, baseline, modes)
		if err != nil || digest(snapshot) != evidence.captured.SnapshotDigest {
			return empty, ErrChanged
		}
	}
	endHead, err := p.observeCaptureHead(ctx, evidence.prepared, evidence.candidate, evidence.ready)
	if err != nil || endHead != head {
		return empty, ErrChanged
	}
	_, endIndex, err := p.git.captureIndex(ctx, evidence.ready, head, evidence.prepared.Source.ObjectFormat, baseline)
	if err != nil || endIndex != index {
		return empty, ErrChanged
	}
	preview := p.cleanupPreview(operationID, evidence)
	workExists, refExists, err := p.cleanupTopology(ctx, preview)
	if err != nil {
		return empty, err
	}
	if !workExists || !refExists {
		return empty, ErrChanged
	}
	return preview, nil
}

// Reject unknown, prunable or locked records, and never run a broad prune.
func (g gitRunner) cleanupWorktrees(ctx context.Context, gitDir string) (map[string]map[string]string, error) {
	raw, err := g.run(ctx, gitDir, nil, 64<<10, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return nil, err
	}
	result := map[string]map[string]string{}
	record := map[string]string{}
	for _, field := range strings.Split(string(raw), "\x00") {
		if field == "" {
			if len(record) == 0 {
				continue
			}
			path := filepath.Clean(filepath.FromSlash(record["worktree"]))
			if !filepath.IsAbs(path) || result[path] != nil || len(result) > 2 {
				return nil, ErrChanged
			}
			result[path], record = record, map[string]string{}
			continue
		}
		key, value, _ := strings.Cut(field, " ")
		if _, exists := record[key]; exists {
			return nil, ErrChanged
		}
		if key != "worktree" && key != "HEAD" && key != "branch" && key != "bare" {
			return nil, ErrChanged
		}
		record[key] = value
	}
	if len(record) != 0 {
		return nil, ErrChanged
	}
	return result, nil
}

func (p *Preparer) cleanupTopology(ctx context.Context, preview CleanupPreview) (bool, bool, error) {
	if err := p.checkOwner(); err != nil {
		return false, false, err
	}
	for path, expected := range map[string]string{filepath.Dir(preview.Path): preview.AttemptIdentity, preview.GitDirectory: preview.GitIdentity} {
		actual, err := directoryIdentity(path)
		if err != nil || actual != expected {
			return false, false, ErrChanged
		}
	}
	if err := checkOwnedGitMetadata(preview.GitDirectory, max(4096, p.git.limits.Entries*4)); err != nil {
		return false, false, err
	}
	workExists := false
	if _, err := os.Lstat(preview.Path); err == nil {
		identity, err := directoryIdentity(preview.Path)
		if err != nil || identity != preview.WorkIdentity {
			return false, false, ErrChanged
		}
		workExists = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, false, err
	}
	worktrees, err := p.git.cleanupWorktrees(ctx, preview.GitDirectory)
	if err != nil {
		return false, false, err
	}
	bare := worktrees[preview.GitDirectory]
	if len(bare) != 2 || bare["worktree"] == "" {
		return false, false, ErrChanged
	}
	if _, exists := bare["bare"]; !exists {
		return false, false, ErrChanged
	}
	if workExists {
		work := worktrees[preview.Path]
		if len(worktrees) != 2 || len(work) != 3 || work["HEAD"] != preview.ExpectedHead || work["branch"] != preview.Branch {
			return false, false, ErrChanged
		}
		if err := checkWorktreeLinks(preview.Path, preview.GitDirectory); err != nil {
			return false, false, err
		}
	} else {
		if len(worktrees) != 1 {
			return false, false, ErrCleanupUnknown
		}
		// Missing working files alone do not prove that Git retired the worktree.
		if entries, err := os.ReadDir(filepath.Join(preview.GitDirectory, "worktrees")); err == nil {
			if len(entries) != 0 {
				return false, false, ErrCleanupUnknown
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return false, false, err
		}
	}
	refs, err := p.git.text(ctx, preview.GitDirectory, "for-each-ref", "--format=%(objectname) %(refname)")
	if err != nil {
		return false, false, err
	}
	if refs == "" {
		if workExists {
			return false, false, ErrChanged
		}
		return false, false, nil
	}
	if refs != preview.ExpectedHead+" "+preview.Branch {
		return false, false, ErrChanged
	}
	return workExists, true, nil
}
