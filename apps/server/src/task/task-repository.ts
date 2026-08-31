import type Database from "better-sqlite3";

import { createOpaqueId } from "../domain/identifiers.js";

export type AgentTaskState =
  | "open"
  | "working"
  | "blocked"
  | "review"
  | "completed"
  | "canceled";
export type TaskLifecycleState =
  | "draft"
  | "ready"
  | "active"
  | "review"
  | "completed"
  | "canceled";
export type TaskSchedulingState = "enabled" | "paused";
export type TaskCompletionPolicy =
  | "owner_confirmed"
  | "accepted_result_required";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskAssignmentRole = "primary" | "contributor" | "reviewer";
export type TaskAttentionReason =
  | "needs_input"
  | "outcome_unknown"
  | "needs_approval"
  | "result_stale"
  | "blocked"
  | "overdue"
  | "paused"
  | "budget_exhausted"
  | "runtime_unavailable"
  | "result_rejected";

export interface TaskCriterion {
  criterionKey: string;
  description: string;
  required: boolean;
  ordinal: number;
}

export interface TaskAssignment {
  agentId: string;
  role: TaskAssignmentRole;
  assignedByMemberId: string;
  assignedAt: string;
}

export interface TaskBudgetPolicy {
  maxRunAttempts: number;
  maxExecutionDurationSeconds: number;
}

export interface TaskBudgetUsage {
  usageRevision: number;
  runAttempts: number;
  executionDurationSeconds: number;
  providerTokens: null;
  providerCostUsd: null;
}

export interface TaskAttention {
  reason: TaskAttentionReason;
  sourceId: string;
  occurredAt: string;
  actorKind: "member" | "agent" | "system";
  expectedMemberId: string | null;
  expectedAgentId: string | null;
}

export interface TaskNextAction {
  actorKind: "member" | "agent" | "system";
  reason:
    | "provide_input"
    | "acknowledge_outcome"
    | "review_result"
    | "resolve_block"
    | "resume_scheduling"
    | "increase_budget"
    | "restore_runtime"
    | "submit_result"
    | "start_work"
    | "none";
  sourceId: string | null;
  expectedMemberId: string | null;
  expectedAgentId: string | null;
}

