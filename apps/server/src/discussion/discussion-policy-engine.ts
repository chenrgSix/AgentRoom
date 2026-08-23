import { inspectBudget } from "./budget-ledger.js";
import type {
  DiscussionAction,
  DiscussionOutputMode,
  DiscussionPolicy,
  DiscussionState,
  DiscussionStateReason,
  ProgressSnapshot,
  BudgetSnapshot
} from "./discussion-types.js";

export type DiscussionUserIntent =
  | "finish"
  | "stop_after_turn"
  | "pause"
  | "cancel"
  | null;

export interface PolicyDecision {
  action: DiscussionAction;
  state: DiscussionState;
  reason: DiscussionStateReason | null;
  outputMode: DiscussionOutputMode;
  grantAutomaticLease: boolean;
}

export function decideDiscussion(input: {
  progress: ProgressSnapshot;
  budget: BudgetSnapshot;
  policy: DiscussionPolicy;
  requestedOutputMode: DiscussionOutputMode;
  userIntent?: DiscussionUserIntent;
  runtimeInputRequired?: boolean;
  runtimeFailed?: boolean;
}): PolicyDecision {
  if (input.userIntent === "cancel") {
    return {
      action: "cancel",
      state: "canceled",
      reason: "user_canceled",
      outputMode: "none",
      grantAutomaticLease: false
    };
  }

  const budget = inspectBudget(input.budget, input.policy);
  if (budget.hardBoundaryReached) {
    return {
      action: "finalize",
      state: "finalizing",
      reason: "hard_budget_exhausted",
      outputMode: input.progress.openQuestions.length > 0
        ? "unresolved_issues"
        : input.requestedOutputMode,
      grantAutomaticLease: false
    };
  }
  if (input.runtimeInputRequired) {
    return {
      action: "wait_human",
      state: "waiting_human",
      reason: "input_required",
      outputMode: "none",
      grantAutomaticLease: false
    };
  }
  if (input.userIntent === "pause") {
    return {
      action: "pause",
      state: "paused",
      reason: "user_paused",
      outputMode: "none",
      grantAutomaticLease: false
    };
  }
  if (input.userIntent === "finish" || input.userIntent === "stop_after_turn") {
    return {
      action: "finalize",
      state: "finalizing",
      reason: "user_requested_finish",
      outputMode: input.requestedOutputMode,
      grantAutomaticLease: false
    };
  }
  if (input.runtimeFailed) {
    return {
      action: "wait_human",
      state: "waiting_human",
      reason: "runtime_failure",
      outputMode: "none",
      grantAutomaticLease: false
    };
  }
  const reviewSatisfied = !input.policy.requireReviewer ||
    input.progress.reviewerApproved;
  if (
    input.policy.allowAutomaticFinish && input.progress.goalSatisfied &&
    reviewSatisfied
  ) {
    return {
      action: "finalize",
      state: "finalizing",
      reason: "goal_satisfied",
      outputMode: input.requestedOutputMode,
      grantAutomaticLease: false
    };
  }
  if (input.progress.plateauCount >= input.policy.plateauWindow) {
    const hasHighPriorityQuestion = input.progress.openQuestions.some(
      ({ importance }) => importance === "high"
    );
    return hasHighPriorityQuestion
      ? {
          action: "wait_human",
          state: "waiting_human",
          reason: "discussion_plateau",
          outputMode: "none",
          grantAutomaticLease: false
        }
      : {
          action: "finalize",
          state: "finalizing",
          reason: "discussion_plateau",
          outputMode: input.requestedOutputMode,
          grantAutomaticLease: false
        };
  }
  if (budget.leaseBoundaryReached) {
    if (budget.automaticRenewalAvailable && input.progress.lastTurnAddedInformation) {
      return {
        action: "continue",
        state: "active",
        reason: null,
        outputMode: "none",
        grantAutomaticLease: true
      };
    }
    return {
      action: "wait_human",
      state: "awaiting_extension",
      reason: "soft_budget_exhausted",
      outputMode: "none",
      grantAutomaticLease: false
    };
  }
  return {
    action: "continue",
    state: "active",
    reason: null,
    outputMode: "none",
    grantAutomaticLease: false
  };
}
