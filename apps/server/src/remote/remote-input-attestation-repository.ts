import type Database from "better-sqlite3";
import type { RemoteInputAttestation } from
  "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON
} from "@convene-wire/contracts/execution-validation";
import { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";

export type RemoteInputAttestationOperationState =
  "planned" | "outcome_unknown" | "succeeded" | "failed";

export interface RemoteInputAttestationOperation {
  operationId: string;
  providerBindingId: string;
  planId: string;
  planRevision: number;
  nodeKey: string;
  sourceEvidenceId: string;
  expectedPlanDigest: string;
  expectedControlRevision: number;
  actorMemberId: string;
  requestDigest: string;
  request: Record<string, unknown>;
  state: RemoteInputAttestationOperationState;
  attestationId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OperationRow {
  operation_id: string;
  provider_binding_id: string;
  plan_id: string;
  plan_revision: number;
  node_key: string;
  source_evidence_id: string;
  expected_plan_digest: string;
  expected_control_revision: number;
  actor_member_id: string;
  request_digest: string;
  request_json: string;
  state: RemoteInputAttestationOperationState;
  attestation_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

function mapOperation(row: OperationRow): RemoteInputAttestationOperation {
  return {
    operationId: row.operation_id,
    providerBindingId: row.provider_binding_id,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    nodeKey: row.node_key,
    sourceEvidenceId: row.source_evidence_id,
    expectedPlanDigest: row.expected_plan_digest,
    expectedControlRevision: row.expected_control_revision,
    actorMemberId: row.actor_member_id,
    requestDigest: row.request_digest,
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    state: row.state,
    attestationId: row.attestation_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** Retains input attestation intent separately from commit and CI observations. */
export class RemoteInputAttestationRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public getOperation(
    operationId: string
  ): RemoteInputAttestationOperation | undefined {
    const row = this.database.prepare(`
      SELECT * FROM remote_input_attestation_operations WHERE operation_id = ?
    `).get(operationId) as OperationRow | undefined;
    return row && mapOperation(row);
  }

  public plan(
    operation: RemoteInputAttestationOperation
  ): RemoteInputAttestationOperation {
    return this.transactions.immediate(() => {
      const existing = this.getOperation(operation.operationId);
      if (existing) return existing;
      this.database.prepare(`
        INSERT INTO remote_input_attestation_operations (
          operation_id, provider_binding_id, plan_id, plan_revision, node_key,
          source_evidence_id, expected_plan_digest, expected_control_revision,
          actor_member_id, request_digest, request_json, state,
          attestation_id, error_code, created_at, updated_at
        ) VALUES (
          @operationId, @providerBindingId, @planId, @planRevision, @nodeKey,
          @sourceEvidenceId, @expectedPlanDigest, @expectedControlRevision,
          @actorMemberId, @requestDigest, @requestJson, 'planned',
          NULL, NULL, @createdAt, @updatedAt
        )
      `).run({
        ...operation,
        requestJson: canonicalExecutionJSON(operation.request)
      });
      return this.getOperation(operation.operationId)!;
    });
  }

  public get(operationId: string): RemoteInputAttestation | undefined {
    const row = this.database.prepare(`
      SELECT attestation_json FROM remote_input_attestations
      WHERE operation_id = ?
    `).get(operationId) as { attestation_json: string } | undefined;
    if (!row) return undefined;
    const retained = JSON.parse(row.attestation_json) as RemoteInputAttestation;
    assertExecutionCommand("remoteInputAttestation", retained);
    return retained;
  }

  public getForSource(
    planId: string,
    planRevision: number,
    nodeKey: string,
    sourceEvidenceId: string
  ): RemoteInputAttestation | undefined {
    const row = this.database.prepare(`
      SELECT operation_id FROM remote_input_attestations
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ?
        AND source_evidence_id = ?
    `).pluck().get(
      planId, planRevision, nodeKey, sourceEvidenceId
    ) as string | undefined;
    return row === undefined ? undefined : this.get(row);
  }

  public retain(
    attestation: RemoteInputAttestation,
    now: string
  ): RemoteInputAttestation {
    return this.transactions.immediate(() => {
      const replay = this.get(attestation.operationId);
      if (replay) return replay;
      this.database.prepare(`
        INSERT INTO remote_input_attestations (
          attestation_id, schema_version, operation_id, provider_binding_id,
          repository_id, provider_repository_id, plan_id, plan_revision,
          node_key, source_evidence_id, source_digest, source_observation_id,
          source_observation_digest, remote_input_evidence_digest,
          provider_attestation_digest, attestation_digest, attestation_json,
          attested_at
        ) VALUES (
          @attestationId, 1, @operationId, @providerBindingId,
          @repositoryId, @providerRepositoryId, @planId, @planRevision,
          @nodeKey, @sourceEvidenceId, @sourceDigest, @sourceObservationId,
          @sourceObservationDigest, @remoteInputEvidenceDigest,
          @providerAttestationDigest, @attestationDigest, @attestationJson,
          @attestedAt
        )
      `).run({
        ...attestation,
        attestationJson: canonicalExecutionJSON(attestation)
      });
      this.database.prepare(`
        UPDATE remote_input_attestation_operations SET state = 'succeeded',
          attestation_id = ?, error_code = NULL, updated_at = ?
        WHERE operation_id = ? AND state IN ('planned', 'outcome_unknown')
      `).run(attestation.attestationId, now, attestation.operationId);
      return this.get(attestation.operationId)!;
    });
  }

  public markOutcomeUnknown(operationId: string, code: string, now: string): void {
    this.mark(operationId, "outcome_unknown", code, now);
  }

  public markFailed(operationId: string, code: string, now: string): void {
    this.mark(operationId, "failed", code, now);
  }

  private mark(
    operationId: string,
    state: "outcome_unknown" | "failed",
    code: string,
    now: string
  ): void {
    this.database.prepare(`
      UPDATE remote_input_attestation_operations
      SET state = ?, error_code = ?, updated_at = ?
      WHERE operation_id = ? AND state IN ('planned', 'outcome_unknown')
    `).run(state, code, now, operationId);
  }
}
