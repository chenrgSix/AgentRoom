import type Database from "better-sqlite3";
import type {
  EvidenceAdoption,
  ExecutionPlanDefinition
} from "@convene-wire/contracts/execution-plan";
import { canonicalExecutionJSON } from
  "@convene-wire/contracts/execution-validation";
import { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import { createRemoteEvidenceReuseContract } from
  "../execution/execution-evidence-reuse.js";

interface LegacyRow {
  adoption_json: string;
  definition_json: string;
  node_json: string;
  task_snapshot_json: string;
}

/** One migration-time data phase for legacy input-free remote adoptions. */
export function backfillRemoteEvidenceReuseContracts(
  database: Database.Database
): number {
  const rows = database.prepare(`
    SELECT adoption.adoption_json, node.node_json, node.task_snapshot_json,
      proposal.definition_json
    FROM execution_remote_evidence_adoptions adoption
    JOIN execution_plan_nodes node ON node.plan_id = adoption.plan_id
      AND node.revision = adoption.plan_revision
      AND node.node_key = adoption.node_key
    JOIN execution_plan_proposals proposal ON proposal.plan_id = adoption.plan_id
      AND proposal.revision = adoption.plan_revision
    LEFT JOIN execution_remote_evidence_reuse_contracts reuse
      ON reuse.adoption_id = adoption.adoption_id
    WHERE reuse.adoption_id IS NULL
    ORDER BY adoption.created_at COLLATE BINARY, adoption.adoption_id COLLATE BINARY
  `).all() as LegacyRow[];
  const insert = database.prepare(`
    INSERT INTO execution_remote_evidence_reuse_contracts (
      reuse_contract_id, schema_version, adoption_id, adoption_digest,
      plan_id, plan_revision, node_key, gate, runtime_input_binding_digest,
      reuse_input_evidence_digest, node_execution_digest,
      node_reuse_contract_digest, contract_digest, contract_json, created_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const transactions = new SqliteTransactionBoundary(database);
  return transactions.immediate(() => {
    for (const row of rows) {
      const adoption = JSON.parse(row.adoption_json) as EvidenceAdoption;
      const definition = JSON.parse(row.definition_json) as ExecutionPlanDefinition;
      const node = JSON.parse(row.node_json) as
        ExecutionPlanDefinition["nodes"][number];
      if (node.inputs.length !== 0) {
        throw new Error(
          `Remote adoption ${adoption.adoptionId} requires an input attestation`
        );
      }
      const contract = createRemoteEvidenceReuseContract({
        adoption,
        integrationPolicy: definition.policy,
        node,
        reuseInputs: [],
        task: JSON.parse(row.task_snapshot_json) as
          Parameters<typeof createRemoteEvidenceReuseContract>[0]["task"]
      });
      insert.run(
        contract.reuseContractId,
        contract.adoptionId,
        contract.adoptionDigest,
        contract.planId,
        contract.planRevision,
        contract.nodeKey,
        contract.gate,
        contract.runtimeInputBindingDigest,
        contract.reuseInputEvidenceDigest,
        contract.nodeExecutionDigest,
        contract.nodeReuseContractDigest,
        contract.contractDigest,
        canonicalExecutionJSON(contract),
        contract.createdAt
      );
    }
    return rows.length;
  });
}
