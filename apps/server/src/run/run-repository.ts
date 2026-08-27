import type Database from "better-sqlite3";

import { createOpaqueId } from "../domain/identifiers.js";
import type { RuntimeEvent } from "../runtime/runtime-adapter.js";

export type RunState =
  | "queued"
  | "delivered"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled"
  | "expired"
  | "outcome_unknown";

export interface RunRecord {
  runId: string;
  traceId: string;
  roomId: string;
  taskId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  targetAgentId: string;
  parentRunId: string | null;
  attemptNumber?: number;
  retryOfRunId?: string | null;
  instruction: string;
  state: RunState;
  lastSequence: number;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  orchestrationKey?: string;
}

export interface RunContextManifest {
  manifestVersion: "1.0";
  runId: string;
  taskId: string;
  taskRevision: number;
  definitionRevision: number;
  criteriaRevision: number;
  goal: string;
  criteria: Array<{
    criterionKey: string;
    description: string;
    required: boolean;
    ordinal: number;
  }>;
  target: {
    agentId: string;
    deviceId: string | null;
    runtimeKind: "generic" | "manual" | "fake";
    workspaceAlias: string | null;
  };
  included: {
    messageIds: string[];
    artifactIds: string[];
    memoryIds: string[];
    parentRunIds: string[];
    roomContextRevision: number;
    taskMemoryRevision: number;
    artifactRevision: number;
  };
  permissions: {
    filesystemAccess: "read-only" | "workspace-write" | "local-policy" |
      "not_recorded";
    networkAccess: "not_recorded";
    interrupt: "supported" | "unsupported" | "not_recorded";
    handoff: "supported" | "unsupported" | "not_recorded";
    maxDurationSeconds: number;
  };
  omittedCategories: Array<
    | "unrelated_room_history"
    | "local_paths"
    | "environment_values"
    | "provider_credentials"
    | "provider_session_ids"
    | "hidden_reasoning"
    | "tool_payloads"
    | "other_workspaces"
  >;
  recordedAt: string;
}

export interface RunAmbiguityAcknowledgement {
  runId: string;
  operationId: string;
  taskId: string;
  acknowledgedByMemberId: string;
  reason: string;
  taskRevisionBefore: number;
  taskRevisionAfter: number;
  acknowledgedAt: string;
}

export interface RunContextFence {
  runId: string;
  roomId: string;
  taskId: string;
  triggerSequence: number;
  roomLongTermMemoryRevision: number;
  taskLongTermMemoryRevision: number;
  taskArtifactRevision: number;
  taskSummaryRevision: number;
  taskState: "open" | "working" | "blocked" | "review" | "completed" | "canceled";
  taskTitle: string;
  taskGoal: string;
  fenceKind: "legacy" | "captured";
  capturedAt: string;
}

export interface RunEventRecord {
  runId: string;
  traceId: string;
  sequence: number;
  event: RuntimeEvent;
  createdAt: string;
}

export interface AppliedRunEvent {
  applied: boolean;
  run: RunRecord;
}

export interface RunReplyRoutingIntent {
  parentRunId: string;
  replySequence: number;
  content: string;
  state: "pending" | "completed";
  createdAt: string;
  completedAt: string | null;
}

interface RunRow {
  run_id: string;
  trace_id: string;
  room_id: string;
  task_id: string;
  trigger_message_id: string;
  requester_member_id: string;
  target_agent_id: string;
  parent_run_id: string | null;
  attempt_number: number;
  retry_of_run_id: string | null;
  context_manifest_json: string | null;
  instruction: string;
  state: RunState;
  last_sequence: number;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  orchestration_key: string | null;
}

interface RunEventRow {
  run_id: string;
  trace_id: string;
  sequence: number;
  event_type: RuntimeEvent["type"];
  status: RunState | null;
  content: string | null;
  output_reset: 0 | 1;
  assessment_json: string | null;
  activity_json: string | null;
  error_json: string | null;
  session_json: string | null;
  clarification_json: string | null;
  created_at: string;
}

