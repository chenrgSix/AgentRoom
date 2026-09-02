import type Database from "better-sqlite3";
import type {
  EvidenceAdoption,
  GateProofRef,
  RemoteEvidenceAdoptionCommandTemplate
} from
  "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  evidenceAdoptionDigest,
  evidenceAdoptionOperationDigest,
  evidenceProofSetDigest,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";
import { ExecutionError } from "../execution/execution-error.js";
import type { ExecutionPlanRepository } from
  "../execution/execution-plan-repository.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import type { RemoteProviderBindingRepository } from
  "./remote-provider-binding-repository.js";
import type { RemoteEvidenceRepository } from "./remote-evidence-repository.js";
import {
  RemoteEvidenceAdoptionRepository,
  type RemoteEvidenceAdoptionBundle
} from "./remote-evidence-adoption-repository.js";

interface AdoptCommand {
  operationId: string;
  providerBindingId: string;
  planRevision: number;
  nodeKey: string;
  expectedPlanDigest: string;
  expectedControlRevision: number;
  sourceEvidenceId: string;
}

interface NodeContext {
  approval_operation_id: string;
  node_json: string;
  task_snapshot_json: string;
}

interface ProofRow {
  proof_json: string;
  profile_digest: string;
  profile_id: string;
  profile_revision: number;
}

export function remoteEvidenceNeedsInputAttestation(
  definition: { nodes: Array<{ nodeKey: string; inputs: unknown[] }> },
  nodeKey: string
): boolean {
  const node = definition.nodes.find((entry) => entry.nodeKey === nodeKey);
  return !node || node.inputs.length > 0;
}

const fail = (code: string, statusCode: 400 | 404 | 409 = 409): never => {
  throw new ExecutionError(code, statusCode);
};
const binary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function exactKeys(value: unknown, keys: readonly string[]):
asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    fail("REMOTE_EVIDENCE_ADOPTION_INVALID", 400);
  }
}

function seal(input: Omit<EvidenceAdoption,
  "operationDigest" | "proofSetDigest" | "adoptionDigest">): EvidenceAdoption {
  const proofs = [...input.proofs].sort((left, right) =>
    binary(left.kind, right.kind) || binary(left.operationId, right.operationId)
  ) as EvidenceAdoption["proofs"];
  const pending = {
    ...input,
    proofs,
    proofSetDigest: evidenceProofSetDigest(proofs),
    operationDigest: "0".repeat(64),
    adoptionDigest: "0".repeat(64)
  } satisfies EvidenceAdoption;
  pending.operationDigest = evidenceAdoptionOperationDigest(pending);
  pending.adoptionDigest = evidenceAdoptionDigest(pending);
  assertExecutionCommand("evidenceAdoption", pending);
  return pending;
}

/** Sole writer for explicit revision-local adoption of authenticated remote evidence. */
export class RemoteEvidenceAdoptionService {
  public constructor(
    private readonly database: Database.Database,
    private readonly repository: RemoteEvidenceAdoptionRepository,
    private readonly evidence: RemoteEvidenceRepository,
    private readonly bindings: RemoteProviderBindingRepository,
    private readonly plans: ExecutionPlanRepository,
    private readonly auth: AuthService
  ) {}

