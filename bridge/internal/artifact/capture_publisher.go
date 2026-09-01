package artifact

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

// CapturePublishInput is local adapter input, not a second wire schema. Source
// bytes must come from a retained capture; this client never reads a Workspace.
type CapturePublishInput struct {
	Manifest                execution.GovernedExecutionManifest
	Operation               execution.RepositoryOperationRequest
	SlotKey, Title, Summary string
	Source                  Source
}

// VerificationLogPublishInput is a local transport adapter. The log bytes are
// already bounded and sanitized by the independent verifier runner; this path
// never reads the verifier workspace or grants verification authority.
type VerificationLogPublishInput struct {
	Manifest                execution.GovernedExecutionManifest
	CaptureOperation        execution.RepositoryOperationRequest
	VerificationOperationID string
	Log                     []byte
}

// This is a projection of the existing WorkspaceLeaseRecord HTTP response.
// Lease metadata grants transport authority, not local filesystem permission.
type captureLeaseView struct {
	LeaseID             string `json:"leaseId"`
	CaptureOperationID  string `json:"captureOperationId"`
	Mode                string `json:"mode"`
	State               string `json:"state"`
	RoomID              string `json:"roomId"`
	TaskID              string `json:"taskId"`
	RunID               string `json:"runId"`
	AgentID             string `json:"agentId"`
	DeviceID            string `json:"deviceId"`
	WorkspaceRef        string `json:"workspaceRef"`
	WorkspaceGeneration string `json:"workspaceGeneration"`
	ExpiresAt           string `json:"expiresAt"`
}

func signedExecutionJSON(kind string, value any, digestField string) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	normalized, err := wire.ValidateAndNormalizeExecutionCommand(kind, raw)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(normalized, &fields); err != nil {
		return nil, err
	}
	var expected string
	if err := json.Unmarshal(fields[digestField], &expected); err != nil {
		return nil, err
	}
	delete(fields, digestField)
	unsigned, err := json.Marshal(fields)
	if err != nil {
		return nil, err
	}
	actual, err := wire.ExecutionDigest(unsigned)
	if err != nil || expected != actual {
		return nil, fmt.Errorf("Execution digest mismatch")
	}
	return normalized, nil
}

func sameExecutionJSON(left, right any) bool {
	a, err := json.Marshal(left)
	if err != nil {
		return false
	}
	b, err := json.Marshal(right)
	if err != nil {
		return false
	}
	a, err = wire.CanonicalExecutionJSON(a)
	if err != nil {
		return false
	}
	b, err = wire.CanonicalExecutionJSON(b)
	return err == nil && bytes.Equal(a, b)
}

// ValidateCaptureContext checks frozen wire identities, not current authority.
// The caller still owns local grant/Run fencing; Central rechecks its own state.
func ValidateCaptureContext(manifest execution.GovernedExecutionManifest, operation execution.RepositoryOperationRequest) error {
	if _, err := signedExecutionJSON("executionManifest", manifest, "manifestDigest"); err != nil {
		return err
	}
	if _, err := signedExecutionJSON("repositoryOperation", operation, "requestDigest"); err != nil {
		return err
	}
	inputs, err := json.Marshal(manifest.Inputs)
	if err != nil {
		return err
	}
	inputDigest, err := wire.ExecutionDigest(inputs)
	if err != nil || inputDigest != manifest.InputDigest || operation.Action.Kind != execution.Capture ||
		operation.Action.Capture == nil || operation.Action.Capture.ManifestDigest != manifest.ManifestDigest ||
		!sameExecutionJSON(operation.Execution, manifest.Scope) || !sameExecutionJSON(operation.Grant, manifest.Grant) ||
		operation.RepositoryID != manifest.Repository.RepositoryID || operation.BindingID != manifest.Repository.BindingID ||
		operation.DeviceID != manifest.Scope.DeviceID || operation.Plan.PlanID != manifest.Scope.PlanID ||
		operation.Plan.Revision != manifest.Scope.PlanRevision || operation.Plan.Digest != manifest.Scope.PlanDigest ||
		operation.Plan.ApprovalOperationID != manifest.Scope.ApprovalOperationID || operation.Plan.RoomID != manifest.Scope.RoomID ||
		manifest.Repository.GrantID != manifest.Grant.GrantID || manifest.Repository.GrantRevision != manifest.Grant.Revision {
		return fmt.Errorf("Capture context does not match its frozen manifest")
	}
	deadline, err := time.Parse(time.RFC3339Nano, operation.Deadline)
	if err != nil {
		return err
	}
	issued, err := time.Parse(time.RFC3339Nano, manifest.Workspace.IssuedAt)
	if err != nil || !deadline.After(issued) {
		return fmt.Errorf("Capture deadline is invalid")
	}
	for _, ceiling := range []string{manifest.Deadline, manifest.Grant.ExpiresAt, manifest.Workspace.ExpiresAt} {
		limit, err := time.Parse(time.RFC3339Nano, ceiling)
		if err != nil || deadline.After(limit) {
			return fmt.Errorf("Capture deadline exceeds its authority")
		}
	}
	return nil
}

