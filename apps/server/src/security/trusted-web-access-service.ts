import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

import type Database from "better-sqlite3";

import {
  type CoreRepository,
  type MemberRecord,
  type WebUserRecord
} from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  type AuthService,
  AuthorizationError,
  type IssuedCredential,
  type WebPrincipal
} from "./auth-service.js";

const ownerMetadataKey = "trusted_team_owner_user_id";
const sessionDurationMilliseconds = 30 * 24 * 60 * 60 * 1_000;
const invitationDurationMilliseconds = 24 * 60 * 60 * 1_000;
const memberRecoveryDurationMilliseconds = 15 * 60 * 1_000;

interface OwnerRecoveryRow {
  token_hash: string;
  revision: number;
  updated_at: string;
}

interface MemberRecoveryRow {
  recovery_id: string;
  team_id: string;
  member_id: string;
  user_id: string;
  created_by_member_id: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
}

interface InvitationRow {
  invitation_id: string;
  team_id: string;
  display_name: string;
  expires_at: string;
  claimed_at: string | null;
  revoked_at: string | null;
}

export interface TrustedSessionResult {
  session: IssuedCredential;
  user: WebUserRecord;
}

export interface MemberInvitation {
  claimUrl: string;
  displayName: string;
  expiresAt: string;
  invitationId: string;
  teamId: string;
}

export interface IssuedMemberRecovery {
  recoveryId: string;
  teamId: string;
  memberId: string;
  displayName: string;
  expiresAt: string;
  token: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    throw new Error("displayName must contain 1 to 80 characters");
  }
  return normalized;
}

function future(now: string, durationMilliseconds: number): string {
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed)) throw new Error("Clock returned an invalid timestamp");
  return new Date(parsed + durationMilliseconds).toISOString();
}

export class TrustedWebAccessService {
  private readonly expectedRecoveryHash: Buffer;

  public constructor(
    private readonly database: Database.Database,
    private readonly repository: CoreRepository,
    private readonly auth: AuthService,
    private readonly publicOrigin: string,
    ownerRecoveryToken: string
  ) {
    this.expectedRecoveryHash = createHash("sha256")
      .update(ownerRecoveryToken)
      .digest();
  }

  public status(): "setup_required" | "sign_in_required" {
    return this.ownerUserId() ? "sign_in_required" : "setup_required";
  }

  public isInstallationOwner(userId: string): boolean {
    return userId === this.ownerUserId();
  }

  public ownerRecoverySettings(principal: WebPrincipal) {
    this.requireInstallationOwner(principal);
    const row = this.ownerRecoveryRow();
    return { revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null };
  }

  public replaceOwnerRecovery(
    principal: WebPrincipal,
    candidate: string,
    expectedRevision: number,
    now: string
  ) {
    // Browser-generated 256-bit material, not a human password. Never echo it.
    this.requireInstallationOwner(principal);
    if (!/^[0-9a-f]{64}$/u.test(candidate)) {
      throw new Error("New Owner recovery key must be a 256-bit hexadecimal key");
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("expectedRevision must be a non-negative safe integer");
    }
    return this.database.transaction(() => {
      this.requireInstallationOwner(principal);
      const row = this.ownerRecoveryRow();
      const candidateHash = hash(candidate);
      // Response-loss retry must not revoke sessions issued after the commit.
      if (row?.revision === expectedRevision + 1 &&
        timingSafeEqual(Buffer.from(row.token_hash, "hex"), Buffer.from(candidateHash, "hex"))) {
        return { revision: row.revision, updatedAt: row.updated_at };
      }
      if ((row?.revision ?? 0) !== expectedRevision) {
        throw new Error("Owner recovery key changed; reload and retry");
      }
      const currentHash = row ? Buffer.from(row.token_hash, "hex") : this.expectedRecoveryHash;
      if (timingSafeEqual(currentHash, Buffer.from(candidateHash, "hex"))) {
        throw new Error("New Owner recovery key must differ from the current key");
      }
      this.database.prepare(`
        INSERT INTO web_owner_recovery_credentials (singleton, token_hash, revision, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          token_hash = excluded.token_hash, revision = excluded.revision,
          updated_at = excluded.updated_at
      `).run(candidateHash, expectedRevision + 1, now);
      this.auth.revokeOtherWebSessionsForUser(principal.userId, principal.sessionId, now);
      return { revision: expectedRevision + 1, updatedAt: now };
    }).immediate();
  }