  /** Read-only exact command preparation; adoptVerified remains the authority. */
  public commandTemplate(
    principal: WebPrincipal,
    planId: string,
    nodeKey: string,
    providerBindingId: string,
    sourceEvidenceId: string
  ): RemoteEvidenceAdoptionCommandTemplate | undefined {
    const plan = this.plans.get(planId);
    if (!plan) return undefined;
    this.auth.requireFullWebSession(principal);
    const actor = this.auth.requireRoomMember(principal, plan.roomId);
    if (actor.role !== "owner" ||
      (plan.state !== "approved" && plan.state !== "running")) return undefined;
    const node = plan.current.definition.nodes.find((entry) =>
      entry.nodeKey === nodeKey);
    const binding = this.bindings.get(providerBindingId);
    const source = this.evidence.getSource(sourceEvidenceId);
    if (!node || !binding || binding.revocation || !source ||
      binding.binding.teamId !== actor.teamId ||
      source.repositoryId !== node.repository.repositoryId ||
      binding.binding.repositoryId !== source.repositoryId ||
      source.inputDigest !== executionOperationDigest([]) ||
      source.origin?.kind !== "remote_observation" ||
      source.origin.providerBindingId !== providerBindingId ||
      remoteEvidenceNeedsInputAttestation(plan.current.definition, nodeKey) ||
      this.database.prepare(`
        SELECT 1 FROM execution_dispatch_intents
        WHERE plan_id = ? AND plan_revision = ? AND node_key = ? LIMIT 1
      `).get(planId, plan.current.revision, nodeKey)) return undefined;
    const required = node.verificationProfiles.filter((profile) =>
      profile.required);
    const rows = this.proofRows(sourceEvidenceId, providerBindingId);
    if (required.length === 0 || rows.length !== required.length ||
      required.some((profile) => rows.filter((row) =>
        row.profile_id === profile.profileId &&
        row.profile_revision === profile.revision &&
        row.profile_digest === profile.digest).length !== 1)) return undefined;
    return {
      providerBindingId,
      planRevision: plan.current.revision,
      nodeKey,
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId
    };
  }

