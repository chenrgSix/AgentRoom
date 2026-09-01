import type Database from "better-sqlite3";
import type { ExternalInputKind, RepositoryCheckpoint } from
  "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type { RunState } from "../run/run-repository.js";
import {
  type ExecutionNodeIdentity,
  type ExecutionNodeState,
  type ExecutionNodeStateValue
} from "./execution-node-state-repository.js";
import type { ExecutionNodeMaterializationRepository } from
  "./execution-node-materialization-repository.js";
import type {
  ExecutionNodeMaterialization,
  VerificationReceiptPin
} from "./execution-node-materialization-repository.js";
import type { ExecutionNodeProjector } from "./execution-node-projector.js";

interface SettlementRow {
  dispatch_generation: number | null;
  plan_state: string;
  run_id: string | null;
  run_state: RunState | null;
}

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

interface VerifiedResultRow {
  checkpoint_id: string;
  checkpoint_json: string;
  dispatch_generation: 1;
  result_id: string;
  result_version: number;
  run_id: string;
}

interface RequiredProfileRow {
  profile_digest: string;
  profile_id: string;
  profile_revision: number;
}

interface PassedReceiptRow extends RequiredProfileRow {
  operation_id: string;
  receipt_digest: string;
  receipt_json: string;
  recorded_at: string;
  verification_id: string;
}

const settleRun = (runState: RunState): {
  blockerCode: string | null;
  state: ExecutionNodeStateValue;
} => {
  switch (runState) {
    case "queued":
    case "delivered":
      return { state: "dispatched", blockerCode: null };
    case "working":
      return { state: "working", blockerCode: null };
    case "input_required":
      return { state: "working", blockerCode: "EXECUTION_RUN_INPUT_REQUIRED" };
    case "completed":
      return { state: "awaiting_result", blockerCode: "EXECUTION_RESULT_REQUIRED" };
    case "failed":
    case "expired":
      return { state: "failed", blockerCode: `EXECUTION_RUN_${runState.toUpperCase()}` };
    case "canceled":
      return { state: "canceled", blockerCode: "EXECUTION_RUN_CANCELED" };
    case "outcome_unknown":
      return {
        state: "outcome_unknown",
        blockerCode: "EXECUTION_RUN_OUTCOME_UNKNOWN"
      };
  }
};

