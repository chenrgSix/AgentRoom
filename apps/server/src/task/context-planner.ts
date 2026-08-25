import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type {
  CoreRepository,
  MessageRecord
} from "../data/core-repository.js";
import {
  RollingRoomMemoryRepository
} from "../memory/rolling-room-memory-repository.js";
import type { RunContextFence } from "../run/run-repository.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "./task-repository.js";
import {
  ArtifactRepository,
  type ArtifactType,
  type TaskArtifactRecord
} from "./artifact-repository.js";
import {
  MemoryEntryRepository,
  type MemoryEntryRecord
} from "./memory-entry-repository.js";

const recentRoomMessageLimit = 12;
const recentTaskMessageLimit = 18;
const projectionMessageLimit = 16;
const projectionSummaryLimit = 8_000;
const projectionExcerptLimit = 320;
const rawRoomTailMessageLimit = 12;
const rawRoomTailUtf8ByteLimit = 10_240;

export interface ContextMemoryProjection {
  summary: string;
  sourceCursor: number;
  revision: number;
  sourceMessageIds: string[];
  projectionKind?: "historical";
}

export interface ContextArtifactRef {
  artifactId: string;
  artifactRevision: number;
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

export interface ContextLongTermMemoryEntry {
  memoryId: string;
  type: MemoryEntryRecord["type"];
  content: string;
  state: MemoryEntryRecord["state"];
  revision: number;
  supersedesMemoryId?: string;
  sourceMessageIds: string[];
  sourceArtifactIds: string[];
  sourceRunIds: string[];
  sourceDiscussionIds: string[];
}

export interface ContextLongTermMemoryScope {
  revision: number;
  activeComplete: boolean;
  entries: ContextLongTermMemoryEntry[];
}

export interface PlannedRoomContextBundle {
  targetThroughSequence: number;
  priorContextThroughSequence: number;
  requestMessageId: string;
  checkpoint: {
    checkpointId: string;
    fromSequenceExclusive: number;
    throughSequence: number;
    summary: string;
    sourceMessageCount: number;
    sourceDigest: string;
    promptVersion: string;
    modelFingerprint: string;
    buildKind: "incremental" | "rebase";
    provenanceMessageIds: string[];
  };
  rawTail: {
    fromSequenceExclusive: number;
    throughSequenceInclusive: number;
    messageCount: number;
    utf8Bytes: number;
    messages: MessageRecord[];
  };
}

export interface PlannedRuntimeContext {
  contextPlan: {
    roomMemory: ContextMemoryProjection;
    taskMemory: ContextMemoryProjection;
    resultEvidence?: {
      revision: number;
      deliveryKind: "bootstrap" | "delta";
      fromRevision: number;
      throughRevision: number;
      hasMore: boolean;
      artifactRefs: ContextArtifactRef[];
    };
    longTermMemory?: {
      room?: ContextLongTermMemoryScope;
      task?: ContextLongTermMemoryScope;
    };
  };
  contextMessages: MessageRecord[];
  roomContextBundle?: PlannedRoomContextBundle;
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
  private readonly memoryEntries: MemoryEntryRepository;
  private readonly rollingRoomMemory: RollingRoomMemoryRepository;

  public constructor(
    private readonly database: Database.Database,
    private readonly core: CoreRepository,
    private readonly tasks: AgentTaskRepository
  ) {
    this.artifacts = new ArtifactRepository(database);
    this.memoryEntries = new MemoryEntryRepository(database);
    this.rollingRoomMemory = new RollingRoomMemoryRepository(database);
  }

  public plan(
    input: {
      roomId: string;
      taskId: string;
      throughSequence: number;
      triggerMessageId: string;
      resultEvidenceAfterRevision?: number;
      contextFence?: RunContextFence;
    },
    now: string
  ): PlannedRuntimeContext {
    const task = this.tasks.get(input.taskId);
    if (!task || task.roomId !== input.roomId) {
      throw new Error("Runtime context Task must belong to its Room");
    }
    const room = this.core.getRoom(input.roomId);
    if (!room) throw new Error(`Room not found: ${input.roomId}`);
    if (
      input.contextFence &&
      (
        input.contextFence.roomId !== input.roomId ||
        input.contextFence.taskId !== input.taskId ||
        input.contextFence.triggerSequence !== input.throughSequence
      )
    ) {
      throw new Error("Runtime context fence does not match its Run");
    }

    const historicalFence = input.contextFence?.fenceKind === "captured"
      ? input.contextFence
      : undefined;
    const contextTask = historicalFence
      ? {
          ...task,
          title: historicalFence.taskTitle,
          goal: historicalFence.taskGoal,
          state: historicalFence.taskState,
          artifactRevision: historicalFence.taskArtifactRevision
        }
      : task;

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

    const resultEvidence = this.planResultEvidence(
      contextTask,
      input.resultEvidenceAfterRevision,
      historicalFence?.taskArtifactRevision
    );
    const roomLongTermMemory = historicalFence
      ? this.memoryEntries.contextScopeAtRevision(
          "room",
          room.roomId,
          historicalFence.roomLongTermMemoryRevision
        )
      : this.memoryEntries.contextScope("room", room.roomId);
    const taskLongTermMemory = historicalFence
      ? this.memoryEntries.contextScopeAtRevision(
          "task",
          task.taskId,
          historicalFence.taskLongTermMemoryRevision
        )
      : this.memoryEntries.contextScope("task", task.taskId);
    const roomContextBundle = this.planRoomContextBundle(
      input.roomId,
      input.throughSequence,
      input.triggerMessageId,
      historicalFence?.capturedAt
    );
    return {
      contextPlan: {
        roomMemory: this.projectRoom(
          room.roomId,
          room.name,
          roomSourceCursor,
          now
        ),
        taskMemory: this.projectTask(
          contextTask,
          taskSourceCursor,
          now,
          historicalFence?.taskSummaryRevision
        ),
        ...(resultEvidence ? { resultEvidence } : {}),
        ...(roomLongTermMemory || taskLongTermMemory
          ? {
              longTermMemory: {
                ...(roomLongTermMemory
                  ? { room: this.contextLongTermMemory(roomLongTermMemory) }
                  : {}),
                ...(taskLongTermMemory
                  ? { task: this.contextLongTermMemory(taskLongTermMemory) }
                  : {})
              }
            }
          : {})
      },
      contextMessages,
      ...(roomContextBundle ? { roomContextBundle } : {})
    };
  }

