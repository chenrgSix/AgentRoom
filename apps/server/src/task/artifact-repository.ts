import type Database from "better-sqlite3";

import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  type ArtifactRelationInput,
  normalizeArtifactRelations,
  type TaskArtifactRelationRecord
} from "./artifact-lineage.js";

export type ArtifactType =
  | "commit"
  | "branch"
  | "file"
  | "patch"
  | "test_result"
  | "document";

export interface TaskArtifactRecord {
  artifactId: string;
  artifactRevision: number;
  taskId: string;
  roomId: string;
  type: ArtifactType;
  workspaceRef: string | null;
  repository: string | null;
  path: string | null;
  commitSha: string | null;
  branch: string | null;
  contentMode: "reference_only" | "snapshot_blob";
  contentId: string | null;
  contentPublicationId: string | null;
  contentSizeBytes: number | null;
  contentMediaType:
    | "text/x-diff"
    | "text/markdown"
    | "application/json"
    | "application/x-git-bundle"
    | null;
  contentSha256: string | null;
  title: string;
  summary: string;
  sourceRunId: string | null;
  createdByMemberId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
  relations: TaskArtifactRelationRecord[];
}

interface TaskArtifactRow {
  artifact_id: string;
  artifact_revision: number;
  task_id: string;
  room_id: string;
  artifact_type: ArtifactType;
  workspace_ref: string | null;
  repository_ref: string | null;
  path_ref: string | null;
  commit_sha: string | null;
  branch_ref: string | null;
  content_mode: TaskArtifactRecord["contentMode"];
  content_id: string | null;
  content_publication_id: string | null;
  content_size_bytes: number | null;
  content_media_type: TaskArtifactRecord["contentMediaType"];
  content_sha256: string | null;
  title: string;
  summary: string;
  source_run_id: string | null;
  created_by_member_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
}

interface TaskArtifactRelationRow {
  relation_id: string;
  source_artifact_id: string;
  target_artifact_id: string;
  task_id: string;
  room_id: string;
  relation_type: TaskArtifactRelationRecord["type"];
  created_by_member_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
}

function mapRelation(row: TaskArtifactRelationRow): TaskArtifactRelationRecord {
  return {
    relationId: row.relation_id,
    sourceArtifactId: row.source_artifact_id,
    targetArtifactId: row.target_artifact_id,
    taskId: row.task_id,
    roomId: row.room_id,
    type: row.relation_type,
    createdByMemberId: row.created_by_member_id,
    createdByAgentId: row.created_by_agent_id,
    createdAt: row.created_at
  };
}

function mapArtifact(row: TaskArtifactRow): TaskArtifactRecord {
  return {
    artifactId: row.artifact_id,
    artifactRevision: row.artifact_revision,
    taskId: row.task_id,
    roomId: row.room_id,
    type: row.artifact_type,
    workspaceRef: row.workspace_ref,
    repository: row.repository_ref,
    path: row.path_ref,
    commitSha: row.commit_sha,
    branch: row.branch_ref,
    contentMode: row.content_mode,
    contentId: row.content_id,
    contentPublicationId: row.content_publication_id,
    contentSizeBytes: row.content_size_bytes,
    contentMediaType: row.content_media_type,
    contentSha256: row.content_sha256,
    title: row.title,
    summary: row.summary,
    sourceRunId: row.source_run_id,
    createdByMemberId: row.created_by_member_id,
    createdByAgentId: row.created_by_agent_id,
    createdAt: row.created_at,
    relations: []
  };
}

