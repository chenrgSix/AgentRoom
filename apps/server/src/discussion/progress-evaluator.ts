import { createHash } from "node:crypto";

import type {
  AgentAssessment,
  DiscussionPolicy,
  OpenQuestion,
  ProgressSnapshot
} from "./discussion-types.js";

const importanceValues = new Set(["low", "medium", "high"]);
const disagreementValues = new Set(["none", "low", "medium", "high"]);

function stringList(value: unknown, maximum = 100): string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) {
    return undefined;
  }
  const result = value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0 && item.length <= 240
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
        question.id.length <= 160 &&
        typeof question.question === "string" && question.question.trim().length > 0 &&
        question.question.length <= 2_000 &&
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

export interface ProgressEvaluation {
  snapshot: ProgressSnapshot;
  assessment: AgentAssessment | null;
  replyHash: string;
  resolvedImportantQuestions: number;
  newEvidence: number;
}

export function evaluateProgress(input: {
  previous: ProgressSnapshot;
  reply: string;
  assessment: unknown;
  policy: DiscussionPolicy;
  speakerIsReviewer: boolean;
}): ProgressEvaluation {
  const assessment = parseAgentAssessment(input.assessment);
  const replyHash = hashDiscussionReply(input.reply);
  const replyIsNovel = !input.previous.replyHashes.includes(replyHash);
  const resolvedIds = new Set(assessment?.resolvedQuestionIds ?? []);
  const resolvedQuestions = input.previous.openQuestions.filter(({ id }) =>
    resolvedIds.has(id)
  );
  const openById = new Map(
    input.previous.openQuestions
      .filter(({ id }) => !resolvedIds.has(id))
      .map((question) => [question.id, question])
  );
  for (const question of assessment?.openQuestions ?? []) {
    openById.set(question.id, question);
  }
  const evidence = new Set(input.previous.evidenceRefs);
  const evidenceBefore = evidence.size;
  for (const reference of assessment?.newEvidenceRefs ?? []) {
    evidence.add(reference);
  }
  const disagreement = assessment?.disagreementRemaining ??
    input.previous.disagreementRemaining;
  const disagreementChanged = disagreement !== input.previous.disagreementRemaining;
  const addedInformation = replyIsNovel && assessment?.newInformationAdded !== false;
  const madeProgress =
    addedInformation || resolvedQuestions.length > 0 ||
    evidence.size > evidenceBefore || disagreementChanged;
  const openQuestions = [...openById.values()];
  const confidence = assessment?.confidence ?? input.previous.confidence;
  const reviewerApproved = input.previous.reviewerApproved ||
    (input.speakerIsReviewer && assessment?.reviewerApproved === true);
  const hasHighPriorityOpenQuestion = openQuestions.some(
    ({ importance }) => importance === "high"
  );
  const goalSatisfied = assessment?.goalSatisfied === true &&
    confidence !== null &&
    confidence >= input.policy.minimumCompletionConfidence &&
    !hasHighPriorityOpenQuestion;
  const replyHashes = [...input.previous.replyHashes, replyHash].slice(-50);

  return {
    snapshot: {
      version: input.previous.version + 1,
      goalSatisfied,
      confidence,
      openQuestions,
      evidenceRefs: [...evidence],
      disagreementRemaining: disagreement,
      reviewerApproved,
      plateauCount: madeProgress ? 0 : input.previous.plateauCount + 1,
      replyHashes,
      lastTurnAddedInformation: madeProgress
    },
    assessment,
    replyHash,
    resolvedImportantQuestions: resolvedQuestions.filter(
      ({ importance }) => importance !== "low"
    ).length,
    newEvidence: evidence.size - evidenceBefore
  };
}
