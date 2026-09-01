import type Database from "better-sqlite3";
import type {
  ExecutionGrantSummary,
  GovernedExecutionManifest,
  RepositoryOperationReceipt,
  RepositoryOperationRequest
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";

import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type { BridgeConnectionRegistry } from
  "../bridge/bridge-connection-registry.js";
import { ExecutionError } from "../execution/execution-error.js";
import type {
  ExecutionNodeMaterializationRepository,
  VerifiedExecutionNodeMaterialization
} from "../execution/execution-node-materialization-repository.js";
import {
  AuthorizationError,
  type AuthService,
  type DevicePrincipal,
  type WebPrincipal
} from "../security/auth-service.js";

interface IntegrationTarget {
  expectedCommit: string;
  repositoryId: string;
  targetRef: string;
}

export interface IntegrationVerificationPin {
  receiptDigest: string;
  verificationId: string;
}

export interface IntegrationApprovalCommand {
  candidateCommit: string;
  candidateTree: string;
  deadline: string;
  inputDigest: string;
  materializationDigest: string;
  nodeKey: string;
  operationId: string;
  planId: string;
  planRevision: number;
  target: IntegrationTarget;
  verificationReceipts: IntegrationVerificationPin[];
}

export interface IntegrationApprovalRecord extends IntegrationApprovalCommand {
  approvalDigest: string;
  approvedAt: string;
  approvedByMemberId: string;
  integrationOperationId: string;
}

export interface IntegrationAdmission {
  admittedAt: string;
  approvalDigest: string;
  operation: RepositoryOperationRequest;
}

export interface RetainedIntegrationReceipt {
  receipt: RepositoryOperationReceipt;
  receiptDigest: string;
  recordedAt: string;
}

interface ApprovalRow {
  approval_digest: string;
  approval_json: string;
  approved_at: string;
  approved_by_member_id: string;
  approval_operation_id: string;
}

interface OperationRow {
  admitted_at: string;
  approval_operation_id: string;
  binding_id: string;
  deadline: string;
  device_id: string;
  operation_id: string;
  request_digest: string;
  request_json: string;
}

interface ReceiptRow {
  operation_id: string;
  receipt_digest: string;
  receipt_json: string;
  recorded_at: string;
}

interface CandidateContextRow {
  approval_operation_id: string;
  definition_json: string;
  grant_json: string;
  manifest_json: string;
  node_json: string;
  owner_member_id: string;
  plan_control_revision: number;
  plan_digest: string;
  plan_room_id: string;
  plan_root_task_id: string;
  plan_state: string;
}

const id = /^(?:op|plan)_[A-Za-z0-9_-]{8,128}$/u;
const stableKey = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const digest = /^[a-f0-9]{64}$/u;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const repositoryId = /^repo_[A-Za-z0-9_-]{8,128}$/u;
const targetRef = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,243}$/u;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const own = (value: object, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index]);
};
const equal = (left: unknown, right: unknown): boolean =>
  canonicalExecutionJSON(left) === canonicalExecutionJSON(right);
const fail = (code: string, status: 400 | 404 | 409 = 409): never => {
  throw new ExecutionError(code, status);
};

