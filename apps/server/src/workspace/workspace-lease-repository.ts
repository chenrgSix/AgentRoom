import type Database from "better-sqlite3";

import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";

export interface WorkspaceLeaseRecord {
  leaseId: string;
  idempotencyKey: string;
  teamId: string;
  roomId: string;
  taskId: string;
  runId: string;
  agentId: string;
  deviceId: string;
  workspaceRef: string;
  workspaceGeneration: string;
  mode: "read_source";
  state: "active" | "released";
  issuedAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

interface WorkspaceLeaseRow {
  lease_id: string;
  idempotency_key: string;
  team_id: string;
  room_id: string;
  task_id: string;
  run_id: string;
  agent_id: string;
  device_id: string;
  workspace_ref: string;
  workspace_generation: string;
  mode: WorkspaceLeaseRecord["mode"];
  state: WorkspaceLeaseRecord["state"];
  issued_at: string;
  expires_at: string;
  released_at: string | null;
}

function mapLease(row: WorkspaceLeaseRow): WorkspaceLeaseRecord {
  return {
    leaseId: row.lease_id,
    idempotencyKey: row.idempotency_key,
    teamId: row.team_id,
    roomId: row.room_id,
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    deviceId: row.device_id,
    workspaceRef: row.workspace_ref,
    workspaceGeneration: row.workspace_generation,
    mode: row.mode,
    state: row.state,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at
  };
}

export class WorkspaceLeaseRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public get(leaseId: string): WorkspaceLeaseRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM workspace_leases WHERE lease_id = ?
    `).get(leaseId) as WorkspaceLeaseRow | undefined;
    return row && mapLease(row);
  }

  public getByIdempotency(
    deviceId: string,
    idempotencyKey: string
  ): WorkspaceLeaseRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM workspace_leases
      WHERE device_id = ? AND idempotency_key = ?
    `).get(deviceId, idempotencyKey) as WorkspaceLeaseRow | undefined;
    return row && mapLease(row);
  }

  public create(record: WorkspaceLeaseRecord): WorkspaceLeaseRecord {
    return this.transactions.immediate(() => {
      const existing = this.getByIdempotency(
        record.deviceId,
        record.idempotencyKey
      );
      if (existing) return existing;
      this.database.prepare(`
        INSERT INTO workspace_leases (
          lease_id, idempotency_key, team_id, room_id, task_id, run_id,
          agent_id, device_id, workspace_ref, workspace_generation, mode,
          state, issued_at, expires_at, released_at
        ) VALUES (
          @leaseId, @idempotencyKey, @teamId, @roomId, @taskId, @runId,
          @agentId, @deviceId, @workspaceRef, @workspaceGeneration, @mode,
          @state, @issuedAt, @expiresAt, @releasedAt
        )
      `).run(record);
      return record;
    });
  }

  public release(leaseId: string, releasedAt: string): WorkspaceLeaseRecord {
    return this.transactions.immediate(() => {
      const existing = this.get(leaseId);
      if (!existing) throw new Error(`Workspace lease not found: ${leaseId}`);
      if (existing.state === "released") return existing;
      this.database.prepare(`
        UPDATE workspace_leases
        SET state = 'released', released_at = ?
        WHERE lease_id = ? AND state = 'active'
      `).run(releasedAt, leaseId);
      return this.get(leaseId)!;
    });
  }
}
