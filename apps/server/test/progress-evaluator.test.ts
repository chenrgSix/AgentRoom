import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultDiscussionPolicy,
  emptyProgressSnapshot
} from "../src/discussion/discussion-types.js";
import {
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

test("the current explicit Reviewer opinion replaces stale approval", () => {
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
  assert.equal(evaluate(true, [undefined]), true);
  assert.equal(evaluate(false, [true, false]), false);
  assert.equal(evaluate(false, [false, true]), false);
});
