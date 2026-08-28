import {
  createHash,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

import type {
  DevicePairingSessionApproveRequest,
  DevicePairingSessionCancelRequest,
  DevicePairingSessionClaimed,
  DevicePairingSessionCreateRequest,
  DevicePairingSessionCreated,
  DevicePairingSessionOwnerProjection,
  DevicePairingSessionPollProjection,
  DevicePairingPrivateTrustDescriptor,
  DevicePairingSessionRejectRequest,
  Platform
} from "@convene-wire/contracts/pairing-session";
import type Database from "better-sqlite3";

import type { CoreRepository, DeviceRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  AuthorizationError,
  type AuthService,
  type MemberPrincipal,
  type WebPrincipal
} from "./auth-service.js";
import type { DeploymentTrustProvider } from "./deployment-trust.js";

type PairingState =
  | "issued"
  | "claimed"
  | "approved"
  | "consumed"
  | "rejected"
  | "canceled"
  | "expired";

type DecisionAction = "approve" | "reject" | "cancel";
type DecisionExpectedState = "issued" | "claimed";

interface PairingSessionRow {
  pairing_session_id: string;
  team_id: string;
  owner_member_id: string;
  create_operation_id: string;
  claim_secret_hash: string;
  short_code_hash: string;
  state: PairingState;
  created_at: string;
  expires_at: string;
  pairing_attempt_id: string | null;
  claim_operation_id: string | null;
  poll_secret_hash: string | null;
  device_display_name: string | null;
  device_platform: Platform | null;
  bridge_version: string | null;
  device_supports_scoped_private_trust: 0 | 1 | null;
  trust_mode: "private_scoped_ca" | null;
  trust_origin: string | null;
  trust_installation_id: string | null;
  trust_epoch: number | null;
  trust_ca_sha256: string | null;
  verification_phrase: string | null;
  claimed_at: string | null;
  decision_operation_id: string | null;
  decision_action: DecisionAction | null;
  decision_expected_state: DecisionExpectedState | null;
  decided_by_member_id: string | null;
  decision_reason: string | null;
  decided_at: string | null;
  consumed_at: string | null;
  device_id: string | null;
  credential_id: string | null;
}

export interface PairingClaimInput {
  operationId: string;
  pairingAttemptId: string;
  pollSecret: string;
  device: {
    displayName: string;
    platform: Platform;
    bridgeVersion: string;
    supportsScopedPrivateTrust?: boolean;
  };
  trust?: DevicePairingPrivateTrustDescriptor;
}

const pairingSessionPattern = /^pairing_[A-Za-z0-9_-]{8,128}$/u;
const pairingAttemptPattern = /^pairattempt_[A-Za-z0-9_-]{8,128}$/u;
const operationPattern = /^op_[A-Za-z0-9_-]{8,128}$/u;
const secretPattern = /^[A-Za-z0-9_-]{43,128}$/u;
const shortCodePattern = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/u;
const bridgeVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const platforms = new Set<Platform>([
  "darwin-amd64",
  "darwin-arm64",
  "linux-amd64",
  "linux-arm64",
  "windows-amd64",
  "windows-arm64"
]);
const shortCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const phraseFirst = [
  "AMBER", "BRISK", "CEDAR", "CORAL", "FROST", "GREEN", "IVORY", "LUNAR",
  "MAPLE", "NOBLE", "QUIET", "RAPID", "SILVER", "SOLAR", "VIOLET", "WARM"
] as const;
const phraseSecond = [
  "BAY", "BIRD", "CLOUD", "FIELD", "FOREST", "HARBOR", "LAKE", "MEADOW",
  "MOON", "PINE", "RIVER", "ROCK", "STAR", "SUMMIT", "TRAIL", "WAVE"
] as const;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function hash(value: string): string {
  return digest(value).toString("hex");
}

function safeHashMatch(value: string, expectedHash: string): boolean {
  const actual = digest(value);
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function requiredOpaqueId(
  value: string,
  pattern: RegExp,
  label: string
): string {
  if (!pattern.test(value)) throw invalidSession(label);
  return value;
}

function requiredSecret(value: string, label: string): string {
  if (!secretPattern.test(value)) throw invalidSession(label);
  return value;
}

function normalizeShortCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!shortCodePattern.test(normalized)) throw invalidSession("short code");
  return normalized;
}

