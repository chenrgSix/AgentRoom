import type Database from "better-sqlite3";
import type {
  EvidenceAdoption,
  EvidenceReuseContract,
  ExecutionInputBinding,
  GateProofRef,
  SourceEvidence
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  evidenceAdoptionDigest,
  evidenceAdoptionOperationDigest,
  evidenceProofSetDigest,
  executionOperationDigest,
  sourceEvidenceDigest,
  validateExecutionPlanDefinition
} from "@convene-wire/contracts/execution-validation";

import type {
  ExecutionMaterializationArtifactPin,
  ExecutionNodeMaterialization,
  IntegratedExecutionNodeMaterialization,
  VerifiedExecutionNodeMaterialization
} from "./execution-node-materialization-repository.js";
import type { ExecutionNodeIdentity } from
  "./execution-node-state-repository.js";
import { ExecutionError } from "./execution-error.js";
import { createEvidenceReuseContract } from "./execution-evidence-reuse.js";

type Gate = ExecutionNodeMaterialization["gate"];

interface LegacyIdentityRow {
  gate: Gate;
  node_key: string;
  plan_id: string;
  plan_revision: number;
}

interface ContextRow {
  agent_id: string;
  approval_operation_id: string;
  criteria_revision: number;
  definition_revision: number;
  device_id: string;
  definition_json: string;
  grant_json: string;
  node_json: string;
  plan_digest: string;
  proposed_at: string;
  result_version: number;
  room_id: string;
  task_id: string;
  task_snapshot_json: string;
}

interface CheckpointRow {
  binding_id: string;
  capture_operation_id: string;
  checkpoint_digest: string;
  created_at: string;
  input_digest: string;
  repository_id: string;
}

interface ReviewRow {
  completed_task: number;
  decision: string;
  operation_id: string;
  reason: string;
  review_revision: number;
  reviewed_at: string;
  reviewed_by_member_id: string;
  task_revision_after: number;
  task_revision_before: number;
}

interface VerificationRow {
  operation_id: string;
  profile_digest: string;
  profile_id: string;
  profile_revision: number;
  receipt_digest: string;
  recorded_at: string;
  verification_id: string;
}

interface IntegrationRow {
  candidate_commit: string;
  operation_id: string;
  receipt_digest: string;
  recorded_at: string;
  repository_id: string;
}

interface SourceRow {
  source_json: string;
}

interface AdoptionRow {
  adoption_json: string;
  legacy_materialization_digest: string;
}

interface ReuseRow {
  contract_json: string;
}

export interface EvidenceAdoptionBundle {
  adoption: EvidenceAdoption;
  legacyMaterializationDigest: string;
  source: SourceEvidence;
}

const binary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function artifacts(
  pins: ExecutionMaterializationArtifactPin[]
): SourceEvidence["artifactPins"] {
  const ordered = pins.map((pin) => ({ ...pin })).sort((left, right) =>
    binary(left.outputSlot, right.outputSlot) ||
    binary(left.artifactId, right.artifactId)
  );
  if (ordered.length === 0) {
    throw new Error("SourceEvidence requires at least one Artifact pin");
  }
  return ordered as SourceEvidence["artifactPins"];
}

function proofOrder(left: GateProofRef, right: GateProofRef): number {
  return binary(left.kind, right.kind) ||
    binary(left.operationId, right.operationId);
}

function objectFormat(value: string): "sha1" | "sha256" {
  if (value.length === 40) return "sha1";
  if (value.length === 64) return "sha256";
  throw new Error("Repository commit object format is unsupported");
}

function sourceWithDigest(
  input: Omit<SourceEvidence, "sourceDigest" | "sourceEvidenceId">
): SourceEvidence {
  const pending = {
    ...input,
    sourceEvidenceId: "source_pending0001",
    sourceDigest: "0".repeat(64)
  } satisfies SourceEvidence;
  const digest = sourceEvidenceDigest(pending);
  const source: SourceEvidence = {
    ...pending,
    sourceEvidenceId: `source_${digest}`,
    sourceDigest: digest
  };
  assertExecutionCommand("sourceEvidence", source);
  return source;
}

