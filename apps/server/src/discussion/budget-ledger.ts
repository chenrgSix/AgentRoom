import type {
  BudgetSnapshot,
  DiscussionPolicy
} from "./discussion-types.js";

export interface TurnTelemetry {
  tokens?: number;
  estimatedCostMicros?: number;
}

function validUsage(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

export function recordTurnUsage(input: {
  previous: BudgetSnapshot;
  telemetry?: TurnTelemetry;
  discussionStartedAt: string;
  now: string;
}): BudgetSnapshot {
  const elapsed = Math.max(0, Math.floor(
    (Date.parse(input.now) - Date.parse(input.discussionStartedAt)) / 1_000
  ));
  const turnTokens = input.telemetry?.tokens;
  const turnCost = input.telemetry?.estimatedCostMicros;
  const tokenKnown = validUsage(turnTokens);
  const costKnown = validUsage(turnCost);
  return {
    ...input.previous,
    turnsUsed: input.previous.turnsUsed + 1,
    tokensUsed: tokenKnown &&
      (input.previous.turnsUsed === 0 || input.previous.tokenTelemetryKnown)
      ? (input.previous.tokensUsed ?? 0) + turnTokens
      : null,
    durationSeconds: elapsed,
    estimatedCostMicros: costKnown &&
      (input.previous.turnsUsed === 0 || input.previous.costTelemetryKnown)
      ? (input.previous.estimatedCostMicros ?? 0) +
        turnCost
      : null,
    tokenTelemetryKnown: tokenKnown &&
      (input.previous.turnsUsed === 0 || input.previous.tokenTelemetryKnown),
    costTelemetryKnown: costKnown &&
      (input.previous.turnsUsed === 0 || input.previous.costTelemetryKnown)
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
    ...input.previous,
    leaseEndTurn,
    extensions: input.previous.extensions + 1
  };
}
