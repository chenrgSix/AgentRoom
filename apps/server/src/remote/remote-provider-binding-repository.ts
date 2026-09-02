import type Database from "better-sqlite3";
import type {
  RemoteProviderBinding,
  RemoteProviderBindingRevocation
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON
} from "@convene-wire/contracts/execution-validation";
import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";

interface BindingRow {
  binding_json: string;
  operation_id: string;
  request_digest: string;
}

interface RevocationRow {
  revocation_json: string;
}

export interface StoredRemoteProviderBinding {
  binding: RemoteProviderBinding;
  operationId: string;
  requestDigest: string;
  revocation?: RemoteProviderBindingRevocation;
}

function parseBinding(row: BindingRow): RemoteProviderBinding {
  const binding = JSON.parse(row.binding_json) as RemoteProviderBinding;
  assertExecutionCommand("remoteProviderBinding", binding);
  return binding;
}

function parseRevocation(row: RevocationRow | undefined):
RemoteProviderBindingRevocation | undefined {
  if (!row) return undefined;
  const revocation = JSON.parse(row.revocation_json) as
    RemoteProviderBindingRevocation;
  assertExecutionCommand("remoteProviderBindingRevocation", revocation);
  return revocation;
}

export class RemoteProviderBindingRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public get(providerBindingId: string): StoredRemoteProviderBinding | undefined {
    const row = this.database.prepare(`
      SELECT binding_json, operation_id, request_digest
      FROM remote_provider_bindings WHERE provider_binding_id = ?
    `).get(providerBindingId) as BindingRow | undefined;
    if (!row) return undefined;
    const revocation = this.database.prepare(`
      SELECT revocation_json FROM remote_provider_binding_revocations
      WHERE provider_binding_id = ?
    `).get(providerBindingId) as RevocationRow | undefined;
    const stored = {
      binding: parseBinding(row),
      operationId: row.operation_id,
      requestDigest: row.request_digest
    };
    return revocation
      ? { ...stored, revocation: parseRevocation(revocation)! }
      : stored;
  }

  public getByOperation(operationId: string): StoredRemoteProviderBinding | undefined {
    const row = this.database.prepare(`
      SELECT provider_binding_id FROM remote_provider_bindings
      WHERE operation_id = ?
    `).get(operationId) as { provider_binding_id: string } | undefined;
    return row ? this.get(row.provider_binding_id) : undefined;
  }

  public list(teamId: string): StoredRemoteProviderBinding[] {
    return (this.database.prepare(`
      SELECT provider_binding_id FROM remote_provider_bindings
      WHERE team_id = ?
      ORDER BY created_at, provider_binding_id COLLATE BINARY
    `).all(teamId) as Array<{ provider_binding_id: string }>).map((row) =>
      this.get(row.provider_binding_id)!);
  }

  public insert(
    binding: RemoteProviderBinding,
    operationId: string,
    requestDigest: string
  ): StoredRemoteProviderBinding {
    return this.transactions.immediate(() => {
      const replay = this.getByOperation(operationId);
      if (replay) return replay;
      this.database.prepare(`
        INSERT INTO remote_provider_bindings (
          provider_binding_id, schema_version, operation_id, request_digest,
          team_id, repository_id, provider_origin, provider_repository_id,
          ci_checks_json, created_by_member_id, binding_digest, binding_json,
          created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        binding.providerBindingId,
        operationId,
        requestDigest,
        binding.teamId,
        binding.repositoryId,
        binding.providerOrigin,
        binding.providerRepositoryId,
        canonicalExecutionJSON(binding.ciChecks),
        binding.createdByMemberId,
        binding.bindingDigest,
        canonicalExecutionJSON(binding),
        binding.createdAt
      );
      return this.get(binding.providerBindingId)!;
    });
  }

  public revoke(
    revocation: RemoteProviderBindingRevocation
  ): StoredRemoteProviderBinding {
    return this.transactions.immediate(() => {
      const replay = this.database.prepare(`
        SELECT revocation_json FROM remote_provider_binding_revocations
        WHERE operation_id = ?
      `).get(revocation.operationId) as RevocationRow | undefined;
      if (replay) {
        const retained = parseRevocation(replay)!;
        if (canonicalExecutionJSON(retained) !== canonicalExecutionJSON(revocation)) {
          throw new Error("REMOTE_PROVIDER_OPERATION_CONFLICT");
        }
        return this.get(retained.providerBindingId)!;
      }
      this.database.prepare(`
        INSERT INTO remote_provider_binding_revocations (
          operation_id, provider_binding_id, expected_binding_digest,
          revoked_by_member_id, reason, revocation_digest, revocation_json,
          revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revocation.operationId,
        revocation.providerBindingId,
        revocation.expectedBindingDigest,
        revocation.revokedByMemberId,
        revocation.reason,
        revocation.revocationDigest,
        canonicalExecutionJSON(revocation),
        revocation.revokedAt
      );
      return this.get(revocation.providerBindingId)!;
    });
  }
}
