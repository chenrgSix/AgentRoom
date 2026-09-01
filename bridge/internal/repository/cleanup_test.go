package repository

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type cleanupAuthorityFunc func(context.Context, CleanupScope, func() error) error

func (f cleanupAuthorityFunc) WithCleanupAuthority(ctx context.Context, scope CleanupScope, action func() error) error {
	return f(ctx, scope, action)
}

// This is explicit fixture authority. It does not claim a production Run/grant
// adapter exists, and is never exposed over the Bridge API or Runtime tools.
var stoppedCleanupFixture = cleanupAuthorityFunc(func(_ context.Context, _ CleanupScope, action func() error) error { return action() })

func cleanupSelection(t *testing.T, seed resumeSeed) (CleanupPreview, CleanupRequest) {
	t.Helper()
	preview, err := seed.f.preparer.PreviewCleanup(context.Background(), "op_cleanup_fixture0001", seed.checkpoint, stoppedCleanupFixture)
	if err != nil {
		t.Fatal(err)
	}
	return preview, CleanupRequest{OperationID: preview.OperationID, Checkpoint: seed.checkpoint, ExpectedPreviewDigest: preview.Digest}
}

func TestCleanupExactCapturedWorktreeAndBranch(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			seed := seedResume(t, format, true)
			f := seed.f
			scratch := filepath.Join(f.preparer.attemptPath(seed.ready.WorkspaceRef), "scratch", "diagnostic.txt")
			if err := os.WriteFile(scratch, []byte("retained diagnostics"), 0o600); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadDir(filepath.Join(f.state, "claims"))
			if err != nil {
				t.Fatal(err)
			}
			preview, request := cleanupSelection(t, seed)
			after, err := os.ReadDir(filepath.Join(f.state, "claims"))
			if err != nil || len(before) != len(after) {
				t.Fatal("preview mutated journal", err)
			}
			if preview.Path != seed.ready.Path || preview.Branch != seed.ready.Branch || len(preview.RetainedPaths) != 3 || !validCleanupPreview(preview) {
				t.Fatal("wrong preview")
			}
			if f.git(t, seed.ready.Path, "status", "--porcelain=v1") == "" {
				t.Fatal("fixture must have captured uncommitted changes")
			}
			receipt, err := f.preparer.CleanupWorkspace(context.Background(), request, stoppedCleanupFixture)
			if err != nil {
				t.Fatal(err)
			}
			if !cleanupReceiptMatches(receipt, preview) {
				t.Fatal("invalid audit tombstone")
			}
			if _, err := os.Lstat(seed.ready.Path); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("worktree not retired", err)
			}
			if f.git(t, seed.ready.GitDirectory, "for-each-ref") != "" {
				t.Fatal("owned branch not deleted")
			}
			if strings.Contains(f.git(t, seed.ready.GitDirectory, "worktree", "list", "--porcelain"), seed.ready.Path) {
				t.Fatal("Git still registers removed worktree")
			}
			if value, err := os.ReadFile(scratch); err != nil || string(value) != "retained diagnostics" {
				t.Fatal("scratch was swept", err)
			}
			patch, err := f.preparer.ReadCapturedPatch(context.Background(), seed.captured.OperationID, seed.captured.Digest)
			if err != nil || len(patch) == 0 {
				t.Fatal("checkpoint bytes lost", err)
			}
			if f.git(t, f.sourcePath, "rev-parse", "HEAD") != f.base || f.git(t, f.sourcePath, "status", "--porcelain=v1") != "" {
				t.Fatal("source changed")
			}
			if err := f.preparer.Close(); err != nil {
				t.Fatal(err)
			}
			f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			replayed, err := f.preparer.CleanupWorkspace(context.Background(), request, stoppedCleanupFixture)
			if err != nil || !reflect.DeepEqual(receipt, replayed) {
				t.Fatal("cleanup response loss was not idempotent", err)
			}
			if _, err := f.preparer.Prepare(context.Background(), f.source, Preparation{WorkspaceRef: preview.WorkspaceRef}); !errors.Is(err, ErrWorkspaceRetired) {
				t.Fatal("retired workspace admitted preparation", err)
			}
			// A historical receipt never authorizes deletion of a recreated path.
			writeWork(t, seed.ready, "owner-new.txt", "new owner data")
			replayed, err = f.preparer.CleanupWorkspace(context.Background(), request, stoppedCleanupFixture)
			if err != nil || !reflect.DeepEqual(receipt, replayed) {
				t.Fatal("read-only replay", err)
			}
			if value, err := os.ReadFile(filepath.Join(seed.ready.Path, "owner-new.txt")); err != nil || string(value) != "new owner data" {
				t.Fatal("replay deleted replacement", err)
			}
			// Cleanup does not destroy the ability to explicitly resume the code.
			next, inputs := nextResumeManifest(t, seed.manifest, seed.inputs, "aftercleanup0001")
			ready, err := f.preparer.PrepareFromCheckpoint(context.Background(), f.source, resumeOperation(t, next, seed.checkpoint), seed.checkpoint, inputs)
			if err != nil || ready.PreparedTree != seed.captured.CandidateTree {
				t.Fatal("checkpoint could not resume after retirement", err)
			}
		})
	}
}

