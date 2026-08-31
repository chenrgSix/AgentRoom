import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ClientEntryIdentity, ClientEntryTicket, DevicePairingMemberBinding
} from "@convene-wire/contracts/pairing-session";
import type { CoreRepository, MemberRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import { AuthorizationError, type AuthService, type DevicePrincipal, type MemberPrincipal } from "./auth-service.js";
import { clientAccessAuthority, type ClientAccessAuthority } from "./client-access-authority.js";

const opaque = (prefix: string) => new RegExp(`^${prefix}_[A-Za-z0-9_-]{8,128}$`, "u");
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const denied = () => new AuthorizationError("UNAUTHENTICATED", "Client access is unavailable or expired");

export function clientSecret(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(value)) throw denied();
  return value;
}

export class ClientAccessService {
  public constructor(
    private readonly database: Database.Database,
    private readonly core: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public binding(actor: MemberPrincipal, input: unknown): DevicePairingMemberBinding {
    if (actor.role !== "owner" || !input || typeof input !== "object" || Array.isArray(input)) {
      throw new AuthorizationError("FORBIDDEN", "Owner member binding required");
    }
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["memberId", "displayName", "roomIds"].includes(key)) ||
      (value.memberId === undefined) === (value.displayName === undefined) ||
      !Array.isArray(value.roomIds) || value.roomIds.length > 100 ||
      new Set(value.roomIds).size !== value.roomIds.length) {
      throw new Error("Member binding requires one identity and unique initial Rooms");
    }
    const roomIds = value.roomIds.map((roomId: unknown) => {
      if (typeof roomId !== "string" || !opaque("room").test(roomId)) throw new Error("Invalid initial Room");
      const room = this.core.getRoom(roomId);
      if (!room || room.teamId !== actor.teamId || room.archivedAt) throw new Error("Initial Room is unavailable");
      return roomId;
    }).sort();
    if (value.memberId !== undefined) {
      if (typeof value.memberId !== "string" || !opaque("member").test(value.memberId)) throw new Error("Invalid member identity");
      const member = this.core.getMember(value.memberId);
      if (!member?.userId || member.teamId !== actor.teamId ||
        (member.role === "owner" && member.memberId !== actor.memberId)) {
        throw new AuthorizationError("FORBIDDEN", "Choose yourself or an ordinary Team member");
      }
      return { memberId: member.memberId, roomIds };
    }
    if (typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.trim().length > 80) {
      throw new Error("Member display name must contain 1 to 80 characters");
    }
    return { displayName: value.displayName.trim(), roomIds };
  }

  /** Called inside the pairing approval transaction; never creates on claim. */
  public approveBinding(actor: MemberPrincipal, input: DevicePairingMemberBinding, now: string): MemberRecord {
    const binding = this.binding(actor, input);
    let member: MemberRecord;
    if (binding.memberId) {
      member = this.core.getMember(binding.memberId)!;
    } else {
      const userId = createOpaqueId("user");
      this.core.createUser({ userId, displayName: binding.displayName!, createdAt: now });
      member = { memberId: createOpaqueId("member"), userId, teamId: actor.teamId,
        displayName: binding.displayName!, role: "member", createdAt: now };
      this.core.createMember(member, []);
    }
    for (const roomId of binding.roomIds) {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO room_human_participants (room_id, member_id, added_at) VALUES (?, ?, ?)
      `).run(roomId, member.memberId, now);
      if (inserted.changes) this.database.prepare(`
        UPDATE rooms SET settings_revision = settings_revision + 1 WHERE room_id = ?
      `).run(roomId);
    }
    return member;
  }

  public grant(input: {
    deviceId: string; credentialId: string; member: MemberRecord;
    issuedByMemberId: string; secretHash: string; roomIds: string[]; now: string;
  }): void {
    this.database.prepare(`
      INSERT INTO client_device_bindings (device_id, member_id, initial_room_ids_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(input.deviceId, input.member.memberId, JSON.stringify(input.roomIds), input.now);
    this.database.prepare(`
      INSERT INTO client_access_grants (grant_id, device_id, credential_id, team_id,
        member_id, user_id, issued_by_member_id, secret_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(createOpaqueId("clientgrant"), input.deviceId, input.credentialId, input.member.teamId,
      input.member.memberId, input.member.userId, input.issuedByMemberId, input.secretHash, input.now);
  }

  private authorizeDevice(device: DevicePrincipal, secret: string, now: string): ClientAccessAuthority {
    const row = this.database.prepare(`SELECT grant_id FROM client_access_grants
      WHERE device_id = ? AND secret_hash = ?`).get(device.deviceId, hash(clientSecret(secret))) as { grant_id: string } | undefined;
    const authority = row && clientAccessAuthority(this.database, row.grant_id, now);
    if (!authority || authority.credential_id !== device.credentialId || authority.member_id !== device.ownerMemberId ||
      authority.team_id !== device.teamId) throw denied();
    return authority;
  }

  private identity(authority: ClientAccessAuthority, roomId?: string): ClientEntryIdentity {
    if (roomId !== undefined) {
      if (!opaque("room").test(roomId) || !this.database.prepare(`
        SELECT 1 FROM rooms r JOIN room_human_participants p ON p.room_id = r.room_id
        WHERE r.room_id = ? AND r.team_id = ? AND p.member_id = ? AND r.archived_at IS NULL
      `).get(roomId, authority.team_id, authority.member_id)) throw new AuthorizationError("FORBIDDEN", "Room access denied");
    }
    return { teamId: authority.team_id, teamName: authority.team_name,
      memberId: authority.member_id, displayName: authority.display_name,
      ...(roomId ? { roomId } : {}),
      rooms: this.core.listRoomsForMember(authority.team_id, authority.member_id).slice(0, 100)
        .map(({ roomId: id, name }) => ({ roomId: id, name })) };
  }

  public list(device: DevicePrincipal, secret: string, now: string): ClientEntryIdentity {
    return this.identity(this.authorizeDevice(device, secret, now));
  }

  public revoke(actor: MemberPrincipal, deviceId: string, now: string): void {
    const device = this.core.getDevice(deviceId);
    if (!device || device.teamId !== actor.teamId ||
      (actor.role !== "owner" && actor.memberId !== device.ownerMemberId)) {
      throw new AuthorizationError("FORBIDDEN", "Client access revoke denied");
    }
    this.database.prepare("UPDATE client_access_grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL")
      .run(now, deviceId);
  }

  public issue(device: DevicePrincipal, secret: string, roomId: string | undefined, now: string): ClientEntryTicket {
    return this.database.transaction(() => {
      const authority = this.authorizeDevice(device, secret, now);
      this.identity(authority, roomId);
      const ticket = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.parse(now) + 60_000).toISOString();
      this.database.prepare("DELETE FROM client_entry_tickets WHERE grant_id = ? AND expires_at <= ?")
        .run(authority.grant_id, now);
      this.database.prepare(`INSERT INTO client_entry_tickets
        (ticket_hash, grant_id, room_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
        .run(hash(ticket), authority.grant_id, roomId ?? null, now, expiresAt);
      return { ticket, expiresAt };
    }).immediate();
  }

  private ticket(value: string, now: string) {
    const row = this.database.prepare(`SELECT grant_id, room_id FROM client_entry_tickets
      WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?`)
      .get(hash(clientSecret(value)), now) as { grant_id: string; room_id: string | null } | undefined;
    const authority = row && clientAccessAuthority(this.database, row.grant_id, now);
    if (!row || !authority) throw denied();
    return { authority, identity: this.identity(authority, row.room_id ?? undefined) };
  }

  public preview(ticket: string, now: string): ClientEntryIdentity {
    return this.ticket(ticket, now).identity;
  }

  public consume(ticket: string, now: string) {
    return this.database.transaction(() => {
      const { authority, identity } = this.ticket(ticket, now);
      const changed = this.database.prepare(`UPDATE client_entry_tickets SET consumed_at = ?
        WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?`).run(now, hash(ticket), now);
      if (changed.changes !== 1) throw denied();
      const session = this.auth.issueWebSession(authority.user_id, now,
        new Date(Date.parse(now) + 8 * 60 * 60 * 1_000).toISOString());
      this.database.prepare("UPDATE web_sessions SET client_access_required = 1 WHERE session_id = ?").run(session.id);
      this.database.prepare("INSERT INTO web_session_client_access (session_id, grant_id) VALUES (?, ?)")
        .run(session.id, authority.grant_id);
      return { identity, session, user: this.core.getUser(authority.user_id)! };
    }).immediate();
  }
}
