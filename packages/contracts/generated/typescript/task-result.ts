// Code generated from JSON Schema; DO NOT EDIT.

export interface TaskProjection {
  assignments:        TaskProjectionAssignment[];
  attentionReasons:   TaskProjectionAttentionReason[];
  budgetPolicy:       TaskProjectionBudgetPolicy;
  budgetUsage:        TaskProjectionBudgetUsage;
  completionPolicy:   CompletionPolicy;
  completionResultId: null | string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  createdAt:          string;
  createdByMemberId:  string;
  criteria:           TaskProjectionCriterion[];
  criteriaRevision:   number;
  definitionRevision: number;
  dueAt:              null | string;
  goal:               string;
  isDefault:          boolean;
  lifecycleState:     LifecycleState;
  nextAction:         TaskProjectionNextAction;
  ownerMemberId:      string;
  parentTaskId:       null | string;
  priority:           Priority;
  roomId:             string;
  schedulingState:    SchedulingState;
  taskDisplayNumber:  number;
  taskId:             string;
  taskRevision:       number;
  teamId:             string;
  title:              string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  updatedAt: string;
}

export interface TaskProjectionAssignment {
  agentId: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  assignedAt:         string;
  assignedByMemberId: string;
  role:               Role;
}

export type Role = "primary" | "contributor" | "reviewer";

export interface TaskProjectionAttentionReason {
  actorKind:         AttentionReasonActorKind;
  expectedAgentId?:  null | string;
  expectedMemberId?: null | string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  occurredAt: string;
  reason:     AttentionElement;
  sourceId:   string;
}

export type AttentionReasonActorKind = "member" | "agent" | "system";

export type AttentionElement = "needs_input" | "outcome_unknown" | "needs_approval" | "result_stale" | "blocked" | "overdue" | "paused" | "budget_exhausted" | "runtime_unavailable" | "result_rejected";