interface RunContextFenceRow {
  run_id: string;
  room_id: string;
  task_id: string;
  trigger_sequence: number;
  room_long_term_memory_revision: number;
  task_long_term_memory_revision: number;
  task_artifact_revision: number;
  task_summary_revision: number;
  task_state: RunContextFence["taskState"];
  task_title: string;
  task_goal: string;
  fence_kind: RunContextFence["fenceKind"];
  captured_at: string;
}

interface RunReplyRoutingIntentRow {
  parent_run_id: string;
  reply_sequence: number;
  content: string;
  state: RunReplyRoutingIntent["state"];
  created_at: string;
  completed_at: string | null;
}

const terminalStates = new Set<RunState>([
  "completed",
  "failed",
  "canceled",
  "expired",
  "outcome_unknown"
]);

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    traceId: row.trace_id,
    roomId: row.room_id,
    taskId: row.task_id,
    triggerMessageId: row.trigger_message_id,
    requesterMemberId: row.requester_member_id,
    targetAgentId: row.target_agent_id,
    parentRunId: row.parent_run_id,
    attemptNumber: row.attempt_number,
    retryOfRunId: row.retry_of_run_id,
    instruction: row.instruction,
    state: row.state,
    lastSequence: row.last_sequence,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    ...(row.orchestration_key
      ? { orchestrationKey: row.orchestration_key }
      : {})
  };
}

function mapContextFence(row: RunContextFenceRow): RunContextFence {
  return {
    runId: row.run_id,
    roomId: row.room_id,
    taskId: row.task_id,
    triggerSequence: row.trigger_sequence,
    roomLongTermMemoryRevision: row.room_long_term_memory_revision,
    taskLongTermMemoryRevision: row.task_long_term_memory_revision,
    taskArtifactRevision: row.task_artifact_revision,
    taskSummaryRevision: row.task_summary_revision,
    taskState: row.task_state,
    taskTitle: row.task_title,
    taskGoal: row.task_goal,
    fenceKind: row.fence_kind,
    capturedAt: row.captured_at
  };
}

function mapRunEvent(row: RunEventRow): RunEventRecord {
  const event: RuntimeEvent = row.event_type === "activity"
    ? {
        type: "activity",
        sequence: row.sequence,
        ...JSON.parse(row.activity_json ?? "{}") as Omit<
          Extract<RuntimeEvent, { type: "activity" }>,
          "type" | "sequence"
        >
      }
    : row.event_type === "reply"
      ? {
        type: "reply",
        sequence: row.sequence,
        content: row.content ?? "",
        ...(row.assessment_json
          ? { assessment: JSON.parse(row.assessment_json) as Record<string, unknown> }
          : {})
      }
    : row.event_type === "output"
      ? {
          type: "output",
          sequence: row.sequence,
          content: row.content ?? "",
          ...(row.output_reset === 1 ? { reset: true } : {})
        }
      : {
        type: "status",
        sequence: row.sequence,
        status: row.status as Extract<RuntimeEvent, { type: "status" }>["status"],
        ...(row.error_json
          ? { error: JSON.parse(row.error_json) as {
              code: string;
              message: string;
              retryable: boolean;
              details?: Record<string, unknown>;
            } }
          : {}),
        ...(row.session_json
          ? { session: JSON.parse(row.session_json) as {
              disposition: "started" | "resumed" | "recreated";
              contextCursor: number;
              runtimeScopeId?: string;
              resultEvidenceRevision?: number;
              roomContextConsumption?: {
                baseContextCursor: number;
                checkpointId?: string;
                rawFromSequenceExclusive: number;
                rawThroughSequenceInclusive: number;
                rawMessageCount: number;
                coverageThroughSequence: number;
              };
            } }
          : {}),
        ...(row.clarification_json
          ? { clarification: JSON.parse(row.clarification_json) as {
              kind: "task";
              question: string;
              choices?: string[];
            } }
          : {})
      };
  return {
    runId: row.run_id,
    traceId: row.trace_id,
    sequence: row.sequence,
    event,
    createdAt: row.created_at
  };
}

