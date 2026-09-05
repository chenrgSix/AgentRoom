import { createHash } from "node:crypto";

import type {
  DiscussionParticipant,
  DiscussionRecord,
  DiscussionSelectionExplanation,
  DiscussionSelectionReason,
  DiscussionWaveSelection,
  OpenQuestion
} from "./discussion-types.js";

export interface DiscussionParticipantCandidate {
  participant: DiscussionParticipant;
  agentRole: string;
  taskRole: "primary" | "contributor" | "reviewer" | null;
  reportedQuestionIds: string[];
}

export interface DiscussionParticipantSelection {
  participants: DiscussionParticipant[];
  snapshot: DiscussionWaveSelection;
}

const importanceRank: Record<OpenQuestion["importance"], number> = {
  low: 0,
  medium: 1,
  high: 2
};

const genericRoleTerms = new Set([
  "agent",
  "assistant",
  "contributor",
  "developer",
  "engineer",
  "participant",
  "primary"
]);

function canonicalSelection(
  selection: Omit<DiscussionWaveSelection, "selectionDigest">
): string {
  const fields: unknown[] = [
    selection.version,
    selection.strategy,
    selection.focusQuestionIds,
    selection.eligibleAgentIds,
    selection.selectedAgentIds,
    selection.requiredRoles,
    selection.focusedParticipantLimit
  ];
  if (selection.version === 2) {
    fields.push(selection.explanations?.map((entry) => [
      entry.agentId, entry.reasons, entry.reportedQuestionIds, entry.matchedRoleTerms
    ]));
  }
  return JSON.stringify(fields);
}

export function createDiscussionWaveSelection(
  selection: Omit<DiscussionWaveSelection, "selectionDigest">
): DiscussionWaveSelection {
  return {
    ...selection,
    selectionDigest: createHash("sha256")
      .update(canonicalSelection(selection))
      .digest("hex")
  };
}

function validExplanations(selection: DiscussionWaveSelection): boolean {
  if (selection.version === 1) return selection.explanations === undefined;
  const entries = selection.explanations;
  const allowed: DiscussionSelectionReason[] = selection.strategy === "finalizer"
    ? ["finalizer_reviewer", "finalizer_primary", "finalizer_ordinal"]
    : selection.strategy === "all_eligible"
      ? ["all_member_policy", "no_focus_questions", "no_deterministic_match"]
      : ["question_reporter", "role_match", "required_reviewer"];
  const uniqueStrings = (values: unknown): values is string[] =>
    Array.isArray(values) && values.every((value) =>
      typeof value === "string" && value.trim().length > 0
    ) && new Set(values).size === values.length;
  return Array.isArray(entries) && entries.length === selection.selectedAgentIds.length &&
    entries.every((entry, index) => entry &&
      entry.agentId === selection.selectedAgentIds[index] &&
      uniqueStrings(entry.reasons) && entry.reasons.length > 0 &&
      entry.reasons.every((reason) => allowed.includes(reason)) &&
      (selection.strategy === "question_focused" || entry.reasons.length === 1) &&
      uniqueStrings(entry.reportedQuestionIds) &&
      entry.reportedQuestionIds.every((id) => selection.focusQuestionIds.includes(id)) &&
      uniqueStrings(entry.matchedRoleTerms) &&
      entry.reasons.includes("question_reporter") === (entry.reportedQuestionIds.length > 0) &&
      entry.reasons.includes("role_match") === (entry.matchedRoleTerms.length > 0) &&
      (!entry.reasons.includes("required_reviewer") || selection.requiredRoles.includes("reviewer"))
    );
}

