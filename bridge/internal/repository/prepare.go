package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	"convenewire.dev/bridge/internal/durablefs"
	"convenewire.dev/bridge/internal/ownership"
	execution "convenewire.dev/contracts/generated/go/execution"
)

// PatchInput is a locally fetched, already-authorized exact input. Its bytes
// are checked against the frozen binding digest before any Git mutation.
// Authorization and transport remain the caller's responsibility; this type is
// deliberately not a public request or a replacement for TaskInputBinding.
type PatchInput struct {
	BindingID string
	SHA256    string
	Bytes     []byte
}

// Preparation is the local projection of an admitted manifest. No caller is
// currently wired to this primitive: BRG-071/RUN-018 must first implement local
// grant checks, full shared-contract validation and the durable Run start fence.
type Preparation struct {
	OperationID    string
	RunID          string
	RepositoryID   string
	BindingID      string
	WorkspaceRef   string
	Generation     string
	ManifestDigest string
	BaseCommit     string
	Inputs         []PatchInput
	ScopePolicy    execution.ManifestScopePolicy
}

type inputPin struct {
	BindingID string `json:"bindingId"`
	SHA256    string `json:"sha256"`
	Bytes     int    `json:"bytes"`
}
type preparationIntent struct {
	Version        int                           `json:"version"`
	OperationID    string                        `json:"operationId"`
	RunID          string                        `json:"runId"`
	RepositoryID   string                        `json:"repositoryId"`
	BindingID      string                        `json:"bindingId"`
	WorkspaceRef   string                        `json:"workspaceRef"`
	Generation     string                        `json:"generation"`
	ManifestDigest string                        `json:"manifestDigest"`
	BaseCommit     string                        `json:"baseCommit"`
	Source         Source                        `json:"source"`
	Inputs         []inputPin                    `json:"inputs"`
	ScopePolicy    execution.ManifestScopePolicy `json:"scopePolicy"`
	Resume         *checkpointResumePin          `json:"resume,omitempty"`
}

type preparedCandidate struct {
	IntentDigest     string `json:"intentDigest"`
	AttemptIdentity  string `json:"attemptIdentity"`
	GitIdentity      string `json:"gitIdentity"`
	ConfigDigest     string `json:"configDigest"`
	Commit           string `json:"commit"`
	Tree             string `json:"tree"`
	OutputBaseCommit string `json:"outputBaseCommit,omitempty"`
}

// PreparedWorkspace is a LOCAL record, not a RepositoryCheckpoint or evidence
// receipt. It proves preparation only: it cannot prove Runtime invocation,
// canonical Artifact publication, code verification or Task completion.
type PreparedWorkspace struct {
	Version        int    `json:"version"`
	IntentDigest   string `json:"intentDigest"`
	OperationID    string `json:"operationId"`
	RunID          string `json:"runId"`
	WorkspaceRef   string `json:"workspaceRef"`
	Generation     string `json:"generation"`
	BaseCommit     string `json:"baseCommit"`
	PreparedCommit string `json:"preparedCommit"`
	PreparedTree   string `json:"preparedTree"`
	// A resumed attempt starts at PreparedCommit but publishes cumulative Task
	// output relative to the approved base plus upstream inputs. Empty preserves
	// the original journal encoding and means PreparedCommit.
	OutputBaseCommit string `json:"outputBaseCommit,omitempty"`
	Branch           string `json:"branch"`
	Path             string `json:"path"`
	GitDirectory     string `json:"gitDirectory"`
	WorkIdentity     string `json:"workIdentity"`
}

// Preparer owns a dedicated directory for its lifetime. Its lock serializes
// journal/Git preparation, not Agent execution. Separate Runtime workspaces
// never share a writable Git common directory. Close does not delete anything.
type Preparer struct {
	mu          sync.Mutex
	root        string
	git         gitRunner
	owner       *ownership.Lock
	directories map[string]string
	closed      bool
}

