export type ExecutionReadinessBlocker =
  | "EXECUTION_AGENT_CAPACITY_EXHAUSTED"
  | "EXECUTION_AGENT_UNAVAILABLE"
  | "EXECUTION_ATTEMPT_ALREADY_EXISTS"
  | "EXECUTION_CAPABILITY_UNAVAILABLE"
  | "EXECUTION_DEPENDENCY_NOT_MATERIALIZED"
  | "EXECUTION_GRANT_AMBIGUOUS"
  | "EXECUTION_GRANT_UNAVAILABLE"
  | "EXECUTION_NODE_KIND_UNSUPPORTED"
  | "EXECUTION_OUTPUT_UNSUPPORTED"
  | "EXECUTION_PLAN_BUDGET_EXHAUSTED"
  | "EXECUTION_PLAN_CAPACITY_EXHAUSTED"
  | "EXECUTION_PLAN_STALE"
  | "EXECUTION_REQUIRED_INPUT_UNSUPPORTED"
  | "EXECUTION_TASK_BUDGET_EXHAUSTED"
  | "EXECUTION_TASK_NOT_RUNNABLE"
  | "EXECUTION_TASK_STALE";

export interface ExecutionReadinessSnapshot {
  activeAgentRuns: number;
  activePlanRuns: number;
  agentAvailable: boolean;
  capabilityAvailable: boolean;
  existingAttempt: boolean;
  grantMatches: number;
  hasIncomingEdges: boolean;
  hasRequiredInputs: boolean;
  nodeKind: "implementation" | "review" | "verification";
  nextRunReservationSeconds: number;
  outputsSupported: boolean;
  planAttempts: number;
  planCurrent: boolean;
  planDurationSeconds: number;
  planMaxConcurrency: number;
  planMaxDurationSeconds: number;
  planMaxRunAttempts: number;
  taskBudgetAvailable: boolean;
  taskPinsCurrent: boolean;
  taskRunnable: boolean;
}

export type ExecutionReadiness =
  | { ready: true; blocker: null }
  | { ready: false; blocker: ExecutionReadinessBlocker };

/** Pure policy: callers must freeze all mutable observations before invoking. */
export function evaluateExecutionReadiness(
  snapshot: ExecutionReadinessSnapshot
): ExecutionReadiness {
  if (!snapshot.planCurrent) {
    return { ready: false, blocker: "EXECUTION_PLAN_STALE" };
  }
  if (snapshot.existingAttempt) {
    return { ready: false, blocker: "EXECUTION_ATTEMPT_ALREADY_EXISTS" };
  }
  if (snapshot.nodeKind !== "implementation") {
    return { ready: false, blocker: "EXECUTION_NODE_KIND_UNSUPPORTED" };
  }
  if (snapshot.hasIncomingEdges) {
    return {
      ready: false,
      blocker: "EXECUTION_DEPENDENCY_NOT_MATERIALIZED"
    };
  }
  if (snapshot.hasRequiredInputs) {
    return { ready: false, blocker: "EXECUTION_REQUIRED_INPUT_UNSUPPORTED" };
  }
  if (!snapshot.taskPinsCurrent) {
    return { ready: false, blocker: "EXECUTION_TASK_STALE" };
  }
  if (!snapshot.taskRunnable) {
    return { ready: false, blocker: "EXECUTION_TASK_NOT_RUNNABLE" };
  }
  if (!snapshot.taskBudgetAvailable) {
    return { ready: false, blocker: "EXECUTION_TASK_BUDGET_EXHAUSTED" };
  }
  if (
    snapshot.planAttempts >= snapshot.planMaxRunAttempts ||
    snapshot.planDurationSeconds + snapshot.nextRunReservationSeconds >
      snapshot.planMaxDurationSeconds
  ) {
    return { ready: false, blocker: "EXECUTION_PLAN_BUDGET_EXHAUSTED" };
  }
  if (snapshot.activePlanRuns >= snapshot.planMaxConcurrency) {
    return { ready: false, blocker: "EXECUTION_PLAN_CAPACITY_EXHAUSTED" };
  }
  if (snapshot.activeAgentRuns > 0) {
    return { ready: false, blocker: "EXECUTION_AGENT_CAPACITY_EXHAUSTED" };
  }
  if (!snapshot.agentAvailable) {
    return { ready: false, blocker: "EXECUTION_AGENT_UNAVAILABLE" };
  }
  if (!snapshot.capabilityAvailable) {
    return { ready: false, blocker: "EXECUTION_CAPABILITY_UNAVAILABLE" };
  }
  if (snapshot.grantMatches !== 1) {
    return {
      ready: false,
      blocker: snapshot.grantMatches === 0
        ? "EXECUTION_GRANT_UNAVAILABLE"
        : "EXECUTION_GRANT_AMBIGUOUS"
    };
  }
  if (!snapshot.outputsSupported) {
    return { ready: false, blocker: "EXECUTION_OUTPUT_UNSUPPORTED" };
  }
  return { ready: true, blocker: null };
}
