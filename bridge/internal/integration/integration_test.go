package integration

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

func integrationWireFixture(t *testing.T) Admission {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "contracts",
		"fixtures", "execution-runtime-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite struct {
		Cases []struct {
			Name     string
			Instance json.RawMessage
		}
	}
	if err := json.Unmarshal(raw, &suite); err != nil {
		t.Fatal(err)
	}
	var operation execution.RepositoryOperationRequest
	var checkpoint execution.RepositoryCheckpoint
	for _, entry := range suite.Cases {
		switch entry.Name {
		case "execution runtime: valid integrate operation":
			if err := json.Unmarshal(entry.Instance, &operation); err != nil {
				t.Fatal(err)
			}
		case "execution runtime: valid checkpoint":
			if err := json.Unmarshal(entry.Instance, &checkpoint); err != nil {
				t.Fatal(err)
			}
		}
	}
	operation.OperationID = "op_integration_fixture01"
	operation.RequestDigest = integrationDigest(t, operation, "requestDigest")
	checkpoint.Digest = integrationDigest(t, checkpoint, "digest")
	admission := Admission{Operation: operation, Checkpoint: checkpoint,
		ApprovalDigest: strings.Repeat("d", 64), AdmittedAt: "2026-08-31T10:05:00Z"}
	if !validAdmission(admission) {
		t.Fatal("fixture is not a valid admission")
	}
	return admission
}

func integrationDigest(t *testing.T, value any, field string) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	delete(fields, field)
	unsigned, _ := json.Marshal(fields)
	digest, err := wire.ExecutionDigest(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	return digest
}

func integrationReceipt(admission Admission) execution.RepositoryOperationReceipt {
	operation, checkpoint := admission.Operation, admission.Checkpoint
	action := operation.Action.Integrate
	generation, checkpointID := operation.ExpectedGeneration, checkpoint.CheckpointID
	candidate, tree := action.CandidateCommit, action.CandidateTree
	target := execution.RepositoryOperationReceiptTarget(action.Target)
	return execution.RepositoryOperationReceipt{Version: 1,
		OperationID: operation.OperationID, RequestDigest: operation.RequestDigest,
		Kind: execution.Integrate, RepositoryID: operation.RepositoryID,
		BindingID: operation.BindingID, DeviceID: operation.DeviceID,
		State: execution.PurpleSucceeded, ObservedGeneration: &generation,
		CheckpointID: &checkpointID, VerificationID: nil,
		CandidateCommit: &candidate, CandidateTree: &tree, Target: &target,
		ProviderObservationID: nil, ErrorCode: nil, RecordedAt: "2026-08-31T10:06:00Z"}
}

func TestClientGetsExactAdmissionAndRecoversLostReceiptResponse(t *testing.T) {
	admission := integrationWireFixture(t)
	receipt := integrationReceipt(admission)
	raw, _ := json.Marshal(receipt)
	digest, _ := wire.ExecutionDigest(raw)
	retained := RetainedReceipt{Receipt: receipt, ReceiptDigest: digest, RecordedAt: receipt.RecordedAt}
	getAdmission, postReceipt, getReceipt := 0, 0, 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/api/bridge/repository-integrations/"+admission.Operation.OperationID && request.Method == http.MethodGet:
			getAdmission++
			_ = json.NewEncoder(w).Encode(admission)
		case request.URL.Path == "/api/bridge/integration-receipts" && request.Method == http.MethodPost:
			postReceipt++
			var observed execution.RepositoryOperationReceipt
			if json.NewDecoder(request.Body).Decode(&observed) != nil || !sameCanonical(observed, receipt) {
				t.Fatal("client changed receipt submission")
			}
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Fatal(err)
			}
			_ = connection.Close()
		case request.URL.Path == "/api/bridge/repository-integrations/"+admission.Operation.OperationID+"/receipt" && request.Method == http.MethodGet:
			getReceipt++
			_ = json.NewEncoder(w).Encode(retained)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	client := NewClient(config.Config{ServerURL: server.URL}, pairing.Credential{ServerURL: server.URL, Token: "secret"})
	observed, err := client.Get(context.Background(), admission.Operation.OperationID)
	if err != nil || !reflect.DeepEqual(observed, admission) || getAdmission != 1 {
		t.Fatalf("admission=%+v error=%v calls=%d", observed, err, getAdmission)
	}
	stored, err := client.Retain(context.Background(), receipt)
	if err != nil || !reflect.DeepEqual(stored, retained) || postReceipt != 1 || getReceipt != 1 {
		t.Fatalf("retained=%+v error=%v post=%d get=%d", stored, err, postReceipt, getReceipt)
	}
}

func TestIntegrationJournalRetainsExactIntentAndReceiptAcrossRestart(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	owner := Owner{ServerURL: "https://central.example", TeamID: "team_integration0001",
		DeviceID: "device_integration0001", OwnerMemberID: "member_integration0001"}
	journal, err := OpenJournal(root, owner)
	if err != nil {
		t.Fatal(err)
	}
	admission := integrationWireFixture(t)
	intent := IntentRecord{Version: 1, Admission: admission}
	if err := journal.PutIntent(intent); err != nil {
		t.Fatal(err)
	}
	changed := intent
	changed.Admission.ApprovalDigest = strings.Repeat("e", 64)
	if err := journal.PutIntent(changed); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	receipt := integrationReceipt(admission)
	if err := journal.PutReceipt(receipt); err != nil {
		t.Fatal(err)
	}
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenJournal(root, owner)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	observedIntent, err := reopened.Intent(admission.Operation.OperationID)
	if err != nil || observedIntent == nil || !reflect.DeepEqual(*observedIntent, intent) {
		t.Fatalf("intent=%+v error=%v", observedIntent, err)
	}
	observedReceipt, err := reopened.Receipt(admission.Operation.OperationID)
	if err != nil || observedReceipt == nil || !reflect.DeepEqual(*observedReceipt, receipt) {
		t.Fatalf("receipt=%+v error=%v", observedReceipt, err)
	}
}