function approvalCommand(value: unknown): IntegrationApprovalCommand {
  if (!value || typeof value !== "object" || Array.isArray(value) || !own(value, [
    "candidateCommit", "candidateTree", "deadline", "inputDigest",
    "materializationDigest", "nodeKey", "operationId", "planId",
    "planRevision", "target", "verificationReceipts"
  ])) return fail("INTEGRATION_APPROVAL_INVALID", 400);
  const command = value as IntegrationApprovalCommand;
  if (
    !id.test(command.operationId) || !command.operationId.startsWith("op_") ||
    !id.test(command.planId) || !command.planId.startsWith("plan_") ||
    !Number.isSafeInteger(command.planRevision) || command.planRevision < 1 ||
    !stableKey.test(command.nodeKey) || !digest.test(command.materializationDigest) ||
    !objectId.test(command.candidateCommit) ||
    !objectId.test(command.candidateTree) || !digest.test(command.inputDigest) ||
    !utc.test(command.deadline) || !Number.isFinite(Date.parse(command.deadline)) ||
    !command.target || typeof command.target !== "object" ||
    !own(command.target, ["expectedCommit", "repositoryId", "targetRef"]) ||
    !repositoryId.test(command.target.repositoryId) ||
    !targetRef.test(command.target.targetRef) ||
    !objectId.test(command.target.expectedCommit) ||
    !Array.isArray(command.verificationReceipts) ||
    command.verificationReceipts.length < 1 || command.verificationReceipts.length > 16
  ) return fail("INTEGRATION_APPROVAL_INVALID", 400);
  const pins = command.verificationReceipts.map((pin) => {
    if (!pin || typeof pin !== "object" ||
      !own(pin, ["receiptDigest", "verificationId"]) ||
      !/^verification_[A-Za-z0-9_-]{8,128}$/u.test(pin.verificationId) ||
      !digest.test(pin.receiptDigest)) {
      return fail("INTEGRATION_APPROVAL_INVALID", 400);
    }
    return { ...pin };
  });
  pins.sort((left, right) => left.verificationId.localeCompare(right.verificationId));
  if (pins.some((pin, index) => index > 0 &&
    pin.verificationId === pins[index - 1]!.verificationId)) {
    return fail("INTEGRATION_APPROVAL_INVALID", 400);
  }
  return { ...command, target: { ...command.target }, verificationReceipts: pins };
}

