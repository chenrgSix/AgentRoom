package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/durablefs"
)

// CaptureRequest contains only recorded identities, never caller-supplied paths
// or a replacement scope policy. The Bridge admission adapter must authorize
// this operation and hold its existing stopped-Run fence for the entire call.
type CaptureRequest struct {
	OperationID        string `json:"operationId"`
	WorkspaceRef       string `json:"workspaceRef"`
	PreparedDigest     string `json:"preparedDigest"`
	ExpectedGeneration string `json:"expectedGeneration"`
	ManifestDigest     string `json:"manifestDigest"`
}

type captureIntent struct {
	Kind         string           `json:"kind"`
	Version      int              `json:"version"`
	Request      CaptureRequest   `json:"request"`
	ObservedHead string           `json:"observedHead"`
	IndexDigest  string           `json:"indexDigest"`
	Snapshot     workSnapshot     `json:"snapshot"`
	Changes      []CapturedChange `json:"changes"`
	CapturedAt   time.Time        `json:"capturedAt"`
}

type captureCandidate struct {
	IntentDigest      string `json:"intentDigest"`
	DirectoryIdentity string `json:"directoryIdentity"`
	GitIdentity       string `json:"gitIdentity"`
	ConfigDigest      string `json:"configDigest"`
	Commit            string `json:"commit"`
	Tree              string `json:"tree"`
}

// CapturedRepository is a sealed LOCAL code observation. Formal publication must
// bind its actual bytes to canonical Artifacts before a RepositoryCheckpoint can
// cite it. It is not verification, Task acceptance, or a cleanup authorization.
type CapturedRepository struct {
	Version             int              `json:"version"`
	OperationID         string           `json:"operationId"`
	RunID               string           `json:"runId"`
	WorkspaceRef        string           `json:"workspaceRef"`
	WorkspaceGeneration string           `json:"workspaceGeneration"`
	ManifestDigest      string           `json:"manifestDigest"`
	PreparedDigest      string           `json:"preparedDigest"`
	RepositoryID        string           `json:"repositoryId"`
	BindingID           string           `json:"bindingId"`
	BaseCommit          string           `json:"baseCommit"`
	PreparedCommit      string           `json:"preparedCommit"`
	OutputBaseCommit    string           `json:"outputBaseCommit,omitempty"`
	ObservedHead        string           `json:"observedHead"`
	CandidateCommit     string           `json:"candidateCommit"`
	CandidateTree       string           `json:"candidateTree"`
	PatchDigest         string           `json:"patchDigest"`
	PatchBytes          int64            `json:"patchBytes"`
	SnapshotDigest      string           `json:"snapshotDigest"`
	Changes             []CapturedChange `json:"changes"`
	CapturedAt          time.Time        `json:"capturedAt"`
	Digest              string           `json:"digest"`
}

const maximumCapturedPatch = 4 << 20 // current canonical Artifact transport limit

func (p *Preparer) capturePath(operationID string) string {
	return filepath.Join(p.root, "captures", digest(operationID))
}

func validCaptureRequest(request CaptureRequest) bool {
	return localID.MatchString(request.OperationID) && localID.MatchString(request.WorkspaceRef) &&
		sha256ID.MatchString(request.PreparedDigest) && sha256ID.MatchString(request.ExpectedGeneration) && sha256ID.MatchString(request.ManifestDigest)
}

func (p *Preparer) capturePreparation(request CaptureRequest) (preparationIntent, preparedCandidate, PreparedWorkspace, error) {
	var intent preparationIntent
	var ready PreparedWorkspace
	if err := readJSON(p.claimPath("workspace", request.WorkspaceRef), &intent); err != nil {
		return intent, preparedCandidate{}, ready, err
	}
	if !validPreparationVersion(intent) || digest(intent) != request.PreparedDigest || intent.Generation != request.ExpectedGeneration ||
		intent.ManifestDigest != request.ManifestDigest || intent.WorkspaceRef != request.WorkspaceRef {
		return intent, preparedCandidate{}, ready, ErrConflict
	}
	policy, err := freezeScopePolicy(intent.ScopePolicy)
	if err != nil || digest(policy) != digest(intent.ScopePolicy) {
		return intent, preparedCandidate{}, ready, ErrChanged
	}
	if err := readJSON(p.claimPath("ready", request.WorkspaceRef), &ready); err != nil {
		return intent, preparedCandidate{}, ready, err
	}
	candidate, err := p.readCandidate(request.WorkspaceRef, request.PreparedDigest)
	if err != nil {
		return intent, candidate, ready, err
	}
	attempt := p.attemptPath(request.WorkspaceRef)
	if ready.IntentDigest != request.PreparedDigest || ready.WorkspaceRef != intent.WorkspaceRef || ready.Generation != intent.Generation ||
		ready.OperationID != intent.OperationID || ready.RunID != intent.RunID || ready.BaseCommit != intent.BaseCommit ||
		ready.PreparedCommit != candidate.Commit || ready.PreparedTree != candidate.Tree || ready.Branch != p.branch(intent) ||
		ready.OutputBaseCommit != candidate.OutputBaseCommit ||
		ready.Path != filepath.Join(attempt, "work") || ready.GitDirectory != filepath.Join(attempt, "git") {
		return intent, candidate, ready, ErrChanged
	}
	return intent, candidate, ready, nil
}