export class ArtifactRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public get(artifactId: string): TaskArtifactRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM task_artifact_refs WHERE artifact_id = ?
    `).get(artifactId) as TaskArtifactRow | undefined;
    return row && this.withRelations(mapArtifact(row));
  }

  public create(
    record: TaskArtifactRecord,
    requestedRelations: readonly ArtifactRelationInput[] = []
  ): {
    artifact: TaskArtifactRecord;
    revision: number;
  } {
    const relationInputs = normalizeArtifactRelations(requestedRelations);
    return this.transactions.immediate(() => {
      const revisionRow = this.database.prepare(`
        UPDATE agent_tasks
        SET artifact_revision = artifact_revision + 1, updated_at = @createdAt
        WHERE task_id = @taskId
        RETURNING artifact_revision
      `).get(record) as { artifact_revision: number } | undefined;
      if (!revisionRow) throw new Error(`Task not found: ${record.taskId}`);
      this.database.prepare(`
        INSERT INTO task_artifact_refs (
          artifact_id, artifact_revision, task_id, room_id, artifact_type, workspace_ref,
          repository_ref, path_ref, commit_sha, branch_ref, title, summary,
          content_mode, content_id, content_publication_id, content_size_bytes,
          content_media_type, content_sha256, source_run_id, created_by_member_id,
          created_by_agent_id, created_at
        ) VALUES (
          @artifactId, @artifactRevision, @taskId, @roomId, @type, @workspaceRef,
          @repository, @path, @commitSha, @branch, @title, @summary,
          @contentMode, @contentId, @contentPublicationId, @contentSizeBytes,
          @contentMediaType, @contentSha256, @sourceRunId, @createdByMemberId,
          @createdByAgentId, @createdAt
        )
      `).run({ ...record, artifactRevision: revisionRow.artifact_revision });
      const artifact = {
        ...record,
        artifactRevision: revisionRow.artifact_revision,
        relations: relationInputs.map((relation) => {
          const created: TaskArtifactRelationRecord = {
            relationId: createOpaqueId("relation"),
            sourceArtifactId: record.artifactId,
            targetArtifactId: relation.targetArtifactId,
            taskId: record.taskId,
            roomId: record.roomId,
            type: relation.type,
            createdByMemberId: record.createdByMemberId,
            createdByAgentId: record.createdByAgentId,
            createdAt: record.createdAt
          };
          this.database.prepare(`
            INSERT INTO task_artifact_relations (
              relation_id, source_artifact_id, target_artifact_id,
              task_id, room_id, relation_type, created_by_member_id,
              created_by_agent_id, created_at
            ) VALUES (
              @relationId, @sourceArtifactId, @targetArtifactId,
              @taskId, @roomId, @type, @createdByMemberId,
              @createdByAgentId, @createdAt
            )
          `).run(created);
          return created;
        })
      };
      return { artifact, revision: artifact.artifactRevision };
    });
  }

  public listForTask(
    taskId: string,
    limit: number,
    throughRevision?: number
  ): TaskArtifactRecord[] {
    return (this.database.prepare(`
      SELECT * FROM task_artifact_refs
      WHERE task_id = ? AND artifact_revision <= ?
      ORDER BY artifact_revision DESC
      LIMIT ?
    `).all(
      taskId,
      throughRevision ?? Number.MAX_SAFE_INTEGER,
      limit
    ) as TaskArtifactRow[]).map((row) => this.withRelations(mapArtifact(row)));
  }

  public listAfterRevision(
    taskId: string,
    afterRevision: number,
    limit: number,
    throughRevision?: number
  ): TaskArtifactRecord[] {
    return (this.database.prepare(`
      SELECT * FROM task_artifact_refs
      WHERE task_id = ? AND artifact_revision > ? AND artifact_revision <= ?
      ORDER BY artifact_revision
      LIMIT ?
    `).all(
      taskId,
      afterRevision,
      throughRevision ?? Number.MAX_SAFE_INTEGER,
      limit
    ) as TaskArtifactRow[]).map((row) => this.withRelations(mapArtifact(row)));
  }

  public getRevision(taskId: string): number {
    const row = this.database.prepare(`
      SELECT artifact_revision FROM agent_tasks WHERE task_id = ?
    `).get(taskId) as { artifact_revision: number } | undefined;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return row.artifact_revision;
  }

  private withRelations(artifact: TaskArtifactRecord): TaskArtifactRecord {
    const rows = this.database.prepare(`
      SELECT * FROM task_artifact_relations
      WHERE source_artifact_id = ?
      ORDER BY target_artifact_id, relation_type, relation_id
    `).all(artifact.artifactId) as TaskArtifactRelationRow[];
    return { ...artifact, relations: rows.map(mapRelation) };
  }
}