export interface TaskProjectionBudgetPolicy {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface TaskProjectionBudgetUsage {
  executionDurationSeconds: number;
  providerCostUsd:          number | null;
  providerTokens:           number | null;
  runAttempts:              number;
  usageRevision:            number;
}

export type CompletionPolicy = "owner_confirmed" | "accepted_result_required";

export interface TaskProjectionCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export type LifecycleState = "draft" | "ready" | "active" | "review" | "completed" | "canceled";

export interface TaskProjectionNextAction {
  actorKind:         AttentionReasonActorKind;
  expectedAgentId?:  null | string;
  expectedMemberId?: null | string;
  reason:            NextActionReason;
  sourceId:          null | string;
}

export type NextActionReason = "provide_input" | "acknowledge_outcome" | "review_result" | "resolve_block" | "resume_scheduling" | "increase_budget" | "restore_runtime" | "submit_result" | "start_work" | "none";

export type Priority = "low" | "normal" | "high" | "urgent";

export type SchedulingState = "enabled" | "paused";

export interface TaskDefinitionCommand {
  assignments:          TaskDefinitionCommandAssignment[];
  budgetPolicy:         TaskDefinitionCommandBudgetPolicy;
  completionPolicy:     CompletionPolicy;
  criteria:             TaskDefinitionCommandCriterion[];
  dueAt:                null | string;
  expectedTaskRevision: number;
  goal:                 string;
  operationId:          string;
  ownerMemberId:        string;
  priority:             Priority;
  title:                string;
}

export interface TaskDefinitionCommandAssignment {
  agentId: string;
  role:    Role;
}

export interface TaskDefinitionCommandBudgetPolicy {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface TaskDefinitionCommandCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface RunAttemptProjection {
  agentId:       string;
  attemptNumber: number;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  createdAt:    string;
  phase:        Phase;
  retryOfRunId: null | string;
  runId:        string;
  state:        RunAttemptProjectionState;
  taskId:       string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  updatedAt: string;
}

export type Phase = "sending" | "preparing_context" | "starting_runtime" | "running" | "running_tests" | "submitting_result" | "unknown";

export type RunAttemptProjectionState = "queued" | "delivered" | "working" | "input_required" | "completed" | "failed" | "canceled" | "expired" | "outcome_unknown";

export interface RunContextManifest {
  criteria:           RunContextManifestCriterion[];
  criteriaRevision:   number;
  definitionRevision: number;
  goal:               string;
  included:           Included;
  manifestVersion:    ManifestVersion;
  omittedCategories:  [OmittedCategory, ...OmittedCategory[]];
  permissions:        Permissions;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  recordedAt:   string;
  runId:        string;
  target:       Target;
  taskId:       string;
  taskRevision: number;
}

export interface RunContextManifestCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface Included {
  artifactIds:         string[];
  artifactRevision:    number;
  memoryIds:           string[];
  messageIds:          string[];
  parentRunIds:        string[];
  roomContextRevision: number;
  taskMemoryRevision:  number;
}

export type ManifestVersion = "1.0";

export type OmittedCategory = "unrelated_room_history" | "local_paths" | "environment_values" | "provider_credentials" | "provider_session_ids" | "hidden_reasoning" | "tool_payloads" | "other_workspaces";

export interface Permissions {
  filesystemAccess:   FilesystemAccess;
  handoff:            Handoff;
  interrupt:          Handoff;
  maxDurationSeconds: number | null;
  networkAccess:      NetworkAccess;
}

export type FilesystemAccess = "read-only" | "workspace-write" | "local-policy" | "not_recorded";

export type Handoff = "supported" | "unsupported" | "not_recorded";

export type NetworkAccess = "disabled" | "local-policy" | "not_recorded";

export interface Target {
  agentId:        string;
  deviceId:       null | string;
  runtimeKind:    RuntimeKind;
  workspaceAlias: null | string;
}

export type RuntimeKind = "codex" | "pi" | "generic" | "fake" | "manual" | "not_recorded";

export interface AmbiguityAcknowledgement {
  expectedTaskRevision: number;
  operationId:          string;
  reason:               string;
  runId:                string;
}

export interface ResultProposal {
  criteriaRevision:       number;
  criterionClaims:        ResultProposalCriterionClaim[];
  definitionRevision:     number;
  nextActions:            ResultProposalNextAction[];
  openQuestions:          string[];
  operationId:            string;
  outcome:                Outcome;
  proposedAtTaskRevision: number;
  risks:                  string[];
  sources:                [ResultProposalSource, ...ResultProposalSource[]];
  summary:                string;
  supersedesResultId:     null | string;
  taskId:                 string;
}

export interface ResultProposalCriterionClaim {
  coverage:       Coverage;
  criterionKey:   string;
  evidenceRefIds: string[];
  explanation:    string;
}

export type Coverage = "satisfied" | "unresolved" | "not_satisfied" | "not_applicable";

export interface ResultProposalNextAction {
  description:   string;
  nextActionKey: string;
}

export type Outcome = "satisfied" | "partial" | "not_satisfied" | "informational";

export interface ResultProposalSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
}

export type SourceKind = "artifact" | "run_event" | "message" | "memory" | "discussion";

export interface AgentResultProposal {
  actorKind: AgentResultProposalActorKind;
  agentId:   string;
  proposal:  AgentResultProposalProposal;
  runId:     string;
}

export type AgentResultProposalActorKind = "manual_agent" | "managed_agent";

export interface AgentResultProposalProposal {
  criteriaRevision:       number;
  criterionClaims:        PurpleCriterionClaim[];
  definitionRevision:     number;
  nextActions:            PurpleNextAction[];
  openQuestions:          string[];
  operationId:            string;
  outcome:                Outcome;
  proposedAtTaskRevision: number;
  risks:                  string[];
  sources:                [PurpleSource, ...PurpleSource[]];
  summary:                string;
  supersedesResultId:     null | string;
  taskId:                 string;
}

export interface PurpleCriterionClaim {
  coverage:       Coverage;
  criterionKey:   string;
  evidenceRefIds: string[];
  explanation:    string;
}

export interface PurpleNextAction {
  description:   string;
  nextActionKey: string;
}

export interface PurpleSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
}

export interface ResultReviewCommand {
  completeTask:           boolean;
  decision:               Decision;
  expectedReviewRevision: number;
  expectedTaskRevision:   number;
  operationId:            string;
  reason:                 string;
}

export type Decision = "accepted" | "rejected";

