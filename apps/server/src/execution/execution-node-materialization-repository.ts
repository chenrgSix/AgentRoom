import type Database from "better-sqlite3";
import type { ExternalInputKind } from
  "@convene-wire/contracts/execution-plan";
import {
  canonicalExecutionJSON,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";

import type { ExecutionNodeIdentity } from
  "./execution-node-state-repository.js";
import { ExecutionError } from "./execution-error.js";

export interface ExecutionMaterializationArtifactPin {
  artifactId: string;
  artifactRevision: number;
  byteLength: number;
  contentDigest: string;
  kind: ExternalInputKind;
  outputSlot: string;
}

interface BaseExecutionNodeMaterialization extends ExecutionNodeIdentity {
  artifactPins: ExecutionMaterializationArtifactPin[];
  createdAt: string;
  dispatchGeneration: 1;
  gateOperationId: string;
  materializationDigest: string;
  sourceResultId: string;
  sourceResultVersion: number;
  sourceRunId: string;
}

export interface AcceptedExecutionNodeMaterialization extends
  BaseExecutionNodeMaterialization {
  gate: "accepted_result";
}

export interface VerificationReceiptPin {
  operationId: string;
  profileDigest: string;
  profileId: string;
  profileRevision: number;
  receiptDigest: string;
  verificationId: string;
}

export interface VerifiedExecutionNodeMaterialization extends
  BaseExecutionNodeMaterialization {
  candidateCommit: string;
  candidateTree: string;
  checkpointId: string;
  gate: "verified_output";
  inputDigest: string;
  verificationReceipts: VerificationReceiptPin[];
}

export type ExecutionNodeMaterialization =
  | AcceptedExecutionNodeMaterialization
  | VerifiedExecutionNodeMaterialization;

interface BaseMaterializationRow {
  artifact_pins_json: string;
  created_at: string;
  dispatch_generation: 1;
  gate_operation_id: string;
  materialization_digest: string;
  node_key: string;
  plan_id: string;
  plan_revision: number;
  source_result_id: string;
  source_result_version: number;
  source_run_id: string;
}

interface MaterializationRow extends BaseMaterializationRow {
  gate: "accepted_result";
}

interface VerifiedMaterializationRow extends BaseMaterializationRow {
  candidate_commit: string;
  candidate_tree: string;
  checkpoint_id: string;
  gate: "verified_output";
  input_digest: string;
  verification_receipts_json: string;
}

function acceptedUnsigned(
  input: Omit<AcceptedExecutionNodeMaterialization, "materializationDigest">
): Omit<AcceptedExecutionNodeMaterialization, "materializationDigest"> {
  return {
    planId: input.planId,
    planRevision: input.planRevision,
    nodeKey: input.nodeKey,
    gate: "accepted_result",
    dispatchGeneration: input.dispatchGeneration,
    sourceRunId: input.sourceRunId,
    sourceResultId: input.sourceResultId,
    sourceResultVersion: input.sourceResultVersion,
    gateOperationId: input.gateOperationId,
    artifactPins: input.artifactPins.map((pin) => ({ ...pin })),
    createdAt: input.createdAt
  };
}

function verifiedUnsigned(
  input: Omit<VerifiedExecutionNodeMaterialization, "materializationDigest">
): Omit<VerifiedExecutionNodeMaterialization, "materializationDigest"> {
  return {
    planId: input.planId,
    planRevision: input.planRevision,
    nodeKey: input.nodeKey,
    gate: "verified_output",
    dispatchGeneration: input.dispatchGeneration,
    sourceRunId: input.sourceRunId,
    sourceResultId: input.sourceResultId,
    sourceResultVersion: input.sourceResultVersion,
    gateOperationId: input.gateOperationId,
    checkpointId: input.checkpointId,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    inputDigest: input.inputDigest,
    verificationReceipts: input.verificationReceipts.map((pin) => ({ ...pin })),
    artifactPins: input.artifactPins.map((pin) => ({ ...pin })),
    createdAt: input.createdAt
  };
}

function mapAccepted(row: MaterializationRow): AcceptedExecutionNodeMaterialization {
  const record = {
    planId: row.plan_id,
    planRevision: row.plan_revision,
    nodeKey: row.node_key,
    gate: row.gate,
    dispatchGeneration: row.dispatch_generation,
    sourceRunId: row.source_run_id,
    sourceResultId: row.source_result_id,
    sourceResultVersion: row.source_result_version,
    gateOperationId: row.gate_operation_id,
    artifactPins: JSON.parse(row.artifact_pins_json) as
      ExecutionMaterializationArtifactPin[],
    materializationDigest: row.materialization_digest,
    createdAt: row.created_at
  } satisfies AcceptedExecutionNodeMaterialization;
  if (executionOperationDigest(acceptedUnsigned(record)) !== record.materializationDigest) {
    throw new Error("Execution node materialization digest is invalid");
  }
  return record;
}

function mapVerified(
  row: VerifiedMaterializationRow
): VerifiedExecutionNodeMaterialization {
  const record = {
    planId: row.plan_id,
    planRevision: row.plan_revision,
    nodeKey: row.node_key,
    gate: row.gate,
    dispatchGeneration: row.dispatch_generation,
    sourceRunId: row.source_run_id,
    sourceResultId: row.source_result_id,
    sourceResultVersion: row.source_result_version,
    gateOperationId: row.gate_operation_id,
    checkpointId: row.checkpoint_id,
    candidateCommit: row.candidate_commit,
    candidateTree: row.candidate_tree,
    inputDigest: row.input_digest,
    verificationReceipts: JSON.parse(row.verification_receipts_json) as
      VerificationReceiptPin[],
    artifactPins: JSON.parse(row.artifact_pins_json) as
      ExecutionMaterializationArtifactPin[],
    materializationDigest: row.materialization_digest,
    createdAt: row.created_at
  } satisfies VerifiedExecutionNodeMaterialization;
  if (executionOperationDigest(verifiedUnsigned(record)) !== record.materializationDigest) {
    throw new Error("Verified execution node materialization digest is invalid");
  }
  return record;
}

export class ExecutionNodeMaterializationRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(
    identity: ExecutionNodeIdentity,
    gate: "accepted_result" | "verified_output" = "accepted_result"
  ): ExecutionNodeMaterialization | undefined {
    if (gate === "verified_output") {
      const row = this.database.prepare(`
        SELECT * FROM execution_verified_node_materializations
        WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND gate = ?
      `).get(
        identity.planId,
        identity.planRevision,
        identity.nodeKey,
        gate
      ) as VerifiedMaterializationRow | undefined;
      return row && mapVerified(row);
    }
    const row = this.database.prepare(`
      SELECT * FROM execution_node_materializations
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND gate = ?
    `).get(
      identity.planId,
      identity.planRevision,
      identity.nodeKey,
      gate
    ) as MaterializationRow | undefined;
    return row && mapAccepted(row);
  }

  public retain(
    input: Omit<AcceptedExecutionNodeMaterialization, "materializationDigest">
  ): AcceptedExecutionNodeMaterialization {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const normalized = acceptedUnsigned(input);
    const record: AcceptedExecutionNodeMaterialization = {
      ...normalized,
      materializationDigest: executionOperationDigest(normalized)
    };
    const existing = this.get(record, record.gate);
    if (existing) {
      if (canonicalExecutionJSON(existing) !== canonicalExecutionJSON(record)) {
        throw new Error("Execution node materialization conflicts with retained evidence");
      }
      return existing as AcceptedExecutionNodeMaterialization;
    }
    this.database.prepare(`
      INSERT INTO execution_node_materializations (
        plan_id, plan_revision, node_key, gate, dispatch_generation,
        source_run_id, source_result_id, source_result_version,
        gate_operation_id, artifact_pins_json, materialization_digest,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.planId,
      record.planRevision,
      record.nodeKey,
      record.gate,
      record.dispatchGeneration,
      record.sourceRunId,
      record.sourceResultId,
      record.sourceResultVersion,
      record.gateOperationId,
      canonicalExecutionJSON(record.artifactPins),
      record.materializationDigest,
      record.createdAt
    );
    return this.get(record, record.gate) as AcceptedExecutionNodeMaterialization;
  }

  public retainVerified(
    input: Omit<VerifiedExecutionNodeMaterialization, "materializationDigest">
  ): VerifiedExecutionNodeMaterialization {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const normalized = verifiedUnsigned(input);
    const record: VerifiedExecutionNodeMaterialization = {
      ...normalized,
      materializationDigest: executionOperationDigest(normalized)
    };
    const existing = this.get(record, record.gate);
    if (existing) {
      if (canonicalExecutionJSON(existing) !== canonicalExecutionJSON(record)) {
        throw new Error("Verified node materialization conflicts with retained evidence");
      }
      return existing as VerifiedExecutionNodeMaterialization;
    }
    this.database.prepare(`
      INSERT INTO execution_verified_node_materializations (
        plan_id, plan_revision, node_key, gate, dispatch_generation,
        source_run_id, source_result_id, source_result_version,
        gate_operation_id, checkpoint_id, candidate_commit, candidate_tree,
        input_digest, verification_receipts_json, artifact_pins_json,
        materialization_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.planId,
      record.planRevision,
      record.nodeKey,
      record.gate,
      record.dispatchGeneration,
      record.sourceRunId,
      record.sourceResultId,
      record.sourceResultVersion,
      record.gateOperationId,
      record.checkpointId,
      record.candidateCommit,
      record.candidateTree,
      record.inputDigest,
      canonicalExecutionJSON(record.verificationReceipts),
      canonicalExecutionJSON(record.artifactPins),
      record.materializationDigest,
      record.createdAt
    );
    return this.get(record, record.gate) as VerifiedExecutionNodeMaterialization;
  }
}