func (p *Preparer) observeCaptureHead(ctx context.Context, intent preparationIntent, candidate preparedCandidate, ready PreparedWorkspace) (string, error) {
	if err := p.checkCandidate(intent, candidate); err != nil {
		return "", err
	}
	identity, err := directoryIdentity(ready.Path)
	if err != nil || identity != ready.WorkIdentity {
		return "", ErrChanged
	}
	if err := checkWorktreeLinks(ready.Path, ready.GitDirectory); err != nil {
		return "", err
	}
	branch, err := p.git.text(ctx, ready.Path, "symbolic-ref", "HEAD")
	if err != nil || branch != ready.Branch {
		return "", ErrChanged
	}
	head, err := p.git.text(ctx, ready.Path, "rev-parse", "HEAD")
	if err != nil || !validObject(head, intent.Source.ObjectFormat) {
		return "", ErrChanged
	}
	if _, err := p.git.run(ctx, ready.Path, nil, 1024, "merge-base", "--is-ancestor", ready.PreparedCommit, head); err != nil {
		return "", ErrChanged
	}
	return head, nil
}

// Capture does not modify the Agent branch, index, working files or source
// repository. It creates a separate immutable Git store from verified bytes.
func (p *Preparer) Capture(ctx context.Context, request CaptureRequest) (CapturedRepository, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.checkOwner(); err != nil {
		return CapturedRepository{}, err
	}
	if err := ctx.Err(); err != nil {
		return CapturedRepository{}, err
	}
	if !validCaptureRequest(request) {
		return CapturedRepository{}, ErrInvalid
	}
	intent, base, ready, err := p.capturePreparation(request)
	if err != nil {
		return CapturedRepository{}, err
	}
	var recorded captureIntent
	operationPath := p.claimPath("operation", request.OperationID)
	loadErr := readJSONSized(operationPath, &recorded, 32<<20)
	if loadErr == nil && (recorded.Kind != "capture" || recorded.Version != 1 || digest(recorded.Request) != digest(request)) {
		return CapturedRepository{}, ErrConflict
	}
	if loadErr != nil && !errors.Is(loadErr, os.ErrNotExist) {
		return CapturedRepository{}, ErrConflict
	}
	var candidate captureCandidate
	candidateErr := readJSON(p.claimPath("capture-candidate", request.OperationID), &candidate)
	if candidateErr == nil {
		if loadErr != nil || candidate.IntentDigest != digest(recorded) {
			return CapturedRepository{}, ErrChanged
		}
		var claim CaptureRequest
		if err := readJSON(p.claimPath("capture-workspace", request.WorkspaceRef), &claim); err != nil || digest(claim) != digest(request) {
			return CapturedRepository{}, ErrChanged
		}
		return p.finishCapture(ctx, intent, ready, recorded, candidate)
	}
	if !errors.Is(candidateErr, os.ErrNotExist) {
		return CapturedRepository{}, candidateErr
	}
	head, err := p.observeCaptureHead(ctx, intent, base, ready)
	if err != nil {
		return CapturedRepository{}, err
	}
	baseline, err := p.git.entries(ctx, ready.GitDirectory, ready.outputBase(), intent.Source.ObjectFormat)
	if err != nil {
		return CapturedRepository{}, err
	}
	modes, indexDigest, err := p.git.captureIndex(ctx, ready, head, intent.Source.ObjectFormat, baseline)
	if err != nil {
		return CapturedRepository{}, err
	}
	snapshot, err := p.git.snapshotWork(ctx, ready.Path, intent.Source.ObjectFormat, baseline, modes)
	if err != nil {
		return CapturedRepository{}, err
	}
	changes, err := changedFiles(baseline, snapshot, intent)
	if err != nil {
		return CapturedRepository{}, err
	}
	again, err := p.git.snapshotWork(ctx, ready.Path, intent.Source.ObjectFormat, baseline, modes)
	if err != nil || digest(snapshot) != digest(again) {
		return CapturedRepository{}, ErrChanged
	}
	endHead, err := p.observeCaptureHead(ctx, intent, base, ready)
	if err != nil || endHead != head {
		return CapturedRepository{}, ErrChanged
	}
	_, endIndex, err := p.git.captureIndex(ctx, ready, head, intent.Source.ObjectFormat, baseline)
	if err != nil || endIndex != indexDigest {
		return CapturedRepository{}, ErrChanged
	}
	if loadErr == nil {
		if recorded.ObservedHead != head || recorded.IndexDigest != indexDigest || digest(recorded.Snapshot) != digest(snapshot) || digest(recorded.Changes) != digest(changes) {
			return CapturedRepository{}, ErrChanged
		}
	} else {
		recorded = captureIntent{Kind: "capture", Version: 1, Request: request, ObservedHead: head, IndexDigest: indexDigest, Snapshot: snapshot, Changes: changes, CapturedAt: time.Now().UTC()}
		if err := ensureExactJSON(operationPath, recorded); err != nil {
			return CapturedRepository{}, err
		}
	}
	// One capture identity per prepared generation; no second observation can
	// overwrite the first candidate under the same Run/workspace history.
	if err := ensureExactJSON(p.claimPath("capture-workspace", request.WorkspaceRef), request); err != nil {
		return CapturedRepository{}, err
	}
	candidate, err = p.buildCapture(ctx, intent, ready, recorded, snapshot)
	if err != nil {
		return CapturedRepository{}, err
	}
	return p.finishCapture(ctx, intent, ready, recorded, candidate)
}