func NewPreparer(stateRoot, gitExecutable string, limits Limits) (*Preparer, error) {
	g, err := newGit(gitExecutable, limits)
	if err != nil {
		return nil, err
	}
	root, err := canonicalDirectory(stateRoot)
	if err != nil || root != stateRoot || filepath.Dir(root) == root {
		return nil, ErrInvalid
	}
	info, err := os.Stat(root)
	if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		return nil, ErrInvalid
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry.Name() != ".bridge-owner.lock" && entry.Name() != "claims" && entry.Name() != "attempts" && entry.Name() != "captures" {
			return nil, ErrInvalid
		}
	}
	owner, err := ownership.Acquire(root)
	if err != nil {
		return nil, err
	}
	for _, name := range []string{"claims", "attempts", "captures"} {
		path := filepath.Join(root, name)
		if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			owner.Release()
			return nil, err
		}
		if _, err := directoryIdentity(path); err != nil {
			owner.Release()
			return nil, err
		}
	}
	if err := durablefs.SyncDirectory(root); err != nil {
		owner.Release()
		return nil, err
	}
	directories := map[string]string{}
	for _, path := range []string{root, filepath.Join(root, "claims"), filepath.Join(root, "attempts"), filepath.Join(root, "captures")} {
		id, err := directoryIdentity(path)
		if err != nil {
			owner.Release()
			return nil, err
		}
		directories[path] = id
	}
	return &Preparer{root: root, git: g, owner: owner, directories: directories}, nil
}

func (p *Preparer) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	p.closed = true
	return p.owner.Release()
}

var localID = regexp.MustCompile(`^[A-Za-z0-9_-]{8,160}$`)
var sha256ID = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (p *Preparer) intent(source Source, request Preparation) (preparationIntent, error) {
	for _, id := range []string{request.OperationID, request.RunID, request.RepositoryID, request.BindingID, request.WorkspaceRef} {
		if !localID.MatchString(id) {
			return preparationIntent{}, ErrInvalid
		}
	}
	if !sha256ID.MatchString(request.Generation) || !sha256ID.MatchString(request.ManifestDigest) ||
		!validObject(request.BaseCommit, source.ObjectFormat) || len(request.Inputs) > 32 {
		return preparationIntent{}, ErrInvalid
	}
	policy, err := freezeScopePolicy(request.ScopePolicy)
	if err != nil {
		return preparationIntent{}, err
	}
	intent := preparationIntent{Version: 2, OperationID: request.OperationID, RunID: request.RunID, RepositoryID: request.RepositoryID,
		BindingID: request.BindingID, WorkspaceRef: request.WorkspaceRef, Generation: request.Generation,
		ManifestDigest: request.ManifestDigest, BaseCommit: request.BaseCommit, Source: source, Inputs: []inputPin{}, ScopePolicy: policy}
	seen := map[string]bool{}
	var inputBytes int64
	for _, input := range request.Inputs {
		hash := sha256.Sum256(input.Bytes)
		if !localID.MatchString(input.BindingID) || seen[input.BindingID] || !sha256ID.MatchString(input.SHA256) ||
			input.SHA256 != hex.EncodeToString(hash[:]) || len(input.Bytes) == 0 {
			return intent, ErrInvalid
		}
		if len(input.Bytes) > 64<<20 || int64(len(input.Bytes)) > p.git.limits.SnapshotBytes-inputBytes {
			return intent, ErrLimit
		}
		expansion, err := patchExpansionBound(input.Bytes, p.git.limits.SnapshotBytes-inputBytes)
		if err != nil {
			return intent, err
		}
		seen[input.BindingID] = true
		inputBytes += expansion
		intent.Inputs = append(intent.Inputs, inputPin{input.BindingID, input.SHA256, len(input.Bytes)})
	}
	return intent, nil
}

func freezeInputs(inputs []PatchInput, limit int64) ([]PatchInput, error) {
	if len(inputs) > 32 {
		return nil, ErrInvalid
	}
	var size int64
	for _, input := range inputs {
		if len(input.Bytes) > 64<<20 || int64(len(input.Bytes)) > limit-size {
			return nil, ErrLimit
		}
		size += int64(len(input.Bytes))
	}
	frozen := make([]PatchInput, len(inputs))
	for i, input := range inputs {
		frozen[i] = input
		frozen[i].Bytes = bytes.Clone(input.Bytes)
	}
	return frozen, nil
}

