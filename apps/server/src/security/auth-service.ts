import { createHash, randomBytes } from "node:crypto";

import type Database from "better-sqlite3";

import { clientAccessAuthority, type ClientAccessScope } from "./client-access-authority.js";

import { createOpaqueId } from "../domain/identifiers.js";

export type AuthorizationErrorCode = "FORBIDDEN" | "UNAUTHENTICATED";

export class AuthorizationError extends Error {
  public constructor(
    public readonly code: AuthorizationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface WebPrincipal {
  clientAccess?: ClientAccessScope;
  userId: string;
  sessionId: string;
}

export interface MemberPrincipal extends WebPrincipal {
  memberId: string;
  teamId: string;
  role: "owner" | "member";
}

export interface DevicePrincipal {
  credentialId: string;
  deviceId: string;
  ownerMemberId: string;
  teamId: string;
}

export interface McpPrincipal extends WebPrincipal {
  credentialId: string;
  memberId: string;
  teamId: string;
  agentId: string;
}

export interface IssuedCredential {
  id: string;
  secret: string;
  expiresAt: string | null;
}

interface WebSessionRow {
  grant_id: string | null;
  client_access_required: 0 | 1;
  session_id: string;
  user_id: string;
  expires_at: string;
}

interface DeviceCredentialRow {
  credential_id: string;
  device_id: string;
  team_id: string;
  owner_member_id: string;
  expires_at: string | null;
  device_status: "active" | "revoked";
}

interface McpCredentialRow {
  credential_id: string;
  agent_id: string;
  member_id: string;
  team_id: string;
  user_id: string;
  expires_at: string | null;
  enabled: number;
}

const activityWriteIntervalMilliseconds = 5 * 60 * 1000;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function isExpired(expiresAt: string | null, now: string): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.parse(now);
}

function activityWriteCutoff(now: string): string {
  return new Date(
    Date.parse(now) - activityWriteIntervalMilliseconds
  ).toISOString();
}

export class AuthService {
  public constructor(private readonly database: Database.Database) {}

