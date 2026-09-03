import assert from "node:assert/strict";
import test from "node:test";

import { waveCloseState } from "../src/discussion/discussion-state.js";
import { createDiscussionWaveSelection } from
  "../src/discussion/discussion-participant-selector.js";
import {
  buildWavePlan,
  selectFinalizer
} from "../src/discussion/discussion-wave-planner.js";
import {
  defaultDiscussionPolicy,
  type DiscussionParticipant,
  type DiscussionRecord
} from "../src/discussion/discussion-types.js";

const now = "2026-08-25T08:00:00.000Z";
const participants: DiscussionParticipant[] = [
  {
    discussionId: "discussion_12345678",
    agentId: "agent_builder123",
    ordinal: 0,
    role: "participant"
  },
  {
    discussionId: "discussion_12345678",
    agentId: "agent_reviewer12",
    ordinal: 1,
    role: "reviewer"
  }
];
const discussion = {
  discussionId: "discussion_12345678",
  currentWave: 3,
  currentTurn: 6,
  deadlineAt: "2026-08-25T08:30:00.000Z",
  policy: { ...defaultDiscussionPolicy, waveTimeoutSeconds: 600 }
} as DiscussionRecord;

function selection(agentIds: string[], strategy: "all_eligible" | "finalizer") {
  return createDiscussionWaveSelection({
    version: 1,
    strategy,
    focusQuestionIds: [],
    eligibleAgentIds: participants.map(({ agentId }) => agentId),
    selectedAgentIds: agentIds,
    requiredRoles: strategy === "finalizer" ? ["reviewer"] : [],
    focusedParticipantLimit: 3
  });
}

test("Wave planner freezes participant order and bounded deadlines", () => {
  const plan = buildWavePlan({
    discussion,
    participants,
    inputMessageId: "msg_anchor1234",
    kind: "discussion",
    selection: selection(participants.map(({ agentId }) => agentId), "all_eligible"),
    now
  });

  assert.equal(plan.wave.ordinal, 4);
  assert.equal(plan.wave.phase, "contribution");
  assert.equal(plan.wave.deadlineAt, "2026-08-25T08:10:00.000Z");
  assert.equal(plan.wave.expectedMembers, 2);
  assert.deepEqual(
    plan.turns.map(({ ordinal, speakerAgentId, waveMemberOrdinal, waveId }) => ({
      ordinal, speakerAgentId, waveMemberOrdinal, waveId
    })),
    [
      {
        ordinal: 7,
        speakerAgentId: "agent_builder123",
        waveMemberOrdinal: 0,
        waveId: plan.wave.waveId
      },
      {
        ordinal: 8,
        speakerAgentId: "agent_reviewer12",
        waveMemberOrdinal: 1,
        waveId: plan.wave.waveId
      }
    ]
  );
});

test("finalization planning prefers a reviewer and owns a five-minute boundary", () => {
  assert.equal(selectFinalizer(participants).agentId, "agent_reviewer12");
  const plan = buildWavePlan({
    discussion,
    participants: [selectFinalizer(participants)],
    inputMessageId: "msg_anchor1234",
    kind: "finalization",
    selection: selection([selectFinalizer(participants).agentId], "finalizer"),
    now
  });

  assert.equal(plan.wave.phase, "finalization");
  assert.equal(plan.wave.deadlineAt, "2026-08-25T08:05:00.000Z");
  assert.equal(plan.turns.length, 1);
});

test("Wave barrier close state is independent of callback order", () => {
  assert.equal(
    waveCloseState([{ state: "completed" }, { state: "completed" }]),
    "completed"
  );
  assert.equal(
    waveCloseState([{ state: "failed" }, { state: "completed" }]),
    "partial"
  );
  assert.equal(
    waveCloseState([{ state: "failed" }, { state: "failed" }]),
    "failed"
  );
  assert.equal(
    waveCloseState([{ state: "canceled" }, { state: "canceled" }]),
    "canceled"
  );
});
