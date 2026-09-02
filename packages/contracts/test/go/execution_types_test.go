package contracts_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	execution "convenewire.dev/contracts/generated/go/execution"
)

func TestExecutionGeneratedTypesPreserveWireFixtures(t *testing.T) {
	root := packageRoot(t)
	var suite fixtureSuite
	for _, name := range []string{"execution-plan-cases.json", "execution-runtime-cases.json", "evidence-adoption-cases.json"} {
		source, err := os.ReadFile(filepath.Join(root, "fixtures", name))
		if err != nil {
			t.Fatal(err)
		}
		var part fixtureSuite
		if err := json.Unmarshal(source, &part); err != nil {
			t.Fatal(err)
		}
		suite.Cases = append(suite.Cases, part.Cases...)
	}
	constructors := map[string]func() any{
		"execution runtime: valid manifest":                                 func() any { return &execution.GovernedExecutionManifest{} },
		"execution runtime: valid input binding":                            func() any { return &execution.ExecutionInputBinding{} },
		"execution runtime: valid capability":                               func() any { return &execution.GovernedExecutionCapability{} },
		"execution runtime: valid authority request":                        func() any { return &execution.RuntimeAuthorityRequest{} },
		"execution runtime: valid authority view":                           func() any { return &execution.RuntimeAuthorityView{} },
		"execution runtime: valid grant summary":                            func() any { return &execution.ExecutionGrantSummary{} },
		"execution runtime: valid repository binding":                       func() any { return &execution.RepositoryBindingSummary{} },
		"execution runtime: valid checkpoint":                               func() any { return &execution.RepositoryCheckpoint{} },
		"execution runtime: valid prepare operation":                        func() any { return &execution.RepositoryOperationRequest{} },
		"execution runtime: valid capture operation":                        func() any { return &execution.RepositoryOperationRequest{} },
		"execution runtime: valid verify operation":                         func() any { return &execution.RepositoryOperationRequest{} },
		"execution runtime: valid integrate operation":                      func() any { return &execution.RepositoryOperationRequest{} },
		"execution runtime: valid publish operation":                        func() any { return &execution.RepositoryOperationRequest{} },
		"execution runtime: valid observe operation":                        func() any { return &execution.RepositoryOperationRequest{} },
		"execution runtime: valid prepared receipt":                         func() any { return &execution.RepositoryOperationReceipt{} },
		"execution runtime: valid verification receipt":                     func() any { return &execution.VerificationReceipt{} },
		"execution runtime: valid CI receipt":                               func() any { return &execution.VerificationReceipt{} },
		"execution: valid source-action plan":                               func() any { return &execution.ExecutionPlanDefinition{} },
		"execution: valid approval record":                                  func() any { return &execution.ExecutionPlanApprovalRecord{} },
		"execution: valid rejection record":                                 func() any { return &execution.ExecutionPlanApprovalRecord{} },
		"execution: valid approval receipt":                                 func() any { return &execution.ExecutionPlanApprovalReceipt{} },
		"execution: valid approval page":                                    func() any { return &execution.ExecutionPlanApprovalPage{} },
		"execution: valid empty approval page":                              func() any { return &execution.ExecutionPlanApprovalPage{} },
		"execution: valid frozen source archive":                            func() any { return &execution.ExecutionDecisionSourceSnapshot{} },
		"execution: valid empty plan page":                                  func() any { return &execution.ExecutionPlanPage{} },
		"execution: valid empty revision page":                              func() any { return &execution.ExecutionPlanRevisionPage{} },
		"execution: valid immutable decision record":                        func() any { return &execution.ExecutionDecisionRecord{} },
		"execution: valid full plan":                                        func() any { return &execution.ExecutionPlanDefinition{} },
		"execution: valid human proposal":                                   func() any { return &execution.ExecutionPlanProposalCommand{} },
		"execution: valid exact approval":                                   func() any { return &execution.ExecutionPlanApprovalCommand{} },
		"execution: valid control command":                                  func() any { return &execution.ExecutionPlanControlCommand{} },
		"execution: valid node retry command":                               func() any { return &execution.ExecutionNodeRetryCommand{} },
		"execution: valid node retry authorization":                         func() any { return &execution.ExecutionNodeRetryAuthorization{} },
		"execution: valid revision command":                                 func() any { return &execution.ExecutionPlanRevisionCommand{} },
		"execution: valid attributed decision":                              func() any { return &execution.ExecutionDecisionContent{} },
		"execution: valid scoped Agent proposal":                            func() any { return &execution.ExecutionAgentPlanProposalCommand{} },
		"evidence adoption: valid task Result source":                       func() any { return &execution.SourceEvidence{} },
		"evidence adoption: valid local repository commit source":           func() any { return &execution.SourceEvidence{} },
		"evidence adoption: valid remote repository commit source contract": func() any { return &execution.SourceEvidence{} },
		"evidence adoption: valid Result review proof":                      func() any { return &execution.GateProofRef{} },
		"evidence adoption: valid verification proof":                       func() any { return &execution.GateProofRef{} },
		"evidence adoption: valid CI observation proof contract":            func() any { return &execution.GateProofRef{} },
		"evidence adoption: valid integration proof":                        func() any { return &execution.GateProofRef{} },
		"evidence adoption: valid accepted Result adoption":                 func() any { return &execution.EvidenceAdoption{} },
	}
	checked := 0
	for _, fixture := range suite.Cases {
		constructor := constructors[fixture.Name]
		if constructor == nil {
			continue
		}
		checked++
		t.Run(fixture.Name, func(t *testing.T) {
			value := constructor()
			if err := json.Unmarshal(fixture.Instance, value); err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(decodeJSON(t, fixture.Instance), decodeJSON(t, encoded)) {
				t.Fatal("generated execution type changed or discarded wire content")
			}
		})
	}
	if checked != len(constructors) {
		t.Fatalf("checked %d typed fixtures, want %d", checked, len(constructors))
	}
}
