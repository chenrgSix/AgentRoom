import type Database from "better-sqlite3";
import type { RunState } from "../run/run-repository.js";
import type { ExecutionReadinessBlocker } from
  "./execution-readiness-evaluator.js";

export type ExecutionNodeStateValue =
  | "blocked"
  | "ready"
  | "dispatched"
  | "working"
  | "awaiting_result"
  | "failed"
  | "canceled"
  | "outcome_unknown";

export interface ExecutionNodeIdentity {
  nodeKey: string;
  planId: string;
  planRevision: number;
}

export interface ExecutionNodeState extends ExecutionNodeIdentity {
  blockerCode: ExecutionReadinessBlocker | string | null;
  dispatchGeneration: number | null;
  lastRunState: RunState | null;
  projectionRevision: number;
  runId: string | null;
  state: ExecutionNodeStateValue;
  updatedAt: string;
}

interface NodeStateRow {
  blocker_code: string | null;
  dispatch_generation: number | null;
  last_run_state: RunState | null;
  node_key: string;
  plan_id: string;
  plan_revision: number;
  projection_revision: number;
  run_id: string | null;
  state: ExecutionNodeStateValue;
  updated_at: string;
}

function map(row: NodeStateRow): ExecutionNodeState {
  return {
    planId: row.plan_id,
    planRevision: row.plan_revision,
    nodeKey: row.node_key,
    state: row.state,
    blockerCode: row.blocker_code,
    dispatchGeneration: row.dispatch_generation,
    runId: row.run_id,
    lastRunState: row.last_run_state,
    projectionRevision: row.projection_revision,
    updatedAt: row.updated_at
  };
}

export class ExecutionNodeStateRepository {
  public constructor(private readonly database: Database.Database) {}

  public ensureCurrent(now: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO execution_node_states (
        plan_id, plan_revision, node_key, state, blocker_code,
        dispatch_generation, run_id, last_run_state,
        projection_revision, updated_at
      )
      SELECT plan.plan_id, plan.current_revision, node.node_key,
        'blocked', 'EXECUTION_RECOVERY_PENDING', NULL, NULL, NULL, 1, ?
      FROM execution_plans plan
      JOIN execution_plan_nodes node ON node.plan_id = plan.plan_id
        AND node.revision = plan.current_revision
      WHERE plan.state IN ('approved', 'running', 'paused', 'review')
    `).run(now);
  }

  public get(identity: ExecutionNodeIdentity): ExecutionNodeState | undefined {
    const row = this.database.prepare(`
      SELECT * FROM execution_node_states
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ?
    `).get(
      identity.planId,
      identity.planRevision,
      identity.nodeKey
    ) as NodeStateRow | undefined;
    return row && map(row);
  }

  public listCandidates(): ExecutionNodeIdentity[] {
    return (this.database.prepare(`
      SELECT state.plan_id, state.plan_revision, state.node_key
      FROM execution_node_states state
      JOIN execution_plans plan ON plan.plan_id = state.plan_id
        AND plan.current_revision = state.plan_revision
      WHERE plan.state IN ('approved', 'running')
        AND state.run_id IS NULL
      ORDER BY state.plan_id, state.node_key
    `).all() as Array<{
      node_key: string;
      plan_id: string;
      plan_revision: number;
    }>).map((row) => ({
      planId: row.plan_id,
      planRevision: row.plan_revision,
      nodeKey: row.node_key
    }));
  }

  public listAllCurrent(): ExecutionNodeIdentity[] {
    return (this.database.prepare(`
      SELECT state.plan_id, state.plan_revision, state.node_key
      FROM execution_node_states state
      JOIN execution_plans plan ON plan.plan_id = state.plan_id
        AND plan.current_revision = state.plan_revision
      WHERE plan.state IN ('approved', 'running', 'paused', 'review')
      ORDER BY state.plan_id, state.node_key
    `).all() as Array<{
      node_key: string;
      plan_id: string;
      plan_revision: number;
    }>).map((row) => ({
      planId: row.plan_id,
      planRevision: row.plan_revision,
      nodeKey: row.node_key
    }));
  }

  /** Internal persistence port used only by ExecutionNodeProjector. */
  public writeProjection(input: ExecutionNodeIdentity & {
    blockerCode: string | null;
    dispatchGeneration: number | null;
    lastRunState: RunState | null;
    runId: string | null;
    state: ExecutionNodeStateValue;
    updatedAt: string;
  }): ExecutionNodeState {
    this.database.prepare(`
      UPDATE execution_node_states SET
        state = @state,
        blocker_code = @blockerCode,
        dispatch_generation = @dispatchGeneration,
        run_id = @runId,
        last_run_state = @lastRunState,
        projection_revision = projection_revision + 1,
        updated_at = @updatedAt
      WHERE plan_id = @planId AND plan_revision = @planRevision
        AND node_key = @nodeKey
        AND NOT (
          state IS @state AND blocker_code IS @blockerCode AND
          dispatch_generation IS @dispatchGeneration AND run_id IS @runId AND
          last_run_state IS @lastRunState
        )
    `).run(input);
    const state = this.get(input);
    if (!state) throw new Error("Execution node state is unavailable");
    return state;
  }
}
