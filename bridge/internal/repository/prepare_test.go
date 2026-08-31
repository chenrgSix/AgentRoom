package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	execution "convenewire.dev/contracts/generated/go/execution"
)

type fixture struct {
	root, sourcePath, state, executable, base string
	source                                    Source
	preparer                                  *Preparer
}

func gitFixture(t *testing.T, format string, limits Limits) *fixture {
	t.Helper()
	executable, err := exec.LookPath("git")
	if err != nil {
		t.Fatal("real Git is required", err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{root: root, sourcePath: filepath.Join(root, "source"), state: filepath.Join(root, "owner-state"), executable: executable}
	for _, path := range []string{f.sourcePath, f.state} {
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	f.git(t, f.sourcePath, "init", "--template=", "--object-format="+format, "-b", "main", ".")
	f.write(t, "src/app.txt", "base\n")
	f.write(t, ".gitignore", "build/\n")
	f.git(t, f.sourcePath, "add", "--all")
	f.git(t, f.sourcePath, "commit", "-m", "approved base")
	f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
	f.source, err = InspectSource(context.Background(), executable, f.sourcePath, []string{root}, limits)
	if err != nil {
		t.Fatal(err)
	}
	f.preparer, err = NewPreparer(f.state, executable, limits)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if f.preparer != nil {
			if err := f.preparer.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	return f
}

func (f *fixture) git(t *testing.T, directory string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, f.executable, append([]string{"-c", "core.hooksPath=" + os.DevNull}, args...)...)
	command.Dir = directory
	command.Env = gitEnvironment()
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture Git %v: %v: %s", args, err, output)
	}
	return strings.TrimSuffix(string(output), "\n")
}

func (f *fixture) write(t *testing.T, name, value string) {
	t.Helper()
	path := filepath.Join(f.sourcePath, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
		t.Fatal(err)
	}
}

func request(base, suffix string) Preparation {
	return Preparation{OperationID: "operation_" + suffix, RunID: "run_" + suffix, RepositoryID: "repository_fixture",
		BindingID: "binding_fixture", WorkspaceRef: "workspace_" + suffix, Generation: strings.Repeat("a", 64),
		ManifestDigest: strings.Repeat("b", 64), BaseCommit: base,
		ScopePolicy: execution.ManifestScopePolicy{Access: execution.IsolatedWrite, AllowedPaths: []string{"."}, ForbiddenPaths: []string{}}}
}

func patch(old, next, id string) PatchInput {
	data := []byte("diff --git a/src/app.txt b/src/app.txt\n--- a/src/app.txt\n+++ b/src/app.txt\n@@ -1 +1 @@\n-" + old + "\n+" + next + "\n")
	hash := sha256.Sum256(data)
	return PatchInput{BindingID: "input_" + id, SHA256: hex.EncodeToString(hash[:]), Bytes: data}
}

func mustPrepare(t *testing.T, f *fixture, r Preparation) PreparedWorkspace {
	t.Helper()
	prepared, err := f.preparer.Prepare(context.Background(), f.source, r)
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func TestPreparePinsBaseWithoutTouchingSource(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			f := gitFixture(t, format, Limits{})
			parent := f.base
			f.write(t, "approved.txt", "second approved commit\n")
			f.git(t, f.sourcePath, "add", "--all")
			f.git(t, f.sourcePath, "commit", "-m", "approved with parent")
			approved := f.git(t, f.sourcePath, "rev-parse", "HEAD")
			f.write(t, "src/app.txt", "later commit\n")
			f.git(t, f.sourcePath, "add", "--all")
			f.git(t, f.sourcePath, "commit", "-m", "not approved")
			f.write(t, "src/app.txt", "owner uncommitted\n")
			f.write(t, "untracked.txt", "owner data")
			before := f.git(t, f.sourcePath, "status", "--porcelain=v1")
			refs := f.git(t, f.sourcePath, "show-ref")
			worktrees := f.git(t, f.sourcePath, "worktree", "list", "--porcelain")
			prepared := mustPrepare(t, f, request(approved, "pinned_base"))
			if prepared.PreparedCommit != approved || prepared.PreparedTree != f.git(t, f.sourcePath, "rev-parse", approved+"^{tree}") {
				t.Fatal("base drift")
			}
			bytes, err := os.ReadFile(filepath.Join(prepared.Path, "src/app.txt"))
			if err != nil || string(bytes) != "base\n" {
				t.Fatal(string(bytes), err)
			}
			if f.git(t, f.sourcePath, "status", "--porcelain=v1") != before || f.git(t, f.sourcePath, "show-ref") != refs ||
				f.git(t, f.sourcePath, "worktree", "list", "--porcelain") != worktrees {
				t.Fatal("source was mutated")
			}
			if f.git(t, prepared.Path, "rev-list", "--count", "HEAD") != "1" {
				t.Fatal("history was imported")
			}
			if _, err := f.preparer.git.run(context.Background(), prepared.Path, nil, 1024, "cat-file", "-e", parent); err == nil {
				t.Fatal("unselected parent object was imported")
			}
			if f.git(t, prepared.Path, "remote") != "" {
				t.Fatal("source remotes were inherited")
			}
		})
	}
}

