package repository

import (
	"bytes"
	"context"
	"errors"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	execution "convenewire.dev/contracts/generated/go/execution"
)

func captureRequest(ready PreparedWorkspace, suffix string) CaptureRequest {
	return CaptureRequest{OperationID: "capture_operation_" + suffix, WorkspaceRef: ready.WorkspaceRef, PreparedDigest: ready.IntentDigest,
		ExpectedGeneration: ready.Generation, ManifestDigest: strings.Repeat("b", 64)}
}

func writeWork(t *testing.T, ready PreparedWorkspace, path, content string) {
	t.Helper()
	target := filepath.Join(ready.Path, path)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustCapture(t *testing.T, f *fixture, request CaptureRequest) CapturedRepository {
	t.Helper()
	result, err := f.preparer.Capture(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestCaptureActualFilesIntoIndependentCandidate(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			f := gitFixture(t, format, Limits{})
			r := request(f.base, "capture_files")
			r.ScopePolicy.AllowedPaths = []string{"src"}
			ready := mustPrepare(t, f, r)
			writeWork(t, ready, "src/app.txt", "implemented\n")
			writeWork(t, ready, "src/new.txt", "new untracked content\n")
			beforeHead := f.git(t, ready.Path, "rev-parse", "HEAD")
			beforeIndex, err := os.ReadFile(filepath.Join(ready.GitDirectory, "worktrees", "work", "index"))
			if err != nil {
				t.Fatal(err)
			}
			result := mustCapture(t, f, captureRequest(ready, "actual_files"))
			if len(result.Changes) != 2 || result.BaseCommit != f.base || result.ObservedHead != beforeHead {
				t.Fatal("incorrect output inventory", result)
			}
			if f.git(t, ready.Path, "rev-parse", "HEAD") != beforeHead {
				t.Fatal("capture changed Agent branch")
			}
			afterIndex, err := os.ReadFile(filepath.Join(ready.GitDirectory, "worktrees", "work", "index"))
			if err != nil || !bytes.Equal(beforeIndex, afterIndex) {
				t.Fatal("capture mutated Agent index", err)
			}
			patch, err := f.preparer.ReadCapturedPatch(context.Background(), result.OperationID, result.Digest)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Contains(patch, []byte("+implemented")) || !bytes.Contains(patch, []byte("+new untracked content")) {
				t.Fatal("incorrect patch", string(patch))
			}
			store := filepath.Join(f.preparer.capturePath(result.OperationID), "git")
			if f.git(t, store, "show", result.CandidateCommit+":src/app.txt") != "implemented" {
				t.Fatal("wrong candidate tree")
			}
			if f.git(t, f.sourcePath, "show", "HEAD:src/app.txt") != "base" {
				t.Fatal("source repository changed")
			}
		})
	}
}

func TestCaptureUsesPreparedInputAsScopeBaseline(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "input_scope_baseline")
	r.Inputs = []PatchInput{patch("base", "upstream", "upstream_change")}
	r.ScopePolicy.AllowedPaths = []string{"tests"}
	ready := mustPrepare(t, f, r)
	writeWork(t, ready, "tests/verify.txt", "downstream test\n")
	result := mustCapture(t, f, captureRequest(ready, "input_scope_baseline"))
	if len(result.Changes) != 1 || result.Changes[0].Path != "tests/verify.txt" {
		t.Fatal("upstream work was attributed to this node")
	}
	patch, err := f.preparer.ReadCapturedPatch(context.Background(), result.OperationID, result.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(patch, []byte("src/app.txt")) {
		t.Fatal("patch re-exported upstream work as own output")
	}
}

func TestCaptureForbiddenPathsWinIncludingRenameSource(t *testing.T) {
	for _, change := range []string{"forbidden", "rename", "prefix", "ignored", "delete"} {
		t.Run(change, func(t *testing.T) {
			f := gitFixture(t, "sha1", Limits{})
			r := request(f.base, "scope_gate")
			r.ScopePolicy.AllowedPaths = []string{"src"}
			r.ScopePolicy.ForbiddenPaths = []string{"src/app.txt"}
			// Keep one usable allowed child even though app.txt is explicitly forbidden.
			ready := mustPrepare(t, f, r)
			switch change {
			case "forbidden":
				writeWork(t, ready, "src/app.txt", "forbidden write")
			case "rename":
				if err := os.Rename(filepath.Join(ready.Path, "src/app.txt"), filepath.Join(ready.Path, "src/moved.txt")); err != nil {
					t.Fatal(err)
				}
			case "prefix":
				writeWork(t, ready, "src-other/sneak.txt", "prefix bypass")
			case "ignored":
				writeWork(t, ready, "build/hidden.txt", "ignored bypass")
			case "delete":
				if err := os.Remove(filepath.Join(ready.Path, "src/app.txt")); err != nil {
					t.Fatal(err)
				}
			}
			cr := captureRequest(ready, "scope_gate")
			if _, err := f.preparer.Capture(context.Background(), cr); !errors.Is(err, ErrScope) {
				t.Fatal(change, err)
			}
			if _, err := os.Stat(f.preparer.claimPath("capture", cr.OperationID)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("published out-of-scope observation", err)
			}
		})
	}
}

