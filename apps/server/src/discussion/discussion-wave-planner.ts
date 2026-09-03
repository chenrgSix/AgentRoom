import { createOpaqueId } from "../domain/identifiers.js";
import type {
  DiscussionParticipant,
  DiscussionRecord,
  DiscussionTurn,
  DiscussionWave,
  DiscussionWaveSelection
} from "./discussion-types.js";
import { assertDiscussionWaveSelection } from
  "./discussion-participant-selector.js";

const finalizationDurationMilliseconds = 5 * 60 * 1000;

export interface WavePlan {
  wave: DiscussionWave;
  turns: DiscussionTurn[];
}

export function buildWavePlan(input: {
  discussion: DiscussionRecord;
  participants: DiscussionParticipant[];
  inputMessageId: string;
  kind: DiscussionTurn["kind"];
  selection: DiscussionWaveSelection;
  now: string;
}): WavePlan {
  if (input.participants.length === 0) {
    throw new Error("Discussion Wave has no eligible participant");
  }
  assertDiscussionWaveSelection(
    input.selection,
    input.participants.map(({ agentId }) => agentId)
  );
  const waveId = createOpaqueId("wave");
  const waveOrdinal = (input.discussion.currentWave ?? 0) + 1;
  const deadlineAt = input.kind === "finalization"
    ? new Date(Date.parse(input.now) + finalizationDurationMilliseconds).toISOString()
    : new Date(Math.min(
        Date.parse(input.discussion.deadlineAt),
        Date.parse(input.now) + input.discussion.policy.waveTimeoutSeconds * 1_000
      )).toISOString();
  const wave: DiscussionWave = {
    waveId,
    discussionId: input.discussion.discussionId,
    ordinal: waveOrdinal,
    phase: input.kind === "finalization" ? "finalization" : "contribution",
    inputMessageId: input.inputMessageId,
    state: "open",
    deadlineAt,
    expectedMembers: input.participants.length,
    version: 1,
    createdAt: input.now,
    updatedAt: input.now,
    closedAt: null,
    selection: input.selection
  };
  const turns: DiscussionTurn[] = input.participants.map(
    (participant, waveMemberOrdinal) => ({
      turnId: createOpaqueId("turn"),
      discussionId: input.discussion.discussionId,
      ordinal: input.discussion.currentTurn + waveMemberOrdinal + 1,
      kind: input.kind,
      speakerAgentId: participant.agentId,
      inputMessageId: input.inputMessageId,
      runId: null,
      outputMessageId: null,
      state: "planned",
      assessment: null,
      replyHash: null,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
      waveId,
      waveMemberOrdinal,
      terminalReason: null
    })
  );
  return { wave, turns };
}

export function selectFinalizer(
  participants: DiscussionParticipant[]
): DiscussionParticipant {
  const finalizer = participants.find(({ role }) => role === "reviewer") ??
    participants[0];
  if (!finalizer) throw new Error("Discussion has no finalizer");
  return finalizer;
}