  public setup(
    recoveryToken: string,
    displayName: string,
    now: string
  ): TrustedSessionResult {
    this.requireRecoveryToken(recoveryToken);
    return this.database.transaction(() => {
      if (this.ownerUserId()) {
        throw new AuthorizationError(
          "FORBIDDEN",
          "Trusted Team setup has already completed"
        );
      }

      const ownerCandidates = this.database.prepare(`
        SELECT DISTINCT wu.user_id
        FROM web_users wu
        JOIN team_members tm ON tm.user_id = wu.user_id
        WHERE tm.role = 'owner'
        ORDER BY wu.created_at, wu.user_id
      `).all() as Array<{ user_id: string }>;
      const userCount = this.database.prepare(`
        SELECT COUNT(*) AS count FROM web_users
      `).get() as { count: number };
      const membershipCount = this.database.prepare(`
        SELECT COUNT(*) AS count FROM team_members
      `).get() as { count: number };

      let user: WebUserRecord;
      if (ownerCandidates.length === 1) {
        const existing = this.repository.getUser(ownerCandidates[0]?.user_id ?? "");
        if (!existing) throw new Error("Existing Owner User disappeared");
        user = existing;
      } else if (
        ownerCandidates.length === 0 &&
        userCount.count === 1 &&
        membershipCount.count === 0
      ) {
        const candidate = this.database.prepare(`
          SELECT user_id FROM web_users ORDER BY created_at, user_id LIMIT 1
        `).get() as { user_id: string } | undefined;
        const existing = candidate
          ? this.repository.getUser(candidate.user_id)
          : undefined;
        if (!existing) throw new Error("Existing bootstrap User disappeared");
        user = existing;
      } else if (
        ownerCandidates.length === 0 &&
        userCount.count === 0 &&
        membershipCount.count === 0
      ) {
        user = {
          userId: createOpaqueId("user"),
          displayName: normalizedDisplayName(displayName),
          createdAt: now
        };
        this.repository.createUser(user);
      } else {
        throw new Error(
          "Trusted Team setup requires exactly one existing Owner User"
        );
      }

      this.database.prepare(`
        INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)
      `).run(ownerMetadataKey, user.userId, now);
      this.auth.revokeWebSessionsForUser(user.userId, now);
      return {
        user,
        session: this.auth.issueWebSession(
          user.userId,
          now,
          future(now, sessionDurationMilliseconds)
        )
      };
    }).immediate();
  }

  public recover(recoveryToken: string, now: string): TrustedSessionResult {
    this.requireRecoveryToken(recoveryToken);
    return this.database.transaction(() => {
      const userId = this.ownerUserId();
      const user = userId ? this.repository.getUser(userId) : undefined;
      if (!user) {
        throw new AuthorizationError(
          "FORBIDDEN",
          "Trusted Team setup is incomplete"
        );
      }
      this.auth.revokeWebSessionsForUser(user.userId, now);
      return {
        user,
        session: this.auth.issueWebSession(
          user.userId,
          now,
          future(now, sessionDurationMilliseconds)
        )
      };
    }).immediate();
  }

