import type Database from "better-sqlite3";

import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";

export type RollingRoomMode = "disabled" | "backfilling" | "ready" | "degraded";
export type RollingRoomBuildKind = "incremental" | "rebase";

export interface RollingRoomCheckpoint {
  checkpointId: string;
  roomId: string;
  parentCheckpointId: string | null;
  inputFromSequenceExclusive: number;
  throughSequence: number;
  summary: string;
  provenance: string[];
  sourceMessageCount: number;
  sourceDigest: string;
  promptVersion: number;
  modelFingerprint: string;
  buildKind: RollingRoomBuildKind;
  createdAt: string;
}

export interface RollingRoomState {
  roomId: string;
  mode: RollingRoomMode;
  latestCheckpointId: string | null;
  latestThroughSequence: number;
  desiredThroughSequence: number;
  generation: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface RollingRoomCheckpointRow {
  checkpoint_id: string;
  room_id: string;
  parent_checkpoint_id: string | null;
  input_from_sequence_exclusive: number;
  through_sequence: number;
  summary: string;
  provenance_json: string;
  source_message_count: number;
  source_digest: string;
  prompt_version: number;
  model_fingerprint: string;
  build_kind: RollingRoomBuildKind;
  created_at: string;
}

interface RollingRoomStateRow {
  room_id: string;
  mode: RollingRoomMode;
  latest_checkpoint_id: string | null;
  latest_through_sequence: number;
  desired_through_sequence: number;
  generation: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  updated_at: string;
}

function mapCheckpoint(row: RollingRoomCheckpointRow): RollingRoomCheckpoint {
  return {
    checkpointId: row.checkpoint_id,
    roomId: row.room_id,
    parentCheckpointId: row.parent_checkpoint_id,
    inputFromSequenceExclusive: row.input_from_sequence_exclusive,
    throughSequence: row.through_sequence,
    summary: row.summary,
    provenance: JSON.parse(row.provenance_json) as string[],
    sourceMessageCount: row.source_message_count,
    sourceDigest: row.source_digest,
    promptVersion: row.prompt_version,
    modelFingerprint: row.model_fingerprint,
    buildKind: row.build_kind,
    createdAt: row.created_at
  };
}

function mapState(row: RollingRoomStateRow): RollingRoomState {
  return {
    roomId: row.room_id,
    mode: row.mode,
    latestCheckpointId: row.latest_checkpoint_id,
    latestThroughSequence: row.latest_through_sequence,
    desiredThroughSequence: row.desired_through_sequence,
    generation: row.generation,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    updatedAt: row.updated_at
  };
}

function requireIsoTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a timestamp`);
  }
}

export class RollingRoomMemoryRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public getState(roomId: string): RollingRoomState | undefined {
    const row = this.database.prepare(`
      SELECT * FROM rolling_room_state WHERE room_id = ?
    `).get(roomId) as RollingRoomStateRow | undefined;
    return row && mapState(row);
  }

  public listPending(limit = 8): RollingRoomState[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Rolling Room pending limit must be between 1 and 100");
    }
    return (this.database.prepare(`
      SELECT * FROM rolling_room_state
      WHERE mode <> 'disabled'
        AND desired_through_sequence > latest_through_sequence
      ORDER BY
        desired_through_sequence - latest_through_sequence DESC,
        updated_at,
        room_id
      LIMIT ?
    `).all(limit) as RollingRoomStateRow[]).map(mapState);
  }

  public enableAll(now: string): number {
    requireIsoTimestamp(now, "now");
    return this.database.prepare(`
      UPDATE rolling_room_state
      SET mode = CASE
            WHEN latest_checkpoint_id IS NULL THEN 'backfilling'
            ELSE 'ready'
          END,
          last_error = NULL,
          updated_at = max(updated_at, ?)
      WHERE mode = 'disabled'
    `).run(now).changes;
  }

  public enable(roomId: string, now: string): RollingRoomState {
    requireIsoTimestamp(now, "now");
    const changed = this.database.prepare(`
      UPDATE rolling_room_state
      SET mode = CASE
            WHEN latest_checkpoint_id IS NULL THEN 'backfilling'
            ELSE 'ready'
          END,
          last_error = NULL,
          updated_at = max(updated_at, ?)
      WHERE room_id = ?
    `).run(now, roomId);
    if (changed.changes !== 1) {
      throw new Error(`Rolling Room state not found: ${roomId}`);
    }
    return this.requireState(roomId);
  }

  public disable(roomId: string, now: string): RollingRoomState {
    requireIsoTimestamp(now, "now");
    const changed = this.database.prepare(`
      UPDATE rolling_room_state
      SET mode = 'disabled', lease_token = NULL, lease_expires_at = NULL,
          last_error = NULL, updated_at = max(updated_at, ?)
      WHERE room_id = ?
    `).run(now, roomId);
    if (changed.changes !== 1) {
      throw new Error(`Rolling Room state not found: ${roomId}`);
    }
    return this.requireState(roomId);
  }

  public acquireLease(input: {
    roomId: string;
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }): RollingRoomState | undefined {
    requireIsoTimestamp(input.now, "now");
    requireIsoTimestamp(input.leaseExpiresAt, "leaseExpiresAt");
    if (
      input.leaseToken.trim().length < 16 || input.leaseToken.length > 160 ||
      Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)
    ) {
      throw new Error("Rolling Room lease is invalid");
    }
    const row = this.database.prepare(`
      UPDATE rolling_room_state
      SET generation = generation + 1,
          lease_token = @leaseToken,
          lease_expires_at = @leaseExpiresAt,
          updated_at = max(updated_at, @now)
      WHERE room_id = @roomId
        AND mode <> 'disabled'
        AND desired_through_sequence > latest_through_sequence
        AND (
          lease_token IS NULL OR lease_expires_at <= @now
        )
      RETURNING *
    `).get(input) as RollingRoomStateRow | undefined;
    return row && mapState(row);
  }

  public commitCheckpoint(input: {
    checkpoint: RollingRoomCheckpoint;
    expectedGeneration: number;
    leaseToken: string;
    now: string;
  }): RollingRoomCheckpoint {
    requireIsoTimestamp(input.now, "now");
    return this.transactions.immediate(() => {
      const state = this.requireState(input.checkpoint.roomId);
      if (
        state.generation !== input.expectedGeneration ||
        state.leaseToken !== input.leaseToken ||
        !state.leaseExpiresAt || state.leaseExpiresAt <= input.now
      ) {
        throw new Error("Rolling Room checkpoint lease is stale");
      }
      if (
        input.checkpoint.throughSequence > state.desiredThroughSequence ||
        input.checkpoint.throughSequence < state.latestThroughSequence
      ) {
        throw new Error("Rolling Room checkpoint is outside the desired watermark");
      }
      if (input.checkpoint.buildKind === "incremental") {
        if (
          input.checkpoint.parentCheckpointId !== state.latestCheckpointId ||
          input.checkpoint.inputFromSequenceExclusive !== state.latestThroughSequence
        ) {
          throw new Error("Incremental checkpoint must extend the current latest checkpoint");
        }
      } else if (input.checkpoint.inputFromSequenceExclusive !== 0) {
        throw new Error("Rebase checkpoint must start at sequence zero");
      }
      const expectedCount = input.checkpoint.throughSequence -
        input.checkpoint.inputFromSequenceExclusive;
      if (input.checkpoint.sourceMessageCount !== expectedCount) {
        throw new Error("Checkpoint source count does not match its input interval");
      }
      this.insertCheckpoint(input.checkpoint);
      const changed = this.database.prepare(`
        UPDATE rolling_room_state
        SET mode = 'ready',
            latest_checkpoint_id = @checkpointId,
            latest_through_sequence = @throughSequence,
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = max(updated_at, @now)
        WHERE room_id = @roomId
          AND generation = @expectedGeneration
          AND lease_token = @leaseToken
          AND latest_through_sequence = @expectedLatestThrough
      `).run({
        checkpointId: input.checkpoint.checkpointId,
        throughSequence: input.checkpoint.throughSequence,
        now: input.now,
        roomId: input.checkpoint.roomId,
        expectedGeneration: input.expectedGeneration,
        leaseToken: input.leaseToken,
        expectedLatestThrough: state.latestThroughSequence
      });
      if (changed.changes !== 1) {
        throw new Error("Rolling Room checkpoint lost its commit fence");
      }
      return input.checkpoint;
    });
  }

  public recordFailure(input: {
    roomId: string;
    expectedGeneration: number;
    leaseToken: string;
    safeError: string;
    now: string;
  }): RollingRoomState {
    requireIsoTimestamp(input.now, "now");
    const safeError = input.safeError.trim();
    if (safeError.length === 0 || safeError.length > 1000) {
      throw new Error("Rolling Room failure must be bounded");
    }
    const changed = this.database.prepare(`
      UPDATE rolling_room_state
      SET mode = 'degraded', lease_token = NULL, lease_expires_at = NULL,
          last_error = @safeError, updated_at = max(updated_at, @now)
      WHERE room_id = @roomId
        AND generation = @expectedGeneration
        AND lease_token = @leaseToken
    `).run({ ...input, safeError });
    if (changed.changes !== 1) {
      throw new Error("Rolling Room failure lost its lease fence");
    }
    return this.requireState(input.roomId);
  }

  public getCheckpoint(checkpointId: string): RollingRoomCheckpoint | undefined {
    const row = this.database.prepare(`
      SELECT * FROM rolling_room_checkpoints WHERE checkpoint_id = ?
    `).get(checkpointId) as RollingRoomCheckpointRow | undefined;
    return row && mapCheckpoint(row);
  }

  public latestAtOrBefore(
    roomId: string,
    throughSequence: number,
    createdAtOrBefore?: string
  ): RollingRoomCheckpoint | undefined {
    const row = this.database.prepare(`
      SELECT * FROM rolling_room_checkpoints
      WHERE room_id = ? AND through_sequence <= ? AND created_at <= ?
      ORDER BY through_sequence DESC, created_at DESC, checkpoint_id DESC
      LIMIT 1
    `).get(
      roomId,
      throughSequence,
      createdAtOrBefore ?? "9999-12-31T23:59:59.999Z"
    ) as RollingRoomCheckpointRow | undefined;
    return row && mapCheckpoint(row);
  }

  private insertCheckpoint(checkpoint: RollingRoomCheckpoint): void {
    if (
      checkpoint.provenance.length > 64 ||
      checkpoint.provenance.some((value) =>
        typeof value !== "string" || value.length < 8 || value.length > 160
      ) ||
      new Set(checkpoint.provenance).size !== checkpoint.provenance.length
    ) {
      throw new Error("Checkpoint provenance must contain bounded unique IDs");
    }
    if (!/^[a-f0-9]{64}$/u.test(checkpoint.sourceDigest)) {
      throw new Error("Checkpoint source digest must be lowercase SHA-256");
    }
    this.database.prepare(`
      INSERT INTO rolling_room_checkpoints (
        checkpoint_id, room_id, parent_checkpoint_id,
        input_from_sequence_exclusive, through_sequence, summary,
        provenance_json, source_message_count, source_digest, prompt_version,
        model_fingerprint, build_kind, created_at
      ) VALUES (
        @checkpointId, @roomId, @parentCheckpointId,
        @inputFromSequenceExclusive, @throughSequence, @summary,
        @provenanceJson, @sourceMessageCount, @sourceDigest, @promptVersion,
        @modelFingerprint, @buildKind, @createdAt
      )
    `).run({
      ...checkpoint,
      provenanceJson: JSON.stringify(checkpoint.provenance)
    });
  }

  private requireState(roomId: string): RollingRoomState {
    const state = this.getState(roomId);
    if (!state) throw new Error(`Rolling Room state not found: ${roomId}`);
    return state;
  }
}
