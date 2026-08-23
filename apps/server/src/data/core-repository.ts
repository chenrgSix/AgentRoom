import type Database from "better-sqlite3";

import { createOpaqueId } from "../domain/identifiers.js";

export interface WebUserRecord {
  userId: string;
  displayName: string;
  createdAt: string;
}

export interface TeamRecord {
  teamId: string;
  name: string;
  createdAt: string;
}

export interface MemberRecord {
  memberId: string;
  teamId: string;
  userId: string | null;
  displayName: string;
  role: "owner" | "member";
  createdAt: string;
}

export interface RoomRecord {
  roomId: string;
  teamId: string;
  name: string;
  createdAt: string;
}

export interface DeviceRecord {
  deviceId: string;
  teamId: string;
  ownerMemberId: string;
  name: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
}

export interface AgentCapabilities {
  supportsHandoff: boolean;
  supportsInterrupt: boolean;
  supportsResume: boolean;
  supportsStart: boolean;
  supportsStreaming: boolean;
}

export interface AgentRecord {
  agentId: string;
  teamId: string;
  ownerMemberId: string;
  deviceId: string | null;
  name: string;
  role: string;
  integrationMode: "managed" | "manual" | "fake";
  capabilities: AgentCapabilities;
  enabled: boolean;
  presence: "ready" | "busy" | "degraded" | "manual" | "offline";
  createdAt: string;
  updatedAt: string;
}

export interface MentionRecord {
  targetType: "agent";
  targetAgentId: string;
  displayLabel: string;
}

export interface MessageRecord {
  messageId: string;
  traceId: string;
  roomId: string;
  sequence: number;
  senderType: "member" | "agent" | "system";
  senderId: string;
  content: string;
  mentions: MentionRecord[];
  parentMessageId: string | null;
  createdAt: string;
}

export interface DevicePresenceRecord {
  deviceId: string;
  connectionEpoch: number;
  adapterAvailable: boolean;
  lastHeartbeatAt: string;
}

interface AgentRow {
  agent_id: string;
  team_id: string;
  owner_member_id: string;
  device_id: string | null;
  name: string;
  role: string;
  integration_mode: AgentRecord["integrationMode"];
  capabilities_json: string;
  enabled: number;
  presence: AgentRecord["presence"];
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  message_id: string;
  trace_id: string;
  room_id: string;
  sequence: number;
  sender_type: MessageRecord["senderType"];
  sender_id: string;
  content: string;
  parent_message_id: string | null;
  created_at: string;
}