export interface AgentTaskRecord {
  taskId: string;
  taskDisplayNumber: number;
  teamId: string;
  roomId: string;
  parentTaskId: string | null;
  title: string;
  goal: string;
  state: AgentTaskState;
  lifecycleState: TaskLifecycleState;
  schedulingState: TaskSchedulingState;
  completionPolicy: TaskCompletionPolicy;
  priority: TaskPriority;
  dueAt: string | null;
  taskRevision: number;
  definitionRevision: number;
  criteriaRevision: number;
  criteria: TaskCriterion[];
  ownerMemberId: string;
  assignments: TaskAssignment[];
  budgetPolicy: TaskBudgetPolicy;
  budgetUsage: TaskBudgetUsage;
  completionResultId: string | null;
  attentionReasons: TaskAttention[];
  nextAction: TaskNextAction;
  primaryAgentId: string | null;
  workspaceRef: string | null;
  summary: string;
  summaryRevision: number;
  summarySourceSequence: number;
  summaryProvenanceMessageIds: string[];
  artifactRevision: number;
  lastRoomSequence: number;
  createdByMemberId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentTaskRow {
  task_id: string;
  task_display_number: number;
  team_id: string;
  room_id: string;
  parent_task_id: string | null;
  title: string;
  goal: string;
  state: AgentTaskState;
  lifecycle_state: TaskLifecycleState;
  scheduling_state: TaskSchedulingState;
  completion_policy: TaskCompletionPolicy;
  priority: TaskPriority;
  due_at: string | null;
  task_revision: number;
  definition_revision: number;
  criteria_revision: number;
  owner_member_id: string;
  max_run_attempts: number;
  max_execution_duration_seconds: number;
  budget_run_attempts: number;
  budget_execution_duration_seconds: number;
  budget_usage_revision: number;
  completion_result_id: string | null;
  primary_agent_id: string | null;
  workspace_ref: string | null;
  summary: string;
  summary_revision: number;
  summary_source_sequence: number;
  summary_provenance_json: string;
  summary_fingerprint: string;
  artifact_revision: number;
  last_room_sequence: number;
  created_by_member_id: string;
  is_default: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface CriterionRow {
  criterion_key: string;
  description: string;
  required: 0 | 1;
  ordinal: number;
}

interface AssignmentRow {
  agent_id: string;
  role: TaskAssignmentRole;
  assigned_by_member_id: string;
  assigned_at: string;
}

const attentionPriority: readonly TaskAttentionReason[] = [
  "needs_input",
  "outcome_unknown",
  "needs_approval",
  "result_stale",
  "blocked",
  "overdue",
  "paused",
  "budget_exhausted",
  "runtime_unavailable",
  "result_rejected"
];

function legacyState(lifecycle: TaskLifecycleState): AgentTaskState {
  switch (lifecycle) {
    case "active": return "working";
    case "review": return "review";
    case "completed": return "completed";
    case "canceled": return "canceled";
    default: return "open";
  }
}

function lifecycleState(state: AgentTaskState): TaskLifecycleState {
  switch (state) {
    case "working":
    case "blocked": return "active";
    case "review": return "review";
    case "completed": return "completed";
    case "canceled": return "canceled";
    default: return "ready";
  }
}

export class AgentTaskRepository {
  public constructor(private readonly database: Database.Database) {}

  public nextDisplayNumber(teamId: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(task_display_number), 0) + 1 AS next
      FROM agent_tasks WHERE team_id = ?
    `).get(teamId) as { next: number };
    return row.next;
  }

  public create(task: AgentTaskRecord): AgentTaskRecord {
    const create = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_tasks (
          task_id, room_id, parent_task_id, title, goal, state,
          primary_agent_id, workspace_ref, summary, summary_revision,
          summary_source_sequence, summary_provenance_json, summary_fingerprint,
          artifact_revision, last_room_sequence, created_by_member_id,
          is_default, created_at, updated_at, team_id, task_display_number,
          owner_member_id, lifecycle_state, scheduling_state, completion_policy,
          priority, due_at, task_revision, definition_revision,
          criteria_revision, max_run_attempts, max_execution_duration_seconds,
          budget_run_attempts, budget_execution_duration_seconds,
          budget_usage_revision, completion_result_id
        ) VALUES (
          @taskId, @roomId, @parentTaskId, @title, @goal, @state,
          @primaryAgentId, @workspaceRef, @summary, @summaryRevision,
          @summarySourceSequence, @summaryProvenanceJson, '', @artifactRevision,
          @lastRoomSequence, @createdByMemberId, @isDefault, @createdAt,
          @updatedAt, @teamId, @taskDisplayNumber, @ownerMemberId,
          @lifecycleState, @schedulingState, @completionPolicy, @priority,
          @dueAt, @taskRevision, @definitionRevision, @criteriaRevision,
          @maxRunAttempts, @maxExecutionDurationSeconds, @runAttempts,
          @executionDurationSeconds, @usageRevision, @completionResultId
        )
      `).run({
        ...task,
        summaryProvenanceJson: JSON.stringify(task.summaryProvenanceMessageIds),
        isDefault: task.isDefault ? 1 : 0,
        ...task.budgetPolicy,
        ...task.budgetUsage
      });
      this.insertDefinitionRevision(task, task.createdByMemberId, task.createdAt);
      this.insertCriteriaRevision(task, task.createdByMemberId, task.createdAt);
      this.replaceAssignments(
        task.taskId,
        task.assignments,
        task.createdByMemberId,
        task.createdAt
      );
    });
    create.immediate();
    return this.get(task.taskId)!;
  }

  public get(taskId: string): AgentTaskRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM agent_tasks WHERE task_id = ?
    `).get(taskId) as AgentTaskRow | undefined;
    return row && this.mapTask(row);
  }

  public getDefaultForRoom(roomId: string): AgentTaskRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM agent_tasks WHERE room_id = ? AND is_default = 1
    `).get(roomId) as AgentTaskRow | undefined;
    return row && this.mapTask(row);
  }

  public listForRoom(roomId: string): AgentTaskRecord[] {
    return (this.database.prepare(`
      SELECT * FROM agent_tasks
      WHERE room_id = ?
      ORDER BY is_default DESC, updated_at DESC, task_id
    `).all(roomId) as AgentTaskRow[]).map((row) => this.mapTask(row));
  }

  public hasActiveWork(taskId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM runs
        WHERE task_id = ?
          AND state NOT IN (
            'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
          )
      ) OR EXISTS (
        SELECT 1 FROM discussions
        WHERE task_id = ?
          AND state NOT IN ('completed', 'canceled', 'terminated')
      ) OR EXISTS (
        SELECT 1 FROM task_clarifications
        WHERE task_id = ? AND state = 'waiting'
      )
    `).get(taskId, taskId, taskId));
  }

  public fenceRevision(input: {
    taskId: string; operationId: string; expectedTaskRevision: number; now: string;
  }): AgentTaskRecord {
    this.database.transaction(() => {
      if (this.isOperationReplay(input.operationId, input.taskId)) return;
      const current = this.requireRevision(input.taskId, input.expectedTaskRevision);
      const result = this.database.prepare(`
        UPDATE agent_tasks SET task_revision = task_revision + 1, updated_at = ?
        WHERE task_id = ? AND task_revision = ?
      `).run(input.now, input.taskId, input.expectedTaskRevision);
      if (result.changes !== 1) throw new Error("Task revision conflict");
      this.recordOperation(input.operationId, input.taskId, current.taskRevision + 1, input.now);
    }).immediate();
    return this.get(input.taskId)!;
  }

  public hasUnacknowledgedAmbiguity(taskId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM runs run
      LEFT JOIN run_ambiguity_acknowledgements acknowledgement
        ON acknowledgement.run_id = run.run_id
      WHERE run.task_id = ? AND run.state = 'outcome_unknown'
        AND acknowledgement.run_id IS NULL
      LIMIT 1
    `).get(taskId));
  }

  public update(
    taskId: string,
    input: Pick<
      AgentTaskRecord,
      "title" | "goal" | "state" | "primaryAgentId" | "workspaceRef" |
      "updatedAt"
    >
  ): AgentTaskRecord {
    const update = this.database.transaction(() => {
      const current = this.get(taskId);
      if (!current) throw new Error(`Task not found: ${taskId}`);
      const definitionChanged =
        current.title !== input.title || current.goal !== input.goal;
      const nextDefinitionRevision = current.definitionRevision +
        (definitionChanged ? 1 : 0);
      const nextLifecycle = lifecycleState(input.state);
      const result = this.database.prepare(`
        UPDATE agent_tasks
        SET title = @title,
            goal = @goal,
            state = @state,
            lifecycle_state = @lifecycleState,
            primary_agent_id = @primaryAgentId,
            workspace_ref = @workspaceRef,
            task_revision = task_revision + 1,
            definition_revision = @definitionRevision,
            updated_at = @updatedAt
        WHERE task_id = @taskId
      `).run({
        taskId,
        ...input,
        lifecycleState: nextLifecycle,
        definitionRevision: nextDefinitionRevision
      });
      if (result.changes !== 1) throw new Error(`Task not found: ${taskId}`);
      if (definitionChanged) {
        this.insertDefinitionRevision(
          { ...current, ...input, definitionRevision: nextDefinitionRevision },
          current.ownerMemberId,
          input.updatedAt
        );
      }
    });
    update.immediate();
    return this.get(taskId)!;
  }

  public updateDefinition(input: {
    taskId: string;
    operationId: string;
    expectedTaskRevision: number;
    title: string;
    goal: string;
    ownerMemberId: string;
    completionPolicy: TaskCompletionPolicy;
    priority: TaskPriority;
    dueAt: string | null;
    criteria: TaskCriterion[];
    assignments: Array<Pick<TaskAssignment, "agentId" | "role">>;
    budgetPolicy: TaskBudgetPolicy;
    memberId: string;
    now: string;
  }): AgentTaskRecord {
    const mutate = this.database.transaction(() => {
      if (this.isOperationReplay(input.operationId, input.taskId)) return;
      const current = this.requireRevision(input.taskId, input.expectedTaskRevision);
      const definitionChanged =
        current.title !== input.title || current.goal !== input.goal;
      const criteriaChanged = JSON.stringify(current.criteria) !==
        JSON.stringify(input.criteria);
      const definitionRevision = current.definitionRevision +
        (definitionChanged || criteriaChanged ? 1 : 0);
      const criteriaRevision = current.criteriaRevision +
        (criteriaChanged ? 1 : 0);
      this.database.prepare(`
        UPDATE agent_tasks
        SET title = @title,
            goal = @goal,
            owner_member_id = @ownerMemberId,
            completion_policy = @completionPolicy,
            priority = @priority,
            due_at = @dueAt,
            task_revision = task_revision + 1,
            definition_revision = @definitionRevision,
            criteria_revision = @criteriaRevision,
            max_run_attempts = @maxRunAttempts,
            max_execution_duration_seconds = @maxExecutionDurationSeconds,
            primary_agent_id = @primaryAgentId,
            updated_at = @now
        WHERE task_id = @taskId AND task_revision = @expectedTaskRevision
      `).run({
        ...input,
        definitionRevision,
        criteriaRevision,
        ...input.budgetPolicy,
        primaryAgentId:
          input.assignments.find(({ role }) => role === "primary")?.agentId ?? null
      });
      if (definitionChanged || criteriaChanged) {
        this.insertDefinitionRevision({
          ...current,
          title: input.title,
          goal: input.goal,
          definitionRevision
        }, input.memberId, input.now);
      }
      if (criteriaChanged) {
        this.insertCriteriaRevision({
          ...current,
          criteria: input.criteria,
          criteriaRevision
        }, input.memberId, input.now);
      }
      this.replaceAssignments(
        input.taskId,
        input.assignments,
        input.memberId,
        input.now
      );
      this.recordOperation(
        input.operationId,
        input.taskId,
        current.taskRevision + 1,
        input.now
      );
    });
    mutate.immediate();
    return this.get(input.taskId)!;
  }

  public updateControl(input: {
    taskId: string;
    operationId: string;
    expectedTaskRevision: number;
    lifecycleState?: TaskLifecycleState;
    schedulingState?: TaskSchedulingState;
    now: string;
  }): AgentTaskRecord {
    const mutate = this.database.transaction(() => {
      if (this.isOperationReplay(input.operationId, input.taskId)) return;
      const current = this.requireRevision(input.taskId, input.expectedTaskRevision);
      const nextLifecycle = input.lifecycleState ?? current.lifecycleState;
      const nextScheduling = input.schedulingState ?? current.schedulingState;
      const result = this.database.prepare(`
        UPDATE agent_tasks
        SET lifecycle_state = @lifecycleState,
            scheduling_state = @schedulingState,
            state = @state,
            task_revision = task_revision + 1,
            updated_at = @now
        WHERE task_id = @taskId AND task_revision = @expectedTaskRevision
      `).run({
        ...input,
        lifecycleState: nextLifecycle,
        schedulingState: nextScheduling,
        state: legacyState(nextLifecycle)
      });
      if (result.changes !== 1) throw new Error("Task revision conflict");
      this.recordOperation(
        input.operationId,
        input.taskId,
        current.taskRevision + 1,
        input.now
      );
    });
    mutate.immediate();
    return this.get(input.taskId)!;
  }

  public addBlock(input: {
    taskId: string;
    operationId: string;
    expectedTaskRevision: number;
    reason: string;
    memberId: string;
    now: string;
  }): AgentTaskRecord {
    const mutate = this.database.transaction(() => {
      if (this.isOperationReplay(input.operationId, input.taskId)) return;
      const current = this.requireRevision(input.taskId, input.expectedTaskRevision);
      this.database.prepare(`
        INSERT INTO task_blocks (
          block_id, task_id, reason, state, created_by_member_id, created_at,
          resolved_by_member_id, resolved_at
        ) VALUES (?, ?, ?, 'open', ?, ?, NULL, NULL)
      `).run(
        createOpaqueId("block"), input.taskId, input.reason, input.memberId,
        input.now
      );
      this.database.prepare(`
        UPDATE agent_tasks SET task_revision = task_revision + 1,
          updated_at = ? WHERE task_id = ? AND task_revision = ?
      `).run(input.now, input.taskId, input.expectedTaskRevision);
      this.recordOperation(
        input.operationId,
        input.taskId,
        current.taskRevision + 1,
        input.now
      );
    });
    mutate.immediate();
    return this.get(input.taskId)!;
  }

  public resolveBlock(input: {
    taskId: string;
    blockId: string;
    operationId: string;
    expectedTaskRevision: number;
    memberId: string;
    now: string;
  }): AgentTaskRecord {
    const mutate = this.database.transaction(() => {
      if (this.isOperationReplay(input.operationId, input.taskId)) return;
      const current = this.requireRevision(input.taskId, input.expectedTaskRevision);
      const resolved = this.database.prepare(`
        UPDATE task_blocks SET state = 'resolved', resolved_by_member_id = ?,
          resolved_at = ?
        WHERE block_id = ? AND task_id = ? AND state = 'open'
      `).run(input.memberId, input.now, input.blockId, input.taskId);
      if (resolved.changes !== 1) throw new Error("Open Task block not found");
      this.database.prepare(`
        UPDATE agent_tasks SET task_revision = task_revision + 1,
          updated_at = ? WHERE task_id = ? AND task_revision = ?
      `).run(input.now, input.taskId, input.expectedTaskRevision);
      this.recordOperation(
        input.operationId,
        input.taskId,
        current.taskRevision + 1,
        input.now
      );
    });
    mutate.immediate();
    return this.get(input.taskId)!;
  }

  public updateSummaryProjection(
    taskId: string,
    input: {
      summary: string;
      sourceSequence: number;
      provenanceMessageIds: string[];
      fingerprint: string;
      updatedAt: string;
    }
  ): AgentTaskRecord {
    const result = this.database.prepare(`
      UPDATE agent_tasks
      SET summary = @summary,
          summary_revision = summary_revision + 1,
          summary_source_sequence = @sourceSequence,
          summary_provenance_json = @provenanceJson,
          summary_fingerprint = @fingerprint,
          updated_at = @updatedAt
      WHERE task_id = @taskId
        AND @sourceSequence >= summary_source_sequence
        AND summary_fingerprint <> @fingerprint
    `).run({
      taskId,
      ...input,
      provenanceJson: JSON.stringify(input.provenanceMessageIds)
    });
    if (result.changes === 0 && !this.get(taskId)) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return this.get(taskId)!;
  }

  private mapTask(row: AgentTaskRow): AgentTaskRecord {
    const criteria = (this.database.prepare(`
      SELECT criterion_key, description, required, ordinal
      FROM task_criteria_entries
      WHERE task_id = ? AND criteria_revision = ?
      ORDER BY ordinal, criterion_key
    `).all(row.task_id, row.criteria_revision) as CriterionRow[]).map((entry) => ({
      criterionKey: entry.criterion_key,
      description: entry.description,
      required: entry.required === 1,
      ordinal: entry.ordinal
    }));
    const assignments = (this.database.prepare(`
      SELECT agent_id, role, assigned_by_member_id, assigned_at
      FROM task_agent_assignments WHERE task_id = ?
      ORDER BY CASE role WHEN 'primary' THEN 0 WHEN 'contributor' THEN 1 ELSE 2 END,
               assigned_at, agent_id
    `).all(row.task_id) as AssignmentRow[]).map((entry) => ({
      agentId: entry.agent_id,
      role: entry.role,
      assignedByMemberId: entry.assigned_by_member_id,
      assignedAt: entry.assigned_at
    }));
    const attentionReasons = this.attention(row, assignments);
    return {
      taskId: row.task_id,
      taskDisplayNumber: row.task_display_number,
      teamId: row.team_id,
      roomId: row.room_id,
      parentTaskId: row.parent_task_id,
      title: row.title,
      goal: row.goal,
      state: row.state,
      lifecycleState: row.lifecycle_state,
      schedulingState: row.scheduling_state,
      completionPolicy: row.completion_policy,
      priority: row.priority,
      dueAt: row.due_at,
      taskRevision: row.task_revision,
      definitionRevision: row.definition_revision,
      criteriaRevision: row.criteria_revision,
      criteria,
      ownerMemberId: row.owner_member_id,
      assignments,
      budgetPolicy: {
        maxRunAttempts: row.max_run_attempts,
        maxExecutionDurationSeconds: row.max_execution_duration_seconds
      },
      budgetUsage: {
        usageRevision: row.budget_usage_revision,
        runAttempts: row.budget_run_attempts,
        executionDurationSeconds: row.budget_execution_duration_seconds,
        providerTokens: null,
        providerCostUsd: null
      },
      completionResultId: row.completion_result_id,
      attentionReasons,
      nextAction: this.nextAction(row, attentionReasons, assignments),
      primaryAgentId: row.primary_agent_id,
      workspaceRef: row.workspace_ref,
      summary: row.summary,
      summaryRevision: row.summary_revision,
      summarySourceSequence: row.summary_source_sequence,
      summaryProvenanceMessageIds: JSON.parse(
        row.summary_provenance_json
      ) as string[],
      artifactRevision: row.artifact_revision,
      lastRoomSequence: row.last_room_sequence,
      createdByMemberId: row.created_by_member_id,
      isDefault: row.is_default === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private attention(
    row: AgentTaskRow,
    assignments: TaskAssignment[]
  ): TaskAttention[] {
    const reasons: TaskAttention[] = [];
    const push = (
      reason: TaskAttentionReason,
      sourceId: string,
      occurredAt: string,
      actorKind: TaskAttention["actorKind"],
      expectedMemberId: string | null = null,
      expectedAgentId: string | null = null
    ) => reasons.push({
      reason, sourceId, occurredAt, actorKind, expectedMemberId, expectedAgentId
    });
    const clarification = this.database.prepare(`
      SELECT clarification_id, created_at FROM task_clarifications
      WHERE task_id = ? AND state = 'waiting'
      ORDER BY created_at, clarification_id LIMIT 1
    `).get(row.task_id) as
      | { clarification_id: string; created_at: string }
      | undefined;
    if (clarification) {
      push(
        "needs_input", clarification.clarification_id,
        clarification.created_at, "member", row.owner_member_id
      );
    }
    const ambiguous = this.database.prepare(`
      SELECT run.run_id, run.updated_at FROM runs run
      LEFT JOIN run_ambiguity_acknowledgements acknowledgement
        ON acknowledgement.run_id = run.run_id
      WHERE run.task_id = ? AND run.state = 'outcome_unknown'
        AND acknowledgement.run_id IS NULL
      ORDER BY run.updated_at, run.run_id LIMIT 1
    `).get(row.task_id) as { run_id: string; updated_at: string } | undefined;
    if (ambiguous) {
      push(
        "outcome_unknown", ambiguous.run_id, ambiguous.updated_at,
        "member", row.owner_member_id
      );
    }
    const pendingResult = this.database.prepare(`
      SELECT result.result_id, result.state, result.definition_revision,
        result.criteria_revision,
        COALESCE(review.reviewed_at, result.proposed_at) AS occurred_at
      FROM task_results result
      LEFT JOIN result_reviews review ON review.result_id = result.result_id
      WHERE result.task_id = ? AND result.state IN ('proposed', 'rejected')
      ORDER BY result.result_version DESC, result.result_id DESC LIMIT 1
    `).get(row.task_id) as {
      result_id: string;
      state: "proposed" | "rejected";
      definition_revision: number;
      criteria_revision: number;
      occurred_at: string;
    } | undefined;
    if (pendingResult?.state === "proposed") {
      push(
        pendingResult.definition_revision === row.definition_revision &&
            pendingResult.criteria_revision === row.criteria_revision
          ? "needs_approval"
          : "result_stale",
        pendingResult.result_id,
        pendingResult.occurred_at,
        "member",
        row.owner_member_id
      );
    } else if (pendingResult?.state === "rejected") {
      push(
        "result_rejected",
        pendingResult.result_id,
        pendingResult.occurred_at,
        "agent",
        null,
        assignments[0]?.agentId ?? null
      );
    }
    const block = this.database.prepare(`
      SELECT block_id, created_at FROM task_blocks WHERE task_id = ?
        AND state = 'open' ORDER BY created_at, block_id LIMIT 1
    `).get(row.task_id) as { block_id: string; created_at: string } | undefined;
    if (block) {
      push("blocked", block.block_id, block.created_at, "member", row.owner_member_id);
    }
    if (row.due_at && Date.parse(row.due_at) < Date.now() &&
      !["completed", "canceled"].includes(row.lifecycle_state)) {
      push("overdue", row.task_id, row.due_at, "member", row.owner_member_id);
    }
    if (row.scheduling_state === "paused") {
      push("paused", row.task_id, row.updated_at, "member", row.owner_member_id);
    }
    if (
      row.budget_run_attempts >= row.max_run_attempts ||
      row.budget_execution_duration_seconds >= row.max_execution_duration_seconds
    ) {
      push("budget_exhausted", row.task_id, row.updated_at, "member", row.owner_member_id);
    }
    const unavailable = assignments.find(({ agentId }) => {
      const agent = this.database.prepare(`
        SELECT enabled, presence FROM agents WHERE agent_id = ?
      `).get(agentId) as { enabled: number; presence: string } | undefined;
      return !agent || agent.enabled !== 1 || agent.presence === "offline";
    });
    if (unavailable) {
      push(
        "runtime_unavailable", unavailable.agentId, row.updated_at,
        "agent", null, unavailable.agentId
      );
    }
    return reasons.sort((left, right) =>
      attentionPriority.indexOf(left.reason) - attentionPriority.indexOf(right.reason)
    );
  }

  private nextAction(
    row: AgentTaskRow,
    attention: TaskAttention[],
    assignments: TaskAssignment[]
  ): TaskNextAction {
    const primary = attention[0];
    const reasonMap: Partial<Record<TaskAttentionReason, TaskNextAction["reason"]>> = {
      needs_input: "provide_input",
      outcome_unknown: "acknowledge_outcome",
      needs_approval: "review_result",
      result_stale: "review_result",
      blocked: "resolve_block",
      paused: "resume_scheduling",
      budget_exhausted: "increase_budget",
      runtime_unavailable: "restore_runtime",
      result_rejected: "submit_result"
    };
    if (primary) {
      return {
        actorKind: primary.actorKind,
        reason: reasonMap[primary.reason] ?? "resolve_block",
        sourceId: primary.sourceId,
        expectedMemberId: primary.expectedMemberId,
        expectedAgentId: primary.expectedAgentId
      };
    }
    if (row.lifecycle_state === "ready") {
      return {
        actorKind: "member",
        reason: "start_work",
        sourceId: row.task_id,
        expectedMemberId: row.owner_member_id,
        expectedAgentId: null
      };
    }
    if (row.lifecycle_state === "active" || row.lifecycle_state === "review") {
      return {
        actorKind: assignments.length > 0 ? "agent" : "member",
        reason: "submit_result",
        sourceId: row.task_id,
        expectedMemberId: assignments.length > 0 ? null : row.owner_member_id,
        expectedAgentId: assignments[0]?.agentId ?? null
      };
    }
    return {
      actorKind: "system",
      reason: "none",
      sourceId: null,
      expectedMemberId: null,
      expectedAgentId: null
    };
  }

  private insertDefinitionRevision(
    task: Pick<AgentTaskRecord, "taskId" | "definitionRevision" | "title" | "goal">,
    memberId: string,
    now: string
  ): void {
    this.database.prepare(`
      INSERT INTO task_definition_revisions (
        task_id, definition_revision, title, goal, created_by_member_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      task.taskId, task.definitionRevision, task.title, task.goal, memberId, now
    );
  }

  private insertCriteriaRevision(
    task: Pick<AgentTaskRecord, "taskId" | "criteriaRevision" | "criteria">,
    memberId: string,
    now: string
  ): void {
    this.database.prepare(`
      INSERT INTO task_criteria_revisions (
        task_id, criteria_revision, created_by_member_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(task.taskId, task.criteriaRevision, memberId, now);
    const insert = this.database.prepare(`
      INSERT INTO task_criteria_entries (
        task_id, criteria_revision, criterion_key, description, required,
        ordinal
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const criterion of task.criteria) {
      insert.run(
        task.taskId, task.criteriaRevision, criterion.criterionKey,
        criterion.description, criterion.required ? 1 : 0, criterion.ordinal
      );
    }
  }

  private replaceAssignments(
    taskId: string,
    assignments: Array<Pick<TaskAssignment, "agentId" | "role">>,
    memberId: string,
    now: string
  ): void {
    this.database.prepare(
      "DELETE FROM task_agent_assignments WHERE task_id = ?"
    ).run(taskId);
    const insert = this.database.prepare(`
      INSERT INTO task_agent_assignments (
        task_id, agent_id, role, assigned_by_member_id, assigned_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const assignment of assignments) {
      insert.run(taskId, assignment.agentId, assignment.role, memberId, now);
    }
  }

  private requireRevision(taskId: string, expected: number): AgentTaskRecord {
    const task = this.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.taskRevision !== expected) throw new Error("Task revision conflict");
    return task;
  }

  private isOperationReplay(operationId: string, taskId: string): boolean {
    const operation = this.database.prepare(`
      SELECT task_id FROM task_mutation_operations WHERE operation_id = ?
    `).get(operationId) as { task_id: string } | undefined;
    if (!operation) return false;
    if (operation.task_id !== taskId) {
      throw new Error("Task operation is already bound to another Task");
    }
    return true;
  }

  private recordOperation(
    operationId: string,
    taskId: string,
    revision: number,
    now: string
  ): void {
    this.database.prepare(`
      INSERT INTO task_mutation_operations (
        operation_id, task_id, resulting_task_revision, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(operationId, taskId, revision, now);
  }
}
