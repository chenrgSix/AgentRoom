import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import {
  type AgentTaskRecord,
  type AgentTaskRepository,
  type AgentTaskState
} from "./task-repository.js";

const taskStates = new Set<AgentTaskState>([
  "open", "working", "blocked", "review", "completed", "canceled"
]);
const terminalTaskStates = new Set<AgentTaskState>(["completed", "canceled"]);

function boundedText(
  value: string,
  label: string,
  maximum: number
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || value.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

export class AgentTaskService {
  public constructor(
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public list(principal: WebPrincipal, roomId: string): AgentTaskRecord[] {
    this.auth.requireRoomMember(principal, roomId);
    return this.tasks.listForRoom(roomId);
  }

  public create(
    principal: WebPrincipal,
    input: {
      roomId: string;
      parentTaskId?: string | null;
      title: string;
      goal: string;
      primaryAgentId?: string | null;
      workspaceRef?: string | null;
    },
    now: string
  ): AgentTaskRecord {
    const member = this.auth.requireRoomMember(principal, input.roomId);
    const room = this.core.getRoom(input.roomId);
    if (!room || room.archivedAt) {
      throw new Error("Task Room is unavailable");
    }
    const parentTaskId = input.parentTaskId ?? null;
    if (parentTaskId) {
      const parent = this.tasks.get(parentTaskId);
      if (!parent || parent.roomId !== input.roomId) {
        throw new Error("Parent Task must belong to the same Room");
      }
    }
    const primaryAgentId = input.primaryAgentId ?? null;
    if (primaryAgentId) {
      const agent = this.core.getAgent(primaryAgentId);
      if (
        !agent || !agent.enabled || agent.teamId !== room.teamId ||
        !this.core.isRoomAgent(room.roomId, agent.agentId)
      ) {
        throw new Error("Primary Agent must be available in the Task Room");
      }
    }
    const workspaceRef = input.workspaceRef === undefined || input.workspaceRef === null
      ? null
      : boundedText(input.workspaceRef, "Task workspace reference", 512);
    const task: AgentTaskRecord = {
      taskId: createOpaqueId("task"),
      roomId: input.roomId,
      parentTaskId,
      title: boundedText(input.title, "Task title", 160),
      goal: boundedText(input.goal, "Task goal", 20_000),
      state: "open",
      primaryAgentId,
      workspaceRef,
      summary: "",
      lastRoomSequence: 0,
      createdByMemberId: member.memberId,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    };
    return this.tasks.create(task);
  }

  public update(
    principal: WebPrincipal,
    taskId: string,
    input: {
      title?: string;
      goal?: string;
      state?: AgentTaskState;
      primaryAgentId?: string | null;
      workspaceRef?: string | null;
    },
    now: string
  ): AgentTaskRecord {
    const existing = this.tasks.get(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
    this.auth.requireRoomMember(principal, existing.roomId);
    if (Object.keys(input).length === 0) {
      throw new Error("Task update requires at least one field");
    }
    if (input.state !== undefined && !taskStates.has(input.state)) {
      throw new Error("Unsupported Task state");
    }
    if (
      input.state !== undefined && terminalTaskStates.has(input.state) &&
      !terminalTaskStates.has(existing.state) && this.tasks.hasActiveWork(taskId)
    ) {
      throw new Error("Task has active Runs or Discussions");
    }
    const primaryAgentId = input.primaryAgentId === undefined
      ? existing.primaryAgentId
      : input.primaryAgentId;
    if (primaryAgentId) {
      const room = this.core.getRoom(existing.roomId);
      const agent = this.core.getAgent(primaryAgentId);
      if (
        !room || !agent || !agent.enabled || agent.teamId !== room.teamId ||
        !this.core.isRoomAgent(room.roomId, agent.agentId)
      ) {
        throw new Error("Primary Agent must be available in the Task Room");
      }
    }
    return this.tasks.update(taskId, {
      title: input.title === undefined
        ? existing.title
        : boundedText(input.title, "Task title", 160),
      goal: input.goal === undefined
        ? existing.goal
        : boundedText(input.goal, "Task goal", 20_000),
      state: input.state ?? existing.state,
      primaryAgentId,
      workspaceRef: input.workspaceRef === undefined
        ? existing.workspaceRef
        : input.workspaceRef === null
          ? null
          : boundedText(input.workspaceRef, "Task workspace reference", 512),
      updatedAt: now
    });
  }

  public requireRunnable(
    principal: WebPrincipal,
    roomId: string,
    taskId?: string
  ): AgentTaskRecord {
    this.auth.requireRoomMember(principal, roomId);
    const task = taskId
      ? this.tasks.get(taskId)
      : this.tasks.getDefaultForRoom(roomId);
    if (!task || task.roomId !== roomId) {
      throw new Error("Task must belong to the target Room");
    }
    if (terminalTaskStates.has(task.state)) {
      throw new Error(`Task is not runnable in state ${task.state}`);
    }
    return task;
  }
}
