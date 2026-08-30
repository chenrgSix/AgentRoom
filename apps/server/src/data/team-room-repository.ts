import type Database from "better-sqlite3";

import {
  defaultRoomCollaborationPolicy,
  readPersistedRoomCollaborationPolicy,
  type RoomCollaborationPolicy
} from "../team-room/room-collaboration-policy.js";
import type {
  MemberRecord,
  RoomParticipants,
  RoomRecord,
  TeamRecord,
  WebUserRecord
} from "./core-repository.js";
import { SqliteTransactionBoundary } from "./sqlite-transaction-boundary.js";

interface TeamRow {
  team_id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
}

interface RoomRow {
  room_id: string;
  team_id: string;
  name: string;
  collaboration_policy_json: string;
  settings_revision: number;
  created_at: string;
  archived_at: string | null;
}

export class TeamRoomRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

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
    this.transactions.immediate(() => {
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
    });
  }

  public createMember(member: MemberRecord): void {
    this.transactions.immediate(() => {
      this.database.prepare(`
        INSERT INTO team_members (
          member_id, team_id, user_id, display_name, role, created_at
        ) VALUES (
          @memberId, @teamId, @userId, @displayName, @role, @createdAt
        )
      `).run(member);
      this.database.prepare(`
        INSERT INTO room_human_participants (room_id, member_id, added_at)
        SELECT room_id, @memberId, @createdAt FROM rooms WHERE team_id = @teamId
      `).run(member);
      this.database.prepare(`
        UPDATE rooms SET settings_revision = settings_revision + 1
        WHERE team_id = @teamId
      `).run(member);
    });
  }

  public createRoom(room: RoomRecord): void {
    this.transactions.immediate(() => {
      this.database.prepare(`
        INSERT INTO rooms (
          room_id, team_id, name, collaboration_policy_json, created_at
        ) VALUES (
          @roomId, @teamId, @name, @collaborationPolicyJson, @createdAt
        )
      `).run({
        ...room,
        collaborationPolicyJson: JSON.stringify(
          room.collaborationPolicy ?? defaultRoomCollaborationPolicy
        )
      });
      this.database.prepare(`
        INSERT INTO room_human_participants (room_id, member_id, added_at)
        SELECT @roomId, member_id, @createdAt
        FROM team_members WHERE team_id = @teamId
      `).run(room);
      this.database.prepare(`
        INSERT INTO room_agent_participants (room_id, agent_id, added_at)
        SELECT @roomId, agent_id, @createdAt
        FROM agents
        WHERE team_id = @teamId AND enabled = 1
          AND integration_mode <> 'hosted'
      `).run(room);
    });
  }

  public getTeam(teamId: string): TeamRecord | undefined {
    const row = this.database.prepare(`
      SELECT team_id, name, created_at, archived_at FROM teams WHERE team_id = ?
    `).get(teamId) as TeamRow | undefined;
    return row && this.mapTeam(row);
  }

  public listTeamsForUser(userId: string, includeArchived = false): TeamRecord[] {
    const rows = this.database.prepare(`
      SELECT t.team_id, t.name, t.created_at, t.archived_at
      FROM teams t
      JOIN team_members tm ON tm.team_id = t.team_id
      WHERE tm.user_id = ? AND (? = 1 OR t.archived_at IS NULL)
      ORDER BY t.created_at, t.team_id
    `).all(userId, includeArchived ? 1 : 0) as TeamRow[];
    return rows.map((row) => this.mapTeam(row));
  }

  public updateTeamLifecycle(
    teamId: string,
    input: { name: string; archivedAt: string | null }
  ): TeamRecord {
    this.database.prepare(`
      UPDATE teams SET name = @name, archived_at = @archivedAt
      WHERE team_id = @teamId
    `).run({ teamId, ...input });
    const team = this.getTeam(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);
    return team;
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
      SELECT room_id, team_id, name, collaboration_policy_json,
             settings_revision, created_at, archived_at
      FROM rooms WHERE room_id = ?
    `).get(roomId) as RoomRow | undefined;
    return row && this.mapRoom(row);
  }

  public listRooms(teamId: string, includeArchived = false): RoomRecord[] {
    const rows = this.database.prepare(`
      SELECT room_id, team_id, name, collaboration_policy_json,
             settings_revision, created_at, archived_at
      FROM rooms
      WHERE team_id = ? AND (? = 1 OR archived_at IS NULL)
      ORDER BY created_at, room_id
    `).all(teamId, includeArchived ? 1 : 0) as RoomRow[];
    return rows.map((row) => this.mapRoom(row));
  }

  public listRoomsForMember(
    teamId: string,
    memberId: string,
    includeArchived = false
  ): RoomRecord[] {
    const rows = this.database.prepare(`
      SELECT r.room_id, r.team_id, r.name, r.collaboration_policy_json,
             r.settings_revision, r.created_at, r.archived_at
      FROM rooms r
      JOIN room_human_participants rp ON rp.room_id = r.room_id
      WHERE r.team_id = ? AND rp.member_id = ?
        AND (? = 1 OR r.archived_at IS NULL)
      ORDER BY r.created_at, r.room_id
    `).all(teamId, memberId, includeArchived ? 1 : 0) as RoomRow[];
    return rows.map((row) => this.mapRoom(row));
  }

  public updateRoomLifecycle(
    roomId: string,
    input: { name: string; archivedAt: string | null }
  ): RoomRecord {
    this.database.prepare(`
      UPDATE rooms SET name = @name, archived_at = @archivedAt
      WHERE room_id = @roomId
    `).run({ roomId, ...input });
    const room = this.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    return room;
  }

  public replaceRoomSettings(
    roomId: string,
    participants: RoomParticipants,
    collaborationPolicy: RoomCollaborationPolicy,
    expectedRevision: number,
    updatedAt: string
  ): { participants: RoomParticipants; room: RoomRecord } {
    return this.transactions.immediate(() => {
      const update = this.database.prepare(`
        UPDATE rooms
        SET collaboration_policy_json = ?, settings_revision = settings_revision + 1
        WHERE room_id = ? AND settings_revision = ?
      `).run(JSON.stringify(collaborationPolicy), roomId, expectedRevision);
      if (update.changes !== 1) {
        throw new Error("Room settings changed; reload and retry");
      }
      this.replaceParticipantRows(roomId, participants, updatedAt);
      const room = this.getRoom(roomId);
      if (!room) throw new Error(`Room not found: ${roomId}`);
      return { participants: this.getRoomParticipants(roomId), room };
    });
  }

  public hasActiveWorkForRoom(roomId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM rooms r
      WHERE r.room_id = ? AND (
        EXISTS (
          SELECT 1 FROM runs run
          WHERE run.room_id = r.room_id
            AND run.state NOT IN (
              'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
            )
        ) OR EXISTS (
          SELECT 1 FROM discussions discussion
          WHERE discussion.room_id = r.room_id
            AND discussion.state NOT IN ('completed', 'canceled', 'terminated')
        )
      )
    `).get(roomId));
  }

  public hasActiveWorkForTeam(teamId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM rooms r
      WHERE r.team_id = ? AND (
        EXISTS (
          SELECT 1 FROM runs run
          WHERE run.room_id = r.room_id
            AND run.state NOT IN (
              'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
            )
        ) OR EXISTS (
          SELECT 1 FROM discussions discussion
          WHERE discussion.room_id = r.room_id
            AND discussion.state NOT IN ('completed', 'canceled', 'terminated')
        )
      ) LIMIT 1
    `).get(teamId));
  }

  public isRoomMember(roomId: string, memberId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM room_human_participants
      WHERE room_id = ? AND member_id = ?
    `).get(roomId, memberId));
  }

  public isRoomAgent(roomId: string, agentId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM room_agent_participants
      WHERE room_id = ? AND agent_id = ?
    `).get(roomId, agentId));
  }

  public getRoomParticipants(roomId: string): RoomParticipants {
    const memberIds = this.database.prepare(`
      SELECT member_id FROM room_human_participants
      WHERE room_id = ? ORDER BY member_id
    `).all(roomId).map((row) => (row as { member_id: string }).member_id);
    const agentIds = this.database.prepare(`
      SELECT agent_id FROM room_agent_participants
      WHERE room_id = ? ORDER BY agent_id
    `).all(roomId).map((row) => (row as { agent_id: string }).agent_id);
    return { memberIds, agentIds };
  }

  public replaceRoomParticipants(
    roomId: string,
    participants: RoomParticipants,
    addedAt: string
  ): RoomParticipants {
    return this.transactions.immediate(() => {
      this.database.prepare(`
        UPDATE rooms SET settings_revision = settings_revision + 1
        WHERE room_id = ?
      `).run(roomId);
      this.replaceParticipantRows(roomId, participants, addedAt);
      return this.getRoomParticipants(roomId);
    });
  }

  private replaceParticipantRows(
    roomId: string,
    participants: RoomParticipants,
    addedAt: string
  ): void {
    this.database.prepare(`
      DELETE FROM room_human_participants WHERE room_id = ?
    `).run(roomId);
    this.database.prepare(`
      DELETE FROM room_agent_participants WHERE room_id = ?
    `).run(roomId);
    const addMember = this.database.prepare(`
      INSERT INTO room_human_participants (room_id, member_id, added_at)
      VALUES (?, ?, ?)
    `);
    for (const memberId of participants.memberIds) {
      addMember.run(roomId, memberId, addedAt);
    }
    const addAgent = this.database.prepare(`
      INSERT INTO room_agent_participants (room_id, agent_id, added_at)
      VALUES (?, ?, ?)
    `);
    for (const agentId of participants.agentIds) {
      addAgent.run(roomId, agentId, addedAt);
    }
  }

  private mapTeam(row: TeamRow): TeamRecord {
    return {
      teamId: row.team_id,
      name: row.name,
      createdAt: row.created_at,
      archivedAt: row.archived_at
    };
  }

  private mapRoom(row: RoomRow): RoomRecord {
    return {
      roomId: row.room_id,
      teamId: row.team_id,
      name: row.name,
      collaborationPolicy: readPersistedRoomCollaborationPolicy(
        row.collaboration_policy_json
      ),
      settingsRevision: row.settings_revision,
      createdAt: row.created_at,
      archivedAt: row.archived_at
    };
  }
}