function normalizeReason(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 280) {
    throw new Error("Device pairing reason must contain 1 to 280 characters");
  }
  return normalized;
}

function normalizeClaim(input: PairingClaimInput): PairingClaimInput {
  const displayName = input.device.displayName.trim();
  if (displayName.length < 1 || displayName.length > 80) {
    throw new Error("Device display name must contain 1 to 80 characters");
  }
  if (!platforms.has(input.device.platform)) {
    throw new Error("Device platform is unsupported");
  }
  if (!bridgeVersionPattern.test(input.device.bridgeVersion)) {
    throw new Error("Bridge version is invalid");
  }
  if (
    input.device.supportsScopedPrivateTrust !== undefined &&
    typeof input.device.supportsScopedPrivateTrust !== "boolean"
  ) {
    throw invalidSession("scoped private trust capability");
  }
  return {
    operationId: requiredOpaqueId(
      input.operationId,
      operationPattern,
      "claim operation"
    ),
    pairingAttemptId: requiredOpaqueId(
      input.pairingAttemptId,
      pairingAttemptPattern,
      "pairing attempt"
    ),
    pollSecret: requiredSecret(input.pollSecret, "poll proof"),
    device: {
      displayName,
      platform: input.device.platform,
      bridgeVersion: input.device.bridgeVersion,
      ...(input.device.supportsScopedPrivateTrust === undefined
        ? {}
        : {
            supportsScopedPrivateTrust:
              input.device.supportsScopedPrivateTrust
          })
    },
    ...(input.trust === undefined ? {} : { trust: input.trust })
  };
}

function invalidSession(_detail?: string): Error {
  return new Error("Invalid or expired Device pairing session");
}

function conflict(message: string): Error {
  return new Error(`Device pairing conflict: ${message}`);
}

function derivedShortCode(pairingSessionId: string, claimSecret: string): string {
  const value = digest(`${pairingSessionId}\0${claimSecret}`);
  let compact = "";
  for (let index = 0; index < 10; index += 1) {
    compact += shortCodeAlphabet[value[index]! % shortCodeAlphabet.length];
  }
  return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
}

function verificationPhrase(
  row: PairingSessionRow,
  input: PairingClaimInput,
  pollSecretHash: string
): string {
  const value = digest(JSON.stringify([
    row.pairing_session_id,
    row.team_id,
    row.owner_member_id,
    row.claim_secret_hash,
    input.operationId,
    input.pairingAttemptId,
    pollSecretHash,
    input.device.displayName,
    input.device.platform,
    input.device.bridgeVersion,
    input.device.supportsScopedPrivateTrust ?? null,
    rowTrust(row) ?? null
  ]));
  return `${phraseFirst[value[0]! % phraseFirst.length]}-${
    phraseSecond[value[1]! % phraseSecond.length]
  }-${String(((value[2]! << 8) + value[3]!) % 100).padStart(2, "0")}`;
}

function rowTrust(
  row: PairingSessionRow
): DevicePairingPrivateTrustDescriptor | undefined {
  const fields = [
    row.trust_mode,
    row.trust_origin,
    row.trust_installation_id,
    row.trust_epoch,
    row.trust_ca_sha256
  ];
  if (fields.every((value) => value === null)) return undefined;
  if (
    row.trust_mode !== "private_scoped_ca" || !row.trust_origin ||
    !row.trust_installation_id || row.trust_epoch === null ||
    !row.trust_ca_sha256
  ) {
    throw conflict("stored trust descriptor is incomplete");
  }
  return {
    mode: row.trust_mode,
    origin: row.trust_origin,
    installationId: row.trust_installation_id,
    trustEpoch: row.trust_epoch,
    caCertificateSha256: row.trust_ca_sha256
  };
}

