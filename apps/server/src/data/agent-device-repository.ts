import type Database from "better-sqlite3";

import type {
  AgentCapabilities,
  AgentRecord,
  DevicePresenceRecord,
  DeviceRecord
} from "./core-repository.js";
import { SqliteTransactionBoundary } from "./sqlite-transaction-boundary.js";

interface AgentRow {
  agent_id: string;
  team_id: string;
  owner_member_id: string;
  device_id: string | null;
  name: string;
  role: string;
  integration_mode: AgentRecord["integrationMode"];
  capabilities_json: string;
  runtime_scope_id: string | null;
  workspace_ref: string | null;
  workspace_generation: string | null;
  enabled: number;
  presence: AgentRecord["presence"];
  created_at: string;
  updated_at: string;
}

export class AgentDeviceRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public createDevice(device: DeviceRecord): void {
    this.database.prepare(`
      INSERT INTO devices (
        device_id, team_id, owner_member_id, name, status, created_at, revoked_at
      ) VALUES (
        @deviceId, @teamId, @ownerMemberId, @name, @status, @createdAt, @revokedAt
      )
    `).run(device);
  }

  public createAgent(agent: AgentRecord): void {
    this.transactions.immediate(() => {
      this.database.prepare(`
        INSERT INTO agents (
          agent_id, team_id, owner_member_id, device_id, name, role,
          integration_mode, capabilities_json, runtime_scope_id, workspace_ref,
          workspace_generation, enabled,
          presence, created_at, updated_at
        ) VALUES (
          @agentId, @teamId, @ownerMemberId, @deviceId, @name, @role,
          @integrationMode, @capabilitiesJson, @runtimeScopeId, @workspaceRef,
          @workspaceGeneration, @enabled,
          @presence, @createdAt, @updatedAt
        )
      `).run({
        ...agent,
        runtimeScopeId: agent.runtimeScopeId ?? null,
        workspaceRef: agent.workspaceRef ?? null,
        workspaceGeneration: agent.workspaceGeneration ?? null,
        capabilitiesJson: JSON.stringify(agent.capabilities),
        enabled: agent.enabled ? 1 : 0
      });
      if (agent.enabled) {
        this.database.prepare(`
          INSERT INTO room_agent_participants (room_id, agent_id, added_at)
          SELECT room_id, @agentId, @createdAt FROM rooms WHERE team_id = @teamId
        `).run(agent);
        this.database.prepare(`
          UPDATE rooms SET settings_revision = settings_revision + 1
          WHERE team_id = @teamId
        `).run(agent);
      }
    });
  }

  public updateAgentPublication(agent: AgentRecord): void {
    this.database.prepare(`
      UPDATE agents
      SET name = @name, role = @role, capabilities_json = @capabilitiesJson,
          runtime_scope_id = @runtimeScopeId, workspace_ref = @workspaceRef,
          workspace_generation = @workspaceGeneration, enabled = @enabled,
          presence = @presence, updated_at = @updatedAt
      WHERE agent_id = @agentId
    `).run({
      ...agent,
      runtimeScopeId: agent.runtimeScopeId ?? null,
      workspaceRef: agent.workspaceRef ?? null,
      workspaceGeneration: agent.workspaceGeneration ?? null,
      capabilitiesJson: JSON.stringify(agent.capabilities),
      enabled: agent.enabled ? 1 : 0
    });
  }

  public hasActiveWork(agentId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM runs
        WHERE target_agent_id = ?
          AND state NOT IN (
            'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
          )
      ) OR EXISTS (
        SELECT 1
        FROM discussion_participants participant
        JOIN discussions discussion
          ON discussion.discussion_id = participant.discussion_id
        WHERE participant.agent_id = ?
          AND discussion.state NOT IN ('completed', 'canceled', 'terminated')
      )
    `).get(agentId, agentId));
  }

  public getDevice(deviceId: string): DeviceRecord | undefined {
    const row = this.database.prepare(`
      SELECT device_id, team_id, owner_member_id, name, status, created_at,
             revoked_at
      FROM devices WHERE device_id = ?
    `).get(deviceId) as
      | {
          device_id: string;
          team_id: string;
          owner_member_id: string;
          name: string;
          status: DeviceRecord["status"];
          created_at: string;
          revoked_at: string | null;
        }
      | undefined;
    return row && {
      deviceId: row.device_id,
      teamId: row.team_id,
      ownerMemberId: row.owner_member_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    };
  }

  public listDevices(teamId: string): DeviceRecord[] {
    const rows = this.database.prepare(`
      SELECT device_id, team_id, owner_member_id, name, status, created_at,
             revoked_at
      FROM devices WHERE team_id = ? ORDER BY created_at, device_id
    `).all(teamId) as Array<{
      device_id: string;
      team_id: string;
      owner_member_id: string;
      name: string;
      status: DeviceRecord["status"];
      created_at: string;
      revoked_at: string | null;
    }>;
    return rows.map((row) => ({
      deviceId: row.device_id,
      teamId: row.team_id,
      ownerMemberId: row.owner_member_id,
      name: row.name,
      status: row.status,
      createdAt: row.created_at,
      revokedAt: row.revoked_at
    }));
  }

  public revokeDevice(deviceId: string, now: string): DeviceRecord | undefined {
    return this.transactions.immediate(() => {
      this.database.prepare(`
        UPDATE devices SET status = 'revoked', revoked_at = ?
        WHERE device_id = ? AND status = 'active'
      `).run(now, deviceId);
      this.database.prepare(`
        UPDATE device_credentials SET revoked_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
      `).run(now, deviceId);
      this.database.prepare(`
        UPDATE agents SET presence = 'offline', enabled = 0, updated_at = ?
        WHERE device_id = ?
      `).run(now, deviceId);
      return this.getDevice(deviceId);
    });
  }

  public getAgent(agentId: string): AgentRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM agents WHERE agent_id = ?
    `).get(agentId) as AgentRow | undefined;
    return row && this.mapAgent(row);
  }

  public listAgents(teamId: string): AgentRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM agents WHERE team_id = ? ORDER BY created_at, agent_id
    `).all(teamId) as AgentRow[];
    return rows.map((row) => this.mapAgent(row));
  }

  public setAgentEnabled(
    agentId: string,
    enabled: boolean,
    now: string
  ): AgentRecord {
    const existing = this.getAgent(agentId);
    if (!existing) throw new Error(`Agent not found: ${agentId}`);
    const presence = enabled
      ? existing.integrationMode === "manual" ? "manual" : "offline"
      : "offline";
    this.database.prepare(`
      UPDATE agents
      SET enabled = ?, presence = ?, updated_at = ?
      WHERE agent_id = ?
    `).run(enabled ? 1 : 0, presence, now, agentId);
    return this.getAgent(agentId)!;
  }

  public recordPresence(record: DevicePresenceRecord): void {
    const existing = this.getPresence(record.deviceId);
    if (existing && record.connectionEpoch < existing.connectionEpoch) {
      throw new Error("Stale Device connection epoch");
    }
    this.database.prepare(`
      INSERT INTO device_presence (
        device_id, connection_epoch, adapter_available, last_heartbeat_at
      ) VALUES (@deviceId, @connectionEpoch, @adapterAvailable, @lastHeartbeatAt)
      ON CONFLICT (device_id) DO UPDATE SET
        connection_epoch = excluded.connection_epoch,
        adapter_available = excluded.adapter_available,
        last_heartbeat_at = excluded.last_heartbeat_at
    `).run({
      ...record,
      adapterAvailable: record.adapterAvailable ? 1 : 0
    });
  }

  public getPresence(deviceId: string): DevicePresenceRecord | undefined {
    const row = this.database.prepare(`
      SELECT device_id, connection_epoch, adapter_available, last_heartbeat_at
      FROM device_presence WHERE device_id = ?
    `).get(deviceId) as
      | {
          device_id: string;
          connection_epoch: number;
          adapter_available: number;
          last_heartbeat_at: string;
        }
      | undefined;
    return row && {
      deviceId: row.device_id,
      connectionEpoch: row.connection_epoch,
      adapterAvailable: row.adapter_available === 1,
      lastHeartbeatAt: row.last_heartbeat_at
    };
  }

  public updateAgentPresence(
    agentId: string,
    presence: AgentRecord["presence"],
    now: string
  ): void {
    this.database.prepare(`
      UPDATE agents SET presence = ?, updated_at = ? WHERE agent_id = ?
    `).run(presence, now, agentId);
  }

  private mapAgent(row: AgentRow): AgentRecord {
    return {
      agentId: row.agent_id,
      teamId: row.team_id,
      ownerMemberId: row.owner_member_id,
      deviceId: row.device_id,
      name: row.name,
      role: row.role,
      integrationMode: row.integration_mode,
      capabilities: JSON.parse(row.capabilities_json) as AgentCapabilities,
      runtimeScopeId: row.runtime_scope_id,
      workspaceRef: row.workspace_ref,
      workspaceGeneration: row.workspace_generation,
      enabled: row.enabled === 1,
      presence: row.presence,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
}
