package admission

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	bridgeintegration "convenewire.dev/bridge/internal/integration"
	"convenewire.dev/bridge/internal/repository"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

func integrationCoordinatorAdmission(t *testing.T) bridgeintegration.Admission {
	t.Helper()
	_, rig, _ := governedCoordinatorFixture(t)
	manifest := rig.manifest
	checkpoint := verificationCheckpoint(manifest)
	var err error
	checkpoint.Digest, err = executionDigest(checkpoint, "digest")
	if err != nil {
		t.Fatal(err)
	}
	scope := execution.RepositoryOperationRequestExecution(manifest.Scope)
	operation := execution.RepositoryOperationRequest{Version: 1,
		OperationID: "op_integration_coordinator01",
		Plan: execution.RepositoryOperationRequestPlan{PlanID: scope.PlanID,
			Revision: scope.PlanRevision, Digest: scope.PlanDigest,
			ApprovalOperationID: scope.ApprovalOperationID, RoomID: scope.RoomID,
			RootTaskID: "task_integration_root0001"},
		Execution: &scope, RepositoryID: checkpoint.RepositoryID,
		BindingID: checkpoint.BindingID, DeviceID: scope.DeviceID,
		Grant:              execution.RepositoryOperationRequestGrant(manifest.Grant),
		ExpectedGeneration: checkpoint.WorkspaceGeneration, Deadline: manifest.Deadline,
		Action: execution.ActionClass{Kind: execution.Integrate, Integrate: &execution.IntegrateClass{
			CandidateCommit: checkpoint.CandidateCommit, CandidateTree: checkpoint.CandidateTree,
			InputDigest: checkpoint.InputDigest,
			Target: execution.IntegrateTarget{RepositoryID: checkpoint.RepositoryID,
				TargetRef: "refs/heads/release", ExpectedCommit: checkpoint.BaseCommit},
			IntegrationApprovalOperationID: "op_integration_approval0001",
			VerificationIDS:                []string{"verification_integration0001"},
		}},
	}
	operation.RequestDigest, err = executionDigest(operation, "requestDigest")
	if err != nil {
		t.Fatal(err)
	}
	return bridgeintegration.Admission{Operation: operation, Checkpoint: checkpoint,
		ApprovalDigest: strings.Repeat("a", 64),
		AdmittedAt:     runtimeFenceNow.Add(-time.Minute).Format(time.RFC3339Nano)}
}

func TestGovernedIntegrationCoordinatorRetainsSuccessAndNeverRepeatsCAS(t *testing.T) {
	admission := integrationCoordinatorAdmission(t)
	bindings := &integrationBindingsStub{}
	preparer := &integrationPreparerStub{current: admission.Operation.Action.Integrate.Target.ExpectedCommit}
	journal := &integrationJournalStub{}
	transport := &integrationTransportStub{admission: admission}
	coordinator, err := newGovernedIntegrationCoordinator(bindings, preparer, journal, transport)
	if err != nil {
		t.Fatal(err)
	}
	coordinator.now = func() time.Time { return runtimeFenceNow }
	retained, err := coordinator.Execute(context.Background(), admission.Operation.OperationID)
	if err != nil || retained.Receipt.State != execution.PurpleSucceeded ||
		preparer.integrateCalls != 1 || bindings.checkCalls != 2 || journal.intent == nil || journal.receipt == nil {
		t.Fatalf("retained=%+v error=%v preparer=%+v bindings=%+v journal=%+v",
			retained, err, preparer, bindings, journal)
	}
	if retained.Receipt.CheckpointID == nil || *retained.Receipt.CheckpointID != admission.Checkpoint.CheckpointID ||
		preparer.current != admission.Operation.Action.Integrate.CandidateCommit {
		t.Fatal("success receipt did not pin the checkpoint and resulting candidate")
	}
	replayed, err := coordinator.Execute(context.Background(), admission.Operation.OperationID)
	if err != nil || !reflect.DeepEqual(replayed.Receipt, retained.Receipt) || preparer.integrateCalls != 1 ||
		transport.getCalls != 2 || transport.retainCalls != 2 {
		t.Fatalf("replay repeated CAS: %+v %v preparer=%+v transport=%+v", replayed, err, preparer, transport)
	}
}

func TestGovernedIntegrationCoordinatorRecoversExactIntentWithoutBlindRetry(t *testing.T) {
	for _, mode := range []string{"candidate", "expected", "other"} {
		t.Run(mode, func(t *testing.T) {
			admission := integrationCoordinatorAdmission(t)
			action := admission.Operation.Action.Integrate
			current := action.CandidateCommit
			if mode == "expected" {
				current = action.Target.ExpectedCommit
			} else if mode == "other" {
				current = strings.Repeat("f", len(action.CandidateCommit))
			}
			bindings := &integrationBindingsStub{}
			preparer := &integrationPreparerStub{current: current}
			journal := &integrationJournalStub{intent: &bridgeintegration.IntentRecord{Version: 1, Admission: admission}}
			transport := &integrationTransportStub{admission: admission}
			coordinator, err := newGovernedIntegrationCoordinator(bindings, preparer, journal, transport)
			if err != nil {
				t.Fatal(err)
			}
			coordinator.now = func() time.Time { return runtimeFenceNow }
			retained, err := coordinator.Execute(context.Background(), admission.Operation.OperationID)
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "candidate":
				if retained.Receipt.State != execution.PurpleSucceeded || preparer.integrateCalls != 0 {
					t.Fatal("confirmed candidate was not recovered as success")
				}
			case "expected":
				if retained.Receipt.State != execution.PurpleSucceeded || preparer.integrateCalls != 1 {
					t.Fatal("unchanged expected target did not retry exact intent")
				}
			case "other":
				if retained.Receipt.State != execution.PurpleOutcomeUnknown || preparer.integrateCalls != 0 ||
					retained.Receipt.ErrorCode == nil || *retained.Receipt.ErrorCode != "INTEGRATION_TARGET_OUTCOME_UNKNOWN" {
					t.Fatal("foreign post-intent target was not retained as unknown")
				}
			}
		})
	}
}