export function assertDiscussionWaveSelection(
  selection: DiscussionWaveSelection,
  turnAgentIds?: readonly string[]
): void {
  if (
    !selection || typeof selection !== "object" ||
    !Array.isArray(selection.focusQuestionIds) ||
    !Array.isArray(selection.eligibleAgentIds) ||
    !Array.isArray(selection.selectedAgentIds) ||
    !Array.isArray(selection.requiredRoles)
  ) {
    throw new Error("Discussion Wave selection snapshot is invalid");
  }
  const { selectionDigest: _selectionDigest, ...unsigned } = selection;
  const digest = createHash("sha256")
    .update(canonicalSelection(unsigned))
    .digest("hex");
  if (
    ![1, 2].includes(selection.version) ||
    !validExplanations(selection) ||
    !new Set(["all_eligible", "question_focused", "finalizer"])
      .has(selection.strategy) ||
    !Number.isSafeInteger(selection.focusedParticipantLimit) ||
    selection.focusedParticipantLimit < 2 ||
    selection.focusedParticipantLimit > 5 ||
    !/^[a-f0-9]{64}$/u.test(selection.selectionDigest) ||
    selection.selectionDigest !== digest ||
    selection.focusQuestionIds.some((id) =>
      typeof id !== "string" || id.trim().length === 0
    ) ||
    selection.eligibleAgentIds.some((id) =>
      typeof id !== "string" || id.trim().length === 0
    ) ||
    selection.selectedAgentIds.some((id) =>
      typeof id !== "string" || id.trim().length === 0
    ) ||
    new Set(selection.focusQuestionIds).size !== selection.focusQuestionIds.length ||
    JSON.stringify(selection.focusQuestionIds) !== JSON.stringify(
      [...selection.focusQuestionIds].sort((left, right) =>
        left.localeCompare(right, "en-US")
      )
    ) ||
    new Set(selection.eligibleAgentIds).size !== selection.eligibleAgentIds.length ||
    new Set(selection.selectedAgentIds).size !== selection.selectedAgentIds.length ||
    selection.selectedAgentIds.length === 0 ||
    selection.selectedAgentIds.some((agentId) =>
      !selection.eligibleAgentIds.includes(agentId)
    ) ||
    selection.requiredRoles.some((role) => role !== "reviewer") ||
    new Set(selection.requiredRoles).size !== selection.requiredRoles.length ||
    (selection.strategy === "all_eligible" &&
      JSON.stringify(selection.selectedAgentIds) !==
        JSON.stringify(selection.eligibleAgentIds)) ||
    (selection.strategy === "question_focused" &&
      selection.focusQuestionIds.length === 0) ||
    (selection.strategy === "question_focused" &&
      selection.selectedAgentIds.length > selection.focusedParticipantLimit) ||
    (selection.strategy === "finalizer" &&
      selection.selectedAgentIds.length !== 1) ||
    (turnAgentIds !== undefined &&
      JSON.stringify(selection.selectedAgentIds) !== JSON.stringify(turnAgentIds))
  ) {
    throw new Error("Discussion Wave selection snapshot is invalid");
  }
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function roleTerms(candidate: DiscussionParticipantCandidate): string[] {
  const terms = normalized([
    candidate.agentRole,
    candidate.taskRole ?? ""
  ].join(" ")).match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms.filter((term) =>
    !genericRoleTerms.has(term) &&
    ([...term].length >= 3 || /[^\u0000-\u007f]/u.test(term))
  ))];
}

function highestPriorityQuestions(
  questions: readonly OpenQuestion[]
): OpenQuestion[] {
  const highest = questions.reduce(
    (rank, question) => Math.max(rank, importanceRank[question.importance]),
    -1
  );
  return questions
    .filter((question) => importanceRank[question.importance] === highest)
    .sort((left, right) =>
      left.id.localeCompare(right.id, "en-US") ||
      left.question.localeCompare(right.question, "en-US")
    );
}

function requiredReviewer(
  discussion: DiscussionRecord,
  candidates: readonly DiscussionParticipantCandidate[]
): DiscussionParticipantCandidate | undefined {
  if (discussion.mode !== "review" && !discussion.policy.requireReviewer) {
    return undefined;
  }
  return candidates.find(({ participant }) => participant.role === "reviewer");
}

function explain(
  candidate: DiscussionParticipantCandidate,
  reason: DiscussionSelectionReason
): DiscussionSelectionExplanation {
  return { agentId: candidate.participant.agentId, reasons: [reason],
    reportedQuestionIds: [], matchedRoleTerms: [] };
}

function snapshot(input: {
  strategy: DiscussionWaveSelection["strategy"];
  explanations: DiscussionSelectionExplanation[];
  questions: readonly OpenQuestion[];
  candidates: readonly DiscussionParticipantCandidate[];
  selected: readonly DiscussionParticipantCandidate[];
  reviewerRequired: boolean;
  focusedParticipantLimit: number;
}): DiscussionParticipantSelection {
  const value = createDiscussionWaveSelection({
    version: 2,
    explanations: input.explanations,
    strategy: input.strategy,
    focusQuestionIds: input.questions.map(({ id }) => id),
    eligibleAgentIds: input.candidates.map(({ participant }) => participant.agentId),
    selectedAgentIds: input.selected.map(({ participant }) => participant.agentId),
    requiredRoles: input.reviewerRequired ? ["reviewer"] : [],
    focusedParticipantLimit: input.focusedParticipantLimit
  });
  assertDiscussionWaveSelection(value);
  return {
    participants: input.selected.map(({ participant }) => participant),
    snapshot: value
  };
}

