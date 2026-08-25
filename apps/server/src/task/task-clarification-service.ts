import type Database from "better-sqlite3";

import type { CoreRepository, MessageRecord } from "../data/core-repository.js";
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
    private readonly database: Database.Database,
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
    taskId: string
  ): TaskClarificationRecord[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.auth.requireRoomMember(principal, task.roomId);
    return this.clarifications.listForTask(taskId);
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

    return this.database.transaction(() => {
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
      this.core.updateAgentPresence(agent.agentId, "ready", now);
      return { clarification: resumed, message: persisted.message, run: continuation };
    }).immediate();
  }
}