export class ExecutionSettlementService {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions: SqliteTransactionBoundary,
    private readonly projector: ExecutionNodeProjector,
    private readonly materializations: ExecutionNodeMaterializationRepository
  ) {}

  public reconcile(now: string): ExecutionNodeState[] {
    return this.transactions.immediate(() => {
      this.projector.ensureCurrent(now);
      return this.projector.listAllCurrent().map((identity) =>
        this.reconcileNode(identity, now)
      );
    });
  }

  public reconcileOne(
    identity: ExecutionNodeIdentity,
    now: string
  ): ExecutionNodeState {
    return this.transactions.immediate(() => {
      this.projector.ensureCurrent(now);
      return this.reconcileNode(identity, now);
    });
  }

  private reconcileNode(
    identity: ExecutionNodeIdentity,
    now: string
  ): ExecutionNodeState {
    const accepted = this.retainAcceptedMaterialization(identity);
    const verified = this.retainVerifiedMaterialization(identity);
    const row = this.database.prepare(`
      SELECT plan.state AS plan_state, intent.dispatch_generation,
        run.run_id, run.state AS run_state
      FROM execution_plans plan
      JOIN execution_plan_nodes node ON node.plan_id = plan.plan_id
        AND node.revision = plan.current_revision
      LEFT JOIN execution_dispatch_intents intent
        ON intent.plan_id = node.plan_id
          AND intent.plan_revision = node.revision
          AND intent.node_key = node.node_key
          AND intent.dispatch_generation = 1
      LEFT JOIN runs run ON run.run_id = intent.run_id
      WHERE node.plan_id = ? AND node.revision = ? AND node.node_key = ?
    `).get(
      identity.planId,
      identity.planRevision,
      identity.nodeKey
    ) as SettlementRow | undefined;
    if (!row) throw new Error("Execution settlement source is unavailable");
    if (!row.run_id || !row.run_state || !row.dispatch_generation) {
      const current = this.projector.get(identity);
      if (!current) throw new Error("Execution node state is unavailable");
      if (["paused", "review"].includes(row.plan_state)) {
        return this.projector.projectRunSettlement({
          ...identity,
          state: "blocked",
          blockerCode: "EXECUTION_PLAN_NOT_SCHEDULABLE",
          dispatchGeneration: null,
          runId: null,
          lastRunState: null,
        }, now);
      }
      return current;
    }
    const settled = settleRun(row.run_state);
    if ((accepted || verified) && row.run_state === "completed") {
      settled.blockerCode = null;
    }
    if (row.plan_state === "approved") {
      this.database.prepare(`
        UPDATE execution_plans SET state = 'running', updated_at = ?
        WHERE plan_id = ? AND current_revision = ? AND state = 'approved'
      `).run(now, identity.planId, identity.planRevision);
    }
    return this.projector.projectRunSettlement({
      ...identity,
      ...settled,
      dispatchGeneration: row.dispatch_generation,
      runId: row.run_id,
      lastRunState: row.run_state
    }, now);
  }

  private retainAcceptedMaterialization(
    identity: ExecutionNodeIdentity
  ): ExecutionNodeMaterialization | undefined {
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
    if (sources.length === 0) return this.materializations.get(identity);
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

  private retainVerifiedMaterialization(
    identity: ExecutionNodeIdentity
  ): ExecutionNodeMaterialization | undefined {
    const retained = this.materializations.get(identity, "verified_output");
    if (retained) return retained;
    const sources = this.database.prepare(`
      SELECT intent.dispatch_generation, run.run_id,
        result.result_id, result.result_version,
        checkpoint.checkpoint_id, checkpoint.checkpoint_json
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
        AND result.state IN ('proposed', 'accepted')
      JOIN repository_capture_operations capture
        ON json_extract(capture.request_json, '$.execution.runId') = run.run_id
      JOIN repository_checkpoints checkpoint
        ON checkpoint.operation_id = capture.operation_id
      WHERE intent.plan_id = ? AND intent.plan_revision = ?
        AND intent.node_key = ? AND intent.dispatch_generation = 1
        AND EXISTS (
          SELECT 1 FROM result_evidence_refs run_evidence
          JOIN run_events event ON event.run_id = run_evidence.run_id
            AND event.sequence = run_evidence.run_sequence
            AND event.event_type = 'status' AND event.status = 'completed'
          WHERE run_evidence.result_id = result.result_id
            AND run_evidence.evidence_kind = 'run_event'
            AND run_evidence.run_id = run.run_id
        )
        AND EXISTS (
          SELECT 1 FROM result_evidence_refs evidence
          JOIN repository_checkpoint_outputs output
            ON output.checkpoint_id = checkpoint.checkpoint_id
            AND output.artifact_id = evidence.artifact_id
          WHERE evidence.result_id = result.result_id
            AND evidence.evidence_kind = 'artifact'
        )
        AND EXISTS (
          SELECT 1 FROM execution_plan_edges edge
          WHERE edge.plan_id = node.plan_id AND edge.revision = node.revision
            AND edge.from_node_key = node.node_key
            AND edge.gate = 'verified_output'
        )
      ORDER BY result.result_version, checkpoint.checkpoint_id
    `).all(
      identity.planId,
      identity.planRevision,
      identity.nodeKey
    ) as VerifiedResultRow[];
    if (sources.length === 0) return undefined;
    if (sources.length !== 1) {
      throw new Error("Execution node has ambiguous verified Result evidence");
    }
    const source = sources[0]!;
    const checkpoint = JSON.parse(source.checkpoint_json) as RepositoryCheckpoint;
    assertExecutionCommand("executionCheckpoint", checkpoint);
    const required = this.database.prepare(`
      SELECT json_extract(profile.value, '$.profileId') AS profile_id,
        json_extract(profile.value, '$.revision') AS profile_revision,
        json_extract(profile.value, '$.digest') AS profile_digest
      FROM execution_plan_nodes node
      JOIN json_each(node.node_json, '$.verificationProfiles') profile
      WHERE node.plan_id = ? AND node.revision = ? AND node.node_key = ?
        AND json_extract(profile.value, '$.required') = 1
      ORDER BY profile_id
    `).all(
      identity.planId,
      identity.planRevision,
      identity.nodeKey
    ) as RequiredProfileRow[];
    if (required.length === 0) return undefined;
    const receipts = this.database.prepare(`
      SELECT receipt.verification_id, receipt.operation_id,
        receipt.receipt_digest, receipt.receipt_json, receipt.recorded_at,
        verification.profile_id, verification.profile_revision,
        verification.profile_digest
      FROM repository_verification_operations verification
      JOIN verification_receipts receipt
        ON receipt.operation_id = verification.operation_id
        AND receipt.outcome = 'passed'
      JOIN execution_plan_nodes profile_node
        ON profile_node.plan_id = ? AND profile_node.revision = ?
        AND profile_node.node_key = ?
      JOIN json_each(profile_node.node_json, '$.verificationProfiles') required_profile
        ON json_extract(required_profile.value, '$.required') = 1
        AND json_extract(required_profile.value, '$.profileId') =
          verification.profile_id
        AND json_extract(required_profile.value, '$.revision') =
          verification.profile_revision
        AND json_extract(required_profile.value, '$.digest') =
          verification.profile_digest
      WHERE verification.checkpoint_id = ?
      ORDER BY verification.profile_id
    `).all(
      identity.planId,
      identity.planRevision,
      identity.nodeKey,
      source.checkpoint_id
    ) as PassedReceiptRow[];
    if (receipts.length !== required.length || required.some((profile, index) => {
      const receipt = receipts[index];
      return !receipt || receipt.profile_id !== profile.profile_id ||
        receipt.profile_revision !== profile.profile_revision ||
        receipt.profile_digest !== profile.profile_digest;
    })) return undefined;
    for (const row of receipts) {
      assertExecutionCommand("verificationReceipt", JSON.parse(row.receipt_json));
    }
    const pins = this.database.prepare(`
      SELECT output.slot_key, artifact.artifact_id,
        artifact.artifact_revision, artifact.artifact_type,
        artifact.content_sha256, artifact.content_size_bytes
      FROM repository_checkpoint_outputs output
      JOIN result_evidence_refs evidence
        ON evidence.result_id = ? AND evidence.evidence_kind = 'artifact'
        AND evidence.artifact_id = output.artifact_id
      JOIN task_artifact_refs artifact
        ON artifact.artifact_id = output.artifact_id
        AND artifact.artifact_revision = output.artifact_revision
        AND artifact.source_run_id = ?
        AND artifact.content_mode = 'snapshot_blob'
      WHERE output.checkpoint_id = ?
      ORDER BY output.slot_key, artifact.artifact_id
    `).all(
      source.result_id,
      source.run_id,
      source.checkpoint_id
    ) as ArtifactPinRow[];
    if (pins.length === 0 || pins.some((pin) =>
      !pin.content_sha256 || !pin.content_size_bytes
    )) return undefined;
    const receiptPins: VerificationReceiptPin[] = receipts.map((receipt) => ({
      verificationId: receipt.verification_id,
      operationId: receipt.operation_id,
      receiptDigest: receipt.receipt_digest,
      profileId: receipt.profile_id,
      profileRevision: receipt.profile_revision,
      profileDigest: receipt.profile_digest
    }));
    const gateOperationId = `op_verified_materialization_${executionOperationDigest({
      ...identity,
      gate: "verified_output",
      sourceRunId: source.run_id,
      sourceResultId: source.result_id,
      checkpointId: source.checkpoint_id,
      verificationReceipts: receiptPins
    })}`;
    return this.materializations.retainVerified({
      ...identity,
      gate: "verified_output",
      dispatchGeneration: source.dispatch_generation,
      sourceRunId: source.run_id,
      sourceResultId: source.result_id,
      sourceResultVersion: source.result_version,
      gateOperationId,
      checkpointId: source.checkpoint_id,
      candidateCommit: checkpoint.candidateCommit,
      candidateTree: checkpoint.candidateTree,
      inputDigest: checkpoint.inputDigest,
      verificationReceipts: receiptPins,
      artifactPins: pins.map((pin) => ({
        outputSlot: pin.slot_key,
        artifactId: pin.artifact_id,
        artifactRevision: pin.artifact_revision,
        kind: pin.artifact_type,
        contentDigest: pin.content_sha256,
        byteLength: pin.content_size_bytes
      })),
      createdAt: receipts.reduce((latest, receipt) =>
        receipt.recorded_at > latest ? receipt.recorded_at : latest,
      receipts[0]!.recorded_at)
    });
  }
}
