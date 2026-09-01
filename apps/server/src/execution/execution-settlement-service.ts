import type Database from "better-sqlite3";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type { RunState } from "../run/run-repository.js";
import {
  type ExecutionNodeIdentity,
  type ExecutionNodeState,
  type ExecutionNodeStateValue
} from "./execution-node-state-repository.js";
import type { ExecutionNodeProjector } from "./execution-node-projector.js";
import type { ExecutionMaterializationService } from
  "./materialization/execution-materialization-service.js";

interface SettlementRow {
  dispatch_generation: number | null;
  plan_state: string;
  run_id: string | null;
  run_state: RunState | null;
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
    private readonly materializations: ExecutionMaterializationService
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
    const proofs = this.materializations.reconcileOne(identity);
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
    if ((proofs.accepted || proofs.verified) && row.run_state === "completed") {
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

}
