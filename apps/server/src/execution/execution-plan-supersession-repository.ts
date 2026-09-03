import type Database from "better-sqlite3";
import type {
  ExecutionPlanSupersessionActivationReceipt,
  ExecutionReplanDelegation,
  ExecutionReplanDelegationRevocation
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON
} from "@convene-wire/contracts/execution-validation";

import { ExecutionError } from "./execution-error.js";

interface JsonRow {
  request_digest?: string;
  response_json?: string;
  record_json?: string;
}

export class ExecutionPlanSupersessionRepository {
  public constructor(private readonly database: Database.Database) {}

  public replayActivation(
    operationId: string,
    requestDigest: string
  ): ExecutionPlanSupersessionActivationReceipt | undefined {
    const row = this.database.prepare(`
      SELECT activation.request_digest, receipt.response_json
      FROM execution_plan_supersession_activations activation
      LEFT JOIN execution_plan_supersession_receipts receipt
        ON receipt.operation_id = activation.operation_id
      WHERE activation.operation_id = ?
    `).get(operationId) as JsonRow | undefined;
    if (!row) {
      this.requireOperationScope(operationId, "activation");
      return undefined;
    }
    if (row.request_digest !== requestDigest || !row.response_json) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    const receipt = JSON.parse(row.response_json) as
      ExecutionPlanSupersessionActivationReceipt;
    assertExecutionCommand("supersessionActivationReceipt", receipt);
    return receipt;
  }

