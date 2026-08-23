import type {
  AgentAssessment,
  ProgressSnapshot
} from "./discussion-types.js";

const disagreementValues = new Set(["none", "low", "medium", "high"]);
const recommendationValues = new Set(["continue", "finish", "wait_human"]);

export interface SemanticWaveMember {
  participantOrdinal: number;
  reply: string;
  replyHash: string;
  assessment: AgentAssessment | null;
}

export interface SemanticEvaluationInput {
  goal: string;
  previous: Readonly<ProgressSnapshot>;
  members: readonly SemanticWaveMember[];
}

export interface SemanticEvidence {
  noveltyScore?: number;
  goalCoverage?: number;
  disagreementRemaining?: Exclude<
    ProgressSnapshot["disagreementRemaining"], "unknown"
  >;
  newEvidenceRefs?: string[];
}

export interface SemanticEvaluation {
  evidence: SemanticEvidence;
  recommendation: "continue" | "finish" | "wait_human" | null;
}

/**
 * Optional evidence provider. Its output is untrusted supporting evidence; it
 * deliberately has no Discussion state or action field.
 */
export interface SemanticEvaluator {
  evaluate(input: SemanticEvaluationInput): Promise<unknown>;
}

function boundedScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0 && value <= 1
    ? value
    : undefined;
}

function normalizedEvidenceRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const references = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 240);
  if (references.length === 0) return undefined;
  return [...new Set(references)].sort((left, right) =>
    left.localeCompare(right, "en-US")
  );
}

export function normalizeSemanticEvaluation(value: unknown): SemanticEvaluation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rawEvidence = raw.evidence && typeof raw.evidence === "object" &&
    !Array.isArray(raw.evidence)
    ? raw.evidence as Record<string, unknown>
    : {};
  const evidence: SemanticEvidence = {};
  const noveltyScore = boundedScore(rawEvidence.noveltyScore);
  if (noveltyScore !== undefined) evidence.noveltyScore = noveltyScore;
  const goalCoverage = boundedScore(rawEvidence.goalCoverage);
  if (goalCoverage !== undefined) evidence.goalCoverage = goalCoverage;
  if (
    typeof rawEvidence.disagreementRemaining === "string" &&
    disagreementValues.has(rawEvidence.disagreementRemaining)
  ) {
    evidence.disagreementRemaining = rawEvidence.disagreementRemaining as Exclude<
      ProgressSnapshot["disagreementRemaining"], "unknown"
    >;
  }
  const newEvidenceRefs = normalizedEvidenceRefs(rawEvidence.newEvidenceRefs);
  if (newEvidenceRefs) evidence.newEvidenceRefs = newEvidenceRefs;
  const recommendation = typeof raw.recommendation === "string" &&
    recommendationValues.has(raw.recommendation)
    ? raw.recommendation as SemanticEvaluation["recommendation"]
    : null;
  return Object.keys(evidence).length > 0 || recommendation !== null
    ? { evidence, recommendation }
    : null;
}

/** Returns null when semantic evaluation is not configured; no model is used by default. */
export async function runOptionalSemanticEvaluation(
  evaluator: SemanticEvaluator | undefined,
  input: SemanticEvaluationInput
): Promise<SemanticEvaluation | null> {
  if (!evaluator) return null;
  return normalizeSemanticEvaluation(await evaluator.evaluate(input));
}
