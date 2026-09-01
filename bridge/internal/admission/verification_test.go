package admission

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"convenewire.dev/bridge/internal/artifact"
	"convenewire.dev/bridge/internal/repository"
	"convenewire.dev/bridge/internal/verification"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

func TestGovernedVerificationHelperProcess(t *testing.T) {
	if len(os.Args) < 4 || os.Args[1] != "-test.run=TestGovernedVerificationHelperProcess" ||
		os.Args[2] != "--" {
		return
	}
	fmt.Fprintln(os.Stdout, "verified candidate")
	if os.Args[3] == "fail" {
		os.Exit(7)
	}
	os.Exit(0)
}

func TestGovernedVerificationCoordinatorRetainsPassAndNeverRerunsJournal(t *testing.T) {
	coordinator, rig, request := governedCoordinatorFixture(t)
	ticket, err := coordinator.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	decision, err := coordinator.Start(context.Background(), ticket)
	if err != nil {
		t.Fatal(err)
	}
	manifest := ticket.manifest
	checkpoint := verificationCheckpoint(manifest)
	executable, _ := os.Executable()
	profile := verification.ResolvedProfile{Reference: verification.Reference{
		ProfileID: manifest.VerificationProfiles[0].ProfileID,
		Revision:  manifest.VerificationProfiles[0].Revision,
		Digest:    manifest.VerificationProfiles[0].Digest,
	}, Executable: executable, ExecutableDigest: fileSHA256(t, executable),
		Arguments: []string{"-test.run=TestGovernedVerificationHelperProcess", "--", "pass"},
		Timeout:   5 * time.Second, OutputLimitBytes: 4096}
	profiles := &verificationProfilesStub{profile: profile}
	preparer := &verificationPreparerStub{}
	transport := &verificationTransportStub{}
	bindings := &verificationBindingsStub{rig: rig}
	journalRoot := filepath.Join(t.TempDir(), "journal-data")
	if err := os.Mkdir(journalRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	journal, err := verification.OpenJournal(journalRoot, verification.Owner{
		ServerURL: "https://central.example", TeamID: "team_verification0001",
		DeviceID: manifest.Scope.DeviceID, OwnerMemberID: "member_verification0001",
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = journal.Close() })
	temporaryParent := t.TempDir()
	verifier, err := newGovernedVerificationCoordinator(bindings, preparer,
		profiles, journal, rig, &captureProcessStub{}, transport,
		verification.Runner{TemporaryParent: temporaryParent})
	if err != nil {
		t.Fatal(err)
	}
	verifier.now = func() time.Time { return runtimeFenceNow }
	receipts, err := verifier.VerifyCaptured(context.Background(), ticket, decision, checkpoint)
	if err != nil {
		t.Fatal(err)
	}
	if len(receipts) != 1 || receipts[0].Receipt.Outcome != execution.Passed ||
		profiles.calls != 2 || preparer.calls != 1 || transport.beginCalls != 1 ||
		transport.publishCalls != 1 || transport.retainCalls != 1 || bindings.verifyCalls != 2 {
		t.Fatalf("unexpected verification: receipts=%+v profiles=%d prepare=%d transport=%+v grants=%d",
			receipts, profiles.calls, preparer.calls, transport, bindings.verifyCalls)
	}
	operationID := receipts[0].Receipt.OperationID
	if terminal, err := journal.Terminal(operationID); err != nil || terminal == nil ||
		terminal.Result.Outcome != verification.OutcomePassed {
		t.Fatalf("terminal journal missing: %+v %v", terminal, err)
	}
	if retained, err := journal.Receipt(operationID); err != nil || retained == nil ||
		!reflect.DeepEqual(*retained, receipts[0].Receipt) {
		t.Fatalf("receipt journal missing: %+v %v", retained, err)
	}
	if entries, err := os.ReadDir(temporaryParent); err != nil || len(entries) != 0 {
		t.Fatalf("verification run root leaked: %#v %v", entries, err)
	}
	replay, err := verifier.VerifyCaptured(context.Background(), ticket, decision, checkpoint)
	if err != nil || len(replay) != 1 || profiles.calls != 2 || preparer.calls != 1 ||
		transport.beginCalls != 1 || transport.publishCalls != 1 || transport.retainCalls != 2 {
		t.Fatalf("journal replay reran verification: %+v %v profile=%d prepare=%d transport=%+v",
			replay, err, profiles.calls, preparer.calls, transport)
	}
}

type verificationBindingsStub struct {
	rig         *coordinatorRig
	verifyCalls int
}

func (s *verificationBindingsStub) CheckTaskGrant(_ context.Context,
	manifest execution.GovernedExecutionManifest, operation execution.KindElement,
	_ time.Time) error {
	if operation != execution.Verify || !reflect.DeepEqual(manifest, s.rig.manifest) {
		return ErrAdmissionChanged
	}
	s.verifyCalls++
	return nil
}

func (s *verificationBindingsStub) ResolveSource(ctx context.Context,
	binding, repositoryID string, revision int) (repository.Source, error) {
	return s.rig.ResolveSource(ctx, binding, repositoryID, revision)
}

type verificationPreparerStub struct{ calls int }

func (s *verificationPreparerStub) MaterializeVerificationCandidate(_ context.Context,
	_ execution.RepositoryCheckpoint, root string) (string, error) {
	s.calls++
	workspace := filepath.Join(root, "candidate")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(workspace, "candidate.txt"),
		[]byte("sealed\n"), 0o600); err != nil {
		return "", err
	}
	return workspace, nil
}