func (c *Client) PublishCapture(ctx context.Context, input CapturePublishInput) (PublishResult, error) {
	if err := ValidateCaptureContext(input.Manifest, input.Operation); err != nil {
		return PublishResult{}, err
	}
	var kind string
	for _, slot := range input.Manifest.Outputs {
		if slot.SlotKey == input.SlotKey {
			if kind != "" {
				return PublishResult{}, fmt.Errorf("Capture output slot is ambiguous")
			}
			kind = string(slot.Kind)
		}
	}
	if kind == "" || strings.TrimSpace(input.Title) == "" || strings.TrimSpace(input.Summary) == "" ||
		len(input.Title) > 160 || len(input.Summary) > 4000 {
		return PublishResult{}, fmt.Errorf("Capture output description is invalid")
	}
	source := input.Source
	source.Bytes = bytes.Clone(source.Bytes)
	if err := validateSource(source, kind); err != nil {
		return PublishResult{}, err
	}
	if source.WorkspaceRef != input.Manifest.Workspace.WorkspaceRef ||
		source.WorkspaceGeneration != input.Operation.ExpectedGeneration {
		return PublishResult{}, fmt.Errorf("Capture source does not match its frozen workspace")
	}
	lease, err := c.captureLease(ctx, input.Manifest, input.Operation)
	if err != nil {
		return PublishResult{}, err
	}
	scope := input.Manifest.Scope
	return c.publishSource(ctx, PublishInput{RunID: scope.RunID, AgentID: scope.AgentID,
		ArtifactType: kind, Title: input.Title, Summary: input.Summary}, source, nil, lease.LeaseID,
		input.Operation.OperationID+":"+input.SlotKey, "")
}

func (c *Client) PublishVerificationLog(ctx context.Context,
	input VerificationLogPublishInput) (PublishResult, error) {
	if err := ValidateCaptureContext(input.Manifest, input.CaptureOperation); err != nil {
		return PublishResult{}, err
	}
	if !validWireID(input.VerificationOperationID, "op_") || len(input.Log) == 0 ||
		len(input.Log) > MaximumSourceBytes {
		return PublishResult{}, fmt.Errorf("Verification log input is invalid")
	}
	lease, err := c.captureLease(ctx, input.Manifest, input.CaptureOperation)
	if err != nil {
		return PublishResult{}, err
	}
	hash := sha256.Sum256(input.Log)
	source := Source{Bytes: bytes.Clone(input.Log), FileName: "verification.json",
		MediaType: "application/json", SHA256: hex.EncodeToString(hash[:]),
		WorkspaceRef:        input.Manifest.Workspace.WorkspaceRef,
		WorkspaceGeneration: input.Manifest.Workspace.WorkspaceGeneration}
	scope := input.Manifest.Scope
	return c.publishSource(ctx, PublishInput{RunID: scope.RunID, AgentID: scope.AgentID,
		ArtifactType: "test_result", Title: "Independent verification log",
		Summary: "Bounded output from the admitted Bridge verifier"}, source, nil,
		lease.LeaseID, "verification:"+input.VerificationOperationID,
		input.VerificationOperationID)
}