  public createMemberInvitation(
    principal: WebPrincipal,
    teamId: string,
    displayName: string,
    now: string
  ): MemberInvitation {
    const actor = this.auth.requireTeamMember(principal, teamId);
    if (actor.role !== "owner") {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Only a Team owner can invite members"
      );
    }
    const invitationId = createOpaqueId("memberinvite");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = future(now, invitationDurationMilliseconds);
    const name = normalizedDisplayName(displayName);
    this.database.prepare(`
      INSERT INTO web_member_invitations (
        invitation_id, team_id, created_by_member_id, display_name,
        token_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      invitationId,
      teamId,
      actor.memberId,
      name,
      hash(token),
      now,
      expiresAt
    );
    return {
      invitationId,
      teamId,
      displayName: name,
      expiresAt,
      claimUrl: `${this.publicOrigin}/#/join/${encodeURIComponent(token)}`
    };
  }

  public claimMemberInvitation(token: string, now: string): {
    member: MemberRecord;
    session: IssuedCredential;
    user: WebUserRecord;
  } {
    return this.database.transaction(() => {
      const invitation = this.database.prepare(`
        SELECT invitation_id, team_id, display_name, expires_at,
               claimed_at, revoked_at
        FROM web_member_invitations WHERE token_hash = ?
      `).get(hash(token)) as InvitationRow | undefined;
      if (
        !invitation ||
        invitation.claimed_at !== null ||
        invitation.revoked_at !== null ||
        Date.parse(invitation.expires_at) <= Date.parse(now)
      ) {
        throw new AuthorizationError(
          "UNAUTHENTICATED",
          "Invalid or expired member invitation"
        );
      }

      const user: WebUserRecord = {
        userId: createOpaqueId("user"),
        displayName: invitation.display_name,
        createdAt: now
      };
      const member: MemberRecord = {
        memberId: createOpaqueId("member"),
        teamId: invitation.team_id,
        userId: user.userId,
        displayName: invitation.display_name,
        role: "member",
        createdAt: now
      };
      this.repository.createUser(user);
      this.repository.createMember(member);
      const claimed = this.database.prepare(`
        UPDATE web_member_invitations
        SET claimed_at = ?, claimed_user_id = ?
        WHERE invitation_id = ? AND claimed_at IS NULL AND revoked_at IS NULL
      `).run(now, user.userId, invitation.invitation_id);
      if (claimed.changes !== 1) {
        throw new AuthorizationError(
          "UNAUTHENTICATED",
          "Invalid or expired member invitation"
        );
      }
      return {
        user,
        member,
        session: this.auth.issueWebSession(
          user.userId,
          now,
          future(now, sessionDurationMilliseconds)
        )
      };
    }).immediate();
  }

  public createMemberRecovery(
    principal: WebPrincipal,
    teamId: string,
    memberId: string,
    now: string
  ): IssuedMemberRecovery {
    return this.database.transaction(() => {
      const actor = this.requireRecoveryOwner(principal, teamId);
      const member = this.recoverableMember(teamId, memberId);
      if (!member?.userId) {
        throw new AuthorizationError("FORBIDDEN", "Member recovery unavailable");
      }
      const recoveryId = createOpaqueId("memberrecovery");
      const token = randomBytes(32).toString("base64url");
      const expiresAt = future(now, memberRecoveryDurationMilliseconds);
      this.database.prepare(`
        UPDATE web_member_recoveries SET revoked_at = ?
        WHERE user_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
      `).run(now, member.userId);
      this.database.prepare(`
        INSERT INTO web_member_recoveries (
          recovery_id, team_id, member_id, user_id, created_by_member_id,
          token_hash, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recoveryId, teamId, memberId, member.userId, actor.memberId,
        hash(token), now, expiresAt
      );
      return {
        recoveryId, teamId, memberId, displayName: member.displayName,
        expiresAt, token
      };
    }).immediate();
  }

  public revokeMemberRecovery(
    principal: WebPrincipal,
    teamId: string,
    memberId: string,
    recoveryId: string,
    now: string
  ): void {
    this.database.transaction(() => {
      this.requireRecoveryOwner(principal, teamId);
      // The exact capability can still be revoked after target eligibility changes.
      this.database.prepare(`
        UPDATE web_member_recoveries SET revoked_at = ?
        WHERE recovery_id = ? AND team_id = ? AND member_id = ?
          AND consumed_at IS NULL AND revoked_at IS NULL
      `).run(now, recoveryId, teamId, memberId);
    }).immediate();
  }

  public claimMemberRecovery(token: string, now: string): {
    member: MemberRecord;
    session: IssuedCredential;
    user: WebUserRecord;
  } {
    const invalid = () => new AuthorizationError(
      "UNAUTHENTICATED", "Invalid or expired member recovery code"
    );
    return this.database.transaction(() => {
      const recovery = this.database.prepare(`
        SELECT recovery_id, team_id, member_id, user_id, created_by_member_id,
               expires_at, consumed_at, revoked_at
        FROM web_member_recoveries WHERE token_hash = ?
      `).get(hash(token)) as MemberRecoveryRow | undefined;
      const timestamp = Date.parse(now);
      if (
        !recovery || !Number.isFinite(timestamp) ||
        recovery.consumed_at !== null || recovery.revoked_at !== null ||
        !Number.isFinite(Date.parse(recovery.expires_at)) ||
        Date.parse(recovery.expires_at) <= timestamp
      ) throw invalid();

      const issuer = this.repository.getMember(recovery.created_by_member_id);
      const member = this.recoverableMember(recovery.team_id, recovery.member_id);
      const user = member?.userId === recovery.user_id
        ? this.repository.getUser(recovery.user_id)
        : undefined;
      if (
        !member || !user || !issuer?.userId || issuer.role !== "owner" ||
        issuer.teamId !== recovery.team_id
      ) throw invalid();

      const consumed = this.database.prepare(`
        UPDATE web_member_recoveries SET consumed_at = ?
        WHERE recovery_id = ? AND consumed_at IS NULL AND revoked_at IS NULL
      `).run(now, recovery.recovery_id);
      if (consumed.changes !== 1) throw invalid();
      this.auth.revokeWebSessionsForUser(user.userId, now);
      return {
        member,
        user,
        session: this.auth.issueWebSession(
          user.userId, now, future(now, sessionDurationMilliseconds)
        )
      };
    }).immediate();
  }

  private requireRecoveryOwner(principal: WebPrincipal, teamId: string) {
    const actor = this.auth.requireTeamMember(principal, teamId);
    if (actor.role !== "owner") {
      throw new AuthorizationError("FORBIDDEN", "Only a Team owner can recover members");
    }
    return actor;
  }

  private recoverableMember(teamId: string, memberId: string): MemberRecord | undefined {
    const team = this.repository.getTeam(teamId);
    const member = this.repository.getMember(memberId);
    if (
      !team || team.archivedAt || !member?.userId || member.teamId !== teamId ||
      member.role !== "member" || member.userId === this.ownerUserId()
    ) return undefined;
    // Web sessions cover a whole User. A Team Owner cannot recover authority
    // in another Team (including archived memberships) or any Owner identity.
    const memberships = this.database.prepare(`
      SELECT COUNT(*) AS count FROM team_members WHERE user_id = ?
    `).get(member.userId) as { count: number };
    return memberships.count === 1 ? member : undefined;
  }

  private ownerUserId(): string | undefined {
    return (this.database.prepare(`
      SELECT value FROM system_metadata WHERE key = ?
    `).get(ownerMetadataKey) as { value: string } | undefined)?.value;
  }

  private requireRecoveryToken(candidate: string): void {
    const actual = createHash("sha256").update(candidate).digest();
    const row = this.ownerRecoveryRow();
    const expected = row ? Buffer.from(row.token_hash, "hex") : this.expectedRecoveryHash;
    if (!timingSafeEqual(actual, expected)) {
      throw new AuthorizationError("UNAUTHENTICATED", "Invalid recovery token");
    }
  }

  private ownerRecoveryRow(): OwnerRecoveryRow | undefined {
    return this.database.prepare(`
      SELECT token_hash, revision, updated_at FROM web_owner_recovery_credentials
      WHERE singleton = 1
    `).get() as OwnerRecoveryRow | undefined;
  }

  private requireInstallationOwner(principal: WebPrincipal): void {
    if (!this.isInstallationOwner(principal.userId)) {
      throw new AuthorizationError("FORBIDDEN", "Only the installation Owner can replace the recovery key");
    }
  }
}