func (p *Preparer) buildCapture(ctx context.Context, prepared preparationIntent, ready PreparedWorkspace, intent captureIntent, snapshot workSnapshot) (captureCandidate, error) {
	root := p.capturePath(intent.Request.OperationID)
	if err := os.Mkdir(root, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return captureCandidate{}, ErrIncomplete
		}
		return captureCandidate{}, err
	}
	if err := durablefs.SyncParent(root); err != nil {
		return captureCandidate{}, err
	}
	gitDir, blobs := filepath.Join(root, "git"), filepath.Join(root, "blobs")
	for _, path := range []string{gitDir, blobs} {
		if err := os.Mkdir(path, 0o700); err != nil {
			return captureCandidate{}, err
		}
	}
	id, err := directoryIdentity(ready.GitDirectory)
	if err != nil {
		return captureCandidate{}, err
	}
	source := Source{Root: ready.GitDirectory, GitDirectory: ready.GitDirectory, CommonDirectory: ready.GitDirectory,
		ObjectFormat: prepared.Source.ObjectFormat, RootIdentity: id, GitIdentity: id, CommonIdentity: id}
	if _, err := p.git.importSnapshot(ctx, source, ready.outputBase(), gitDir); err != nil {
		return captureCandidate{}, err
	}
	seen := map[string]bool{}
	var paths, expected []string
	for _, file := range snapshot.Files {
		if file.Mode == "160000" || seen[file.Object] {
			continue
		}
		seen[file.Object] = true
		path := filepath.Join(blobs, file.Object)
		if err := writeExclusive(path, file.Data); err != nil {
			return captureCandidate{}, err
		}
		paths = append(paths, path)
		expected = append(expected, file.Object)
	}
	if len(paths) > 0 {
		objects, err := p.git.run(ctx, gitDir, strings.NewReader(strings.Join(paths, "\n")+"\n"), 16<<20, "hash-object", "--no-filters", "-w", "--stdin-paths")
		if err != nil {
			return captureCandidate{}, err
		}
		if string(objects) != strings.Join(expected, "\n")+"\n" {
			return captureCandidate{}, ErrChanged
		}
	}
	// The object store now has the exact bytes. Flush it before dropping only
	// our explicitly enumerated staging copies; never recursively remove a root.
	if err := syncTree(gitDir); err != nil {
		return captureCandidate{}, err
	}
	for _, path := range paths {
		if err := os.Remove(path); err != nil {
			return captureCandidate{}, err
		}
	}
	if err := os.Remove(blobs); err != nil {
		return captureCandidate{}, err
	}
	if err := durablefs.SyncDirectory(root); err != nil {
		return captureCandidate{}, err
	}
	if _, err := p.git.run(ctx, gitDir, nil, 1024, "read-tree", "--empty"); err != nil {
		return captureCandidate{}, err
	}
	var index bytes.Buffer
	for _, file := range snapshot.Files {
		index.WriteString(file.Mode + " " + file.Object + "\t" + file.Path + "\x00")
	}
	if _, err := p.git.run(ctx, gitDir, &index, 1024, "update-index", "-z", "--index-info"); err != nil {
		return captureCandidate{}, err
	}
	tree, err := p.git.text(ctx, gitDir, "write-tree")
	if err != nil {
		return captureCandidate{}, err
	}
	commit, err := p.git.run(ctx, gitDir, strings.NewReader("ConveneWire captured output "+digest(intent)+"\n"), 1024, "commit-tree", tree, "-p", ready.outputBase())
	if err != nil {
		return captureCandidate{}, err
	}
	commitID := strings.TrimSpace(string(commit))
	if !validObject(tree, prepared.Source.ObjectFormat) || !validObject(commitID, prepared.Source.ObjectFormat) {
		return captureCandidate{}, ErrChanged
	}
	if _, err := p.git.run(ctx, gitDir, nil, 1024, "update-ref", "refs/heads/codex/capture", commitID, strings.Repeat("0", len(commitID))); err != nil {
		return captureCandidate{}, err
	}
	rootID, err := directoryIdentity(root)
	if err != nil {
		return captureCandidate{}, err
	}
	gitID, err := directoryIdentity(gitDir)
	if err != nil {
		return captureCandidate{}, err
	}
	config, err := readRegular(filepath.Join(gitDir, "config"), 64<<10)
	if err != nil {
		return captureCandidate{}, err
	}
	candidate := captureCandidate{IntentDigest: digest(intent), DirectoryIdentity: rootID, GitIdentity: gitID, ConfigDigest: digest(string(config)), Commit: commitID, Tree: tree}
	if err := syncTree(root); err != nil {
		return captureCandidate{}, err
	}
	if err := ensureExactJSON(p.claimPath("capture-candidate", intent.Request.OperationID), candidate); err != nil {
		return captureCandidate{}, err
	}
	return candidate, nil
}