func (c *Client) captureLease(ctx context.Context, manifest execution.GovernedExecutionManifest,
	operation execution.RepositoryOperationRequest) (captureLeaseView, error) {
	var raw json.RawMessage
	if err := c.retrySameRequest(ctx, http.MethodPost, "/api/bridge/repository-captures", operation, &raw); err != nil {
		return captureLeaseView{}, err
	}
	canonical, err := wire.CanonicalExecutionJSON(raw)
	if err != nil {
		return captureLeaseView{}, err
	}
	var lease captureLeaseView
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(canonical, &fields); err != nil {
		return captureLeaseView{}, err
	}
	// Project only exact field spellings. Extra Server lease metadata may remain,
	// but encoding/json case aliases cannot override an authoritative pin.
	for key, target := range map[string]*string{"leaseId": &lease.LeaseID, "captureOperationId": &lease.CaptureOperationID,
		"mode": &lease.Mode, "state": &lease.State, "roomId": &lease.RoomID, "taskId": &lease.TaskID,
		"runId": &lease.RunID, "agentId": &lease.AgentID, "deviceId": &lease.DeviceID,
		"workspaceRef": &lease.WorkspaceRef, "workspaceGeneration": &lease.WorkspaceGeneration, "expiresAt": &lease.ExpiresAt} {
		if err := json.Unmarshal(fields[key], target); err != nil {
			return captureLeaseView{}, fmt.Errorf("Capture lease field is invalid")
		}
	}
	scope := manifest.Scope
	if !validWireID(lease.LeaseID, "lease_") || lease.Mode != "read_capture" || lease.State != "active" ||
		lease.CaptureOperationID != operation.OperationID || lease.RoomID != scope.RoomID || lease.TaskID != scope.TaskID ||
		lease.RunID != scope.RunID || lease.AgentID != scope.AgentID || lease.DeviceID != scope.DeviceID ||
		lease.WorkspaceRef != manifest.Workspace.WorkspaceRef ||
		lease.WorkspaceGeneration != manifest.Workspace.WorkspaceGeneration || lease.ExpiresAt != operation.Deadline {
		return captureLeaseView{}, fmt.Errorf("Capture lease does not match the authorized operation")
	}
	return lease, nil
}

func validWireID(value, prefix string) bool {
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	return validPublicationArtifactID("artifact_" + strings.TrimPrefix(value, prefix))
}

func decodeCheckpoint(raw []byte) (execution.RepositoryCheckpoint, error) {
	normalized, err := wire.ValidateAndNormalizeExecutionCommand("executionCheckpoint", raw)
	if err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	var checkpoint execution.RepositoryCheckpoint
	if err := json.Unmarshal(normalized, &checkpoint); err != nil {
		return checkpoint, err
	}
	_, err = signedExecutionJSON("executionCheckpoint", checkpoint, "digest")
	return checkpoint, err
}

func (c *Client) CaptureCheckpoint(ctx context.Context, operationID string) (*execution.RepositoryCheckpoint, error) {
	if !validWireID(operationID, "op_") {
		return nil, fmt.Errorf("Capture operation identity is invalid")
	}
	var raw json.RawMessage
	err := c.retrySameRequest(ctx, http.MethodGet,
		"/api/bridge/repository-captures/"+url.PathEscape(operationID)+"/checkpoint", nil, &raw)
	if err != nil {
		var rejected apiError
		if errors.As(err, &rejected) && rejected.status == http.StatusNotFound &&
			(rejected.code == "REPOSITORY_CAPTURE_NOT_FOUND" || rejected.code == "REPOSITORY_CHECKPOINT_NOT_FOUND") {
			return nil, nil
		}
		return nil, err
	}
	checkpoint, err := decodeCheckpoint(raw)
	if err != nil {
		return nil, err
	}
	if checkpoint.OperationID != operationID {
		return nil, fmt.Errorf("Capture checkpoint identity changed")
	}
	return &checkpoint, nil
}

func (c *Client) SealCaptureCheckpoint(ctx context.Context, checkpoint execution.RepositoryCheckpoint) (execution.RepositoryCheckpoint, error) {
	if _, err := signedExecutionJSON("executionCheckpoint", checkpoint, "digest"); err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	var raw json.RawMessage
	err := c.request(ctx, http.MethodPost, "/api/bridge/repository-checkpoints", checkpoint, &raw)
	if err != nil && isOutcomeUnknown(err) {
		observed, lookupErr := c.CaptureCheckpoint(ctx, checkpoint.OperationID)
		if lookupErr == nil && observed != nil && sameExecutionJSON(observed, checkpoint) {
			return *observed, nil
		}
	}
	if err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	result, err := decodeCheckpoint(raw)
	if err != nil {
		return execution.RepositoryCheckpoint{}, err
	}
	if !sameExecutionJSON(result, checkpoint) {
		return execution.RepositoryCheckpoint{}, fmt.Errorf("Capture checkpoint receipt changed")
	}
	return result, nil
}