function mapReplyRoutingIntent(
  row: RunReplyRoutingIntentRow
): RunReplyRoutingIntent {
  return {
    parentRunId: row.parent_run_id,
    replySequence: row.reply_sequence,
    content: row.content,
    state: row.state,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

export class RunRepository {
  public constructor(private readonly database: Database.Database) {}

  public createRuns(runs: RunRecord[]): RunRecord[] {
    const insert = this.database.prepare(`
      INSERT INTO runs (
        run_id, trace_id, room_id, task_id, trigger_message_id,
        requester_member_id, target_agent_id, parent_run_id, instruction,
        state, last_sequence, deadline_at, created_at, updated_at, terminal_at,
        orchestration_key, attempt_number, retry_of_run_id, context_manifest_json
      ) VALUES (
        @runId, @traceId, @roomId, @taskId, @triggerMessageId,
        @requesterMemberId, @targetAgentId, @parentRunId, @instruction,
        @state, @lastSequence, @deadlineAt, @createdAt, @updatedAt,
        @terminalAt, @orchestrationKey, @attemptNumber, @retryOfRunId, NULL
      )
    `);
    this.database.transaction(() => {
      for (const run of runs) {
        const attemptNumber = run.attemptNumber ?? this.nextAttemptNumber(run.taskId);
        insert.run({
          ...run,
          attemptNumber,
          retryOfRunId: run.retryOfRunId ?? null,
          orchestrationKey: run.orchestrationKey ?? null
        });
        const manifest = this.buildContextManifest(run.runId);
        this.database.prepare(`
          UPDATE runs SET context_manifest_json = ? WHERE run_id = ?
        `).run(JSON.stringify(manifest), run.runId);
      }
    }).immediate();
    return runs.map(({ runId }) => this.getRun(runId)!);
  }

  public getContextManifest(runId: string): RunContextManifest | undefined {
    const row = this.database.prepare(`
      SELECT context_manifest_json FROM runs WHERE run_id = ?
    `).get(runId) as { context_manifest_json: string | null } | undefined;
    return row?.context_manifest_json
      ? JSON.parse(row.context_manifest_json) as RunContextManifest
      : undefined;
  }

  public getAmbiguityAcknowledgement(
    runId: string
  ): RunAmbiguityAcknowledgement | undefined {
    const row = this.database.prepare(`
      SELECT * FROM run_ambiguity_acknowledgements WHERE run_id = ?
    `).get(runId) as {
      run_id: string;
      operation_id: string;
      task_id: string;
      acknowledged_by_member_id: string;
      reason: string;
      task_revision_before: number;
      task_revision_after: number;
      acknowledged_at: string;
    } | undefined;
    return row && {
      runId: row.run_id,
      operationId: row.operation_id,
      taskId: row.task_id,
      acknowledgedByMemberId: row.acknowledged_by_member_id,
      reason: row.reason,
      taskRevisionBefore: row.task_revision_before,
      taskRevisionAfter: row.task_revision_after,
      acknowledgedAt: row.acknowledged_at
    };
  }

  public acknowledgeAmbiguity(input: {
    runId: string;
    operationId: string;
    expectedTaskRevision: number;
    memberId: string;
    reason: string;
    now: string;
  }): RunAmbiguityAcknowledgement {
    this.database.transaction(() => {
      const operation = this.database.prepare(`
        SELECT run_id FROM run_ambiguity_acknowledgements
        WHERE operation_id = ?
      `).get(input.operationId) as { run_id: string } | undefined;
      if (operation) {
        if (operation.run_id !== input.runId) {
          throw new Error("Ambiguity operation is bound to another Run");
        }
        return;
      }
      const run = this.getRun(input.runId);
      if (!run || run.state !== "outcome_unknown") {
        throw new Error("Only an outcome_unknown Run may be acknowledged");
      }
      if (this.getAmbiguityAcknowledgement(input.runId)) {
        throw new Error("Run ambiguity is already acknowledged");
      }
      const updated = this.database.prepare(`
        UPDATE agent_tasks
        SET task_revision = task_revision + 1, updated_at = ?
        WHERE task_id = ? AND task_revision = ?
      `).run(input.now, run.taskId, input.expectedTaskRevision);
      if (updated.changes !== 1) throw new Error("Task revision conflict");
      this.database.prepare(`
        INSERT INTO run_ambiguity_acknowledgements (
          run_id, operation_id, task_id, acknowledged_by_member_id, reason,
          task_revision_before, task_revision_after, acknowledged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.runId,
        input.operationId,
        run.taskId,
        input.memberId,
        input.reason,
        input.expectedTaskRevision,
        input.expectedTaskRevision + 1,
        input.now
      );
    }).immediate();
    return this.getAmbiguityAcknowledgement(input.runId)!;
  }

  public createRetry(input: {
    parentRunId: string;
    operationId: string;
    expectedTaskRevision: number;
    memberId: string;
    now: string;
    deadlineAt: string;
  }): RunRecord {
    let retryRunId: string | undefined;
    this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT parent_run_id, retry_run_id FROM run_retry_operations
        WHERE operation_id = ?
      `).get(input.operationId) as
        | { parent_run_id: string; retry_run_id: string }
        | undefined;
      if (replay) {
        if (replay.parent_run_id !== input.parentRunId) {
          throw new Error("Retry operation is bound to another Run");
        }
        retryRunId = replay.retry_run_id;
        return;
      }
      const parent = this.getRun(input.parentRunId);
      if (!parent || !terminalStates.has(parent.state) || parent.state === "completed") {
        throw new Error("Only an unsuccessful terminal Run may be retried");
      }
      if (parent.state === "outcome_unknown" &&
        !this.getAmbiguityAcknowledgement(parent.runId)) {
        throw new Error("Ambiguous Run outcome requires acknowledgement before retry");
      }
      const task = this.database.prepare(`
        SELECT task_revision, lifecycle_state, scheduling_state,
          max_run_attempts, budget_run_attempts,
          max_execution_duration_seconds, budget_execution_duration_seconds,
          is_default
        FROM agent_tasks WHERE task_id = ?
      `).get(parent.taskId) as {
        task_revision: number;
        lifecycle_state: string;
        scheduling_state: string;
        max_run_attempts: number;
        budget_run_attempts: number;
        max_execution_duration_seconds: number;
        budget_execution_duration_seconds: number;
        is_default: number;
      } | undefined;
      if (!task || task.task_revision !== input.expectedTaskRevision) {
        throw new Error("Task revision conflict");
      }
      if (!["ready", "active", "review"].includes(task.lifecycle_state) ||
        task.scheduling_state !== "enabled") {
        throw new Error("Run Task is not schedulable");
      }
      if (task.budget_run_attempts >= task.max_run_attempts ||
        task.budget_execution_duration_seconds >=
          task.max_execution_duration_seconds) {
        throw new Error("Task budget is exhausted");
      }
      if (task.is_default !== 1 && !this.database.prepare(`
        SELECT 1 FROM task_agent_assignments WHERE task_id = ? AND agent_id = ?
      `).get(parent.taskId, parent.targetAgentId)) {
        throw new Error("Retry target is no longer assigned to the Task");
      }
      retryRunId = createOpaqueId("run");
      const retryTriggerMessageId = createOpaqueId("msg");
      const sequence = this.database.prepare(`
        UPDATE rooms SET next_message_sequence = next_message_sequence + 1
        WHERE room_id = ? RETURNING next_message_sequence AS sequence
      `).get(parent.roomId) as { sequence: number };
      this.database.prepare(`
        INSERT INTO messages (
          message_id, trace_id, room_id, task_id, sequence, sender_type,
          sender_id, content, parent_message_id, client_message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, 'member', ?, ?, ?, NULL, ?)
      `).run(
        retryTriggerMessageId,
        parent.traceId,
        parent.roomId,
        parent.taskId,
        sequence.sequence,
        input.memberId,
        parent.instruction,
        parent.triggerMessageId,
        input.now
      );
      this.createRuns([{
        runId: retryRunId,
        traceId: parent.traceId,
        roomId: parent.roomId,
        taskId: parent.taskId,
        triggerMessageId: retryTriggerMessageId,
        requesterMemberId: input.memberId,
        targetAgentId: parent.targetAgentId,
        parentRunId: null,
        retryOfRunId: parent.runId,
        instruction: parent.instruction,
        state: "queued",
        lastSequence: 0,
        deadlineAt: input.deadlineAt,
        createdAt: input.now,
        updatedAt: input.now,
        terminalAt: null
      }]);
      this.database.prepare(`
        INSERT INTO run_retry_operations (
          operation_id, parent_run_id, retry_run_id, created_by_member_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        input.operationId,
        input.parentRunId,
        retryRunId,
        input.memberId,
        input.now
      );
    }).immediate();
    return this.getRun(retryRunId!)!;
  }

  public getRun(runId: string): RunRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM runs WHERE run_id = ?
    `).get(runId) as RunRow | undefined;
    return row && mapRun(row);
  }

  public getContextFence(runId: string): RunContextFence | undefined {
    const row = this.database.prepare(`
      SELECT * FROM run_context_fences WHERE run_id = ?
    `).get(runId) as RunContextFenceRow | undefined;
    return row && mapContextFence(row);
  }

  public findByTrigger(messageId: string): RunRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM runs WHERE trigger_message_id = ? ORDER BY target_agent_id
    `).all(messageId) as RunRow[];
    return rows.map(mapRun);
  }

  public findByOrchestrationKey(orchestrationKey: string): RunRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM runs WHERE orchestration_key = ?
    `).get(orchestrationKey) as RunRow | undefined;
    return row && mapRun(row);
  }

  public listRoomRuns(roomId: string): RunRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM runs WHERE room_id = ? ORDER BY created_at, run_id
    `).all(roomId) as RunRow[];
    return rows.map(mapRun);
  }

  public listTaskRuns(taskId: string): RunRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM runs WHERE task_id = ?
      ORDER BY created_at, run_id
    `).all(taskId) as RunRow[];
    return rows.map(mapRun);
  }

  public listAgentRuns(agentId: string): RunRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM runs
      WHERE target_agent_id = ?
      ORDER BY created_at, run_id
    `).all(agentId) as RunRow[];
    return rows.map(mapRun);
  }

  public expireQueued(roomId: string, now: string): RunRecord[] {
    const due = this.database.prepare(`
      SELECT run_id FROM runs
      WHERE room_id = ? AND state = 'queued' AND deadline_at <= ?
      ORDER BY created_at, run_id
    `).all(roomId, now) as Array<{ run_id: string }>;
    return due.map(({ run_id: runId }) => this.applyEvent(runId, {
      type: "status",
      sequence: (this.getRun(runId)?.lastSequence ?? 0) + 1,
      status: "expired",
      error: {
        code: "RUN_EXPIRED",
        message: "Run expired before its target Agent accepted delivery.",
        retryable: false
      }
    }, now).run);
  }

  public applyEvent(
    runId: string,
    event: RuntimeEvent,
    now: string
  ): AppliedRunEvent {
    return this.database.transaction(() => {
      const current = this.getRun(runId);
      if (!current) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (event.sequence <= current.lastSequence || terminalStates.has(current.state)) {
        return { applied: false, run: current };
      }
      if (event.sequence !== current.lastSequence + 1) {
        throw new Error(`Run event sequence gap: ${event.sequence}`);
      }

      const nextState = event.type === "status" ? event.status : current.state;
      const terminalAt = terminalStates.has(nextState) ? now : null;
      this.database.prepare(`
        INSERT INTO run_events (
          run_id, trace_id, sequence, event_type, status, content, output_reset,
          error_json, assessment_json, activity_json, session_json,
          clarification_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        current.traceId,
        event.sequence,
        event.type,
        event.type === "status" ? event.status : null,
        event.type === "reply" || event.type === "output" ? event.content : null,
        event.type === "output" && event.reset ? 1 : 0,
        event.type === "status" && event.error
          ? JSON.stringify(event.error)
          : null,
        event.type === "reply" && event.assessment
          ? JSON.stringify(event.assessment)
          : null,
        event.type === "activity"
          ? JSON.stringify({
              activityId: event.activityId,
              kind: event.kind,
              phase: event.phase,
              ...(event.label ? { label: event.label } : {}),
              ...(event.content ? { content: event.content } : {}),
              ...(event.reset ? { reset: true } : {})
            })
          : null,
        event.type === "status" && event.session
          ? JSON.stringify(event.session)
          : null,
        event.type === "status" && event.clarification
          ? JSON.stringify(event.clarification)
          : null,
        now
      );
      if (event.type === "status" && event.clarification) {
        if (event.status !== "input_required" || current.orchestrationKey) {
          throw new Error(
            "Task clarification is allowed only for a non-Discussion input-required Run"
          );
        }
        if (this.database.prepare(`
          SELECT 1 FROM task_clarifications WHERE requesting_run_id = ?
        `).get(runId)) {
          throw new Error("Run already owns a Task clarification");
        }
        const questionMessageId = createOpaqueId("msg");
        const clarificationId = createOpaqueId("clarification");
        const sequenceRow = this.database.prepare(`
          UPDATE rooms
          SET next_message_sequence = next_message_sequence + 1
          WHERE room_id = ?
          RETURNING next_message_sequence AS sequence
        `).get(current.roomId) as { sequence: number };
        this.database.prepare(`
          INSERT INTO messages (
            message_id, trace_id, room_id, task_id, sequence, sender_type,
            sender_id, content, parent_message_id, client_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, ?, NULL, ?)
        `).run(
          questionMessageId,
          current.traceId,
          current.roomId,
          current.taskId,
          sequenceRow.sequence,
          current.targetAgentId,
          event.clarification.question,
          current.triggerMessageId,
          now
        );
        this.database.prepare(`
          INSERT INTO task_clarifications (
            clarification_id, task_id, room_id, requesting_run_id,
            target_agent_id, question, choices_json, state,
            question_message_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)
        `).run(
          clarificationId,
          current.taskId,
          current.roomId,
          current.runId,
          current.targetAgentId,
          event.clarification.question,
          event.clarification.choices
            ? JSON.stringify(event.clarification.choices)
            : null,
          questionMessageId,
          now
        );
      }
      if (event.type === "status" && event.session) {
        this.database.prepare(`
          UPDATE agent_tasks
          SET last_room_sequence = max(last_room_sequence, ?), updated_at = ?
          WHERE task_id = ?
        `).run(event.session.contextCursor, now, current.taskId);
      }
      if (event.type === "reply") {
        this.database.prepare(`
          INSERT INTO run_reply_routing_intents (
            parent_run_id, reply_sequence, content, state, created_at
          ) VALUES (?, ?, ?, 'pending', ?)
        `).run(runId, event.sequence, event.content, now);
      }
      this.database.prepare(`
        UPDATE runs
        SET state = ?, last_sequence = ?, updated_at = ?, terminal_at = ?
        WHERE run_id = ?
      `).run(nextState, event.sequence, now, terminalAt, runId);
      const updated = this.getRun(runId);
      if (!updated) {
        throw new Error(`Run disappeared after event: ${runId}`);
      }
      return { applied: true, run: updated };
    }).immediate();
  }

  public listEvents(runId: string, afterSequence = 0): RunEventRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM run_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence
    `).all(runId, afterSequence) as RunEventRow[];
    return rows.map(mapRunEvent);
  }

  public listPendingReplyRoutingIntents(
    parentRunId?: string
  ): RunReplyRoutingIntent[] {
    const rows = (parentRunId
      ? this.database.prepare(`
          SELECT * FROM run_reply_routing_intents
          WHERE state = 'pending' AND parent_run_id = ?
          ORDER BY reply_sequence
        `).all(parentRunId)
      : this.database.prepare(`
          SELECT * FROM run_reply_routing_intents
          WHERE state = 'pending'
          ORDER BY created_at, parent_run_id, reply_sequence
        `).all()) as RunReplyRoutingIntentRow[];
    return rows.map(mapReplyRoutingIntent);
  }

  public completeReplyRoutingIntent(
    parentRunId: string,
    replySequence: number,
    now: string
  ): void {
    this.database.prepare(`
      UPDATE run_reply_routing_intents
      SET state = 'completed', completed_at = ?
      WHERE parent_run_id = ? AND reply_sequence = ? AND state = 'pending'
    `).run(now, parentRunId, replySequence);
  }

  private nextAttemptNumber(taskId: string): number {
    return (this.database.prepare(`
      SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next
      FROM runs WHERE task_id = ?
    `).get(taskId) as { next: number }).next;
  }

  private buildContextManifest(runId: string): RunContextManifest {
    const run = this.getRun(runId);
    const fence = this.getContextFence(runId);
    if (!run || !fence) {
      throw new Error("Run Context Manifest requires a captured context fence");
    }
    const task = this.database.prepare(`
      SELECT task_revision, definition_revision, criteria_revision, goal
      FROM agent_tasks WHERE task_id = ?
    `).get(run.taskId) as {
      task_revision: number;
      definition_revision: number;
      criteria_revision: number;
      goal: string;
    } | undefined;
    const agent = this.database.prepare(`
      SELECT device_id, integration_mode, capabilities_json,
        runtime_policy_json, workspace_alias
      FROM agents WHERE agent_id = ?
    `).get(run.targetAgentId) as {
      device_id: string | null;
      integration_mode: "managed" | "manual" | "fake";
      capabilities_json: string;
      runtime_policy_json: string | null;
      workspace_alias: string | null;
    } | undefined;
    if (!task || !agent) {
      throw new Error("Run Context Manifest identity is unavailable");
    }
    const criteria = (this.database.prepare(`
      SELECT criterion_key, description, required, ordinal
      FROM task_criteria_entries
      WHERE task_id = ? AND criteria_revision = ?
      ORDER BY ordinal, criterion_key
    `).all(run.taskId, task.criteria_revision) as Array<{
      criterion_key: string;
      description: string;
      required: number;
      ordinal: number;
    }>).map((criterion) => ({
      criterionKey: criterion.criterion_key,
      description: criterion.description,
      required: criterion.required === 1,
      ordinal: criterion.ordinal
    }));
    const capabilities = JSON.parse(agent.capabilities_json) as {
      supportsInterrupt?: boolean;
      supportsHandoff?: boolean;
    };
    const runtimePolicy = agent.runtime_policy_json
      ? JSON.parse(agent.runtime_policy_json) as {
          filesystemAccess?: "read-only" | "workspace-write" | "local-policy";
        }
      : undefined;
    const parentRunIds = [...new Set([
      run.parentRunId,
      run.retryOfRunId ?? null
    ].filter((value): value is string => value !== null))];
    return {
      manifestVersion: "1.0",
      runId: run.runId,
      taskId: run.taskId,
      taskRevision: task.task_revision,
      definitionRevision: task.definition_revision,
      criteriaRevision: task.criteria_revision,
      goal: fence.taskGoal,
      criteria,
      target: {
        agentId: run.targetAgentId,
        deviceId: agent.device_id,
        runtimeKind: agent.integration_mode === "managed"
          ? "generic"
          : agent.integration_mode,
        workspaceAlias: agent.workspace_alias
      },
      included: {
        messageIds: [run.triggerMessageId],
        artifactIds: [],
        memoryIds: [],
        parentRunIds,
        roomContextRevision: fence.roomLongTermMemoryRevision,
        taskMemoryRevision: fence.taskLongTermMemoryRevision,
        artifactRevision: fence.taskArtifactRevision
      },
      permissions: {
        filesystemAccess: runtimePolicy?.filesystemAccess ?? "not_recorded",
        networkAccess: "not_recorded",
        interrupt: typeof capabilities.supportsInterrupt === "boolean"
          ? capabilities.supportsInterrupt ? "supported" : "unsupported"
          : "not_recorded",
        handoff: typeof capabilities.supportsHandoff === "boolean"
          ? capabilities.supportsHandoff ? "supported" : "unsupported"
          : "not_recorded",
        maxDurationSeconds: Math.min(
          86_400,
          Math.max(
            1,
            Math.floor(
              (Date.parse(run.deadlineAt) - Date.parse(run.createdAt)) / 1000
            )
          )
        )
      },
      omittedCategories: [
        "unrelated_room_history",
        "local_paths",
        "environment_values",
        "provider_credentials",
        "provider_session_ids",
        "hidden_reasoning",
        "tool_payloads",
        "other_workspaces"
      ],
      recordedAt: run.createdAt
    };
  }
}
