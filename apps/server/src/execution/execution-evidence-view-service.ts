import type Database from "better-sqlite3";
import type {
  ExecutionEvidencePage,
  RemoteCIObservationReceipt,
  RemoteCommitObservation,
  RepositoryOperationReceipt,
  SourceEvidence,
  VerificationReceipt
} from "@convene-wire/contracts/execution-plan";
import { assertExecutionCommand } from
  "@convene-wire/contracts/execution-validation";

import type { ExecutionPlanService } from "./execution-plan-service.js";
import { ExecutionEvidenceAdoptionRepository } from
  "./execution-evidence-adoption-repository.js";
import type { ExecutionNodeMaterializationRepository } from
  "./execution-node-materialization-repository.js";
import type { ExecutionNodeStateRepository } from
  "./execution-node-state-repository.js";
import type { RepositoryIntegrationService } from
  "../repository/repository-integration-service.js";
import type { RemoteEvidenceAdoptionRepository } from
  "../remote/remote-evidence-adoption-repository.js";
import type { RemoteEvidenceAdoptionService } from
  "../remote/remote-evidence-adoption-service.js";
import type { RemoteProviderBindingRepository } from
  "../remote/remote-provider-binding-repository.js";
import type { WebPrincipal } from "../security/auth-service.js";

type EvidencePlan = ExecutionEvidencePage["plans"][number];
type EvidenceNode = EvidencePlan["nodes"][number];
type EvidenceStage = EvidenceNode["stages"][number];
type IntegrationView = EvidenceNode["integration"];

interface RemoteRow {
  expected_control_revision: number;
  expected_plan_digest: string;
  observation_json: string;
  provider_binding_id: string;
  source_json: string;
}

interface ReceiptRow {
  receipt_digest: string;
  receipt_json: string;
  recorded_at: string;
}

interface ApprovalRow {
  approval_digest: string;
  approval_json: string;
  approved_at: string;
  approved_by_member_id: string;
  integration_operation_id: string;
}

const binary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const gates = ["accepted_result", "verified_output", "integrated_commit"] as const;

/** Task-scoped, path-free proof-control read model. It owns no evidence authority. */
export class ExecutionEvidenceViewService {
  private readonly localEvidence: ExecutionEvidenceAdoptionRepository;

  public constructor(
    private readonly database: Database.Database,
    private readonly plans: ExecutionPlanService,
    private readonly nodeStates: ExecutionNodeStateRepository,
    private readonly materializations: ExecutionNodeMaterializationRepository,
    private readonly remoteAdoptions: RemoteEvidenceAdoptionRepository,
    private readonly remoteAdoptionAuthority: RemoteEvidenceAdoptionService,
    private readonly remoteBindings: RemoteProviderBindingRepository,
    private readonly integrations: RepositoryIntegrationService
  ) {
    this.localEvidence = new ExecutionEvidenceAdoptionRepository(database);
  }

  public get(
    principal: WebPrincipal,
    taskId: string,
    limit: number,
    now: string
  ): ExecutionEvidencePage {
    const page = this.plans.listForTask(principal, taskId, "", limit);
    const result: ExecutionEvidencePage = {
      version: 1,
      taskId,
      plans: page.plans.map((plan) => {
        const nodes = plan.current.definition.nodes.map((node) =>
          this.node(principal, plan, node, now)
        ).sort((left, right) => binary(left.nodeKey, right.nodeKey));
        return {
          planId: plan.planId,
          planRevision: plan.current.revision,
          planDigest: plan.current.digest,
          controlRevision: plan.controlRevision,
          state: plan.state,
          nodes: nodes as EvidencePlan["nodes"]
        };
      }).sort((left, right) => binary(left.planId, right.planId))
    };
    assertExecutionCommand("executionEvidencePage", result);
    return result;
  }

