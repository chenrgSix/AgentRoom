import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDiscussionWaveSelection,
  createDiscussionWaveSelection,
  selectDiscussionParticipants,
  type DiscussionParticipantCandidate
} from "../src/discussion/discussion-participant-selector.js";
import {
  defaultDiscussionPolicy,
  emptyBudgetSnapshot,
  emptyProgressSnapshot,
  type DiscussionRecord
} from "../src/discussion/discussion-types.js";

const discussionId = "discussion_focused123";
const agents = {
  backend: "agent_backend123",
  docs: "agent_docs123456",
  reviewer: "agent_reviewer123",
  security: "agent_security123"
};

function discussion(overrides: Partial<DiscussionRecord> = {}): DiscussionRecord {
  return {
    discussionId,
    roomId: "room_focused123",
    taskId: "task_focused123",
    rootMessageId: "msg_focused1234",
    requesterMemberId: "member_focused1",
    goal: "Resolve the highest-risk implementation questions.",
    mode: "review",
    state: "active",
    stateReason: null,
    outputMode: "decision_record",
    policy: { ...defaultDiscussionPolicy, focusedParticipantLimit: 3 },
    progress: {
      ...emptyProgressSnapshot(),
      version: 1,
      openQuestions: [{
        id: "question:security",
        question: "Which security boundary protects the token exchange?",
        importance: "high"
      }, {
        id: "question:docs",
        question: "Which documentation page needs an example?",
        importance: "medium"
      }]
    },
    budget: emptyBudgetSnapshot(defaultDiscussionPolicy.initialLeaseTurns),
    executionModel: "parallel_wave",
    currentTurn: 4,
    currentWave: 1,
    nextSpeakerIndex: 0,
    requestedAction: null,
    version: 2,
    deadlineAt: "2026-09-03T11:20:00.000Z",
    createdAt: "2026-09-03T11:00:00.000Z",
    updatedAt: "2026-09-03T11:05:00.000Z",
    terminalAt: null,
    ...overrides
  };
}

function candidates(): DiscussionParticipantCandidate[] {
  return [
    {
      participant: { discussionId, ordinal: 0, agentId: agents.backend, role: "participant" },
      agentRole: "Backend Engineer",
      taskRole: "primary",
      reportedQuestionIds: []
    },
    {
      participant: { discussionId, ordinal: 1, agentId: agents.security, role: "participant" },
      agentRole: "Security Specialist",
      taskRole: "contributor",
      reportedQuestionIds: []
    },
    {
      participant: { discussionId, ordinal: 2, agentId: agents.docs, role: "participant" },
      agentRole: "Documentation Writer",
      taskRole: "contributor",
      reportedQuestionIds: ["question:docs"]
    },
    {
      participant: { discussionId, ordinal: 3, agentId: agents.reviewer, role: "reviewer" },
      agentRole: "Architecture Reviewer",
      taskRole: "reviewer",
      reportedQuestionIds: []
    }
  ];
}

test("focused selection uses only highest-priority reporters and role matches", () => {
  const input = candidates();
  input[0]!.reportedQuestionIds = ["question:security"];
  const result = selectDiscussionParticipants({
    discussion: discussion(),
    candidates: input
  });

  assert.equal(result.snapshot.strategy, "question_focused");
  assert.deepEqual(result.snapshot.focusQuestionIds, ["question:security"]);
  assert.deepEqual(result.snapshot.eligibleAgentIds, [
    agents.backend, agents.security, agents.docs, agents.reviewer
  ]);
  assert.deepEqual(result.snapshot.selectedAgentIds, [
    agents.backend, agents.security, agents.reviewer
  ]);
  assert.deepEqual(result.snapshot.requiredRoles, ["reviewer"]);
  assert.match(result.snapshot.selectionDigest, /^[a-f0-9]{64}$/u);
  assertDiscussionWaveSelection(result.snapshot, result.snapshot.selectedAgentIds);
});

test("candidate and question permutations retain one ordered selection digest", () => {
  const first = candidates();
  first[0]!.reportedQuestionIds = ["question:security"];
  const left = selectDiscussionParticipants({
    discussion: discussion(),
    candidates: first
  });
  const right = selectDiscussionParticipants({
    discussion: discussion({
      progress: {
        ...discussion().progress,
        openQuestions: [...discussion().progress.openQuestions].reverse()
      }
    }),
    candidates: [...first].reverse()
  });

  assert.deepEqual(right.snapshot, left.snapshot);
});

test("first-Wave, no-match and compatibility policies stay broad", () => {
  const firstWave = selectDiscussionParticipants({
    discussion: discussion({ progress: emptyProgressSnapshot(), currentWave: 0 }),
    candidates: candidates()
  });
  assert.equal(firstWave.snapshot.strategy, "all_eligible");
  assert.deepEqual(firstWave.snapshot.selectedAgentIds, firstWave.snapshot.eligibleAgentIds);

  const noMatch = selectDiscussionParticipants({
    discussion: discussion({
      progress: {
        ...discussion().progress,
        openQuestions: [{
          id: "question:legal",
          question: "Which jurisdiction controls this agreement?",
          importance: "high"
        }]
      }
    }),
    candidates: candidates()
  });
  assert.equal(noMatch.snapshot.strategy, "all_eligible");

  const compatibility = selectDiscussionParticipants({
    discussion: discussion({
      policy: {
        ...defaultDiscussionPolicy,
        participantSelectionMode: "all_eligible",
        focusedParticipantLimit: 2
      }
    }),
    candidates: candidates()
  });
  assert.deepEqual(
    compatibility.snapshot.selectedAgentIds,
    compatibility.snapshot.eligibleAgentIds
  );
});

