package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

func captureWireFixture(t *testing.T, name string, target any) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "contracts", "fixtures", "execution-runtime-cases.json"))
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
	for _, entry := range suite.Cases {
		if entry.Name == name {
			if err := json.Unmarshal(entry.Instance, target); err != nil {
				t.Fatal(err)
			}
			return
		}
	}
	t.Fatal("fixture not found", name)
}

func captureHash(t *testing.T, value any, field string) string {
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
	raw, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	result, err := wire.ExecutionDigest(raw)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func captureInputFixture(t *testing.T) CapturePublishInput {
	t.Helper()
	var manifest execution.GovernedExecutionManifest
	captureWireFixture(t, "execution runtime: valid manifest", &manifest)
	raw, err := json.Marshal(manifest.Inputs)
	if err != nil {
		t.Fatal(err)
	}
	manifest.InputDigest, err = wire.ExecutionDigest(raw)
	if err != nil {
		t.Fatal(err)
	}
	manifest.ManifestDigest = captureHash(t, manifest, "manifestDigest")
	scope := execution.RepositoryOperationRequestExecution(manifest.Scope)
	operation := execution.RepositoryOperationRequest{Version: 1, OperationID: "op_capture_client0001",
		Plan: execution.RepositoryOperationRequestPlan{PlanID: scope.PlanID, Revision: scope.PlanRevision,
			Digest: scope.PlanDigest, ApprovalOperationID: scope.ApprovalOperationID, RoomID: scope.RoomID, RootTaskID: "task_capture_root0001"},
		Execution: &scope, RepositoryID: manifest.Repository.RepositoryID, BindingID: manifest.Repository.BindingID,
		DeviceID: scope.DeviceID, Grant: execution.RepositoryOperationRequestGrant(manifest.Grant),
		ExpectedGeneration: manifest.Workspace.WorkspaceGeneration, Deadline: manifest.Deadline,
		Action: execution.ActionClass{Kind: execution.Capture, Capture: &execution.ActionCapture{ManifestDigest: manifest.ManifestDigest}}}
	operation.RequestDigest = captureHash(t, operation, "requestDigest")
	patch := []byte("diff --git a/a b/a\n+client fixture\n")
	hash := sha256.Sum256(patch)
	slot := ""
	for _, output := range manifest.Outputs {
		if output.Kind == execution.Patch {
			slot = output.SlotKey
			break
		}
	}
	return CapturePublishInput{Manifest: manifest, Operation: operation, SlotKey: slot, Title: "Captured patch", Summary: "Client fixture",
		Source: Source{Bytes: patch, FileName: "output.patch", MediaType: "text/x-diff", SHA256: hex.EncodeToString(hash[:]),
			WorkspaceRef: manifest.Workspace.WorkspaceRef, WorkspaceGeneration: manifest.Workspace.WorkspaceGeneration}}
}

func TestCaptureClientRejectsContextAndSourceChangesBeforeHTTP(t *testing.T) {
	for name, mutate := range map[string]func(*CapturePublishInput){
		"manifest digest":   func(v *CapturePublishInput) { v.Manifest.Scope.TaskRevision++ },
		"scope":             func(v *CapturePublishInput) { v.Operation.Execution.TaskID = "task_other0001" },
		"grant":             func(v *CapturePublishInput) { v.Operation.Grant.Revision++ },
		"binding":           func(v *CapturePublishInput) { v.Operation.BindingID = "repobind_other0001" },
		"device":            func(v *CapturePublishInput) { v.Operation.DeviceID = "device_other0001" },
		"approval":          func(v *CapturePublishInput) { v.Operation.Plan.ApprovalOperationID = "op_other_approval0001" },
		"capture digest":    func(v *CapturePublishInput) { v.Operation.Action.Capture.ManifestDigest = strings.Repeat("d", 64) },
		"deadline":          func(v *CapturePublishInput) { v.Operation.Deadline = "2099-01-01T00:00:00Z" },
		"source generation": func(v *CapturePublishInput) { v.Source.WorkspaceGeneration = strings.Repeat("d", 64) },
		"source bytes":      func(v *CapturePublishInput) { v.Source.Bytes = []byte("changed") },
		"unsafe filename":   func(v *CapturePublishInput) { v.Source.FileName = "bad\nname.patch" },
		"output slot":       func(v *CapturePublishInput) { v.SlotKey = "not_approved" },
	} {
		t.Run(name, func(t *testing.T) {
			input := captureInputFixture(t)
			mutate(&input)
			input.Operation.RequestDigest = captureHash(t, input.Operation, "requestDigest")
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(500) }))
			defer server.Close()
			_, err := NewClient(config.Config{ServerURL: server.URL}, pairing.Credential{}).PublishCapture(context.Background(), input)
			if err == nil || calls != 0 {
				t.Fatal("invalid capture reached HTTP", err, calls)
			}
		})
	}
}