export function selectDiscussionParticipants(input: {
  discussion: DiscussionRecord;
  candidates: DiscussionParticipantCandidate[];
  finalization?: boolean;
}): DiscussionParticipantSelection {
  const candidates = [...input.candidates].sort((left, right) =>
    left.participant.ordinal - right.participant.ordinal
  );
  if (candidates.length === 0) {
    throw new Error("Discussion Wave has no eligible participant");
  }
  const reviewer = requiredReviewer(input.discussion, candidates);
  if (
    !input.finalization &&
    (input.discussion.mode === "review" || input.discussion.policy.requireReviewer) &&
    !reviewer
  ) {
    throw new Error("Discussion Wave requires an eligible reviewer");
  }
  if (input.finalization) {
    const finalReviewer = candidates.find(({ participant }) => participant.role === "reviewer");
    const primary = candidates.find(({ taskRole }) => taskRole === "primary");
    const selected = finalReviewer ?? primary ?? candidates[0]!;
    return snapshot({
      strategy: "finalizer",
      explanations: [explain(selected, finalReviewer ? "finalizer_reviewer"
        : primary ? "finalizer_primary" : "finalizer_ordinal")],
      questions: highestPriorityQuestions(input.discussion.progress.openQuestions),
      candidates,
      selected: [selected],
      reviewerRequired: Boolean(reviewer),
      focusedParticipantLimit: input.discussion.policy.focusedParticipantLimit
    });
  }

  const questions = highestPriorityQuestions(input.discussion.progress.openQuestions);
  if (
    input.discussion.policy.participantSelectionMode === "all_eligible" ||
    questions.length === 0
  ) {
    return snapshot({
      strategy: "all_eligible",
      explanations: candidates.map((candidate) => explain(candidate,
        input.discussion.policy.participantSelectionMode === "all_eligible"
          ? "all_member_policy" : "no_focus_questions")),
      questions,
      candidates,
      selected: candidates,
      reviewerRequired: Boolean(reviewer),
      focusedParticipantLimit: input.discussion.policy.focusedParticipantLimit
    });
  }

  const questionIds = new Set(questions.map(({ id }) => id));
  const questionText = normalized(questions.map(({ question }) => question).join("\n"));
  const scored = candidates.map((candidate) => {
    const reports = candidate.reportedQuestionIds.filter((id) => questionIds.has(id)).length;
    const matches = roleTerms(candidate).filter((term) => questionText.includes(term)).length;
    return { candidate, score: reports * 100 + matches * 10 };
  }).filter(({ score }) => score > 0).sort((left, right) =>
    right.score - left.score ||
    left.candidate.participant.ordinal - right.candidate.participant.ordinal
  );

  if (scored.length === 0) {
    return snapshot({
      strategy: "all_eligible",
      explanations: candidates.map((candidate) => explain(candidate, "no_deterministic_match")),
      questions,
      candidates,
      selected: candidates,
      reviewerRequired: Boolean(reviewer),
      focusedParticipantLimit: input.discussion.policy.focusedParticipantLimit
    });
  }

  const selected = scored
    .slice(0, input.discussion.policy.focusedParticipantLimit)
    .map(({ candidate }) => candidate);
  if (reviewer && !selected.some(({ participant }) =>
    participant.agentId === reviewer.participant.agentId
  )) {
    if (selected.length === input.discussion.policy.focusedParticipantLimit) {
      selected.pop();
    }
    selected.push(reviewer);
  }
  selected.sort((left, right) =>
    left.participant.ordinal - right.participant.ordinal
  );
  return snapshot({
    strategy: "question_focused",
    explanations: selected.map((candidate) => {
      const reportedQuestionIds = [...new Set(candidate.reportedQuestionIds)]
        .filter((id) => questionIds.has(id)).sort((a, b) => a.localeCompare(b, "en-US"));
      const matchedRoleTerms = roleTerms(candidate).filter((term) => questionText.includes(term))
        .sort((a, b) => a.localeCompare(b, "en-US"));
      const reasons: DiscussionSelectionReason[] = [];
      if (reportedQuestionIds.length) reasons.push("question_reporter");
      if (matchedRoleTerms.length) reasons.push("role_match");
      if (candidate === reviewer) reasons.push("required_reviewer");
      return { agentId: candidate.participant.agentId, reasons, reportedQuestionIds, matchedRoleTerms };
    }),
    questions,
    candidates,
    selected,
    reviewerRequired: Boolean(reviewer),
    focusedParticipantLimit: input.discussion.policy.focusedParticipantLimit
  });
}