func (p *Preparer) claimPath(kind, id string) string {
	return filepath.Join(p.root, "claims", kind+"_"+digest(id)+".json")
}
func (p *Preparer) attemptPath(workspaceRef string) string {
	return filepath.Join(p.root, "attempts", digest(workspaceRef))
}

// Prepare never checks out or writes the source repository. Exact replay either
// returns the same inspected prepared workspace or fails closed. No existing
// dirty directory is reset, removed, repaired or silently reused.
func (p *Preparer) Prepare(ctx context.Context, source Source, request Preparation) (PreparedWorkspace, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.prepareLocked(ctx, source, request, nil)
}

func (p *Preparer) prepareLocked(ctx context.Context, source Source, request Preparation, resume *checkpointResume) (PreparedWorkspace, error) {
	if err := p.checkOwner(); err != nil {
		return PreparedWorkspace{}, err
	}
	if err := ctx.Err(); err != nil {
		return PreparedWorkspace{}, err
	}
	if err := p.git.checkSource(ctx, source); err != nil {
		return PreparedWorkspace{}, err
	}
	// Never create owner metadata inside the user's source checkout (or vice versa).
	for _, directory := range []string{source.Root, source.GitDirectory, source.CommonDirectory} {
		if contained(directory, p.root) || contained(p.root, directory) {
			return PreparedWorkspace{}, ErrInvalid
		}
	}
	inputs, err := freezeInputs(request.Inputs, p.git.limits.SnapshotBytes)
	if err != nil {
		return PreparedWorkspace{}, err
	}
	request.Inputs = inputs
	intent, err := p.intent(source, request)
	if err != nil {
		return PreparedWorkspace{}, err
	}
	if resume != nil {
		if err := resume.checkInputs(inputs, p.git.limits.SnapshotBytes); err != nil {
			return PreparedWorkspace{}, err
		}
		intent.Version = 3
		intent.Resume = &resume.pin
	}
	for _, claim := range []struct{ kind, id string }{{"operation", request.OperationID}, {"run", request.RunID}, {"workspace", request.WorkspaceRef}} {
		if err := ensureExactJSON(p.claimPath(claim.kind, claim.id), intent); err != nil {
			return PreparedWorkspace{}, err
		}
	}
	key := digest(intent)
	var ready PreparedWorkspace
	readyPath := p.claimPath("ready", request.WorkspaceRef)
	if err := readJSON(readyPath, &ready); err == nil {
		if ready.IntentDigest != key {
			return ready, ErrConflict
		}
		candidate, err := p.readCandidate(request.WorkspaceRef, key)
		if err != nil {
			return PreparedWorkspace{}, err
		}
		verified, err := p.verifyWorkspace(ctx, intent, candidate)
		if err != nil || digest(verified) != digest(ready) {
			if err == nil {
				err = ErrChanged
			}
			return PreparedWorkspace{}, err
		}
		return ready, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return PreparedWorkspace{}, err
	}
	candidate, err := p.readCandidate(request.WorkspaceRef, key)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return PreparedWorkspace{}, err
	}
	if errors.Is(err, os.ErrNotExist) {
		candidate, err = p.createCandidate(ctx, intent, request.Inputs, resume)
		if err != nil {
			return PreparedWorkspace{}, err
		}
	}
	if err := p.checkCandidate(intent, candidate); err != nil {
		return PreparedWorkspace{}, err
	}
	work := filepath.Join(p.attemptPath(intent.WorkspaceRef), "work")
	if _, err := os.Lstat(work); errors.Is(err, os.ErrNotExist) {
		if _, err := p.git.run(ctx, filepath.Join(p.attemptPath(intent.WorkspaceRef), "git"), nil, 16<<10,
			"worktree", "add", "--", work, strings.TrimPrefix(p.branch(intent), "refs/heads/")); err != nil {
			return PreparedWorkspace{}, err
		}
	} else if err != nil {
		return PreparedWorkspace{}, err
	}
	ready, err = p.verifyWorkspace(ctx, intent, candidate)
	if err != nil {
		return PreparedWorkspace{}, err
	}
	if err := syncTree(p.attemptPath(intent.WorkspaceRef)); err != nil {
		return PreparedWorkspace{}, err
	}
	if err := ensureExactJSON(readyPath, ready); err != nil {
		return PreparedWorkspace{}, err
	}
	return ready, nil
}

