import type Database from "better-sqlite3";

import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";

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
  title: string;
  summary: string;
  sourceRunId: string | null;
  createdByMemberId: string | null;
  createdByAgentId: string | null;
  createdAt: string;
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
  title: string;
  summary: string;
  source_run_id: string | null;
  created_by_member_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
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
    title: row.title,
    summary: row.summary,
    sourceRunId: row.source_run_id,
    createdByMemberId: row.created_by_member_id,
    createdByAgentId: row.created_by_agent_id,
    createdAt: row.created_at
  };
}

export class ArtifactRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public create(record: TaskArtifactRecord): {
    artifact: TaskArtifactRecord;
    revision: number;
  } {
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
          source_run_id, created_by_member_id, created_by_agent_id, created_at
        ) VALUES (
          @artifactId, @artifactRevision, @taskId, @roomId, @type, @workspaceRef,
          @repository, @path, @commitSha, @branch, @title, @summary,
          @sourceRunId, @createdByMemberId, @createdByAgentId, @createdAt
        )
      `).run({ ...record, artifactRevision: revisionRow.artifact_revision });
      const artifact = { ...record, artifactRevision: revisionRow.artifact_revision };
      return { artifact, revision: artifact.artifactRevision };
    });
  }

  public listForTask(taskId: string, limit: number): TaskArtifactRecord[] {
    return (this.database.prepare(`
      SELECT * FROM task_artifact_refs
      WHERE task_id = ?
      ORDER BY artifact_revision DESC
      LIMIT ?
    `).all(taskId, limit) as TaskArtifactRow[]).map(mapArtifact);
  }

  public listAfterRevision(
    taskId: string,
    afterRevision: number,
    limit: number
  ): TaskArtifactRecord[] {
    return (this.database.prepare(`
      SELECT * FROM task_artifact_refs
      WHERE task_id = ? AND artifact_revision > ?
      ORDER BY artifact_revision
      LIMIT ?
    `).all(taskId, afterRevision, limit) as TaskArtifactRow[]).map(mapArtifact);
  }

  public getRevision(taskId: string): number {
    const row = this.database.prepare(`
      SELECT artifact_revision FROM agent_tasks WHERE task_id = ?
    `).get(taskId) as { artifact_revision: number } | undefined;
    if (!row) throw new Error(`Task not found: ${taskId}`);
    return row.artifact_revision;
  }
}
