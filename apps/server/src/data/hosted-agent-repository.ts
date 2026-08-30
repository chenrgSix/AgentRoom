import { randomBytes } from "node:crypto";

import type Database from "better-sqlite3";

import { createOpaqueId } from "../domain/identifiers.js";
import {
  createHostedCredentialKeyring,
  decryptHostedCredential,
  encryptHostedCredential,
  type HostedCredentialEnvelope,
  type HostedCredentialScope,
  type HostedWrappedDataKey,
  unwrapHostedCredentialDataKey
} from "../security/hosted-credential-cipher.js";
import { SqliteTransactionBoundary } from "./sqlite-transaction-boundary.js";

export const hostedProvider = "openai_responses" as const;

export interface HostedExecutionLimits {
  maxInputCharacters: number;
  maxOutputCharacters: number;
  timeoutSeconds: number;
}

export const defaultHostedExecutionLimits: HostedExecutionLimits = {
  maxInputCharacters: 60_000,
  maxOutputCharacters: 20_000,
  timeoutSeconds: 120
};

export interface HostedRuntimeProfileRecord {
  agentId: string;
  teamId: string;
  profileRevision: number;
  provider: typeof hostedProvider;
  model: string;
  credentialVersion: number;
  executionLimits: HostedExecutionLimits;
  createdByMemberId: string;
  createdAt: string;
  supersededAt: string | null;
}

export interface HostedAgentConfigurationRecord {
  agentId: string;
  teamId: string;
  name: string;
  role: string;
  enabled: boolean;
  presence: "ready" | "busy" | "degraded" | "offline";
  roomIds: string[];
  profileRevision: number;
  provider: typeof hostedProvider;
  model: string;
  credentialConfigured: boolean;
  credentialRevoked: boolean;
  latestTest: HostedProviderTestObservation | null;
  updatedAt: string;
}

export interface HostedProviderTestObservation {
  observationId: string;
  teamId: string;
  agentId: string | null;
  profileRevision: number | null;
  provider: typeof hostedProvider;
  model: string;
  status: "succeeded" | "failed";
  failureCode: string | null;
  observedAt: string;
}

export interface HostedExecutionProfile {
  agentId: string;
  teamId: string;
  profileRevision: number;
  credentialVersion: number;
  provider: typeof hostedProvider;
  model: string;
  apiKey: string;
  executionLimits: HostedExecutionLimits;
}

export type HostedCredentialRoot =
  | { mode: "trusted_recovery"; secret: string }
  | { mode: "local_database" };

interface KeyringRow {
  key_version: number;
  root_mode: HostedCredentialRoot["mode"];
  key_derivation: "hkdf-sha256";
  wrapping_cipher: "aes-256-gcm";
  kdf_salt: Buffer;
  local_root_key: Buffer | null;
  wrapped_data_key_ciphertext: Buffer;
  wrapped_data_key_nonce: Buffer;
  wrapped_data_key_auth_tag: Buffer;
  retired_at: string | null;
}

interface CredentialRow {
  credential_id: string;
  agent_id: string;
  team_id: string;
  credential_version: number;
  provider: typeof hostedProvider;
  key_version: number;
  encryption_cipher: "aes-256-gcm";
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  revoked_at: string | null;
}

interface ProfileRow {
  agent_id: string;
  team_id: string;
  profile_revision: number;
  provider: typeof hostedProvider;
  model: string;
  credential_version: number;
  execution_limits_json: string;
  created_by_member_id: string;
  created_at: string;
  superseded_at: string | null;
}

interface ObservationRow {
  observation_id: string;
  team_id: string;
  agent_id: string | null;
  profile_revision: number | null;
  provider: typeof hostedProvider;
  model: string;
  status: "succeeded" | "failed";
  failure_code: string | null;
  observed_at: string;
}

