package repository

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"convenewire.dev/bridge/internal/artifact"
	execution "convenewire.dev/contracts/generated/go/execution"
)

func integrationCandidateFixture(t *testing.T, format string) (*fixture, execution.RepositoryCheckpoint,
	execution.RepositoryOperationRequest) {
	t.Helper()
	f, _, captured, publication := reportSeed(t, format, "# Review\n", "{\"passed\":true}\n")
	transport := &reportTransport{sources: map[string]artifact.Source{}}
	checkpoint, err := f.preparer.PublishCaptured(context.Background(), publication, transport)
	if err != nil {
		t.Fatal(err)
	}
	targetRef := "refs/heads/release"
	f.git(t, f.sourcePath, "update-ref", targetRef, f.base)
	operation := operationForManifest(t, publication.Manifest, "op_integration_exact0001")
	operation.Action = execution.ActionClass{Kind: execution.Integrate, Integrate: &execution.IntegrateClass{
		CandidateCommit: checkpoint.CandidateCommit, CandidateTree: checkpoint.CandidateTree,
		InputDigest: checkpoint.InputDigest,
		Target: execution.IntegrateTarget{RepositoryID: checkpoint.RepositoryID,
			TargetRef: targetRef, ExpectedCommit: f.base},
		IntegrationApprovalOperationID: "op_integration_approval0001",
		VerificationIDS:                []string{"verification_integration0001"},
	}}
	operation.RequestDigest = resumeDigest(t, operation, "requestDigest")
	if captured.CandidateCommit != checkpoint.CandidateCommit {
		t.Fatal("fixture lost captured candidate")
	}
	return f, checkpoint, operation
}

func TestIntegrateExactTargetAtomicallyAdvancesOnlyApprovedRef(t *testing.T) {
	for _, format := range []string{"sha1", "sha256"} {
		t.Run(format, func(t *testing.T) {
			f, checkpoint, operation := integrationCandidateFixture(t, format)
			beforeHead := f.git(t, f.sourcePath, "rev-parse", "HEAD")
			beforeBranch := f.git(t, f.sourcePath, "symbolic-ref", "HEAD")
			beforeStatus := f.git(t, f.sourcePath, "status", "--porcelain=v1", "--untracked-files=all")
			result, err := f.preparer.IntegrateExactTarget(context.Background(), f.source, operation, checkpoint)
			if err != nil || result != checkpoint.CandidateCommit {
				t.Fatalf("result=%s error=%v", result, err)
			}
			if got := f.git(t, f.sourcePath, "show-ref", "--verify", "--hash", operation.Action.Integrate.Target.TargetRef); got != checkpoint.CandidateCommit {
				t.Fatalf("target=%s", got)
			}
			if got := f.git(t, f.sourcePath, "rev-parse", checkpoint.CandidateCommit+"^{tree}"); got != checkpoint.CandidateTree {
				t.Fatalf("candidate tree=%s", got)
			}
			if f.git(t, f.sourcePath, "rev-parse", "HEAD") != beforeHead ||
				f.git(t, f.sourcePath, "symbolic-ref", "HEAD") != beforeBranch ||
				f.git(t, f.sourcePath, "status", "--porcelain=v1", "--untracked-files=all") != beforeStatus {
				t.Fatal("integration changed the owner checkout or HEAD")
			}
		})
	}
}

