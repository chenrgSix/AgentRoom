import { createHash } from "node:crypto";

import { exceedsUnicodeCodePointLimit } from "../domain/unicode-length.js";
import type {
  AgentAssessment,
  DiscussionPolicy,
  OpenQuestion,
  ProgressSnapshot
} from "./discussion-types.js";

const importanceValues = new Set(["low", "medium", "high"]);
const disagreementValues = new Set(["none", "low", "medium", "high"]);
const importanceRank: Record<OpenQuestion["importance"], number> = {
  low: 0,
  medium: 1,
  high: 2
};
const disagreementRank: Record<
  Exclude<ProgressSnapshot["disagreementRemaining"], "unknown">,
  number
> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3
};
const minimumLexicalComparisonCodePoints = 20;
const minimumLexicalLengthRatio = 0.8;
const lexicalNearDuplicateThreshold = 0.8;
const maximumPreviousRepliesCompared = 10;

function stringList(value: unknown, maximum = 100): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) {
    return undefined;
  }
  const result = value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0 &&
      !exceedsUnicodeCodePointLimit(item, 240)
  );
  return result.length === value.length ? result : undefined;
}

export function parseAgentAssessment(value: unknown): AgentAssessment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const parsed: AgentAssessment = {};
  if (typeof raw.goalSatisfied === "boolean") {
    parsed.goalSatisfied = raw.goalSatisfied;
  }
  if (
    typeof raw.confidence === "number" &&
    Number.isFinite(raw.confidence) &&
    raw.confidence >= 0 && raw.confidence <= 1
  ) {
    parsed.confidence = raw.confidence;
  }
  const resolvedQuestionIds = stringList(raw.resolvedQuestionIds);
  if (resolvedQuestionIds) {
    parsed.resolvedQuestionIds = resolvedQuestionIds;
  }
  const newEvidenceRefs = stringList(raw.newEvidenceRefs);
  if (newEvidenceRefs) {
    parsed.newEvidenceRefs = newEvidenceRefs;
  }
  if (Array.isArray(raw.openQuestions) && raw.openQuestions.length <= 50) {
    const questions: OpenQuestion[] = [];
    for (const item of raw.openQuestions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const question = item as Record<string, unknown>;
      if (
        typeof question.id === "string" && question.id.trim().length > 0 &&
        !exceedsUnicodeCodePointLimit(question.id, 160) &&
        typeof question.question === "string" && question.question.trim().length > 0 &&
        !exceedsUnicodeCodePointLimit(question.question, 2_000) &&
        typeof question.importance === "string" &&
        importanceValues.has(question.importance)
      ) {
        questions.push({
          id: question.id,
          question: question.question,
          importance: question.importance as OpenQuestion["importance"]
        });
      }
    }
    if (questions.length === raw.openQuestions.length) {
      parsed.openQuestions = questions;
    }
  }
  if (
    typeof raw.disagreementRemaining === "string" &&
    disagreementValues.has(raw.disagreementRemaining)
  ) {
    parsed.disagreementRemaining = raw.disagreementRemaining as Exclude<
      ProgressSnapshot["disagreementRemaining"], "unknown"
    >;
  }
  if (typeof raw.newInformationAdded === "boolean") {
    parsed.newInformationAdded = raw.newInformationAdded;
  }
  if (typeof raw.reviewerApproved === "boolean") {
    parsed.reviewerApproved = raw.reviewerApproved;
  }
  if (
    raw.recommendation === "continue" || raw.recommendation === "finish" ||
    raw.recommendation === "wait_human"
  ) {
    parsed.recommendation = raw.recommendation;
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

export function hashDiscussionReply(reply: string): string {
  const normalized = reply
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizedLexicalCharacters(reply: string): string[] {
  return Array.from(reply
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, ""));
}

function characterBigrams(characters: readonly string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let index = 0; index < characters.length - 1; index += 1) {
    bigrams.add(characters[index]! + characters[index + 1]!);
  }
  return bigrams;
}

export function discussionReplySimilarity(left: string, right: string): number {
  const leftCharacters = normalizedLexicalCharacters(left);
  const rightCharacters = normalizedLexicalCharacters(right);
  const shortestLength = Math.min(leftCharacters.length, rightCharacters.length);
  const longestLength = Math.max(leftCharacters.length, rightCharacters.length);
  if (
    shortestLength < minimumLexicalComparisonCodePoints ||
    shortestLength / longestLength < minimumLexicalLengthRatio
  ) {
    return 0;
  }
  const leftBigrams = characterBigrams(leftCharacters);
  const rightBigrams = characterBigrams(rightCharacters);
  let intersection = 0;
  for (const bigram of leftBigrams) {
    if (rightBigrams.has(bigram)) intersection += 1;
  }
  return (2 * intersection) / (leftBigrams.size + rightBigrams.size);
}

