import type Database from "better-sqlite3";
import { validateExecutionPlanDefinition } from
  "@convene-wire/contracts/execution-validation";
import type { RunState } from "../run/run-repository.js";
import type { ExecutionReadinessBlocker } from
  "./execution-readiness-evaluator.js";
import type { ExecutionSchedulerMode } from
  "./execution-scheduler-control-repository.js";

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

export interface ExecutionSchedulerCandidate extends ExecutionNodeIdentity {
  agentId: string;
  planApprovedAt: string;
  schedulerMode: ExecutionSchedulerMode;
  schedulerModeRevision: number;
  topologicalOrdinal: number;
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

  public listCandidates(options: {
    mode?: ExecutionSchedulerMode;
    planId?: string;
  } = {}): ExecutionSchedulerCandidate[] {
    const rows = this.database.prepare(`
      SELECT state.plan_id, state.plan_revision, state.node_key,
        approval.reviewed_at, proposal.definition_json, node.agent_id,
        control.mode AS scheduler_mode,
        control.mode_revision AS scheduler_mode_revision
      FROM execution_node_states state
      JOIN execution_plans plan ON plan.plan_id = state.plan_id
        AND plan.current_revision = state.plan_revision
      JOIN execution_plan_nodes node ON node.plan_id = state.plan_id
        AND node.revision = state.plan_revision
        AND node.node_key = state.node_key
      JOIN execution_plan_approvals approval
        ON approval.plan_id = state.plan_id
        AND approval.revision = state.plan_revision
        AND approval.decision = 'approved'
      JOIN execution_plan_proposals proposal
        ON proposal.plan_id = state.plan_id
        AND proposal.revision = state.plan_revision
      JOIN execution_scheduler_controls control
        ON control.plan_id = state.plan_id
      WHERE plan.state IN ('approved', 'running')
        AND state.run_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM execution_all_adopted_node_materializations adopted
          WHERE adopted.plan_id = state.plan_id
            AND adopted.plan_revision = state.plan_revision
            AND adopted.node_key = state.node_key
        )
        AND (@mode IS NULL OR control.mode = @mode)
        AND (@planId IS NULL OR state.plan_id = @planId)
    `).all({
      mode: options.mode ?? null,
      planId: options.planId ?? null
    }) as Array<{
      agent_id: string;
      definition_json: string;
      node_key: string;
      plan_id: string;
      plan_revision: number;
      reviewed_at: string;
      scheduler_mode: ExecutionSchedulerMode;
      scheduler_mode_revision: number;
    }>;
    const topologies = new Map<string, string[]>();
    return rows.map((row) => {
      const key = `${row.plan_id}\0${row.plan_revision}`;
      let topology = topologies.get(key);
      if (!topology) {
        topology = validateExecutionPlanDefinition(
          JSON.parse(row.definition_json)
        ).topologicalOrder;
        topologies.set(key, topology);
      }
      const ordinal = topology.indexOf(row.node_key);
      if (ordinal < 0) {
        throw new Error("Execution scheduler candidate is outside topology");
      }
      return {
        planId: row.plan_id,
        planRevision: row.plan_revision,
        nodeKey: row.node_key,
        agentId: row.agent_id,
        planApprovedAt: row.reviewed_at,
        schedulerMode: row.scheduler_mode,
        schedulerModeRevision: row.scheduler_mode_revision,
        topologicalOrdinal: ordinal
      };
    }).sort(compareExecutionSchedulerCandidates);
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

const binary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export function compareExecutionSchedulerCandidates(
  left: ExecutionSchedulerCandidate,
  right: ExecutionSchedulerCandidate
): number {
  return binary(left.planApprovedAt, right.planApprovedAt) ||
    binary(left.planId, right.planId) ||
    left.topologicalOrdinal - right.topologicalOrdinal ||
    binary(left.nodeKey, right.nodeKey);
}