func (p *Preparer) verifyCaptureCandidate(ctx context.Context, prepared preparationIntent, ready PreparedWorkspace, intent captureIntent, candidate captureCandidate) error {
	root := p.capturePath(intent.Request.OperationID)
	gitDir := filepath.Join(root, "git")
	if err := checkOwnedGitMetadata(gitDir, max(4096, p.git.limits.Entries*4)); err != nil {
		return err
	}
	for path, expected := range map[string]string{root: candidate.DirectoryIdentity, gitDir: candidate.GitIdentity} {
		actual, err := directoryIdentity(path)
		if err != nil || actual != expected {
			return ErrChanged
		}
	}
	config, err := readRegular(filepath.Join(gitDir, "config"), 64<<10)
	if err != nil || digest(string(config)) != candidate.ConfigDigest {
		return ErrChanged
	}
	attributes, err := readRegular(filepath.Join(gitDir, "info", "attributes"), 4096)
	if err != nil || string(attributes) != exactCheckoutAttributes {
		return ErrChanged
	}
	shallow, err := readRegular(filepath.Join(gitDir, "shallow"), 4096)
	if err != nil || string(shallow) != ready.outputBase()+"\n" {
		return ErrChanged
	}
	if _, err := os.Lstat(filepath.Join(gitDir, "info", "grafts")); !errors.Is(err, os.ErrNotExist) {
		return ErrChanged
	}
	if candidate.IntentDigest != digest(intent) || !validObject(candidate.Commit, prepared.Source.ObjectFormat) || !validObject(candidate.Tree, prepared.Source.ObjectFormat) {
		return ErrChanged
	}
	source := Source{Root: gitDir, GitDirectory: gitDir, CommonDirectory: gitDir, ObjectFormat: prepared.Source.ObjectFormat,
		RootIdentity: candidate.GitIdentity, GitIdentity: candidate.GitIdentity, CommonIdentity: candidate.GitIdentity}
	_, tree, err := p.git.objectList(ctx, source, candidate.Commit)
	if err != nil || tree != candidate.Tree {
		return ErrChanged
	}
	entries, err := p.git.entries(ctx, gitDir, candidate.Tree, prepared.Source.ObjectFormat)
	if err != nil {
		return err
	}
	actualFiles := map[string]treeEntry{}
	for _, entry := range entries {
		if entry.kind != "tree" {
			actualFiles[entry.path] = entry
		}
	}
	if len(actualFiles) != len(intent.Snapshot.Files) {
		return ErrChanged
	}
	for _, file := range intent.Snapshot.Files {
		actual := actualFiles[file.Path]
		if actual.id != file.Object || actual.mode != file.Mode {
			return ErrChanged
		}
	}
	if _, err := p.git.run(ctx, gitDir, nil, 16<<10, "fsck", "--full", "--strict", "--no-reflogs"); err != nil {
		return ErrChanged
	}
	return nil
}

