package contracts_test

import (
	"encoding/json"
	"strings"
	"testing"

	execution "convenewire.dev/contracts/generated/go/execution"
	runtimecontracts "convenewire.dev/contracts/generated/go/runtime"
)

func TestExecutionSchedulerContractsAreClosedAcrossGoRuntime(t *testing.T) {
	const (
		at       = "2026-09-03T00:00:00.000Z"
		planID   = "plan_scheduler0001"
		memberID = "member_scheduler0001"
	)
	digest := strings.Repeat("a", 64)
	control := map[string]any{
		"planId": planID, "mode": "automatic", "modeRevision": 1,
		"lastOperationId": nil, "updatedByMemberId": nil,
		"reason": "Initial automatic scheduler mode.", "updatedAt": at,
	}
	modeCommand := map[string]any{
		"operationId": "op_scheduler_mode0001", "expectedPlanRevision": 1,
		"expectedPlanDigest": digest, "expectedPlanControlRevision": 1,
		"expectedModeRevision": 1, "mode": "manual",
		"reason": "Require exact manual selection.",
	}
	manualCommand := map[string]any{
		"operationId": "op_scheduler_manual0001", "expectedPlanRevision": 1,
		"expectedPlanDigest": digest, "expectedPlanControlRevision": 1,
		"expectedModeRevision": 2, "nodeKey": "Build",
		"expectedNodeProjectionRevision": 3,
		"reason":                         "Dispatch only Build.",
	}
	advanceCommand := map[string]any{
		"operationId": "op_scheduler_advance0001", "expectedPlanRevision": 1,
		"expectedPlanDigest": digest, "expectedPlanControlRevision": 1,
		"expectedModeRevision": 3,
		"reason":               "Advance one deterministic candidate.",
	}
	modeReceipt := map[string]any{
		"operationId": modeCommand["operationId"], "planId": planID,
		"planRevision": 1, "planDigest": digest, "planControlRevision": 1,
		"previousMode": "automatic", "previousModeRevision": 1,
		"mode": "manual", "modeRevision": 2,
		"updatedByMemberId": memberID, "reason": modeCommand["reason"],
		"requestDigest": strings.Repeat("b", 64), "operationDigest": strings.Repeat("c", 64),
		"updatedAt": at,
	}
	dispatchReceipt := map[string]any{
		"operationId": manualCommand["operationId"], "action": "manual_dispatch",
		"planId": planID, "planRevision": 1, "planDigest": digest,
		"planControlRevision": 1, "mode": "manual", "modeRevision": 2,
		"requestedByMemberId": memberID, "reason": manualCommand["reason"],
		"selection": map[string]any{
			"nodeKey": "Build", "dispatchIntentId": "dispatch_scheduler0001",
			"runId": "run_scheduler0001",
		},
		"requestDigest": strings.Repeat("d", 64), "operationDigest": strings.Repeat("e", 64),
		"createdAt": at,
	}
	values := map[string]map[string]any{
		"schedulerControl":               control,
		"schedulerModeCommand":           modeCommand,
		"schedulerManualDispatchCommand": manualCommand,
		"schedulerAdvanceCommand":        advanceCommand,
		"schedulerModeReceipt":           modeReceipt,
		"schedulerDispatchReceipt":       dispatchReceipt,
	}
	for kind, value := range values {
		if err := runtimecontracts.ValidateExecutionCommand(kind, encodeJSON(t, value)); err != nil {
			t.Fatalf("%s rejected: %v", kind, err)
		}
		invalid := cloneJSONMap(t, value)
		invalid["command"] = "unbounded work"
		if runtimecontracts.ValidateExecutionCommand(kind, encodeJSON(t, invalid)) == nil {
			t.Fatalf("%s accepted an unknown field", kind)
		}
	}

	var typed execution.ExecutionSchedulerControl
	if err := json.Unmarshal(encodeJSON(t, control), &typed); err != nil {
		t.Fatal(err)
	}
	if typed.Mode != execution.Automatic || typed.ModeRevision != 1 {
		t.Fatalf("generated Go scheduler type lost mode identity: %#v", typed)
	}
}

func cloneJSONMap(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	raw := encodeJSON(t, value)
	var cloned map[string]any
	if err := json.Unmarshal(raw, &cloned); err != nil {
		t.Fatal(err)
	}
	return cloned
}
