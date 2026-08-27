package result

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/pairing"
	workcontracts "agentroom.dev/contracts/generated/go/work"
)

const maximumProposalJSONBytes = 64 << 10

var opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

type ProposeInput struct {
	AgentID  string
	RunID    string
	Proposal workcontracts.ResultProposal
}

type Client struct {
	config     config.Config
	credential pairing.Credential
	httpClient *http.Client
}

type outcomeUnknownError struct{ cause error }

func (e outcomeUnknownError) Error() string {
	return "Result proposal outcome is unknown: " + e.cause.Error()
}

func NewClient(cfg config.Config, credential pairing.Credential) *Client {
	return &Client{
		config: cfg, credential: credential, httpClient: pairing.HTTPClient(cfg),
	}
}

func ParseProposal(source string) (workcontracts.ResultProposal, error) {
	if len(source) == 0 || len(source) > maximumProposalJSONBytes {
		return workcontracts.ResultProposal{}, fmt.Errorf(
			"Result proposal JSON must contain 1 to %d bytes",
			maximumProposalJSONBytes,
		)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(source), &fields); err != nil {
		return workcontracts.ResultProposal{}, fmt.Errorf("decode Result proposal: %w", err)
	}
	required := []string{
		"operationId", "taskId", "definitionRevision", "criteriaRevision",
		"proposedAtTaskRevision", "supersedesResultId", "outcome", "summary",
		"risks", "openQuestions", "nextActions", "sources", "criterionClaims",
	}
	for _, field := range required {
		if _, ok := fields[field]; !ok {
			return workcontracts.ResultProposal{}, fmt.Errorf(
				"Result proposal omitted required field %s",
				field,
			)
		}
	}
	decoder := json.NewDecoder(strings.NewReader(source))
	decoder.DisallowUnknownFields()
	var proposal workcontracts.ResultProposal
	if err := decoder.Decode(&proposal); err != nil {
		return workcontracts.ResultProposal{}, fmt.Errorf("decode Result proposal: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return workcontracts.ResultProposal{}, fmt.Errorf("Result proposal has trailing JSON")
	}
	if err := ValidateProposal(proposal); err != nil {
		return workcontracts.ResultProposal{}, err
	}
	return proposal, nil
}

func ValidateProposal(proposal workcontracts.ResultProposal) error {
	if !validID(proposal.OperationID, "op") || !validID(proposal.TaskID, "task") {
		return fmt.Errorf("Result operation or Task identity is invalid")
	}
	if proposal.DefinitionRevision < 1 || proposal.CriteriaRevision < 1 ||
		proposal.ProposedAtTaskRevision < 1 {
		return fmt.Errorf("Result revisions must be positive")
	}
	if proposal.SupersedesResultID != nil &&
		!validID(*proposal.SupersedesResultID, "result") {
		return fmt.Errorf("Superseded Result identity is invalid")
	}
	if proposal.Outcome != workcontracts.OutcomeSatisfied &&
		proposal.Outcome != workcontracts.Partial &&
		proposal.Outcome != workcontracts.OutcomeNotSatisfied &&
		proposal.Outcome != workcontracts.Informational {
		return fmt.Errorf("Result outcome is invalid")
	}
	if err := boundedText(proposal.Summary, "Result summary", 20_000); err != nil {
		return err
	}
	if err := boundedTextList(proposal.Risks, "Result risks", 50, 2_000); err != nil {
		return err
	}
	if err := boundedTextList(
		proposal.OpenQuestions,
		"Result open questions",
		50,
		2_000,
	); err != nil {
		return err
	}
	if proposal.NextActions == nil || len(proposal.NextActions) > 50 {
		return fmt.Errorf("Result next actions must contain at most 50 entries")
	}
	nextActionKeys := make(map[string]bool, len(proposal.NextActions))
	for _, action := range proposal.NextActions {
		if !validID(action.NextActionKey, "next") ||
			nextActionKeys[action.NextActionKey] {
			return fmt.Errorf("Result next action identities must be valid and unique")
		}
		nextActionKeys[action.NextActionKey] = true
		if err := boundedText(action.Description, "Result next action", 2_000); err != nil {
			return err
		}
	}
	if len(proposal.Sources) < 1 || len(proposal.Sources) > 100 {
		return fmt.Errorf("Result sources must contain 1 to 100 entries")
	}
	evidenceIDs := make(map[string]bool, len(proposal.Sources))
	for _, source := range proposal.Sources {
		if !validID(source.EvidenceRefID, "evidence") ||
			evidenceIDs[source.EvidenceRefID] {
			return fmt.Errorf("Result evidence identities must be valid and unique")
		}
		evidenceIDs[source.EvidenceRefID] = true
		if err := validateSource(source); err != nil {
			return err
		}
	}
	if proposal.CriterionClaims == nil || len(proposal.CriterionClaims) > 100 {
		return fmt.Errorf("Result criterion claims must contain at most 100 entries")
	}
	criterionKeys := make(map[string]bool, len(proposal.CriterionClaims))
	for _, claim := range proposal.CriterionClaims {
		if !validID(claim.CriterionKey, "criterion") ||
			criterionKeys[claim.CriterionKey] {
			return fmt.Errorf("Result criterion identities must be valid and unique")
		}
		criterionKeys[claim.CriterionKey] = true
		if claim.Coverage != workcontracts.CoverageSatisfied &&
			claim.Coverage != workcontracts.Unresolved &&
			claim.Coverage != workcontracts.CoverageNotSatisfied &&
			claim.Coverage != workcontracts.NotApplicable {
			return fmt.Errorf("Result criterion coverage is invalid")
		}
		if err := boundedText(
			claim.Explanation,
			"Result criterion explanation",
			4_000,
		); err != nil {
			return err
		}
		if claim.EvidenceRefIDS == nil || len(claim.EvidenceRefIDS) > 100 {
			return fmt.Errorf("Result criterion evidence exceeds its bound")
		}
		seen := make(map[string]bool, len(claim.EvidenceRefIDS))
		for _, evidenceID := range claim.EvidenceRefIDS {
			if !evidenceIDs[evidenceID] || seen[evidenceID] {
				return fmt.Errorf(
					"Result criterion evidence must reference unique proposal sources",
				)
			}
			seen[evidenceID] = true
		}
	}
	return nil
}

func (c *Client) Propose(
	ctx context.Context,
	input ProposeInput,
) (workcontracts.ResultProjection, error) {
	if !validID(input.AgentID, "agent") || !validID(input.RunID, "run") {
		return workcontracts.ResultProjection{}, fmt.Errorf(
			"Managed Result Agent or Run identity is invalid",
		)
	}
	if err := ValidateProposal(input.Proposal); err != nil {
		return workcontracts.ResultProjection{}, err
	}
	hasOwnRunEvent := false
	for _, source := range input.Proposal.Sources {
		if source.Kind == workcontracts.RunEvent {
			if source.RunID == nil || *source.RunID != input.RunID {
				return workcontracts.ResultProjection{}, fmt.Errorf(
					"Managed Result must cite only its selected Run events",
				)
			}
			hasOwnRunEvent = true
		}
	}
	if !hasOwnRunEvent {
		return workcontracts.ResultProjection{}, fmt.Errorf(
			"Managed Result must cite its selected Run event",
		)
	}
	payload := struct {
		ActorKind string                       `json:"actorKind"`
		AgentID   string                       `json:"agentId"`
		RunID     string                       `json:"runId"`
		Proposal  workcontracts.ResultProposal `json:"proposal"`
	}{
		ActorKind: "managed_agent",
		AgentID:   input.AgentID,
		RunID:     input.RunID,
		Proposal:  input.Proposal,
	}
	var result workcontracts.ResultProjection
	if err := c.retrySameRequest(
		ctx,
		http.MethodPost,
		"/api/bridge/results",
		payload,
		&result,
	); err != nil {
		return workcontracts.ResultProjection{}, err
	}
	if !validID(result.ResultID, "result") || result.TaskID != input.Proposal.TaskID ||
		result.Proposal.OperationID != input.Proposal.OperationID {
		return workcontracts.ResultProjection{}, fmt.Errorf(
			"Result proposal response identity is invalid",
		)
	}
	return result, nil
}

func validateSource(source workcontracts.ResultProposalSource) error {
	valid := false
	switch source.Kind {
	case workcontracts.Artifact:
		valid = source.ArtifactID != nil && validID(*source.ArtifactID, "artifact") &&
			source.RunID == nil && source.Sequence == nil && source.MessageID == nil &&
			source.MemoryID == nil && source.DiscussionID == nil
	case workcontracts.RunEvent:
		valid = source.RunID != nil && validID(*source.RunID, "run") &&
			source.Sequence != nil && *source.Sequence > 0 && source.ArtifactID == nil &&
			source.MessageID == nil && source.MemoryID == nil && source.DiscussionID == nil
	case workcontracts.Message:
		valid = source.MessageID != nil && validID(*source.MessageID, "msg") &&
			source.ArtifactID == nil && source.RunID == nil && source.Sequence == nil &&
			source.MemoryID == nil && source.DiscussionID == nil
	case workcontracts.Memory:
		valid = source.MemoryID != nil && validID(*source.MemoryID, "memory") &&
			source.ArtifactID == nil && source.RunID == nil && source.Sequence == nil &&
			source.MessageID == nil && source.DiscussionID == nil
	case workcontracts.Discussion:
		valid = source.DiscussionID != nil && validID(*source.DiscussionID, "discussion") &&
			source.ArtifactID == nil && source.RunID == nil && source.Sequence == nil &&
			source.MessageID == nil && source.MemoryID == nil
	}
	if !valid {
		return fmt.Errorf("Result evidence source is invalid")
	}
	return nil
}

func (c *Client) retrySameRequest(
	ctx context.Context,
	method string,
	requestPath string,
	input any,
	output any,
) error {
	err := c.request(ctx, method, requestPath, input, output)
	var unknown outcomeUnknownError
	if errors.As(err, &unknown) {
		return c.request(ctx, method, requestPath, input, output)
	}
	return err
}

func (c *Client) request(
	ctx context.Context,
	method string,
	requestPath string,
	input any,
	output any,
) error {
	source, err := json.Marshal(input)
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(c.config.ServerURL, "/") + requestPath
	request, err := http.NewRequestWithContext(
		ctx,
		method,
		endpoint,
		bytes.NewReader(source),
	)
	if err != nil {
		return err
	}
	request.Header.Set("authorization", "Bearer "+c.credential.Token)
	request.Header.Set("content-type", "application/json")
	if c.config.ServerToken != "" {
		request.Header.Set(config.ServerTokenHeader, c.config.ServerToken)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return outcomeUnknownError{cause: err}
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return outcomeUnknownError{cause: err}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var rejected struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &rejected)
		message := strings.TrimSpace(rejected.Error.Message)
		if message == "" {
			message = http.StatusText(response.StatusCode)
		}
		return fmt.Errorf(
			"Result API rejected request with status %d: %s",
			response.StatusCode,
			message,
		)
	}
	if err := json.Unmarshal(body, output); err != nil {
		return outcomeUnknownError{cause: fmt.Errorf("decode Result API response: %w", err)}
	}
	return nil
}

func validID(value string, prefix string) bool {
	wanted := prefix + "_"
	return strings.HasPrefix(value, wanted) &&
		opaqueIDPattern.MatchString(strings.TrimPrefix(value, wanted))
}

func boundedText(value string, label string, maximum int) error {
	if strings.TrimSpace(value) == "" || len(value) > maximum {
		return fmt.Errorf("%s must contain 1 to %d bytes", label, maximum)
	}
	return nil
}

func boundedTextList(
	values []string,
	label string,
	maximumItems int,
	maximumLength int,
) error {
	if values == nil || len(values) > maximumItems {
		return fmt.Errorf("%s exceeds its item bound", label)
	}
	for _, value := range values {
		if err := boundedText(value, label, maximumLength); err != nil {
			return err
		}
	}
	return nil
}
