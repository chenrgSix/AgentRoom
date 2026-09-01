package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

var (
	ErrInvalid  = errors.New("integration evidence is invalid")
	ErrChanged  = errors.New("integration evidence changed")
	ErrConflict = errors.New("integration journal already contains different evidence")
)

var hexDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Admission struct {
	Operation      execution.RepositoryOperationRequest `json:"operation"`
	Checkpoint     execution.RepositoryCheckpoint       `json:"checkpoint"`
	ApprovalDigest string                               `json:"approvalDigest"`
	AdmittedAt     string                               `json:"admittedAt"`
}

type RetainedReceipt struct {
	Receipt       execution.RepositoryOperationReceipt `json:"receipt"`
	ReceiptDigest string                               `json:"receiptDigest"`
	RecordedAt    string                               `json:"recordedAt"`
}

type clientOutcomeUnknown struct{ cause error }

func (e clientOutcomeUnknown) Error() string {
	return "integration API outcome is unknown: " + e.cause.Error()
}

type Client struct {
	config     config.Config
	credential pairing.Credential
	httpClient *http.Client
}

func NewClient(cfg config.Config, credential pairing.Credential) *Client {
	return &Client{config: cfg, credential: credential,
		httpClient: pairing.HTTPClientForCredential(cfg, credential)}
}

func (c *Client) Get(ctx context.Context, operationID string) (Admission, error) {
	var admission Admission
	if !validOperationID(operationID) {
		return admission, ErrInvalid
	}
	err := c.request(ctx, http.MethodGet,
		"/api/bridge/repository-integrations/"+url.PathEscape(operationID), nil, &admission)
	if err != nil {
		return Admission{}, err
	}
	if admission.Operation.OperationID != operationID || !validAdmission(admission) {
		return Admission{}, ErrChanged
	}
	return admission, nil
}

func (c *Client) Retain(ctx context.Context,
	receipt execution.RepositoryOperationReceipt) (RetainedReceipt, error) {
	var retained RetainedReceipt
	if validateReceipt(receipt) != nil {
		return retained, ErrInvalid
	}
	err := c.request(ctx, http.MethodPost, "/api/bridge/integration-receipts", receipt, &retained)
	if isClientOutcomeUnknown(err) {
		observed, lookupErr := c.Lookup(ctx, receipt.OperationID)
		if lookupErr == nil && sameCanonical(observed.Receipt, receipt) {
			return observed, nil
		}
	}
	if err != nil {
		return RetainedReceipt{}, err
	}
	if err := matchRetained(retained, receipt); err != nil {
		return RetainedReceipt{}, err
	}
	return retained, nil
}

func (c *Client) Lookup(ctx context.Context, operationID string) (RetainedReceipt, error) {
	var retained RetainedReceipt
	if !validOperationID(operationID) {
		return retained, ErrInvalid
	}
	err := c.request(ctx, http.MethodGet,
		"/api/bridge/repository-integrations/"+url.PathEscape(operationID)+"/receipt", nil, &retained)
	if err != nil {
		return RetainedReceipt{}, err
	}
	if retained.Receipt.OperationID != operationID || matchRetained(retained, retained.Receipt) != nil {
		return RetainedReceipt{}, ErrChanged
	}
	return retained, nil
}

func matchRetained(retained RetainedReceipt, expected execution.RepositoryOperationReceipt) error {
	if retained.RecordedAt == "" || retained.ReceiptDigest == "" || !sameCanonical(retained.Receipt, expected) {
		return ErrChanged
	}
	raw, err := json.Marshal(retained.Receipt)
	if err != nil {
		return err
	}
	digest, err := wire.ExecutionDigest(raw)
	if err != nil || digest != retained.ReceiptDigest || validateReceipt(retained.Receipt) != nil {
		return ErrChanged
	}
	return nil
}

func validAdmission(admission Admission) bool {
	operation, checkpoint := admission.Operation, admission.Checkpoint
	admittedAt, admittedErr := time.Parse(time.RFC3339Nano, admission.AdmittedAt)
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, operation.Deadline)
	if !hexDigest.MatchString(admission.ApprovalDigest) || admittedErr != nil || deadlineErr != nil || admittedAt.After(deadline) ||
		validateSigned("repositoryOperation", operation, "requestDigest") != nil ||
		validateSigned("executionCheckpoint", checkpoint, "digest") != nil ||
		operation.Action.Kind != execution.Integrate || operation.Action.Integrate == nil || operation.Execution == nil {
		return false
	}
	action := operation.Action.Integrate
	return operation.RepositoryID == checkpoint.RepositoryID && operation.BindingID == checkpoint.BindingID &&
		operation.DeviceID == operation.Execution.DeviceID && operation.ExpectedGeneration == checkpoint.WorkspaceGeneration &&
		action.CandidateCommit == checkpoint.CandidateCommit && action.CandidateTree == checkpoint.CandidateTree &&
		action.InputDigest == checkpoint.InputDigest && checkpoint.Scope == execution.RepositoryCheckpointScope(*operation.Execution)
}

func validateReceipt(receipt execution.RepositoryOperationReceipt) error {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	_, err = wire.ValidateAndNormalizeExecutionCommand("repositoryReceipt", raw)
	return err
}

func validateSigned(kind string, value any, field string) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if _, err := wire.ValidateAndNormalizeExecutionCommand(kind, raw); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	var expected string
	if err := json.Unmarshal(fields[field], &expected); err != nil {
		return err
	}
	delete(fields, field)
	unsigned, _ := json.Marshal(fields)
	digest, err := wire.ExecutionDigest(unsigned)
	if err != nil || digest != expected {
		return ErrChanged
	}
	return nil
}

func sameCanonical(left, right any) bool {
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

func validOperationID(value string) bool {
	return strings.HasPrefix(value, "op_") && len(value) >= 11 && len(value) <= 131 && !strings.ContainsAny(value, `/\\`)
}

func (c *Client) request(ctx context.Context, method, requestPath string, input, output any) error {
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method,
		strings.TrimRight(c.config.ServerURL, "/")+requestPath, body)
	if err != nil {
		return err
	}
	request.Header.Set("authorization", "Bearer "+c.credential.Token)
	if input != nil {
		request.Header.Set("content-type", "application/json")
	}
	if c.config.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, c.config.ServerToken)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return clientOutcomeUnknown{cause: err}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return clientOutcomeUnknown{cause: err}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("integration API rejected request with status %d", response.StatusCode)
	}
	if output == nil {
		return nil
	}
	if err := json.Unmarshal(raw, output); err != nil {
		return clientOutcomeUnknown{cause: err}
	}
	return nil
}

func isClientOutcomeUnknown(err error) bool {
	var unknown clientOutcomeUnknown
	return errors.As(err, &unknown)
}