func (p *Preparer) finishCapture(ctx context.Context, prepared preparationIntent, ready PreparedWorkspace, intent captureIntent, candidate captureCandidate) (CapturedRepository, error) {
	if err := p.verifyCaptureCandidate(ctx, prepared, ready, intent, candidate); err != nil {
		return CapturedRepository{}, err
	}
	root := p.capturePath(intent.Request.OperationID)
	gitDir := filepath.Join(root, "git")
	patch, err := p.git.run(ctx, gitDir, nil, maximumCapturedPatch, "diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", ready.outputBase(), candidate.Commit, "--")
	if err != nil {
		return CapturedRepository{}, err
	}
	hash := sha256.Sum256(patch)
	patchPath := filepath.Join(root, "output.patch")
	if existing, err := readRegular(patchPath, maximumCapturedPatch); err == nil {
		if !bytes.Equal(existing, patch) {
			return CapturedRepository{}, ErrChanged
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := writeExclusive(patchPath, patch); err != nil {
			return CapturedRepository{}, err
		}
	} else {
		return CapturedRepository{}, err
	}
	result := CapturedRepository{Version: 1, OperationID: intent.Request.OperationID, RunID: prepared.RunID, WorkspaceRef: prepared.WorkspaceRef,
		WorkspaceGeneration: prepared.Generation, ManifestDigest: prepared.ManifestDigest, PreparedDigest: ready.IntentDigest,
		RepositoryID: prepared.RepositoryID, BindingID: prepared.BindingID, BaseCommit: prepared.BaseCommit, PreparedCommit: ready.PreparedCommit,
		OutputBaseCommit: ready.OutputBaseCommit, ObservedHead: intent.ObservedHead, CandidateCommit: candidate.Commit, CandidateTree: candidate.Tree, PatchDigest: hex.EncodeToString(hash[:]),
		PatchBytes: int64(len(patch)), SnapshotDigest: digest(intent.Snapshot), Changes: intent.Changes, CapturedAt: intent.CapturedAt}
	result.Digest = digest(result)
	if err := ensureExactJSON(p.claimPath("capture", intent.Request.OperationID), result); err != nil {
		return CapturedRepository{}, err
	}
	return result, nil
}

// ReadCapturedPatch returns only bytes matching a sealed local observation. It
// does not add a central Artifact identity or confer cross-Task read authority.
func (p *Preparer) ReadCapturedPatch(ctx context.Context, operationID, expectedDigest string) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.readCapturedPatchLocked(ctx, operationID, expectedDigest)
}

func (p *Preparer) readCapturedPatchLocked(ctx context.Context, operationID, expectedDigest string) ([]byte, error) {
	if err := p.checkOwner(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !localID.MatchString(operationID) || !sha256ID.MatchString(expectedDigest) {
		return nil, ErrInvalid
	}
	var record CapturedRepository
	if err := readJSONSized(p.claimPath("capture", operationID), &record, 32<<20); err != nil {
		return nil, err
	}
	actual := record.Digest
	record.Digest = ""
	if actual != expectedDigest || digest(record) != actual || record.OperationID != operationID {
		return nil, ErrChanged
	}
	var candidate captureCandidate
	if err := readJSON(p.claimPath("capture-candidate", operationID), &candidate); err != nil {
		return nil, err
	}
	if identity, err := directoryIdentity(p.capturePath(operationID)); err != nil || identity != candidate.DirectoryIdentity {
		return nil, ErrChanged
	}
	patch, err := readRegular(filepath.Join(p.capturePath(operationID), "output.patch"), maximumCapturedPatch)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(patch)
	if record.PatchBytes != int64(len(patch)) || record.PatchDigest != hex.EncodeToString(hash[:]) {
		return nil, ErrChanged
	}
	return patch, nil
}