  private node(
    principal: WebPrincipal,
    plan: ReturnType<ExecutionPlanService["get"]>,
    node: ReturnType<ExecutionPlanService["get"]>["current"]["definition"]["nodes"][number],
    now: string
  ): EvidenceNode {
    const identity = {
      planId: plan.planId,
      planRevision: plan.current.revision,
      nodeKey: node.nodeKey
    };
    const task = plan.compiledTasks.find((entry) => entry.nodeKey === node.nodeKey);
    if (!task) throw new Error("Execution evidence Task projection is unavailable");
    const stages = this.stages(identity);
    const localVerifications = this.localVerifications(identity);
    const remote = this.remote(principal, plan, node, now);
    const verifications = [
      ...localVerifications,
      ...(remote?.ciReceipts.map((receipt) => ({
        kind: "remote_ci" as const,
        receipt
      })) ?? [])
    ];
    const integration = this.integration(principal, plan, node, now);
    return {
      nodeKey: node.nodeKey,
      taskId: task.taskId,
      runtime: this.nodeStates.get(identity) ?? null,
      requiredVerificationProfiles: node.verificationProfiles
        .filter((profile) => profile.required)
        .map((profile) => ({
          profileId: profile.profileId,
          revision: profile.revision,
          digest: profile.digest
        })).sort((left, right) => binary(left.profileId, right.profileId)),
      stages,
      verifications,
      remote,
      integration,
      nextAction: this.nextAction(
        this.nodeStates.get(identity)?.state,
        stages,
        verifications,
        remote,
        integration
      )
    } as EvidenceNode;
  }

  private stages(identity: {
    planId: string; planRevision: number; nodeKey: string;
  }): EvidenceStage[] {
    return gates.flatMap((gate) => {
      const materialization = this.materializations.getAdopted(identity, gate);
      if (!materialization) return [];
      const remote = gate === "verified_output"
        ? this.remoteAdoptions.get(
          identity.planId,
          identity.planRevision,
          identity.nodeKey
        )
        : undefined;
      const local = remote ? undefined : this.localEvidence.get(identity, gate);
      const bundle = remote ?? local;
      if (!bundle) throw new Error("Adopted evidence projection is unavailable");
      return [{
        gate,
        materializationDigest: materialization.materializationDigest,
        source: bundle.source,
        proofs: bundle.adoption.proofs,
        adoption: bundle.adoption
      } as EvidenceStage];
    });
  }

  private localVerifications(identity: {
    planId: string; planRevision: number; nodeKey: string;
  }): EvidenceNode["verifications"] {
    return (this.database.prepare(`
      SELECT receipt.receipt_json, receipt.receipt_digest, receipt.recorded_at
      FROM verification_receipts receipt
      JOIN repository_verification_operations operation
        ON operation.operation_id = receipt.operation_id
      WHERE json_extract(operation.request_json, '$.plan.planId') = ?
        AND json_extract(operation.request_json, '$.plan.revision') = ?
        AND json_extract(operation.request_json, '$.execution.nodeKey') = ?
      ORDER BY receipt.verification_id COLLATE BINARY
    `).all(identity.planId, identity.planRevision, identity.nodeKey) as
      ReceiptRow[]).map((row) => ({
        kind: "local_verification" as const,
        receipt: JSON.parse(row.receipt_json) as VerificationReceipt,
        receiptDigest: row.receipt_digest,
        recordedAt: row.recorded_at
      }));
  }

