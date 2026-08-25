import type Database from "better-sqlite3";

import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";

export type MemoryScopeKind = "room" | "task";
export type RoomMemoryEntryType =
  | "decision"
  | "constraint"
  | "fact"
  | "open_question"
  | "convention";
export type TaskMemoryEntryType =
  | "goal"
  | "acceptance_criterion"
  | "plan"
  | "progress"
  | "blocker"
  | "decision"
  | "result";
export type MemoryEntryType = RoomMemoryEntryType | TaskMemoryEntryType;
export type MemoryEntryState = "active" | "superseded" | "retracted";

export interface MemoryEntryRecord {
  memoryId: string;
  scopeKind: MemoryScopeKind;
  scopeId: string;
  roomId: string;
  taskId: string | null;
  type: MemoryEntryType;
  content: string;
  state: MemoryEntryState;
  revision: number;
  supersedesMemoryId: string | null;
  sourceMessageIds: string[];
  sourceArtifactIds: string[];
  sourceRunIds: string[];
  sourceDiscussionIds: string[];
  createdByMemberId: string;
  createdAt: string;
  updatedAt: string;
}

interface MemoryEntryRow {
  memory_id: string;
  scope_kind: MemoryScopeKind;
  scope_id: string;
  room_id: string;
  task_id: string | null;
  entry_type: MemoryEntryType;
  content: string;
  state: MemoryEntryState;
  revision: number;
  supersedes_memory_id: string | null;
  source_message_ids_json: string;
  source_artifact_ids_json: string;
  source_run_ids_json: string;
  source_discussion_ids_json: string;
  created_by_member_id: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryContextScope {
  revision: number;
  activeComplete: boolean;
  entries: MemoryEntryRecord[];
}

function mapEntry(row: MemoryEntryRow): MemoryEntryRecord {
  return {
    memoryId: row.memory_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    roomId: row.room_id,
    taskId: row.task_id,
    type: row.entry_type,
    content: row.content,
    state: row.state,
    revision: row.revision,
    supersedesMemoryId: row.supersedes_memory_id,
    sourceMessageIds: JSON.parse(row.source_message_ids_json) as string[],
    sourceArtifactIds: JSON.parse(row.source_artifact_ids_json) as string[],
    sourceRunIds: JSON.parse(row.source_run_ids_json) as string[],
    sourceDiscussionIds: JSON.parse(row.source_discussion_ids_json) as string[],
    createdByMemberId: row.created_by_member_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class MemoryEntryRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public get(memoryId: string): MemoryEntryRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM memory_entries WHERE memory_id = ?
    `).get(memoryId) as MemoryEntryRow | undefined;
    return row && mapEntry(row);
  }

  public list(
    scopeKind: MemoryScopeKind,
    scopeId: string,
    afterRevision: number,
    limit: number
  ): MemoryEntryRecord[] {
    return (this.database.prepare(`
      SELECT * FROM memory_entries
      WHERE scope_kind = ? AND scope_id = ? AND revision > ?
      ORDER BY revision
      LIMIT ?
    `).all(scopeKind, scopeId, afterRevision, limit) as MemoryEntryRow[])
      .map(mapEntry);
  }

  public create(input: Omit<
    MemoryEntryRecord,
    "state" | "revision" | "updatedAt"
  >): MemoryEntryRecord {
    return this.transactions.immediate(() => {
      const step = input.supersedesMemoryId ? 2 : 1;
      const revision = this.advanceScope(input.scopeKind, input.scopeId, step);
      this.database.prepare(`
        INSERT INTO memory_entries (
          memory_id, scope_kind, scope_id, room_id, task_id, entry_type,
          content, state, revision, supersedes_memory_id,
          source_message_ids_json, source_artifact_ids_json,
          source_run_ids_json, source_discussion_ids_json,
          created_by_member_id, created_at, updated_at
        ) VALUES (
          @memoryId, @scopeKind, @scopeId, @roomId, @taskId, @type,
          @content, 'active', @revision, @supersedesMemoryId,
          @sourceMessageIdsJson, @sourceArtifactIdsJson,
          @sourceRunIdsJson, @sourceDiscussionIdsJson,
          @createdByMemberId, @createdAt, @createdAt
        )
      `).run({
        ...input,
        revision,
        sourceMessageIdsJson: JSON.stringify(input.sourceMessageIds),
        sourceArtifactIdsJson: JSON.stringify(input.sourceArtifactIds),
        sourceRunIdsJson: JSON.stringify(input.sourceRunIds),
        sourceDiscussionIdsJson: JSON.stringify(input.sourceDiscussionIds)
      });
      if (input.supersedesMemoryId) {
        const changed = this.database.prepare(`
          UPDATE memory_entries
          SET state = 'superseded', revision = ?, updated_at = ?
          WHERE memory_id = ? AND scope_kind = ? AND scope_id = ?
            AND state = 'active'
        `).run(
          revision - 1,
          input.createdAt,
          input.supersedesMemoryId,
          input.scopeKind,
          input.scopeId
        );
        if (changed.changes !== 1) {
          throw new Error("Memory supersession target is no longer active");
        }
      }
      const created = this.get(input.memoryId);
      if (!created) throw new Error(`Memory entry not found: ${input.memoryId}`);
      return created;
    });
  }

  public retract(memoryId: string, now: string): MemoryEntryRecord {
    return this.transactions.immediate(() => {
      const current = this.get(memoryId);
      if (!current) throw new Error(`Memory entry not found: ${memoryId}`);
      if (current.state === "retracted") return current;
      if (current.state !== "active") {
        throw new Error(`Memory entry is ${current.state}`);
      }
      const revision = this.advanceScope(current.scopeKind, current.scopeId, 1);
      this.database.prepare(`
        UPDATE memory_entries
        SET state = 'retracted', revision = ?, updated_at = ?
        WHERE memory_id = ? AND state = 'active'
      `).run(revision, now, memoryId);
      const retracted = this.get(memoryId);
      if (!retracted) throw new Error(`Memory entry not found: ${memoryId}`);
      return retracted;
    });
  }

  public contextScope(
    scopeKind: MemoryScopeKind,
    scopeId: string,
    activeLimit = 16,
    tombstoneLimit = 8
  ): MemoryContextScope | undefined {
    const revision = this.scopeRevision(scopeKind, scopeId);
    if (revision === 0) return undefined;
    const activeCount = this.database.prepare(`
      SELECT count(*) AS count FROM memory_entries
      WHERE scope_kind = ? AND scope_id = ? AND state = 'active'
    `).get(scopeKind, scopeId) as { count: number };
    const active = this.database.prepare(`
      SELECT * FROM memory_entries
      WHERE scope_kind = ? AND scope_id = ? AND state = 'active'
      ORDER BY
        CASE entry_type
          WHEN 'constraint' THEN 0
          WHEN 'goal' THEN 0
          WHEN 'decision' THEN 1
          WHEN 'acceptance_criterion' THEN 1
          WHEN 'convention' THEN 2
          WHEN 'blocker' THEN 2
          ELSE 3
        END,
        revision DESC
      LIMIT ?
    `).all(scopeKind, scopeId, activeLimit) as MemoryEntryRow[];
    const inactive = this.database.prepare(`
      SELECT * FROM memory_entries
      WHERE scope_kind = ? AND scope_id = ? AND state <> 'active'
      ORDER BY revision DESC
      LIMIT ?
    `).all(scopeKind, scopeId, tombstoneLimit) as MemoryEntryRow[];
    return {
      revision,
      activeComplete: activeCount.count <= activeLimit,
      entries: [...active, ...inactive]
        .map(mapEntry)
        .sort((left, right) => left.revision - right.revision)
    };
  }

  private advanceScope(
    scopeKind: MemoryScopeKind,
    scopeId: string,
    step: number
  ): number {
    const row = scopeKind === "room"
      ? this.database.prepare(`
          UPDATE rooms SET memory_revision = memory_revision + ?
          WHERE room_id = ? RETURNING memory_revision AS revision
        `).get(step, scopeId)
      : this.database.prepare(`
          UPDATE agent_tasks
          SET long_term_memory_revision = long_term_memory_revision + ?
          WHERE task_id = ? RETURNING long_term_memory_revision AS revision
        `).get(step, scopeId);
    if (!row) throw new Error(`Memory scope not found: ${scopeId}`);
    return (row as { revision: number }).revision;
  }

  private scopeRevision(scopeKind: MemoryScopeKind, scopeId: string): number {
    const row = scopeKind === "room"
      ? this.database.prepare(`
          SELECT memory_revision AS revision FROM rooms WHERE room_id = ?
        `).get(scopeId)
      : this.database.prepare(`
          SELECT long_term_memory_revision AS revision
          FROM agent_tasks WHERE task_id = ?
        `).get(scopeId);
    if (!row) throw new Error(`Memory scope not found: ${scopeId}`);
    return (row as { revision: number }).revision;
  }
}
