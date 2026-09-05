import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultDiscussionPolicy,
  emptyProgressSnapshot
} from "../src/discussion/discussion-types.js";
import {
  discussionReplySimilarity,
  evaluateWaveProgress,
  hashDiscussionReply
} from "../src/discussion/progress-evaluator.js";
import {
  normalizeSemanticEvaluation,
  runOptionalSemanticEvaluation,
  type SemanticEvaluator
} from "../src/discussion/semantic-evaluator.js";

test("Wave progress aggregation is deterministic across callback order", () => {
  const previous = {
    ...emptyProgressSnapshot(),
    version: 7,
    evidenceRefs: ["evidence_existing"],
    disagreementRemaining: "high" as const,
    openQuestions: [{
      id: "cancel_race",
      question: "How is cancellation resolved?",
      importance: "high" as const
    }]
  };
  const results = [{
    participantOrdinal: 2,
    reply: "The reviewer confirms the deterministic rule.",
    assessment: {
      goalSatisfied: true,
      confidence: 0.92,
      resolvedQuestionIds: ["cancel_race"],
      openQuestions: [{ id: "docs", question: "Update docs?", importance: "low" }],
      newEvidenceRefs: ["evidence_review"],
      disagreementRemaining: "low",
      reviewerApproved: true
    },
    speakerIsReviewer: true
  }, {
    participantOrdinal: 0,
    reply: "Persist the first terminal outcome.",
    assessment: {
      goalSatisfied: true,
      confidence: 0.88,
      openQuestions: [{ id: "load", question: "Test load?", importance: "medium" }],
      newEvidenceRefs: ["evidence_implementation"],
      disagreementRemaining: "none"
    },
    speakerIsReviewer: false
  }];

  const forward = evaluateWaveProgress({
    previous,
    successfulResults: results,
    policy: defaultDiscussionPolicy
  });
  const reversed = evaluateWaveProgress({
    previous,
    successfulResults: [...results].reverse(),
    policy: defaultDiscussionPolicy
  });

  assert.deepEqual(reversed, forward);
  assert.equal(forward.snapshot.version, 8);
  assert.equal(forward.snapshot.goalSatisfied, true);
  assert.equal(forward.snapshot.confidence, 0.88);
  assert.equal(forward.snapshot.reviewerApproved, true);
  assert.equal(forward.snapshot.disagreementRemaining, "low");
  assert.deepEqual(forward.snapshot.evidenceRefs, [
    "evidence_existing", "evidence_implementation", "evidence_review"
  ]);
  assert.deepEqual(forward.snapshot.replyHashes, [
    hashDiscussionReply(results[1]!.reply),
    hashDiscussionReply(results[0]!.reply)
  ]);
  assert.deepEqual(forward.members.map(({ participantOrdinal }) => participantOrdinal), [0, 2]);
  assert.equal(forward.resolvedImportantQuestions, 1);
});

test("Wave completion requires explicit confident consensus and no high questions", () => {
  const baseResults = [{
    participantOrdinal: 0,
    reply: "The primary path is complete.",
    assessment: { goalSatisfied: true, confidence: 0.95 },
    speakerIsReviewer: false
  }, {
    participantOrdinal: 1,
    reply: "Independent evidence was added.",
    assessment: { newEvidenceRefs: ["artifact_1"] },
    speakerIsReviewer: false
  }];
  assert.equal(evaluateWaveProgress({
    previous: emptyProgressSnapshot(),
    successfulResults: baseResults,
    policy: defaultDiscussionPolicy
  }).snapshot.goalSatisfied, true);

  for (const assessment of [
    { goalSatisfied: false, confidence: 0.95 },
    { goalSatisfied: true, confidence: 0.79 },
    { confidence: 0.95 }
  ]) {
    const result = evaluateWaveProgress({
      previous: emptyProgressSnapshot(),
      successfulResults: [baseResults[0]!, {
        participantOrdinal: 2,
        reply: "A second completion assessment.",
        assessment,
        speakerIsReviewer: false
      }],
      policy: defaultDiscussionPolicy
    });
    assert.equal(result.snapshot.goalSatisfied, false);
  }

  const highQuestion = evaluateWaveProgress({
    previous: emptyProgressSnapshot(),
    successfulResults: [{
      ...baseResults[0]!,
      assessment: {
        goalSatisfied: true,
        confidence: 0.95,
        openQuestions: [{ id: "safety", question: "Is data safe?", importance: "high" }]
      }
    }],
    policy: defaultDiscussionPolicy
  });
  assert.equal(highQuestion.snapshot.goalSatisfied, false);
});

test("an empty successful Wave advances one version without fabricating completion", () => {
  const previous = {
    ...emptyProgressSnapshot(),
    version: 4,
    goalSatisfied: true,
    confidence: 0.94,
    plateauCount: 1
  };
  const result = evaluateWaveProgress({
    previous,
    successfulResults: [],
    policy: defaultDiscussionPolicy
  });
  assert.equal(result.snapshot.version, 5);
  assert.equal(result.snapshot.goalSatisfied, false);
  assert.equal(result.snapshot.confidence, 0.94);
  assert.equal(result.snapshot.plateauCount, 2);
  assert.equal(result.snapshot.lastTurnAddedInformation, false);
  assert.deepEqual(result.members, []);
});