  public beginActivation(input: {
    operationId: string;
    planId: string;
    baseRevision: number;
    baseDigest: string;
    baseControlRevision: number;
    candidateId: string;
    candidateRevision: number;
    candidateDigest: string;
    rootTaskRevisionBefore: number;
    activatedBy: ExecutionPlanSupersessionActivationReceipt["activatedBy"];
    authorityMemberId: string;
    delegationId: string | null;
    reason: string;
    requestDigest: string;
    now: string;
  }): void {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    this.database.prepare(`
      INSERT INTO execution_plan_supersession_activations (
        operation_id, plan_id, base_revision, base_digest,
        base_control_revision, candidate_id, candidate_revision,
        candidate_digest, root_task_revision_before, activated_by_json,
        authority_member_id, delegation_id, reason, request_digest,
        activated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.operationId,
      input.planId,
      input.baseRevision,
      input.baseDigest,
      input.baseControlRevision,
      input.candidateId,
      input.candidateRevision,
      input.candidateDigest,
      input.rootTaskRevisionBefore,
      canonicalExecutionJSON(input.activatedBy),
      input.authorityMemberId,
      input.delegationId,
      input.reason,
      input.requestDigest,
      input.now
    );
  }

  public retainActivationReceipt(
    receipt: ExecutionPlanSupersessionActivationReceipt
  ): void {
    assertExecutionCommand("supersessionActivationReceipt", receipt);
    this.database.prepare(`
      INSERT INTO execution_plan_supersession_receipts (
        operation_id, operation_digest, response_json, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      receipt.operationId,
      receipt.operationDigest,
      canonicalExecutionJSON(receipt),
      receipt.activatedAt
    );
  }

  public getDelegation(
    delegationId: string
  ): ExecutionReplanDelegation | undefined {
    const row = this.database.prepare(`
      SELECT record_json FROM execution_replan_delegations
      WHERE delegation_id = ?
    `).get(delegationId) as JsonRow | undefined;
    if (!row?.record_json) return undefined;
    const record = JSON.parse(row.record_json) as ExecutionReplanDelegation;
    assertExecutionCommand("replanDelegationRecord", record);
    return record;
  }

  public listDelegations(planId: string): ExecutionReplanDelegation[] {
    return (this.database.prepare(`
      SELECT record_json FROM execution_replan_delegations
      WHERE plan_id = ? ORDER BY issued_at, delegation_id
    `).all(planId) as JsonRow[]).map((row) => {
      const record = JSON.parse(row.record_json!) as ExecutionReplanDelegation;
      assertExecutionCommand("replanDelegationRecord", record);
      return record;
    });
  }

  public nextDelegationRevision(planId: string, agentId: string): number {
    const row = this.database.prepare(`
      SELECT coalesce(max(revision), 0) + 1 AS revision
      FROM execution_replan_delegations
      WHERE plan_id = ? AND agent_id = ?
    `).get(planId, agentId) as { revision: number };
    return row.revision;
  }

  public isCurrentDelegation(record: ExecutionReplanDelegation): boolean {
    const row = this.database.prepare(`
      SELECT max(revision) AS revision
      FROM execution_replan_delegations
      WHERE plan_id = ? AND agent_id = ?
    `).get(record.planId, record.agentId) as { revision: number | null };
    return row.revision === record.revision;
  }

  public replayDelegation(
    operationId: string,
    requestDigest: string
  ): ExecutionReplanDelegation | undefined {
    this.requireOperationScope(operationId, "delegation");
    const row = this.database.prepare(`
      SELECT request_digest, record_json FROM execution_replan_delegations
      WHERE operation_id = ?
    `).get(operationId) as JsonRow | undefined;
    if (!row) return undefined;
    if (row.request_digest !== requestDigest || !row.record_json) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    const record = JSON.parse(row.record_json) as ExecutionReplanDelegation;
    assertExecutionCommand("replanDelegationRecord", record);
    return record;
  }

  public retainDelegation(
    record: ExecutionReplanDelegation,
    requestDigest: string
  ): ExecutionReplanDelegation {
    assertExecutionCommand("replanDelegationRecord", record);
    this.database.prepare(`
      INSERT INTO execution_replan_delegations (
        delegation_id, revision, operation_id, plan_id, plan_revision,
        plan_digest, plan_control_revision, root_task_revision,
        agent_id, issued_by_member_id,
        task_ids_json, expires_at, reason, delegation_digest, record_json,
        request_digest, issued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.delegationId,
      record.revision,
      record.operationId,
      record.planId,
      record.planRevision,
      record.planDigest,
      record.planControlRevision,
      record.rootTaskRevision,
      record.agentId,
      record.issuedByMemberId,
      canonicalExecutionJSON(record.taskIds),
      record.expiresAt,
      record.reason,
      record.delegationDigest,
      canonicalExecutionJSON(record),
      requestDigest,
      record.issuedAt
    );
    return this.getDelegation(record.delegationId)!;
  }

  public replayRevocation(
    operationId: string,
    requestDigest: string
  ): ExecutionReplanDelegationRevocation | undefined {
    this.requireOperationScope(operationId, "revocation");
    const row = this.database.prepare(`
      SELECT request_digest, record_json
      FROM execution_replan_delegation_revocations WHERE operation_id = ?
    `).get(operationId) as JsonRow | undefined;
    if (!row) return undefined;
    if (row.request_digest !== requestDigest || !row.record_json) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    const record = JSON.parse(row.record_json) as
      ExecutionReplanDelegationRevocation;
    assertExecutionCommand("replanDelegationRevocationRecord", record);
    return record;
  }

  public retainRevocation(
    record: ExecutionReplanDelegationRevocation,
    requestDigest: string
  ): ExecutionReplanDelegationRevocation {
    assertExecutionCommand("replanDelegationRevocationRecord", record);
    this.database.prepare(`
      INSERT INTO execution_replan_delegation_revocations (
        operation_id, delegation_id, delegation_revision, delegation_digest,
        revoked_by_member_id, reason, revocation_digest, record_json,
        request_digest, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.operationId,
      record.delegationId,
      record.delegationRevision,
      record.delegationDigest,
      record.revokedByMemberId,
      record.reason,
      record.revocationDigest,
      canonicalExecutionJSON(record),
      requestDigest,
      record.revokedAt
    );
    return record;
  }

  public isRevoked(delegationId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM execution_replan_delegation_revocations
      WHERE delegation_id = ?
    `).get(delegationId));
  }

  public isConsumed(delegationId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM execution_replan_delegation_consumptions
      WHERE delegation_id = ?
    `).get(delegationId));
  }

  public consume(
    delegationId: string,
    activationOperationId: string,
    now: string
  ): void {
    this.database.prepare(`
      INSERT INTO execution_replan_delegation_consumptions (
        delegation_id, activation_operation_id, consumed_at
      ) VALUES (?, ?, ?)
    `).run(delegationId, activationOperationId, now);
  }

  private requireOperationScope(
    operationId: string,
    expected: "activation" | "delegation" | "revocation"
  ): void {
    const groups: Record<typeof expected, string> = {
      activation: "execution_plan_supersession_activations",
      delegation: "execution_replan_delegations",
      revocation: "execution_replan_delegation_revocations"
    };
    const names = [
      "execution_plan_operations",
      "execution_plan_approvals",
      "execution_plan_supersession_candidates",
      "execution_plan_supersession_activations",
      "execution_replan_delegations",
      "execution_replan_delegation_revocations"
    ].filter((name) => name !== groups[expected]);
    const query = names.map((name) =>
      `SELECT 1 FROM ${name} WHERE operation_id = ?`).join(" UNION ALL ");
    if (this.database.prepare(`${query} LIMIT 1`).get(
      ...names.map(() => operationId)
    )) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
  }
}
