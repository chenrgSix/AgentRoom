import type Database from "better-sqlite3";
import type {
  ExecutionSchedulerControl,
  ExecutionSchedulerDispatchReceipt,
  ExecutionSchedulerModeReceipt
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON
} from "@convene-wire/contracts/execution-validation";
import { ExecutionError } from "./execution-error.js";

export type ExecutionSchedulerMode = ExecutionSchedulerControl["mode"];
export type ExecutionSchedulerReceipt =
  | ExecutionSchedulerDispatchReceipt
  | ExecutionSchedulerModeReceipt;

interface ControlRow {
  last_operation_id: string | null;
  mode: ExecutionSchedulerMode;
  mode_revision: number;
  plan_id: string;
  reason: string;
  updated_at: string;
  updated_by_member_id: string | null;
}

interface OperationRow {
  request_digest: string;
}

const mapControl = (row: ControlRow): ExecutionSchedulerControl => ({
  planId: row.plan_id,
  mode: row.mode,
  modeRevision: row.mode_revision,
  lastOperationId: row.last_operation_id,
  updatedByMemberId: row.updated_by_member_id,
  reason: row.reason,
  updatedAt: row.updated_at
});

export class ExecutionSchedulerControlRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(planId: string): ExecutionSchedulerControl | undefined {
    const row = this.database.prepare(`
      SELECT * FROM execution_scheduler_controls WHERE plan_id = ?
    `).get(planId) as ControlRow | undefined;
    return row && mapControl(row);
  }

  public require(
    planId: string,
    mode: ExecutionSchedulerMode,
    modeRevision: number
  ): ExecutionSchedulerControl {
    const control = this.get(planId);
    if (!control || control.mode !== mode ||
      control.modeRevision !== modeRevision) {
      throw new ExecutionError("EXECUTION_SCHEDULER_MODE_CONFLICT", 409);
    }
    return control;
  }

  public replay(
    operationId: string,
    requestDigest: string
  ): ExecutionSchedulerReceipt | undefined {
    const operation = this.database.prepare(`
      SELECT request_digest FROM execution_scheduler_operations
      WHERE operation_id = ?
    `).get(operationId) as OperationRow | undefined;
    if (!operation) return undefined;
    if (operation.request_digest !== requestDigest) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    const receipt = this.database.prepare(`
      SELECT response_json FROM execution_scheduler_receipts
      WHERE operation_id = ?
    `).get(operationId) as { response_json: string } | undefined;
    if (!receipt) {
      throw new ExecutionError("EXECUTION_SCHEDULER_HISTORY_INCONSISTENT");
    }
    const value = JSON.parse(receipt.response_json) as ExecutionSchedulerReceipt;
    assertExecutionCommand(
      "previousMode" in value ? "schedulerModeReceipt" :
        "schedulerDispatchReceipt",
      value
    );
    return value;
  }

  public begin(input: {
    action: "manual_dispatch" | "mode_transition" | "supervised_advance";
    createdAt: string;
    expectedMode: ExecutionSchedulerMode;
    expectedModeRevision: number;
    expectedNodeProjectionRevision: number | null;
    nodeKey: string | null;
    operationId: string;
    planControlRevision: number;
    planDigest: string;
    planId: string;
    planRevision: number;
    reason: string;
    request: unknown;
    requestDigest: string;
    requestedByMemberId: string;
    targetMode: ExecutionSchedulerMode | null;
  }): void {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    this.database.prepare(`
      INSERT INTO execution_scheduler_operations (
        operation_id, action, plan_id, plan_revision, plan_digest,
        plan_control_revision, expected_mode, expected_mode_revision,
        target_mode, node_key, expected_node_projection_revision,
        requested_by_member_id, reason, request_digest, request_json, created_at
      ) VALUES (
        @operationId, @action, @planId, @planRevision, @planDigest,
        @planControlRevision, @expectedMode, @expectedModeRevision,
        @targetMode, @nodeKey, @expectedNodeProjectionRevision,
        @requestedByMemberId, @reason, @requestDigest, @requestJson, @createdAt
      )
    `).run({ ...input, requestJson: canonicalExecutionJSON(input.request) });
  }

  public transition(input: {
    expectedMode: ExecutionSchedulerMode;
    expectedModeRevision: number;
    memberId: string;
    mode: ExecutionSchedulerMode;
    now: string;
    operationId: string;
    planId: string;
    reason: string;
  }): ExecutionSchedulerControl {
    const changed = this.database.prepare(`
      UPDATE execution_scheduler_controls SET
        mode = @mode,
        mode_revision = mode_revision + 1,
        last_operation_id = @operationId,
        updated_by_member_id = @memberId,
        reason = @reason,
        updated_at = @now
      WHERE plan_id = @planId
        AND mode = @expectedMode
        AND mode_revision = @expectedModeRevision
    `).run(input);
    if (changed.changes !== 1) {
      throw new ExecutionError("EXECUTION_SCHEDULER_MODE_CONFLICT", 409);
    }
    return this.get(input.planId)!;
  }

  public complete(receipt: ExecutionSchedulerReceipt): void {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const kind = "previousMode" in receipt
      ? "schedulerModeReceipt"
      : "schedulerDispatchReceipt";
    assertExecutionCommand(kind, receipt);
    this.database.prepare(`
      INSERT INTO execution_scheduler_receipts (
        operation_id, operation_digest, response_json, completed_at
      ) VALUES (?, ?, ?, ?)
    `).run(
      receipt.operationId,
      receipt.operationDigest,
      canonicalExecutionJSON(receipt),
      "updatedAt" in receipt ? receipt.updatedAt : receipt.createdAt
    );
  }

  public dispatchIntent(runId: string): string {
    const row = this.database.prepare(`
      SELECT intent_id FROM execution_dispatch_intents WHERE run_id = ?
    `).get(runId) as { intent_id: string } | undefined;
    if (!row) {
      throw new ExecutionError("EXECUTION_SCHEDULER_HISTORY_INCONSISTENT");
    }
    return row.intent_id;
  }
}