  public issueWebSession(
    userId: string,
    now: string,
    expiresAt: string
  ): IssuedCredential {
    if (isExpired(expiresAt, now)) {
      throw new Error("Web session expiry must be in the future");
    }
    const id = createOpaqueId("session");
    const secret = newSecret();
    this.database.prepare(`
      INSERT INTO web_sessions (
        session_id, user_id, token_hash, created_at, expires_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, hashSecret(secret), now, expiresAt, now);
    return { id, secret, expiresAt };
  }

  public authenticateWebSession(secret: string, now: string): WebPrincipal {
    const row = this.database.prepare(`
      SELECT s.session_id, s.user_id, s.expires_at, s.client_access_required, c.grant_id
      FROM web_sessions s LEFT JOIN web_session_client_access c ON c.session_id = s.session_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL
    `).get(hashSecret(secret)) as WebSessionRow | undefined;
    if (!row || isExpired(row.expires_at, now)) {
      throw new AuthorizationError("UNAUTHENTICATED", "Invalid web session");
    }
    const client = row.grant_id ? clientAccessAuthority(this.database, row.grant_id, now) : undefined;
    if ((row.client_access_required === 1 || row.grant_id) && (!client || client.user_id !== row.user_id)) {
      throw new AuthorizationError("UNAUTHENTICATED", "Client session access was revoked");
    }
    this.database.prepare(`
      UPDATE web_sessions SET last_seen_at = ?
      WHERE session_id = ? AND last_seen_at < ?
    `).run(now, row.session_id, activityWriteCutoff(now));
    return { userId: row.user_id, sessionId: row.session_id, ...(client ? { clientAccess: {
      grantId: client.grant_id, memberId: client.member_id, teamId: client.team_id
    } } : {}) };
  }

  public requireTeamMember(
    principal: WebPrincipal,
    teamId: string,
    options: { includeArchived?: boolean } = {}
  ): MemberPrincipal {
    const row = this.database.prepare(`
      SELECT tm.member_id, tm.role
      FROM team_members tm
      JOIN teams t ON t.team_id = tm.team_id
      WHERE tm.team_id = ? AND tm.user_id = ?
        AND (? = 1 OR t.archived_at IS NULL)
    `).get(teamId, principal.userId, options.includeArchived ? 1 : 0) as
      | { member_id: string; role: MemberPrincipal["role"] }
      | undefined;
    if (!row || (principal.clientAccess && (principal.clientAccess.teamId !== teamId || principal.clientAccess.memberId !== row.member_id))) {
      throw new AuthorizationError("FORBIDDEN", "Team access denied");
    }
    return {
      ...principal,
      memberId: row.member_id,
      teamId,
      role: principal.clientAccess ? "member" : row.role
    };
  }

  public requireRoomMember(
    principal: WebPrincipal,
    roomId: string
  ): MemberPrincipal {
    const row = this.database.prepare(`
      SELECT r.team_id, tm.member_id, tm.role
      FROM rooms r
      JOIN teams t ON t.team_id = r.team_id
      JOIN team_members tm ON tm.team_id = r.team_id AND tm.user_id = ?
      JOIN room_human_participants rp
        ON rp.room_id = r.room_id AND rp.member_id = tm.member_id
      WHERE r.room_id = ? AND r.archived_at IS NULL AND t.archived_at IS NULL
    `).get(principal.userId, roomId) as
      | {
          team_id: string;
          member_id: string;
          role: MemberPrincipal["role"];
        }
      | undefined;
    if (!row || (principal.clientAccess && (principal.clientAccess.teamId !== row.team_id || principal.clientAccess.memberId !== row.member_id))) {
      throw new AuthorizationError("FORBIDDEN", "Room access denied");
    }
    return {
      ...principal,
      memberId: row.member_id,
      teamId: row.team_id,
      role: principal.clientAccess ? "member" : row.role
    };
  }

  public requireFullWebSession(principal: WebPrincipal): void {
    if (principal.clientAccess) throw new AuthorizationError("FORBIDDEN", "This action requires a full Web login");
  }

  public revokeWebSession(sessionId: string, now: string): boolean {
    return this.database.prepare(`
      UPDATE web_sessions SET revoked_at = ?
      WHERE session_id = ? AND revoked_at IS NULL
    `).run(now, sessionId).changes === 1;
  }

  public revokeWebSessionsForUser(userId: string, now: string): number {
    return this.database.prepare(`
      UPDATE web_sessions SET revoked_at = ?
      WHERE user_id = ? AND revoked_at IS NULL
    `).run(now, userId).changes;
  }

  public getWebSessionExpiresAt(sessionId: string): string | undefined {
    return (this.database.prepare(`
      SELECT expires_at FROM web_sessions
      WHERE session_id = ? AND revoked_at IS NULL
    `).get(sessionId) as { expires_at: string } | undefined)?.expires_at;
  }

  public revokeOtherWebSessionsForUser(userId: string, retainedSessionId: string, now: string): number {
    return this.database.prepare(`
      UPDATE web_sessions SET revoked_at = ?
      WHERE user_id = ? AND session_id != ? AND revoked_at IS NULL
    `).run(now, userId, retainedSessionId).changes;
  }

  public issueDeviceCredential(
    deviceId: string,
    now: string,
    expiresAt: string | null = null
  ): IssuedCredential {
    if (isExpired(expiresAt, now)) {
      throw new Error("Device credential expiry must be in the future");
    }
    const device = this.database.prepare(`
      SELECT status FROM devices WHERE device_id = ?
    `).get(deviceId) as { status: "active" | "revoked" } | undefined;
    if (!device || device.status !== "active") {
      throw new AuthorizationError("FORBIDDEN", "Device is not active");
    }

    const id = createOpaqueId("credential");
    const secret = newSecret();
    this.database.transaction(() => {
      this.database.prepare(`
        UPDATE device_credentials SET revoked_at = ?
        WHERE device_id = ? AND revoked_at IS NULL
      `).run(now, deviceId);
      this.database.prepare(`
        INSERT INTO device_credentials (
          credential_id, device_id, secret_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(id, deviceId, hashSecret(secret), now, expiresAt);
    }).immediate();
    return { id, secret, expiresAt };
  }