export interface ProgressEvaluation {
  snapshot: ProgressSnapshot;
  assessment: AgentAssessment | null;
  replyHash: string;
  resolvedImportantQuestions: number;
  newEvidence: number;
}

export interface SuccessfulWaveResult {
  participantOrdinal: number;
  reply: string;
  assessment: unknown;
  speakerIsReviewer: boolean;
  verifiedEvidenceRefs?: readonly string[];
}

export interface WaveMemberProgressEvaluation {
  participantOrdinal: number;
  assessment: AgentAssessment | null;
  replyHash: string;
}

export interface WaveProgressEvaluation {
  snapshot: ProgressSnapshot;
  members: WaveMemberProgressEvaluation[];
  resolvedImportantQuestions: number;
  newEvidence: number;
}

function mergeOpenQuestion(
  current: OpenQuestion | undefined,
  candidate: OpenQuestion
): OpenQuestion {
  if (!current) return candidate;
  const currentImportance = importanceRank[current.importance];
  const candidateImportance = importanceRank[candidate.importance];
  if (candidateImportance > currentImportance) return candidate;
  if (candidateImportance < currentImportance) return current;
  return candidate.question.localeCompare(current.question, "en-US") < 0
    ? candidate
    : current;
}

function sortSuccessfulResults(
  results: readonly SuccessfulWaveResult[]
): SuccessfulWaveResult[] {
  const ordinals = new Set<number>();
  const sorted = [...results].sort(
    (left, right) => left.participantOrdinal - right.participantOrdinal
  );
  for (const result of sorted) {
    if (
      !Number.isSafeInteger(result.participantOrdinal) ||
      result.participantOrdinal < 0
    ) {
      throw new Error("Wave participant ordinal must be a non-negative integer");
    }
    if (ordinals.has(result.participantOrdinal)) {
      throw new Error(`Duplicate Wave participant ordinal: ${result.participantOrdinal}`);
    }
    ordinals.add(result.participantOrdinal);
  }
  return sorted;
}

/**
 * Applies one all-settled Wave to the durable progress projection. Only
 * successful participant results belong here; failed members are accounted for
 * by orchestration policy and cannot contribute completion evidence.
 */