func TestPrepareOrderedPinnedPatchesAndIndependentGitStores(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "ordered_inputs")
	r.Inputs = []PatchInput{patch("base", "first", "first_pin"), patch("first", "second", "second_pin")}
	first := mustPrepare(t, f, r)
	if first.PreparedCommit == f.base {
		t.Fatal("inputs did not produce a candidate")
	}
	if got := f.git(t, first.Path, "show", "HEAD:src/app.txt"); got != "second" {
		t.Fatal(got)
	}
	second := mustPrepare(t, f, request(f.base, "separate_writer"))
	if first.Path == second.Path || first.GitDirectory == second.GitDirectory {
		t.Fatal("shared writable Git state")
	}
	if err := os.WriteFile(filepath.Join(first.Path, "src/app.txt"), []byte("writer one"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := f.git(t, second.Path, "show", "HEAD:src/app.txt"); got != "base" {
		t.Fatal(got)
	}
	if got := f.git(t, f.sourcePath, "show", "HEAD:src/app.txt"); got != "base" {
		t.Fatal(got)
	}
	if _, err := f.preparer.Prepare(context.Background(), f.source, r); !errors.Is(err, ErrChanged) {
		t.Fatal("dirty replay", err)
	}
}

func TestPrepareExactReplayAfterReopenAndLostResponse(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "response_loss")
	r.Inputs = []PatchInput{patch("base", "prepared", "exact_pin")}
	first := mustPrepare(t, f, r)
	readyPath := f.preparer.claimPath("ready", r.WorkspaceRef)
	if err := os.Rename(readyPath, readyPath+".lost-fixture"); err != nil {
		t.Fatal(err)
	}
	if err := f.preparer.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	again := mustPrepare(t, f, r)
	if !reflect.DeepEqual(first, again) {
		t.Fatal("lost receipt recreated a different workspace", first, again)
	}
	if exact := mustPrepare(t, f, r); !reflect.DeepEqual(exact, again) {
		t.Fatal("replay changed receipt")
	}
}

func TestPrepareRecoversSealedCandidateBeforeCheckout(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "before_checkout")
	intent, err := f.preparer.intent(f.source, r)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.createCandidate(context.Background(), intent, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.preparer.Close(); err != nil {
		t.Fatal(err)
	}
	f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	prepared := mustPrepare(t, f, r)
	if prepared.PreparedCommit != f.base {
		t.Fatal("incorrect recovered candidate")
	}
}

func TestPrepareConflictingOperationRunOrWorkspaceClaims(t *testing.T) {
	for _, field := range []string{"operation", "run", "workspace", "manifest", "generation", "inputs"} {
		t.Run(field, func(t *testing.T) {
			f := gitFixture(t, "sha1", Limits{})
			original := request(f.base, "claim_original")
			mustPrepare(t, f, original)
			changed := request(f.base, "claim_changed")
			switch field {
			case "operation":
				changed.OperationID = original.OperationID
			case "run":
				changed.RunID = original.RunID
			case "workspace":
				changed.WorkspaceRef = original.WorkspaceRef
			case "manifest":
				changed = original
				changed.ManifestDigest = strings.Repeat("c", 64)
			case "generation":
				changed = original
				changed.Generation = strings.Repeat("c", 64)
			case "inputs":
				changed = original
				changed.Inputs = []PatchInput{patch("base", "other", "other_pin")}
			}
			if _, err := f.preparer.Prepare(context.Background(), f.source, changed); !errors.Is(err, ErrConflict) {
				t.Fatal(err)
			}
		})
	}
}

func TestPrepareRejectsForgedPatchBeforeClaiming(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "forged_input")
	input := patch("base", "changed", "forged_pin")
	input.Bytes = append(input.Bytes, '!')
	r.Inputs = []PatchInput{input}
	if _, err := f.preparer.Prepare(context.Background(), f.source, r); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	claims, err := os.ReadDir(filepath.Join(f.state, "claims"))
	if err != nil || len(claims) != 0 {
		t.Fatal("invalid input claimed state", err)
	}
}

func TestPrepareConflictingInputsRetainIncompleteAttempt(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "conflicting_inputs")
	r.Inputs = []PatchInput{patch("not the base", "changed", "conflict_pin")}
	if _, err := f.preparer.Prepare(context.Background(), f.source, r); err == nil {
		t.Fatal("conflicting patch accepted")
	}
	if _, err := f.preparer.Prepare(context.Background(), f.source, r); !errors.Is(err, ErrIncomplete) {
		t.Fatal("partial mutation blindly repeated", err)
	}
	if f.git(t, f.sourcePath, "status", "--porcelain=v1") != "" {
		t.Fatal("conflict mutated source")
	}
}