  private planRoomContextBundle(
    roomId: string,
    targetThroughSequence: number,
    requestMessageId: string,
    checkpointCreatedAtOrBefore?: string
  ): PlannedRoomContextBundle | undefined {
    const state = this.rollingRoomMemory.getState(roomId);
    if (state?.mode !== "ready") return undefined;
    const priorContextThroughSequence = targetThroughSequence - 1;
    if (priorContextThroughSequence < 1) return undefined;
    const checkpoint = this.rollingRoomMemory.latestAtOrBefore(
      roomId,
      priorContextThroughSequence,
      checkpointCreatedAtOrBefore
    );
    if (!checkpoint) return undefined;
    const messages = this.core.listMessagesRange(
      roomId,
      checkpoint.throughSequence,
      priorContextThroughSequence,
      rawRoomTailMessageLimit + 1
    );
    const expectedCount = priorContextThroughSequence - checkpoint.throughSequence;
    if (
      messages.length !== expectedCount ||
      messages.length > rawRoomTailMessageLimit ||
      messages.some((message, index) =>
        message.sequence !== checkpoint.throughSequence + index + 1 ||
        message.messageId === requestMessageId
      )
    ) {
      return undefined;
    }
    const utf8Bytes = messages.reduce(
      (total, message) => total + Buffer.byteLength(message.content, "utf8"),
      0
    );
    if (utf8Bytes > rawRoomTailUtf8ByteLimit) return undefined;
    return {
      targetThroughSequence,
      priorContextThroughSequence,
      requestMessageId,
      checkpoint: {
        checkpointId: checkpoint.checkpointId,
        fromSequenceExclusive: checkpoint.inputFromSequenceExclusive,
        throughSequence: checkpoint.throughSequence,
        summary: checkpoint.summary,
        sourceMessageCount: checkpoint.sourceMessageCount,
        sourceDigest: checkpoint.sourceDigest,
        promptVersion: `room-memory-v${checkpoint.promptVersion}`,
        modelFingerprint: checkpoint.modelFingerprint,
        buildKind: checkpoint.buildKind,
        provenanceMessageIds: checkpoint.provenance
      },
      rawTail: {
        fromSequenceExclusive: checkpoint.throughSequence,
        throughSequenceInclusive: priorContextThroughSequence,
        messageCount: messages.length,
        utf8Bytes,
        messages
      }
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
    now: string,
    historicalRevision?: number
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
    if (historicalRevision !== undefined) {
      return {
        summary,
        sourceCursor,
        revision: Math.max(1, historicalRevision),
        sourceMessageIds,
        projectionKind: "historical"
      };
    }
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
      artifactRevision: artifact.artifactRevision,
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

  private contextLongTermMemory(input: {
    revision: number;
    activeComplete: boolean;
    entries: MemoryEntryRecord[];
  }): ContextLongTermMemoryScope {
    return {
      revision: input.revision,
      activeComplete: input.activeComplete,
      entries: input.entries.map((entry) => ({
        memoryId: entry.memoryId,
        type: entry.type,
        content: entry.content,
        state: entry.state,
        revision: entry.revision,
        ...(entry.supersedesMemoryId
          ? { supersedesMemoryId: entry.supersedesMemoryId }
          : {}),
        sourceMessageIds: entry.sourceMessageIds,
        sourceArtifactIds: entry.sourceArtifactIds,
        sourceRunIds: entry.sourceRunIds,
        sourceDiscussionIds: entry.sourceDiscussionIds
      }))
    };
  }

  private planResultEvidence(
    task: AgentTaskRecord,
    afterRevision: number | undefined,
    throughRevision = task.artifactRevision
  ): PlannedRuntimeContext["contextPlan"]["resultEvidence"] | undefined {
    if (throughRevision === 0) return undefined;
    if (
      afterRevision !== undefined &&
      afterRevision >= 0 &&
      afterRevision <= throughRevision
    ) {
      const artifacts = this.artifacts.listAfterRevision(
        task.taskId,
        afterRevision,
        20,
        throughRevision
      );
      if (artifacts.length === 0) return undefined;
      const deliveredThroughRevision = artifacts.at(-1)!.artifactRevision;
      return {
        revision: deliveredThroughRevision,
        deliveryKind: "delta",
        fromRevision: afterRevision,
        throughRevision: deliveredThroughRevision,
        hasMore: deliveredThroughRevision < throughRevision,
        artifactRefs: artifacts.map((artifact) => this.contextArtifact(artifact))
      };
    }
    const artifacts = this.artifacts.listForTask(
      task.taskId,
      20,
      throughRevision
    ).reverse();
    if (artifacts.length === 0) return undefined;
    return {
      revision: throughRevision,
      deliveryKind: "bootstrap",
      fromRevision: artifacts[0]!.artifactRevision - 1,
      throughRevision,
      hasMore: false,
      artifactRefs: artifacts.map((artifact) => this.contextArtifact(artifact))
    };
  }
}
