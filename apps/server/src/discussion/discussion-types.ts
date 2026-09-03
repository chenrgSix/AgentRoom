export type DiscussionMode = "round_robin" | "review";

export type DiscussionExecutionModel = "sequential" | "parallel_wave";

export type DiscussionState =
  | "active"
  | "stop_requested"
  | "waiting_human"
  | "awaiting_extension"
  | "paused"
  | "finalizing"
  | "completed"
  | "canceled"
  | "terminated";

export type DiscussionStateReason =
  | "goal_satisfied"
  | "user_requested_finish"
  | "discussion_plateau"
  | "soft_budget_exhausted"
  | "hard_budget_exhausted"
  | "policy_violation"
  | "runtime_failure"
  | "user_paused"
  | "user_canceled"
  | "input_required";

export type DiscussionAction =
  | "continue"
  | "wait_human"
  | "pause"
  | "finalize"
  | "cancel"
  | "terminate";

export type DiscussionOutputMode =
  | "none"
  | "summary"
  | "final_answer"
  | "artifact"
  | "decision_record"
  | "unresolved_issues";

export interface DiscussionPolicy {
  initialLeaseTurns: number;
  automaticMaxTurns: number;
  hardMaxTurns: number;
  maxDurationSeconds: number;
  waveTimeoutSeconds: number;
  plateauWindow: number;
  minimumCompletionConfidence: number;
  finalizationReserveTurns: number;
  requireReviewer: boolean;
  allowAutomaticFinish: boolean;
  participantSelectionMode: DiscussionParticipantSelectionMode;
  focusedParticipantLimit: number;
}

export type DiscussionParticipantSelectionMode =
  | "all_eligible"
  | "question_focused";

export interface OpenQuestion {
  id: string;
  question: string;
  importance: "low" | "medium" | "high";
}

export interface AgentAssessment {
  goalSatisfied?: boolean;
  confidence?: number;
  resolvedQuestionIds?: string[];
  openQuestions?: OpenQuestion[];
  newEvidenceRefs?: string[];
  disagreementRemaining?: "none" | "low" | "medium" | "high";
  newInformationAdded?: boolean;
  reviewerApproved?: boolean;
  recommendation?: "continue" | "finish" | "wait_human";
}

export interface ProgressSnapshot {
  version: number;
  goalSatisfied: boolean;
  confidence: number | null;
  openQuestions: OpenQuestion[];
  evidenceRefs: string[];
  disagreementRemaining: "unknown" | "none" | "low" | "medium" | "high";
  reviewerApproved: boolean;
  plateauCount: number;
  replyHashes: string[];
  lastTurnAddedInformation: boolean;
}

export interface BudgetSnapshot {
  turnsUsed: number;
  agentRunsUsed: number;
  tokensUsed: number | null;
  durationSeconds: number;
  estimatedCostMicros: number | null;
  leaseEndTurn: number;
  extensions: number;
  tokenTelemetryKnown: boolean;
  costTelemetryKnown: boolean;
}

export interface DiscussionRecord {
  discussionId: string;
  roomId: string;
  taskId: string;
  rootMessageId: string;
  requesterMemberId: string;
  goal: string;
  mode: DiscussionMode;
  state: DiscussionState;
  stateReason: DiscussionStateReason | null;
  outputMode: DiscussionOutputMode;
  policy: DiscussionPolicy;
  progress: ProgressSnapshot;
  budget: BudgetSnapshot;
  executionModel?: DiscussionExecutionModel;
  currentTurn: number;
  currentWave?: number;
  nextSpeakerIndex: number;
  requestedAction: "finish" | "stop_after_turn" | "pause" | null;
  version: number;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface DiscussionParticipant {
  discussionId: string;
  ordinal: number;
  agentId: string;
  role: "participant" | "reviewer";
}

export interface DiscussionTurn {
  turnId: string;
  discussionId: string;
  ordinal: number;
  kind: "discussion" | "finalization";
  speakerAgentId: string;
  inputMessageId: string;
  runId: string | null;
  outputMessageId: string | null;
  state: "planned" | "queued" | "working" | "completed" | "failed" | "canceled";
  assessment: AgentAssessment | null;
  replyHash: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  waveId?: string | null;
  waveMemberOrdinal?: number | null;
  terminalReason?: string | null;
}

export type DiscussionWavePhase = "contribution" | "review" | "finalization";

export type DiscussionWaveState =
  | "open"
  | "completed"
  | "partial"
  | "failed"
  | "canceled";

export interface DiscussionWave {
  waveId: string;
  discussionId: string;
  ordinal: number;
  phase: DiscussionWavePhase;
  inputMessageId: string;
  state: DiscussionWaveState;
  deadlineAt: string;
  expectedMembers: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  selection: DiscussionWaveSelection | null;
}

export interface DiscussionWaveSelection {
  version: 1;
  strategy: "all_eligible" | "question_focused" | "finalizer";
  focusQuestionIds: string[];
  eligibleAgentIds: string[];
  selectedAgentIds: string[];
  requiredRoles: Array<"reviewer">;
  focusedParticipantLimit: number;
  selectionDigest: string;
}

export interface DiscussionDecision {
  decisionId: string;
  discussionId: string;
  aggregateVersion: number;
  progressVersion: number;
  action: DiscussionAction;
  reason: string;
  nextAgentId: string | null;
  outputMode: DiscussionOutputMode;
  createdAt: string;
}

export interface DiscussionBudgetEvent {
  budgetEventId: string;
  discussionId: string;
  ordinal: number;
  eventType:
    | "lease_granted"
    | "turn_recorded"
    | "extension_granted"
    | "finalization_reserved";
  turns: number;
  tokens: number | null;
  durationSeconds: number;
  estimatedCostMicros: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export const defaultDiscussionPolicy: DiscussionPolicy = {
  initialLeaseTurns: 4,
  automaticMaxTurns: 12,
  hardMaxTurns: 50,
  maxDurationSeconds: 20 * 60,
  waveTimeoutSeconds: 5 * 60,
  plateauWindow: 2,
  minimumCompletionConfidence: 0.8,
  finalizationReserveTurns: 1,
  requireReviewer: false,
  allowAutomaticFinish: true,
  participantSelectionMode: "question_focused",
  focusedParticipantLimit: 3
};

export const emptyProgressSnapshot = (): ProgressSnapshot => ({
  version: 0,
  goalSatisfied: false,
  confidence: null,
  openQuestions: [],
  evidenceRefs: [],
  disagreementRemaining: "unknown",
  reviewerApproved: false,
  plateauCount: 0,
  replyHashes: [],
  lastTurnAddedInformation: true
});

export const emptyBudgetSnapshot = (leaseEndTurn: number): BudgetSnapshot => ({
  turnsUsed: 0,
  agentRunsUsed: 0,
  tokensUsed: null,
  durationSeconds: 0,
  estimatedCostMicros: null,
  leaseEndTurn,
  extensions: 0,
  tokenTelemetryKnown: false,
  costTelemetryKnown: false
});