function mapProfile(row: ProfileRow): HostedRuntimeProfileRecord {
  const limits = JSON.parse(row.execution_limits_json) as Partial<HostedExecutionLimits>;
  if (
    !Number.isSafeInteger(limits.maxInputCharacters) ||
    !Number.isSafeInteger(limits.maxOutputCharacters) ||
    !Number.isSafeInteger(limits.timeoutSeconds)
  ) {
    throw new Error("Hosted Runtime Profile execution limits are invalid");
  }
  return {
    agentId: row.agent_id,
    teamId: row.team_id,
    profileRevision: row.profile_revision,
    provider: row.provider,
    model: row.model,
    credentialVersion: row.credential_version,
    executionLimits: limits as HostedExecutionLimits,
    createdByMemberId: row.created_by_member_id,
    createdAt: row.created_at,
    supersededAt: row.superseded_at
  };
}

function mapObservation(row: ObservationRow): HostedProviderTestObservation {
  return {
    observationId: row.observation_id,
    teamId: row.team_id,
    agentId: row.agent_id,
    profileRevision: row.profile_revision,
    provider: row.provider,
    model: row.model,
    status: row.status,
    failureCode: row.failure_code,
    observedAt: row.observed_at
  };
}

export class HostedAgentRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly root: HostedCredentialRoot,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public createCredential(input: {
    agentId: string;
    teamId: string;
    createdByMemberId: string;
    apiKey: string;
    now: string;
  }): { credentialId: string; credentialVersion: number } {
    return this.transactions.immediate(() => {
      const active = this.database.prepare(`
        SELECT credential_version FROM hosted_provider_credentials
        WHERE agent_id = ? AND revoked_at IS NULL
      `).get(input.agentId) as { credential_version: number } | undefined;
      const credentialVersion = (this.database.prepare(`
        SELECT COALESCE(MAX(credential_version), 0) + 1 AS next_version
        FROM hosted_provider_credentials WHERE agent_id = ?
      `).get(input.agentId) as { next_version: number }).next_version;
      if (active) {
        this.database.prepare(`
          UPDATE hosted_provider_credentials
          SET revoked_at = ?, replaced_by_version = ?
          WHERE agent_id = ? AND credential_version = ? AND revoked_at IS NULL
        `).run(
          input.now,
          credentialVersion,
          input.agentId,
          active.credential_version
        );
      }

      const { dataKey, keyVersion } = this.currentDataKey(input.now);
      try {
        const credentialId = createOpaqueId("hostedcred");
        const scope: HostedCredentialScope = {
          credentialId,
          agentId: input.agentId,
          teamId: input.teamId,
          provider: hostedProvider,
          keyVersion
        };
        const envelope = encryptHostedCredential(input.apiKey, dataKey, scope);
        this.database.prepare(`
          INSERT INTO hosted_provider_credentials (
            credential_id, agent_id, team_id, credential_version, provider,
            key_version, encryption_cipher, ciphertext, nonce, auth_tag,
            created_by_member_id, created_at, revoked_at, replaced_by_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).run(
          credentialId,
          input.agentId,
          input.teamId,
          credentialVersion,
          hostedProvider,
          keyVersion,
          envelope.cipher,
          envelope.ciphertext,
          envelope.nonce,
          envelope.tag,
          input.createdByMemberId,
          input.now
        );
        return { credentialId, credentialVersion };
      } finally {
        dataKey.fill(0);
      }
    });
  }

  public createProfile(input: {
    agentId: string;
    teamId: string;
    provider: typeof hostedProvider;
    model: string;
    credentialVersion: number;
    createdByMemberId: string;
    now: string;
    expectedRevision?: number;
    executionLimits?: HostedExecutionLimits;
  }): HostedRuntimeProfileRecord {
    return this.transactions.immediate(() => {
      const current = this.getCurrentProfile(input.agentId);
      if (input.expectedRevision === undefined) {
        if (current) throw new Error("Hosted Runtime Profile already exists");
      } else if (current?.profileRevision !== input.expectedRevision) {
        throw new Error("Hosted Runtime Profile changed; reload and retry");
      }
      const profileRevision = (current?.profileRevision ?? 0) + 1;
      if (current) {
        const superseded = this.database.prepare(`
          UPDATE hosted_runtime_profiles SET superseded_at = ?
          WHERE agent_id = ? AND profile_revision = ? AND superseded_at IS NULL
        `).run(input.now, input.agentId, current.profileRevision);
        if (superseded.changes !== 1) {
          throw new Error("Hosted Runtime Profile changed; reload and retry");
        }
      }
      this.database.prepare(`
        INSERT INTO hosted_runtime_profiles (
          agent_id, team_id, profile_revision, provider, model,
          credential_version, execution_limits_json, created_by_member_id,
          created_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        input.agentId,
        input.teamId,
        profileRevision,
        input.provider,
        input.model,
        input.credentialVersion,
        JSON.stringify(input.executionLimits ?? defaultHostedExecutionLimits),
        input.createdByMemberId,
        input.now
      );
      return this.getCurrentProfile(input.agentId)!;
    });
  }

  public getCurrentProfile(agentId: string): HostedRuntimeProfileRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM hosted_runtime_profiles
      WHERE agent_id = ? AND superseded_at IS NULL
    `).get(agentId) as ProfileRow | undefined;
    return row && mapProfile(row);
  }

  public resolveExecutionProfile(agentId: string): HostedExecutionProfile {
    const row = this.database.prepare(`
      SELECT profile.*, credential.credential_id,
        credential.encryption_cipher, credential.key_version,
        credential.ciphertext, credential.nonce, credential.auth_tag,
        credential.revoked_at
      FROM hosted_runtime_profiles profile
      JOIN hosted_provider_credentials credential
        ON credential.agent_id = profile.agent_id
        AND credential.credential_version = profile.credential_version
      WHERE profile.agent_id = ? AND profile.superseded_at IS NULL
    `).get(agentId) as (ProfileRow & CredentialRow) | undefined;
    if (!row || row.revoked_at !== null) {
      throw new Error("Hosted Agent provider credential is unavailable");
    }
    const profile = mapProfile(row);
    const scope: HostedCredentialScope = {
      credentialId: row.credential_id,
      agentId: row.agent_id,
      teamId: row.team_id,
      provider: row.provider,
      keyVersion: row.key_version
    };
    const dataKey = this.dataKey(row.key_version);
    try {
      const envelope: HostedCredentialEnvelope = {
        cipher: row.encryption_cipher,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        tag: row.auth_tag
      };
      return {
        agentId: profile.agentId,
        teamId: profile.teamId,
        profileRevision: profile.profileRevision,
        credentialVersion: profile.credentialVersion,
        provider: profile.provider,
        model: profile.model,
        apiKey: decryptHostedCredential(envelope, dataKey, scope),
        executionLimits: profile.executionLimits
      };
    } finally {
      dataKey.fill(0);
    }
  }

  public revokeCurrentCredential(
    agentId: string,
    expectedProfileRevision: number,
    now: string
  ): boolean {
    return this.transactions.immediate(() => {
      const profile = this.getCurrentProfile(agentId);
      if (!profile || profile.profileRevision !== expectedProfileRevision) {
        throw new Error("Hosted Runtime Profile changed; reload and retry");
      }
      return this.database.prepare(`
        UPDATE hosted_provider_credentials SET revoked_at = ?
        WHERE agent_id = ? AND credential_version = ? AND revoked_at IS NULL
      `).run(now, agentId, profile.credentialVersion).changes === 1;
    });
  }

  public recordTestObservation(input: {
    teamId: string;
    agentId?: string;
    profileRevision?: number;
    provider: typeof hostedProvider;
    model: string;
    observedByMemberId: string;
    status: "succeeded" | "failed";
    failureCode?: string;
    now: string;
  }): HostedProviderTestObservation {
    const observationId = createOpaqueId("hostedtest");
    this.database.prepare(`
      INSERT INTO hosted_provider_test_observations (
        observation_id, operation_id, team_id, agent_id, profile_revision,
        provider, model, status, failure_code, observed_by_member_id, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observationId,
      createOpaqueId("op"),
      input.teamId,
      input.agentId ?? null,
      input.profileRevision ?? null,
      input.provider,
      input.model,
      input.status,
      input.failureCode ?? null,
      input.observedByMemberId,
      input.now
    );
    return this.getObservation(observationId)!;
  }

  public listConfigurations(teamId: string): HostedAgentConfigurationRecord[] {
    const rows = this.database.prepare(`
      SELECT agent.agent_id, agent.team_id, agent.name, agent.role,
        agent.enabled, agent.presence, agent.updated_at,
        profile.profile_revision, profile.provider, profile.model,
        credential.credential_id, credential.revoked_at,
        observation.observation_id, observation.agent_id AS observation_agent_id,
        observation.profile_revision AS observation_profile_revision,
        observation.provider AS observation_provider,
        observation.model AS observation_model,
        observation.status AS observation_status,
        observation.failure_code AS observation_failure_code,
        observation.observed_at
      FROM agents agent
      JOIN hosted_runtime_profiles profile
        ON profile.agent_id = agent.agent_id AND profile.superseded_at IS NULL
      JOIN hosted_provider_credentials credential
        ON credential.agent_id = profile.agent_id
        AND credential.credential_version = profile.credential_version
      LEFT JOIN hosted_provider_test_observations observation
        ON observation.observation_id = (
          SELECT candidate.observation_id
          FROM hosted_provider_test_observations candidate
          WHERE candidate.agent_id = agent.agent_id
            AND candidate.profile_revision = profile.profile_revision
          ORDER BY candidate.observed_at DESC, candidate.observation_id DESC
          LIMIT 1
        )
      WHERE agent.team_id = ? AND agent.integration_mode = 'hosted'
      ORDER BY agent.created_at, agent.agent_id
    `).all(teamId) as Array<{
      agent_id: string;
      team_id: string;
      name: string;
      role: string;
      enabled: number;
      presence: HostedAgentConfigurationRecord["presence"];
      updated_at: string;
      profile_revision: number;
      provider: typeof hostedProvider;
      model: string;
      credential_id: string;
      revoked_at: string | null;
      observation_id: string | null;
      observation_agent_id: string | null;
      observation_profile_revision: number | null;
      observation_provider: typeof hostedProvider | null;
      observation_model: string | null;
      observation_status: "succeeded" | "failed" | null;
      observation_failure_code: string | null;
      observed_at: string | null;
    }>;
    const roomRows = this.database.prepare(`
      SELECT participant.agent_id, participant.room_id
      FROM room_agent_participants participant
      JOIN agents agent ON agent.agent_id = participant.agent_id
      WHERE agent.team_id = ? AND agent.integration_mode = 'hosted'
      ORDER BY participant.room_id
    `).all(teamId) as Array<{ agent_id: string; room_id: string }>;
    const roomIds = new Map<string, string[]>();
    for (const row of roomRows) {
      const values = roomIds.get(row.agent_id) ?? [];
      values.push(row.room_id);
      roomIds.set(row.agent_id, values);
    }
    return rows.map((row) => ({
      agentId: row.agent_id,
      teamId: row.team_id,
      name: row.name,
      role: row.role,
      enabled: row.enabled === 1,
      presence: row.presence,
      roomIds: roomIds.get(row.agent_id) ?? [],
      profileRevision: row.profile_revision,
      provider: row.provider,
      model: row.model,
      credentialConfigured: true,
      credentialRevoked: row.revoked_at !== null,
      latestTest: row.observation_id && row.observation_provider &&
          row.observation_model && row.observation_status && row.observed_at
        ? {
            observationId: row.observation_id,
            teamId: row.team_id,
            agentId: row.observation_agent_id,
            profileRevision: row.observation_profile_revision,
            provider: row.observation_provider,
            model: row.observation_model,
            status: row.observation_status,
            failureCode: row.observation_failure_code,
            observedAt: row.observed_at
          }
        : null,
      updatedAt: row.updated_at
    }));
  }

  public getAvailability(agentId: string): "ready" | "degraded" | undefined {
    const row = this.database.prepare(`
      SELECT agent.enabled, credential.revoked_at,
        EXISTS (
          SELECT 1
          FROM room_agent_participants participant
          JOIN rooms room ON room.room_id = participant.room_id
          WHERE participant.agent_id = agent.agent_id
            AND room.archived_at IS NULL
        ) AS has_room,
        observation.status AS latest_status
      FROM agents agent
      LEFT JOIN hosted_runtime_profiles profile
        ON profile.agent_id = agent.agent_id AND profile.superseded_at IS NULL
      LEFT JOIN hosted_provider_credentials credential
        ON credential.agent_id = profile.agent_id
        AND credential.credential_version = profile.credential_version
      LEFT JOIN hosted_provider_test_observations observation
        ON observation.observation_id = (
          SELECT candidate.observation_id
          FROM hosted_provider_test_observations candidate
          WHERE candidate.agent_id = agent.agent_id
            AND candidate.profile_revision = profile.profile_revision
          ORDER BY candidate.observed_at DESC, candidate.observation_id DESC
          LIMIT 1
        )
      WHERE agent.agent_id = ? AND agent.integration_mode = 'hosted'
    `).get(agentId) as {
      enabled: number;
      revoked_at: string | null;
      has_room: number;
      latest_status: "succeeded" | "failed" | null;
    } | undefined;
    if (!row) return undefined;
    return row.enabled === 1 && row.has_room === 1 && row.revoked_at === null &&
      row.latest_status === "succeeded"
      ? "ready"
      : "degraded";
  }

  private getObservation(
    observationId: string
  ): HostedProviderTestObservation | undefined {
    const row = this.database.prepare(`
      SELECT * FROM hosted_provider_test_observations WHERE observation_id = ?
    `).get(observationId) as ObservationRow | undefined;
    return row && mapObservation(row);
  }

  private currentDataKey(now: string): { dataKey: Buffer; keyVersion: number } {
    let row = this.database.prepare(`
      SELECT * FROM hosted_credential_keyrings
      WHERE retired_at IS NULL ORDER BY key_version DESC LIMIT 1
    `).get() as KeyringRow | undefined;
    if (!row) {
      const keyVersion = 1;
      const rootSecret = this.root.mode === "trusted_recovery"
        ? this.root.secret
        : randomBytes(32);
      const created = createHostedCredentialKeyring(rootSecret, keyVersion);
      this.database.prepare(`
        INSERT INTO hosted_credential_keyrings (
          key_version, root_mode, key_derivation, wrapping_cipher, kdf_salt,
          local_root_key, wrapped_data_key_ciphertext, wrapped_data_key_nonce,
          wrapped_data_key_auth_tag, created_at, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(
        keyVersion,
        this.root.mode,
        created.wrapped.kdf,
        created.wrapped.cipher,
        created.wrapped.kdfSalt,
        this.root.mode === "local_database" ? rootSecret : null,
        created.wrapped.ciphertext,
        created.wrapped.nonce,
        created.wrapped.tag,
        now
      );
      created.dataKey.fill(0);
      if (Buffer.isBuffer(rootSecret)) rootSecret.fill(0);
      row = this.database.prepare(`
        SELECT * FROM hosted_credential_keyrings WHERE key_version = ?
      `).get(keyVersion) as KeyringRow;
    }
    return { dataKey: this.unwrap(row), keyVersion: row.key_version };
  }

  private dataKey(keyVersion: number): Buffer {
    const row = this.database.prepare(`
      SELECT * FROM hosted_credential_keyrings WHERE key_version = ?
    `).get(keyVersion) as KeyringRow | undefined;
    if (!row) throw new Error("Hosted credential key version is unavailable");
    return this.unwrap(row);
  }

  private unwrap(row: KeyringRow): Buffer {
    const rootSecret = row.root_mode === "local_database"
      ? row.local_root_key
      : this.root.mode === "trusted_recovery" ? this.root.secret : null;
    if (!rootSecret) {
      throw new Error("Hosted credential recovery authority is unavailable");
    }
    const wrapped: HostedWrappedDataKey = {
      cipher: row.wrapping_cipher,
      kdf: row.key_derivation,
      kdfSalt: row.kdf_salt,
      ciphertext: row.wrapped_data_key_ciphertext,
      nonce: row.wrapped_data_key_nonce,
      tag: row.wrapped_data_key_auth_tag
    };
    return unwrapHostedCredentialDataKey(
      rootSecret,
      row.key_version,
      wrapped
    );
  }
}
