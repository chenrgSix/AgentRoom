import type { CoreRepository, MessageRecord } from "../data/core-repository.js";
import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";
import type { RunRecord, RunRepository } from "../run/run-repository.js";
import type { RunService } from "../run/run-service.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import type { MessageService } from "../team-room/message-service.js";
import {
  type ClarificationRepository,
  type TaskClarificationRecord
} from "./clarification-repository.js";
import type { AgentTaskRepository } from "./task-repository.js";

export interface ResumedTaskClarification {
  clarification: TaskClarificationRecord;
  message: MessageRecord;
  run: RunRecord;
}

export class TaskClarificationService {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly clarifications: ClarificationRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly runService: RunService,
    private readonly messages: MessageService,
    private readonly auth: AuthService
  ) {}

  public list(
    principal: WebPrincipal,
    taskId: string,
    now?: string
  ): TaskClarificationRecord[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.auth.requireRoomMember(principal, task.roomId);
    if (now) this.reconcile(now, taskId);
    return this.clarifications.listForTask(taskId);
  }

  public reconcile(now: string, taskId?: string): TaskClarificationRecord[] {
    return this.transactions.immediate(() => {
      const reconciled: TaskClarificationRecord[] = [];
      for (const clarification of this.clarifications.listWaiting(taskId)) {
        const requestingRun = this.runs.getRun(clarification.requestingRunId);
        if (!requestingRun) {
          reconciled.push(this.clarifications.cancelWaiting({
            clarificationId: clarification.clarificationId,
            reason: "orphaned",
            now
          }));
          continue;
        }
        if (requestingRun.state !== "input_required") {
          const reason = requestingRun.state === "canceled"
            ? "run_canceled"
            : requestingRun.state === "expired"
              ? "run_expired"
              : "run_terminal";
          reconciled.push(this.clarifications.cancelWaiting({
            clarificationId: clarification.clarificationId,
            reason,
            now
          }));
          continue;
        }
        const task = this.tasks.get(clarification.taskId);
        if (!task || task.state === "completed" || task.state === "canceled") {
          reconciled.push(this.clarifications.cancelWaiting({
            clarificationId: clarification.clarificationId,
            reason: task ? "task_terminal" : "orphaned",
            now
          }));
          this.closeOrphanedRun(
            requestingRun,
            "TASK_CLARIFICATION_TASK_CLOSED",
            now
          );
          continue;
        }
        const agent = this.core.getAgent(clarification.targetAgentId);
        if (
          !agent || !agent.enabled ||
          !this.core.isRoomAgent(clarification.roomId, clarification.targetAgentId)
        ) {
          reconciled.push(this.clarifications.cancelWaiting({
            clarificationId: clarification.clarificationId,
            reason: "agent_unavailable",
            now
          }));
          this.closeOrphanedRun(
            requestingRun,
            "TASK_CLARIFICATION_AGENT_UNAVAILABLE",
            now
          );
          continue;
        }
        const question = this.core.getMessage(clarification.questionMessageId);
        if (
          !question || question.roomId !== clarification.roomId ||
          question.taskId !== clarification.taskId ||
          question.senderType !== "agent" ||
          question.senderId !== clarification.targetAgentId
        ) {
          reconciled.push(this.clarifications.cancelWaiting({
            clarificationId: clarification.clarificationId,
            reason: "orphaned",
            now
          }));
          this.closeOrphanedRun(
            requestingRun,
            "TASK_CLARIFICATION_ORPHANED",
            now
          );
          continue;
        }
        if (Date.parse(requestingRun.deadlineAt) <= Date.parse(now)) {
          this.runs.applyEvent(requestingRun.runId, {
            type: "status",
            sequence: requestingRun.lastSequence + 1,
            status: "expired",
            error: {
              code: "TASK_CLARIFICATION_EXPIRED",
              message: "Task clarification expired before an answer was accepted.",
              retryable: false
            }
          }, now);
          const expired = this.clarifications.get(clarification.clarificationId);
          if (expired) reconciled.push(expired);
        }
      }
      return reconciled;
    });
  }

  public answer(
    principal: WebPrincipal,
    clarificationId: string,
    answer: string,
    now: string
  ): ResumedTaskClarification {
    const normalizedAnswer = answer.trim();
    if (normalizedAnswer.length === 0 || answer.length > 20_000) {
      throw new Error("Clarification answer must contain 1 to 20000 characters");
    }
    const initial = this.clarifications.get(clarificationId);
    if (!initial) {
      throw new Error(`Task clarification not found: ${clarificationId}`);
    }
    this.auth.requireRoomMember(principal, initial.roomId);
    this.reconcile(now, initial.taskId);

    return this.transactions.immediate(() => {
      const clarification = this.clarifications.get(clarificationId);
      if (!clarification) {
        throw new Error(`Task clarification not found: ${clarificationId}`);
      }
      if (clarification.state === "resumed") {
        const message = clarification.answerMessageId
          ? this.core.getMessage(clarification.answerMessageId)
          : undefined;
        const run = clarification.continuationRunId
          ? this.runs.getRun(clarification.continuationRunId)
          : undefined;
        if (!message || !run) {
          throw new Error("Resumed Task clarification is incomplete");
        }
        return { clarification, message, run };
      }
      if (clarification.state !== "waiting") {
        throw new Error(`Task clarification is ${clarification.state}`);
      }
      const requestingRun = this.runs.getRun(clarification.requestingRunId);
      const agent = this.core.getAgent(clarification.targetAgentId);
      if (
        !requestingRun || requestingRun.state !== "input_required" ||
        requestingRun.taskId !== clarification.taskId ||
        !agent || !agent.enabled ||
        !this.core.isRoomAgent(clarification.roomId, agent.agentId)
      ) {
        throw new Error("Task clarification can no longer be resumed");
      }
      const member = this.auth.requireRoomMember(principal, clarification.roomId);
      const persisted = this.messages.createMemberMessageResult(principal, {
        roomId: clarification.roomId,
        taskId: clarification.taskId,
        content: normalizedAnswer,
        mentions: [{
          targetType: "agent",
          targetAgentId: agent.agentId,
          displayLabel: `${agent.name} / ${agent.role}`
        }],
        parentMessageId: clarification.questionMessageId,
        clientMessageId: `client_clarification_${clarification.clarificationId}`,
        now
      });
      const continuation = this.runService.createRunsForMessage(
        principal,
        persisted.message.messageId,
        now
      )[0];
      if (!continuation || continuation.targetAgentId !== agent.agentId) {
        throw new Error("Task clarification did not create its continuation Run");
      }
      const resumed = this.clarifications.markResumed({
        clarificationId: clarification.clarificationId,
        answerMessageId: persisted.message.messageId,
        answeredByMemberId: member.memberId,
        continuationRunId: continuation.runId,
        now
      });
      this.runs.applyEvent(requestingRun.runId, {
        type: "status",
        sequence: requestingRun.lastSequence + 1,
        status: "outcome_unknown",
        error: {
          code: "TASK_CLARIFICATION_CONTINUED",
          message: "Run suspended for Task clarification and continued in a new bounded Run.",
          retryable: false
        }
      }, now);
      this.core.updateAgentPresence(agent.agentId, "ready", now);
      return { clarification: resumed, message: persisted.message, run: continuation };
    });
  }

  private closeOrphanedRun(
    run: RunRecord,
    code: string,
    now: string
  ): void {
    this.runs.applyEvent(run.runId, {
      type: "status",
      sequence: run.lastSequence + 1,
      status: "outcome_unknown",
      error: {
        code,
        message: "Task clarification can no longer be resumed safely.",
        retryable: false
      }
    }, now);
  }
}
