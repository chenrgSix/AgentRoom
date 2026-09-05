import type {
  BudgetSnapshot,
  DiscussionPolicy
} from "./discussion-types.js";

export function recordTurnUsage(input: {
  previous: BudgetSnapshot;
  agentRuns?: number;
  discussionStartedAt: string;
  now: string;
}): BudgetSnapshot {
  const elapsed = Math.max(0, Math.floor(
    (Date.parse(input.now) - Date.parse(input.discussionStartedAt)) / 1_000
  ));
  const agentRuns = input.agentRuns ?? 1;
  if (!Number.isSafeInteger(agentRuns) || agentRuns < 1 || agentRuns > 5) {
    throw new Error("Discussion Wave Agent Run count must be between 1 and 5");
  }
  return {
    turnsUsed: input.previous.turnsUsed + 1,
    agentRunsUsed: input.previous.agentRunsUsed + agentRuns,
    durationSeconds: elapsed,
    leaseEndTurn: input.previous.leaseEndTurn,
    extensions: input.previous.extensions
  };
}

export interface BudgetStatus {
  hardBoundaryReached: boolean;
  leaseBoundaryReached: boolean;
  automaticRenewalAvailable: boolean;
  softBoundaryReached: boolean;
  regularTurnLimit: number;
}

export function inspectBudget(
  budget: BudgetSnapshot,
  policy: DiscussionPolicy
): BudgetStatus {
  const regularTurnLimit = Math.max(
    0,
    policy.hardMaxTurns - policy.finalizationReserveTurns
  );
  const hardBoundaryReached =
    budget.turnsUsed >= regularTurnLimit ||
    budget.durationSeconds >= policy.maxDurationSeconds;
  const leaseBoundaryReached = budget.turnsUsed >= budget.leaseEndTurn;
  return {
    hardBoundaryReached,
    leaseBoundaryReached,
    automaticRenewalAvailable:
      leaseBoundaryReached && budget.leaseEndTurn < policy.automaticMaxTurns,
    softBoundaryReached:
      leaseBoundaryReached && budget.leaseEndTurn >= policy.automaticMaxTurns,
    regularTurnLimit
  };
}

export function grantDiscussionLease(input: {
  previous: BudgetSnapshot;
  policy: DiscussionPolicy;
  requestedTurns?: number;
  source: "automatic" | "user";
}): BudgetSnapshot {
  const status = inspectBudget(input.previous, input.policy);
  if (status.hardBoundaryReached) {
    throw new Error("Discussion hard budget cannot be extended");
  }
  const increment = input.requestedTurns ?? input.policy.initialLeaseTurns;
  if (!Number.isSafeInteger(increment) || increment < 1 || increment > 20) {
    throw new Error("Discussion lease extension must be between 1 and 20 turns");
  }
  const boundary = input.source === "automatic"
    ? Math.min(input.policy.automaticMaxTurns, status.regularTurnLimit)
    : status.regularTurnLimit;
  const leaseEndTurn = Math.min(
    Math.max(input.previous.leaseEndTurn, input.previous.turnsUsed) + increment,
    boundary
  );
  if (leaseEndTurn <= input.previous.leaseEndTurn) {
    throw new Error("Discussion lease cannot advance beyond its current boundary");
  }
  return {
    turnsUsed: input.previous.turnsUsed,
    agentRunsUsed: input.previous.agentRunsUsed,
    durationSeconds: input.previous.durationSeconds,
    leaseEndTurn,
    extensions: input.previous.extensions + 1
  };
}