  public adoptVerified(
    principal: WebPrincipal,
    planId: string,
    input: unknown,
    now: string
  ): RemoteEvidenceAdoptionBundle {
    exactKeys(input, [
      "operationId", "providerBindingId", "planRevision", "nodeKey",
      "expectedPlanDigest", "expectedControlRevision", "sourceEvidenceId"
    ]);
    canonicalExecutionJSON(input);
    assertExecutionCommand("remoteEvidenceAdoptionCommand", input);
    const command = input as unknown as AdoptCommand;
    const plan = this.plans.get(planId);
    if (!plan) return fail("EXECUTION_PLAN_NOT_FOUND", 404);
    this.auth.requireFullWebSession(principal);
    const actor = this.auth.requireRoomMember(principal, plan.roomId);
    if (actor.role !== "owner") return fail("REMOTE_EVIDENCE_OWNER_REQUIRED");
    if ((plan.state !== "approved" && plan.state !== "running") ||
      plan.current.revision !== command.planRevision ||
      plan.current.digest !== command.expectedPlanDigest ||
      plan.controlRevision !== command.expectedControlRevision) {
      return fail("REMOTE_EVIDENCE_PLAN_STALE");
    }
    const node = plan.current.definition.nodes.find((entry) =>
      entry.nodeKey === command.nodeKey);
    const task = plan.compiledTasks.find((entry) =>
      entry.nodeKey === command.nodeKey);
    const binding = this.bindings.get(command.providerBindingId);
    const source = this.evidence.getSource(command.sourceEvidenceId);
    if (!node || !task || !binding || binding.revocation || !source ||
      binding.binding.teamId !== actor.teamId ||
      source.repositoryId !== node.repository.repositoryId ||
      binding.binding.repositoryId !== source.repositoryId ||
      source.inputDigest !== executionOperationDigest([]) ||
      source.origin?.kind !== "remote_observation" ||
      source.origin.providerBindingId !== command.providerBindingId ||
      remoteEvidenceNeedsInputAttestation(
        plan.current.definition,
        command.nodeKey
      ) ||
      this.database.prepare(`
        SELECT 1 FROM execution_dispatch_intents
        WHERE plan_id = ? AND plan_revision = ? AND node_key = ? LIMIT 1
      `).get(planId, command.planRevision, command.nodeKey)) {
      return fail("REMOTE_EVIDENCE_ADOPTION_UNAVAILABLE");
    }
    const required = node.verificationProfiles.filter((profile) =>
      profile.required);
    const rows = this.proofRows(
      command.sourceEvidenceId,
      command.providerBindingId
    );
    const selected: GateProofRef[] = [];
    for (const profile of required) {
      const matches = rows.filter((row) => row.profile_id === profile.profileId &&
        row.profile_revision === profile.revision &&
        row.profile_digest === profile.digest);
      if (matches.length !== 1) return fail("REMOTE_CI_PROOF_SET_INCOMPLETE");
      selected.push(JSON.parse(matches[0]!.proof_json) as GateProofRef);
    }
    if (selected.length === 0 || selected.length !== rows.length) {
      return fail("REMOTE_CI_PROOF_SET_AMBIGUOUS");
    }
    const context = this.database.prepare(`
      SELECT node.node_json, node.task_snapshot_json,
        approval.operation_id AS approval_operation_id
      FROM execution_plan_nodes node
      JOIN execution_plan_approvals approval ON approval.plan_id = node.plan_id
        AND approval.revision = node.revision AND approval.decision = 'approved'
      WHERE node.plan_id = ? AND node.revision = ? AND node.node_key = ?
    `).get(planId, command.planRevision, command.nodeKey) as NodeContext | undefined;
    if (!context) return fail("REMOTE_EVIDENCE_ADOPTION_UNAVAILABLE");
    const resolvedInputSetDigest = executionOperationDigest([]);
    const nodeContractDigest = executionOperationDigest({
      planId,
      planRevision: command.planRevision,
      planDigest: command.expectedPlanDigest,
      approvalOperationId: context.approval_operation_id,
      node: JSON.parse(context.node_json),
      task: JSON.parse(context.task_snapshot_json),
      resolvedInputSetDigest
    });
    const adoption = seal({
      version: 1,
      adoptionId: `adoption_${executionOperationDigest({
        operationId: command.operationId,
        sourceEvidenceId: source.sourceEvidenceId,
        gate: "verified_output"
      })}`,
      operationId: command.operationId,
      planId,
      planRevision: command.planRevision,
      nodeKey: command.nodeKey,
      gate: "verified_output",
      sourceEvidenceId: source.sourceEvidenceId,
      sourceDigest: source.sourceDigest,
      sourceExecution: null,
      proofs: selected as EvidenceAdoption["proofs"],
      nodeContractDigest,
      resolvedInputSetDigest,
      authority: {
        service: "remote_evidence_adoption",
        approvalOperationId: context.approval_operation_id,
        planDigest: command.expectedPlanDigest,
        roomId: plan.roomId,
        taskId: task.taskId,
        definitionRevision: task.definitionRevision,
        criteriaRevision: task.criteriaRevision,
        actorMemberId: actor.memberId,
        providerBindingId: command.providerBindingId,
        bindingDigest: binding.binding.bindingDigest
      },
      createdAt: now
    });
    const replay = this.repository.getByOperation(command.operationId);
    if (replay) {
      if (canonicalExecutionJSON(replay.adoption) !== canonicalExecutionJSON(adoption)) {
        return fail("REMOTE_EVIDENCE_OPERATION_CONFLICT");
      }
      return replay;
    }
    return this.repository.retain(command.providerBindingId, adoption);
  }

  private proofRows(
    sourceEvidenceId: string,
    providerBindingId: string
  ): ProofRow[] {
    return this.database.prepare(`
      SELECT proof.proof_json, receipt.profile_id, receipt.profile_revision,
        receipt.profile_digest
      FROM execution_remote_gate_proof_refs proof
      JOIN remote_ci_observation_receipts receipt
        ON receipt.operation_id = proof.operation_id
      WHERE receipt.source_evidence_id = ?
        AND receipt.provider_binding_id = ? AND receipt.outcome = 'passed'
      ORDER BY receipt.profile_id COLLATE BINARY, receipt.attempt,
        receipt.operation_id COLLATE BINARY
    `).all(sourceEvidenceId, providerBindingId) as ProofRow[];
  }
}
