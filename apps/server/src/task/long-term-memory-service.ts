import type Database from "better-sqlite3";

import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRepository } from "../run/run-repository.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import { redactSensitiveText } from "../security/redaction.js";
import type { ArtifactRepository } from "./artifact-repository.js";
import {
  type MemoryEntryRecord,
  type MemoryEntryRepository,
  type MemoryEntryType,
  type MemoryScopeKind,
  type RoomMemoryEntryType,
  type TaskMemoryEntryType
} from "./memory-entry-repository.js";
import type { AgentTaskRepository } from "./task-repository.js";

const roomTypes = new Set<RoomMemoryEntryType>([
  "decision", "constraint", "fact", "open_question", "convention"
]);
const taskTypes = new Set<TaskMemoryEntryType>([
  "goal", "acceptance_criterion", "plan", "progress", "blocker",
  "decision", "result"
]);

interface MemorySourceInput {
  sourceMessageIds?: string[];
  sourceArtifactIds?: string[];
  sourceRunIds?: string[];
  sourceDiscussionIds?: string[];
}

export interface CreateMemoryEntryInput extends MemorySourceInput {
  type: MemoryEntryType;
  content: string;
  supersedesMemoryId?: string | null;
}

function uniqueBoundedIds(values: string[] | undefined, label: string): string[] {
  const ids = values ?? [];
  if (
    ids.length > 16 ||
    ids.some((id) => typeof id !== "string" || id.length < 8 || id.length > 160) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(`${label} must contain up to 16 unique bounded IDs`);
  }
  return ids;
}

export class LongTermMemoryService {
  public constructor(
    private readonly database: Database.Database,
    private readonly entries: MemoryEntryRepository,
    private readonly artifacts: ArtifactRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly auth: AuthService
  ) {}

  public listRoom(
    principal: WebPrincipal,
    roomId: string,
    afterRevision = 0,
    limit = 100
  ): MemoryEntryRecord[] {
    this.auth.requireRoomMember(principal, roomId);
    return this.entries.list("room", roomId, afterRevision, limit);
  }

  public listTask(
    principal: WebPrincipal,
    taskId: string,
    afterRevision = 0,
    limit = 100
  ): MemoryEntryRecord[] {
    const task = this.requireTask(taskId);
    this.auth.requireRoomMember(principal, task.roomId);
    return this.entries.list("task", taskId, afterRevision, limit);
  }

  public createRoom(
    principal: WebPrincipal,
    roomId: string,
    input: CreateMemoryEntryInput,
    now: string
  ): MemoryEntryRecord {
    const member = this.auth.requireRoomMember(principal, roomId);
    if (!roomTypes.has(input.type as RoomMemoryEntryType)) {
      throw new Error("Room memory entry type is invalid");
    }
    return this.create("room", roomId, roomId, null, member.memberId, input, now);
  }

  public createTask(
    principal: WebPrincipal,
    taskId: string,
    input: CreateMemoryEntryInput,
    now: string
  ): MemoryEntryRecord {
    const task = this.requireTask(taskId);
    const member = this.auth.requireRoomMember(principal, task.roomId);
    if (!taskTypes.has(input.type as TaskMemoryEntryType)) {
      throw new Error("Task memory entry type is invalid");
    }
    return this.create(
      "task", taskId, task.roomId, taskId, member.memberId, input, now
    );
  }

  public retract(
    principal: WebPrincipal,
    memoryId: string,
    now: string
  ): MemoryEntryRecord {
    const entry = this.entries.get(memoryId);
    if (!entry) throw new Error(`Memory entry not found: ${memoryId}`);
    this.auth.requireRoomMember(principal, entry.roomId);
    return this.entries.retract(memoryId, now);
  }

  private create(
    scopeKind: MemoryScopeKind,
    scopeId: string,
    roomId: string,
    taskId: string | null,
    memberId: string,
    input: CreateMemoryEntryInput,
    now: string
  ): MemoryEntryRecord {
    const content = redactSensitiveText(input.content.trim());
    if (content.length === 0 || input.content.length > 2_000) {
      throw new Error("Memory content must contain 1 to 2000 characters");
    }
    const sourceMessageIds = uniqueBoundedIds(
      input.sourceMessageIds,
      "sourceMessageIds"
    );
    const sourceArtifactIds = uniqueBoundedIds(
      input.sourceArtifactIds,
      "sourceArtifactIds"
    );
    const sourceRunIds = uniqueBoundedIds(input.sourceRunIds, "sourceRunIds");
    const sourceDiscussionIds = uniqueBoundedIds(
      input.sourceDiscussionIds,
      "sourceDiscussionIds"
    );
    if (
      sourceMessageIds.length + sourceArtifactIds.length + sourceRunIds.length +
      sourceDiscussionIds.length === 0
    ) {
      throw new Error("Memory entry requires authoritative provenance");
    }
    for (const messageId of sourceMessageIds) {
      const message = this.core.getMessage(messageId);
      if (
        !message || message.roomId !== roomId ||
        (taskId !== null && message.taskId !== taskId)
      ) {
        throw new Error("Memory source Message is outside its scope");
      }
    }
    for (const artifactId of sourceArtifactIds) {
      const artifact = this.artifacts.get(artifactId);
      if (
        !artifact || artifact.roomId !== roomId ||
        (taskId !== null && artifact.taskId !== taskId)
      ) {
        throw new Error("Memory source Artifact is outside its scope");
      }
    }
    for (const runId of sourceRunIds) {
      const run = this.runs.getRun(runId);
      if (
        !run || run.roomId !== roomId ||
        (taskId !== null && run.taskId !== taskId)
      ) {
        throw new Error("Memory source Run is outside its scope");
      }
    }
    for (const discussionId of sourceDiscussionIds) {
      const discussion = this.database.prepare(`
        SELECT room_id, task_id FROM discussions WHERE discussion_id = ?
      `).get(discussionId) as { room_id: string; task_id: string } | undefined;
      if (
        !discussion || discussion.room_id !== roomId ||
        (taskId !== null && discussion.task_id !== taskId)
      ) {
        throw new Error("Memory source Discussion is outside its scope");
      }
    }
    const supersedesMemoryId = input.supersedesMemoryId ?? null;
    if (supersedesMemoryId) {
      const previous = this.entries.get(supersedesMemoryId);
      if (
        !previous || previous.scopeKind !== scopeKind ||
        previous.scopeId !== scopeId || previous.state !== "active"
      ) {
        throw new Error("Memory supersession target is outside its active scope");
      }
    }
    return this.entries.create({
      memoryId: createOpaqueId("memory"),
      scopeKind,
      scopeId,
      roomId,
      taskId,
      type: input.type,
      content,
      supersedesMemoryId,
      sourceMessageIds,
      sourceArtifactIds,
      sourceRunIds,
      sourceDiscussionIds,
      createdByMemberId: memberId,
      createdAt: now
    });
  }

  private requireTask(taskId: string): NonNullable<ReturnType<AgentTaskRepository["get"]>> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
}