func TestGovernedIntegrationCoordinatorRetainsCASFailure(t *testing.T) {
	admission := integrationCoordinatorAdmission(t)
	preparer := &integrationPreparerStub{current: admission.Operation.Action.Integrate.Target.ExpectedCommit,
		integrateErr: repository.ErrIntegrationTargetMoved}
	journal := &integrationJournalStub{}
	transport := &integrationTransportStub{admission: admission}
	coordinator, err := newGovernedIntegrationCoordinator(&integrationBindingsStub{}, preparer, journal, transport)
	if err != nil {
		t.Fatal(err)
	}
	coordinator.now = func() time.Time { return runtimeFenceNow }
	retained, err := coordinator.Execute(context.Background(), admission.Operation.OperationID)
	if err != nil || retained.Receipt.State != execution.PurpleFailed || retained.Receipt.ErrorCode == nil ||
		*retained.Receipt.ErrorCode != "INTEGRATION_TARGET_MOVED" {
		t.Fatalf("retained=%+v error=%v", retained, err)
	}
}

type integrationBindingsStub struct {
	checkCalls, resolveCalls int
	checkErr, resolveErr     error
}

func (s *integrationBindingsStub) CheckIntegrationGrant(_ context.Context,
	_ execution.RepositoryOperationRequest, _ time.Time) error {
	s.checkCalls++
	return s.checkErr
}

func (s *integrationBindingsStub) ResolveSource(_ context.Context, _, _ string, revision int) (repository.Source, error) {
	s.resolveCalls++
	if revision != 1 {
		return repository.Source{}, errors.New("wrong binding revision")
	}
	return repository.Source{Root: "/source", GitDirectory: "/source/.git",
		CommonDirectory: "/source/.git", ObjectFormat: "sha1"}, s.resolveErr
}

type integrationPreparerStub struct {
	current                      string
	integrateErr, inspectionErr  error
	integrateCalls, inspectCalls int
}

func (s *integrationPreparerStub) IntegrateExactTarget(_ context.Context, _ repository.Source,
	operation execution.RepositoryOperationRequest, _ execution.RepositoryCheckpoint) (string, error) {
	s.integrateCalls++
	if s.integrateErr != nil {
		return "", s.integrateErr
	}
	s.current = operation.Action.Integrate.CandidateCommit
	return s.current, nil
}

func (s *integrationPreparerStub) InspectIntegrationTarget(_ context.Context, _ repository.Source,
	_ string) (string, error) {
	s.inspectCalls++
	return s.current, s.inspectionErr
}

type integrationJournalStub struct {
	intent  *bridgeintegration.IntentRecord
	receipt *execution.RepositoryOperationReceipt
}

func (s *integrationJournalStub) PutIntent(value bridgeintegration.IntentRecord) error {
	if s.intent != nil && !reflect.DeepEqual(*s.intent, value) {
		return bridgeintegration.ErrConflict
	}
	copy := value
	s.intent = &copy
	return nil
}

func (s *integrationJournalStub) Intent(string) (*bridgeintegration.IntentRecord, error) {
	return s.intent, nil
}

func (s *integrationJournalStub) PutReceipt(value execution.RepositoryOperationReceipt) error {
	if s.receipt != nil && !reflect.DeepEqual(*s.receipt, value) {
		return bridgeintegration.ErrConflict
	}
	copy := value
	s.receipt = &copy
	return nil
}

func (s *integrationJournalStub) Receipt(string) (*execution.RepositoryOperationReceipt, error) {
	return s.receipt, nil
}

type integrationTransportStub struct {
	admission             bridgeintegration.Admission
	getCalls, retainCalls int
}

func (s *integrationTransportStub) Get(_ context.Context, operationID string) (bridgeintegration.Admission, error) {
	s.getCalls++
	if operationID != s.admission.Operation.OperationID {
		return bridgeintegration.Admission{}, ErrAdmissionChanged
	}
	return s.admission, nil
}

func (s *integrationTransportStub) Retain(_ context.Context,
	receipt execution.RepositoryOperationReceipt) (bridgeintegration.RetainedReceipt, error) {
	s.retainCalls++
	raw, _ := json.Marshal(receipt)
	digest, err := wire.ExecutionDigest(raw)
	if err != nil {
		return bridgeintegration.RetainedReceipt{}, err
	}
	return bridgeintegration.RetainedReceipt{Receipt: receipt, ReceiptDigest: digest,
		RecordedAt: receipt.RecordedAt}, nil
}
