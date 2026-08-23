import { createHash, randomBytes } from "node:crypto";

import type Database from "better-sqlite3";

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

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

function isExpired(expiresAt: string | null, now: string): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= Date.parse(now);
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
      SELECT session_id, user_id, expires_at
      FROM web_sessions
      WHERE token_hash = ? AND revoked_at IS NULL
    `).get(hashSecret(secret)) as WebSessionRow | undefined;
    if (!row || isExpired(row.expires_at, now)) {
      throw new AuthorizationError("UNAUTHENTICATED", "Invalid web session");
    }
    this.database.prepare(`
      UPDATE web_sessions SET last_seen_at = ? WHERE session_id = ?
    `).run(now, row.session_id);
    return { userId: row.user_id, sessionId: row.session_id };
  }

  public requireTeamMember(
    principal: WebPrincipal,
    teamId: string
  ): MemberPrincipal {
    const row = this.database.prepare(`
      SELECT member_id, role
      FROM team_members
      WHERE team_id = ? AND user_id = ?
    `).get(teamId, principal.userId) as
      | { member_id: string; role: MemberPrincipal["role"] }
      | undefined;
    if (!row) {
      throw new AuthorizationError("FORBIDDEN", "Team access denied");
    }
    return {
      ...principal,
      memberId: row.member_id,
      teamId,
      role: row.role
    };
  }

  public requireRoomMember(
    principal: WebPrincipal,
    roomId: string
  ): MemberPrincipal {
    const room = this.database.prepare(`
      SELECT team_id FROM rooms WHERE room_id = ?
    `).get(roomId) as { team_id: string } | undefined;
    if (!room) {
      throw new AuthorizationError("FORBIDDEN", "Room access denied");
    }
    return this.requireTeamMember(principal, room.team_id);
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
      UPDATE device_credentials SET last_used_at = ? WHERE credential_id = ?
    `).run(now, row.credential_id);
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
          integration_mode: "managed" | "manual" | "fake";
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
      UPDATE mcp_credentials SET last_used_at = ? WHERE credential_id = ?
    `).run(now, row.credential_id);
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