func TestCaptureReadsCommittedAndHiddenWorkingChanges(t *testing.T) {
	for _, flag := range []string{"committed", "--assume-unchanged", "--skip-worktree"} {
		t.Run(flag, func(t *testing.T) {
			f := gitFixture(t, "sha1", Limits{})
			ready := mustPrepare(t, f, request(f.base, "hidden_capture"))
			if flag != "committed" {
				f.git(t, ready.Path, "update-index", flag, "src/app.txt")
			}
			writeWork(t, ready, "src/app.txt", "actual content\n")
			if flag == "committed" {
				f.git(t, ready.Path, "add", "--all")
				f.git(t, ready.Path, "commit", "-m", "Agent commit")
			}
			if f.git(t, ready.Path, "status", "--porcelain=v1") != "" {
				t.Fatal("fixture must look clean to status")
			}
			result := mustCapture(t, f, captureRequest(ready, "hidden_capture"))
			if len(result.Changes) != 1 {
				t.Fatal("hidden output omitted")
			}
			patch, err := f.preparer.ReadCapturedPatch(context.Background(), result.OperationID, result.Digest)
			if err != nil || !bytes.Contains(patch, []byte("+actual content")) {
				t.Fatal("wrong content", err)
			}
		})
	}
}

func TestCaptureReadOnlyAndFrozenPolicy(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "readonly_capture")
	r.ScopePolicy = execution.ManifestScopePolicy{Access: execution.ReadOnly, AllowedPaths: []string{}, ForbiddenPaths: []string{}}
	ready := mustPrepare(t, f, r)
	r.ScopePolicy.Access = execution.IsolatedWrite
	r.ScopePolicy.AllowedPaths = []string{"."}
	writeWork(t, ready, "src/app.txt", "not authorized")
	if _, err := f.preparer.Capture(context.Background(), captureRequest(ready, "readonly_capture")); !errors.Is(err, ErrScope) {
		t.Fatal(err)
	}
}

func TestCaptureReplayAfterReopenDoesNotObserveLaterWrites(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	ready := mustPrepare(t, f, request(f.base, "replay_capture"))
	writeWork(t, ready, "src/app.txt", "first captured\n")
	cr := captureRequest(ready, "replay_capture")
	first := mustCapture(t, f, cr)
	writeWork(t, ready, "src/app.txt", "later uncollected\n")
	if err := f.preparer.Close(); err != nil {
		t.Fatal(err)
	}
	var err error
	f.preparer, err = NewPreparer(f.state, f.executable, Limits{})
	if err != nil {
		t.Fatal(err)
	}
	again := mustCapture(t, f, cr)
	if !reflect.DeepEqual(first, again) {
		t.Fatal("replay changed historical capture")
	}
	patch, err := f.preparer.ReadCapturedPatch(context.Background(), first.OperationID, first.Digest)
	if err != nil || !bytes.Contains(patch, []byte("+first captured")) || bytes.Contains(patch, []byte("later uncollected")) {
		t.Fatal(err)
	}
	if _, err := f.preparer.Capture(context.Background(), captureRequest(ready, "second_observation")); !errors.Is(err, ErrConflict) {
		t.Fatal("second capture replaced same generation", err)
	}
}

