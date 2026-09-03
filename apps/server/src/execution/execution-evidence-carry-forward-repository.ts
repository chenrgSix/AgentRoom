import type Database from "better-sqlite3";
import type {
  EvidenceAdoption,
  EvidenceReuseContract,
  ExecutionPlanDefinition,
  ExecutionPlanSupersessionActivationCommand,
  ExecutionPlanSupersessionActivationReceipt
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  evidenceAdoptionDigest,
  evidenceAdoptionOperationDigest,
  evidenceProofSetDigest,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";

import { createCarriedEvidenceReuseContract } from
  "./execution-evidence-reuse.js";
import type { ExecutionEvidenceAdoptionRepository } from
  "./execution-evidence-adoption-repository.js";
import { runtimeInputBindingDigest } from "./execution-evidence-reuse.js";
import { ExecutionError } from "./execution-error.js";

type Selection = ExecutionPlanSupersessionActivationCommand["carryForward"][number];
type CarryReceipt = ExecutionPlanSupersessionActivationReceipt["carryForward"][number];
type Node = ExecutionPlanDefinition["nodes"][number];
type Task = EvidenceReuseContract["task"] & { taskRevision: number };

interface SourceAdoptionRow {
  adoption_json: string;
}

interface ProofRow {
  proof_json: string;
}

const same = (left: unknown, right: unknown): boolean =>
  canonicalExecutionJSON(left) === canonicalExecutionJSON(right);

export class ExecutionEvidenceCarryForwardRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly evidence: ExecutionEvidenceAdoptionRepository
  ) {}

  public source(
    adoptionId: string
  ): { adoption: EvidenceAdoption; reuse: EvidenceReuseContract } | undefined {
    const row = this.database.prepare(`
      SELECT adoption_json FROM execution_evidence_adoptions
      WHERE adoption_id = ?
      UNION ALL
      SELECT adoption_json FROM execution_carried_evidence_adoptions
      WHERE adoption_id = ?
    `).get(adoptionId, adoptionId) as SourceAdoptionRow | undefined;
    if (!row) return undefined;
    const adoption = JSON.parse(row.adoption_json) as EvidenceAdoption;
    assertExecutionCommand("evidenceAdoption", adoption);
    for (const proof of adoption.proofs) {
      const retained = this.database.prepare(`
        SELECT proof_json FROM execution_gate_proof_refs
        WHERE kind = ? AND operation_id = ? AND proof_digest = ?
      `).get(proof.kind, proof.operationId, proof.proofDigest) as
        ProofRow | undefined;
      if (!retained || !same(JSON.parse(retained.proof_json), proof)) {
        throw new ExecutionError("EXECUTION_CARRY_PROOF_UNAVAILABLE");
      }
    }
    const reuse = this.evidence.getReuse(adoption.adoptionId);
    if (!reuse) throw new ExecutionError("EXECUTION_REUSE_CONTRACT_UNAVAILABLE");
    return { adoption, reuse };
  }

  public retain(input: {
    activatedBy: ExecutionPlanSupersessionActivationReceipt["activatedBy"];
    activationOperationId: string;
    candidateDigest: string;
    candidateRevision: number;
    definition: ExecutionPlanDefinition;
    delegationId: string | null;
    node: Node;
    planId: string;
    selection: Selection;
    task: Task;
    now: string;
  }): CarryReceipt {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const source = this.source(input.selection.sourceAdoptionId);
    if (!source ||
      source.adoption.authority.service === "remote_evidence_adoption" ||
      source.adoption.planId !== input.planId ||
      source.adoption.planRevision !== input.candidateRevision - 1 ||
      source.adoption.adoptionDigest !== input.selection.sourceAdoptionDigest ||
      source.adoption.gate !== input.selection.gate ||
      source.reuse.reuseContractId !== input.selection.sourceReuseContractId ||
      source.reuse.nodeReuseContractDigest !==
        input.selection.sourceNodeReuseContractDigest ||
      source.reuse.reuseInputEvidenceDigest !==
        input.selection.sourceReuseInputEvidenceDigest) {
      throw new ExecutionError("EXECUTION_CARRY_SOURCE_CONFLICT", 409);
    }
    this.requireLogicalInputs(input.definition, input.node, source.reuse);
    const oldAuthority = source.adoption.authority;
    if (!oldAuthority.agentId || !oldAuthority.deviceId ||
      !oldAuthority.grantId || !oldAuthority.grantRevision ||
      !oldAuthority.grantDigest || !source.adoption.sourceExecution) {
      throw new ExecutionError("EXECUTION_CARRY_LOCAL_AUTHORITY_REQUIRED");
    }
    const operationId = `op_${executionOperationDigest({
      purpose: "execution_evidence_carry_forward_v1",
      activationOperationId: input.activationOperationId,
      targetNodeKey: input.node.nodeKey,
      gate: input.selection.gate
    })}`;
    const adoptionId = `adoption_${executionOperationDigest({
      purpose: "execution_evidence_carry_forward_adoption_v1",
      operationId,
      sourceAdoptionId: source.adoption.adoptionId,
      targetNodeKey: input.node.nodeKey
    })}`;
    const resolvedInputSetDigest = runtimeInputBindingDigest([]);
    const nodeContractDigest = executionOperationDigest({
      planId: input.planId,
      planRevision: input.candidateRevision,
      planDigest: input.candidateDigest,
      approvalOperationId: input.activationOperationId,
      node: input.node,
      task: input.task,
      resolvedInputSetDigest
    });
    const authority: EvidenceAdoption["authority"] = {
      service: "execution_supersession",
      approvalOperationId: input.activationOperationId,
      planDigest: input.candidateDigest,
      roomId: input.task.roomId,
      taskId: input.task.taskId,
      definitionRevision: input.task.definitionRevision,
      criteriaRevision: input.task.criteriaRevision,
      activatedBy: structuredClone(input.activatedBy),
      sourceAdoptionId: source.adoption.adoptionId,
      sourceAdoptionDigest: source.adoption.adoptionDigest,
      sourceReuseContractId: source.reuse.reuseContractId,
      agentId: oldAuthority.agentId,
      deviceId: oldAuthority.deviceId,
      grantId: oldAuthority.grantId,
      grantRevision: oldAuthority.grantRevision,
      grantDigest: oldAuthority.grantDigest,
      ...(input.delegationId ? { delegationId: input.delegationId } : {})
    };
    const pending = {
      version: 1,
      adoptionId,
      operationId,
      operationDigest: "0".repeat(64),
      planId: input.planId,
      planRevision: input.candidateRevision,
      nodeKey: input.node.nodeKey,
      gate: source.adoption.gate,
      sourceEvidenceId: source.adoption.sourceEvidenceId,
      sourceDigest: source.adoption.sourceDigest,
      sourceExecution: structuredClone(source.adoption.sourceExecution),
      proofs: source.adoption.proofs.map((proof) => ({ ...proof })),
      proofSetDigest: evidenceProofSetDigest(source.adoption.proofs),
      nodeContractDigest,
      resolvedInputSetDigest,
      authority,
      adoptionDigest: "0".repeat(64),
      createdAt: input.now
    } as EvidenceAdoption;
    pending.operationDigest = evidenceAdoptionOperationDigest(pending);
    pending.adoptionDigest = evidenceAdoptionDigest(pending);
    assertExecutionCommand("evidenceAdoption", pending);
    const targetReuse = createCarriedEvidenceReuseContract({
      adoption: pending,
      integrationPolicy: input.definition.policy,
      node: input.node,
      reuseInputs: source.reuse.reuseInputs,
      task: input.task
    });
    if (targetReuse.nodeReuseContractDigest !==
        source.reuse.nodeReuseContractDigest ||
      targetReuse.reuseInputEvidenceDigest !==
        source.reuse.reuseInputEvidenceDigest) {
      throw new ExecutionError("EXECUTION_CARRY_REUSE_MISMATCH", 409);
    }
    this.database.prepare(`
      INSERT INTO execution_carried_evidence_adoptions (
        adoption_id, schema_version, operation_id, operation_digest,
        plan_id, plan_revision, node_key, gate, source_adoption_id,
        source_evidence_id, source_digest, proof_set_digest,
        node_contract_digest, resolved_input_set_digest, adoption_digest,
        adoption_json, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pending.adoptionId,
      pending.operationId,
      pending.operationDigest,
      pending.planId,
      pending.planRevision,
      pending.nodeKey,
      pending.gate,
      source.adoption.adoptionId,
      pending.sourceEvidenceId,
      pending.sourceDigest,
      pending.proofSetDigest,
      pending.nodeContractDigest,
      pending.resolvedInputSetDigest,
      pending.adoptionDigest,
      canonicalExecutionJSON(pending),
      pending.createdAt
    );
    this.database.prepare(`
      INSERT INTO execution_carried_evidence_reuse_contracts (
        reuse_contract_id, schema_version, adoption_id, adoption_digest,
        source_reuse_contract_id, plan_id, plan_revision, node_key, gate,
        runtime_input_binding_digest, reuse_input_evidence_digest,
        node_execution_digest, node_reuse_contract_digest, contract_digest,
        contract_json, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      targetReuse.reuseContractId,
      targetReuse.adoptionId,
      targetReuse.adoptionDigest,
      source.reuse.reuseContractId,
      targetReuse.planId,
      targetReuse.planRevision,
      targetReuse.nodeKey,
      targetReuse.gate,
      targetReuse.runtimeInputBindingDigest,
      targetReuse.reuseInputEvidenceDigest,
      targetReuse.nodeExecutionDigest,
      targetReuse.nodeReuseContractDigest,
      targetReuse.contractDigest,
      canonicalExecutionJSON(targetReuse),
      targetReuse.createdAt
    );
    const retained = this.source(pending.adoptionId);
    if (!retained || !same(retained.adoption, pending) ||
      !same(retained.reuse, targetReuse)) {
      throw new Error("Carried evidence is not replayable");
    }
    return {
      targetNodeKey: pending.nodeKey,
      gate: pending.gate,
      sourceAdoptionId: source.adoption.adoptionId,
      sourceAdoptionDigest: source.adoption.adoptionDigest,
      adoptionId: pending.adoptionId,
      adoptionDigest: pending.adoptionDigest,
      reuseContractId: targetReuse.reuseContractId,
      nodeReuseContractDigest: targetReuse.nodeReuseContractDigest,
      reuseInputEvidenceDigest: targetReuse.reuseInputEvidenceDigest
    };
  }

  private requireLogicalInputs(
    definition: ExecutionPlanDefinition,
    node: Node,
    reuse: EvidenceReuseContract
  ): void {
    for (const input of reuse.reuseInputs) {
      if (input.producer.kind === "adopted_evidence") {
        const edge = input.producer.edge;
        if (!edge || edge.toNodeKey !== node.nodeKey ||
          !definition.edges.some((candidate) => same(candidate, edge))) {
          throw new ExecutionError("EXECUTION_CARRY_INPUT_MISMATCH", 409);
        }
        const adopted = this.database.prepare(`
          SELECT 1 FROM execution_all_adopted_node_materializations
          WHERE plan_id = ? AND plan_revision = ? AND node_key = ?
            AND gate = ? AND source_evidence_id = ? AND source_digest = ?
        `).get(
          reuse.planId,
          reuse.planRevision + 1,
          edge.fromNodeKey,
          edge.gate,
          input.producer.sourceEvidenceId,
          input.producer.sourceDigest
        );
        if (!adopted) {
          throw new ExecutionError("EXECUTION_CARRY_INPUT_NOT_ADOPTED", 409);
        }
      } else {
        const external = input.producer.externalInput;
        if (!external || external.nodeKey !== node.nodeKey ||
          !definition.externalInputs.some((candidate) => same(candidate, external))) {
          throw new ExecutionError("EXECUTION_CARRY_INPUT_MISMATCH", 409);
        }
      }
    }
  }
}
