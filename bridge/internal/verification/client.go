package verification

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"convenewire.dev/bridge/internal/artifact"
	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	execution "convenewire.dev/contracts/generated/go/execution"
	wire "convenewire.dev/contracts/generated/go/runtime"
)

type Admission struct {
	OperationID   string `json:"operationId"`
	RequestDigest string `json:"requestDigest"`
	AdmittedAt    string `json:"admittedAt"`
	Deadline      string `json:"deadline"`
}

type RetainedReceipt struct {
	Receipt       execution.VerificationReceipt `json:"receipt"`
	ReceiptDigest string                        `json:"receiptDigest"`
	RecordedAt    string                        `json:"recordedAt"`
}

type clientOutcomeUnknown struct{ cause error }

func (e clientOutcomeUnknown) Error() string {
	return "verification API outcome is unknown: " + e.cause.Error()
}

type Client struct {
	config     config.Config
	credential pairing.Credential
	httpClient *http.Client
	artifacts  *artifact.Client
}

func NewClient(cfg config.Config, credential pairing.Credential) *Client {
	return &Client{config: cfg, credential: credential,
		httpClient: pairing.HTTPClientForCredential(cfg, credential),
		artifacts:  artifact.NewClient(cfg, credential)}
}

func (c *Client) Begin(ctx context.Context,
	request execution.RepositoryOperationRequest) (Admission, error) {
	var admission Admission
	if err := validateSigned("repositoryOperation", request, "requestDigest"); err != nil ||
		request.Action.Kind != execution.Verify || request.Action.Verify == nil {
		return admission, ErrProfileInvalid
	}
	err := c.request(ctx, http.MethodPost, "/api/bridge/repository-verifications", request, &admission)
	if isClientOutcomeUnknown(err) {
		err = c.request(ctx, http.MethodPost, "/api/bridge/repository-verifications", request, &admission)
	}
	if err != nil {
		return Admission{}, err
	}
	if admission.OperationID != request.OperationID || admission.RequestDigest != request.RequestDigest ||
		admission.Deadline != request.Deadline || admission.AdmittedAt == "" {
		return Admission{}, errors.New("verification admission response changed")
	}
	return admission, nil
}

func (c *Client) PublishLog(ctx context.Context, manifest execution.GovernedExecutionManifest,
	captureOperation execution.RepositoryOperationRequest, verificationOperationID string,
	log []byte) (artifact.PublishResult, error) {
	return c.artifacts.PublishVerificationLog(ctx, artifact.VerificationLogPublishInput{
		Manifest: manifest, CaptureOperation: captureOperation,
		VerificationOperationID: verificationOperationID, Log: log,
	})
}

func (c *Client) Retain(ctx context.Context,
	receipt execution.VerificationReceipt) (RetainedReceipt, error) {
	var retained RetainedReceipt
	if err := validateReceipt(receipt); err != nil {
		return retained, err
	}
	err := c.request(ctx, http.MethodPost, "/api/bridge/verification-receipts", receipt, &retained)
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
	if !strings.HasPrefix(operationID, "op_") {
		return retained, ErrProfileInvalid
	}
	err := c.request(ctx, http.MethodGet,
		"/api/bridge/repository-verifications/"+url.PathEscape(operationID)+"/receipt", nil, &retained)
	if err != nil {
		return RetainedReceipt{}, err
	}
	if retained.Receipt.OperationID != operationID {
		return RetainedReceipt{}, errors.New("verification receipt lookup changed identity")
	}
	if err := matchRetained(retained, retained.Receipt); err != nil {
		return RetainedReceipt{}, err
	}
	return retained, nil
}

func matchRetained(retained RetainedReceipt, expected execution.VerificationReceipt) error {
	if retained.RecordedAt == "" || !sameCanonical(retained.Receipt, expected) ||
		retained.ReceiptDigest == "" {
		return errors.New("verification receipt response changed")
	}
	raw, err := json.Marshal(retained.Receipt)
	if err != nil {
		return err
	}
	digest, err := wire.ExecutionDigest(raw)
	if err != nil || digest != retained.ReceiptDigest {
		return errors.New("verification receipt digest changed")
	}
	return validateReceipt(retained.Receipt)
}

func validateReceipt(receipt execution.VerificationReceipt) error {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	_, err = wire.ValidateAndNormalizeExecutionCommand("verificationReceipt", raw)
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
		return errors.New("verification request digest changed")
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

func (c *Client) request(ctx context.Context, method, requestPath string,
	input, output any) error {
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
		return fmt.Errorf("verification API rejected request with status %d", response.StatusCode)
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