func (p *Preparer) branch(intent preparationIntent) string {
	return "refs/heads/codex/" + digest(intent.WorkspaceRef)
}

func (p *Preparer) createCandidate(ctx context.Context, intent preparationIntent, inputs []PatchInput, resume *checkpointResume) (preparedCandidate, error) {
	attempt := p.attemptPath(intent.WorkspaceRef)
	if err := os.Mkdir(attempt, 0o700); err != nil {
		if errors.Is(err, os.ErrExist) {
			return preparedCandidate{}, ErrIncomplete
		}
		return preparedCandidate{}, err
	}
	if err := durablefs.SyncParent(attempt); err != nil {
		return preparedCandidate{}, err
	}
	gitDir := filepath.Join(attempt, "git")
	for _, directory := range []string{gitDir, filepath.Join(attempt, "scratch")} {
		if err := os.Mkdir(directory, 0o700); err != nil {
			return preparedCandidate{}, err
		}
	}
	tree, err := p.git.importSnapshot(ctx, intent.Source, intent.BaseCommit, gitDir)
	if err != nil {
		return preparedCandidate{}, err
	}
	if _, err := p.git.run(ctx, gitDir, nil, 16<<10, "read-tree", intent.BaseCommit); err != nil {
		return preparedCandidate{}, err
	}
	for _, input := range inputs {
		if _, err := p.git.run(ctx, gitDir, bytes.NewReader(input.Bytes), 16<<10, "apply", "--cached", "--whitespace=nowarn"); err != nil {
			return preparedCandidate{}, err
		}
	}
	commit := intent.BaseCommit
	if len(inputs) > 0 {
		tree, err = p.git.text(ctx, gitDir, "write-tree")
		if err != nil {
			return preparedCandidate{}, err
		}
		created, err := p.git.run(ctx, gitDir, strings.NewReader("ConveneWire prepared inputs "+digest(intent)+"\n"), 16<<10,
			"commit-tree", tree, "-p", intent.BaseCommit)
		if err != nil {
			return preparedCandidate{}, err
		}
		commit = strings.TrimSpace(string(created))
	}
	outputBase := ""
	if resume != nil {
		outputBase = commit
		if _, err := p.git.run(ctx, gitDir, bytes.NewReader(resume.patch), 16<<10, "apply", "--cached", "--whitespace=nowarn"); err != nil {
			return preparedCandidate{}, err
		}
		tree, err = p.git.text(ctx, gitDir, "write-tree")
		if err != nil || tree != resume.pin.CandidateTree {
			return preparedCandidate{}, ErrChanged
		}
		created, err := p.git.run(ctx, gitDir, strings.NewReader("ConveneWire resumed checkpoint "+digest(intent)+"\n"), 16<<10,
			"commit-tree", tree, "-p", outputBase)
		if err != nil {
			return preparedCandidate{}, err
		}
		commit = strings.TrimSpace(string(created))
	}
	if !validObject(commit, intent.Source.ObjectFormat) || !validObject(tree, intent.Source.ObjectFormat) {
		return preparedCandidate{}, ErrInvalid
	}
	// Reapply the object/checkout budget and path validation after upstream input
	// patches, including large binary expansions and repeated blobs.
	id, err := directoryIdentity(gitDir)
	if err != nil {
		return preparedCandidate{}, err
	}
	owned := Source{Root: gitDir, GitDirectory: gitDir, CommonDirectory: gitDir, ObjectFormat: intent.Source.ObjectFormat,
		RootIdentity: id, GitIdentity: id, CommonIdentity: id}
	if _, _, err = p.git.objectList(ctx, owned, commit); err != nil {
		return preparedCandidate{}, err
	}
	if _, err = p.git.run(ctx, gitDir, nil, 16<<10, "update-ref", p.branch(intent), commit, strings.Repeat("0", len(commit))); err != nil {
		return preparedCandidate{}, err
	}
	attemptID, err := directoryIdentity(attempt)
	if err != nil {
		return preparedCandidate{}, err
	}
	configuration, err := readRegular(filepath.Join(gitDir, "config"), 64<<10)
	if err != nil {
		return preparedCandidate{}, err
	}
	candidate := preparedCandidate{IntentDigest: digest(intent), AttemptIdentity: attemptID, GitIdentity: id,
		ConfigDigest: digest(string(configuration)), Commit: commit, Tree: tree, OutputBaseCommit: outputBase}
	if err := syncTree(attempt); err != nil {
		return preparedCandidate{}, err
	}
	if err := ensureExactJSON(p.claimPath("candidate", intent.WorkspaceRef), candidate); err != nil {
		return preparedCandidate{}, err
	}
	return candidate, nil
}