  private remote(
    principal: WebPrincipal,
    plan: ReturnType<ExecutionPlanService["get"]>,
    node: ReturnType<ExecutionPlanService["get"]>["current"]["definition"]["nodes"][number],
    _now: string
  ): EvidenceNode["remote"] {
    const row = this.database.prepare(`
      SELECT observation.observation_json, source.source_json,
        operation.provider_binding_id, operation.expected_plan_digest,
        operation.expected_control_revision
      FROM remote_commit_observations observation
      JOIN remote_evidence_operations operation
        ON operation.operation_id = observation.operation_id
      JOIN execution_remote_source_evidence source
        ON source.observation_id = observation.observation_id
      WHERE operation.plan_id = ? AND operation.plan_revision = ?
        AND operation.node_key = ? AND operation.state = 'succeeded'
      ORDER BY operation.created_at DESC, operation.operation_id DESC LIMIT 1
    `).get(plan.planId, plan.current.revision, node.nodeKey) as RemoteRow | undefined;
    if (!row) return null;
    const commitObservation = JSON.parse(row.observation_json) as
      RemoteCommitObservation;
    const source = JSON.parse(row.source_json) as SourceEvidence;
    const receipts = (this.database.prepare(`
      SELECT receipt_json FROM remote_ci_observation_receipts
      WHERE source_evidence_id = ?
      ORDER BY check_key COLLATE BINARY, attempt, operation_id COLLATE BINARY
    `).all(source.sourceEvidenceId) as Array<{ receipt_json: string }>).map((entry) =>
      JSON.parse(entry.receipt_json) as RemoteCIObservationReceipt);
    const adoption = this.remoteAdoptions.get(
      plan.planId,
      plan.current.revision,
      node.nodeKey
    );
    const blockers: string[] = [];
    const binding = this.remoteBindings.get(row.provider_binding_id);
    if (node.inputs.length > 0) blockers.push("REMOTE_INPUT_ATTESTATION_REQUIRED");
    if (!binding || binding.revocation) blockers.push("REMOTE_PROVIDER_REVOKED");
    if (row.expected_plan_digest !== plan.current.digest ||
      row.expected_control_revision !== plan.controlRevision) {
      blockers.push("REMOTE_PLAN_STALE");
    }
    if (this.database.prepare(`
      SELECT 1 FROM execution_dispatch_intents
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ? LIMIT 1
    `).get(plan.planId, plan.current.revision, node.nodeKey)) {
      blockers.push("REMOTE_LOCAL_ATTEMPT_EXISTS");
    }
    for (const profile of node.verificationProfiles.filter((entry) => entry.required)) {
      const matches = receipts.filter((receipt) =>
        receipt.profileId === profile.profileId &&
        receipt.profileRevision === profile.revision &&
        receipt.profileDigest === profile.digest);
      if (matches.length === 0) blockers.push("REMOTE_REQUIRED_CI_MISSING");
      else if (matches.filter((receipt) => receipt.outcome === "passed").length !== 1) {
        blockers.push("REMOTE_REQUIRED_CI_NOT_PASSED");
      }
    }
    const blockerCodes = [...new Set(blockers)].sort(binary) as
      NonNullable<EvidenceNode["remote"]>["blockerCodes"];
    let commandTemplate = null;
    if (!adoption && blockerCodes.length === 0) {
      try {
        commandTemplate = this.remoteAdoptionAuthority.commandTemplate(
          principal,
          plan.planId,
          node.nodeKey,
          row.provider_binding_id,
          source.sourceEvidenceId
        ) ?? null;
      } catch {
        commandTemplate = null;
      }
    }
    return {
      commitObservation,
      source,
      ciReceipts: receipts,
      adoptionState: adoption
        ? "adopted"
        : blockerCodes.length === 0 ? "ready" : "blocked",
      blockerCodes,
      commandTemplate
    };
  }

  private integration(
    principal: WebPrincipal,
    plan: ReturnType<ExecutionPlanService["get"]>,
    node: ReturnType<ExecutionPlanService["get"]>["current"]["definition"]["nodes"][number],
    now: string
  ): IntegrationView {
    const target = plan.current.definition.policy.integrationTargets.find((entry) =>
      entry.repositoryId === node.repository.repositoryId) ?? null;
    const required = plan.current.definition.policy.integration === "local_integration" &&
      plan.current.definition.edges.some((edge) =>
        edge.fromNodeKey === node.nodeKey && edge.gate === "integrated_commit");
    if (!required) return {
      state: "not_required", target, approval: null, receipt: null,
      blockerCode: null, commandTemplate: null
    };
    const approvalRow = this.database.prepare(`
      SELECT approval.approval_json, approval.approval_digest,
        approval.approved_at, approval.approved_by_member_id,
        operation.operation_id AS integration_operation_id
      FROM execution_integration_approvals approval
      JOIN repository_integration_operations operation
        ON operation.approval_operation_id = approval.approval_operation_id
      WHERE approval.plan_id = ? AND approval.plan_revision = ?
        AND approval.node_key = ?
    `).get(plan.planId, plan.current.revision, node.nodeKey) as
      ApprovalRow | undefined;
    if (approvalRow) {
      const command = JSON.parse(approvalRow.approval_json) as
        Omit<NonNullable<IntegrationView["approval"]>,
          "approvalDigest" | "approvedAt" | "approvedByMemberId" |
          "integrationOperationId">;
      const approval = {
        ...command,
        approvalDigest: approvalRow.approval_digest,
        approvedAt: approvalRow.approved_at,
        approvedByMemberId: approvalRow.approved_by_member_id,
        integrationOperationId: approvalRow.integration_operation_id
      } as NonNullable<IntegrationView["approval"]>;
      const receiptRow = this.database.prepare(`
        SELECT receipt_json, receipt_digest, recorded_at
        FROM integration_receipts WHERE operation_id = ?
      `).get(approvalRow.integration_operation_id) as ReceiptRow | undefined;
      if (!receiptRow) return {
        state: "pending", target, approval, receipt: null,
        blockerCode: null, commandTemplate: null
      };
      const receipt = JSON.parse(receiptRow.receipt_json) as
        RepositoryOperationReceipt;
      const state = receipt.state === "succeeded" ? "succeeded"
        : receipt.state === "outcome_unknown" ? "outcome_unknown"
        : receipt.state === "canceled" ? "canceled"
        : receipt.errorCode === "INTEGRATION_TARGET_MOVED" ? "conflict"
        : "failed";
      return {
        state,
        target,
        approval,
        receipt: {
          receipt,
          receiptDigest: receiptRow.receipt_digest,
          recordedAt: receiptRow.recorded_at
        },
        blockerCode: receipt.errorCode,
        commandTemplate: null
      };
    }
    const identity = {
      planId: plan.planId,
      planRevision: plan.current.revision,
      nodeKey: node.nodeKey
    };
    const localVerified = this.materializations.get(identity, "verified_output");
    if (!localVerified) return {
      state: "waiting_for_verified_output", target, approval: null, receipt: null,
      blockerCode: this.materializations.getAdopted(identity, "verified_output")
        ? "INTEGRATION_LOCAL_CANDIDATE_REQUIRED" : null,
      commandTemplate: null
    };
    let commandTemplate = null;
    try {
      commandTemplate = this.integrations.approvalTemplate(
        principal,
        plan.planId,
        node.nodeKey,
        now
      ) ?? null;
    } catch {
      commandTemplate = null;
    }
    return {
      state: commandTemplate ? "approval_ready" : "waiting_for_verified_output",
      target,
      approval: null,
      receipt: null,
      blockerCode: commandTemplate ? null : "INTEGRATION_GRANT_UNAVAILABLE",
      commandTemplate
    };
  }

