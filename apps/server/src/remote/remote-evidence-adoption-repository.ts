import type Database from "better-sqlite3";
import type { EvidenceAdoption, SourceEvidence } from
  "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON
} from "@convene-wire/contracts/execution-validation";
import { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";

export interface RemoteEvidenceAdoptionBundle {
  adoption: EvidenceAdoption;
  source: SourceEvidence;
}

export class RemoteEvidenceAdoptionRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public get(
    planId: string,
    planRevision: number,
    nodeKey: string
  ): RemoteEvidenceAdoptionBundle | undefined {
    const row = this.database.prepare(`
      SELECT adoption.adoption_json, source.source_json
      FROM execution_remote_evidence_adoptions adoption
      JOIN execution_remote_source_evidence source
        ON source.source_evidence_id = adoption.source_evidence_id
        AND source.source_digest = adoption.source_digest
      WHERE adoption.plan_id = ? AND adoption.plan_revision = ?
        AND adoption.node_key = ? AND adoption.gate = 'verified_output'
    `).get(planId, planRevision, nodeKey) as {
      adoption_json: string; source_json: string;
    } | undefined;
    if (!row) return undefined;
    const adoption = JSON.parse(row.adoption_json) as EvidenceAdoption;
    const source = JSON.parse(row.source_json) as SourceEvidence;
    assertExecutionCommand("evidenceAdoption", adoption);
    assertExecutionCommand("sourceEvidence", source);
    return { adoption, source };
  }

  public getByOperation(operationId: string): RemoteEvidenceAdoptionBundle | undefined {
    const row = this.database.prepare(`
      SELECT plan_id, plan_revision, node_key
      FROM execution_remote_evidence_adoptions WHERE operation_id = ?
    `).get(operationId) as {
      plan_id: string; plan_revision: number; node_key: string;
    } | undefined;
    return row && this.get(row.plan_id, row.plan_revision, row.node_key);
  }

  public retain(
    providerBindingId: string,
    adoption: EvidenceAdoption
  ): RemoteEvidenceAdoptionBundle {
    return this.transactions.immediate(() => {
      const replay = this.getByOperation(adoption.operationId);
      if (replay) return replay;
      this.database.prepare(`
        INSERT INTO execution_remote_evidence_adoptions (
          adoption_id, schema_version, operation_id, operation_digest,
          plan_id, plan_revision, node_key, gate, provider_binding_id,
          source_evidence_id, source_digest, proof_set_digest,
          node_contract_digest, resolved_input_set_digest, adoption_digest,
          adoption_json, created_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        adoption.adoptionId,
        adoption.operationId,
        adoption.operationDigest,
        adoption.planId,
        adoption.planRevision,
        adoption.nodeKey,
        adoption.gate,
        providerBindingId,
        adoption.sourceEvidenceId,
        adoption.sourceDigest,
        adoption.proofSetDigest,
        adoption.nodeContractDigest,
        adoption.resolvedInputSetDigest,
        adoption.adoptionDigest,
        canonicalExecutionJSON(adoption),
        adoption.createdAt
      );
      return this.get(adoption.planId, adoption.planRevision, adoption.nodeKey)!;
    });
  }
}