function mapMessage(
  database: Database.Database,
  row: MessageRow
): MessageRecord {
  const mentions = database.prepare(`
    SELECT target_type, target_agent_id, display_label
    FROM message_mentions WHERE message_id = ? ORDER BY ordinal
  `).all(row.message_id) as Array<{
    target_type: "agent";
    target_agent_id: string;
    display_label: string;
  }>;
  return {
    messageId: row.message_id,
    traceId: row.trace_id,
    roomId: row.room_id,
    sequence: row.sequence,
    senderType: row.sender_type,
    senderId: row.sender_id,
    content: row.content,
    mentions: mentions.map((mention) => ({
      targetType: mention.target_type,
      targetAgentId: mention.target_agent_id,
      displayLabel: mention.display_label
    })),
    parentMessageId: row.parent_message_id,
    createdAt: row.created_at
  };
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    teamId: row.team_id,
    ownerMemberId: row.owner_member_id,
    deviceId: row.device_id,
    name: row.name,
    role: row.role,
    integrationMode: row.integration_mode,
    capabilities: JSON.parse(row.capabilities_json) as AgentCapabilities,
    enabled: row.enabled === 1,
    presence: row.presence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class CoreRepository {
  public constructor(private readonly database: Database.Database) {}

  public createUser(user: WebUserRecord): void {
    this.database.prepare(`
      INSERT INTO web_users (user_id, display_name, created_at)
      VALUES (@userId, @displayName, @createdAt)
    `).run(user);
  }

  public ensureUser(user: WebUserRecord): void {
    this.database.prepare(`
      INSERT INTO web_users (user_id, display_name, created_at)
      VALUES (@userId, @displayName, @createdAt)
      ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name
    `).run(user);
  }

  public getUser(userId: string): WebUserRecord | undefined {
    const row = this.database.prepare(`
      SELECT user_id, display_name, created_at FROM web_users WHERE user_id = ?
    `).get(userId) as
      | { user_id: string; display_name: string; created_at: string }
      | undefined;
    return row && {
      userId: row.user_id,
      displayName: row.display_name,
      createdAt: row.created_at
    };
  }

  public createTeamWithOwner(team: TeamRecord, owner: MemberRecord): void {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO teams (team_id, name, created_at)
        VALUES (@teamId, @name, @createdAt)
      `).run(team);
      this.database.prepare(`
        INSERT INTO team_members (
          member_id, team_id, user_id, display_name, role, created_at
        ) VALUES (
          @memberId, @teamId, @userId, @displayName, @role, @createdAt
        )
      `).run(owner);
    }).immediate();
  }

  public createMember(member: MemberRecord): void {
    this.database.prepare(`
      INSERT INTO team_members (
        member_id, team_id, user_id, display_name, role, created_at
      ) VALUES (
        @memberId, @teamId, @userId, @displayName, @role, @createdAt
      )
    `).run(member);
  }

  public createRoom(room: RoomRecord): void {
    this.database.prepare(`
      INSERT INTO rooms (room_id, team_id, name, created_at)
      VALUES (@roomId, @teamId, @name, @createdAt)
    `).run(room);
  }

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
    this.database.prepare(`
      INSERT INTO agents (
        agent_id, team_id, owner_member_id, device_id, name, role,
        integration_mode, capabilities_json, enabled, presence, created_at,
        updated_at
      ) VALUES (
        @agentId, @teamId, @ownerMemberId, @deviceId, @name, @role,
        @integrationMode, @capabilitiesJson, @enabled, @presence, @createdAt,
        @updatedAt
      )
    `).run({
      ...agent,
      capabilitiesJson: JSON.stringify(agent.capabilities),
      enabled: agent.enabled ? 1 : 0
    });
  }

  public updateAgentPublication(agent: AgentRecord): void {
    this.database.prepare(`
      UPDATE agents
      SET name = @name, role = @role, capabilities_json = @capabilitiesJson,
          enabled = @enabled, presence = @presence, updated_at = @updatedAt
      WHERE agent_id = @agentId
    `).run({
      ...agent,
      capabilitiesJson: JSON.stringify(agent.capabilities),
      enabled: agent.enabled ? 1 : 0
    });
  }

  public appendMessage(
    message: Omit<MessageRecord, "sequence" | "traceId"> & { traceId?: string }
  ): MessageRecord {
    const persistedMessage = {
      ...message,
      traceId: message.traceId ?? createOpaqueId("trace")
    };
    return this.database.transaction(() => {
      const room = this.database.prepare(`
        SELECT team_id FROM rooms WHERE room_id = ?
      `).get(persistedMessage.roomId) as { team_id: string } | undefined;
      if (!room) {
        throw new Error(`Room not found: ${persistedMessage.roomId}`);
      }

      const findAgent = this.database.prepare(`
        SELECT team_id, enabled FROM agents WHERE agent_id = ?
      `);
      for (const mention of persistedMessage.mentions) {
        const agent = findAgent.get(mention.targetAgentId) as
          | { team_id: string; enabled: number }
          | undefined;
        if (!agent || agent.team_id !== room.team_id || agent.enabled !== 1) {
          throw new Error(`Mention target is unavailable: ${mention.targetAgentId}`);
        }
      }

      const sequenceRow = this.database.prepare(`
        UPDATE rooms
        SET next_message_sequence = next_message_sequence + 1
        WHERE room_id = ?
        RETURNING next_message_sequence AS sequence
      `).get(persistedMessage.roomId) as { sequence: number };

      this.database.prepare(`
        INSERT INTO messages (
          message_id, trace_id, room_id, sequence, sender_type, sender_id, content,
          parent_message_id, created_at
        ) VALUES (
          @messageId, @traceId, @roomId, @sequence, @senderType, @senderId, @content,
          @parentMessageId, @createdAt
        )
      `).run({ ...persistedMessage, sequence: sequenceRow.sequence });

      const insertMention = this.database.prepare(`
        INSERT INTO message_mentions (
          message_id, ordinal, target_type, target_agent_id, display_label
        ) VALUES (?, ?, 'agent', ?, ?)
      `);
      for (const [ordinal, mention] of persistedMessage.mentions.entries()) {
        insertMention.run(
          persistedMessage.messageId,
          ordinal,
          mention.targetAgentId,
          mention.displayLabel
        );
      }

      return { ...persistedMessage, sequence: sequenceRow.sequence };
    }).immediate();
  }

  public getTeam(teamId: string): TeamRecord | undefined {
    const row = this.database.prepare(`
      SELECT team_id, name, created_at FROM teams WHERE team_id = ?
    `).get(teamId) as
      | { team_id: string; name: string; created_at: string }
      | undefined;
    return row && { teamId: row.team_id, name: row.name, createdAt: row.created_at };
  }

  public listTeamsForUser(userId: string): TeamRecord[] {
    const rows = this.database.prepare(`
      SELECT t.team_id, t.name, t.created_at
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.team_id
      WHERE tm.user_id = ?
      ORDER BY t.created_at, t.team_id
    `).all(userId) as Array<{
      team_id: string;
      name: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      teamId: row.team_id,
      name: row.name,
      createdAt: row.created_at
    }));
  }

  public getMember(memberId: string): MemberRecord | undefined {
    const row = this.database.prepare(`
      SELECT member_id, team_id, user_id, display_name, role, created_at
      FROM team_members WHERE member_id = ?
    `).get(memberId) as
      | {
          member_id: string;
          team_id: string;
          user_id: string | null;
          display_name: string;
          role: MemberRecord["role"];
          created_at: string;
        }
      | undefined;
    return row && {
      memberId: row.member_id,
      teamId: row.team_id,
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at
    };
  }

  public listMembers(teamId: string): MemberRecord[] {
    const rows = this.database.prepare(`
      SELECT member_id, team_id, user_id, display_name, role, created_at
      FROM team_members WHERE team_id = ? ORDER BY created_at, member_id
    `).all(teamId) as Array<{
      member_id: string;
      team_id: string;
      user_id: string | null;
      display_name: string;
      role: MemberRecord["role"];
      created_at: string;
    }>;
    return rows.map((row) => ({
      memberId: row.member_id,
      teamId: row.team_id,
      userId: row.user_id,
      displayName: row.display_name,
      role: row.role,
      createdAt: row.created_at
    }));
  }

  public getRoom(roomId: string): RoomRecord | undefined {
    const row = this.database.prepare(`
      SELECT room_id, team_id, name, created_at FROM rooms WHERE room_id = ?
    `).get(roomId) as
      | { room_id: string; team_id: string; name: string; created_at: string }
      | undefined;
    return row && {
      roomId: row.room_id,
      teamId: row.team_id,
      name: row.name,
      createdAt: row.created_at
    };
  }

  public listRooms(teamId: string): RoomRecord[] {
    const rows = this.database.prepare(`
      SELECT room_id, team_id, name, created_at
      FROM rooms WHERE team_id = ? ORDER BY created_at, room_id
    `).all(teamId) as Array<{
      room_id: string;
      team_id: string;
      name: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      roomId: row.room_id,
      teamId: row.team_id,
      name: row.name,
      createdAt: row.created_at
    }));
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
    return this.database.transaction(() => {
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
    }).immediate();
  }

  public getAgent(agentId: string): AgentRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM agents WHERE agent_id = ?
    `).get(agentId) as AgentRow | undefined;
    return row && mapAgent(row);
  }

  public listAgents(teamId: string): AgentRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM agents WHERE team_id = ? ORDER BY created_at, agent_id
    `).all(teamId) as AgentRow[];
    return rows.map(mapAgent);
  }

  public recordDevicePresence(record: DevicePresenceRecord): void {
    const existing = this.getDevicePresence(record.deviceId);
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

  public getDevicePresence(deviceId: string): DevicePresenceRecord | undefined {
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

  public getMessage(messageId: string): MessageRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM messages WHERE message_id = ?
    `).get(messageId) as MessageRow | undefined;
    if (!row) {
      return undefined;
    }
    return mapMessage(this.database, row);
  }

  public findAgentReply(
    parentMessageId: string,
    agentId: string
  ): MessageRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM messages
      WHERE parent_message_id = ? AND sender_type = 'agent' AND sender_id = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(parentMessageId, agentId) as MessageRow | undefined;
    return row && mapMessage(this.database, row);
  }

  public listMessagesAfter(
    roomId: string,
    sequence: number,
    limit: number
  ): MessageRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM messages
      WHERE room_id = ? AND sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(roomId, sequence, limit) as MessageRow[];
    return rows.map((row) => mapMessage(this.database, row));
  }

  public listMessagesThrough(
    roomId: string,
    sequence: number,
    limit: number
  ): MessageRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE room_id = ? AND sequence <= ?
        ORDER BY sequence DESC
        LIMIT ?
      ) ORDER BY sequence
    `).all(roomId, sequence, limit) as MessageRow[];
    return rows.map((row) => mapMessage(this.database, row));
  }

  public latestMessageSequence(roomId: string): number {
    const row = this.database.prepare(`
      SELECT next_message_sequence AS sequence FROM rooms WHERE room_id = ?
    `).get(roomId) as { sequence: number } | undefined;
    if (!row) {
      throw new Error(`Room not found: ${roomId}`);
    }
    return row.sequence;
  }
}
