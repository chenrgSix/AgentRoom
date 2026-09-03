import { createHash } from "node:crypto";

import { canonicalExecutionJSON } from
  "@convene-wire/contracts/execution-validation";

import type {
  DiscussionWaveSeal,
  DiscussionWaveSealMember
} from "./discussion-types.js";

export interface QuorumSealInput {
  sealId: string;
  discussionId: string;
  waveId: string;
  softDeadlineAt: string;
  minimumCompleted: number;
  requiredRoles: Array<"reviewer">;
  acceptedMembers: DiscussionWaveSealMember[];
  sealedAt: string;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalExecutionJSON(value))
    .digest("hex");
}

export function quorumSoftDeadline(
  waveCreatedAt: string,
  seconds: number
): string {
  return new Date(Date.parse(waveCreatedAt) + seconds * 1_000).toISOString();
}

export function createDiscussionWaveSeal(
  input: QuorumSealInput
): DiscussionWaveSeal {
  const acceptedMembers = [...input.acceptedMembers].sort(
    (left, right) => left.waveMemberOrdinal - right.waveMemberOrdinal
  );
  const unsigned = { ...input, acceptedMembers };
  return { ...unsigned, sealDigest: digest(unsigned) };
}

export function assertDiscussionWaveSeal(seal: DiscussionWaveSeal): void {
  const { sealDigest, ...unsigned } = seal;
  const members = seal.acceptedMembers;
  if (
    seal.sealId.trim().length === 0 ||
    seal.discussionId.trim().length === 0 ||
    seal.waveId.trim().length === 0 ||
    !Number.isSafeInteger(seal.minimumCompleted) ||
    seal.minimumCompleted < 2 || seal.minimumCompleted > 5 ||
    !Array.isArray(seal.requiredRoles) ||
    seal.requiredRoles.some((role) => role !== "reviewer") ||
    new Set(seal.requiredRoles).size !== seal.requiredRoles.length ||
    !Array.isArray(members) || members.length < seal.minimumCompleted ||
    members.length > 5 ||
    new Set(members.map(({ turnId }) => turnId)).size !== members.length ||
    new Set(members.map(({ agentId }) => agentId)).size !== members.length ||
    JSON.stringify(members.map(({ waveMemberOrdinal }) => waveMemberOrdinal)) !==
      JSON.stringify(
        members.map(({ waveMemberOrdinal }) => waveMemberOrdinal)
          .sort((left, right) => left - right)
      ) ||
    members.some((member) =>
      !Number.isSafeInteger(member.waveMemberOrdinal) ||
      member.waveMemberOrdinal < 0 ||
      !Number.isSafeInteger(member.sourceReplySequence) ||
      member.sourceReplySequence < 1 ||
      !Number.isSafeInteger(member.sourceMessageSequence) ||
      member.sourceMessageSequence < 1 ||
      !/^[a-f0-9]{64}$/u.test(member.replyHash)
    ) ||
    seal.requiredRoles.some((role) =>
      !members.some((member) => member.role === role)
    ) ||
    !/^[a-f0-9]{64}$/u.test(sealDigest) ||
    sealDigest !== digest(unsigned)
  ) {
    throw new Error("Discussion Wave seal is invalid");
  }
}

export function discussionSupplementalEvidenceDigest(input: {
  operationId: string;
  sealId: string;
  discussionId: string;
  waveId: string;
  turnId: string;
  runId: string;
  agentId: string;
  deviceId: string;
  sourceReplySequence: number;
  sourceMessageId: string;
  sourceMessageSequence: number;
  replyHash: string;
  submittedAt: string;
}): string {
  return digest(input);
}
