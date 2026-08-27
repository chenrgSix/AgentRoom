package result

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"agentroom.dev/bridge/internal/config"
	"agentroom.dev/bridge/internal/pairing"
	workcontracts "agentroom.dev/contracts/generated/go/work"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestParseProposalRejectsLocalAndUnknownFields(t *testing.T) {
	withLocalPath := `{
		"operationId":"op_result_parse_0001",
		"taskId":"task_result_parse_0001",
		"definitionRevision":1,
		"criteriaRevision":1,
		"proposedAtTaskRevision":1,
		"supersedesResultId":null,
		"outcome":"informational",
		"summary":"Explicit proposal.",
		"risks":[],
		"openQuestions":[],
		"nextActions":[],
		"sources":[{
			"evidenceRefId":"evidence_parse_event_0001",
			"kind":"run_event",
			"runId":"run_result_parse_0001",
			"sequence":1,
			"workspacePath":"/private/workspace"
		}],
		"criterionClaims":[]
	}`
	if _, err := ParseProposal(withLocalPath); err == nil ||
		!strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("local field validation error = %v", err)
	}
	if _, err := ParseProposal(`{"taskId":"task_result_parse_0001"}`); err == nil ||
		!strings.Contains(err.Error(), "omitted required field") {
		t.Fatalf("required field validation error = %v", err)
	}
}

func TestManagedProposalRetriesTheExactOperationAfterResponseLoss(t *testing.T) {
	proposal := validProposal()
	requests := 0
	var firstBody string
	client := NewClient(config.Config{
		ServerURL:   "https://hub.example.test",
		ServerToken: "server-token",
	}, pairing.Credential{Token: "device-token"})
	client.httpClient = &http.Client{Transport: roundTripFunc(func(
		request *http.Request,
	) (*http.Response, error) {
		requests++
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		if request.URL.Path != "/api/bridge/results" ||
			request.Header.Get("authorization") != "Bearer device-token" ||
			request.Header.Get(config.ServerTokenHeader) != "server-token" {
			t.Fatalf("unexpected request: %s %#v", request.URL, request.Header)
		}
		if requests == 1 {
			firstBody = string(body)
			return nil, errors.New("response lost")
		}
		if string(body) != firstBody {
			t.Fatalf("retry body changed\nfirst=%s\nsecond=%s", firstBody, body)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Body: io.NopCloser(strings.NewReader(`{
				"resultId":"result_managed_retry_0001",
				"taskId":"task_managed_retry_0001",
				"proposal":{"operationId":"op_managed_retry_0001"}
			}`)),
			Header: make(http.Header),
		}, nil
	})}
	result, err := client.Propose(context.Background(), ProposeInput{
		AgentID:  "agent_managed_retry_0001",
		RunID:    "run_managed_retry_0001",
		Proposal: proposal,
	})
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || result.ResultID != "result_managed_retry_0001" {
		t.Fatalf("requests=%d result=%#v", requests, result)
	}
	if strings.Contains(firstBody, "workspacePath") ||
		strings.Contains(firstBody, "review") ||
		strings.Contains(firstBody, "completeTask") {
		t.Fatalf("proposal crossed an unauthorized boundary: %s", firstBody)
	}
}

func TestManagedProposalRequiresItsSelectedRunEvent(t *testing.T) {
	proposal := validProposal()
	foreignRun := "run_foreign_event_0001"
	proposal.Sources[0].RunID = &foreignRun
	client := NewClient(config.Config{}, pairing.Credential{})
	_, err := client.Propose(context.Background(), ProposeInput{
		AgentID:  "agent_managed_retry_0001",
		RunID:    "run_managed_retry_0001",
		Proposal: proposal,
	})
	if err == nil || !strings.Contains(err.Error(), "selected Run") {
		t.Fatalf("Run source validation error = %v", err)
	}
}

func validProposal() workcontracts.ResultProposal {
	runID := "run_managed_retry_0001"
	sequence := int64(3)
	return workcontracts.ResultProposal{
		OperationID:            "op_managed_retry_0001",
		TaskID:                 "task_managed_retry_0001",
		DefinitionRevision:     2,
		CriteriaRevision:       3,
		ProposedAtTaskRevision: 4,
		Outcome:                workcontracts.Informational,
		Summary:                "The managed Runtime explicitly proposed this Result.",
		Risks:                  []string{},
		OpenQuestions:          []string{},
		NextActions:            []workcontracts.ResultProposalNextAction{},
		Sources: []workcontracts.ResultProposalSource{{
			EvidenceRefID: "evidence_managed_event_0001",
			Kind:          workcontracts.RunEvent,
			RunID:         &runID,
			Sequence:      &sequence,
		}},
		CriterionClaims: []workcontracts.ResultProposalCriterionClaim{},
	}
}
