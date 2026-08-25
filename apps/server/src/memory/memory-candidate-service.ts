import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import { redactSensitiveText } from "../security/redaction.js";
import type { LongTermMemoryService } from "../task/long-term-memory-service.js";
import type {
  MemoryEntryType,
  MemoryScopeKind,
  RoomMemoryEntryType,
  TaskMemoryEntryType
} from "../task/memory-entry-repository.js";
import type { MemoryCandidateSuggestion } from "./memory-reducer-runner.js";
import type { MemoryCandidateSink } from "./memory-reducer-scheduler.js";

const roomTypes = new Set<RoomMemoryEntryType>([
  "decision", "constraint", "fact", "open_question", "convention"
]);
const taskTypes = new Set<TaskMemoryEntryType>([
  "goal", "acceptance_criterion", "plan", "progress", "blocker",
  "decision", "result"
]);

export type MemoryCandidateState = "pending" | "accepted" | "rejected";

export interface MemoryCandidateRecord {
  candidateId: string;
  roomId: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  taskId: string | null;
  type: MemoryEntryType;
  content: string;
  sourceMessageIds: string[];
  checkpointId: string;
  sourceDigest: string;
  sourceFingerprint: string;
  state: MemoryCandidateState;
  acceptedMemoryId: string | null;
  reviewedByMemberId: string | null;
  rejectionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

interface MemoryCandidateRow {
  candidate_id: string;
  room_id: string;
  scope_kind: MemoryScopeKind;
  scope_id: string;
  task_id: string | null;
  entry_type: MemoryEntryType;
  content: string;
  source_message_ids_json: string;
  checkpoint_id: string;
  source_digest: string;
  source_fingerprint: string;
  state: MemoryCandidateState;
  accepted_memory_id: string | null;
  reviewed_by_member_id: string | null;
  rejection_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
}

interface CheckpointIntervalRow {
  input_from_sequence_exclusive: number;
  through_sequence: number;
  source_digest: string;
}

function mapCandidate(row: MemoryCandidateRow): MemoryCandidateRecord {
  return {
    candidateId: row.candidate_id,
    roomId: row.room_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    taskId: row.task_id,
    type: row.entry_type,
    content: row.content,
    sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
    checkpointId: row.checkpoint_id,
    sourceDigest: row.source_digest,
    sourceFingerprint: row.source_fingerprint,
    state: row.state,
    acceptedMemoryId: row.accepted_memory_id,
    reviewedByMemberId: row.reviewed_by_member_id,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at
  };
}

function sourceFingerprint(input: {
  roomId: string;
  checkpointId: string;
  sourceDigest: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  type: MemoryEntryType;
  content: string;
  sourceMessageIds: string[];
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function validateSourceIds(ids: string[]): string[] {
  if (
    ids.length < 1 || ids.length > 16 || new Set(ids).size !== ids.length ||
    ids.some((id) => id.length < 8 || id.length > 160)
  ) {
    throw new Error(
      "Memory candidate requires 1 to 16 unique bounded source Message IDs"
    );
  }
  return [...ids].sort();
}

export class MemoryCandidateService implements MemoryCandidateSink {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions: SqliteTransactionBoundary,
    private readonly auth: AuthService,
    private readonly longTermMemory: LongTermMemoryService,
    private readonly onCandidatesChanged?: (roomId: string) => void
  ) {}

  public persistSuggestions(input: {
    roomId: string;
    checkpointId: string;
    sourceDigest: string;
    suggestions: MemoryCandidateSuggestion[];
    now: string;
  }): void {
    if (input.suggestions.length > 32) {
      throw new Error("Memory reducer produced too many candidates");
    }
    const checkpoint = this.database.prepare(`
      SELECT input_from_sequence_exclusive, through_sequence, source_digest
      FROM rolling_room_checkpoints
      WHERE checkpoint_id = ? AND room_id = ?
    `).get(input.checkpointId, input.roomId) as CheckpointIntervalRow | undefined;
    if (!checkpoint || checkpoint.source_digest !== input.sourceDigest) {
      throw new Error("Memory candidate checkpoint provenance does not match");
    }

    const created = this.transactions.immediate(() => {
      let count = 0;
      for (const suggestion of input.suggestions) {
        if (this.persistOne(input, checkpoint, suggestion)) count += 1;
      }
      return count;
    });
    if (created > 0) this.onCandidatesChanged?.(input.roomId);
  }

  public listRoom(
    principal: WebPrincipal,
    roomId: string,
    state: MemoryCandidateState | "all" = "pending",
    limit = 100
  ): MemoryCandidateRecord[] {
    this.auth.requireRoomMember(principal, roomId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Memory candidate page limit must be from 1 to 100");
    }
    const rows = state === "all"
      ? this.database.prepare(`
          SELECT * FROM memory_candidates
          WHERE room_id = ?
          ORDER BY created_at DESC, candidate_id
          LIMIT ?
        `).all(roomId, limit)
      : this.database.prepare(`
          SELECT * FROM memory_candidates
          WHERE room_id = ? AND state = ?
          ORDER BY created_at DESC, candidate_id
          LIMIT ?
        `).all(roomId, state, limit);
    return (rows as MemoryCandidateRow[]).map(mapCandidate);
  }

  public accept(
    principal: WebPrincipal,
    candidateId: string,
    now: string
  ): MemoryCandidateRecord {
    return this.transactions.immediate(() => {
      const current = this.requireCandidate(candidateId);
      const member = this.auth.requireRoomMember(principal, current.roomId);
      if (current.state === "accepted") return current;
      if (current.state === "rejected") {
        throw new Error("Rejected memory candidate cannot be accepted");
      }
      const memory = current.scopeKind === "room"
        ? this.longTermMemory.createRoom(principal, current.roomId, {
            type: current.type,
            content: current.content,
            sourceMessageIds: current.sourceMessageIds
          }, now)
        : this.longTermMemory.createTask(principal, current.scopeId, {
            type: current.type,
            content: current.content,
            sourceMessageIds: current.sourceMessageIds
          }, now);
      const changed = this.database.prepare(`
        UPDATE memory_candidates
        SET state = 'accepted', accepted_memory_id = ?,
            reviewed_by_member_id = ?, reviewed_at = ?
        WHERE candidate_id = ? AND state = 'pending'
      `).run(memory.memoryId, member.memberId, now, candidateId);
      if (changed.changes !== 1) {
        throw new Error("Memory candidate review raced with another reviewer");
      }
      return this.requireCandidate(candidateId);
    });
  }

  public reject(
    principal: WebPrincipal,
    candidateId: string,
    reason: string | undefined,
    now: string
  ): MemoryCandidateRecord {
    if ((reason?.length ?? 0) > 500) {
      throw new Error("Memory candidate rejection reason is too long");
    }
    const safeReason = reason === undefined
      ? null
      : redactSensitiveText(reason.trim()) || null;
    return this.transactions.immediate(() => {
      const current = this.requireCandidate(candidateId);
      const member = this.auth.requireRoomMember(principal, current.roomId);
      if (current.state === "rejected") return current;
      if (current.state === "accepted") {
        throw new Error("Accepted memory candidate cannot be rejected");
      }
      const changed = this.database.prepare(`
        UPDATE memory_candidates
        SET state = 'rejected', reviewed_by_member_id = ?,
            rejection_reason = ?, reviewed_at = ?
        WHERE candidate_id = ? AND state = 'pending'
      `).run(member.memberId, safeReason, now, candidateId);
      if (changed.changes !== 1) {
        throw new Error("Memory candidate review raced with another reviewer");
      }
      return this.requireCandidate(candidateId);
    });
  }

  private persistOne(
    input: {
      roomId: string;
      checkpointId: string;
      sourceDigest: string;
      now: string;
    },
    checkpoint: CheckpointIntervalRow,
    suggestion: MemoryCandidateSuggestion
  ): boolean {
    const content = redactSensitiveText(suggestion.content.trim());
    if (
      content.length === 0 || suggestion.content.length > 2_000 ||
      suggestion.scopeId.length < 8 || suggestion.scopeId.length > 160
    ) {
      throw new Error("Memory candidate content or scope is outside its bounds");
    }
    if (
      suggestion.scopeKind === "room" &&
      (!roomTypes.has(suggestion.type as RoomMemoryEntryType) ||
        suggestion.scopeId !== input.roomId)
    ) {
      throw new Error("Room memory candidate scope or type is invalid");
    }
    if (suggestion.scopeKind === "task") {
      if (!taskTypes.has(suggestion.type as TaskMemoryEntryType)) {
        throw new Error("Task memory candidate type is invalid");
      }
      const task = this.database.prepare(`
        SELECT room_id FROM agent_tasks WHERE task_id = ?
      `).get(suggestion.scopeId) as { room_id: string } | undefined;
      if (!task || task.room_id !== input.roomId) {
        throw new Error("Task memory candidate is outside its Room");
      }
    }
    const sourceMessageIds = validateSourceIds(suggestion.sourceMessageIds);
    for (const messageId of sourceMessageIds) {
      const message = this.database.prepare(`
        SELECT room_id, task_id, sequence FROM messages WHERE message_id = ?
      `).get(messageId) as {
        room_id: string;
        task_id: string;
        sequence: number;
      } | undefined;
      if (
        !message || message.room_id !== input.roomId ||
        message.sequence <= checkpoint.input_from_sequence_exclusive ||
        message.sequence > checkpoint.through_sequence ||
        (suggestion.scopeKind === "task" &&
          message.task_id !== suggestion.scopeId)
      ) {
        throw new Error("Memory candidate Message provenance is outside scope");
      }
    }
    const fingerprint = sourceFingerprint({
      roomId: input.roomId,
      checkpointId: input.checkpointId,
      sourceDigest: input.sourceDigest,
      scopeKind: suggestion.scopeKind,
      scopeId: suggestion.scopeId,
      type: suggestion.type,
      content,
      sourceMessageIds
    });
    return this.database.prepare(`
      INSERT INTO memory_candidates (
        candidate_id, room_id, scope_kind, scope_id, task_id, entry_type,
        content, source_message_ids_json, checkpoint_id, source_digest,
        source_fingerprint, state, accepted_memory_id, reviewed_by_member_id,
        rejection_reason, created_at, reviewed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL
      )
      ON CONFLICT(source_fingerprint) DO NOTHING
    `).run(
      createOpaqueId("candidate"),
      input.roomId,
      suggestion.scopeKind,
      suggestion.scopeId,
      suggestion.scopeKind === "task" ? suggestion.scopeId : null,
      suggestion.type,
      content,
      JSON.stringify(sourceMessageIds),
      input.checkpointId,
      input.sourceDigest,
      fingerprint,
      input.now
    ).changes === 1;
  }

  private requireCandidate(candidateId: string): MemoryCandidateRecord {
    const row = this.database.prepare(`
      SELECT * FROM memory_candidates WHERE candidate_id = ?
    `).get(candidateId) as MemoryCandidateRow | undefined;
    if (!row) throw new Error(`Memory candidate not found: ${candidateId}`);
    return mapCandidate(row);
  }
}
