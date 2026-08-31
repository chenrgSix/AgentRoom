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
	source, err := os.ReadFile(filepath.Join(root, "fixtures", "execution-plan-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var suite fixtureSuite
	if err := json.Unmarshal(source, &suite); err != nil {
		t.Fatal(err)
	}
	constructors := map[string]func() any{
		"execution: valid frozen source archive":     func() any { return &execution.ExecutionDecisionSourceSnapshot{} },
		"execution: valid empty plan page":           func() any { return &execution.ExecutionPlanPage{} },
		"execution: valid empty revision page":       func() any { return &execution.ExecutionPlanRevisionPage{} },
		"execution: valid immutable decision record": func() any { return &execution.ExecutionDecisionRecord{} },
		"execution: valid full plan":                 func() any { return &execution.ExecutionPlanDefinition{} },
		"execution: valid human proposal":            func() any { return &execution.ExecutionPlanProposalCommand{} },
		"execution: valid exact approval":            func() any { return &execution.ExecutionPlanApprovalCommand{} },
		"execution: valid control command":           func() any { return &execution.ExecutionPlanControlCommand{} },
		"execution: valid revision command":          func() any { return &execution.ExecutionPlanRevisionCommand{} },
		"execution: valid attributed decision":       func() any { return &execution.ExecutionDecisionContent{} },
		"execution: valid scoped Agent proposal":     func() any { return &execution.ExecutionAgentPlanProposalCommand{} },
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
