package admission

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
	"time"

	"convenewire.dev/bridge/internal/config"
	"convenewire.dev/bridge/internal/pairing"
	execution "convenewire.dev/contracts/generated/go/execution"
	runtimecontracts "convenewire.dev/contracts/generated/go/runtime"
)

var ErrAuthorityUnavailable = errors.New("governed Runtime authority observation is unavailable")

type RuntimeAuthorityView = execution.RuntimeAuthorityView

type RuntimeAuthorityClient struct {
	config     config.Config
	credential pairing.Credential
	httpClient *http.Client
}

func NewRuntimeAuthorityClient(cfg config.Config, credential pairing.Credential) *RuntimeAuthorityClient {
	return &RuntimeAuthorityClient{config: cfg, credential: credential,
		httpClient: pairing.HTTPClientForCredential(cfg, credential)}
}

// Check observes Server authority once and binds the response to the exact
// local admission. It creates, extends and caches no authority.
func (c *RuntimeAuthorityClient) Check(ctx context.Context, spec RuntimeAdmissionSpec) (RuntimeAuthorityView, error) {
	var view RuntimeAuthorityView
	if c == nil || c.httpClient == nil || !validRuntimeAdmissionSpec(spec) || strings.TrimSpace(c.credential.Token) == "" {
		return view, ErrAdmissionInvalid
	}
	endpoint, err := runtimeAuthorityEndpoint(c.config.ServerURL, c.credential.ServerURL)
	if err != nil {
		return view, ErrAdmissionInvalid
	}
	input := execution.RuntimeAuthorityRequest{Version: 1, RunID: spec.RunID, LeaseID: spec.LeaseID,
		ManifestDigest: spec.ManifestDigest, WorkspaceRef: spec.WorkspaceRef, WorkspaceGeneration: spec.WorkspaceGeneration}
	raw, err := json.Marshal(input)
	if err != nil || runtimecontracts.ValidateExecutionCommand("runtimeAuthorityRequest", raw) != nil {
		return view, ErrAdmissionInvalid
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	if err != nil {
		return view, ErrAdmissionInvalid
	}
	request.Header.Set("authorization", "Bearer "+c.credential.Token)
	request.Header.Set("content-type", "application/json")
	if c.config.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, c.config.ServerToken)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return view, fmt.Errorf("%w: %v", ErrAuthorityUnavailable, err)
	}
	defer response.Body.Close()
	source, err := io.ReadAll(io.LimitReader(response.Body, (32<<10)+1))
	if err != nil || len(source) > 32<<10 {
		return view, ErrAuthorityUnavailable
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode >= 500 {
			return view, ErrAuthorityUnavailable
		}
		return view, ErrAdmissionNotCurrent
	}
	normalized, err := runtimecontracts.ValidateAndNormalizeExecutionCommand("runtimeAuthorityView", source)
	if err != nil || json.Unmarshal(normalized, &view) != nil {
		return RuntimeAuthorityView{}, ErrAdmissionChanged
	}
	checkedAt, checkedErr := time.Parse(time.RFC3339Nano, view.CheckedAt)
	if checkedErr != nil || view.Version != 1 || view.RunID != spec.RunID || view.LeaseID != spec.LeaseID ||
		view.ManifestDigest != spec.ManifestDigest || view.WorkspaceRef != spec.WorkspaceRef ||
		view.WorkspaceGeneration != spec.WorkspaceGeneration || view.State != "active" || view.LeaseRevision != 1 ||
		view.ExpiresAt != spec.WorkspaceExpiresAt || !runtimeAdmissionCurrent(spec, checkedAt) {
		return RuntimeAuthorityView{}, ErrAdmissionChanged
	}
	return view, nil
}

func runtimeAuthorityEndpoint(configured, credential string) (string, error) {
	base, err := governedServerBase(configured, credential)
	if err != nil {
		return "", err
	}
	return base + "/api/bridge/governed-runtime-authority", nil
}

func governedServerBase(configured, credential string) (string, error) {
	configured = strings.TrimRight(strings.TrimSpace(configured), "/")
	credential = strings.TrimRight(strings.TrimSpace(credential), "/")
	if configured == "" || credential == "" || configured != credential {
		return "", ErrAdmissionInvalid
	}
	parsed, err := url.Parse(configured)
	if err != nil || parsed.User != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		(parsed.Scheme != "https" && !(parsed.Scheme == "http" &&
			(parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "localhost" || parsed.Hostname() == "::1"))) {
		return "", ErrAdmissionInvalid
	}
	return configured, nil
}
