import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  CoreRepository,
  MessageRecord
} from "../data/core-repository.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "./task-repository.js";
import {
  ArtifactRepository,
  type ArtifactType,
  type TaskArtifactRecord
} from "./artifact-repository.js";

const recentRoomMessageLimit = 12;
const recentTaskMessageLimit = 18;
const projectionMessageLimit = 16;
const projectionSummaryLimit = 8_000;
const projectionExcerptLimit = 320;

export interface ContextMemoryProjection {
  summary: string;
  sourceCursor: number;
  revision: number;
  sourceMessageIds: string[];
  projectionKind?: "historical";
}

export interface ContextArtifactRef {
  artifactId: string;
  type: ArtifactType;
  workspaceRef?: string;
  repository?: string;
  path?: string;
  commitSha?: string;
  branch?: string;
  title: string;
  summary: string;
  sourceRunId?: string;
  createdByMemberId?: string;
  createdByAgentId?: string;
  createdAt: string;
}

export interface PlannedRuntimeContext {
  contextPlan: {
    roomMemory: ContextMemoryProjection;
    taskMemory: ContextMemoryProjection;
    resultEvidence?: {
      revision: number;
      artifactRefs: ContextArtifactRef[];
    };
  };
  contextMessages: MessageRecord[];
}

interface RoomProjectionRow {
  room_id: string;
  summary: string;
  source_sequence: number;
  revision: number;
  provenance_json: string;
  fingerprint: string;
  created_at: string;
  updated_at: string;
}

function normalizedExcerpt(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= projectionExcerptLimit
    ? normalized
    : `${normalized.slice(0, projectionExcerptLimit - 1)}…`;
}

function boundedSummary(lines: string[]): string {
  const summary = lines.filter((line) => line.trim().length > 0).join("\n");
  if (summary.length <= projectionSummaryLimit) return summary;
  return `${summary.slice(0, projectionSummaryLimit - 1)}…`;
}