test("SemanticEvaluator normalizes evidence but cannot return state authority", async () => {
  let calls = 0;
  const evaluator: SemanticEvaluator = {
    async evaluate() {
      calls += 1;
      return {
        state: "completed",
        action: "finalize",
        evidence: {
          noveltyScore: 0.75,
          goalCoverage: 2,
          disagreementRemaining: "low",
          newEvidenceRefs: [" evidence_b ", "evidence_a", "evidence_a", ""]
        },
        recommendation: "finish"
      };
    }
  };
  const input = {
    goal: "Choose a safe rule.",
    previous: emptyProgressSnapshot(),
    members: []
  };
  assert.equal(await runOptionalSemanticEvaluation(undefined, input), null);
  const result = await runOptionalSemanticEvaluation(evaluator, input);
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    evidence: {
      noveltyScore: 0.75,
      disagreementRemaining: "low",
      newEvidenceRefs: ["evidence_a", "evidence_b"]
    },
    recommendation: "finish"
  });
  assert.equal("state" in (result ?? {}), false);
  assert.equal("action" in (result ?? {}), false);
  assert.equal(normalizeSemanticEvaluation({ state: "completed" }), null);
});

test("Wave aggregation rejects duplicate participant ordinals", () => {
  assert.throws(() => evaluateWaveProgress({
    previous: emptyProgressSnapshot(),
    successfulResults: [{
      participantOrdinal: 1,
      reply: "One.",
      assessment: null,
      speakerIsReviewer: false
    }, {
      participantOrdinal: 1,
      reply: "Two.",
      assessment: null,
      speakerIsReviewer: false
    }],
    policy: defaultDiscussionPolicy
  }), /Duplicate Wave participant ordinal/u);
});

test("current review replaces or invalidates stale approval", () => {
  const evaluate = (
    previousApproval: boolean,
    opinions: Array<boolean | undefined>
  ) => evaluateWaveProgress({
    previous: { ...emptyProgressSnapshot(), reviewerApproved: previousApproval },
    successfulResults: opinions.map((reviewerApproved, participantOrdinal) => ({
      participantOrdinal,
      reply: `Reviewer opinion ${participantOrdinal}.`,
      assessment: reviewerApproved === undefined ? {} : { reviewerApproved },
      speakerIsReviewer: true
    })),
    policy: defaultDiscussionPolicy
  }).snapshot.reviewerApproved;

  assert.equal(evaluate(true, [false]), false);
  assert.equal(evaluate(false, [true]), true);
  assert.equal(evaluate(true, [undefined]), false);
  assert.equal(evaluate(false, [true, false]), false);
  assert.equal(evaluate(false, [false, true]), false);

  const unchangedReply = "The already reviewed conclusion remains unchanged.";
  const unchanged = evaluateWaveProgress({
    previous: {
      ...emptyProgressSnapshot(),
      reviewerApproved: true,
      replyHashes: [hashDiscussionReply(unchangedReply)]
    },
    previousReplies: [unchangedReply],
    successfulResults: [{
      participantOrdinal: 0,
      reply: unchangedReply,
      assessment: { newInformationAdded: false },
      speakerIsReviewer: false
    }],
    policy: defaultDiscussionPolicy
  });
  assert.equal(unchanged.snapshot.lastTurnAddedInformation, false);
  assert.equal(unchanged.snapshot.reviewerApproved, true);

  const changedCompletion = evaluateWaveProgress({
    previous: {
      ...emptyProgressSnapshot(),
      reviewerApproved: true,
      replyHashes: [hashDiscussionReply(unchangedReply)]
    },
    previousReplies: [unchangedReply],
    successfulResults: [{
      participantOrdinal: 0,
      reply: unchangedReply,
      assessment: {
        goalSatisfied: true,
        confidence: 0.95,
        newInformationAdded: false
      },
      speakerIsReviewer: false
    }],
    policy: defaultDiscussionPolicy
  });
  assert.equal(changedCompletion.snapshot.lastTurnAddedInformation, false);
  assert.equal(changedCompletion.snapshot.goalSatisfied, true);
  assert.equal(changedCompletion.snapshot.reviewerApproved, false);
});

