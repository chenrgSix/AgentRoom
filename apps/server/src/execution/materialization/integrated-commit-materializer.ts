import type Database from "better-sqlite3";
import type {
  RepositoryOperationReceipt,
  RepositoryOperationRequest
} from "@convene-wire/contracts/execution-plan";
import { assertExecutionCommand, canonicalExecutionJSON } from
  "@convene-wire/contracts/execution-validation";

import type {
  ExecutionNodeMaterializationRepository,
  IntegratedExecutionNodeMaterialization,
  VerifiedExecutionNodeMaterialization
} from "../execution-node-materialization-repository.js";
import type { ExecutionNodeIdentity } from
  "../execution-node-state-repository.js";

interface IntegratedSourceRow {
  approval_digest: string;
  approval_json: string;
  operation_id: string;
  receipt_digest: string;
  receipt_json: string;
  recorded_at: string;
  request_json: string;
  verified_materialization_digest: string;
}

export class IntegratedCommitMaterializer {
  public constructor(
    private readonly database: Database.Database,
    private readonly materializations: ExecutionNodeMaterializationRepository
  ) {}

  public reconcile(
    identity: ExecutionNodeIdentity
  ): IntegratedExecutionNodeMaterialization | undefined {
    const retained = this.materializations.get(identity, "integrated_commit") as
      IntegratedExecutionNodeMaterialization | undefined;
    if (retained) return retained;
    const sources = this.database.prepare(`
      SELECT receipt.operation_id, receipt.receipt_digest,
        receipt.receipt_json, receipt.recorded_at,
        operation.request_json, approval.approval_json,
        approval.approval_digest,
        approval.materialization_digest AS verified_materialization_digest
      FROM execution_integration_approvals approval
      JOIN repository_integration_operations operation
        ON operation.approval_operation_id = approval.approval_operation_id
      JOIN integration_receipts receipt
        ON receipt.operation_id = operation.operation_id
        AND receipt.state = 'succeeded'
      WHERE approval.plan_id = ? AND approval.plan_revision = ?
        AND approval.node_key = ?
      ORDER BY receipt.operation_id
    `).all(
      identity.planId,
      identity.planRevision,
      identity.nodeKey
    ) as IntegratedSourceRow[];
    if (sources.length === 0) return undefined;
    if (sources.length !== 1) {
      throw new Error("Execution node has ambiguous integration evidence");
    }
    const source = sources[0]!;
    const receipt = JSON.parse(source.receipt_json) as
      RepositoryOperationReceipt;
    const operation = JSON.parse(source.request_json) as
      RepositoryOperationRequest;
    assertExecutionCommand("repositoryReceipt", receipt);
    assertExecutionCommand("repositoryOperation", operation);
    const action = operation.action.integrate;
    const approval = JSON.parse(source.approval_json) as {
      materializationDigest: string;
      verificationReceipts: { receiptDigest: string; verificationId: string }[];
    };
    const verified = this.materializations.get(identity, "verified_output") as
      VerifiedExecutionNodeMaterialization | undefined;
    if (!action || !verified ||
      verified.materializationDigest !== source.verified_materialization_digest ||
      approval.materializationDigest !== verified.materializationDigest ||
      receipt.operationId !== operation.operationId ||
      receipt.requestDigest !== operation.requestDigest ||
      receipt.kind !== "integrate" || receipt.state !== "succeeded" ||
      receipt.errorCode !== null ||
      receipt.repositoryId !== operation.repositoryId ||
      receipt.bindingId !== operation.bindingId ||
      receipt.deviceId !== operation.deviceId ||
      receipt.observedGeneration !== operation.expectedGeneration ||
      receipt.checkpointId !== verified.checkpointId ||
      receipt.candidateCommit !== verified.candidateCommit ||
      receipt.candidateTree !== verified.candidateTree ||
      action.candidateCommit !== verified.candidateCommit ||
      action.candidateTree !== verified.candidateTree ||
      action.inputDigest !== verified.inputDigest ||
      canonicalExecutionJSON(receipt.target) !== canonicalExecutionJSON(action.target) ||
      approval.verificationReceipts.length !==
        verified.verificationReceipts.length ||
      approval.verificationReceipts.some((pin, index) => {
        const verifiedPin = verified.verificationReceipts[index];
        return !verifiedPin || pin.verificationId !== verifiedPin.verificationId ||
          pin.receiptDigest !== verifiedPin.receiptDigest;
      })) return undefined;
    return this.materializations.retainIntegrated({
      ...identity,
      gate: "integrated_commit",
      dispatchGeneration: verified.dispatchGeneration,
      sourceRunId: verified.sourceRunId,
      sourceResultId: verified.sourceResultId,
      sourceResultVersion: verified.sourceResultVersion,
      gateOperationId: operation.operationId,
      checkpointId: verified.checkpointId,
      repositoryId: operation.repositoryId,
      bindingId: operation.bindingId,
      candidateCommit: verified.candidateCommit,
      candidateTree: verified.candidateTree,
      inputDigest: verified.inputDigest,
      target: { ...action.target },
      verifiedMaterializationDigest: verified.materializationDigest,
      verificationReceipts: verified.verificationReceipts,
      integrationApprovalDigest: source.approval_digest,
      integrationReceiptDigest: source.receipt_digest,
      artifactPins: verified.artifactPins,
      createdAt: source.recorded_at
    });
  }
}