func TestCaptureClientRejectsWrongLeaseBeforeUpload(t *testing.T) {
	for _, field := range []string{"leaseId", "captureOperationId", "mode", "state", "roomId", "taskId", "runId",
		"agentId", "deviceId", "workspaceRef", "workspaceGeneration", "expiresAt", "caseAlias"} {
		t.Run(field, func(t *testing.T) {
			input := captureInputFixture(t)
			scope := input.Manifest.Scope
			lease := map[string]string{"leaseId": "lease_capture0001", "captureOperationId": input.Operation.OperationID,
				"mode": "read_capture", "state": "active", "roomId": scope.RoomID, "taskId": scope.TaskID, "runId": scope.RunID,
				"agentId": scope.AgentID, "deviceId": scope.DeviceID, "workspaceRef": input.Source.WorkspaceRef,
				"workspaceGeneration": input.Source.WorkspaceGeneration, "expiresAt": input.Operation.Deadline}
			if field == "caseAlias" {
				delete(lease, "deviceId")
				lease["DeviceID"] = scope.DeviceID
			} else {
				lease[field] = "wrong"
			}
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/api/bridge/repository-captures" {
					t.Error("lease mismatch reached upload")
				}
				_ = json.NewEncoder(w).Encode(lease)
			}))
			defer server.Close()
			_, err := NewClient(config.Config{ServerURL: server.URL}, pairing.Credential{}).PublishCapture(context.Background(), input)
			if err == nil || calls != 1 {
				t.Fatal("invalid capture lease accepted", err, calls)
			}
		})
	}
}

func TestCaptureCheckpointLookupDistinguishesAbsentFromUncertainOrInvalid(t *testing.T) {
	var checkpoint execution.RepositoryCheckpoint
	captureWireFixture(t, "execution runtime: valid checkpoint", &checkpoint)
	checkpoint.Digest = captureHash(t, checkpoint, "digest")
	for name, response := range map[string]struct {
		status int
		code   string
		mutate func(*execution.RepositoryCheckpoint)
	}{
		"missing operation":  {status: 404, code: "REPOSITORY_CAPTURE_NOT_FOUND"},
		"missing checkpoint": {status: 404, code: "REPOSITORY_CHECKPOINT_NOT_FOUND"},
		"foreign 404":        {status: 404, code: "OTHER_NOT_FOUND"},
		"forbidden":          {status: 403, code: "FORBIDDEN"},
		"unavailable":        {status: 503, code: "UNAVAILABLE"},
		"actual receipt":     {status: 200},
		"wrong digest":       {status: 200, mutate: func(v *execution.RepositoryCheckpoint) { v.Digest = strings.Repeat("d", 64) }},
		"wrong operation": {status: 200, mutate: func(v *execution.RepositoryCheckpoint) {
			v.OperationID = "op_foreign0001"
			v.Digest = captureHash(t, v, "digest")
		}},
	} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(response.status)
				if response.status != 200 {
					_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": response.code}})
					return
				}
				value := checkpoint
				if response.mutate != nil {
					response.mutate(&value)
				}
				_ = json.NewEncoder(w).Encode(value)
			}))
			defer server.Close()
			result, err := NewClient(config.Config{ServerURL: server.URL}, pairing.Credential{}).CaptureCheckpoint(context.Background(), checkpoint.OperationID)
			absent := strings.HasPrefix(name, "missing")
			valid := name == "actual receipt"
			if (err == nil) != (absent || valid) || (result != nil) != valid {
				t.Fatal("incorrect checkpoint lookup classification", result, err)
			}
		})
	}
}

func TestPublisherRejectsIncompleteOrConflictingBindReceipts(t *testing.T) {
	for name, modify := range map[string]func(*bindView){
		"zero revision":      func(v *bindView) { v.Revision = 0; v.Artifact.ArtifactRevision = 0 },
		"different revision": func(v *bindView) { v.Artifact.ArtifactRevision++ },
		"different artifact": func(v *bindView) { v.Artifact.ArtifactID = "artifact_foreign0001" },
		"different content":  func(v *bindView) { other := "content_foreign0001"; v.Artifact.ContentID = &other },
	} {
		t.Run(name, func(t *testing.T) {
			input := captureInputFixture(t)
			contentID, artifactID := "content_capture0001", "artifact_capture0001"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasSuffix(r.URL.Path, "/bind") {
					var bound bindView
					bound.Revision = 7
					bound.Artifact.ArtifactRevision = 7
					bound.Artifact.ArtifactID = artifactID
					bound.Artifact.ContentID = &contentID
					modify(&bound)
					_ = json.NewEncoder(w).Encode(bound)
					return
				}
				_ = json.NewEncoder(w).Encode(publicationView{PublicationID: "publication_capture0001", State: "bound",
					ReceivedSize: len(input.Source.Bytes), ArtifactID: &artifactID, ContentID: &contentID})
			}))
			defer server.Close()
			client := NewClient(config.Config{ServerURL: server.URL}, pairing.Credential{})
			_, err := client.publishSource(context.Background(), PublishInput{RunID: input.Manifest.Scope.RunID,
				AgentID: input.Manifest.Scope.AgentID, ArtifactType: "patch", Title: input.Title, Summary: input.Summary},
				input.Source, nil, "lease_capture0001", "test", "")
			if err == nil {
				t.Fatal("accepted inconsistent bind receipt")
			}
		})
	}
}