export interface ResultProjection {
  proposal: ResultProjectionProposal;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  proposedAt:    string;
  proposedBy:    ProposedBy;
  resultId:      string;
  resultVersion: number;
  review:        Review | null;
  roomId:        string;
  state:         ResultProjectionState;
  taskId:        string;
}

export interface ResultProjectionProposal {
  criteriaRevision:       number;
  criterionClaims:        FluffyCriterionClaim[];
  definitionRevision:     number;
  nextActions:            FluffyNextAction[];
  openQuestions:          string[];
  operationId:            string;
  outcome:                Outcome;
  proposedAtTaskRevision: number;
  risks:                  string[];
  sources:                [FluffySource, ...FluffySource[]];
  summary:                string;
  supersedesResultId:     null | string;
  taskId:                 string;
}

export interface FluffyCriterionClaim {
  coverage:       Coverage;
  criterionKey:   string;
  evidenceRefIds: string[];
  explanation:    string;
}

export interface FluffyNextAction {
  description:   string;
  nextActionKey: string;
}

export interface FluffySource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
}

export interface ProposedBy {
  kind:          ProposedByKind;
  memberId?:     string;
  agentId?:      string;
  runId?:        string;
  discussionId?: string;
}

export type ProposedByKind = "member" | "manual_agent" | "managed_agent" | "orchestrator";

export interface Review {
  decision: Decision;
  reason:   string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  reviewedAt:         string;
  reviewedByMemberId: string;
  reviewRevision:     number;
}

export type ResultProjectionState = "proposed" | "accepted" | "rejected" | "superseded";

export interface WorkbenchQuery {
  agentId?:       null | string;
  attention:      AttentionElement[];
  cursor:         null | string;
  lifecycleState: LifecycleState[];
  limit:          number;
  ownerMemberId?: null | string;
  priority?:      Priority[];
  roomId?:        null | string;
  scope:          Scope;
  updatedAfter?:  null | string;
  updatedBefore?: null | string;
}

export type Scope = "mine" | "team";

export interface WorkbenchPage {
  items:      Item[];
  nextCursor: null | string;
}

export interface Item {
  attentionReasons:          ItemAttentionReason[];
  budgetUsage:               ItemBudgetUsage;
  latestResultCurrent:       boolean | null;
  latestResultId:            null | string;
  latestRun:                 LatestRun | null;
  lifecycleState:            LifecycleState;
  nextAction:                ItemNextAction;
  ownerMemberId:             string;
  primaryAttention:          AttentionElement | null;
  priority:                  Priority;
  requiredCriteriaSatisfied: number;
  requiredCriteriaTotal:     number;
  roomId:                    string;
  schedulingState:           SchedulingState;
  taskDisplayNumber:         number;
  taskId:                    string;
  title:                     string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  updatedAt: string;
}

export interface ItemAttentionReason {
  actorKind:         AttentionReasonActorKind;
  expectedAgentId?:  null | string;
  expectedMemberId?: null | string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  occurredAt: string;
  reason:     AttentionElement;
  sourceId:   string;
}

export interface ItemBudgetUsage {
  executionDurationSeconds: number;
  providerCostUsd:          number | null;
  providerTokens:           number | null;
  runAttempts:              number;
  usageRevision:            number;
}

export interface LatestRun {
  agentId:       string;
  attemptNumber: number;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  createdAt:    string;
  phase:        Phase;
  retryOfRunId: null | string;
  runId:        string;
  state:        RunAttemptProjectionState;
  taskId:       string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  updatedAt: string;
}

export interface ItemNextAction {
  actorKind:         AttentionReasonActorKind;
  expectedAgentId?:  null | string;
  expectedMemberId?: null | string;
  reason:            NextActionReason;
  sourceId:          null | string;
}

export interface LegacyTaskMapping {
  completionPolicy: CompletionPolicy;
  isDefault:        boolean;
  legacyState:      LegacyState;
  lifecycleState:   LifecycleState;
  schedulingState:  SchedulingState;
}

export type LegacyState = "open" | "working" | "blocked" | "review" | "completed" | "canceled";

export interface ChildTaskFromResultCommand {
  nextActionKey: string;
  operationId:   string;
  ownerMemberId: string;
  title:         string;
}