test("claimed evidence remains auditable but only verified evidence resets plateau", () => {
  const repeatedReply = "Use Redis because it provides lower latency for this request path.";
  const previous = {
    ...emptyProgressSnapshot(),
    plateauCount: 2,
    replyHashes: [hashDiscussionReply(repeatedReply)]
  };
  const claimedOnly = evaluateWaveProgress({
    previous,
    previousReplies: [repeatedReply],
    successfulResults: [{
      participantOrdinal: 0,
      reply: repeatedReply,
      assessment: {
        newEvidenceRefs: ["artifact_forged"],
        newInformationAdded: true
      },
      speakerIsReviewer: false
    }],
    policy: defaultDiscussionPolicy
  });

  assert.deepEqual(claimedOnly.snapshot.evidenceRefs, ["artifact_forged"]);
  assert.deepEqual(claimedOnly.snapshot.verifiedEvidenceRefs, []);
  assert.equal(claimedOnly.newEvidence, 0);
  assert.equal(claimedOnly.snapshot.plateauCount, 3);

  const verified = evaluateWaveProgress({
    previous,
    previousReplies: [repeatedReply],
    successfulResults: [{
      participantOrdinal: 0,
      reply: repeatedReply,
      assessment: { newEvidenceRefs: ["artifact_verified"] },
      speakerIsReviewer: false,
      verifiedEvidenceRefs: ["artifact_verified"]
    }],
    policy: defaultDiscussionPolicy
  });
  assert.deepEqual(verified.snapshot.evidenceRefs, ["artifact_verified"]);
  assert.deepEqual(verified.snapshot.verifiedEvidenceRefs, ["artifact_verified"]);
  assert.equal(verified.newEvidence, 1);
  assert.equal(verified.snapshot.plateauCount, 0);
});

test("lexical novelty suppresses near copies without becoming semantic judgment", () => {
  const cases = [{
    name: "exact duplicate",
    previous: "Use Redis because it provides lower latency for this request path.",
    current: "Use Redis because it provides lower latency for this request path.",
    repeated: true
  }, {
    name: "English clause reorder",
    previous: "Use Redis because it provides lower latency for this request path.",
    current: "Because Redis provides lower latency for this request path, use Redis.",
    repeated: true
  }, {
    name: "Chinese near copy",
    previous: "Redis 的延迟更低，因此我们建议在这个请求路径中使用 Redis。",
    current: "Redis 延迟更低，因此建议在这个请求路径中使用 Redis。",
    repeated: true
  }, {
    name: "materially different",
    previous: "Use Redis because it provides lower latency for this request path.",
    current: "Use PostgreSQL because durable transactions protect the billing ledger.",
    repeated: false
  }, {
    name: "substantially extended",
    previous: "Use Redis because it provides lower latency for this request path.",
    current: "Use Redis because it provides lower latency for this request path, " +
      "but first add failover measurements, a memory ceiling, persistence tests, " +
      "and a rollback criterion for every production region.",
    repeated: false
  }, {
    name: "short reply",
    previous: "Redis is faster.",
    current: "Redis has speed.",
    repeated: false
  }];

  for (const item of cases) {
    const evaluated = evaluateWaveProgress({
      previous: {
        ...emptyProgressSnapshot(),
        replyHashes: [hashDiscussionReply(item.previous)]
      },
      previousReplies: [item.previous],
      successfulResults: [{
        participantOrdinal: 0,
        reply: item.current,
        assessment: null,
        speakerIsReviewer: false
      }],
      policy: defaultDiscussionPolicy
    });
    assert.equal(
      evaluated.snapshot.plateauCount,
      item.repeated ? 1 : 0,
      item.name
    );
  }

  assert.ok(discussionReplySimilarity(
    cases[0]!.previous,
    cases[1]!.current
  ) >= 0.8);
  assert.equal(discussionReplySimilarity("Redis is faster.", "Redis has speed."), 0);
});

test("lexical comparison follows frozen Wave member order", () => {
  const results = [{
    participantOrdinal: 1,
    reply: "Because Redis provides lower latency for this request path, use Redis.",
    assessment: null,
    speakerIsReviewer: false
  }, {
    participantOrdinal: 0,
    reply: "Use Redis because it provides lower latency for this request path.",
    assessment: { newInformationAdded: false },
    speakerIsReviewer: false
  }];
  const input = {
    previous: { ...emptyProgressSnapshot(), plateauCount: 4 },
    policy: defaultDiscussionPolicy
  };

  const forward = evaluateWaveProgress({ ...input, successfulResults: results });
  const reversed = evaluateWaveProgress({
    ...input,
    successfulResults: [...results].reverse()
  });
  assert.deepEqual(reversed, forward);
  assert.equal(forward.snapshot.plateauCount, 5);
});

test("independent question and disagreement deltas override lexical repetition", () => {
  const repeatedReply = "Use Redis because it provides lower latency for this request path.";
  const previous = {
    ...emptyProgressSnapshot(),
    plateauCount: 3,
    replyHashes: [hashDiscussionReply(repeatedReply)],
    openQuestions: [{
      id: "q1",
      question: "Is the fallback bounded?",
      importance: "high" as const
    }],
    disagreementRemaining: "high" as const
  };
  for (const assessment of [
    { resolvedQuestionIds: ["q1"] },
    { disagreementRemaining: "low" }
  ]) {
    const evaluated = evaluateWaveProgress({
      previous,
      previousReplies: [repeatedReply],
      successfulResults: [{
        participantOrdinal: 0,
        reply: repeatedReply,
        assessment,
        speakerIsReviewer: false
      }],
      policy: defaultDiscussionPolicy
    });
    assert.equal(evaluated.snapshot.plateauCount, 0);
    assert.equal(evaluated.snapshot.lastTurnAddedInformation, true);
  }
});