func TestIntegrateExactTargetFailsClosedWithoutMovingRef(t *testing.T) {
	for _, mode := range []string{"moved", "checked-out", "non-fast-forward", "wrong-tree"} {
		t.Run(mode, func(t *testing.T) {
			f, checkpoint, operation := integrationCandidateFixture(t, "sha1")
			target := operation.Action.Integrate.Target.TargetRef
			expectedRef := f.base
			var expectedError error
			switch mode {
			case "moved":
				f.write(t, "src/app.txt", "owner advanced target\n")
				f.git(t, f.sourcePath, "add", "--all")
				f.git(t, f.sourcePath, "commit", "-m", "owner target update")
				expectedRef = f.git(t, f.sourcePath, "rev-parse", "HEAD")
				f.git(t, f.sourcePath, "update-ref", target, expectedRef)
				expectedError = ErrIntegrationTargetMoved
			case "checked-out":
				worktree := filepath.Join(f.root, "release-worktree")
				f.git(t, f.sourcePath, "worktree", "add", "--", worktree, "release")
				if f.git(t, worktree, "symbolic-ref", "HEAD") != target {
					t.Fatal("fixture did not check out the integration target")
				}
				expectedError = ErrIntegrationTargetCheckedOut
			case "non-fast-forward":
				tree := f.git(t, f.sourcePath, "rev-parse", f.base+"^{tree}")
				expectedRef = f.git(t, f.sourcePath, "commit-tree", tree, "-m", "unrelated target")
				f.git(t, f.sourcePath, "update-ref", target, expectedRef)
				operation.Action.Integrate.Target.ExpectedCommit = expectedRef
				operation.RequestDigest = resumeDigest(t, operation, "requestDigest")
				expectedError = ErrIntegrationNonFastForward
			case "wrong-tree":
				operation.Action.Integrate.CandidateTree = strings.Repeat("a", 40)
				operation.RequestDigest = resumeDigest(t, operation, "requestDigest")
				expectedError = ErrChanged
			}
			beforeHead := f.git(t, f.sourcePath, "rev-parse", "HEAD")
			beforeStatus := f.git(t, f.sourcePath, "status", "--porcelain=v1", "--untracked-files=all")
			if _, err := f.preparer.IntegrateExactTarget(context.Background(), f.source, operation, checkpoint); !errors.Is(err, expectedError) {
				t.Fatalf("error=%v want=%v", err, expectedError)
			}
			if got := f.git(t, f.sourcePath, "show-ref", "--verify", "--hash", target); got != expectedRef {
				t.Fatalf("failed integration moved target: %s != %s", got, expectedRef)
			}
			if f.git(t, f.sourcePath, "rev-parse", "HEAD") != beforeHead ||
				f.git(t, f.sourcePath, "status", "--porcelain=v1", "--untracked-files=all") != beforeStatus {
				t.Fatal("failed integration changed the owner checkout")
			}
		})
	}
}

func TestIntegrateExactTargetConcurrentAttemptsCannotOverwrite(t *testing.T) {
	f, checkpoint, operation := integrationCandidateFixture(t, "sha1")
	var second execution.RepositoryOperationRequest
	raw, _ := json.Marshal(operation)
	if err := json.Unmarshal(raw, &second); err != nil {
		t.Fatal(err)
	}
	second.OperationID = "op_integration_exact0002"
	second.Action.Integrate.IntegrationApprovalOperationID = "op_integration_approval0002"
	second.RequestDigest = resumeDigest(t, second, "requestDigest")
	type result struct {
		commit string
		err    error
	}
	results := make(chan result, 2)
	var wait sync.WaitGroup
	for _, candidate := range []execution.RepositoryOperationRequest{operation, second} {
		wait.Add(1)
		go func(value execution.RepositoryOperationRequest) {
			defer wait.Done()
			commit, err := f.preparer.IntegrateExactTarget(context.Background(), f.source, value, checkpoint)
			results <- result{commit: commit, err: err}
		}(candidate)
	}
	wait.Wait()
	close(results)
	succeeded, moved := 0, 0
	for result := range results {
		if result.err == nil && result.commit == checkpoint.CandidateCommit {
			succeeded++
		} else if errors.Is(result.err, ErrIntegrationTargetMoved) {
			moved++
		} else {
			t.Fatalf("unexpected result: %+v", result)
		}
	}
	if succeeded != 1 || moved != 1 ||
		f.git(t, f.sourcePath, "show-ref", "--verify", "--hash", operation.Action.Integrate.Target.TargetRef) != checkpoint.CandidateCommit {
		t.Fatalf("success=%d moved=%d", succeeded, moved)
	}
}

func TestIntegrateExactTargetCanceledBeforeCASLeavesTargetUntouched(t *testing.T) {
	f, checkpoint, operation := integrationCandidateFixture(t, "sha1")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := f.preparer.IntegrateExactTarget(ctx, f.source, operation, checkpoint); !errors.Is(err, context.Canceled) {
		t.Fatalf("error=%v", err)
	}
	if got := f.git(t, f.sourcePath, "show-ref", "--verify", "--hash", operation.Action.Integrate.Target.TargetRef); got != f.base {
		t.Fatalf("canceled integration moved target: %s", got)
	}
}