test("required Reviewer is retained and finalization selects only that Reviewer", () => {
  const contribution = selectDiscussionParticipants({
    discussion: discussion({
      policy: { ...defaultDiscussionPolicy, focusedParticipantLimit: 2 }
    }),
    candidates: candidates()
  });
  assert.deepEqual(contribution.snapshot.selectedAgentIds, [
    agents.security, agents.reviewer
  ]);

  const finalization = selectDiscussionParticipants({
    discussion: discussion(),
    candidates: candidates(),
    finalization: true
  });
  assert.equal(finalization.snapshot.strategy, "finalizer");
  assert.deepEqual(finalization.snapshot.selectedAgentIds, [agents.reviewer]);
});

test("selection digest and member substitutions fail closed", () => {
  const value = selectDiscussionParticipants({
    discussion: discussion(),
    candidates: candidates()
  }).snapshot;
  assert.throws(() => assertDiscussionWaveSelection({
    ...value,
    selectedAgentIds: [...value.selectedAgentIds].reverse()
  }), /selection snapshot is invalid/u);
  assert.throws(() => assertDiscussionWaveSelection(
    value,
    [agents.security, agents.backend, agents.reviewer]
  ), /selection snapshot is invalid/u);
});


test("finalizers prefer eligible Reviewer, then current primary, then frozen ordinal", () => {
  const input = candidates();
  input[0]!.taskRole = "contributor";
  input[2]!.taskRole = "primary";
  for (const [available, expected, reason] of [
    [input, agents.reviewer, "finalizer_reviewer"],
    [input.slice(0, 3).reverse(), agents.docs, "finalizer_primary"],
    [input.slice(0, 2).reverse(), agents.backend, "finalizer_ordinal"]
  ] as const) {
    const result = selectDiscussionParticipants({
      discussion: discussion(), candidates: [...available], finalization: true
    }).snapshot;
    assert.deepEqual(result.selectedAgentIds, [expected]);
    assert.deepEqual(result.explanations?.[0]?.reasons, [reason]);
  }
  assert.throws(() => selectDiscussionParticipants({
    discussion: discussion(), candidates: [], finalization: true
  }), /no eligible participant/u);
});

test("explanations retain matched facts, broad fallback reasons and reject tampering", () => {
  const input = candidates();
  input[0]!.reportedQuestionIds = ["question:security"];
  const value = selectDiscussionParticipants({ discussion: discussion(), candidates: input }).snapshot;
  assert.equal(value.version, 2);
  assert.deepEqual(value.explanations?.map(({ reasons }) => reasons), [
    ["question_reporter"], ["role_match"], ["required_reviewer"]
  ]);
  assert.deepEqual(value.explanations?.[0]?.reportedQuestionIds, ["question:security"]);
  assert.deepEqual(value.explanations?.[1]?.matchedRoleTerms, ["security"]);
  input[1]!.agentRole = "Unrelated";
  assert.deepEqual(value.explanations?.[1]?.matchedRoleTerms, ["security"]);
  const tampered = structuredClone(value);
  tampered.explanations![1]!.matchedRoleTerms = ["unrelated"];
  assert.throws(() => assertDiscussionWaveSelection(tampered), /invalid/u);
  for (const [policy, questions, expected] of [
    ["all_eligible", [], "all_member_policy"],
    ["question_focused", [], "no_focus_questions"],
    ["question_focused", [{ id: "question:legal", question: "Jurisdiction?", importance: "high" }],
      "no_deterministic_match"]
  ] as const) {
    const broad = selectDiscussionParticipants({
      discussion: discussion({
        policy: { ...defaultDiscussionPolicy, participantSelectionMode: policy },
        progress: { ...emptyProgressSnapshot(), openQuestions: [...questions] }
      }), candidates: input
    }).snapshot;
    assert.ok(broad.explanations?.every(({ reasons }) => reasons[0] === expected));
  }
  const invalid = structuredClone(value);
  invalid.explanations![0]!.reportedQuestionIds = ["unknown"];
  assert.throws(() => assertDiscussionWaveSelection(createDiscussionWaveSelection(invalid)), /invalid/u);
});

test("legacy selection canonical bytes and absence of explanations remain exact", () => {
  const legacy = createDiscussionWaveSelection({
    version: 1, strategy: "all_eligible", focusQuestionIds: [],
    eligibleAgentIds: [agents.backend], selectedAgentIds: [agents.backend],
    requiredRoles: [], focusedParticipantLimit: 3
  });
  assert.equal(legacy.selectionDigest, createHash("sha256").update(JSON.stringify([
    1, "all_eligible", [], [agents.backend], [agents.backend], [], 3
  ])).digest("hex"));
  assertDiscussionWaveSelection(legacy);
  assert.throws(() => assertDiscussionWaveSelection({ ...legacy, explanations: [] }), /invalid/u);
});