  public authenticateDevice(secret: string, now: string): DevicePrincipal {
    const row = this.database.prepare(`
      SELECT dc.credential_id, dc.device_id, dc.expires_at,
             d.team_id, d.owner_member_id, d.status AS device_status
      FROM device_credentials dc
      JOIN devices d ON d.device_id = dc.device_id
      WHERE dc.secret_hash = ? AND dc.revoked_at IS NULL
    `).get(hashSecret(secret)) as DeviceCredentialRow | undefined;
    if (
      !row ||
      row.device_status !== "active" ||
      isExpired(row.expires_at, now)
    ) {
      throw new AuthorizationError("UNAUTHENTICATED", "Invalid device credential");
    }
    this.database.prepare(`
      UPDATE device_credentials SET last_used_at = ?
      WHERE credential_id = ?
        AND (last_used_at IS NULL OR last_used_at < ?)
    `).run(now, row.credential_id, activityWriteCutoff(now));
    return {
      credentialId: row.credential_id,
      deviceId: row.device_id,
      ownerMemberId: row.owner_member_id,
      teamId: row.team_id
    };
  }

  public revokeDeviceCredential(credentialId: string, now: string): boolean {
    return this.database.prepare(`
      UPDATE device_credentials SET revoked_at = ?
      WHERE credential_id = ? AND revoked_at IS NULL
    `).run(now, credentialId).changes === 1;
  }

  public issueMcpCredential(
    principal: WebPrincipal,
    agentId: string,
    now: string,
    expiresAt: string | null = null
  ): IssuedCredential {
    this.requireFullWebSession(principal);
    if (isExpired(expiresAt, now)) {
      throw new Error("MCP credential expiry must be in the future");
    }
    const agent = this.database.prepare(`
      SELECT a.owner_member_id, a.integration_mode, a.enabled, tm.user_id
      FROM agents a
      JOIN team_members tm ON tm.member_id = a.owner_member_id
      WHERE a.agent_id = ?
    `).get(agentId) as
      | {
          owner_member_id: string;
          integration_mode: "managed" | "manual" | "fake" | "hosted";
          enabled: number;
          user_id: string | null;
        }
      | undefined;
    if (
      !agent ||
      agent.user_id !== principal.userId ||
      agent.integration_mode !== "manual" ||
      agent.enabled !== 1
    ) {
      throw new AuthorizationError("FORBIDDEN", "Manual Agent ownership denied");
    }
    const id = createOpaqueId("mcpcred");
    const secret = newSecret();
    this.database.prepare(`
      INSERT INTO mcp_credentials (
        credential_id, agent_id, member_id, token_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      agentId,
      agent.owner_member_id,
      hashSecret(secret),
      now,
      expiresAt
    );
    return { id, secret, expiresAt };
  }

  public authenticateMcp(secret: string, now: string): McpPrincipal {
    const row = this.database.prepare(`
      SELECT mc.credential_id, mc.agent_id, mc.member_id, mc.expires_at,
             tm.team_id, tm.user_id, a.enabled
      FROM mcp_credentials mc
      JOIN team_members tm ON tm.member_id = mc.member_id
      JOIN agents a ON a.agent_id = mc.agent_id
      WHERE mc.token_hash = ? AND mc.revoked_at IS NULL
    `).get(hashSecret(secret)) as McpCredentialRow | undefined;
    if (!row || row.enabled !== 1 || isExpired(row.expires_at, now)) {
      throw new AuthorizationError("UNAUTHENTICATED", "Invalid MCP credential");
    }
    this.database.prepare(`
      UPDATE mcp_credentials SET last_used_at = ?
      WHERE credential_id = ?
        AND (last_used_at IS NULL OR last_used_at < ?)
    `).run(now, row.credential_id, activityWriteCutoff(now));
    return {
      credentialId: row.credential_id,
      sessionId: row.credential_id,
      userId: row.user_id,
      memberId: row.member_id,
      teamId: row.team_id,
      agentId: row.agent_id
    };
  }

  public revokeMcpCredential(credentialId: string, now: string): boolean {
    return this.database.prepare(`
      UPDATE mcp_credentials SET revoked_at = ?
      WHERE credential_id = ? AND revoked_at IS NULL
    `).run(now, credentialId).changes === 1;
  }
}
