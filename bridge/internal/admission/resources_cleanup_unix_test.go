//go:build darwin || linux

package admission

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	"convenewire.dev/bridge/internal/repository"
	bridgeruntime "convenewire.dev/bridge/internal/runtime"
	execution "convenewire.dev/contracts/generated/go/execution"
)

type cleanupResourceTransport struct{}

func (cleanupResourceTransport) CaptureCheckpoint(context.Context, string) (*execution.RepositoryCheckpoint, error) {
	return nil, nil
}

func (cleanupResourceTransport) PublishCapture(_ context.Context,
	input artifact.CapturePublishInput) (artifact.PublishResult, error) {
	return artifact.PublishResult{ArtifactID: "artifact_cleanupresource0001",
		ContentID: "content_cleanupresource0001", Revision: 1, SHA256: input.Source.SHA256}, nil
}

func (cleanupResourceTransport) SealCaptureCheckpoint(_ context.Context,
	checkpoint execution.RepositoryCheckpoint) (execution.RepositoryCheckpoint, error) {
	return checkpoint, nil
}

func TestGovernedAdmissionResourcesRetireOnlyExactStoppedCapturedWorkspace(t *testing.T) {
	_, git, cfg, credential, _ := governedResourcesFixture(t)
	resources, err := OpenGovernedAdmissionResources(context.Background(), cfg, credential, git, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = resources.Close() })
	now := time.Now().UTC().Truncate(time.Millisecond)
	sourceRoot, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	runResourceGit(t, git, sourceRoot, "init", "--template=", "-b", "main")
	runResourceGit(t, git, sourceRoot, "config", "user.name", "ConveneWire Test")
	runResourceGit(t, git, sourceRoot, "config", "user.email", "test@example.invalid")
	if err := os.Mkdir(filepath.Join(sourceRoot, "src"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "src", "app.txt"), []byte("base\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	runResourceGit(t, git, sourceRoot, "add", "--", "src/app.txt")
	runResourceGit(t, git, sourceRoot, "commit", "-m", "base")
	base := strings.TrimSpace(runResourceGit(t, git, sourceRoot, "rev-parse", "HEAD"))
	binding, err := resources.bindings.Bind(context.Background(), repository.BindRepository{
		BindingID: "repobind_cleanupresource0001", RepositoryID: "repo_cleanupresource0001",
		Alias: "Cleanup resource", SelectedRoot: sourceRoot, AllowedRoots: []string{sourceRoot}}, now)
	if err != nil {
		t.Fatal(err)
	}

	manifest := runtimeManifestFixture(t)
	manifest.Scope.DeviceID = credential.DeviceID
	manifest.Repository.RepositoryID = binding.RepositoryID
	manifest.Repository.BindingID = binding.BindingID
	manifest.Repository.BaseCommit = base
	manifest.Inputs = []execution.GovernedExecutionManifestInput{}
	manifest.ScopePolicy.AllowedPaths = []string{"src"}
	manifest.ScopePolicy.ForbiddenPaths = []string{}
	manifest.Workspace.IssuedAt = now.Add(-time.Minute).Format(time.RFC3339Nano)
	manifest.Workspace.ExpiresAt = now.Add(time.Hour).Format(time.RFC3339Nano)
	manifest.Grant.ExpiresAt = manifest.Workspace.ExpiresAt
	manifest.Deadline = now.Add(30 * time.Minute).Format(time.RFC3339Nano)
	manifest.InputDigest, err = executionDigest(manifest.Inputs, "")
	if err != nil {
		t.Fatal(err)
	}
	manifest.ManifestDigest, err = executionDigest(manifest, "manifestDigest")
	if err != nil {
		t.Fatal(err)
	}
	source, err := resources.bindings.ResolveSource(context.Background(), binding.BindingID, binding.RepositoryID, 1)
	if err != nil {
		t.Fatal(err)
	}
	ready, err := resources.preparer.Prepare(context.Background(), source, repository.Preparation{
		OperationID: "op_prepare_cleanupresource0001", RunID: manifest.Scope.RunID,
		RepositoryID: binding.RepositoryID, BindingID: binding.BindingID,
		WorkspaceRef: manifest.Workspace.WorkspaceRef, Generation: manifest.Workspace.WorkspaceGeneration,
		ManifestDigest: manifest.ManifestDigest, BaseCommit: base,
		ScopePolicy: execution.ManifestScopePolicy(manifest.ScopePolicy)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ready.Path, "src", "app.txt"), []byte("implemented\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	captureOperation := cleanupResourceCaptureOperation(t, manifest)
	captured, err := resources.preparer.Capture(context.Background(), repository.CaptureRequest{
		OperationID: captureOperation.OperationID, WorkspaceRef: ready.WorkspaceRef,
		PreparedDigest: ready.IntentDigest, ExpectedGeneration: ready.Generation,
		ManifestDigest: manifest.ManifestDigest})
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err := resources.preparer.PublishCaptured(context.Background(), repository.CapturePublication{
		CaptureDigest: captured.Digest, Manifest: manifest, Operation: captureOperation,
		Outputs: []repository.CaptureOutputDescription{{SlotKey: manifest.Outputs[0].SlotKey,
			Title: "Cleanup resource", Summary: "Exact captured patch"}}}, cleanupResourceTransport{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resources.IssueCleanupGrant(context.Background(), "cleanupgrant_early0001",
		"op_cleanup_early0001", checkpoint, now.Add(time.Hour).Format(time.RFC3339Nano), now); err == nil {
		t.Fatal("checkpoint alone authorized cleanup consent")
	}

	_, profile := runtimePrerequisites(manifest)
	spec, err := NewRuntimeAdmissionSpec(manifest, ready, profile)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := resources.fence.Claim(spec, now)
	if err != nil {
		t.Fatal(err)
	}
	started, invoke, err := resources.fence.start(context.Background(), spec.RunID, claimed.AdmissionDigest,
		func(context.Context, RuntimeAdmissionSpec) error { return nil }, func() time.Time { return now.Add(time.Minute) })
	if err != nil || !invoke || started.StartDigest == nil {
		t.Fatalf("started=%+v invoke=%t err=%v", started, invoke, err)
	}
	identity := bridgeruntime.GovernedProcessIdentity{RunID: spec.RunID,
		AdmissionDigest: claimed.AdmissionDigest, StartDigest: *started.StartDigest}
	lease, err := resources.processes.PrepareProcess(identity)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command("/bin/sh", "-c", "exit 0")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.ExtraFiles = []*os.File{lease.InheritedLockFile()}
	if err := command.Start(); err != nil {
		_ = lease.Abandon()
		t.Fatal(err)
	}
	observation := bridgeruntime.GovernedProcessObservation{PID: command.Process.Pid,
		PlatformIdentity: fmt.Sprintf("process-group:%d", command.Process.Pid)}
	if err := lease.Started(observation); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Finished(observation); err != nil {
		t.Fatal(err)
	}
	if _, err := resources.fence.Stop(spec.RunID, claimed.AdmissionDigest, *started.StartDigest,
		RuntimeOutcomeCompleted, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	changedCheckpoint := checkpoint
	changedCheckpoint.Digest = strings.Repeat("f", 64)
	if _, err := resources.IssueCleanupGrant(context.Background(), "cleanupgrant_changed0001",
		"op_cleanup_changed0001", changedCheckpoint, now.Add(time.Hour).Format(time.RFC3339Nano), now); err == nil {
		t.Fatal("changed checkpoint authorized cleanup consent")
	}

	cleanupScope, err := resources.preparer.InspectCleanupScope(context.Background(), "op_cleanup_resource0001", checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := resources.IssueCleanupGrant(context.Background(), "cleanupgrant_resource0001",
		"op_cleanup_resource0001", checkpoint, now.Add(time.Hour).Format(time.RFC3339Nano), now)
	if err != nil {
		t.Fatalf("scope=%+v err=%v", cleanupScope, err)
	}
	listed, err := resources.ListCleanupGrants()
	if err != nil || len(listed) != 1 || listed[0].Digest != grant.Digest {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	ordinary, err := resources.bindings.ListTaskGrants()
	if err != nil || len(ordinary) != 0 {
		t.Fatalf("cleanup consent leaked into Runtime grants: %+v err=%v", ordinary, err)
	}
	coordinator, err := resources.CleanupCoordinator(grant.Spec.GrantID)
	if err != nil {
		t.Fatal(err)
	}
	preview, err := coordinator.Preview(context.Background(), grant.Spec.OperationID, checkpoint)
	if err != nil || preview.Path != ready.Path || preview.Branch != ready.Branch {
		t.Fatalf("preview=%+v err=%v", preview, err)
	}
	receipt, err := coordinator.Execute(context.Background(), repository.CleanupRequest{
		OperationID: grant.Spec.OperationID, Checkpoint: checkpoint, ExpectedPreviewDigest: preview.Digest})
	if err != nil || receipt.RemovedWorktree != ready.Path || receipt.RemovedBranch != ready.Branch {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	if _, err := os.Lstat(ready.Path); !os.IsNotExist(err) {
		t.Fatalf("owned worktree remains: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(sourceRoot, "src", "app.txt")); err != nil || string(got) != "base\n" {
		t.Fatalf("source changed: %q err=%v", got, err)
	}
	replayed, err := coordinator.Execute(context.Background(), repository.CleanupRequest{
		OperationID: grant.Spec.OperationID, Checkpoint: checkpoint, ExpectedPreviewDigest: preview.Digest})
	if err != nil || replayed.Digest != receipt.Digest {
		t.Fatalf("replay=%+v err=%v", replayed, err)
	}
	if _, err := resources.RevokeCleanupGrant(grant.Spec.GrantID, 1, grant.Digest, now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := coordinator.Execute(context.Background(), repository.CleanupRequest{
		OperationID: grant.Spec.OperationID, Checkpoint: checkpoint,
		ExpectedPreviewDigest: preview.Digest}); !errors.Is(err, repository.ErrGrantRevoked) {
		t.Fatalf("revoked cleanup replay error=%v", err)
	}
}

func cleanupResourceCaptureOperation(t *testing.T,
	manifest execution.GovernedExecutionManifest) execution.RepositoryOperationRequest {
	t.Helper()
	scope := execution.RepositoryOperationRequestExecution(manifest.Scope)
	operation := execution.RepositoryOperationRequest{Version: 1,
		OperationID: "op_capture_cleanupresource0001",
		Plan: execution.RepositoryOperationRequestPlan{PlanID: scope.PlanID, Revision: scope.PlanRevision,
			Digest: scope.PlanDigest, ApprovalOperationID: scope.ApprovalOperationID,
			RoomID: scope.RoomID, RootTaskID: "task_cleanup_root0001"},
		Execution: &scope, RepositoryID: manifest.Repository.RepositoryID,
		BindingID: manifest.Repository.BindingID, DeviceID: scope.DeviceID,
		Grant:              execution.RepositoryOperationRequestGrant(manifest.Grant),
		ExpectedGeneration: manifest.Workspace.WorkspaceGeneration, Deadline: manifest.Deadline,
		Action: execution.ActionClass{Kind: execution.Capture,
			Capture: &execution.ActionCapture{ManifestDigest: manifest.ManifestDigest}}}
	var err error
	operation.RequestDigest, err = executionDigest(operation, "requestDigest")
	if err != nil {
		t.Fatal(err)
	}
	return operation
}