func (p *Preparer) readCandidate(workspaceRef, key string) (preparedCandidate, error) {
	var candidate preparedCandidate
	err := readJSON(p.claimPath("candidate", workspaceRef), &candidate)
	if err == nil && candidate.IntentDigest != key {
		err = ErrConflict
	}
	return candidate, err
}

func (p *Preparer) checkCandidate(intent preparationIntent, candidate preparedCandidate) error {
	attempt := p.attemptPath(intent.WorkspaceRef)
	if err := checkOwnedGitMetadata(filepath.Join(attempt, "git"), max(4096, p.git.limits.Entries*4)); err != nil {
		return err
	}
	for path, expected := range map[string]string{attempt: candidate.AttemptIdentity, filepath.Join(attempt, "git"): candidate.GitIdentity} {
		actual, err := directoryIdentity(path)
		if err != nil || actual != expected {
			return ErrChanged
		}
	}
	configuration, err := readRegular(filepath.Join(attempt, "git", "config"), 64<<10)
	if err != nil || digest(string(configuration)) != candidate.ConfigDigest {
		return ErrChanged
	}
	attributes, err := readRegular(filepath.Join(attempt, "git", "info", "attributes"), 4096)
	if err != nil || string(attributes) != exactCheckoutAttributes {
		return ErrChanged
	}
	for _, name := range []string{"config.worktree", "info/grafts", "objects/info/alternates", "objects/info/http-alternates"} {
		if _, err := os.Lstat(filepath.Join(attempt, "git", name)); !errors.Is(err, os.ErrNotExist) {
			return ErrChanged
		}
	}
	shallow, err := readRegular(filepath.Join(attempt, "git", "shallow"), 4096)
	if err != nil || string(shallow) != intent.BaseCommit+"\n" {
		return ErrChanged
	}
	if !validObject(candidate.Commit, intent.Source.ObjectFormat) || !validObject(candidate.Tree, intent.Source.ObjectFormat) {
		return ErrChanged
	}
	if !validPreparationVersion(intent) || (intent.Resume == nil && candidate.OutputBaseCommit != "") ||
		(intent.Resume != nil && (!validObject(candidate.OutputBaseCommit, intent.Source.ObjectFormat) || candidate.Tree != intent.Resume.CandidateTree)) {
		return ErrChanged
	}
	return nil
}

