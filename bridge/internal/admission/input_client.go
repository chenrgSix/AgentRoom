package admission

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	"convenewire.dev/bridge/internal/repository"
	execution "convenewire.dev/contracts/generated/go/execution"
	runtimecontracts "convenewire.dev/contracts/generated/go/runtime"
)

const maxGovernedInputBytes int64 = 4 << 20

var ErrInputUnavailable = errors.New("governed execution input is unavailable")

// ExecutionInputClient loads only exact immutable patch bytes already admitted
// by the Server for one destination Run. It does not cache or materialize them.
type ExecutionInputClient struct {
	config     config.Config
	credential pairing.Credential
	httpClient *http.Client
}

var _ GovernedInputLoader = (*ExecutionInputClient)(nil)

func NewExecutionInputClient(cfg config.Config, credential pairing.Credential) *ExecutionInputClient {
	httpClient := *pairing.HTTPClientForCredential(cfg, credential)
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("governed execution input redirects are forbidden")
	}
	return &ExecutionInputClient{config: cfg, credential: credential, httpClient: &httpClient}
}

func (c *ExecutionInputClient) LoadPatches(ctx context.Context,
	manifest execution.GovernedExecutionManifest) ([]repository.PatchInput, error) {
	if c == nil || c.httpClient == nil || strings.TrimSpace(c.credential.Token) == "" ||
		c.credential.DeviceID == "" || c.credential.DeviceID != manifest.Scope.DeviceID {
		return nil, ErrAdmissionInvalid
	}
	base, err := governedServerBase(c.config.ServerURL, c.credential.ServerURL)
	if err != nil || !validExecutionInputManifest(manifest) {
		return nil, ErrAdmissionInvalid
	}
	seen := make(map[string]struct{}, len(manifest.Inputs))
	for _, binding := range manifest.Inputs {
		if _, exists := seen[binding.BindingID]; exists || !exactInputDestination(manifest, binding) ||
			binding.Artifact.Kind != execution.Patch || binding.Artifact.ByteLength < 1 ||
			binding.Artifact.ByteLength > maxGovernedInputBytes {
			return nil, ErrAdmissionInvalid
		}
		seen[binding.BindingID] = struct{}{}
	}
	inputs := make([]repository.PatchInput, 0, len(manifest.Inputs))
	for _, binding := range manifest.Inputs {
		input, err := c.loadPatch(ctx, base, manifest.Scope.RunID, binding)
		if err != nil {
			return nil, err
		}
		inputs = append(inputs, input)
	}
	return inputs, nil
}

func (c *ExecutionInputClient) loadPatch(ctx context.Context, base, run string,
	binding execution.GovernedExecutionManifestInput) (repository.PatchInput, error) {
	endpoint := base + "/api/bridge/runs/" + url.PathEscape(run) + "/execution-inputs/" +
		url.PathEscape(binding.BindingID) + "/content"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return repository.PatchInput{}, ErrAdmissionInvalid
	}
	request.Header.Set("authorization", "Bearer "+c.credential.Token)
	request.Header.Set("accept", "text/x-diff")
	if c.config.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, c.config.ServerToken)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return repository.PatchInput{}, ctx.Err()
		}
		return repository.PatchInput{}, fmt.Errorf("%w: %v", ErrInputUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode >= 500 {
			return repository.PatchInput{}, ErrInputUnavailable
		}
		return repository.PatchInput{}, ErrAdmissionNotCurrent
	}
	expectedLength := binding.Artifact.ByteLength
	if response.ContentLength != expectedLength || response.Uncompressed || response.Header.Get("content-encoding") != "" ||
		response.Header.Get("x-convenewire-input-id") != binding.BindingID ||
		response.Header.Get("x-convenewire-content-sha256") != binding.Artifact.ContentDigest ||
		response.Header.Get("x-content-type-options") != "nosniff" || response.Header.Get("cache-control") != "no-store" ||
		strings.Split(response.Header.Get("content-type"), ";")[0] != "text/x-diff" {
		return repository.PatchInput{}, ErrAdmissionChanged
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, expectedLength+1))
	if err != nil {
		return repository.PatchInput{}, ErrInputUnavailable
	}
	hash := sha256.Sum256(body)
	if int64(len(body)) != expectedLength || hex.EncodeToString(hash[:]) != binding.Artifact.ContentDigest {
		return repository.PatchInput{}, ErrAdmissionChanged
	}
	return repository.PatchInput{BindingID: binding.BindingID, SHA256: binding.Artifact.ContentDigest, Bytes: body}, nil
}

func validExecutionInputManifest(manifest execution.GovernedExecutionManifest) bool {
	raw, err := json.Marshal(manifest)
	if err != nil || runtimecontracts.ValidateExecutionCommand("executionManifest", raw) != nil {
		return false
	}
	manifestDigest, err := executionDigest(manifest, "manifestDigest")
	if err != nil || manifestDigest != manifest.ManifestDigest {
		return false
	}
	inputDigest, err := executionDigest(manifest.Inputs, "")
	return err == nil && inputDigest == manifest.InputDigest
}

func exactInputDestination(manifest execution.GovernedExecutionManifest,
	binding execution.GovernedExecutionManifestInput) bool {
	scope := manifest.Scope
	return binding.PlanID == scope.PlanID && binding.PlanRevision == scope.PlanRevision &&
		binding.RepositoryID != nil && *binding.RepositoryID == manifest.Repository.RepositoryID &&
		binding.DestinationTaskID == scope.TaskID &&
		binding.DestinationRunID == scope.RunID && binding.DestinationAgentID == scope.AgentID &&
		binding.DestinationDeviceID == scope.DeviceID
}
