import { createHash, randomBytes } from "node:crypto";

import type {
  BridgeJoinApproval,
  BridgeJoinChallenge,
  BridgeJoinRequest
} from "@agent-room/contracts/bridge-messages";
import type Database from "better-sqlite3";

import type { CoreRepository, DeviceRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  AuthorizationError,
  type AuthService,
  type IssuedCredential,
  type WebPrincipal
} from "./auth-service.js";

interface PairingInviteRow {
  invite_id: string;
  team_id: string;
  member_id: string;
  device_name: string;
  expires_at: string;
}

interface JoinRequestRow {
  join_request_id: string;
  poll_token_hash: string;
  device_name: string;
  agent_name: string;
  agent_role: string;
  expires_at: string;
  approved_at: string | null;
  approved_team_id: string | null;
  approved_member_id: string | null;
  claimed_at: string | null;
  device_id: string | null;
  credential_id: string | null;
}

export interface IssuedPairingInvite {
  inviteId: string;
  code: string;
  deviceName: string;
  expiresAt: string;
}

export interface PairingResult {
  device: DeviceRecord;
  credential: IssuedCredential;
}

export type IssuedJoinRequest = BridgeJoinChallenge;

export type ApprovedJoinRequest = BridgeJoinApproval;

export type JoinClaimResult =
  | { status: "pending"; expiresAt: string }
  | ({ status: "paired" } & PairingResult);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

function deviceName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    throw new Error("Device name must contain 1 to 80 characters");
  }
  return normalized;
}

function agentField(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    throw new Error(`${label} must contain 1 to 80 characters`);
  }
  return normalized;
}

function userCode(value: string): string {
  const normalized = value.trim().toUpperCase().replaceAll("-", "");
  if (!/^[0-9A-F]{8}$/u.test(normalized)) {
    throw new Error("Invalid or expired Bridge join code");
  }
  return normalized;
}