/** Central admission/receipt authority; it never imports objects or executes Git. */
export class RepositoryIntegrationService {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions: SqliteTransactionBoundary,
    private readonly auth: AuthService,
    private readonly materializations: ExecutionNodeMaterializationRepository,
    private readonly connections: BridgeConnectionRegistry
  ) {}

  public approve(
    principal: WebPrincipal,
    planId: string,
    value: unknown,
    now: string
  ): IntegrationApprovalRecord {
    const command = approvalCommand(value);
    if (command.planId !== planId) return fail("INTEGRATION_APPROVAL_SCOPE_CONFLICT");
    return this.transactions.immediate(() => {
      const previous = this.approval(command.operationId);
      if (previous) {
        if (!equal(JSON.parse(previous.approval_json), command)) {
          return fail("INTEGRATION_APPROVAL_OPERATION_CONFLICT");
        }
        return this.mapApproval(previous);
      }
      const context = this.candidateContext(command);
      const member = this.auth.requireRoomMember(principal, context.plan_room_id);
      if (member.memberId !== context.owner_member_id && member.role !== "owner") {
        throw new AuthorizationError(
          "FORBIDDEN",
          "Task Owner or Team Owner integration approval required"
        );
      }
      const materialization = this.requireMaterialization(command);
      const manifest = JSON.parse(context.manifest_json) as GovernedExecutionManifest;
      assertExecutionCommand("executionManifest", manifest);
      const runtimeGrant = JSON.parse(context.grant_json) as ExecutionGrantSummary;
      assertExecutionCommand("executionGrant", runtimeGrant);
      const definition = JSON.parse(context.definition_json) as {
        policy: {
          integration: string;
          integrationTargets: IntegrationTarget[];
          requireHumanIntegrationApproval: boolean;
        };
      };
      const expectedPins = materialization.verificationReceipts.map((pin) => ({
        verificationId: pin.verificationId,
        receiptDigest: pin.receiptDigest
      })).sort((left, right) => left.verificationId.localeCompare(right.verificationId));
      const hasIntegratedEdge = this.database.prepare(`
        SELECT 1 FROM execution_plan_edges
        WHERE plan_id = ? AND revision = ? AND from_node_key = ?
          AND gate = 'integrated_commit'
      `).get(command.planId, command.planRevision, command.nodeKey);
      const integrationGrants = this.connections.governedAgentReadyGrants(
        manifest.scope.deviceId,
        manifest.scope.agentId
      ).filter((grant) =>
        grant.planId === command.planId &&
        grant.nodeKey === command.nodeKey &&
        grant.repositoryId === command.target.repositoryId &&
        grant.bindingId === manifest.repository.bindingId &&
        grant.deviceId === manifest.scope.deviceId &&
        grant.agentId === manifest.scope.agentId &&
        grant.revokedAt === null &&
        grant.operations.length === 1 && grant.operations[0] === "integrate" &&
        grant.integrationTargets.length === 1 &&
        equal(grant.integrationTargets[0], command.target) &&
        Number.isFinite(Date.parse(grant.issuedAt)) &&
        Date.parse(grant.issuedAt) <= Date.parse(now) &&
        Date.parse(now) < Date.parse(grant.grant.expiresAt)
      );
      if (
        context.plan_state !== "approved" && context.plan_state !== "running" ||
        context.plan_digest !== manifest.scope.planDigest ||
        context.approval_operation_id !== manifest.scope.approvalOperationId ||
        context.plan_control_revision !== manifest.scope.planControlRevision ||
        definition.policy.integration !== "local_integration" ||
        !definition.policy.requireHumanIntegrationApproval || !hasIntegratedEdge ||
        !definition.policy.integrationTargets.some((target) => equal(target, command.target)) ||
        !manifest.grant || !manifest.repository ||
        !manifest.scope || manifest.scope.planId !== command.planId ||
        manifest.scope.planRevision !== command.planRevision ||
        manifest.scope.nodeKey !== command.nodeKey ||
        manifest.scope.runId !== materialization.sourceRunId ||
        manifest.repository.repositoryId !== command.target.repositoryId ||
        manifest.repository.bindingId === "" ||
        !equal(expectedPins, command.verificationReceipts) ||
        runtimeGrant.grant.digest !== manifest.grant.digest ||
        runtimeGrant.grant.grantId !== manifest.grant.grantId ||
        runtimeGrant.grant.revision !== manifest.grant.revision ||
        runtimeGrant.deviceId !== manifest.scope.deviceId ||
        integrationGrants.length !== 1
      ) return fail("INTEGRATION_APPROVAL_SCOPE_CONFLICT");
      const integrationGrant = integrationGrants[0]!;
      const nowMs = Date.parse(now);
      const deadlineMs = Date.parse(command.deadline);
      if (
        !utc.test(now) || !Number.isFinite(nowMs) || !Number.isFinite(deadlineMs) ||
        deadlineMs <= nowMs ||
        deadlineMs > Date.parse(integrationGrant.grant.expiresAt)
      ) return fail("INTEGRATION_APPROVAL_STALE");
      const approvalDigest = executionOperationDigest({
        command,
        approvedByMemberId: member.memberId,
        approvedAt: now
      });
      const operationId = `op_integration_${approvalDigest}`;
      const unsigned: Omit<RepositoryOperationRequest, "requestDigest"> = {
        version: 1,
        operationId,
        plan: {
          planId: command.planId,
          revision: command.planRevision,
          digest: context.plan_digest,
          approvalOperationId: context.approval_operation_id,
          roomId: context.plan_room_id,
          rootTaskId: context.plan_root_task_id
        },
        execution: manifest.scope,
        repositoryId: command.target.repositoryId,
        bindingId: manifest.repository.bindingId,
        deviceId: manifest.scope.deviceId,
        grant: integrationGrant.grant,
        expectedGeneration: manifest.workspace.workspaceGeneration,
        deadline: command.deadline,
        action: {
          kind: "integrate",
          integrate: {
            candidateCommit: command.candidateCommit,
            candidateTree: command.candidateTree,
            inputDigest: command.inputDigest,
            target: command.target,
            integrationApprovalOperationId: command.operationId,
            verificationIds: command.verificationReceipts.map((pin) =>
              pin.verificationId) as [string, ...string[]]
          }
        }
      };
      const operation: RepositoryOperationRequest = {
        ...unsigned,
        requestDigest: executionOperationDigest(unsigned)
      };
      assertExecutionCommand("repositoryOperation", operation);
      if (this.database.prepare(`
        SELECT 1 FROM repository_integration_locks
        WHERE repository_id = ? AND target_ref = ?
      `).get(command.target.repositoryId, command.target.targetRef)) {
        return fail("INTEGRATION_TARGET_BUSY");
      }
      this.database.prepare(`
        INSERT INTO execution_integration_approvals (
          approval_operation_id, plan_id, plan_revision, node_key,
          source_run_id, checkpoint_id, materialization_digest,
          repository_id, binding_id, device_id, target_ref,
          expected_target_commit, candidate_commit, candidate_tree,
          input_digest, verification_receipts_json, approved_by_member_id,
          approval_digest, approval_json, approved_at, deadline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        command.operationId, command.planId, command.planRevision,
        command.nodeKey, materialization.sourceRunId,
        materialization.checkpointId, command.materializationDigest,
        command.target.repositoryId, manifest.repository.bindingId,
        manifest.scope.deviceId, command.target.targetRef,
        command.target.expectedCommit, command.candidateCommit,
        command.candidateTree, command.inputDigest,
        canonicalExecutionJSON(command.verificationReceipts), member.memberId,
        approvalDigest, canonicalExecutionJSON(command), now, command.deadline
      );
      this.database.prepare(`
        INSERT INTO repository_integration_operations (
          operation_id, approval_operation_id, request_digest, request_json,
          repository_id, target_ref, expected_target_commit,
          candidate_commit, candidate_tree, source_run_id, binding_id,
          device_id, admitted_at, deadline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        operation.operationId, command.operationId, operation.requestDigest,
        canonicalExecutionJSON(operation), command.target.repositoryId,
        command.target.targetRef, command.target.expectedCommit,
        command.candidateCommit, command.candidateTree,
        materialization.sourceRunId, manifest.repository.bindingId,
        manifest.scope.deviceId, now, command.deadline
      );
      this.database.prepare(`
        INSERT INTO repository_integration_locks (
          repository_id, target_ref, operation_id, acquired_at
        ) VALUES (?, ?, ?, ?)
      `).run(
        command.target.repositoryId,
        command.target.targetRef,
        operation.operationId,
        now
      );
      return this.mapApproval(this.approval(command.operationId)!);
    });
  }

  public getForDevice(
    principal: DevicePrincipal,
    operationId: string
  ): IntegrationAdmission {
    const operation = this.operation(operationId);
    if (!operation) return fail("INTEGRATION_OPERATION_NOT_FOUND", 404);
    this.requireOwner(principal, operation);
    const approval = this.approval(operation.approval_operation_id);
    if (!approval) return fail("INTEGRATION_APPROVAL_NOT_FOUND", 404);
    return {
      operation: this.decodeOperation(operation),
      approvalDigest: approval.approval_digest,
      admittedAt: operation.admitted_at
    };
  }

  public retain(
    principal: DevicePrincipal,
    value: unknown,
    now: string
  ): RetainedIntegrationReceipt {
    assertExecutionCommand("repositoryReceipt", value);
    const receipt = value as RepositoryOperationReceipt;
    if (receipt.kind !== "integrate" || receipt.deviceId !== principal.deviceId) {
      throw new AuthorizationError("FORBIDDEN", "Integration receipt authority is invalid");
    }
    return this.transactions.immediate(() => {
      const operation = this.operation(receipt.operationId);
      if (!operation) return fail("INTEGRATION_OPERATION_NOT_FOUND", 404);
      this.requireOwner(principal, operation);
      const existing = this.receipt(receipt.operationId);
      const receiptDigest = executionOperationDigest(receipt);
      if (existing) {
        if (existing.receipt_digest !== receiptDigest ||
          !equal(JSON.parse(existing.receipt_json), receipt)) {
          return fail("INTEGRATION_RECEIPT_CONFLICT");
        }
        return this.mapReceipt(existing);
      }
      const request = this.decodeOperation(operation);
      this.matchReceipt(receipt, request, operation, now);
      this.database.prepare(`
        INSERT INTO integration_receipts (
          operation_id, receipt_digest, receipt_json, state, error_code,
          recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        receipt.operationId,
        receiptDigest,
        canonicalExecutionJSON(receipt),
        receipt.state,
        receipt.errorCode,
        now
      );
      this.database.prepare(`
        DELETE FROM repository_integration_locks WHERE operation_id = ?
      `).run(receipt.operationId);
      return this.mapReceipt(this.receipt(receipt.operationId)!);
    });
  }

  public receiptForDevice(
    principal: DevicePrincipal,
    operationId: string
  ): RetainedIntegrationReceipt {
    const operation = this.operation(operationId);
    if (!operation) return fail("INTEGRATION_OPERATION_NOT_FOUND", 404);
    this.requireOwner(principal, operation);
    const receipt = this.receipt(operationId);
    if (!receipt) return fail("INTEGRATION_RECEIPT_NOT_FOUND", 404);
    return this.mapReceipt(receipt);
  }

  private requireMaterialization(
    command: IntegrationApprovalCommand
  ): VerifiedExecutionNodeMaterialization {
    const materialization = this.materializations.get({
      planId: command.planId,
      planRevision: command.planRevision,
      nodeKey: command.nodeKey
    }, "verified_output") as VerifiedExecutionNodeMaterialization | undefined;
    if (!materialization ||
      materialization.materializationDigest !== command.materializationDigest ||
      materialization.candidateCommit !== command.candidateCommit ||
      materialization.candidateTree !== command.candidateTree ||
      materialization.inputDigest !== command.inputDigest) {
      return fail("INTEGRATION_VERIFIED_MATERIALIZATION_REQUIRED");
    }
    return materialization;
  }

  private candidateContext(command: IntegrationApprovalCommand): CandidateContextRow {
    const row = this.database.prepare(`
      SELECT plan.state AS plan_state, plan.control_revision AS plan_control_revision,
        plan.room_id AS plan_room_id, plan.root_task_id AS plan_root_task_id,
        proposal.definition_json, proposal.digest AS plan_digest,
        plan_approval.operation_id AS approval_operation_id,
        node.owner_member_id, node.node_json,
        json_extract(run.context_manifest_json, '$.execution') AS manifest_json,
        admission.grant_json
      FROM execution_plans plan
      JOIN execution_plan_proposals proposal
        ON proposal.plan_id = plan.plan_id
        AND proposal.revision = plan.current_revision
      JOIN execution_plan_approvals plan_approval
        ON plan_approval.plan_id = plan.plan_id
        AND plan_approval.revision = plan.current_revision
        AND plan_approval.decision = 'approved'
      JOIN execution_plan_nodes node
        ON node.plan_id = plan.plan_id AND node.revision = plan.current_revision
      JOIN execution_verified_node_materializations materialization
        ON materialization.plan_id = node.plan_id
        AND materialization.plan_revision = node.revision
        AND materialization.node_key = node.node_key
      JOIN runs run ON run.run_id = materialization.source_run_id
      JOIN execution_run_admissions admission ON admission.run_id = run.run_id
      WHERE plan.plan_id = ? AND plan.current_revision = ?
        AND node.node_key = ?
    `).get(command.planId, command.planRevision, command.nodeKey) as
      CandidateContextRow | undefined;
    if (!row || !row.manifest_json) {
      return fail("INTEGRATION_VERIFIED_MATERIALIZATION_REQUIRED", 404);
    }
    return row;
  }

  private matchReceipt(
    receipt: RepositoryOperationReceipt,
    request: RepositoryOperationRequest,
    operation: OperationRow,
    now: string
  ): void {
    const action = request.action.integrate!;
    const recorded = Date.parse(receipt.recordedAt);
    const retained = Date.parse(now);
    if (
      receipt.version !== request.version ||
      receipt.operationId !== request.operationId ||
      receipt.requestDigest !== request.requestDigest ||
      receipt.repositoryId !== request.repositoryId ||
      receipt.bindingId !== request.bindingId ||
      receipt.deviceId !== request.deviceId ||
      receipt.observedGeneration !== request.expectedGeneration ||
      receipt.checkpointId !== null || receipt.verificationId !== null ||
      receipt.providerObservationId !== null ||
      receipt.candidateCommit !== action.candidateCommit ||
      receipt.candidateTree !== action.candidateTree ||
      !equal(receipt.target, action.target) || receipt.state === "prepared" ||
      !Number.isFinite(recorded) || !Number.isFinite(retained) ||
      recorded < Date.parse(operation.admitted_at) || recorded > retained ||
      recorded > Date.parse(operation.deadline) ||
      (receipt.state === "succeeded" && receipt.errorCode !== null) ||
      (receipt.state !== "succeeded" && receipt.errorCode === null)
    ) return fail("INTEGRATION_RECEIPT_SCOPE_CONFLICT");
  }

  private requireOwner(principal: DevicePrincipal, row: OperationRow): void {
    if (row.device_id !== principal.deviceId || !this.database.prepare(`
      SELECT 1 FROM devices device
      JOIN room_human_participants human
        ON human.member_id = device.owner_member_id
      JOIN execution_integration_approvals approval
        ON approval.approval_operation_id = ?
      JOIN execution_plans plan ON plan.plan_id = approval.plan_id
        AND plan.room_id = human.room_id
      WHERE device.device_id = ? AND device.team_id = ?
        AND device.owner_member_id = ? AND device.status = 'active'
    `).get(
      row.approval_operation_id,
      principal.deviceId,
      principal.teamId,
      principal.ownerMemberId
    )) {
      throw new AuthorizationError("FORBIDDEN", "Repository integration access denied");
    }
  }

  private mapApproval(row: ApprovalRow): IntegrationApprovalRecord {
    const command = JSON.parse(row.approval_json) as IntegrationApprovalCommand;
    const operation = this.database.prepare(`
      SELECT operation_id FROM repository_integration_operations
      WHERE approval_operation_id = ?
    `).get(row.approval_operation_id) as { operation_id: string } | undefined;
    if (!operation) return fail("INTEGRATION_OPERATION_NOT_FOUND", 404);
    return {
      ...command,
      approvalDigest: row.approval_digest,
      approvedAt: row.approved_at,
      approvedByMemberId: row.approved_by_member_id,
      integrationOperationId: operation.operation_id
    };
  }

  private decodeOperation(row: OperationRow): RepositoryOperationRequest {
    const operation = JSON.parse(row.request_json) as RepositoryOperationRequest;
    assertExecutionCommand("repositoryOperation", operation);
    const { requestDigest, ...unsigned } = operation;
    if (requestDigest !== row.request_digest ||
      executionOperationDigest(unsigned) !== requestDigest ||
      operation.action.kind !== "integrate" || !operation.action.integrate) {
      return fail("INTEGRATION_OPERATION_CORRUPT");
    }
    return operation;
  }

  private mapReceipt(row: ReceiptRow): RetainedIntegrationReceipt {
    const receipt = JSON.parse(row.receipt_json) as RepositoryOperationReceipt;
    assertExecutionCommand("repositoryReceipt", receipt);
    if (executionOperationDigest(receipt) !== row.receipt_digest) {
      return fail("INTEGRATION_RECEIPT_CORRUPT");
    }
    return {
      receipt,
      receiptDigest: row.receipt_digest,
      recordedAt: row.recorded_at
    };
  }

  private approval(operationId: string): ApprovalRow | undefined {
    return this.database.prepare(`
      SELECT approval_operation_id, approval_digest, approval_json,
        approved_by_member_id, approved_at
      FROM execution_integration_approvals
      WHERE approval_operation_id = ?
    `).get(operationId) as ApprovalRow | undefined;
  }

  private operation(operationId: string): OperationRow | undefined {
    return this.database.prepare(`
      SELECT operation_id, approval_operation_id, request_digest, request_json,
        binding_id, device_id, admitted_at, deadline
      FROM repository_integration_operations WHERE operation_id = ?
    `).get(operationId) as OperationRow | undefined;
  }

  private receipt(operationId: string): ReceiptRow | undefined {
    return this.database.prepare(`
      SELECT operation_id, receipt_digest, receipt_json, recorded_at
      FROM integration_receipts WHERE operation_id = ?
    `).get(operationId) as ReceiptRow | undefined;
  }
}