func (p *Preparer) verifyWorkspace(ctx context.Context, intent preparationIntent, candidate preparedCandidate) (PreparedWorkspace, error) {
	if err := p.checkCandidate(intent, candidate); err != nil {
		return PreparedWorkspace{}, err
	}
	attempt := p.attemptPath(intent.WorkspaceRef)
	work, gitDir := filepath.Join(attempt, "work"), filepath.Join(attempt, "git")
	workID, err := directoryIdentity(work)
	if err != nil {
		return PreparedWorkspace{}, err
	}
	if err := checkWorktreeLinks(work, gitDir); err != nil {
		return PreparedWorkspace{}, err
	}
	for _, check := range []struct {
		args     []string
		expected string
	}{
		{[]string{"rev-parse", "HEAD"}, candidate.Commit},
		{[]string{"rev-parse", "HEAD^{tree}"}, candidate.Tree},
		{[]string{"symbolic-ref", "HEAD"}, p.branch(intent)},
		{[]string{"rev-parse", "--path-format=absolute", "--git-common-dir"}, gitDir},
		{[]string{"write-tree"}, candidate.Tree},
	} {
		actual, err := p.git.text(ctx, work, check.args...)
		if check.args[len(check.args)-1] == "--git-common-dir" {
			actual = filepath.Clean(actual)
		}
		if err != nil || actual != check.expected {
			return PreparedWorkspace{}, ErrChanged
		}
	}
	status, err := p.git.run(ctx, work, nil, 16<<20, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching")
	if err != nil {
		return PreparedWorkspace{}, err
	}
	if len(status) != 0 {
		return PreparedWorkspace{}, ErrChanged
	}
	if err := p.git.verifyFiles(ctx, work, candidate.Tree, intent.Source.ObjectFormat); err != nil {
		return PreparedWorkspace{}, err
	}
	if candidate.OutputBaseCommit != "" {
		parent, err := p.git.text(ctx, gitDir, "rev-parse", candidate.Commit+"^")
		if err != nil || parent != candidate.OutputBaseCommit {
			return PreparedWorkspace{}, ErrChanged
		}
	}
	return PreparedWorkspace{Version: 1, IntentDigest: digest(intent), OperationID: intent.OperationID, RunID: intent.RunID,
		WorkspaceRef: intent.WorkspaceRef, Generation: intent.Generation, BaseCommit: intent.BaseCommit,
		PreparedCommit: candidate.Commit, PreparedTree: candidate.Tree, OutputBaseCommit: candidate.OutputBaseCommit,
		Branch: p.branch(intent), Path: work, GitDirectory: gitDir, WorkIdentity: workID}, nil
}

func (ready PreparedWorkspace) outputBase() string {
	if ready.OutputBaseCommit != "" {
		return ready.OutputBaseCommit
	}
	return ready.PreparedCommit
}

func readRegular(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, ErrChanged
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		return nil, ErrChanged
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, ErrLimit
	}
	return raw, nil
}

func readJSON(path string, value any) error {
	return readJSONSized(path, value, 1<<20)
}

func readJSONSized(path string, value any, limit int64) error {
	raw, err := readRegular(path, limit)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return ErrChanged
	}
	if decoder.Decode(new(any)) != io.EOF {
		return ErrChanged
	}
	return nil
}

func ensureExactJSON(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(raw) > 32<<20 {
		return ErrLimit
	}
	if existing, err := readRegular(path, 32<<20); err == nil {
		if !bytes.Equal(raw, existing) {
			return ErrConflict
		}
		return durablefs.SyncParent(path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeExclusive(path, raw)
}

func writeExclusive(path string, raw []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".pending-")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	_, writeErr := file.Write(raw)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	// Linking installs a fully synced immutable file without replacing a prior
	// operation's record. A crash cannot expose partially written JSON.
	if err := os.Link(temporary, path); err != nil {
		return err
	}
	return durablefs.SyncParent(path)
}

// Flush only this explicitly owned attempt. Symlinks are directory entries,
// never followed to a source checkout or an external destination.
func syncTree(root string) error {
	var directories []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			directories = append(directories, path)
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if !entry.Type().IsRegular() {
			return ErrChanged
		}
		return syncOwnedFile(path)
	})
	if err != nil {
		return err
	}
	for index := len(directories) - 1; index >= 0; index-- {
		if err := durablefs.SyncDirectory(directories[index]); err != nil {
			return err
		}
	}
	return durablefs.SyncParent(root)
}