  private nextAction(
    runtimeState: string | undefined,
    stages: EvidenceStage[],
    verifications: EvidenceNode["verifications"],
    remote: EvidenceNode["remote"],
    integration: IntegrationView
  ): EvidenceNode["nextAction"] {
    if (remote?.adoptionState === "blocked" &&
      remote.blockerCodes.includes("REMOTE_INPUT_ATTESTATION_REQUIRED")) {
      return { kind: "none", actorKind: "none",
        reasonCode: "REMOTE_INPUT_ATTESTATION_REQUIRED" };
    }
    if (remote?.adoptionState === "ready") return {
      kind: "adopt_remote_evidence", actorKind: "team_owner",
      reasonCode: "REMOTE_ADOPTION_READY"
    };
    if (integration.state === "approval_ready") return {
      kind: "approve_integration", actorKind: "task_owner",
      reasonCode: "INTEGRATION_APPROVAL_READY"
    };
    if (integration.state === "pending") return {
      kind: "wait_for_integration", actorKind: "bridge",
      reasonCode: "INTEGRATION_PENDING"
    };
    if (integration.state === "conflict") return {
      kind: "resolve_target_conflict", actorKind: "task_owner",
      reasonCode: "INTEGRATION_TARGET_CONFLICT"
    };
    if (integration.state === "outcome_unknown") return {
      kind: "investigate_outcome_unknown", actorKind: "task_owner",
      reasonCode: "INTEGRATION_OUTCOME_UNKNOWN"
    };
    if (verifications.some((entry) => entry.kind === "local_verification" &&
      entry.receipt.outcome !== "passed") ||
      verifications.some((entry) => entry.kind === "remote_ci" &&
        entry.receipt.outcome !== "passed")) return {
      kind: "inspect_verification", actorKind: "task_owner",
      reasonCode: "VERIFICATION_FAILED"
    };
    if (runtimeState === "failed" || runtimeState === "canceled" ||
      runtimeState === "outcome_unknown") return {
      kind: "retry_node", actorKind: "task_owner",
      reasonCode: "NODE_RETRY_AVAILABLE"
    };
    if (!stages.some((stage) => stage.gate === "accepted_result" ||
      stage.gate === "verified_output")) return {
      kind: "produce_candidate", actorKind: "agent",
      reasonCode: "CANDIDATE_MISSING"
    };
    if (!stages.some((stage) => stage.gate === "verified_output")) return {
      kind: "wait_for_verification", actorKind: "bridge",
      reasonCode: "VERIFICATION_PENDING"
    };
    return { kind: "none", actorKind: "none", reasonCode: "NO_ACTION" };
  }
}
