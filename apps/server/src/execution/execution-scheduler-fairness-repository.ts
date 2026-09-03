import type Database from "better-sqlite3";
import { ExecutionError } from "./execution-error.js";

export type ExecutionSchedulerFairnessSource =
  | "automatic"
  | "manual"
  | "member_message"
  | "node_retry"
  | "supervised";

export interface ExecutionSchedulerFairnessCursor {
  agentId: string;
  cursorRevision: number;
  lastDispatchIntentId: string;
  lastNodeKey: string;
  lastPlanId: string;
  lastPlanRevision: number;
  lastRunId: string;
  updatedAt: string;
}

interface CursorRow {
  agent_id: string;
  cursor_revision: number;
  last_dispatch_intent_id: string;
  last_node_key: string;
  last_plan_id: string;
  last_plan_revision: number;
  last_run_id: string;
  updated_at: string;
}

const mapCursor = (row: CursorRow): ExecutionSchedulerFairnessCursor => ({
  agentId: row.agent_id,
  cursorRevision: row.cursor_revision,
  lastPlanId: row.last_plan_id,
  lastPlanRevision: row.last_plan_revision,
  lastNodeKey: row.last_node_key,
  lastDispatchIntentId: row.last_dispatch_intent_id,
  lastRunId: row.last_run_id,
  updatedAt: row.updated_at
});

export class ExecutionSchedulerFairnessRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(agentId: string): ExecutionSchedulerFairnessCursor | undefined {
    const row = this.database.prepare(`
      SELECT * FROM execution_scheduler_fairness_cursors WHERE agent_id = ?
    `).get(agentId) as CursorRow | undefined;
    return row && mapCursor(row);
  }

  public revision(agentId: string): number {
    return this.get(agentId)?.cursorRevision ?? 0;
  }

  public advance(input: {
    admittedAt: string;
    agentId: string;
    dispatchIntentId: string;
    expectedCursorRevision?: number;
    nodeKey: string;
    planId: string;
    planRevision: number;
    runId: string;
    schedulerOperationId: string | null;
    source: ExecutionSchedulerFairnessSource;
  }): ExecutionSchedulerFairnessCursor {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const previous = this.get(input.agentId);
    const previousRevision = previous?.cursorRevision ?? 0;
    if (input.expectedCursorRevision !== undefined &&
      input.expectedCursorRevision !== previousRevision) {
      throw new ExecutionError("EXECUTION_SCHEDULER_FAIRNESS_CONFLICT", 409);
    }
    const cursorRevision = previousRevision + 1;
    this.database.prepare(`
      INSERT INTO execution_scheduler_fairness_history (
        agent_id, cursor_revision,
        previous_plan_id, previous_plan_revision, previous_node_key,
        plan_id, plan_revision, node_key, source, scheduler_operation_id,
        dispatch_intent_id, run_id, admitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.agentId,
      cursorRevision,
      previous?.lastPlanId ?? null,
      previous?.lastPlanRevision ?? null,
      previous?.lastNodeKey ?? null,
      input.planId,
      input.planRevision,
      input.nodeKey,
      input.source,
      input.schedulerOperationId,
      input.dispatchIntentId,
      input.runId,
      input.admittedAt
    );
    if (previous) {
      const changed = this.database.prepare(`
        UPDATE execution_scheduler_fairness_cursors SET
          cursor_revision = ?, last_plan_id = ?, last_plan_revision = ?,
          last_node_key = ?, last_dispatch_intent_id = ?, last_run_id = ?,
          updated_at = ?
        WHERE agent_id = ? AND cursor_revision = ?
      `).run(
        cursorRevision,
        input.planId,
        input.planRevision,
        input.nodeKey,
        input.dispatchIntentId,
        input.runId,
        input.admittedAt,
        input.agentId,
        previousRevision
      );
      if (changed.changes !== 1) {
        throw new ExecutionError("EXECUTION_SCHEDULER_FAIRNESS_CONFLICT", 409);
      }
    } else {
      this.database.prepare(`
        INSERT INTO execution_scheduler_fairness_cursors (
          agent_id, cursor_revision, last_plan_id, last_plan_revision,
          last_node_key, last_dispatch_intent_id, last_run_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.agentId,
        cursorRevision,
        input.planId,
        input.planRevision,
        input.nodeKey,
        input.dispatchIntentId,
        input.runId,
        input.admittedAt
      );
    }
    return this.get(input.agentId)!;
  }
}