func TestPrepareRejectsChangedWorkspaceAndGitMetadata(t *testing.T) {
	for _, change := range []string{"ignored", "tracked", "untracked", "branch", "config", "missing", "replaced"} {
		t.Run(change, func(t *testing.T) {
			f := gitFixture(t, "sha1", Limits{})
			r := request(f.base, "workspace_change")
			prepared := mustPrepare(t, f, r)
			switch change {
			case "ignored":
				if err := os.Mkdir(filepath.Join(prepared.Path, "build"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(prepared.Path, "build", "owner.txt"), []byte("keep"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "tracked":
				if err := os.WriteFile(filepath.Join(prepared.Path, "src/app.txt"), []byte("keep"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "untracked":
				if err := os.WriteFile(filepath.Join(prepared.Path, "keep.txt"), []byte("keep"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "branch":
				f.git(t, prepared.Path, "checkout", "-b", "owner-branch")
			case "config":
				f.git(t, prepared.Path, "config", "core.fsmonitor", "foreign-command")
			case "missing":
				if err := os.Rename(prepared.Path, prepared.Path+"-retained"); err != nil {
					t.Fatal(err)
				}
			case "replaced":
				if err := os.Rename(prepared.Path, prepared.Path+"-retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(prepared.Path, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.preparer.Prepare(context.Background(), f.source, r); !errors.Is(err, ErrChanged) {
				t.Fatal(change, err)
			}
		})
	}
}

func TestPrepareBoundedSnapshotIncludingRepeatedBlobs(t *testing.T) {
	for _, limit := range []string{"bytes", "entries", "repeated"} {
		t.Run(limit, func(t *testing.T) {
			f := gitFixture(t, "sha1", Limits{})
			switch limit {
			case "bytes":
				f.preparer.git.limits.SnapshotBytes = 10
			case "entries":
				f.preparer.git.limits.Entries = 1
			case "repeated":
				for _, name := range []string{"large1", "large2", "large3"} {
					f.write(t, name, strings.Repeat("x", 2000))
				}
				f.git(t, f.sourcePath, "add", "--all")
				f.git(t, f.sourcePath, "commit", "-m", "repeated blob")
				f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
				f.preparer.git.limits.SnapshotBytes = 5000
			}
			if _, err := f.preparer.Prepare(context.Background(), f.source, request(f.base, "resource_limit")); !errors.Is(err, ErrLimit) {
				t.Fatal(err)
			}
		})
	}
}

func TestPrepareConcurrentReplayAndOwnerExclusion(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "concurrent_run")
	if other, err := NewPreparer(f.state, f.executable, Limits{}); err == nil {
		other.Close()
		t.Fatal("two preparation owners")
	}
	var wait sync.WaitGroup
	results := make(chan PreparedWorkspace, 8)
	failures := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, err := f.preparer.Prepare(context.Background(), f.source, r)
			results <- result
			failures <- err
		}()
	}
	wait.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first PreparedWorkspace
	for result := range results {
		if first.Path == "" {
			first = result
		}
		if result != first {
			t.Fatal("concurrent preparation duplicated work")
		}
	}
}

func TestSourceSelectionAndReplacement(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	if _, err := InspectSource(context.Background(), f.executable, filepath.Join(f.sourcePath, "src"), []string{f.root}, Limits{}); !errors.Is(err, ErrInvalid) {
		t.Fatal("subdirectory selected", err)
	}
	if _, err := InspectSource(context.Background(), f.executable, f.sourcePath, []string{f.state}, Limits{}); !errors.Is(err, ErrInvalid) {
		t.Fatal("outside allowed roots", err)
	}
	if err := os.Rename(f.sourcePath, f.sourcePath+"-original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(f.sourcePath, 0o700); err != nil {
		t.Fatal(err)
	}
	f.git(t, f.sourcePath, "init", "--template=", ".")
	if _, err := f.preparer.Prepare(context.Background(), f.source, request(f.base, "rebound_source")); !errors.Is(err, ErrChanged) {
		t.Fatal("silently rebound source", err)
	}
}

func TestPrepareRejectsExpressionsAndCancellation(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	for _, base := range []string{"HEAD", f.base[:12], "--help", f.base + "^{tree}", strings.ToUpper(f.base)} {
		if _, err := f.preparer.Prepare(context.Background(), f.source, request(base, "invalid_base")); !errors.Is(err, ErrInvalid) {
			t.Fatal(base, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.preparer.Prepare(ctx, f.source, request(f.base, "cancelled_run")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestPortablePaths(t *testing.T) {
	for _, path := range []string{".git/config", "a/.GIT/hooks/x", "../escape", "/absolute", "a//b", "C:stream", "a\\b", "a\nb", "NUL.txt", "dir/COM1", "trailing.", "trailing ", "git~1/config"} {
		if portablePath(path) {
			t.Fatal("unsafe path accepted", path)
		}
	}
	for _, path := range []string{"src/app.ts", ".gitignore", ".gitattributes", ".gitmodules", "文档/说明.md"} {
		if !portablePath(path) {
			t.Fatal("valid path rejected", path)
		}
	}
}
