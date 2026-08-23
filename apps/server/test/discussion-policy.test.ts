import assert from "node:assert/strict";
import test from "node:test";

import {
  grantDiscussionLease,
  inspectBudget,
  recordTurnUsage
} from "../src/discussion/budget-ledger.js";
import { decideDiscussion } from "../src/discussion/discussion-policy-engine.js";
import {
  defaultDiscussionPolicy,
  emptyBudgetSnapshot,
  emptyProgressSnapshot
} from "../src/discussion/discussion-types.js";
import {
  evaluateProgress,
  parseAgentAssessment
} from "../src/discussion/progress-evaluator.js";

test("progress evaluation accepts structured evidence and degrades to reply-only", () => {
  const initial = {
    ...emptyProgressSnapshot(),
    openQuestions: [{
      id: "cancel_race",
      question: "How is cancel versus complete resolved?",
      importance: "high" as const
    }]
  };
  const first = evaluateProgress({
    previous: initial,
    reply: "Persist the first terminal outcome.",
    assessment: {
      goalSatisfied: true,
      confidence: 0.91,
      resolvedQuestionIds: ["cancel_race"],
      newEvidenceRefs: ["test_terminal_race"],
      disagreementRemaining: "none"
    },
    policy: defaultDiscussionPolicy,
    speakerIsReviewer: false
  });
  assert.equal(first.snapshot.goalSatisfied, true);
  assert.equal(first.resolvedImportantQuestions, 1);
  assert.deepEqual(first.snapshot.evidenceRefs, ["test_terminal_race"]);
  assert.equal(first.snapshot.plateauCount, 0);

  const replyOnly = evaluateProgress({
    previous: first.snapshot,
    reply: "Persist the first terminal outcome.",
    assessment: { confidence: "very" },
    policy: defaultDiscussionPolicy,
    speakerIsReviewer: false
  });
  assert.equal(replyOnly.assessment, null);
  assert.equal(replyOnly.snapshot.lastTurnAddedInformation, false);
  assert.equal(replyOnly.snapshot.plateauCount, 1);
  assert.equal(replyOnly.snapshot.goalSatisfied, false);
});

test("malformed assessment fields cannot assert completion or reviewer approval", () => {
  assert.equal(parseAgentAssessment({
    goalSatisfied: "yes",
    confidence: 4,
    reviewerApproved: "yes",
    openQuestions: [{ id: "x", question: "x", importance: "critical" }]
  }), null);
  const evaluated = evaluateProgress({
    previous: emptyProgressSnapshot(),
    reply: "A useful new answer.",
    assessment: { goalSatisfied: true, confidence: 0.99, reviewerApproved: true },
    policy: { ...defaultDiscussionPolicy, requireReviewer: true },
    speakerIsReviewer: false
  });
  assert.equal(evaluated.snapshot.goalSatisfied, true);
  assert.equal(evaluated.snapshot.reviewerApproved, false);
  assert.equal(decideDiscussion({
    progress: evaluated.snapshot,
    budget: emptyBudgetSnapshot(4),
    policy: { ...defaultDiscussionPolicy, requireReviewer: true },
    requestedOutputMode: "final_answer"
  }).action, "continue");
});

test("budget ledger preserves unknown telemetry and protects finalization reserve", () => {
  const startedAt = "2026-08-23T10:00:00.000Z";
  const first = recordTurnUsage({
    previous: emptyBudgetSnapshot(4),
    telemetry: { tokens: 120, estimatedCostMicros: 35 },
    discussionStartedAt: startedAt,
    now: "2026-08-23T10:00:03.000Z"
  });
  assert.equal(first.tokensUsed, 120);
  assert.equal(first.durationSeconds, 3);
  assert.equal(first.agentRunsUsed, 1);
  const second = recordTurnUsage({
    previous: first,
    agentRuns: 3,
    discussionStartedAt: startedAt,
    now: "2026-08-23T10:00:05.000Z"
  });
  assert.equal(second.tokensUsed, null);
  assert.equal(second.estimatedCostMicros, null);
  assert.equal(second.tokenTelemetryKnown, false);
  assert.equal(second.turnsUsed, 2);
  assert.equal(second.agentRunsUsed, 4);

  const nearHard = {
    ...second,
    turnsUsed: defaultDiscussionPolicy.hardMaxTurns -
      defaultDiscussionPolicy.finalizationReserveTurns
  };
  const status = inspectBudget(nearHard, defaultDiscussionPolicy);
  assert.equal(status.hardBoundaryReached, true);
  assert.throws(() => grantDiscussionLease({
    previous: nearHard,
    policy: defaultDiscussionPolicy,
    source: "user"
  }), /hard budget/);
});

