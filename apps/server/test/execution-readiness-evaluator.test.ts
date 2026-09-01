import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateExecutionReadiness,
  type ExecutionReadinessSnapshot
} from "../src/execution/execution-readiness-evaluator.js";

const ready = (): ExecutionReadinessSnapshot => ({
  activeAgentRuns: 0,
  activePlanRuns: 0,
  agentAvailable: true,
  capabilityAvailable: true,
  existingAttempt: false,
  grantMatches: 1,
  hasIncomingEdges: false,
  hasRequiredInputs: false,
  nodeKind: "implementation",
  nextRunReservationSeconds: 1_200,
  outputsSupported: true,
  planAttempts: 0,
  planCurrent: true,
  planDurationSeconds: 0,
  planMaxConcurrency: 2,
  planMaxDurationSeconds: 3_600,
  planMaxRunAttempts: 4,
  taskBudgetAvailable: true,
  taskPinsCurrent: true,
  taskRunnable: true
});

test("readiness accepts only the complete frozen snapshot", () => {
  assert.deepEqual(evaluateExecutionReadiness(ready()), {
    ready: true,
    blocker: null
  });
});

test("readiness reports dependency, budget, capacity and authority blockers", () => {
  const cases: Array<[
    keyof ExecutionReadinessSnapshot,
    ExecutionReadinessSnapshot[keyof ExecutionReadinessSnapshot],
    string
  ]> = [
    ["planCurrent", false, "EXECUTION_PLAN_STALE"],
    ["existingAttempt", true, "EXECUTION_ATTEMPT_ALREADY_EXISTS"],
    ["nodeKind", "review", "EXECUTION_NODE_KIND_UNSUPPORTED"],
    ["hasIncomingEdges", true, "EXECUTION_DEPENDENCY_NOT_MATERIALIZED"],
    ["hasRequiredInputs", true, "EXECUTION_REQUIRED_INPUT_UNSUPPORTED"],
    ["taskPinsCurrent", false, "EXECUTION_TASK_STALE"],
    ["taskRunnable", false, "EXECUTION_TASK_NOT_RUNNABLE"],
    ["taskBudgetAvailable", false, "EXECUTION_TASK_BUDGET_EXHAUSTED"],
    ["planAttempts", 4, "EXECUTION_PLAN_BUDGET_EXHAUSTED"],
    ["planDurationSeconds", 3_600, "EXECUTION_PLAN_BUDGET_EXHAUSTED"],
    ["activePlanRuns", 2, "EXECUTION_PLAN_CAPACITY_EXHAUSTED"],
    ["activeAgentRuns", 1, "EXECUTION_AGENT_CAPACITY_EXHAUSTED"],
    ["agentAvailable", false, "EXECUTION_AGENT_UNAVAILABLE"],
    ["capabilityAvailable", false, "EXECUTION_CAPABILITY_UNAVAILABLE"],
    ["grantMatches", 0, "EXECUTION_GRANT_UNAVAILABLE"],
    ["grantMatches", 2, "EXECUTION_GRANT_AMBIGUOUS"],
    ["outputsSupported", false, "EXECUTION_OUTPUT_UNSUPPORTED"]
  ];
  for (const [key, value, blocker] of cases) {
    const snapshot = ready();
    Object.assign(snapshot, { [key]: value });
    assert.deepEqual(
      evaluateExecutionReadiness(snapshot),
      { ready: false, blocker },
      key
    );
  }
});

test("readiness blocker precedence is deterministic", () => {
  const snapshot = ready();
  snapshot.planCurrent = false;
  snapshot.grantMatches = 0;
  snapshot.activePlanRuns = snapshot.planMaxConcurrency;
  assert.deepEqual(evaluateExecutionReadiness(snapshot), {
    ready: false,
    blocker: "EXECUTION_PLAN_STALE"
  });
});
