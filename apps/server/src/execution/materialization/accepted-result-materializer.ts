import type Database from "better-sqlite3";
import type { ExternalInputKind } from
  "@convene-wire/contracts/execution-plan";

import type { ExecutionNodeIdentity } from
  "../execution-node-state-repository.js";
import type {
  AcceptedExecutionNodeMaterialization,
  ExecutionNodeMaterializationRepository
} from "../execution-node-materialization-repository.js";

interface AcceptedResultRow {
  dispatch_generation: 1;
  gate_operation_id: string;
  result_id: string;
  result_version: number;
  reviewed_at: string;
  run_id: string;
}

interface ArtifactPinRow {
  artifact_id: string;
  artifact_revision: number;
  artifact_type: ExternalInputKind;
  content_sha256: string;
  content_size_bytes: number;
  slot_key: string;
}

export class AcceptedResultMaterializer {
  public constructor(
    private readonly database: Database.Database,
    private readonly materializations: ExecutionNodeMaterializationRepository
  ) {}

  public reconcile(
    identity: ExecutionNodeIdentity
  ): AcceptedExecutionNodeMaterialization | undefined {
    const sources = this.database.prepare(`
      SELECT intent.dispatch_generation, run.run_id,
        result.result_id, result.result_version,
        review.operation_id AS gate_operation_id, review.reviewed_at
      FROM execution_dispatch_intents intent
      JOIN runs run ON run.run_id = intent.run_id AND run.state = 'completed'
      JOIN execution_plan_nodes node ON node.plan_id = intent.plan_id
        AND node.revision = intent.plan_revision
        AND node.node_key = intent.node_key
      JOIN task_results result ON result.task_id = node.task_id
        AND result.room_id = intent.room_id
        AND result.definition_revision = node.definition_revision
        AND result.criteria_revision = node.criteria_revision
        AND result.proposed_by_kind = 'managed_agent'
        AND result.proposed_by_agent_id = intent.agent_id
        AND result.proposed_by_run_id = run.run_id
        AND result.state = 'accepted'
      JOIN result_reviews review ON review.result_id = result.result_id
        AND review.decision = 'accepted' AND review.completed_task = 0
      WHERE intent.plan_id = ? AND intent.plan_revision = ?
        AND intent.node_key = ? AND intent.dispatch_generation = 1
      ORDER BY result.result_version
    `).all(
      identity.planId,
      identity.planRevision,
      identity.nodeKey
    ) as AcceptedResultRow[];
    if (sources.length === 0) {
      return this.materializations.get(identity, "accepted_result") as
        AcceptedExecutionNodeMaterialization | undefined;
    }
    if (sources.length !== 1) {
      throw new Error("Execution node has ambiguous accepted Result evidence");
    }
    const source = sources[0]!;
    const pins = this.database.prepare(`
      SELECT output.slot_key, artifact.artifact_id,
        artifact.artifact_revision, artifact.artifact_type,
        artifact.content_sha256, artifact.content_size_bytes
      FROM result_evidence_refs evidence
      JOIN repository_checkpoint_outputs output
        ON output.artifact_id = evidence.artifact_id
      JOIN repository_checkpoints checkpoint
        ON checkpoint.checkpoint_id = output.checkpoint_id
      JOIN repository_capture_operations capture
        ON capture.operation_id = checkpoint.operation_id
      JOIN isolated_workspace_leases lease
        ON lease.lease_id = capture.isolated_lease_id
        AND lease.run_id = ?
      JOIN task_artifact_refs artifact
        ON artifact.artifact_id = output.artifact_id
        AND artifact.artifact_revision = output.artifact_revision
        AND artifact.source_run_id = lease.run_id
        AND artifact.content_mode = 'snapshot_blob'
      WHERE evidence.result_id = ? AND evidence.evidence_kind = 'artifact'
      ORDER BY output.slot_key, artifact.artifact_id
    `).all(source.run_id, source.result_id) as ArtifactPinRow[];
    if (pins.length === 0 || pins.some((pin) =>
      !pin.content_sha256 || !pin.content_size_bytes
    )) {
      throw new Error("Accepted Result has no canonical checkpoint output");
    }
    return this.materializations.retain({
      ...identity,
      gate: "accepted_result",
      dispatchGeneration: source.dispatch_generation,
      sourceRunId: source.run_id,
      sourceResultId: source.result_id,
      sourceResultVersion: source.result_version,
      gateOperationId: source.gate_operation_id,
      artifactPins: pins.map((pin) => ({
        outputSlot: pin.slot_key,
        artifactId: pin.artifact_id,
        artifactRevision: pin.artifact_revision,
        kind: pin.artifact_type,
        contentDigest: pin.content_sha256,
        byteLength: pin.content_size_bytes
      })),
      createdAt: source.reviewed_at
    });
  }
}