test("policy finishes early, renews useful leases, and waits at soft boundaries", () => {
  const complete = decideDiscussion({
    progress: { ...emptyProgressSnapshot(), goalSatisfied: true, confidence: 0.9 },
    budget: emptyBudgetSnapshot(4),
    policy: defaultDiscussionPolicy,
    requestedOutputMode: "final_answer"
  });
  assert.deepEqual(
    { action: complete.action, reason: complete.reason },
    { action: "finalize", reason: "goal_satisfied" }
  );

  const usefulAtLease = decideDiscussion({
    progress: emptyProgressSnapshot(),
    budget: { ...emptyBudgetSnapshot(4), turnsUsed: 4 },
    policy: defaultDiscussionPolicy,
    requestedOutputMode: "summary"
  });
  assert.equal(usefulAtLease.action, "continue");
  assert.equal(usefulAtLease.grantAutomaticLease, true);
  const renewed = grantDiscussionLease({
    previous: { ...emptyBudgetSnapshot(4), turnsUsed: 4 },
    policy: defaultDiscussionPolicy,
    source: "automatic"
  });
  assert.equal(renewed.leaseEndTurn, 8);

  const soft = decideDiscussion({
    progress: emptyProgressSnapshot(),
    budget: { ...emptyBudgetSnapshot(12), turnsUsed: 12 },
    policy: defaultDiscussionPolicy,
    requestedOutputMode: "summary"
  });
  assert.equal(soft.state, "awaiting_extension");
  assert.equal(soft.reason, "soft_budget_exhausted");
});

test("plateau policy distinguishes low and high priority unresolved questions", () => {
  const low = decideDiscussion({
    progress: {
      ...emptyProgressSnapshot(),
      plateauCount: 2,
      lastTurnAddedInformation: false,
      openQuestions: [{ id: "edge", question: "Optional lock?", importance: "low" }]
    },
    budget: emptyBudgetSnapshot(4),
    policy: defaultDiscussionPolicy,
    requestedOutputMode: "summary"
  });
  assert.equal(low.action, "finalize");
  const high = decideDiscussion({
    progress: {
      ...emptyProgressSnapshot(),
      plateauCount: 2,
      lastTurnAddedInformation: false,
      openQuestions: [{ id: "safety", question: "Is data safe?", importance: "high" }]
    },
    budget: emptyBudgetSnapshot(4),
    policy: defaultDiscussionPolicy,
    requestedOutputMode: "summary"
  });
  assert.equal(high.action, "wait_human");
  assert.equal(high.state, "waiting_human");
});

test("user cancellation and hard budget outrank completion recommendations", () => {
  const progress = { ...emptyProgressSnapshot(), goalSatisfied: true, confidence: 1 };
  const canceled = decideDiscussion({
    progress,
    budget: emptyBudgetSnapshot(4),
    policy: defaultDiscussionPolicy,
    requestedOutputMode: "final_answer",
    userIntent: "cancel"
  });
  assert.equal(canceled.action, "cancel");
  const hard = decideDiscussion({
    progress,
    budget: { ...emptyBudgetSnapshot(49), turnsUsed: 49 },
    policy: defaultDiscussionPolicy,
    requestedOutputMode: "final_answer"
  });
  assert.equal(hard.reason, "hard_budget_exhausted");
  assert.equal(hard.action, "finalize");
});