export class BridgePairingService {
  public constructor(
    private readonly database: Database.Database,
    private readonly core: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public createInvite(
    principal: WebPrincipal,
    teamId: string,
    requestedDeviceName: string,
    now: string
  ): IssuedPairingInvite {
    const member = this.auth.requireTeamMember(principal, teamId);
    const normalizedName = deviceName(requestedDeviceName);
    const inviteId = createOpaqueId("invite");
    const code = randomBytes(12).toString("base64url");
    const expiresAt = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
    this.database.prepare(`
      INSERT INTO bridge_pairing_invites (
        invite_id, team_id, member_id, device_name, code_hash, created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      inviteId,
      teamId,
      member.memberId,
      normalizedName,
      hash(code),
      now,
      expiresAt
    );
    return { inviteId, code, deviceName: normalizedName, expiresAt };
  }

  public createJoinRequest(
    input: BridgeJoinRequest,
    now: string
  ): IssuedJoinRequest {
    const normalizedDeviceName = deviceName(input.deviceName);
    const normalizedAgentName = agentField(input.agentName, "Agent name");
    const normalizedAgentRole = agentField(input.agentRole, "Agent role");
    const joinRequestId = createOpaqueId("joinreq");
    const pollToken = secret();
    const expiresAt = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const compactCode = randomBytes(4).toString("hex").toUpperCase();
      try {
        this.database.prepare(`
          INSERT INTO bridge_join_requests (
            join_request_id, user_code_hash, poll_token_hash, device_name,
            agent_name, agent_role, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          joinRequestId,
          hash(compactCode),
          hash(pollToken),
          normalizedDeviceName,
          normalizedAgentName,
          normalizedAgentRole,
          now,
          expiresAt
        );
        return {
          joinRequestId,
          userCode: `${compactCode.slice(0, 4)}-${compactCode.slice(4)}`,
          pollToken,
          expiresAt,
          pollIntervalMs: 1_000
        };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("bridge_join_requests.user_code_hash")
        ) {
          throw error;
        }
      }
    }
    throw new Error("Could not allocate a unique Bridge join code");
  }

  public approveJoinRequest(
    principal: WebPrincipal,
    teamId: string,
    code: string,
    now: string
  ): ApprovedJoinRequest {
    const member = this.auth.requireTeamMember(principal, teamId);
    if (member.role !== "owner") {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Only a Team owner can approve Bridge joins"
      );
    }
    const normalizedCode = userCode(code);
    return this.database.transaction(() => {
      const request = this.database.prepare(`
        SELECT join_request_id, device_name, agent_name, agent_role, expires_at
        FROM bridge_join_requests
        WHERE user_code_hash = ? AND approved_at IS NULL AND claimed_at IS NULL
      `).get(hash(normalizedCode)) as Pick<
        JoinRequestRow,
        "join_request_id" | "device_name" | "agent_name" | "agent_role" | "expires_at"
      > | undefined;
      if (!request || Date.parse(request.expires_at) <= Date.parse(now)) {
        throw new Error("Invalid or expired Bridge join code");
      }
      const approved = this.database.prepare(`
        UPDATE bridge_join_requests
        SET approved_at = ?, approved_team_id = ?, approved_member_id = ?
        WHERE join_request_id = ? AND approved_at IS NULL AND claimed_at IS NULL
      `).run(now, teamId, member.memberId, request.join_request_id);
      if (approved.changes !== 1) {
        throw new Error("Bridge join request was already approved");
      }
      return {
        joinRequestId: request.join_request_id,
        status: "approved" as const,
        deviceName: request.device_name,
        agentName: request.agent_name,
        agentRole: request.agent_role,
        expiresAt: request.expires_at
      };
    }).immediate();
  }

  public claimJoinRequest(
    joinRequestId: string,
    pollToken: string,
    now: string
  ): JoinClaimResult {
    if (!joinRequestId.startsWith("joinreq_") || joinRequestId.length > 140) {
      throw new Error("Invalid Bridge join request");
    }
    if (pollToken.length < 40 || pollToken.length > 128) {
      throw new Error("Invalid Bridge join request");
    }
    return this.database.transaction(() => {
      const request = this.database.prepare(`
        SELECT join_request_id, poll_token_hash, device_name, agent_name,
               agent_role, expires_at, approved_at, approved_team_id,
               approved_member_id, claimed_at, device_id, credential_id
        FROM bridge_join_requests
        WHERE join_request_id = ? AND poll_token_hash = ?
      `).get(joinRequestId, hash(pollToken)) as JoinRequestRow | undefined;
      if (!request || Date.parse(request.expires_at) <= Date.parse(now)) {
        throw new Error("Invalid or expired Bridge join request");
      }
      if (!request.approved_at || !request.approved_team_id || !request.approved_member_id) {
        return { status: "pending" as const, expiresAt: request.expires_at };
      }

      let device: DeviceRecord | undefined;
      let credentialId = request.credential_id;
      if (request.claimed_at && request.device_id && credentialId) {
        device = this.core.getDevice(request.device_id);
      } else {
        device = {
          deviceId: createOpaqueId("device"),
          teamId: request.approved_team_id,
          ownerMemberId: request.approved_member_id,
          name: request.device_name,
          status: "active",
          createdAt: now,
          revokedAt: null
        };
        this.core.createDevice(device);
        credentialId = createOpaqueId("credential");
        this.database.prepare(`
          INSERT INTO device_credentials (
            credential_id, device_id, secret_hash, created_at, expires_at
          ) VALUES (?, ?, ?, ?, NULL)
        `).run(credentialId, device.deviceId, request.poll_token_hash, now);
        const claimed = this.database.prepare(`
          UPDATE bridge_join_requests
          SET claimed_at = ?, device_id = ?, credential_id = ?
          WHERE join_request_id = ? AND claimed_at IS NULL
        `).run(now, device.deviceId, credentialId, request.join_request_id);
        if (claimed.changes !== 1) {
          throw new Error("Bridge join request claim raced");
        }
      }
      if (!device || !credentialId) {
        throw new Error("Bridge join request lost its claimed Device");
      }
      return {
        status: "paired" as const,
        device,
        credential: { id: credentialId, secret: pollToken, expiresAt: null }
      };
    }).immediate();
  }

  public exchange(code: string, requestedDeviceName: string, now: string): PairingResult {
    if (code.trim().length < 12 || code.length > 128) {
      throw new Error("Invalid or expired Bridge pairing code");
    }
    const normalizedName = deviceName(requestedDeviceName);
    return this.database.transaction(() => {
      const invite = this.database.prepare(`
        SELECT invite_id, team_id, member_id, device_name, expires_at
        FROM bridge_pairing_invites
        WHERE code_hash = ? AND used_at IS NULL
      `).get(hash(code)) as PairingInviteRow | undefined;
      if (
        !invite ||
        Date.parse(invite.expires_at) <= Date.parse(now) ||
        invite.device_name !== normalizedName
      ) {
        throw new Error("Invalid or expired Bridge pairing code");
      }
      const device: DeviceRecord = {
        deviceId: createOpaqueId("device"),
        teamId: invite.team_id,
        ownerMemberId: invite.member_id,
        name: invite.device_name,
        status: "active",
        createdAt: now,
        revokedAt: null
      };
      this.core.createDevice(device);
      const credential: IssuedCredential = {
        id: createOpaqueId("credential"),
        secret: secret(),
        expiresAt: null
      };
      this.database.prepare(`
        INSERT INTO device_credentials (
          credential_id, device_id, secret_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, NULL)
      `).run(
        credential.id,
        device.deviceId,
        hash(credential.secret),
        now
      );
      const consumed = this.database.prepare(`
        UPDATE bridge_pairing_invites SET used_at = ?
        WHERE invite_id = ? AND used_at IS NULL
      `).run(now, invite.invite_id);
      if (consumed.changes !== 1) {
        throw new Error("Bridge pairing code was already used");
      }
      return { device, credential };
    }).immediate();
  }
}