function sameTrust(
  left: DevicePairingPrivateTrustDescriptor | undefined,
  right: DevicePairingPrivateTrustDescriptor | undefined
): boolean {
  if (!left || !right) return left === right;
  return left.mode === right.mode && left.origin === right.origin &&
    left.installationId === right.installationId &&
    left.trustEpoch === right.trustEpoch &&
    left.caCertificateSha256 === right.caCertificateSha256;
}

function isPreDecision(state: PairingState): state is "issued" | "claimed" {
  return state === "issued" || state === "claimed";
}

export class DevicePairingSessionService {
  public constructor(
    private readonly database: Database.Database,
    private readonly core: CoreRepository,
    private readonly auth: AuthService,
    private readonly deploymentTrust: DeploymentTrustProvider = () => undefined
  ) {}

  public create(
    principal: WebPrincipal,
    teamId: string,
    input: DevicePairingSessionCreateRequest,
    now: string
  ): DevicePairingSessionCreated {
    const owner = this.requireOwner(principal, teamId);
    const operationId = requiredOpaqueId(
      input.operationId,
      operationPattern,
      "create operation"
    );
    const claimSecret = requiredSecret(input.claimSecret, "claim proof");
    const claimSecretHash = hash(claimSecret);
    const trust = this.deploymentTrust();

    return this.database.transaction((): DevicePairingSessionCreated => {
      const existing = this.findByCreateOperation(owner.memberId, operationId);
      if (existing) {
        if (
          existing.team_id !== teamId ||
          !safeHashMatch(claimSecret, existing.claim_secret_hash) ||
          !sameTrust(rowTrust(existing), trust)
        ) {
          throw conflict("create operation was reused with different input");
        }
        const current = this.expire(existing, now);
        if (current.state !== "issued") {
          throw conflict(`session is ${current.state}`);
        }
        return this.createdProjection(current, claimSecret);
      }

      const expiresAt = new Date(Date.parse(now) + 10 * 60 * 1_000).toISOString();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const pairingSessionId = createOpaqueId("pairing");
        const shortCode = derivedShortCode(pairingSessionId, claimSecret);
        try {
          this.database.prepare(`
            INSERT INTO device_pairing_sessions (
              pairing_session_id, team_id, owner_member_id,
              create_operation_id, claim_secret_hash, short_code_hash, state,
              created_at, expires_at, trust_mode, trust_origin,
              trust_installation_id, trust_epoch, trust_ca_sha256
            ) VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            pairingSessionId,
            teamId,
            owner.memberId,
            operationId,
            claimSecretHash,
            hash(shortCode),
            now,
            expiresAt,
            trust?.mode ?? null,
            trust?.origin ?? null,
            trust?.installationId ?? null,
            trust?.trustEpoch ?? null,
            trust?.caCertificateSha256 ?? null
          );
          return {
            pairingSessionId,
            teamId,
            ownerMemberId: owner.memberId,
            state: "issued",
            shortCode,
            createdAt: now,
            expiresAt,
            ...(trust ? { trust } : {})
          };
        } catch (error) {
          const raced = this.findByCreateOperation(owner.memberId, operationId);
          if (raced) {
            if (
              raced.team_id !== teamId ||
              !safeHashMatch(claimSecret, raced.claim_secret_hash) ||
              !sameTrust(rowTrust(raced), trust)
            ) {
              throw conflict("create operation was reused with different input");
            }
            const current = this.expire(raced, now);
            if (current.state !== "issued") {
              throw conflict(`session is ${current.state}`);
            }
            return this.createdProjection(current, claimSecret);
          }
          if (
            !(error instanceof Error) ||
            !error.message.includes("device_pairing_sessions.short_code_hash")
          ) {
            throw error;
          }
        }
      }
      throw new Error("Could not allocate a unique Device pairing short code");
    }).immediate();
  }

  public get(
    principal: WebPrincipal,
    teamId: string,
    pairingSessionId: string,
    now: string
  ): DevicePairingSessionOwnerProjection {
    this.requireOwner(principal, teamId);
    requiredOpaqueId(pairingSessionId, pairingSessionPattern, "pairing session");
    return this.database.transaction((): DevicePairingSessionOwnerProjection => {
      const row = this.findOwnerSession(teamId, pairingSessionId);
      if (!row) throw invalidSession();
      return this.ownerProjection(this.expire(row, now));
    }).immediate();
  }

  public claimBySecret(
    pairingSessionId: string,
    claimSecret: string,
    input: PairingClaimInput,
    now: string
  ): DevicePairingSessionClaimed {
    requiredOpaqueId(pairingSessionId, pairingSessionPattern, "pairing session");
    requiredSecret(claimSecret, "claim proof");
    return this.claim(
      () => {
        const row = this.find(pairingSessionId);
        return row && safeHashMatch(claimSecret, row.claim_secret_hash)
          ? row
          : undefined;
      },
      input,
      now,
      true
    );
  }

  public claimByShortCode(
    shortCode: string,
    input: PairingClaimInput,
    now: string
  ): DevicePairingSessionClaimed {
    const normalized = normalizeShortCode(shortCode);
    return this.claim(() => this.database.prepare(`
      SELECT * FROM device_pairing_sessions WHERE short_code_hash = ?
    `).get(hash(normalized)) as PairingSessionRow | undefined, input, now, false);
  }

  public poll(
    pairingSessionId: string,
    pairingAttemptId: string,
    pollSecret: string,
    now: string
  ): DevicePairingSessionPollProjection {
    requiredOpaqueId(pairingSessionId, pairingSessionPattern, "pairing session");
    requiredOpaqueId(pairingAttemptId, pairingAttemptPattern, "pairing attempt");
    requiredSecret(pollSecret, "poll proof");

    return this.database.transaction((): DevicePairingSessionPollProjection => {
      const found = this.find(pairingSessionId);
      if (
        !found ||
        found.pairing_attempt_id !== pairingAttemptId ||
        !found.poll_secret_hash ||
        !safeHashMatch(pollSecret, found.poll_secret_hash)
      ) {
        throw invalidSession();
      }
      const row = this.expire(found, now);
      if (row.state === "claimed") {
        return {
          pairingSessionId,
          pairingAttemptId,
          state: "claimed",
          verificationPhrase: row.verification_phrase!,
          expiresAt: row.expires_at,
          retryAfterMs: 1_000
        };
      }
      if (row.state === "approved") {
        const consumed = this.database.prepare(`
          UPDATE device_pairing_sessions
          SET state = 'consumed', consumed_at = ?
          WHERE pairing_session_id = ? AND state = 'approved'
        `).run(now, pairingSessionId);
        if (consumed.changes !== 1) {
          throw conflict("poll consumption raced");
        }
        return this.consumedProjection({
          ...row,
          state: "consumed",
          consumed_at: now
        });
      }
      if (row.state === "consumed") return this.consumedProjection(row);
      if (["rejected", "canceled", "expired"].includes(row.state)) {
        return {
          pairingSessionId,
          pairingAttemptId,
          state: row.state as "rejected" | "canceled" | "expired",
          expiresAt: row.expires_at
        };
      }
      throw invalidSession();
    }).immediate();
  }

  public approve(
    principal: WebPrincipal,
    teamId: string,
    pairingSessionId: string,
    input: DevicePairingSessionApproveRequest,
    now: string
  ): DevicePairingSessionOwnerProjection {
    return this.decide(
      principal,
      teamId,
      pairingSessionId,
      "approve",
      input.expectedState,
      input.operationId,
      null,
      now
    );
  }

  public reject(
    principal: WebPrincipal,
    teamId: string,
    pairingSessionId: string,
    input: DevicePairingSessionRejectRequest,
    now: string
  ): DevicePairingSessionOwnerProjection {
    return this.decide(
      principal,
      teamId,
      pairingSessionId,
      "reject",
      input.expectedState,
      input.operationId,
      normalizeReason(input.reason),
      now
    );
  }

  public cancel(
    principal: WebPrincipal,
    teamId: string,
    pairingSessionId: string,
    input: DevicePairingSessionCancelRequest,
    now: string
  ): DevicePairingSessionOwnerProjection {
    return this.decide(
      principal,
      teamId,
      pairingSessionId,
      "cancel",
      input.expectedState,
      input.operationId,
      normalizeReason(input.reason),
      now
    );
  }

  private claim(
    locate: () => PairingSessionRow | undefined,
    rawInput: PairingClaimInput,
    now: string,
    allowPrivateTrust: boolean
  ): DevicePairingSessionClaimed {
    const input = normalizeClaim(rawInput);
    const pollSecretHash = hash(input.pollSecret);
    return this.database.transaction((): DevicePairingSessionClaimed => {
      const found = locate();
      if (!found) throw invalidSession();
      const row = this.expire(found, now);
      const expectedTrust = rowTrust(row);
      if (
        !sameTrust(expectedTrust, input.trust) ||
        (expectedTrust &&
          (!allowPrivateTrust ||
            input.device.supportsScopedPrivateTrust !== true))
      ) {
        throw invalidSession();
      }
      if (this.isExactClaim(row, input, pollSecretHash)) {
        if (row.state === "expired") throw invalidSession();
        return this.claimedProjection(row);
      }
      if (row.state !== "issued") throw invalidSession();
      const phrase = verificationPhrase(row, input, pollSecretHash);
      const updated = this.database.prepare(`
        UPDATE device_pairing_sessions
        SET state = 'claimed', pairing_attempt_id = ?, claim_operation_id = ?,
            poll_secret_hash = ?, device_display_name = ?,
            device_platform = ?, bridge_version = ?,
            device_supports_scoped_private_trust = ?,
            verification_phrase = ?, claimed_at = ?
        WHERE pairing_session_id = ? AND state = 'issued' AND expires_at > ?
      `).run(
        input.pairingAttemptId,
        input.operationId,
        pollSecretHash,
        input.device.displayName,
        input.device.platform,
        input.device.bridgeVersion,
        input.device.supportsScopedPrivateTrust === undefined
          ? null
          : Number(input.device.supportsScopedPrivateTrust),
        phrase,
        now,
        row.pairing_session_id,
        now
      );
      if (updated.changes !== 1) throw invalidSession();
      return {
        pairingSessionId: row.pairing_session_id,
        pairingAttemptId: input.pairingAttemptId,
        state: "claimed",
        verificationPhrase: phrase,
        expiresAt: row.expires_at,
        pollIntervalMs: 1_000
      };
    }).immediate();
  }

  private decide(
    principal: WebPrincipal,
    teamId: string,
    pairingSessionId: string,
    action: DecisionAction,
    expectedState: DecisionExpectedState,
    operationId: string,
    reason: string | null,
    now: string
  ): DevicePairingSessionOwnerProjection {
    const decidingOwner = this.requireOwner(principal, teamId);
    requiredOpaqueId(pairingSessionId, pairingSessionPattern, "pairing session");
    requiredOpaqueId(operationId, operationPattern, "decision operation");
    if (
      (action === "approve" || action === "reject") &&
      expectedState !== "claimed"
    ) {
      throw conflict("decision expected state is invalid");
    }

    return this.database.transaction(() => {
      const found = this.findOwnerSession(teamId, pairingSessionId);
      if (!found) throw invalidSession();
      const row = this.expire(found, now);
      if (row.decision_operation_id === operationId) {
        if (
          row.decision_action !== action ||
          row.decision_expected_state !== expectedState ||
          row.decided_by_member_id !== decidingOwner.memberId ||
          row.decision_reason !== reason
        ) {
          throw conflict("decision operation was reused with different input");
        }
        return this.ownerProjection(row);
      }
      if (row.state !== expectedState) {
        throw conflict(`session is ${row.state}, expected ${expectedState}`);
      }

      if (action === "approve") {
        const approved = this.approveRow(
          row,
          operationId,
          "claimed",
          decidingOwner.memberId,
          now
        );
        return this.ownerProjection(approved);
      }
      const nextState = action === "reject" ? "rejected" : "canceled";
      const updated = this.database.prepare(`
        UPDATE device_pairing_sessions
        SET state = ?, decision_operation_id = ?, decision_action = ?,
            decision_expected_state = ?, decided_by_member_id = ?,
            decision_reason = ?, decided_at = ?
        WHERE pairing_session_id = ? AND state = ?
      `).run(
        nextState,
        operationId,
        action,
        expectedState,
        decidingOwner.memberId,
        reason,
        now,
        pairingSessionId,
        expectedState
      );
      if (updated.changes !== 1) throw conflict("decision raced");
      return this.ownerProjection({
        ...row,
        state: nextState,
        decision_operation_id: operationId,
        decision_action: action,
        decision_expected_state: expectedState,
        decided_by_member_id: decidingOwner.memberId,
        decision_reason: reason,
        decided_at: now
      });
    }).immediate();
  }

  private approveRow(
    row: PairingSessionRow,
    operationId: string,
    expectedState: "claimed",
    decidedByMemberId: string,
    now: string
  ): PairingSessionRow {
    if (!row.poll_secret_hash || !row.device_display_name) {
      throw conflict("claimed proof is incomplete");
    }
    const device: DeviceRecord = {
      deviceId: createOpaqueId("device"),
      teamId: row.team_id,
      ownerMemberId: row.owner_member_id,
      name: row.device_display_name,
      status: "active",
      createdAt: now,
      revokedAt: null
    };
    this.core.createDevice(device);
    const credentialId = createOpaqueId("credential");
    this.database.prepare(`
      INSERT INTO device_credentials (
        credential_id, device_id, secret_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, NULL)
    `).run(credentialId, device.deviceId, row.poll_secret_hash, now);
    const updated = this.database.prepare(`
      UPDATE device_pairing_sessions
      SET state = 'approved', decision_operation_id = ?,
          decision_action = 'approve', decision_expected_state = ?,
          decided_by_member_id = ?, decided_at = ?, device_id = ?,
          credential_id = ?
      WHERE pairing_session_id = ? AND state = 'claimed'
    `).run(
      operationId,
      expectedState,
      decidedByMemberId,
      now,
      device.deviceId,
      credentialId,
      row.pairing_session_id
    );
    if (updated.changes !== 1) throw conflict("approval raced");
    return {
      ...row,
      state: "approved",
      decision_operation_id: operationId,
      decision_action: "approve",
      decision_expected_state: expectedState,
      decided_by_member_id: decidedByMemberId,
      decided_at: now,
      device_id: device.deviceId,
      credential_id: credentialId
    };
  }

  private expire(row: PairingSessionRow, now: string): PairingSessionRow {
    if (!isPreDecision(row.state) || Date.parse(row.expires_at) > Date.parse(now)) {
      return row;
    }
    const expired = this.database.prepare(`
      UPDATE device_pairing_sessions SET state = 'expired'
      WHERE pairing_session_id = ? AND state = ?
    `).run(row.pairing_session_id, row.state);
    return expired.changes === 1 ? { ...row, state: "expired" } : row;
  }

  private isExactClaim(
    row: PairingSessionRow,
    input: PairingClaimInput,
    pollSecretHash: string
  ): boolean {
    return row.claim_operation_id === input.operationId &&
      row.pairing_attempt_id === input.pairingAttemptId &&
      row.poll_secret_hash === pollSecretHash &&
      row.device_display_name === input.device.displayName &&
      row.device_platform === input.device.platform &&
      row.bridge_version === input.device.bridgeVersion &&
      row.device_supports_scoped_private_trust === (
        input.device.supportsScopedPrivateTrust === undefined
          ? null
          : Number(input.device.supportsScopedPrivateTrust)
      );
  }

  private createdProjection(
    row: PairingSessionRow,
    claimSecret: string
  ): DevicePairingSessionCreated {
    return {
      pairingSessionId: row.pairing_session_id,
      teamId: row.team_id,
      ownerMemberId: row.owner_member_id,
      state: "issued",
      shortCode: derivedShortCode(row.pairing_session_id, claimSecret),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(rowTrust(row) ? { trust: rowTrust(row)! } : {})
    };
  }

  private claimedProjection(row: PairingSessionRow): DevicePairingSessionClaimed {
    if (!row.pairing_attempt_id || !row.verification_phrase) {
      throw conflict("claimed projection is incomplete");
    }
    return {
      pairingSessionId: row.pairing_session_id,
      pairingAttemptId: row.pairing_attempt_id,
      state: "claimed",
      verificationPhrase: row.verification_phrase,
      expiresAt: row.expires_at,
      pollIntervalMs: 1_000
    };
  }

  private consumedProjection(
    row: PairingSessionRow
  ): DevicePairingSessionPollProjection {
    if (!row.pairing_attempt_id || !row.device_id) {
      throw conflict("consumed projection is incomplete");
    }
    return {
      pairingSessionId: row.pairing_session_id,
      pairingAttemptId: row.pairing_attempt_id,
      state: "consumed",
      deviceId: row.device_id,
      teamId: row.team_id,
      ownerMemberId: row.owner_member_id,
      credentialSource: "poll_secret"
    };
  }

  private ownerProjection(
    row: PairingSessionRow
  ): DevicePairingSessionOwnerProjection {
    return {
      pairingSessionId: row.pairing_session_id,
      teamId: row.team_id,
      ownerMemberId: row.owner_member_id,
      state: row.state,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      ...(row.pairing_attempt_id
        ? { pairingAttemptId: row.pairing_attempt_id }
        : {}),
      ...(row.device_display_name && row.device_platform && row.bridge_version
        ? {
            device: {
              displayName: row.device_display_name,
              platform: row.device_platform,
              bridgeVersion: row.bridge_version,
              ...(row.device_supports_scoped_private_trust === null
                ? {}
                : {
                    supportsScopedPrivateTrust:
                      row.device_supports_scoped_private_trust === 1
                  })
            }
          }
        : {}),
      ...(row.verification_phrase
        ? { verificationPhrase: row.verification_phrase }
        : {}),
      ...(rowTrust(row) ? { trust: rowTrust(row)! } : {}),
      ...(row.device_id ? { deviceId: row.device_id } : {}),
      ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
      ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
      ...(row.consumed_at ? { consumedAt: row.consumed_at } : {})
    };
  }

  private find(pairingSessionId: string): PairingSessionRow | undefined {
    return this.database.prepare(`
      SELECT * FROM device_pairing_sessions WHERE pairing_session_id = ?
    `).get(pairingSessionId) as PairingSessionRow | undefined;
  }

  private findOwnerSession(
    teamId: string,
    pairingSessionId: string
  ): PairingSessionRow | undefined {
    return this.database.prepare(`
      SELECT * FROM device_pairing_sessions
      WHERE pairing_session_id = ? AND team_id = ?
    `).get(pairingSessionId, teamId) as PairingSessionRow | undefined;
  }

  private findByCreateOperation(
    ownerMemberId: string,
    operationId: string
  ): PairingSessionRow | undefined {
    return this.database.prepare(`
      SELECT * FROM device_pairing_sessions
      WHERE owner_member_id = ? AND create_operation_id = ?
    `).get(ownerMemberId, operationId) as PairingSessionRow | undefined;
  }

  private requireOwner(
    principal: WebPrincipal,
    teamId: string
  ): MemberPrincipal {
    const member = this.auth.requireTeamMember(principal, teamId);
    if (member.role !== "owner") {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Only a Team owner can manage Device pairing sessions"
      );
    }
    return member;
  }
}