export function evaluateWaveProgress(input: {
  previous: ProgressSnapshot;
  successfulResults: readonly SuccessfulWaveResult[];
  policy: DiscussionPolicy;
  previousReplies?: readonly string[];
}): WaveProgressEvaluation {
  const sortedResults = sortSuccessfulResults(input.successfulResults);
  const members = sortedResults.map((result) => ({
    participantOrdinal: result.participantOrdinal,
    assessment: parseAgentAssessment(result.assessment),
    replyHash: hashDiscussionReply(result.reply)
  }));

  const resolvedIds = new Set<string>();
  for (const member of members) {
    for (const questionId of member.assessment?.resolvedQuestionIds ?? []) {
      resolvedIds.add(questionId);
    }
  }

  const openById = new Map(
    input.previous.openQuestions
      .filter(({ id }) => !resolvedIds.has(id))
      .map((question) => [question.id, question])
  );
  for (const member of members) {
    for (const question of member.assessment?.openQuestions ?? []) {
      openById.set(question.id, mergeOpenQuestion(openById.get(question.id), question));
    }
  }
  const openQuestions = [...openById.values()].sort((left, right) =>
    left.id.localeCompare(right.id, "en-US")
  );
  const resolvedQuestions = input.previous.openQuestions.filter(
    ({ id }) => resolvedIds.has(id) && !openById.has(id)
  );

  const evidence = new Set(input.previous.evidenceRefs);
  for (const member of members) {
    for (const reference of member.assessment?.newEvidenceRefs ?? []) {
      evidence.add(reference);
    }
  }
  const evidenceRefs = [...evidence].sort((left, right) =>
    left.localeCompare(right, "en-US")
  );
  const verifiedEvidenceBefore = new Set(
    input.previous.verifiedEvidenceRefs ?? []
  );
  const verifiedEvidence = new Set(verifiedEvidenceBefore);
  for (const [index, result] of sortedResults.entries()) {
    const claimedReferences = new Set(
      members[index]?.assessment?.newEvidenceRefs ?? []
    );
    for (const reference of result.verifiedEvidenceRefs ?? []) {
      if (claimedReferences.has(reference)) verifiedEvidence.add(reference);
    }
  }
  const verifiedEvidenceRefs = [...verifiedEvidence].sort((left, right) =>
    left.localeCompare(right, "en-US")
  );

  const reportedDisagreement = members
    .map(({ assessment }) => assessment?.disagreementRemaining)
    .filter((value): value is Exclude<
      ProgressSnapshot["disagreementRemaining"], "unknown"
    > => value !== undefined);
  const disagreementRemaining = reportedDisagreement.length === 0
    ? input.previous.disagreementRemaining
    : reportedDisagreement.reduce((highest, current) =>
        disagreementRank[current] > disagreementRank[highest] ? current : highest
      );

  const reportedConfidences = members
    .map(({ assessment }) => assessment?.confidence)
    .filter((value): value is number => value !== undefined);
  const confidence = reportedConfidences.length === 0
    ? input.previous.confidence
    : Math.min(...reportedConfidences);
  const currentReviewerOpinions = sortedResults.flatMap((result, index) => {
    const opinion = members[index]?.assessment?.reviewerApproved;
    return result.speakerIsReviewer && opinion !== undefined ? [opinion] : [];
  });
  const reviewerApproved = currentReviewerOpinions.length === 0
    ? input.previous.reviewerApproved
    : currentReviewerOpinions.every((approved) => approved);

  const completionAssessments = members
    .map(({ assessment }) => assessment)
    .filter((assessment): assessment is AgentAssessment =>
      assessment !== null &&
      (assessment.goalSatisfied !== undefined || assessment.confidence !== undefined)
    );
  const hasHighPriorityOpenQuestion = openQuestions.some(
    ({ importance }) => importance === "high"
  );
  const goalSatisfied = sortedResults.length > 0 &&
    completionAssessments.length > 0 &&
    completionAssessments.every((assessment) =>
      assessment.goalSatisfied === true &&
      assessment.confidence !== undefined &&
      assessment.confidence >= input.policy.minimumCompletionConfidence
    ) &&
    !hasHighPriorityOpenQuestion;

  const knownReplyHashes = new Set(input.previous.replyHashes);
  const replyHashes = [...input.previous.replyHashes];
  const comparisonReplies = [...(input.previousReplies ?? [])]
    .slice(-maximumPreviousRepliesCompared);
  let addedNovelReply = false;
  for (const [index, member] of members.entries()) {
    const isExactNovel = !knownReplyHashes.has(member.replyHash);
    if (isExactNovel) {
      knownReplyHashes.add(member.replyHash);
      replyHashes.push(member.replyHash);
    }
    const isLexicalNearDuplicate = comparisonReplies.some((previousReply) =>
      discussionReplySimilarity(sortedResults[index]!.reply, previousReply) >=
        lexicalNearDuplicateThreshold
    );
    const isNovel = isExactNovel && !isLexicalNearDuplicate;
    if (isNovel && member.assessment?.newInformationAdded !== false) {
      addedNovelReply = true;
    }
    comparisonReplies.push(sortedResults[index]!.reply);
    // Keep the sorted result and member arrays structurally aligned.
    if (sortedResults[index]?.participantOrdinal !== member.participantOrdinal) {
      throw new Error("Wave progress member ordering invariant failed");
    }
  }

  const newEvidence = verifiedEvidence.size - verifiedEvidenceBefore.size;
  const disagreementChanged =
    disagreementRemaining !== input.previous.disagreementRemaining;
  const madeProgress = addedNovelReply || resolvedQuestions.length > 0 ||
    newEvidence > 0 || disagreementChanged;

  return {
    snapshot: {
      version: input.previous.version + 1,
      goalSatisfied,
      confidence,
      openQuestions,
      evidenceRefs,
      verifiedEvidenceRefs,
      disagreementRemaining,
      reviewerApproved,
      plateauCount: madeProgress ? 0 : input.previous.plateauCount + 1,
      replyHashes: replyHashes.slice(-50),
      lastTurnAddedInformation: madeProgress
    },
    members,
    resolvedImportantQuestions: resolvedQuestions.filter(
      ({ importance }) => importance !== "low"
    ).length,
    newEvidence
  };
}

export function evaluateProgress(input: {
  previous: ProgressSnapshot;
  reply: string;
  assessment: unknown;
  policy: DiscussionPolicy;
  speakerIsReviewer: boolean;
}): ProgressEvaluation {
  const wave = evaluateWaveProgress({
    previous: input.previous,
    successfulResults: [{
      participantOrdinal: 0,
      reply: input.reply,
      assessment: input.assessment,
      speakerIsReviewer: input.speakerIsReviewer
    }],
    policy: input.policy
  });
  const member = wave.members[0];
  if (!member) {
    throw new Error("Single-member progress evaluation produced no member result");
  }

  return {
    snapshot: wave.snapshot,
    assessment: member.assessment,
    replyHash: member.replyHash,
    resolvedImportantQuestions: wave.resolvedImportantQuestions,
    newEvidence: wave.newEvidence
  };
}