function fingerprintProjection(input: {
  summary: string;
  sourceCursor: number;
  sourceMessageIds: string[];
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export class ContextPlanner {
  private readonly artifacts: ArtifactRepository;

  public constructor(
    private readonly database: Database.Database,
    private readonly core: CoreRepository,
    private readonly tasks: AgentTaskRepository
  ) {
    this.artifacts = new ArtifactRepository(database);
  }

  public plan(
    input: {
      roomId: string;
      taskId: string;
      throughSequence: number;
      triggerMessageId: string;
    },
    now: string
  ): PlannedRuntimeContext {
    const task = this.tasks.get(input.taskId);
    if (!task || task.roomId !== input.roomId) {
      throw new Error("Runtime context Task must belong to its Room");
    }
    const room = this.core.getRoom(input.roomId);
    if (!room) throw new Error(`Room not found: ${input.roomId}`);

    const recentRoom = this.core.listMessagesThrough(
      input.roomId,
      input.throughSequence,
      recentRoomMessageLimit
    );
    const recentTask = this.core.listTaskMessagesThrough(
      input.taskId,
      input.throughSequence,
      recentTaskMessageLimit
    );
    const contextMessages = this.mergeRecentMessages(recentRoom, recentTask);
    const roomSourceCursor = this.projectionCursor(
      recentRoom,
      input.triggerMessageId,
      input.throughSequence
    );
    const taskSourceCursor = this.projectionCursor(
      recentTask,
      input.triggerMessageId,
      input.throughSequence
    );

    const artifactRefs = this.artifacts.listForTask(task.taskId, 20);
    return {
      contextPlan: {
        roomMemory: this.projectRoom(
          room.roomId,
          room.name,
          roomSourceCursor,
          now
        ),
        taskMemory: this.projectTask(task, taskSourceCursor, now),
        ...(artifactRefs.length > 0
          ? {
              resultEvidence: {
                revision: task.artifactRevision,
                artifactRefs: artifactRefs.map((artifact) =>
                  this.contextArtifact(artifact)
                )
              }
            }
          : {})
      },
      contextMessages
    };
  }

  private mergeRecentMessages(
    roomMessages: MessageRecord[],
    taskMessages: MessageRecord[]
  ): MessageRecord[] {
    const byId = new Map<string, MessageRecord>();
    for (const message of [...roomMessages, ...taskMessages]) {
      byId.set(message.messageId, message);
    }
    return [...byId.values()].sort((left, right) =>
      left.sequence - right.sequence || left.messageId.localeCompare(right.messageId)
    );
  }

  private projectionCursor(
    recent: MessageRecord[],
    triggerMessageId: string,
    throughSequence: number
  ): number {
    const firstPrior = recent.find((message) =>
      message.messageId !== triggerMessageId
    );
    return firstPrior
      ? Math.max(0, firstPrior.sequence - 1)
      : Math.max(0, throughSequence - 1);
  }

  private projectRoom(
    roomId: string,
    roomName: string,
    sourceCursor: number,
    now: string
  ): ContextMemoryProjection {
    const messages = this.core.listMessagesThrough(
      roomId,
      sourceCursor,
      projectionMessageLimit
    );
    const summary = boundedSummary([
      `Room: ${normalizedExcerpt(roomName)}`,
      ...(messages.length > 0 ? ["Earlier Room evidence:"] : []),
      ...messages.map((message) => this.evidenceLine(message))
    ]);
    const sourceMessageIds = messages.map((message) => message.messageId);
    const fingerprint = fingerprintProjection({
      summary,
      sourceCursor,
      sourceMessageIds
    });
    this.database.prepare(`
      INSERT INTO room_memory_projections (
        room_id, summary, source_sequence, revision, provenance_json,
        fingerprint, created_at, updated_at
      ) VALUES (
        @roomId, @summary, @sourceCursor, 1, @provenanceJson,
        @fingerprint, @now, @now
      )
      ON CONFLICT(room_id) DO UPDATE SET
        summary = excluded.summary,
        source_sequence = excluded.source_sequence,
        revision = room_memory_projections.revision + 1,
        provenance_json = excluded.provenance_json,
        fingerprint = excluded.fingerprint,
        updated_at = excluded.updated_at
      WHERE excluded.source_sequence >= room_memory_projections.source_sequence
        AND room_memory_projections.fingerprint <> excluded.fingerprint
    `).run({
      roomId,
      summary,
      sourceCursor,
      provenanceJson: JSON.stringify(sourceMessageIds),
      fingerprint,
      now
    });
    const row = this.database.prepare(`
      SELECT * FROM room_memory_projections WHERE room_id = ?
    `).get(roomId) as RoomProjectionRow;
    if (row.source_sequence > sourceCursor) {
      return {
        summary,
        sourceCursor,
        revision: row.revision,
        sourceMessageIds,
        projectionKind: "historical"
      };
    }
    return {
      summary: row.summary,
      sourceCursor: row.source_sequence,
      revision: row.revision,
      sourceMessageIds: JSON.parse(row.provenance_json) as string[]
    };
  }

  private projectTask(
    task: AgentTaskRecord,
    sourceCursor: number,
    now: string
  ): ContextMemoryProjection {
    const messages = this.core.listTaskMessagesThrough(
      task.taskId,
      sourceCursor,
      projectionMessageLimit
    );
    const summary = boundedSummary([
      `Task: ${normalizedExcerpt(task.title)}`,
      `Goal: ${normalizedExcerpt(task.goal)}`,
      `State: ${task.state}`,
      ...(messages.length > 0 ? ["Earlier Task evidence:"] : []),
      ...messages.map((message) => this.evidenceLine(message))
    ]);
    const sourceMessageIds = messages.map((message) => message.messageId);
    const fingerprint = fingerprintProjection({
      summary,
      sourceCursor,
      sourceMessageIds
    });
    const updated = this.tasks.updateSummaryProjection(task.taskId, {
      summary,
      sourceSequence: sourceCursor,
      provenanceMessageIds: sourceMessageIds,
      fingerprint,
      updatedAt: now
    });
    if (updated.summarySourceSequence > sourceCursor) {
      return {
        summary,
        sourceCursor,
        revision: updated.summaryRevision,
        sourceMessageIds,
        projectionKind: "historical"
      };
    }
    return {
      summary: updated.summary,
      sourceCursor: updated.summarySourceSequence,
      revision: updated.summaryRevision,
      sourceMessageIds: updated.summaryProvenanceMessageIds
    };
  }

  private evidenceLine(message: MessageRecord): string {
    const sender = message.senderType === "member"
      ? this.core.getMember(message.senderId)?.displayName ?? "Member"
      : message.senderType === "agent"
        ? this.core.getAgent(message.senderId)?.name ?? "Agent"
        : "Agent Room";
    return `- [sequence ${message.sequence}; ${normalizedExcerpt(sender)}] ${
      normalizedExcerpt(message.content)
    }`;
  }

  private contextArtifact(artifact: TaskArtifactRecord): ContextArtifactRef {
    return {
      artifactId: artifact.artifactId,
      type: artifact.type,
      ...(artifact.workspaceRef ? { workspaceRef: artifact.workspaceRef } : {}),
      ...(artifact.repository ? { repository: artifact.repository } : {}),
      ...(artifact.path ? { path: artifact.path } : {}),
      ...(artifact.commitSha ? { commitSha: artifact.commitSha } : {}),
      ...(artifact.branch ? { branch: artifact.branch } : {}),
      title: artifact.title,
      summary: artifact.summary,
      ...(artifact.sourceRunId ? { sourceRunId: artifact.sourceRunId } : {}),
      ...(artifact.createdByMemberId
        ? { createdByMemberId: artifact.createdByMemberId }
        : {}),
      ...(artifact.createdByAgentId
        ? { createdByAgentId: artifact.createdByAgentId }
        : {}),
      createdAt: artifact.createdAt
    };
  }
}
