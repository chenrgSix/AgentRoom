import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "../task/task-repository.js";
import type {
  RunAmbiguityAcknowledgement,
  RunContextManifest,
  RunRecord,
  RunRepository
} from "./run-repository.js";

export const defaultRunDurationMilliseconds = 20 * 60 * 1000;

export function isRunTaskRunnable(task: AgentTaskRecord): boolean {
  return ["ready", "active", "review"].includes(task.lifecycleState) &&
    task.schedulingState === "enabled" &&
    task.budgetUsage.runAttempts < task.budgetPolicy.maxRunAttempts &&
    task.budgetUsage.executionDurationSeconds <
      task.budgetPolicy.maxExecutionDurationSeconds;
}

export function runDeadlineAt(createdAt: string): string {
  return new Date(
    Date.parse(createdAt) + defaultRunDurationMilliseconds
  ).toISOString();
}

export class RunService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly auth: AuthService,
    private readonly tasks: AgentTaskRepository
  ) {}

  public createRunsForMessage(
    principal: WebPrincipal,
    messageId: string,
    now: string
  ): RunRecord[] {
    return this.createRunsForMessageResult(principal, messageId, now).runs;
  }

  public createRunsForMessageResult(
    principal: WebPrincipal,
    messageId: string,
    now: string
  ): { created: boolean; runs: RunRecord[] } {
    const message = this.core.getMessage(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }
    const member = this.auth.requireRoomMember(principal, message.roomId);
    if (message.senderType !== "member" || message.senderId !== member.memberId) {
      throw new Error("Only the sending Member can route a Message");
    }
    const existing = this.runs.findByTrigger(messageId);
    if (existing.length > 0 || message.mentions.length === 0) {
      return { created: false, runs: existing };
    }
    const task = this.tasks.get(message.taskId);
    if (
      !task || task.roomId !== message.roomId ||
      !isRunTaskRunnable(task)
    ) {
      throw new Error("Run Task must be runnable in the Message Room");
    }
    const deadlineAt = runDeadlineAt(now);
    this.runs.createRuns(message.mentions.map((mention) => ({
      runId: createOpaqueId("run"),
      traceId: message.traceId,
      roomId: message.roomId,
      taskId: task.taskId,
      triggerMessageId: message.messageId,
      requesterMemberId: member.memberId,
      targetAgentId: mention.targetAgentId,
      parentRunId: null,
      instruction: message.content,
      state: "queued",
      lastSequence: 0,
      deadlineAt,
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    })));
    return { created: true, runs: this.runs.findByTrigger(messageId) };
  }

  public listRoomRuns(
    principal: WebPrincipal,
    roomId: string,
    now?: string
  ): RunRecord[] {
    this.auth.requireRoomMember(principal, roomId);
    if (now) {
      this.runs.expireQueued(roomId, now);
    }
    return this.runs.listRoomRuns(roomId);
  }

  public get(
    principal: WebPrincipal,
    runId: string
  ): RunRecord {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    this.auth.requireRoomMember(principal, run.roomId);
    return run;
  }

  public listTaskRuns(
    principal: WebPrincipal,
    taskId: string
  ): RunRecord[] {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.auth.requireRoomMember(principal, task.roomId);
    return this.runs.listTaskRuns(taskId);
  }

  public getContextManifest(
    principal: WebPrincipal,
    runId: string
  ): RunContextManifest {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    this.auth.requireRoomMember(principal, run.roomId);
    const manifest = this.runs.getContextManifest(runId);
    if (!manifest) throw new Error("Run Context Manifest was not recorded");
    return manifest;
  }

  public getAmbiguityAcknowledgement(
    principal: WebPrincipal,
    runId: string
  ): RunAmbiguityAcknowledgement | null {
    this.get(principal, runId);
    return this.runs.getAmbiguityAcknowledgement(runId) ?? null;
  }

  public acknowledgeAmbiguity(
    principal: WebPrincipal,
    runId: string,
    input: {
      operationId: string;
      expectedTaskRevision: number;
      reason: string;
    },
    now: string
  ): RunAmbiguityAcknowledgement {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const task = this.tasks.get(run.taskId);
    if (!task) throw new Error(`Task not found: ${run.taskId}`);
    const member = this.auth.requireRoomMember(principal, run.roomId);
    if (member.role !== "owner" && member.memberId !== task.ownerMemberId) {
      throw new Error("Only the Task Owner or Team Owner may acknowledge ambiguity");
    }
    const operationId = input.operationId.trim();
    const reason = input.reason.trim();
    if (!/^op_[A-Za-z0-9_-]{8,128}$/u.test(operationId)) {
      throw new Error("Ambiguity acknowledgement operation ID is invalid");
    }
    if (!Number.isSafeInteger(input.expectedTaskRevision) ||
      input.expectedTaskRevision < 1) {
      throw new Error("Expected Task revision must be positive");
    }
    if (reason.length < 1 || input.reason.length > 1000) {
      throw new Error("Ambiguity acknowledgement reason is invalid");
    }
    return this.runs.acknowledgeAmbiguity({
      runId,
      operationId,
      expectedTaskRevision: input.expectedTaskRevision,
      memberId: member.memberId,
      reason,
      now
    });
  }

  public retry(
    principal: WebPrincipal,
    runId: string,
    input: { operationId: string; expectedTaskRevision: number },
    now: string
  ): RunRecord {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const task = this.tasks.get(run.taskId);
    if (!task) throw new Error(`Task not found: ${run.taskId}`);
    const member = this.auth.requireRoomMember(principal, run.roomId);
    if (member.role !== "owner" && member.memberId !== task.ownerMemberId) {
      throw new Error("Only the Task Owner or Team Owner may retry a Run");
    }
    const operationId = input.operationId.trim();
    if (!/^op_[A-Za-z0-9_-]{8,128}$/u.test(operationId)) {
      throw new Error("Run retry operation ID is invalid");
    }
    if (!Number.isSafeInteger(input.expectedTaskRevision) ||
      input.expectedTaskRevision < 1) {
      throw new Error("Expected Task revision must be positive");
    }
    return this.runs.createRetry({
      parentRunId: runId,
      operationId,
      expectedTaskRevision: input.expectedTaskRevision,
      memberId: member.memberId,
      now,
      deadlineAt: runDeadlineAt(now)
    });
  }
}
