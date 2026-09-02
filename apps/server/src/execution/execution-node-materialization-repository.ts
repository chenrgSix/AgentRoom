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
  dispatchGeneration: number;
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

export interface IntegratedExecutionNodeMaterialization extends
  BaseExecutionNodeMaterialization {
  bindingId: string;
  candidateCommit: string;
  candidateTree: string;
  checkpointId: string;
  gate: "integrated_commit";
  inputDigest: string;
  integrationApprovalDigest: string;
  integrationReceiptDigest: string;
  repositoryId: string;
  target: {
    expectedCommit: string;
    repositoryId: string;
    targetRef: string;
  };
  verificationReceipts: VerificationReceiptPin[];
  verifiedMaterializationDigest: string;
}

export type ExecutionNodeMaterialization =
  | AcceptedExecutionNodeMaterialization
  | VerifiedExecutionNodeMaterialization
  | IntegratedExecutionNodeMaterialization;

interface BaseMaterializationRow {
  artifact_pins_json: string;
  created_at: string;
  dispatch_generation: number;
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

interface IntegratedMaterializationRow extends BaseMaterializationRow {
  binding_id: string;
  candidate_commit: string;
  candidate_tree: string;
  checkpoint_id: string;
  gate: "integrated_commit";
  input_digest: string;
  integration_approval_digest: string;
  integration_receipt_digest: string;
  repository_id: string;
  target_json: string;
  verification_receipts_json: string;
  verified_materialization_digest: string;
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

function integratedUnsigned(
  input: Omit<IntegratedExecutionNodeMaterialization, "materializationDigest">
): Omit<IntegratedExecutionNodeMaterialization, "materializationDigest"> {
  return {
    planId: input.planId,
    planRevision: input.planRevision,
    nodeKey: input.nodeKey,
    gate: "integrated_commit",
    dispatchGeneration: input.dispatchGeneration,
    sourceRunId: input.sourceRunId,
    sourceResultId: input.sourceResultId,
    sourceResultVersion: input.sourceResultVersion,
    gateOperationId: input.gateOperationId,
    checkpointId: input.checkpointId,
    repositoryId: input.repositoryId,
    bindingId: input.bindingId,
    candidateCommit: input.candidateCommit,
    candidateTree: input.candidateTree,
    inputDigest: input.inputDigest,
    target: { ...input.target },
    verifiedMaterializationDigest: input.verifiedMaterializationDigest,
    verificationReceipts: input.verificationReceipts.map((pin) => ({ ...pin })),
    integrationApprovalDigest: input.integrationApprovalDigest,
    integrationReceiptDigest: input.integrationReceiptDigest,
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

function mapIntegrated(
  row: IntegratedMaterializationRow
): IntegratedExecutionNodeMaterialization {
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
    repositoryId: row.repository_id,
    bindingId: row.binding_id,
    candidateCommit: row.candidate_commit,
    candidateTree: row.candidate_tree,
    inputDigest: row.input_digest,
    target: JSON.parse(row.target_json) as
      IntegratedExecutionNodeMaterialization["target"],
    verifiedMaterializationDigest: row.verified_materialization_digest,
    verificationReceipts: JSON.parse(row.verification_receipts_json) as
      VerificationReceiptPin[],
    integrationApprovalDigest: row.integration_approval_digest,
    integrationReceiptDigest: row.integration_receipt_digest,
    artifactPins: JSON.parse(row.artifact_pins_json) as
      ExecutionMaterializationArtifactPin[],
    materializationDigest: row.materialization_digest,
    createdAt: row.created_at
  } satisfies IntegratedExecutionNodeMaterialization;
  if (executionOperationDigest(integratedUnsigned(record)) !==
    record.materializationDigest) {
    throw new Error("Integrated execution node materialization digest is invalid");
  }
  return record;
}

export class ExecutionNodeMaterializationRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(
    identity: ExecutionNodeIdentity,
    gate: "accepted_result" | "verified_output" | "integrated_commit" =
      "accepted_result"
  ): ExecutionNodeMaterialization | undefined {
    if (gate === "integrated_commit") {
      const row = this.database.prepare(`
        SELECT * FROM execution_integrated_node_materializations
        WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND gate = ?
      `).get(
        identity.planId,
        identity.planRevision,
        identity.nodeKey,
        gate
      ) as IntegratedMaterializationRow | undefined;
      return row && mapIntegrated(row);
    }
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

  public retainIntegrated(
    input: Omit<IntegratedExecutionNodeMaterialization, "materializationDigest">
  ): IntegratedExecutionNodeMaterialization {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const normalized = integratedUnsigned(input);
    const record: IntegratedExecutionNodeMaterialization = {
      ...normalized,
      materializationDigest: executionOperationDigest(normalized)
    };
    const existing = this.get(record, record.gate);
    if (existing) {
      if (canonicalExecutionJSON(existing) !== canonicalExecutionJSON(record)) {
        throw new Error("Integrated node materialization conflicts with retained evidence");
      }
      return existing as IntegratedExecutionNodeMaterialization;
    }
    this.database.prepare(`
      INSERT INTO execution_integrated_node_materializations (
        plan_id, plan_revision, node_key, gate, dispatch_generation,
        source_run_id, source_result_id, source_result_version,
        gate_operation_id, checkpoint_id, repository_id, binding_id,
        candidate_commit, candidate_tree, input_digest, target_json,
        verified_materialization_digest, verification_receipts_json,
        integration_approval_digest, integration_receipt_digest,
        artifact_pins_json, materialization_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      record.repositoryId,
      record.bindingId,
      record.candidateCommit,
      record.candidateTree,
      record.inputDigest,
      canonicalExecutionJSON(record.target),
      record.verifiedMaterializationDigest,
      canonicalExecutionJSON(record.verificationReceipts),
      record.integrationApprovalDigest,
      record.integrationReceiptDigest,
      canonicalExecutionJSON(record.artifactPins),
      record.materializationDigest,
      record.createdAt
    );
    return this.get(record, record.gate) as IntegratedExecutionNodeMaterialization;
  }
}
