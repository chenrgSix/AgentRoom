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

export interface ExecutionNodeMaterialization extends ExecutionNodeIdentity {
  artifactPins: ExecutionMaterializationArtifactPin[];
  createdAt: string;
  dispatchGeneration: 1;
  gate: "accepted_result";
  gateOperationId: string;
  materializationDigest: string;
  sourceResultId: string;
  sourceResultVersion: number;
  sourceRunId: string;
}

interface MaterializationRow {
  artifact_pins_json: string;
  created_at: string;
  dispatch_generation: 1;
  gate: "accepted_result";
  gate_operation_id: string;
  materialization_digest: string;
  node_key: string;
  plan_id: string;
  plan_revision: number;
  source_result_id: string;
  source_result_version: number;
  source_run_id: string;
}

function unsigned(
  input: Omit<ExecutionNodeMaterialization, "materializationDigest">
): Omit<ExecutionNodeMaterialization, "materializationDigest"> {
  return {
    planId: input.planId,
    planRevision: input.planRevision,
    nodeKey: input.nodeKey,
    gate: input.gate,
    dispatchGeneration: input.dispatchGeneration,
    sourceRunId: input.sourceRunId,
    sourceResultId: input.sourceResultId,
    sourceResultVersion: input.sourceResultVersion,
    gateOperationId: input.gateOperationId,
    artifactPins: input.artifactPins.map((pin) => ({ ...pin })),
    createdAt: input.createdAt
  };
}

function map(row: MaterializationRow): ExecutionNodeMaterialization {
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
  } satisfies ExecutionNodeMaterialization;
  if (executionOperationDigest(unsigned(record)) !== record.materializationDigest) {
    throw new Error("Execution node materialization digest is invalid");
  }
  return record;
}

export class ExecutionNodeMaterializationRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(
    identity: ExecutionNodeIdentity,
    gate: "accepted_result" = "accepted_result"
  ): ExecutionNodeMaterialization | undefined {
    const row = this.database.prepare(`
      SELECT * FROM execution_node_materializations
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND gate = ?
    `).get(
      identity.planId,
      identity.planRevision,
      identity.nodeKey,
      gate
    ) as MaterializationRow | undefined;
    return row && map(row);
  }

  public retain(
    input: Omit<ExecutionNodeMaterialization, "materializationDigest">
  ): ExecutionNodeMaterialization {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const normalized = unsigned(input);
    const record: ExecutionNodeMaterialization = {
      ...normalized,
      materializationDigest: executionOperationDigest(normalized)
    };
    const existing = this.get(record, record.gate);
    if (existing) {
      if (canonicalExecutionJSON(existing) !== canonicalExecutionJSON(record)) {
        throw new Error("Execution node materialization conflicts with retained evidence");
      }
      return existing;
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
    return this.get(record, record.gate)!;
  }
}