type verificationProfilesStub struct {
	profile verification.ResolvedProfile
	calls   int
}

func (s *verificationProfilesStub) Resolve(reference verification.Reference) (verification.ResolvedProfile, error) {
	s.calls++
	if reference != s.profile.Reference {
		return verification.ResolvedProfile{}, verification.ErrProfileConflict
	}
	return s.profile, nil
}

type verificationTransportStub struct {
	beginCalls, publishCalls, retainCalls int
	operation                             execution.RepositoryOperationRequest
}

func (s *verificationTransportStub) Begin(_ context.Context,
	operation execution.RepositoryOperationRequest) (verification.Admission, error) {
	s.beginCalls++
	s.operation = operation
	return verification.Admission{OperationID: operation.OperationID,
		RequestDigest: operation.RequestDigest, AdmittedAt: runtimeFenceNow.Format(time.RFC3339Nano),
		Deadline: operation.Deadline}, nil
}

func (s *verificationTransportStub) PublishLog(_ context.Context,
	_ execution.GovernedExecutionManifest, _ execution.RepositoryOperationRequest,
	operationID string, log []byte) (artifact.PublishResult, error) {
	s.publishCalls++
	if operationID != s.operation.OperationID || len(log) == 0 {
		return artifact.PublishResult{}, ErrAdmissionChanged
	}
	digest := sha256.Sum256(log)
	return artifact.PublishResult{ArtifactID: "artifact_verification0001",
		ContentID: "content_verification0001", Revision: 1,
		SHA256: hex.EncodeToString(digest[:])}, nil
}

func (s *verificationTransportStub) Retain(_ context.Context,
	receipt execution.VerificationReceipt) (verification.RetainedReceipt, error) {
	s.retainCalls++
	raw, _ := json.Marshal(receipt)
	digest, err := wire.ExecutionDigest(raw)
	if err != nil {
		return verification.RetainedReceipt{}, err
	}
	return verification.RetainedReceipt{Receipt: receipt, ReceiptDigest: digest,
		RecordedAt: runtimeFenceNow.Format(time.RFC3339Nano)}, nil
}

func verificationCheckpoint(manifest execution.GovernedExecutionManifest) execution.RepositoryCheckpoint {
	return execution.RepositoryCheckpoint{CheckpointID: "checkpoint_verification0001",
		OperationID: manifest.Capture.OperationID, Scope: execution.RepositoryCheckpointScope(manifest.Scope),
		RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID,
		BaseCommit: manifest.Repository.BaseCommit, CandidateCommit: strings.Repeat("d", len(manifest.Repository.BaseCommit)),
		CandidateTree: strings.Repeat("e", len(manifest.Repository.BaseCommit)), InputDigest: manifest.InputDigest,
		WorkspaceRef: manifest.Workspace.WorkspaceRef, WorkspaceGeneration: manifest.Workspace.WorkspaceGeneration,
		Outputs: []execution.RepositoryCheckpointOutput{}, CapturedAt: runtimeFenceNow.Format(time.RFC3339Nano),
		Digest: strings.Repeat("f", 64)}
}

func fileSHA256(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}