func TestCaptureRecoversLostFinalReceipt(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	ready := mustPrepare(t, f, request(f.base, "lost_capture_receipt"))
	writeWork(t, ready, "src/app.txt", "captured\n")
	cr := captureRequest(ready, "lost_capture_receipt")
	first := mustCapture(t, f, cr)
	path := f.preparer.claimPath("capture", cr.OperationID)
	if err := os.Rename(path, path+".lost-fixture"); err != nil {
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
	if again := mustCapture(t, f, cr); !reflect.DeepEqual(first, again) {
		t.Fatal("lost response recreated output")
	}
}

func TestCaptureRejectsSpecialOutputsAndMetadataChanges(t *testing.T) {
	for _, change := range []string{"config", "branch", "symlink", "grafts", "shallow"} {
		t.Run(change, func(t *testing.T) {
			if change == "symlink" && runtime.GOOS == "windows" {
				t.Skip("native symlink privilege gate")
			}
			f := gitFixture(t, "sha1", Limits{})
			ready := mustPrepare(t, f, request(f.base, "unsafe_capture"))
			want := ErrChanged
			switch change {
			case "config":
				f.git(t, ready.Path, "config", "filter.unsafe.clean", "arbitrary-command")
			case "branch":
				f.git(t, ready.Path, "checkout", "-b", "foreign-branch")
			case "grafts":
				if err := os.WriteFile(filepath.Join(ready.GitDirectory, "info", "grafts"), []byte(f.base+"\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "shallow":
				if err := os.WriteFile(filepath.Join(ready.GitDirectory, "shallow"), []byte(strings.Repeat("c", 40)+"\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(f.sourcePath, filepath.Join(ready.Path, "external")); err != nil {
					t.Fatal(err)
				}
				want = ErrSpecialOutput
			}
			if _, err := f.preparer.Capture(context.Background(), captureRequest(ready, "unsafe_capture")); !errors.Is(err, want) {
				t.Fatal(change, err)
			}
		})
	}
}

func TestCapturePatchCorruptionAndStaleIdentity(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	ready := mustPrepare(t, f, request(f.base, "corrupt_capture"))
	cr := captureRequest(ready, "corrupt_capture")
	result := mustCapture(t, f, cr)
	bad := cr
	bad.ExpectedGeneration = strings.Repeat("c", 64)
	if _, err := f.preparer.Capture(context.Background(), bad); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	bad = cr
	bad.OperationID = ready.OperationID
	if _, err := f.preparer.Capture(context.Background(), bad); !errors.Is(err, ErrConflict) {
		t.Fatal("reused prepare operation", err)
	}
	if err := os.WriteFile(filepath.Join(f.preparer.capturePath(cr.OperationID), "output.patch"), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.ReadCapturedPatch(context.Background(), cr.OperationID, result.Digest); !errors.Is(err, ErrChanged) {
		t.Fatal(err)
	}
	if _, err := f.preparer.Capture(context.Background(), cr); !errors.Is(err, ErrChanged) {
		t.Fatal("overwrote corrupted output", err)
	}
}

func TestCaptureLimitsAndCanceledContext(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	ready := mustPrepare(t, f, request(f.base, "capture_limit"))
	writeWork(t, ready, "src/large", strings.Repeat("x", 1024))
	f.preparer.git.limits.SnapshotBytes = 256
	if _, err := f.preparer.Capture(context.Background(), captureRequest(ready, "capture_limit")); !errors.Is(err, ErrLimit) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.preparer.Capture(ctx, captureRequest(ready, "capture_cancel")); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestCaptureBinaryModeAndDeletionPatchRoundTrip(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	f.write(t, "src/delete.txt", "delete me\n")
	f.git(t, f.sourcePath, "add", "--all")
	f.git(t, f.sourcePath, "commit", "-m", "deletion base")
	f.base = f.git(t, f.sourcePath, "rev-parse", "HEAD")
	ready := mustPrepare(t, f, request(f.base, "binary_capture"))
	data := make([]byte, 8192)
	rand.New(rand.NewSource(4)).Read(data)
	writeWork(t, ready, "src/binary.dat", string(data))
	if err := os.Remove(filepath.Join(ready.Path, "src/delete.txt")); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(filepath.Join(ready.Path, "src/app.txt"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	result := mustCapture(t, f, captureRequest(ready, "binary_capture"))
	patchBytes, err := f.preparer.ReadCapturedPatch(context.Background(), result.OperationID, result.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(patchBytes, []byte("GIT binary patch")) || !bytes.Contains(patchBytes, []byte("deleted file mode")) {
		t.Fatal("missing binary/deletion evidence")
	}
	retry := request(f.base, "patch_consumer")
	retry.Inputs = []PatchInput{{BindingID: "input_captured_patch", SHA256: result.PatchDigest, Bytes: patchBytes}}
	prepared := mustPrepare(t, f, retry)
	if prepared.PreparedTree != result.CandidateTree {
		t.Fatal("captured patch does not recreate exact tree")
	}
}

func TestCaptureRejectsGitlinkChangesAndUnresolvedIndex(t *testing.T) {
	for _, change := range []string{"gitlink_index", "gitlink_committed", "unresolved"} {
		t.Run(change, func(t *testing.T) {
			f := gitFixture(t, "sha1", Limits{})
			ready := mustPrepare(t, f, request(f.base, "index_capture"))
			want := ErrSpecialOutput
			if change == "unresolved" {
				object := f.git(t, ready.Path, "rev-parse", "HEAD:src/app.txt")
				input := "0 " + strings.Repeat("0", len(object)) + "\tsrc/app.txt\n100644 " + object + " 1\tsrc/app.txt\n"
				if _, err := f.preparer.git.run(context.Background(), ready.Path, strings.NewReader(input), 1024, "update-index", "--index-info"); err != nil {
					t.Fatal(err)
				}
				want = ErrChanged
			} else {
				f.git(t, ready.Path, "update-index", "--add", "--cacheinfo", "160000,"+f.base+",new-submodule")
				if change == "gitlink_committed" {
					f.git(t, ready.Path, "commit", "-m", "changed gitlink")
				}
			}
			if _, err := f.preparer.Capture(context.Background(), captureRequest(ready, "index_capture")); !errors.Is(err, want) {
				t.Fatal(change, err)
			}
		})
	}
}

func TestCaptureCanonicalTransportLimitRetainsUnpublishedCandidate(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	ready := mustPrepare(t, f, request(f.base, "patch_limit"))
	data := make([]byte, maximumCapturedPatch)
	rand.New(rand.NewSource(7)).Read(data)
	writeWork(t, ready, "src/large-binary", string(data))
	cr := captureRequest(ready, "patch_limit")
	if _, err := f.preparer.Capture(context.Background(), cr); !errors.Is(err, ErrLimit) {
		t.Fatal("oversized canonical patch accepted", err)
	}
	if _, err := os.Stat(f.preparer.claimPath("capture", cr.OperationID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("sealed incomplete output", err)
	}
	if _, err := os.Stat(f.preparer.capturePath(cr.OperationID)); err != nil {
		t.Fatal("discarded uncollected candidate", err)
	}
}

func TestCapturePolicyCannotDriftAcrossPrepareReplay(t *testing.T) {
	f := gitFixture(t, "sha1", Limits{})
	r := request(f.base, "policy_replay")
	r.ScopePolicy.AllowedPaths = []string{"src"}
	mustPrepare(t, f, r)
	r.ScopePolicy.AllowedPaths = []string{"."}
	if _, err := f.preparer.Prepare(context.Background(), f.source, r); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
}

func TestScopePolicyValidationAndBoundaryMatching(t *testing.T) {
	for _, policy := range []execution.ManifestScopePolicy{
		{Access: execution.ReadOnly, AllowedPaths: []string{"src"}},
		{Access: execution.IsolatedWrite, AllowedPaths: []string{}},
		{Access: execution.IsolatedWrite, AllowedPaths: []string{"src"}, ForbiddenPaths: []string{"."}},
		{Access: execution.IsolatedWrite, AllowedPaths: []string{"src", "src"}},
		{Access: execution.IsolatedWrite, AllowedPaths: []string{"../outside"}},
		{Access: execution.IsolatedWrite, AllowedPaths: []string{"src/ padded"}},
	} {
		if _, err := freezeScopePolicy(policy); err == nil {
			t.Fatal("invalid policy accepted", policy)
		}
	}
	policy, err := freezeScopePolicy(execution.ManifestScopePolicy{Access: execution.IsolatedWrite, AllowedPaths: []string{"src"}, ForbiddenPaths: []string{"src/private"}})
	if err != nil || !allowedOutput(policy, "src/file") || allowedOutput(policy, "src-other/file") || allowedOutput(policy, "src/private/file") {
		t.Fatal("scope matching differs", err)
	}
}

func TestCaptureRejectsRuntimeMetadataSymlinkTraversal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("native symlink privilege gate")
	}
	f := gitFixture(t, "sha1", Limits{})
	ready := mustPrepare(t, f, request(f.base, "metadata_escape"))
	outside := filepath.Join(f.root, "foreign-metadata")
	if err := os.MkdirAll(filepath.Join(outside, "child"), 0o700); err != nil {
		t.Fatal(err)
	}
	info := filepath.Join(ready.GitDirectory, "objects", "info")
	if err := os.Rename(info, info+"-retained"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, info); err != nil {
		t.Fatal(err)
	}
	if _, err := f.preparer.Capture(context.Background(), captureRequest(ready, "metadata_escape")); !errors.Is(err, ErrChanged) {
		t.Fatal("followed runtime metadata link", err)
	}
	if _, err := directoryIdentity(filepath.Join(info, "child")); !errors.Is(err, ErrChanged) {
		t.Fatal("intermediate link accepted", err)
	}
}