function sealAdoption(
  input: Omit<
    EvidenceAdoption,
    "adoptionDigest" | "operationDigest" | "proofSetDigest"
  >
): EvidenceAdoption {
  const pending = {
    ...input,
    proofSetDigest: evidenceProofSetDigest(input.proofs),
    operationDigest: "0".repeat(64),
    adoptionDigest: "0".repeat(64)
  } satisfies EvidenceAdoption;
  pending.operationDigest = evidenceAdoptionOperationDigest(pending);
  pending.adoptionDigest = evidenceAdoptionDigest(pending);
  assertExecutionCommand("evidenceAdoption", pending);
  return pending;
}

function same(left: unknown, right: unknown): boolean {
  return canonicalExecutionJSON(left) === canonicalExecutionJSON(right);
}

export class ExecutionEvidenceAdoptionRepository {
  public constructor(private readonly database: Database.Database) {}

  public available(): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'execution_evidence_adoptions'
    `).get());
  }

  public reuseAvailable(): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'execution_evidence_reuse_contracts'
    `).get());
  }

  public reconcileLegacy(
    loadMaterialization: (
      identity: ExecutionNodeIdentity,
      gate: Gate
    ) => ExecutionNodeMaterialization | undefined
  ): number {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    if (!this.available()) return 0;
    const rows = this.database.prepare(`
      SELECT plan_id, plan_revision, node_key, gate
      FROM execution_legacy_node_materializations
      ORDER BY plan_id COLLATE BINARY, plan_revision,
        node_key COLLATE BINARY, gate COLLATE BINARY
    `).all() as LegacyIdentityRow[];
    for (const row of rows) {
      const identity = {
        planId: row.plan_id,
        planRevision: row.plan_revision,
        nodeKey: row.node_key
      };
      const materialization = loadMaterialization(identity, row.gate);
      if (!materialization) {
        throw new Error("Legacy NodeMaterialization cannot be reconstructed");
      }
      const existing = this.get(identity, row.gate);
      if (existing) {
        this.assertShadowEqual(materialization, existing);
        if (this.reuseAvailable()) {
          this.retainReuseContract(
            this.reuseContract(materialization, existing.adoption),
            true
          );
        }
      } else {
        this.retainLegacy(materialization);
      }
    }
    const localCount = (this.database.prepare(`
      SELECT count(*) AS count
      FROM execution_evidence_adoptions adoption
      JOIN execution_legacy_node_materializations legacy
        ON legacy.plan_id = adoption.plan_id
        AND legacy.plan_revision = adoption.plan_revision
        AND legacy.node_key = adoption.node_key
        AND legacy.gate = adoption.gate
        AND legacy.materialization_digest = adoption.legacy_materialization_digest
    `).get() as { count: number }).count;
    if (localCount !== rows.length) {
      throw new Error("EvidenceAdoption backfill count mismatch");
    }
    if (this.reuseAvailable()) {
      const reuseCount = (this.database.prepare(`
        SELECT count(*) AS count
        FROM execution_evidence_reuse_contracts reuse
        JOIN execution_evidence_adoptions adoption
          ON adoption.adoption_id = reuse.adoption_id
          AND adoption.adoption_digest = reuse.adoption_digest
          AND adoption.plan_id = reuse.plan_id
          AND adoption.plan_revision = reuse.plan_revision
          AND adoption.node_key = reuse.node_key
          AND adoption.gate = reuse.gate
          AND adoption.resolved_input_set_digest =
            reuse.runtime_input_binding_digest
          AND adoption.node_contract_digest = reuse.node_execution_digest
        JOIN execution_legacy_node_materializations legacy
          ON legacy.plan_id = adoption.plan_id
          AND legacy.plan_revision = adoption.plan_revision
          AND legacy.node_key = adoption.node_key
          AND legacy.gate = adoption.gate
          AND legacy.materialization_digest =
            adoption.legacy_materialization_digest
      `).get() as { count: number }).count;
      if (reuseCount !== rows.length) {
        throw new Error("EvidenceReuseContract backfill count mismatch");
      }
    }
    return rows.length;
  }

  public retainLegacy(
    materialization: ExecutionNodeMaterialization
  ): EvidenceAdoptionBundle {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const context = this.context(materialization);
    const taskSource = this.taskResultSource(materialization, context);
    this.retainSource(taskSource);
    const source = materialization.gate === "accepted_result"
      ? taskSource
      : this.repositoryCommitSource(materialization, taskSource, context.device_id);
    this.retainSource(source);
    const proofs = this.proofs(materialization, context).sort(proofOrder) as
      EvidenceAdoption["proofs"];
    for (const proof of proofs) this.retainProof(proof, materialization.createdAt);
    const inputs = (this.database.prepare(`
      SELECT binding_json FROM execution_input_bindings
      WHERE destination_run_id = ?
      ORDER BY input_slot COLLATE BINARY, binding_id COLLATE BINARY
    `).all(materialization.sourceRunId) as Array<{
      binding_json: string;
    }>).map((row) => {
      const binding = JSON.parse(row.binding_json) as ExecutionInputBinding;
      assertExecutionCommand("executionInputBinding", binding);
      return binding;
    });
    const resolvedInputSetDigest = executionOperationDigest(inputs);
    const nodeContractDigest = executionOperationDigest({
      planId: materialization.planId,
      planRevision: materialization.planRevision,
      planDigest: context.plan_digest,
      approvalOperationId: context.approval_operation_id,
      node: JSON.parse(context.node_json),
      task: JSON.parse(context.task_snapshot_json),
      resolvedInputSetDigest
    });
    const keyDigest = executionOperationDigest({
      planId: materialization.planId,
      planRevision: materialization.planRevision,
      nodeKey: materialization.nodeKey,
      gate: materialization.gate,
      sourceEvidenceId: source.sourceEvidenceId,
      legacyMaterializationDigest: materialization.materializationDigest
    });
    const grant = JSON.parse(context.grant_json) as {
      grant?: { digest?: unknown; grantId?: unknown; revision?: unknown };
    };
    if (
      typeof grant.grant?.grantId !== "string" ||
      typeof grant.grant.revision !== "number" ||
      typeof grant.grant.digest !== "string"
    ) {
      throw new Error("EvidenceAdoption grant authority is invalid");
    }
    const adoption = sealAdoption({
      version: 1,
      adoptionId: `adoption_${keyDigest}`,
      operationId: `op_adoption_${keyDigest}`,
      planId: materialization.planId,
      planRevision: materialization.planRevision,
      nodeKey: materialization.nodeKey,
      gate: materialization.gate,
      sourceEvidenceId: source.sourceEvidenceId,
      sourceDigest: source.sourceDigest,
      sourceExecution: {
        runId: materialization.sourceRunId,
        dispatchGeneration: materialization.dispatchGeneration
      },
      proofs,
      nodeContractDigest,
      resolvedInputSetDigest,
      authority: {
        service: "execution_materialization",
        approvalOperationId: context.approval_operation_id,
        planDigest: context.plan_digest,
        roomId: context.room_id,
        taskId: context.task_id,
        definitionRevision: context.definition_revision,
        criteriaRevision: context.criteria_revision,
        agentId: context.agent_id,
        deviceId: context.device_id,
        grantId: grant.grant.grantId,
        grantRevision: grant.grant.revision,
        grantDigest: grant.grant.digest
      },
      createdAt: materialization.createdAt
    });
    const reuseContract = this.reuseAvailable()
      ? this.reuseContract(materialization, adoption, context, inputs)
      : undefined;
    const existing = this.get(materialization, materialization.gate);
    if (existing) {
      if (
        !same(existing.adoption, adoption) ||
        !same(existing.source, source) ||
        existing.legacyMaterializationDigest !==
          materialization.materializationDigest
      ) {
        throw new Error("EvidenceAdoption conflicts with retained local proof");
      }
      this.assertShadowEqual(materialization, existing);
      if (this.reuseAvailable()) {
        this.retainReuseContract(reuseContract!, false);
      }
      return existing;
    }
    this.database.prepare(`
      INSERT INTO execution_evidence_adoptions (
        adoption_id, schema_version, operation_id, operation_digest,
        plan_id, plan_revision, node_key, gate, source_evidence_id,
        source_digest, source_run_id, dispatch_generation, proof_set_digest,
        node_contract_digest, resolved_input_set_digest, adoption_digest,
        adoption_json, legacy_materialization_digest, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      adoption.adoptionId,
      adoption.operationId,
      adoption.operationDigest,
      adoption.planId,
      adoption.planRevision,
      adoption.nodeKey,
      adoption.gate,
      adoption.sourceEvidenceId,
      adoption.sourceDigest,
      adoption.sourceExecution?.runId ?? null,
      adoption.sourceExecution?.dispatchGeneration ?? null,
      adoption.proofSetDigest,
      adoption.nodeContractDigest,
      adoption.resolvedInputSetDigest,
      adoption.adoptionDigest,
      canonicalExecutionJSON(adoption),
      materialization.materializationDigest,
      adoption.createdAt
    );
    const retained = this.get(materialization, materialization.gate)!;
    this.assertShadowEqual(materialization, retained);
    if (this.reuseAvailable()) {
      this.retainReuseContract(reuseContract!, true);
    }
    return retained;
  }

  public get(
    identity: ExecutionNodeIdentity,
    gate: Gate
  ): EvidenceAdoptionBundle | undefined {
    if (!this.available()) return undefined;
    const row = this.database.prepare(`
      SELECT adoption_json, legacy_materialization_digest
      FROM execution_evidence_adoptions
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND gate = ?
    `).get(
      identity.planId,
      identity.planRevision,
      identity.nodeKey,
      gate
    ) as AdoptionRow | undefined;
    if (!row) return undefined;
    const adoption = JSON.parse(row.adoption_json) as EvidenceAdoption;
    assertExecutionCommand("evidenceAdoption", adoption);
    const source = this.getSource(
      adoption.sourceEvidenceId,
      adoption.sourceDigest
    );
    if (!source) throw new Error("EvidenceAdoption source is unavailable");
    return {
      adoption,
      legacyMaterializationDigest: row.legacy_materialization_digest,
      source
    };
  }

  public getSource(
    sourceEvidenceId: string,
    sourceDigest?: string
  ): SourceEvidence | undefined {
    if (!this.available()) return undefined;
    const row = this.database.prepare(`
      SELECT source_json FROM execution_source_evidence
      WHERE source_evidence_id = ?
        AND (? IS NULL OR source_digest = ?)
    `).get(sourceEvidenceId, sourceDigest ?? null, sourceDigest ?? null) as
      SourceRow | undefined;
    if (!row) return undefined;
    const source = JSON.parse(row.source_json) as SourceEvidence;
    assertExecutionCommand("sourceEvidence", source);
    return source;
  }

  public getReuse(adoptionId: string): EvidenceReuseContract | undefined {
    if (!this.reuseAvailable()) return undefined;
    const row = this.database.prepare(`
      SELECT contract_json FROM execution_evidence_reuse_contracts
      WHERE adoption_id = ?
    `).get(adoptionId) as ReuseRow | undefined;
    if (!row) return undefined;
    const contract = JSON.parse(row.contract_json) as EvidenceReuseContract;
    assertExecutionCommand("evidenceReuseContract", contract);
    return contract;
  }

  private context(materialization: ExecutionNodeMaterialization): ContextRow {
    const row = this.database.prepare(`
      SELECT node.task_id, node.definition_revision, node.criteria_revision,
        node.agent_id, node.node_json, node.task_snapshot_json,
        proposal.definition_json,
        intent.room_id, intent.device_id, intent.plan_digest,
        intent.approval_operation_id, admission.grant_json,
        result.result_version, result.proposed_at
      FROM execution_plan_nodes node
      JOIN execution_dispatch_intents intent
        ON intent.plan_id = node.plan_id
        AND intent.plan_revision = node.revision
        AND intent.node_key = node.node_key
        AND intent.dispatch_generation = ?
        AND intent.run_id = ?
      JOIN execution_run_admissions admission ON admission.run_id = intent.run_id
      JOIN execution_plan_proposals proposal
        ON proposal.plan_id = node.plan_id
        AND proposal.revision = node.revision
      JOIN task_results result
        ON result.result_id = ?
        AND result.result_version = ?
        AND result.task_id = node.task_id
        AND result.proposed_by_run_id = intent.run_id
      WHERE node.plan_id = ? AND node.revision = ? AND node.node_key = ?
    `).get(
      materialization.dispatchGeneration,
      materialization.sourceRunId,
      materialization.sourceResultId,
      materialization.sourceResultVersion,
      materialization.planId,
      materialization.planRevision,
      materialization.nodeKey
    ) as ContextRow | undefined;
    if (!row) throw new Error("Legacy materialization context is incomplete");
    return row;
  }

  private reuseContract(
    materialization: ExecutionNodeMaterialization,
    adoption: EvidenceAdoption,
    knownContext?: ContextRow,
    knownInputs?: ExecutionInputBinding[]
  ): EvidenceReuseContract {
    const context = knownContext ?? this.context(materialization);
    const definition = validateExecutionPlanDefinition(
      JSON.parse(context.definition_json)
    ).definition;
    const node = definition.nodes.find((entry) =>
      entry.nodeKey === materialization.nodeKey);
    if (!node) throw new Error("Evidence reuse node is unavailable");
    const bindings = knownInputs ?? (this.database.prepare(`
      SELECT binding_json FROM execution_input_bindings
      WHERE destination_run_id = ?
      ORDER BY input_slot COLLATE BINARY, binding_id COLLATE BINARY
    `).all(materialization.sourceRunId) as Array<{
      binding_json: string;
    }>).map((row) => {
      const binding = JSON.parse(row.binding_json) as ExecutionInputBinding;
      assertExecutionCommand("executionInputBinding", binding);
      return binding;
    });
    const reuseInputs = bindings.map((binding) => {
      const edge = definition.edges.find((entry) =>
        entry.edgeKey === binding.edgeKey &&
        entry.toNodeKey === materialization.nodeKey &&
        entry.bindings.some((candidate) =>
          candidate.inputSlot === binding.inputSlot)
      );
      const external = definition.externalInputs.find((entry) =>
        entry.nodeKey === materialization.nodeKey &&
        entry.inputSlot === binding.inputSlot
      );
      if ((edge && external) || (!edge && !external)) {
        throw new Error("Evidence reuse input producer is ambiguous");
      }
      if (edge) {
        const source = this.get({
          planId: materialization.planId,
          planRevision: materialization.planRevision,
          nodeKey: edge.fromNodeKey
        }, edge.gate);
        const edgeBinding = edge.bindings.find((candidate) =>
          candidate.inputSlot === binding.inputSlot);
        const pin = edgeBinding && source?.source.artifactPins.find((candidate) =>
          candidate.outputSlot === edgeBinding.outputSlot);
        if (
          !source || !edgeBinding || !pin ||
          binding.planId !== materialization.planId ||
          binding.planRevision !== materialization.planRevision ||
          binding.gate !== edge.gate ||
          binding.sourceTaskId !== source.adoption.authority.taskId ||
          binding.sourceOutputSlot !== edgeBinding.outputSlot ||
          binding.artifact.artifactId !== pin.artifactId ||
          binding.artifact.artifactRevision !== pin.artifactRevision ||
          binding.artifact.contentDigest !== pin.contentDigest ||
          binding.artifact.kind !== pin.kind
        ) {
          throw new Error("Evidence reuse graph input is not shadow-equal");
        }
        return {
          inputSlot: binding.inputSlot,
          producer: {
            kind: "adopted_evidence" as const,
            edge,
            sourceEvidenceId: source.adoption.sourceEvidenceId,
            sourceDigest: source.adoption.sourceDigest,
            proofSetDigest: source.adoption.proofSetDigest
          },
          artifact: {
            contentDigest: binding.artifact.contentDigest,
            kind: binding.artifact.kind
          }
        };
      }
      if (
        !external || binding.edgeKey !== null ||
        binding.gate !== "accepted_result" ||
        binding.sourceTaskId !== external.sourceTaskId ||
        binding.sourceResultId !== external.sourceResultId ||
        binding.artifact.artifactId !== external.artifactId ||
        binding.artifact.artifactRevision !== external.artifactRevision ||
        binding.artifact.contentDigest !== external.contentDigest ||
        binding.artifact.kind !== external.kind
      ) {
        throw new Error("Evidence reuse external input is not shadow-equal");
      }
      return {
        inputSlot: binding.inputSlot,
        producer: {
          kind: "external_result" as const,
          externalInput: external,
          reviewOperationId: binding.gateOperationId,
          reviewDigest: binding.gateDigest
        },
        artifact: {
          contentDigest: binding.artifact.contentDigest,
          kind: binding.artifact.kind
        }
      };
    });
    return createEvidenceReuseContract({
      adoption,
      bindings,
      integrationPolicy: definition.policy,
      node,
      reuseInputs,
      task: JSON.parse(context.task_snapshot_json) as
        EvidenceReuseContract["task"] & { taskRevision: number }
    });
  }

  private retainReuseContract(
    contract: EvidenceReuseContract,
    allowInsert: boolean
  ): void {
    const row = this.database.prepare(`
      SELECT contract_json FROM execution_evidence_reuse_contracts
      WHERE adoption_id = ? OR reuse_contract_id = ? OR contract_digest = ?
    `).get(
      contract.adoptionId,
      contract.reuseContractId,
      contract.contractDigest
    ) as ReuseRow | undefined;
    if (row) {
      if (!same(JSON.parse(row.contract_json), contract)) {
        throw new Error("EvidenceReuseContract conflicts with retained content");
      }
      return;
    }
    if (!allowInsert) {
      throw new Error("EvidenceReuseContract is unavailable");
    }
    this.database.prepare(`
      INSERT INTO execution_evidence_reuse_contracts (
        reuse_contract_id, schema_version, adoption_id, adoption_digest,
        plan_id, plan_revision, node_key, gate,
        runtime_input_binding_digest, reuse_input_evidence_digest,
        node_execution_digest, node_reuse_contract_digest, contract_digest,
        contract_json, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
    const retained = this.getReuse(contract.adoptionId);
    if (!retained || !same(retained, contract)) {
      throw new Error("EvidenceReuseContract insert is not replayable");
    }
  }

  private taskResultSource(
    materialization: ExecutionNodeMaterialization,
    context: ContextRow
  ): SourceEvidence {
    return sourceWithDigest({
      version: 1,
      kind: "task_result",
      roomId: context.room_id,
      taskId: context.task_id,
      definitionRevision: context.definition_revision,
      criteriaRevision: context.criteria_revision,
      sourceRunId: materialization.sourceRunId,
      dispatchGeneration: materialization.dispatchGeneration,
      agentId: context.agent_id,
      deviceId: context.device_id,
      resultId: materialization.sourceResultId,
      resultVersion: context.result_version,
      artifactPins: artifacts(materialization.artifactPins),
      createdAt: context.proposed_at
    });
  }

  private repositoryCommitSource(
    materialization: VerifiedExecutionNodeMaterialization |
      IntegratedExecutionNodeMaterialization,
    companion: SourceEvidence,
    deviceId: string
  ): SourceEvidence {
    const checkpoint = this.database.prepare(`
      SELECT checkpoint.digest AS checkpoint_digest,
        checkpoint.operation_id AS capture_operation_id,
        checkpoint.recorded_at AS created_at,
        json_extract(checkpoint.checkpoint_json, '$.repositoryId') AS repository_id,
        json_extract(checkpoint.checkpoint_json, '$.bindingId') AS binding_id,
        json_extract(checkpoint.checkpoint_json, '$.inputDigest') AS input_digest
      FROM repository_checkpoints checkpoint
      WHERE checkpoint.checkpoint_id = ?
    `).get(materialization.checkpointId) as CheckpointRow | undefined;
    if (!checkpoint) throw new Error("Repository checkpoint source is unavailable");
    return sourceWithDigest({
      version: 1,
      kind: "repository_commit",
      repositoryId: checkpoint.repository_id,
      objectFormat: objectFormat(materialization.candidateCommit),
      commit: materialization.candidateCommit,
      tree: materialization.candidateTree,
      inputDigest: checkpoint.input_digest,
      artifactPins: artifacts(materialization.artifactPins),
      origin: {
        kind: "local_checkpoint",
        checkpointId: materialization.checkpointId,
        checkpointDigest: checkpoint.checkpoint_digest,
        captureOperationId: checkpoint.capture_operation_id,
        sourceRunId: materialization.sourceRunId,
        dispatchGeneration: materialization.dispatchGeneration,
        deviceId,
        bindingId: checkpoint.binding_id,
        companionSourceEvidenceId: companion.sourceEvidenceId,
        companionSourceDigest: companion.sourceDigest
      },
      createdAt: checkpoint.created_at
    });
  }

  private proofs(
    materialization: ExecutionNodeMaterialization,
    context: ContextRow
  ): GateProofRef[] {
    if (materialization.gate === "accepted_result") {
      const review = this.database.prepare(`
        SELECT * FROM result_reviews WHERE operation_id = ? AND result_id = ?
      `).get(
        materialization.gateOperationId,
        materialization.sourceResultId
      ) as ReviewRow | undefined;
      if (!review) throw new Error("Accepted Result review proof is unavailable");
      const proofDigest = executionOperationDigest({
        resultId: materialization.sourceResultId,
        resultVersion: context.result_version,
        operationId: review.operation_id,
        decision: review.decision,
        reviewRevision: review.review_revision,
        reviewedByMemberId: review.reviewed_by_member_id,
        reason: review.reason,
        taskRevisionBefore: review.task_revision_before,
        taskRevisionAfter: review.task_revision_after,
        completedTask: Boolean(review.completed_task),
        reviewedAt: review.reviewed_at
      });
      return [{
        kind: "result_review",
        operationId: review.operation_id,
        resultId: materialization.sourceResultId,
        resultVersion: context.result_version,
        proofDigest
      }];
    }
    if (materialization.gate === "verified_output") {
      return materialization.verificationReceipts.map((pin) => {
        const row = this.database.prepare(`
          SELECT receipt.verification_id, receipt.operation_id,
            receipt.receipt_digest, receipt.recorded_at,
            operation.profile_id, operation.profile_revision,
            operation.profile_digest
          FROM verification_receipts receipt
          JOIN repository_verification_operations operation
            ON operation.operation_id = receipt.operation_id
          WHERE receipt.verification_id = ? AND receipt.operation_id = ?
            AND receipt.receipt_digest = ? AND receipt.outcome = 'passed'
        `).get(
          pin.verificationId,
          pin.operationId,
          pin.receiptDigest
        ) as VerificationRow | undefined;
        if (!row) throw new Error("Verification proof is unavailable");
        return {
          kind: "verification_receipt",
          operationId: row.operation_id,
          verificationId: row.verification_id,
          profileId: row.profile_id,
          profileRevision: row.profile_revision,
          profileDigest: row.profile_digest,
          proofDigest: row.receipt_digest
        } satisfies GateProofRef;
      });
    }
    const row = this.database.prepare(`
      SELECT receipt.operation_id, receipt.receipt_digest, receipt.recorded_at,
        operation.repository_id, operation.candidate_commit
      FROM integration_receipts receipt
      JOIN repository_integration_operations operation
        ON operation.operation_id = receipt.operation_id
      WHERE receipt.operation_id = ? AND receipt.state = 'succeeded'
        AND receipt.error_code IS NULL
    `).get(materialization.gateOperationId) as IntegrationRow | undefined;
    if (!row) throw new Error("Integration proof is unavailable");
    return [{
      kind: "integration_receipt",
      operationId: row.operation_id,
      repositoryId: row.repository_id,
      resultingCommit: row.candidate_commit,
      proofDigest: row.receipt_digest
    }];
  }

  private retainSource(source: SourceEvidence): void {
    const existing = this.database.prepare(`
      SELECT source_json FROM execution_source_evidence
      WHERE source_evidence_id = ? OR source_digest = ?
    `).get(source.sourceEvidenceId, source.sourceDigest) as SourceRow | undefined;
    if (existing) {
      if (!same(JSON.parse(existing.source_json), source)) {
        throw new Error("SourceEvidence conflicts with retained content");
      }
      return;
    }
    const local = source.kind === "repository_commit" &&
      source.origin?.kind === "local_checkpoint" ? source.origin : undefined;
    this.database.prepare(`
      INSERT INTO execution_source_evidence (
        source_evidence_id, schema_version, kind, source_digest, source_json,
        source_run_id, source_result_id, repository_id, checkpoint_id,
        candidate_commit, candidate_tree, companion_source_evidence_id,
        created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.sourceEvidenceId,
      source.kind,
      source.sourceDigest,
      canonicalExecutionJSON(source),
      source.kind === "task_result" ? source.sourceRunId : local?.sourceRunId,
      source.kind === "task_result" ? source.resultId : null,
      source.kind === "repository_commit" ? source.repositoryId : null,
      local?.checkpointId ?? null,
      source.kind === "repository_commit" ? source.commit : null,
      source.kind === "repository_commit" ? source.tree : null,
      local?.companionSourceEvidenceId ?? null,
      source.createdAt
    );
  }

  private retainProof(proof: GateProofRef, createdAt: string): void {
    assertExecutionCommand("gateProofRef", proof);
    const proofRefId = `proof_${executionOperationDigest(proof)}`;
    const existing = this.database.prepare(`
      SELECT proof_json FROM execution_gate_proof_refs
      WHERE proof_ref_id = ? OR (kind = ? AND operation_id = ?)
    `).get(proofRefId, proof.kind, proof.operationId) as {
      proof_json: string;
    } | undefined;
    if (existing) {
      if (!same(JSON.parse(existing.proof_json), proof)) {
        throw new Error("GateProofRef conflicts with retained proof");
      }
      return;
    }
    this.database.prepare(`
      INSERT INTO execution_gate_proof_refs (
        proof_ref_id, kind, operation_id, proof_digest, proof_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      proofRefId,
      proof.kind,
      proof.operationId,
      proof.proofDigest,
      canonicalExecutionJSON(proof),
      createdAt
    );
  }

  public assertShadowEqual(
    materialization: ExecutionNodeMaterialization,
    bundle: EvidenceAdoptionBundle
  ): void {
    const { adoption, source } = bundle;
    if (
      bundle.legacyMaterializationDigest !==
        materialization.materializationDigest ||
      adoption.planId !== materialization.planId ||
      adoption.planRevision !== materialization.planRevision ||
      adoption.nodeKey !== materialization.nodeKey ||
      adoption.gate !== materialization.gate ||
      adoption.sourceExecution?.runId !== materialization.sourceRunId ||
      adoption.sourceExecution.dispatchGeneration !==
        materialization.dispatchGeneration ||
      !same(source.artifactPins, materialization.artifactPins)
    ) {
      throw new Error("EvidenceAdoption legacy projection is not shadow-equal");
    }
    if (materialization.gate === "accepted_result") {
      const proof = adoption.proofs[0];
      if (
        source.kind !== "task_result" ||
        source.resultId !== materialization.sourceResultId ||
        source.resultVersion !== materialization.sourceResultVersion ||
        adoption.proofs.length !== 1 ||
        proof?.kind !== "result_review" ||
        proof.operationId !== materialization.gateOperationId ||
        proof.resultId !== materialization.sourceResultId ||
        proof.resultVersion !== materialization.sourceResultVersion
      ) {
        throw new Error("Accepted EvidenceAdoption is not shadow-equal");
      }
      return;
    }
    const origin = source.kind === "repository_commit" &&
      source.origin?.kind === "local_checkpoint" ? source.origin : undefined;
    if (
      source.kind !== "repository_commit" ||
      source.commit !== materialization.candidateCommit ||
      source.tree !== materialization.candidateTree ||
      source.inputDigest !== materialization.inputDigest ||
      !origin ||
      origin.checkpointId !== materialization.checkpointId ||
      origin.sourceRunId !== materialization.sourceRunId ||
      origin.dispatchGeneration !== materialization.dispatchGeneration
    ) {
      throw new Error("Repository EvidenceAdoption is not shadow-equal");
    }
    if (materialization.gate === "verified_output") {
      const projected = adoption.proofs.map((proof) => {
        if (proof.kind !== "verification_receipt") {
          throw new Error("Verified EvidenceAdoption has a foreign proof kind");
        }
        return {
          operationId: proof.operationId,
          profileDigest: proof.profileDigest,
          profileId: proof.profileId,
          profileRevision: proof.profileRevision,
          receiptDigest: proof.proofDigest,
          verificationId: proof.verificationId
        };
      });
      if (!same(projected, materialization.verificationReceipts)) {
        throw new Error("Verified EvidenceAdoption is not shadow-equal");
      }
      return;
    }
    const proof = adoption.proofs[0];
    if (
      source.repositoryId !== materialization.repositoryId ||
      origin.bindingId !== materialization.bindingId ||
      adoption.proofs.length !== 1 ||
      proof?.kind !== "integration_receipt" ||
      proof.operationId !== materialization.gateOperationId ||
      proof.repositoryId !== materialization.repositoryId ||
      proof.resultingCommit !== materialization.candidateCommit ||
      proof.proofDigest !== materialization.integrationReceiptDigest
    ) {
      throw new Error("Integrated EvidenceAdoption is not shadow-equal");
    }
  }
}