func TestCleanupRejectsUncollectedAndForeignState(t *testing.T) {
	for _, change := range []string{"tracked", "untracked", "ignored", "deleted", "staged", "head", "branch", "other ref", "other worktree", "replaced directory", "config", "unconfirmed", "corrupt patch"} {
		t.Run(change, func(t *testing.T) {
			seed := seedResume(t, "sha1", false)
			f := seed.f
			_, request := cleanupSelection(t, seed)
			switch change {
			case "tracked":
				writeWork(t, seed.ready, "src/app.txt", "not collected")
			case "untracked":
				writeWork(t, seed.ready, "tests/new.txt", "not collected")
			case "ignored":
				writeWork(t, seed.ready, "build/ignored.txt", "not collected")
			case "deleted":
				if err := os.Remove(filepath.Join(seed.ready.Path, "tests/first.txt")); err != nil {
					t.Fatal(err)
				}
			case "staged":
				f.git(t, seed.ready.Path, "add", "--all")
			case "head":
				f.git(t, seed.ready.Path, "add", "--all")
				f.git(t, seed.ready.Path, "commit", "-m", "later uncollected commit")
			case "branch":
				f.git(t, seed.ready.Path, "checkout", "-b", "owner-branch")
			case "other ref":
				f.git(t, seed.ready.GitDirectory, "update-ref", "refs/heads/owner-branch", seed.ready.PreparedCommit)
			case "other worktree":
				f.git(t, seed.ready.GitDirectory, "worktree", "add", "-b", "owner-other", filepath.Join(f.root, "owner-other"), seed.ready.PreparedCommit)
			case "replaced directory":
				if err := os.Rename(seed.ready.Path, seed.ready.Path+"-retained"); err != nil {
					t.Fatal(err)
				}
				writeWork(t, seed.ready, "owner.txt", "foreign replacement")
			case "config":
				f.git(t, seed.ready.GitDirectory, "config", "core.abbrev", "8")
			case "unconfirmed":
				if err := os.Remove(f.preparer.claimPath("checkpoint", seed.checkpoint.OperationID)); err != nil {
					t.Fatal(err)
				}
			case "corrupt patch":
				if err := os.WriteFile(filepath.Join(f.preparer.capturePath(seed.captured.OperationID), "output.patch"), []byte("corrupt"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := f.preparer.PreviewCleanup(context.Background(), "op_cleanup_new_preview", seed.checkpoint, stoppedCleanupFixture); err == nil {
				t.Fatal("preview accepted changed state")
			}
			if _, err := f.preparer.CleanupWorkspace(context.Background(), request, stoppedCleanupFixture); err == nil {
				t.Fatal("stale confirmation deleted changed state")
			}
			if _, err := os.Lstat(seed.ready.Path); err != nil {
				t.Fatal("worktree removed", err)
			}
			if _, err := os.Stat(f.preparer.claimPath("cleanup", request.OperationID)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("false tombstone", err)
			}
		})
	}
}

func TestCleanupAuthorityAndExactConfirmation(t *testing.T) {
	seed := seedResume(t, "sha1", false)
	preview, request := cleanupSelection(t, seed)
	for _, reason := range []string{"active", "outcome unknown", "grant revoked", "grant expired", "foreign owner"} {
		t.Run(reason, func(t *testing.T) {
			denied := errors.New(reason)
			guard := cleanupAuthorityFunc(func(_ context.Context, scope CleanupScope, _ func() error) error {
				if scope.RunID != seed.manifest.Scope.RunID || scope.WorkspaceRef != preview.WorkspaceRef || scope.CheckpointDigest != seed.checkpoint.Digest ||
					scope.AgentID != seed.manifest.Scope.AgentID || scope.DeviceID != seed.manifest.Scope.DeviceID || scope.ManifestDigest != seed.manifest.ManifestDigest {
					t.Fatal("incorrect fence scope")
				}
				return denied
			})
			if _, err := seed.f.preparer.PreviewCleanup(context.Background(), request.OperationID, seed.checkpoint, guard); !errors.Is(err, denied) {
				t.Fatal(err)
			}
			if _, err := seed.f.preparer.CleanupWorkspace(context.Background(), request, guard); !errors.Is(err, denied) {
				t.Fatal(err)
			}
		})
	}
	if _, err := seed.f.preparer.CleanupWorkspace(context.Background(), request, nil); !errors.Is(err, ErrInvalid) {
		t.Fatal("nil authority", err)
	}
	changed := request
	changed.ExpectedPreviewDigest = strings.Repeat("e", 64)
	if _, err := seed.f.preparer.CleanupWorkspace(context.Background(), changed, stoppedCleanupFixture); !errors.Is(err, ErrConflict) {
		t.Fatal("wrong preview accepted", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := seed.f.preparer.CleanupWorkspace(ctx, request, stoppedCleanupFixture); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := os.Stat(seed.f.preparer.claimPath("operation", request.OperationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("denied cleanup wrote intent", err)
	}
	if _, err := os.Stat(seed.ready.Path); err != nil {
		t.Fatal("denied cleanup removed work", err)
	}
}

func TestInspectCleanupScopeUsesRetainedCheckpointHistoryWithoutMutation(t *testing.T) {
	seed := seedResume(t, "sha1", false)
	operationID := "op_cleanup_inspect0001"
	scope, err := seed.f.preparer.InspectCleanupScope(context.Background(), operationID, seed.checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	manifest := seed.manifest
	if scope.OperationID != operationID || scope.CheckpointID != seed.checkpoint.CheckpointID ||
		scope.CheckpointDigest != seed.checkpoint.Digest || scope.RepositoryID != manifest.Repository.RepositoryID ||
		scope.BindingID != manifest.Repository.BindingID || scope.RunID != manifest.Scope.RunID ||
		scope.AgentID != manifest.Scope.AgentID || scope.DeviceID != manifest.Scope.DeviceID ||
		scope.WorkspaceRef != manifest.Workspace.WorkspaceRef ||
		scope.Generation != manifest.Workspace.WorkspaceGeneration || scope.ManifestDigest != manifest.ManifestDigest ||
		scope.PlanID != manifest.Scope.PlanID || scope.PlanRevision != manifest.Scope.PlanRevision ||
		scope.NodeKey != manifest.Scope.NodeKey || scope.TaskID != manifest.Scope.TaskID {
		t.Fatalf("scope=%+v", scope)
	}
	if _, err := os.Stat(seed.f.preparer.claimPath("operation", operationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("scope inspection wrote an operation: %v", err)
	}
	changed := seed.checkpoint
	changed.Digest = strings.Repeat("f", 64)
	if _, err := seed.f.preparer.InspectCleanupScope(context.Background(), operationID, changed); err == nil {
		t.Fatal("changed checkpoint was accepted")
	}
}

func TestCleanupReconcilesCompletedGitStepsAfterRestart(t *testing.T) {
	for _, cut := range []string{"intent", "worktree removed", "branch removed", "partially removed", "moved branch"} {
		t.Run(cut, func(t *testing.T) {
			seed := seedResume(t, "sha1", false)
			f := seed.f
			preview, request := cleanupSelection(t, seed)
			intent := cleanupIntent{Kind: "cleanup", Version: 1, RequestDigest: digest(request), Preview: preview}
			if err := ensureExactJSON(f.preparer.claimPath("operation", request.OperationID), intent); err != nil {
				t.Fatal(err)
			}
			if err := ensureExactJSON(f.preparer.claimPath("cleanup-workspace", preview.WorkspaceRef), cleanupStep{request.OperationID, preview.Digest, "claimed"}); err != nil {
				t.Fatal(err)
			}
			if cut == "worktree removed" || cut == "branch removed" || cut == "moved branch" {
				f.git(t, preview.GitDirectory, "worktree", "remove", "--force", "--", preview.Path)
			}
			if cut == "branch removed" {
				f.git(t, preview.GitDirectory, "update-ref", "-d", preview.Branch, preview.ExpectedHead)
			}
			if cut == "partially removed" {
				if err := os.Remove(filepath.Join(preview.Path, "tests/first.txt")); err != nil {
					t.Fatal(err)
				}
			}
			if cut == "moved branch" {
				moved := f.git(t, preview.GitDirectory, "commit-tree", seed.ready.PreparedTree, "-p", preview.ExpectedHead, "-m", "Owner moved target")
				f.git(t, preview.GitDirectory, "update-ref", preview.Branch, moved, preview.ExpectedHead)
			}
			if err := f.preparer.Close(); err != nil {
				t.Fatal(err)
			}
			var err error
			f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
			if err != nil {
				t.Fatal(err)
			}
			receipt, err := f.preparer.CleanupWorkspace(context.Background(), request, stoppedCleanupFixture)
			if cut == "partially removed" || cut == "moved branch" {
				if !errors.Is(err, ErrCleanupUnknown) {
					t.Fatal("ambiguous removal was retried", err)
				}
				if _, err := os.Stat(f.preparer.claimPath("cleanup", request.OperationID)); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("unknown cleanup marked complete", err)
				}
				if cut == "partially removed" {
					if _, err := os.Stat(preview.Path); err != nil {
						t.Fatal("partial directory deleted", err)
					}
				}
				return
			}
			if err != nil || !cleanupReceiptMatches(receipt, preview) {
				t.Fatal("known completed effect not reconciled", err)
			}
		})
	}
}

func TestCleanupWriterProcess(t *testing.T) {
	if os.Getenv("CONVENE_WIRE_CLEANUP_WRITER_PROCESS") != "1" {
		t.Skip("cleanup guard process fixture")
	}
	fmt.Println("writer-ready")
	if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupFenceWaitsForActualProcessExit(t *testing.T) {
	seed := seedResume(t, "sha1", false)
	_, request := cleanupSelection(t, seed)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCleanupWriterProcess$")
	child.Env = append(os.Environ(), "CONVENE_WIRE_CLEANUP_WRITER_PROCESS=1")
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	var waitErr error
	go func() { waitErr = child.Wait(); close(exited) }()
	t.Cleanup(func() {
		input.Close()
		select {
		case <-exited:
		default:
			child.Process.Kill()
			<-exited
		}
	})
	if line, err := bufio.NewReader(output).ReadString('\n'); err != nil || line != "writer-ready\n" {
		t.Fatal("child not ready", line, err)
	}
	live := errors.New("fixture writer is still live")
	guard := cleanupAuthorityFunc(func(_ context.Context, _ CleanupScope, action func() error) error {
		select {
		case <-exited:
			if waitErr != nil {
				return ErrCleanupUnknown
			}
			return action()
		default:
			return live
		}
	})
	if _, err := seed.f.preparer.CleanupWorkspace(context.Background(), request, guard); !errors.Is(err, live) {
		t.Fatal("live process cleanup admitted", err)
	}
	if _, err := os.Stat(seed.ready.Path); err != nil {
		t.Fatal("live worktree lost", err)
	}
	if err := input.Close(); err != nil {
		t.Fatal(err)
	}
	<-exited
	if waitErr != nil {
		t.Fatal(waitErr)
	}
	if _, err := seed.f.preparer.CleanupWorkspace(context.Background(), request, guard); err != nil {
		t.Fatal("terminal process cleanup rejected", err)
	}
}

func TestCleanupAuthorityCannotSwallowActionFailure(t *testing.T) {
	denied := errors.New("action failed")
	guard := cleanupAuthorityFunc(func(_ context.Context, _ CleanupScope, action func() error) error { _ = action(); return nil })
	if err := underCleanupAuthority(context.Background(), guard, CleanupScope{}, func() error { return denied }); !errors.Is(err, denied) {
		t.Fatal(err)
	}
	missing := cleanupAuthorityFunc(func(_ context.Context, _ CleanupScope, _ func() error) error { return nil })
	if err := underCleanupAuthority(context.Background(), missing, CleanupScope{}, func() error { t.Fatal("unexpected action"); return nil }); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	calls := 0
	repeated := cleanupAuthorityFunc(func(_ context.Context, _ CleanupScope, action func() error) error {
		_ = action()
		_ = action()
		return nil
	})
	if err := underCleanupAuthority(context.Background(), repeated, CleanupScope{}, func() error { calls++; return nil }); !errors.Is(err, ErrInvalid) || calls != 1 {
		t.Fatal("repeated callback executed the action again or hid its failure", calls, err)
	}
	var late func() error
	deferred := cleanupAuthorityFunc(func(_ context.Context, _ CleanupScope, action func() error) error { late = action; return nil })
	if err := underCleanupAuthority(context.Background(), deferred, CleanupScope{}, func() error { t.Fatal("late action escaped its authority lifetime"); return nil }); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if err := late(); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
}

func TestCleanupRejectsChangedJournalBeforeDeletion(t *testing.T) {
	for _, change := range []string{"operation", "preview", "step", "foreign cleanup"} {
		t.Run(change, func(t *testing.T) {
			seed := seedResume(t, "sha1", false)
			preview, request := cleanupSelection(t, seed)
			intent := cleanupIntent{Kind: "cleanup", Version: 1, RequestDigest: digest(request), Preview: preview}
			switch change {
			case "operation":
				intent.RequestDigest = strings.Repeat("e", 64)
			case "preview":
				intent.Preview.Path = seed.f.sourcePath
			case "step":
				if err := ensureExactJSON(seed.f.preparer.claimPath("cleanup-detached", request.OperationID), cleanupStep{request.OperationID, strings.Repeat("e", 64), "detached"}); err != nil {
					t.Fatal(err)
				}
			case "foreign cleanup":
				if err := ensureExactJSON(seed.f.preparer.claimPath("cleanup-workspace", preview.WorkspaceRef), cleanupStep{"op_foreign_cleanup0001", preview.Digest, "claimed"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := ensureExactJSON(seed.f.preparer.claimPath("operation", request.OperationID), intent); err != nil {
				t.Fatal(err)
			}
			if _, err := seed.f.preparer.CleanupWorkspace(context.Background(), request, stoppedCleanupFixture); err == nil {
				t.Fatal("changed journal admitted deletion")
			}
			if _, err := os.Stat(seed.ready.Path); err != nil {
				t.Fatal("worktree deleted", err)
			}
		})
	}
}
