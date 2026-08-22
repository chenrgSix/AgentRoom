import { createHash, randomBytes } from "node:crypto";

import type Database from "better-sqlite3";

import type { CoreRepository, DeviceRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type {
  AuthService,
  IssuedCredential,
  WebPrincipal
} from "./auth-service.js";

interface PairingInviteRow {
  invite_id: string;
  team_id: string;
  member_id: string;
  device_name: string;
  expires_at: string;
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
