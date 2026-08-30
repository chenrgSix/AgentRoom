import type Database from "better-sqlite3";

import { exceedsUnicodeCodePointLimit } from "../domain/unicode-length.js";
import { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
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

export interface CommittedRunChange {
  kind: "room" | "run";
  roomId: string;
  teamId: string;
}

export interface DeviceRevocationRun {
  run: RunRecord;
  acceptedByBridge: boolean;
}

export type RunCancellationTerminalStatus = Extract<RunState,
  "completed" | "failed" | "canceled" | "expired" | "outcome_unknown"
>;

export interface RunCancellationIntent {
  runId: string;
  messageId: string;
  agentId: string;
  deviceId: string;
  requestedByMemberId: string;
  reason: string;
  state: "pending" | "resolved";
  createdAt: string;
  lastSentAt: string | null;
  sendCount: number;
  ackDeadlineAt: string;
  resolvedAt: string | null;
  terminalStatus: RunCancellationTerminalStatus | null;
}

export interface RunCancellationRequest {
  run: RunRecord;
  intent?: RunCancellationIntent;
  created: boolean;
}

export interface RunCancellationDelivery {
  deviceId: string;
  state: "pending" | "accepted";
  sendCount: number;
  lastSentAt: string | null;
}

export interface RunReplyRoutingIntent {
  parentRunId: string;
  replySequence: number;
  content: string;
  state: "pending" | "completed";
  createdAt: string;
  completedAt: string | null;
}

export interface RunReplyMessageProjection {
  runId: string;
  replySequence: number;
  messageId: string;
  projectedAt: string;
}

export type RunReplyProjectionFailureCode =
  | "INVALID_REPLY_EVENT"
  | "MULTIPLE_EXACT_MESSAGES"
  | "MESSAGE_ALREADY_PROJECTED"
  | "TIMESTAMP_MISMATCH";

export interface RunReplyProjectionFailure {
  runId: string;
  replySequence: number;
  errorCode: RunReplyProjectionFailureCode;
  candidateCount: number;
  recordedAt: string;
}

export type RunReplyProjectionReconciliation =
  | {
      state: "projected";
      messageCreated: boolean;
      projection: RunReplyMessageProjection;
    }
  | {
      state: "unreconciled";
      failure: RunReplyProjectionFailure;
    };

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

interface RunCancellationIntentRow {
  run_id: string;
  message_id: string;
  agent_id: string;
  device_id: string;
  requested_by_member_id: string;
  reason: string;
  state: RunCancellationIntent["state"];
  created_at: string;
  last_sent_at: string | null;
  send_count: number;
  ack_deadline_at: string;
  resolved_at: string | null;
  terminal_status: RunCancellationTerminalStatus | null;
}

interface RunCancellationDeliveryRow {
  device_id: string;
  state: RunCancellationDelivery["state"];
  send_count: number;
  last_sent_at: string | null;
}

interface RunReplyMessageProjectionRow {
  run_id: string;
  reply_sequence: number;
  message_id: string;
  projected_at: string;
}

interface RunReplyProjectionFailureRow {
  run_id: string;
  reply_sequence: number;
  error_code: RunReplyProjectionFailureCode;
  candidate_count: number;
  recorded_at: string;
}

interface ReplyProjectionSourceRow {
  run_id: string;
  reply_sequence: number;
  event_trace_id: string | null;
  content: string | null;
  event_created_at: string;
  run_trace_id: string;
  room_id: string;
  task_id: string;
  trigger_message_id: string;
  target_agent_id: string;
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

function mapCancellationIntent(
  row: RunCancellationIntentRow
): RunCancellationIntent {
  return {
    runId: row.run_id,
    messageId: row.message_id,
    agentId: row.agent_id,
    deviceId: row.device_id,
    requestedByMemberId: row.requested_by_member_id,
    reason: row.reason,
    state: row.state,
    createdAt: row.created_at,
    lastSentAt: row.last_sent_at,
    sendCount: row.send_count,
    ackDeadlineAt: row.ack_deadline_at,
    resolvedAt: row.resolved_at,
    terminalStatus: row.terminal_status
  };
}

function mapReplyMessageProjection(
  row: RunReplyMessageProjectionRow
): RunReplyMessageProjection {
  return {
    runId: row.run_id,
    replySequence: row.reply_sequence,
    messageId: row.message_id,
    projectedAt: row.projected_at
  };
}

function mapReplyProjectionFailure(
  row: RunReplyProjectionFailureRow
): RunReplyProjectionFailure {
  return {
    runId: row.run_id,
    replySequence: row.reply_sequence,
    errorCode: row.error_code,
    candidateCount: row.candidate_count,
    recordedAt: row.recorded_at
  };
}

export class RunRepository {
  private readonly roomTeams = new Map<string, string>();

  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database),
    private readonly onCommitted?: (change: CommittedRunChange) => void
  ) {}

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
    this.transactions.immediate(() => {
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
      for (const roomId of new Set(runs.map((run) => run.roomId))) {
        this.scheduleCommittedChange(roomId, "run");
      }
    });
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
    this.transactions.immediate(() => {
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
    });
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
    this.transactions.immediate(() => {
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
      this.scheduleCommittedChange(parent.roomId, "room");
    });
    return this.getRun(retryRunId!)!;
  }

  public getRun(runId: string): RunRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM runs WHERE run_id = ?
    `).get(runId) as RunRow | undefined;
    return row && mapRun(row);
  }

  public getCancellationIntent(
    runId: string
  ): RunCancellationIntent | undefined {
    const row = this.database.prepare(`
      SELECT * FROM run_cancellation_intents WHERE run_id = ?
    `).get(runId) as RunCancellationIntentRow | undefined;
    return row && mapCancellationIntent(row);
  }

  public getCancellationDelivery(
    runId: string
  ): RunCancellationDelivery | undefined {
    const row = this.database.prepare(`
      SELECT device_id, state, send_count, last_sent_at
      FROM run_deliveries WHERE run_id = ?
    `).get(runId) as RunCancellationDeliveryRow | undefined;
    return row && {
      deviceId: row.device_id,
      state: row.state,
      sendCount: row.send_count,
      lastSentAt: row.last_sent_at
    };
  }

  public requestCancellation(input: {
    runId: string;
    messageId: string;
    requestedByMemberId: string;
    reason: string;
    now: string;
    ackDeadlineAt: string;
  }): RunCancellationRequest {
    return this.transactions.immediate(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new Error(`Run not found: ${input.runId}`);
      const existing = this.getCancellationIntent(run.runId);
      if (terminalStates.has(run.state)) {
        if (existing?.state === "pending") {
          this.resolveCancellationIntent(
            run.runId,
            run.state as RunCancellationTerminalStatus,
            input.now
          );
        }
        const resolved = this.getCancellationIntent(run.runId);
        return resolved
          ? { run, intent: resolved, created: false }
          : { run, created: false };
      }
      if (run.state === "input_required") {
        const canceled = this.applyRuntimeEvent(run.runId, {
          type: "status",
          sequence: run.lastSequence + 1,
          status: "canceled"
        }, input.now).run;
        return { run: canceled, created: false };
      }
      if (existing) {
        return { run, intent: existing, created: false };
      }
      const delivery = this.getCancellationDelivery(run.runId);
      // Delivery send markers are written after the socket write, so a durable
      // row with send_count=0 is still ambiguous across a process crash.
      const queuedMayHaveReachedBridge = run.state === "queued" &&
        delivery !== undefined;
      if (run.state === "queued" && !queuedMayHaveReachedBridge) {
        const canceled = this.applyRuntimeEvent(run.runId, {
          type: "status",
          sequence: run.lastSequence + 1,
          status: "canceled"
        }, input.now).run;
        return { run: canceled, created: false };
      }
      if (
        run.state !== "queued" &&
        run.state !== "delivered" &&
        run.state !== "working"
      ) {
        throw new Error(`Run cannot be canceled from state: ${run.state}`);
      }
      if (!delivery) {
        throw new Error("Remote Run cancellation requires its frozen delivery Device");
      }
      this.database.prepare(`
        INSERT INTO run_cancellation_intents (
          run_id, message_id, agent_id, device_id, requested_by_member_id,
          reason, state, created_at, last_sent_at, send_count,
          ack_deadline_at, resolved_at, terminal_status
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 0, ?, NULL, NULL)
      `).run(
        run.runId,
        input.messageId,
        run.targetAgentId,
        delivery.deviceId,
        input.requestedByMemberId,
        input.reason,
        input.now,
        input.ackDeadlineAt
      );
      this.scheduleCommittedChange(run.roomId, "run");
      return {
        run,
        intent: this.getCancellationIntent(run.runId)!,
        created: true
      };
    });
  }

  public listDispatchableCancellationIntents(input: {
    now: string;
    sentBefore: string;
    limit: number;
    deviceId?: string;
  }): RunCancellationIntent[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
    const rows = this.database.prepare(`
      SELECT * FROM run_cancellation_intents
      WHERE state = 'pending'
        AND ack_deadline_at > @now
        AND (last_sent_at IS NULL OR last_sent_at <= @sentBefore)
        AND (@deviceId IS NULL OR device_id = @deviceId)
      ORDER BY created_at, run_id
      LIMIT @limit
    `).all({
      now: input.now,
      sentBefore: input.sentBefore,
      deviceId: input.deviceId ?? null,
      limit
    }) as RunCancellationIntentRow[];
    return rows.map(mapCancellationIntent);
  }

  public markCancellationIntentSent(
    runId: string,
    messageId: string,
    sentAt: string
  ): RunCancellationIntent | undefined {
    this.database.prepare(`
      UPDATE run_cancellation_intents
      SET send_count = send_count + 1, last_sent_at = ?
      WHERE run_id = ? AND message_id = ? AND state = 'pending'
    `).run(sentAt, runId, messageId);
    return this.getCancellationIntent(runId);
  }

  public expireCancellationIntents(
    now: string,
    limit: number
  ): RunRecord[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`
      SELECT run_id FROM run_cancellation_intents
      WHERE state = 'pending' AND ack_deadline_at <= ?
      ORDER BY ack_deadline_at, created_at, run_id
      LIMIT ?
    `).all(now, boundedLimit) as Array<{ run_id: string }>;
    const expired: RunRecord[] = [];
    for (const { run_id: runId } of rows) {
      expired.push(this.transactions.immediate(() => {
        const intent = this.getCancellationIntent(runId);
        const run = this.getRun(runId);
        if (!intent || !run) throw new Error(`Run not found: ${runId}`);
        if (intent.state !== "pending") return run;
        if (terminalStates.has(run.state)) {
          this.resolveCancellationIntent(
            run.runId,
            run.state as RunCancellationTerminalStatus,
            now
          );
          return run;
        }
        return this.applyRuntimeEvent(run.runId, {
          type: "status",
          sequence: run.lastSequence + 1,
          status: "outcome_unknown",
          error: {
            code: "RUN_CANCEL_ACK_TIMEOUT",
            message:
              "The managed Runtime did not confirm a terminal outcome before the cancellation deadline.",
            retryable: false
          }
        }, now).run;
      }));
    }
    return expired;
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

  public listDeviceRevocationRuns(deviceId: string): DeviceRevocationRun[] {
    const rows = this.database.prepare(`
      SELECT r.*, CASE
        WHEN d.state = 'accepted' OR r.state != 'queued' THEN 1
        ELSE 0
      END AS accepted_by_bridge
      FROM runs r
      JOIN agents a ON a.agent_id = r.target_agent_id
      LEFT JOIN run_deliveries d ON d.run_id = r.run_id
      WHERE a.device_id = ?
        AND r.state NOT IN (
          'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
        )
      ORDER BY r.created_at, r.run_id
    `).all(deviceId) as Array<RunRow & { accepted_by_bridge: 0 | 1 }>;
    return rows.map((row) => ({
      run: mapRun(row),
      acceptedByBridge: row.accepted_by_bridge === 1
    }));
  }

  public listRevokedDeviceIdsWithActiveRuns(): string[] {
    const rows = this.database.prepare(`
      SELECT DISTINCT d.device_id
      FROM devices d
      JOIN agents a ON a.device_id = d.device_id
      JOIN runs r ON r.target_agent_id = a.agent_id
      WHERE d.status = 'revoked'
        AND r.state NOT IN (
          'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
        )
      ORDER BY d.device_id
    `).all() as Array<{ device_id: string }>;
    return rows.map((row) => row.device_id);
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
    event: Exclude<RuntimeEvent, { type: "reply" }>,
    now: string
  ): AppliedRunEvent {
    return this.applyRuntimeEvent(runId, event, now);
  }

  private applyRuntimeEvent(
    runId: string,
    event: RuntimeEvent,
    now: string
  ): AppliedRunEvent {
    return this.transactions.immediate(() => {
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
      if (terminalStates.has(nextState)) {
        this.resolveCancellationIntent(
          runId,
          nextState as RunCancellationTerminalStatus,
          now
        );
      }
      const updated = this.getRun(runId);
      if (!updated) {
        throw new Error(`Run disappeared after event: ${runId}`);
      }
      this.scheduleCommittedChange(
        current.roomId,
        event.type === "status" && event.clarification ? "room" : "run"
      );
      return { applied: true, run: updated };
    });
  }

  public applyReply(
    runId: string,
    event: Extract<RuntimeEvent, { type: "reply" }>,
    now: string
  ): AppliedRunEvent {
    return this.transactions.immediate(() => {
      const applied = this.applyRuntimeEvent(runId, event, now);
      if (!applied.applied) return applied;
      const messageId = this.insertReplyMessage(applied.run, event.content, now);
      this.insertReplyMessageProjection(
        runId,
        event.sequence,
        messageId,
        now
      );
      this.scheduleCommittedChange(applied.run.roomId, "room");
      return applied;
    });
  }

  public applyReplyAndTerminal(
    runId: string,
    replyEvent: Extract<RuntimeEvent, { type: "reply" }>,
    terminalEvent: Extract<RuntimeEvent, { type: "status" }> & {
      status: "completed";
    },
    now: string
  ): AppliedRunEvent {
    if (terminalEvent.sequence !== replyEvent.sequence + 1) {
      throw new Error("Runtime reply and completion sequences must be contiguous");
    }
    return this.transactions.immediate(() => {
      const reply = this.applyReply(runId, replyEvent, now);
      if (!reply.applied) return reply;
      const terminal = this.applyRuntimeEvent(runId, terminalEvent, now);
      if (!terminal.applied) {
        throw new Error("Runtime completion was not applied with its reply");
      }
      return terminal;
    });
  }

  public listUnprojectedReplyEvents(): Array<{
    runId: string;
    replySequence: number;
  }> {
    const rows = this.database.prepare(`
      SELECT event.run_id, event.sequence AS reply_sequence
      FROM run_events event
      LEFT JOIN run_reply_message_projections projection
        ON projection.run_id = event.run_id
        AND projection.reply_sequence = event.sequence
      LEFT JOIN run_reply_projection_failures failure
        ON failure.run_id = event.run_id
        AND failure.reply_sequence = event.sequence
      WHERE event.event_type = 'reply'
        AND projection.run_id IS NULL
        AND failure.run_id IS NULL
      ORDER BY event.created_at, event.run_id, event.sequence
    `).all() as Array<{ run_id: string; reply_sequence: number }>;
    return rows.map((row) => ({
      runId: row.run_id,
      replySequence: row.reply_sequence
    }));
  }

  public getReplyMessageProjection(
    runId: string,
    replySequence: number
  ): RunReplyMessageProjection | undefined {
    const row = this.database.prepare(`
      SELECT * FROM run_reply_message_projections
      WHERE run_id = ? AND reply_sequence = ?
    `).get(runId, replySequence) as
      | RunReplyMessageProjectionRow
      | undefined;
    return row && mapReplyMessageProjection(row);
  }

  public getReplyProjectionFailure(
    runId: string,
    replySequence: number
  ): RunReplyProjectionFailure | undefined {
    const row = this.database.prepare(`
      SELECT * FROM run_reply_projection_failures
      WHERE run_id = ? AND reply_sequence = ?
    `).get(runId, replySequence) as
      | RunReplyProjectionFailureRow
      | undefined;
    return row && mapReplyProjectionFailure(row);
  }

  public reconcileReplyMessageProjection(
    runId: string,
    replySequence: number,
    now: string
  ): RunReplyProjectionReconciliation {
    return this.transactions.immediate(() => {
      const existing = this.getReplyMessageProjection(runId, replySequence);
      if (existing) {
        return {
          state: "projected" as const,
          messageCreated: false,
          projection: existing
        };
      }
      const existingFailure = this.getReplyProjectionFailure(
        runId,
        replySequence
      );
      if (existingFailure) {
        return {
          state: "unreconciled" as const,
          failure: existingFailure
        };
      }

      const source = this.database.prepare(`
        SELECT
          event.run_id,
          event.sequence AS reply_sequence,
          event.trace_id AS event_trace_id,
          event.content,
          event.created_at AS event_created_at,
          run.trace_id AS run_trace_id,
          run.room_id,
          run.task_id,
          run.trigger_message_id,
          run.target_agent_id
        FROM run_events event
        JOIN runs run ON run.run_id = event.run_id
        WHERE event.run_id = ?
          AND event.sequence = ?
          AND event.event_type = 'reply'
      `).get(runId, replySequence) as ReplyProjectionSourceRow | undefined;
      if (!source) {
        throw new Error(
          `Run reply event not found: ${runId}/${replySequence}`
        );
      }
      if (
        source.event_trace_id !== source.run_trace_id ||
        source.content === null ||
        source.content.length < 1 ||
        exceedsUnicodeCodePointLimit(source.content, 20_000) ||
        Number.isNaN(Date.parse(source.event_created_at))
      ) {
        return {
          state: "unreconciled" as const,
          failure: this.insertReplyProjectionFailure(
            runId,
            replySequence,
            "INVALID_REPLY_EVENT",
            0,
            now
          )
        };
      }

      const exactMatches = this.findReplyMessageCandidates(source, true);
      if (exactMatches.length > 1) {
        return {
          state: "unreconciled" as const,
          failure: this.insertReplyProjectionFailure(
            runId,
            replySequence,
            "MULTIPLE_EXACT_MESSAGES",
            exactMatches.length,
            now
          )
        };
      }
      const exactMatch = exactMatches[0];
      if (exactMatch?.projected_run_id) {
        return {
          state: "unreconciled" as const,
          failure: this.insertReplyProjectionFailure(
            runId,
            replySequence,
            "MESSAGE_ALREADY_PROJECTED",
            1,
            now
          )
        };
      }
      if (exactMatch) {
        return {
          state: "projected" as const,
          messageCreated: false,
          projection: this.insertReplyMessageProjection(
            runId,
            replySequence,
            exactMatch.message_id,
            now
          )
        };
      }

      const timestampMismatches = this.findReplyMessageCandidates(source, false);
      if (timestampMismatches.length > 0) {
        return {
          state: "unreconciled" as const,
          failure: this.insertReplyProjectionFailure(
            runId,
            replySequence,
            "TIMESTAMP_MISMATCH",
            timestampMismatches.length,
            now
          )
        };
      }

      const run = this.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      const messageId = this.insertReplyMessage(
        run,
        source.content,
        source.event_created_at
      );
      this.scheduleCommittedChange(run.roomId, "room");
      return {
        state: "projected" as const,
        messageCreated: true,
        projection: this.insertReplyMessageProjection(
          runId,
          replySequence,
          messageId,
          now
        )
      };
    });
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

  private insertReplyMessage(
    run: RunRecord,
    content: string,
    createdAt: string
  ): string {
    const messageId = createOpaqueId("msg");
    const messageSequence = this.database.prepare(`
      UPDATE rooms
      SET next_message_sequence = next_message_sequence + 1
      WHERE room_id = ?
      RETURNING next_message_sequence AS sequence
    `).get(run.roomId) as { sequence: number } | undefined;
    if (!messageSequence) {
      throw new Error(`Run Room not found: ${run.roomId}`);
    }
    this.database.prepare(`
      INSERT INTO messages (
        message_id, trace_id, room_id, task_id, sequence, sender_type,
        sender_id, content, parent_message_id, client_message_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?, ?, NULL, ?)
    `).run(
      messageId,
      run.traceId,
      run.roomId,
      run.taskId,
      messageSequence.sequence,
      run.targetAgentId,
      content,
      run.triggerMessageId,
      createdAt
    );
    return messageId;
  }

  private insertReplyMessageProjection(
    runId: string,
    replySequence: number,
    messageId: string,
    projectedAt: string
  ): RunReplyMessageProjection {
    this.database.prepare(`
      INSERT INTO run_reply_message_projections (
        run_id, reply_sequence, message_id, projected_at
      ) VALUES (?, ?, ?, ?)
    `).run(runId, replySequence, messageId, projectedAt);
    return this.getReplyMessageProjection(runId, replySequence)!;
  }

  private insertReplyProjectionFailure(
    runId: string,
    replySequence: number,
    errorCode: RunReplyProjectionFailureCode,
    candidateCount: number,
    recordedAt: string
  ): RunReplyProjectionFailure {
    this.database.prepare(`
      INSERT INTO run_reply_projection_failures (
        run_id, reply_sequence, error_code, candidate_count, recorded_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      runId,
      replySequence,
      errorCode,
      candidateCount,
      recordedAt
    );
    return this.getReplyProjectionFailure(runId, replySequence)!;
  }

  private findReplyMessageCandidates(
    source: ReplyProjectionSourceRow,
    requireExactTimestamp: boolean
  ): Array<{
    message_id: string;
    projected_run_id: string | null;
    projected_reply_sequence: number | null;
  }> {
    const timestampClause = requireExactTimestamp
      ? "AND message.created_at = @eventCreatedAt"
      : "AND message.created_at <> @eventCreatedAt";
    return this.database.prepare(`
      SELECT
        message.message_id,
        projection.run_id AS projected_run_id,
        projection.reply_sequence AS projected_reply_sequence
      FROM messages message
      LEFT JOIN run_reply_message_projections projection
        ON projection.message_id = message.message_id
      WHERE message.trace_id = @traceId
        AND message.room_id = @roomId
        AND message.task_id IS @taskId
        AND message.sender_type = 'agent'
        AND message.sender_id = @senderId
        AND message.parent_message_id = @parentMessageId
        AND message.content = @content
        ${timestampClause}
      ORDER BY message.sequence, message.message_id
    `).all({
      traceId: source.run_trace_id,
      roomId: source.room_id,
      taskId: source.task_id,
      senderId: source.target_agent_id,
      parentMessageId: source.trigger_message_id,
      content: source.content,
      eventCreatedAt: source.event_created_at
    }) as Array<{
      message_id: string;
      projected_run_id: string | null;
      projected_reply_sequence: number | null;
    }>;
  }

  private scheduleCommittedChange(
    roomId: string,
    kind: CommittedRunChange["kind"]
  ): void {
    if (!this.onCommitted) return;
    let teamId = this.roomTeams.get(roomId);
    if (!teamId) {
      const room = this.database.prepare(`
        SELECT team_id FROM rooms WHERE room_id = ?
      `).get(roomId) as { team_id: string } | undefined;
      if (!room) throw new Error(`Run Room not found: ${roomId}`);
      teamId = room.team_id;
      this.roomTeams.set(roomId, teamId);
    }
    const change = { kind, roomId, teamId };
    this.transactions.afterCommit(
      () => this.onCommitted?.(change),
      {
        key: `team-room-change:${teamId}:${roomId}`,
        priority: kind === "room" ? 2 : 1
      }
    );
  }

  private resolveCancellationIntent(
    runId: string,
    terminalStatus: RunCancellationTerminalStatus,
    resolvedAt: string
  ): void {
    this.database.prepare(`
      UPDATE run_cancellation_intents
      SET state = 'resolved', resolved_at = ?, terminal_status = ?
      WHERE run_id = ? AND state = 'pending'
    `).run(resolvedAt, terminalStatus, runId);
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
