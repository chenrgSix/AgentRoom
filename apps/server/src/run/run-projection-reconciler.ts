import type Database from "better-sqlite3";

import type { CoreRepository, MessageRecord } from
  "../data/core-repository.js";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { AgentTaskRecord, AgentTaskRepository } from
  "../task/task-repository.js";
import type {
  RunRecord,
  RunReplyMessageProjection,
  RunReplyProjectionFailure,
  RunRepository
} from "./run-repository.js";
import { isRunTaskRunnable, runDeadlineAt } from "./run-service.js";

export type MemberMessageRunRecoveryFailureCode =
  | "INVALID_MESSAGE_TIME"
  | "MESSAGE_SCOPE_UNAVAILABLE"
  | "TASK_SCOPE_UNAVAILABLE"
  | "TASK_NOT_RUNNABLE"
  | "MENTION_TARGET_UNAVAILABLE";

export interface MemberMessageRunRecoveryFailure {
  messageId: string;
  errorCode: MemberMessageRunRecoveryFailureCode;
}

export interface RunProjectionReconciliationResult {
  queuedRuns: RunRecord[];
  expiredRuns: RunRecord[];
  memberMessageFailures: MemberMessageRunRecoveryFailure[];
  replyProjections: RunReplyMessageProjection[];
  replyProjectionFailures: RunReplyProjectionFailure[];
}

type MemberMessageRecovery =
  | { state: "skipped" }
  | { state: "queued" | "expired"; runs: RunRecord[] }
  | { state: "unreconciled"; failure: MemberMessageRunRecoveryFailure };

export class RunProjectionReconciler {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions: SqliteTransactionBoundary,
    private readonly core: CoreRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly runs: RunRepository
  ) {}

  public reconcile(now: string): RunProjectionReconciliationResult {
    const nowMilliseconds = Date.parse(now);
    if (Number.isNaN(nowMilliseconds)) {
      throw new Error("Run projection reconciliation time is invalid");
    }
    const result: RunProjectionReconciliationResult = {
      queuedRuns: [],
      expiredRuns: [],
      memberMessageFailures: [],
      replyProjections: [],
      replyProjectionFailures: []
    };

    for (const messageId of this.listUnroutedMemberMessageIds()) {
      const recovery = this.transactions.immediate(() =>
        this.reconcileMemberMessage(messageId, nowMilliseconds)
      );
      if (recovery.state === "queued") {
        result.queuedRuns.push(...recovery.runs);
      } else if (recovery.state === "expired") {
        result.expiredRuns.push(...recovery.runs);
      } else if (recovery.state === "unreconciled") {
        result.memberMessageFailures.push(recovery.failure);
      }
    }

    for (const reply of this.runs.listUnprojectedReplyEvents()) {
      const reconciliation = this.runs.reconcileReplyMessageProjection(
        reply.runId,
        reply.replySequence,
        now
      );
      if (reconciliation.state === "projected") {
        result.replyProjections.push(reconciliation.projection);
      } else {
        result.replyProjectionFailures.push(reconciliation.failure);
      }
    }
    return result;
  }

  private listUnroutedMemberMessageIds(): string[] {
    const rows = this.database.prepare(`
      SELECT message.message_id
      FROM messages message
      WHERE message.sender_type = 'member'
        AND EXISTS (
          SELECT 1 FROM message_mentions mention
          WHERE mention.message_id = message.message_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM runs run
          WHERE run.trigger_message_id = message.message_id
        )
      ORDER BY message.created_at, message.room_id, message.sequence,
        message.message_id
    `).all() as Array<{ message_id: string }>;
    return rows.map((row) => row.message_id);
  }

  private reconcileMemberMessage(
    messageId: string,
    nowMilliseconds: number
  ): MemberMessageRecovery {
    if (this.runs.findByTrigger(messageId).length > 0) {
      return { state: "skipped" };
    }
    const message = this.core.getMessage(messageId);
    if (!message || message.senderType !== "member" ||
      message.mentions.length === 0) {
      return { state: "skipped" };
    }
    const createdMilliseconds = Date.parse(message.createdAt);
    if (Number.isNaN(createdMilliseconds) ||
      createdMilliseconds > nowMilliseconds) {
      return this.memberFailure(messageId, "INVALID_MESSAGE_TIME");
    }
    const deadlineAt = runDeadlineAt(message.createdAt);
    const deadlineMilliseconds = Date.parse(deadlineAt);
    const expired = deadlineMilliseconds <= nowMilliseconds;
    const task = this.tasks.get(message.taskId);
    const scopeFailure = this.validateDurableMessageScope(message, task);
    if (scopeFailure) return this.memberFailure(messageId, scopeFailure);
    if (!expired) {
      const runnableFailure = this.validateCurrentRouting(message, task!);
      if (runnableFailure) return this.memberFailure(messageId, runnableFailure);
    }

    const createdRuns = this.runs.createRuns(message.mentions.map((mention) => ({
      runId: createOpaqueId("run"),
      traceId: message.traceId,
      roomId: message.roomId,
      taskId: message.taskId,
      triggerMessageId: message.messageId,
      requesterMemberId: message.senderId,
      targetAgentId: mention.targetAgentId,
      parentRunId: null,
      instruction: message.content,
      state: "queued",
      lastSequence: 0,
      deadlineAt,
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      terminalAt: null
    })));
    if (!expired) return { state: "queued", runs: createdRuns };

    return {
      state: "expired",
      runs: createdRuns.map((run) => this.runs.applyEvent(run.runId, {
        type: "status",
        sequence: 1,
        status: "expired",
        error: {
          code: "RUN_EXPIRED",
          message: "Run expired before startup could restore its missing projection.",
          retryable: false
        }
      }, deadlineAt).run)
    };
  }

  private validateDurableMessageScope(
    message: MessageRecord,
    task: AgentTaskRecord | undefined
  ): MemberMessageRunRecoveryFailureCode | undefined {
    const room = this.core.getRoom(message.roomId);
    const member = this.core.getMember(message.senderId);
    if (!room || !member || member.teamId !== room.teamId) {
      return "MESSAGE_SCOPE_UNAVAILABLE";
    }
    if (!task || task.roomId !== message.roomId || task.teamId !== room.teamId) {
      return "TASK_SCOPE_UNAVAILABLE";
    }
    if (message.mentions.length > 5 || message.mentions.some((mention) => {
      const agent = this.core.getAgent(mention.targetAgentId);
      return !agent || agent.teamId !== room.teamId;
    })) {
      return "MENTION_TARGET_UNAVAILABLE";
    }
    return undefined;
  }

  private validateCurrentRouting(
    message: MessageRecord,
    task: AgentTaskRecord
  ): MemberMessageRunRecoveryFailureCode | undefined {
    if (
      !this.core.isRoomMember(message.roomId, message.senderId) ||
      !isRunTaskRunnable(task)
    ) {
      return "TASK_NOT_RUNNABLE";
    }
    if (message.mentions.some((mention) => {
      const agent = this.core.getAgent(mention.targetAgentId);
      return !agent || !agent.enabled ||
        !this.core.isRoomAgent(message.roomId, mention.targetAgentId) ||
        (!task.isDefault && !task.assignments.some(
          ({ agentId }) => agentId === mention.targetAgentId
        ));
    })) {
      return "MENTION_TARGET_UNAVAILABLE";
    }
    return undefined;
  }

  private memberFailure(
    messageId: string,
    errorCode: MemberMessageRunRecoveryFailureCode
  ): MemberMessageRecovery {
    return {
      state: "unreconciled",
      failure: { messageId, errorCode }
    };
  }
}
