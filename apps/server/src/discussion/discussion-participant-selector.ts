import { createHash } from "node:crypto";

import type {
  DiscussionParticipant,
  DiscussionRecord,
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
  return JSON.stringify([
    selection.version,
    selection.strategy,
    selection.focusQuestionIds,
    selection.eligibleAgentIds,
    selection.selectedAgentIds,
    selection.requiredRoles,
    selection.focusedParticipantLimit
  ]);
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
    selection.version !== 1 ||
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

function snapshot(input: {
  strategy: DiscussionWaveSelection["strategy"];
  questions: readonly OpenQuestion[];
  candidates: readonly DiscussionParticipantCandidate[];
  selected: readonly DiscussionParticipantCandidate[];
  reviewerRequired: boolean;
  focusedParticipantLimit: number;
}): DiscussionParticipantSelection {
  const value = createDiscussionWaveSelection({
    version: 1,
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
    const selected = reviewer ?? candidates[0]!;
    return snapshot({
      strategy: "finalizer",
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
    questions,
    candidates,
    selected,
    reviewerRequired: Boolean(reviewer),
    focusedParticipantLimit: input.discussion.policy.focusedParticipantLimit
  });
}
