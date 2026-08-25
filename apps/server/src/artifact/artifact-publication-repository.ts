import type Database from "better-sqlite3";

import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";

export type ArtifactPublicationState =
  | "prepared"
  | "receiving"
  | "sealed"
  | "bound"
  | "failed"
  | "expired";

export interface ArtifactContentRecord {
  contentId: string;
  teamId: string;
  sha256: string;
  sizeBytes: number;
  storageKey: string;
  sealedAt: string;
}

export interface ArtifactPublicationRecord {
  publicationId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  teamId: string;
  deviceId: string;
  leaseId: string;
  roomId: string;
  taskId: string;
  runId: string;
  agentId: string;
  workspaceRef: string;
  workspaceGeneration: string;
  artifactType: "patch" | "test_result" | "document";
  fileName: string;
  mediaType: "text/x-diff" | "text/markdown" | "application/json";
  title: string;
  summary: string;
  declaredSize: number;
  declaredSha256: string;
  receivedSize: number;
  state: ArtifactPublicationState;
  tempStorageKey: string;
  contentId: string | null;
  artifactId: string | null;
  failureCode: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface ArtifactPublicationRow {
  publication_id: string;
  request_fingerprint: string;
  idempotency_key: string;
  team_id: string;
  device_id: string;
  lease_id: string;
  room_id: string;
  task_id: string;
  run_id: string;
  agent_id: string;
  workspace_ref: string;
  workspace_generation: string;
  artifact_type: ArtifactPublicationRecord["artifactType"];
  file_name: string;
  media_type: ArtifactPublicationRecord["mediaType"];
  title: string;
  summary: string;
  declared_size: number;
  declared_sha256: string;
  received_size: number;
  state: ArtifactPublicationState;
  temp_storage_key: string;
  content_id: string | null;
  artifact_id: string | null;
  failure_code: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface ArtifactContentRow {
  content_id: string;
  team_id: string;
  sha256: string;
  size_bytes: number;
  storage_key: string;
  sealed_at: string;
}

function mapPublication(row: ArtifactPublicationRow): ArtifactPublicationRecord {
  return {
    publicationId: row.publication_id,
    requestFingerprint: row.request_fingerprint,
    idempotencyKey: row.idempotency_key,
    teamId: row.team_id,
    deviceId: row.device_id,
    leaseId: row.lease_id,
    roomId: row.room_id,
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    workspaceRef: row.workspace_ref,
    workspaceGeneration: row.workspace_generation,
    artifactType: row.artifact_type,
    fileName: row.file_name,
    mediaType: row.media_type,
    title: row.title,
    summary: row.summary,
    declaredSize: row.declared_size,
    declaredSha256: row.declared_sha256,
    receivedSize: row.received_size,
    state: row.state,
    tempStorageKey: row.temp_storage_key,
    contentId: row.content_id,
    artifactId: row.artifact_id,
    failureCode: row.failure_code,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapContent(row: ArtifactContentRow): ArtifactContentRecord {
  return {
    contentId: row.content_id,
    teamId: row.team_id,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    storageKey: row.storage_key,
    sealedAt: row.sealed_at
  };
}

export class ArtifactPublicationRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public get(publicationId: string): ArtifactPublicationRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM artifact_publications WHERE publication_id = ?
    `).get(publicationId) as ArtifactPublicationRow | undefined;
    return row && mapPublication(row);
  }

  public getByIdempotency(
    deviceId: string,
    idempotencyKey: string
  ): ArtifactPublicationRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM artifact_publications
      WHERE device_id = ? AND idempotency_key = ?
    `).get(deviceId, idempotencyKey) as ArtifactPublicationRow | undefined;
    return row && mapPublication(row);
  }

  public create(record: ArtifactPublicationRecord): ArtifactPublicationRecord {
    return this.transactions.immediate(() => {
      const existing = this.getByIdempotency(
        record.deviceId,
        record.idempotencyKey
      );
      if (existing) return existing;
      this.database.prepare(`
        INSERT INTO artifact_publications (
          publication_id, request_fingerprint, idempotency_key, team_id,
          device_id, lease_id, room_id, task_id, run_id, agent_id,
          workspace_ref, workspace_generation, artifact_type, file_name,
          media_type, title, summary, declared_size, declared_sha256,
          received_size, state, temp_storage_key, content_id, artifact_id,
          failure_code, expires_at, created_at, updated_at
        ) VALUES (
          @publicationId, @requestFingerprint, @idempotencyKey, @teamId,
          @deviceId, @leaseId, @roomId, @taskId, @runId, @agentId,
          @workspaceRef, @workspaceGeneration, @artifactType, @fileName,
          @mediaType, @title, @summary, @declaredSize, @declaredSha256,
          @receivedSize, @state, @tempStorageKey, @contentId, @artifactId,
          @failureCode, @expiresAt, @createdAt, @updatedAt
        )
      `).run(record);
      return record;
    });
  }

  public advanceReceived(
    publicationId: string,
    expectedOffset: number,
    nextOffset: number,
    now: string
  ): ArtifactPublicationRecord {
    const result = this.database.prepare(`
      UPDATE artifact_publications
      SET received_size = ?, state = 'receiving', updated_at = ?
      WHERE publication_id = ? AND received_size = ?
        AND state IN ('prepared', 'receiving')
    `).run(nextOffset, now, publicationId, expectedOffset);
    if (result.changes !== 1) {
      throw new Error("Artifact publication offset changed concurrently");
    }
    return this.get(publicationId)!;
  }

  public markExpired(publicationId: string, now: string): ArtifactPublicationRecord {
    this.database.prepare(`
      UPDATE artifact_publications
      SET state = 'expired', updated_at = ?
      WHERE publication_id = ? AND state IN ('prepared', 'receiving')
    `).run(now, publicationId);
    return this.get(publicationId)!;
  }

  public markFailed(
    publicationId: string,
    failureCode: string,
    now: string
  ): ArtifactPublicationRecord {
    this.database.prepare(`
      UPDATE artifact_publications
      SET state = 'failed', failure_code = ?, updated_at = ?
      WHERE publication_id = ? AND state IN ('prepared', 'receiving')
    `).run(failureCode, now, publicationId);
    return this.get(publicationId)!;
  }

  public seal(
    publicationId: string,
    content: ArtifactContentRecord,
    now: string
  ): { publication: ArtifactPublicationRecord; content: ArtifactContentRecord } {
    return this.transactions.immediate(() => {
      let stored = this.findContent(
        content.teamId,
        content.sha256,
        content.sizeBytes
      );
      if (!stored) {
        this.database.prepare(`
          INSERT INTO artifact_contents (
            content_id, team_id, sha256, size_bytes, storage_key, sealed_at
          ) VALUES (
            @contentId, @teamId, @sha256, @sizeBytes, @storageKey, @sealedAt
          )
        `).run(content);
        stored = content;
      }
      const result = this.database.prepare(`
        UPDATE artifact_publications
        SET state = 'sealed', content_id = ?, updated_at = ?
        WHERE publication_id = ? AND state IN ('prepared', 'receiving')
          AND received_size = declared_size
          AND declared_sha256 = ? AND declared_size = ? AND team_id = ?
      `).run(
        stored.contentId,
        now,
        publicationId,
        stored.sha256,
        stored.sizeBytes,
        stored.teamId
      );
      if (result.changes !== 1) {
        throw new Error("Artifact publication cannot seal from its current state");
      }
      return { publication: this.get(publicationId)!, content: stored };
    });
  }

  public getContent(contentId: string): ArtifactContentRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM artifact_contents WHERE content_id = ?
    `).get(contentId) as ArtifactContentRow | undefined;
    return row && mapContent(row);
  }

  public findContent(
    teamId: string,
    sha256: string,
    sizeBytes: number
  ): ArtifactContentRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM artifact_contents
      WHERE team_id = ? AND sha256 = ? AND size_bytes = ?
    `).get(teamId, sha256, sizeBytes) as ArtifactContentRow | undefined;
    return row && mapContent(row);
  }

  public reservedBytes(teamId: string): number {
    const row = this.database.prepare(`
      SELECT
        COALESCE((
          SELECT SUM(size_bytes) FROM artifact_contents WHERE team_id = ?
        ), 0) +
        COALESCE((
          SELECT SUM(declared_size) FROM artifact_publications
          WHERE team_id = ? AND state IN ('prepared', 'receiving')
        ), 0) AS bytes
    `).get(teamId, teamId) as { bytes: number };
    return row.bytes;
  }

  public activeUploadCount(teamId: string): number {
    const row = this.database.prepare(`
      SELECT count(*) AS count FROM artifact_publications
      WHERE team_id = ? AND state IN ('prepared', 'receiving')
    `).get(teamId) as { count: number };
    return row.count;
  }
}
