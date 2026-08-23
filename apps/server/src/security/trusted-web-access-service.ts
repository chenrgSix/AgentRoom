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
      } else if (ownerCandidates.length === 0 && userCount.count === 0) {
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

  private ownerUserId(): string | undefined {
    return (this.database.prepare(`
      SELECT value FROM system_metadata WHERE key = ?
    `).get(ownerMetadataKey) as { value: string } | undefined)?.value;
  }

  private requireRecoveryToken(candidate: string): void {
    const actual = createHash("sha256").update(candidate).digest();
    if (!timingSafeEqual(actual, this.expectedRecoveryHash)) {
      throw new AuthorizationError("UNAUTHENTICATED", "Invalid recovery token");
    }
  }
}
