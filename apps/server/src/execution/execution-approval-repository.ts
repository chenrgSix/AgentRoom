import type Database from "better-sqlite3";
import type {
  ExecutionPlanApprovalCommand,
  ExecutionPlanApprovalPage,
  ExecutionPlanApprovalReceipt,
  ExecutionPlanApprovalRecord,
  ExecutionPlanProjection
} from "@convene-wire/contracts/execution-plan";
import { canonicalExecutionJSON } from "@convene-wire/contracts/execution-validation";
import type { AgentTaskRecord } from "../task/task-repository.js";
import { ExecutionError } from "./execution-error.js";

export interface CompiledExecutionNode {
  node: ExecutionPlanProjection["current"]["definition"]["nodes"][number];
  task: AgentTaskRecord;
}

interface ApprovalRow {
  operation_id: string; plan_id: string; revision: number; digest: string;
  decision: ExecutionPlanApprovalCommand["decision"]; reason: string;
  reviewed_by_member_id: string; root_task_revision_before: number;
  root_task_revision_after: number; compiled_tasks_json: string; reviewed_at: string;
}

function mapApproval(row: ApprovalRow): ExecutionPlanApprovalRecord {
  return {
    operationId: row.operation_id, planId: row.plan_id, revision: row.revision,
    digest: row.digest, decision: row.decision, reason: row.reason,
    reviewedByMemberId: row.reviewed_by_member_id,
    rootTaskRevisionBefore: row.root_task_revision_before,
    rootTaskRevisionAfter: row.root_task_revision_after,
    compiledTasks: JSON.parse(row.compiled_tasks_json), reviewedAt: row.reviewed_at
  };
}

export class ExecutionApprovalRepository {
  public constructor(private readonly database: Database.Database) {}

  public replay(operationId: string, requestDigest: string): ExecutionPlanApprovalReceipt | undefined {
    if (this.database.prepare("SELECT 1 FROM execution_plan_operations WHERE operation_id = ?").get(operationId)) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    const row = this.database.prepare(`
      SELECT request_digest, response_json FROM execution_plan_approvals WHERE operation_id = ?
    `).get(operationId) as { request_digest: string; response_json: string } | undefined;
    if (!row) return undefined;
    if (row.request_digest !== requestDigest) throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    return JSON.parse(row.response_json) as ExecutionPlanApprovalReceipt;
  }

  public get(planId: string, revision: number): ExecutionPlanApprovalRecord | undefined {
    const row = this.database.prepare("SELECT * FROM execution_plan_approvals WHERE plan_id = ? AND revision = ?")
      .get(planId, revision) as ApprovalRow | undefined;
    return row && mapApproval(row);
  }

  public history(planId: string, afterRevision: number, limit: number): ExecutionPlanApprovalPage {
    const rows = this.database.prepare(`
      SELECT * FROM execution_plan_approvals WHERE plan_id = ? AND revision > ? ORDER BY revision LIMIT ?
    `).all(planId, afterRevision, limit + 1) as ApprovalRow[];
    const page = rows.slice(0, limit);
    return { approvals: page.map(mapApproval), nextAfterRevision: rows.length > limit ? page.at(-1)!.revision : null };
  }

  public requireRootAvailable(plan: ExecutionPlanProjection): void {
    if (this.database.prepare(`
      SELECT 1 FROM execution_plans WHERE root_task_id = ? AND plan_id <> ?
        AND state IN ('approved', 'running', 'paused', 'review')
    `).get(plan.rootTaskId, plan.planId) || this.database.prepare(
      "SELECT 1 FROM execution_plan_task_claims WHERE task_id = ?"
    ).get(plan.rootTaskId)) {
      throw new ExecutionError("EXECUTION_ROOT_ALREADY_GOVERNED", 409);
    }
  }

  public requireTaskAvailable(taskId: string): void {
    if (this.database.prepare("SELECT 1 FROM execution_plan_task_claims WHERE task_id = ?").get(taskId) ||
      this.database.prepare(`SELECT 1 FROM execution_plans WHERE root_task_id = ?
        AND state IN ('approved', 'running', 'paused', 'review')`).get(taskId)) {
      throw new ExecutionError("EXECUTION_TASK_ALREADY_GOVERNED", 409);
    }
  }

  public persist(input: {
    plan: ExecutionPlanProjection; command: ExecutionPlanApprovalCommand;
    memberId: string; requestDigest: string; rootTaskRevisionAfter: number;
    compiled: CompiledExecutionNode[]; now: string;
  }): ExecutionPlanApprovalReceipt {
    if (!this.database.inTransaction) throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    const { plan, command, compiled } = input;
    for (const { node, task } of compiled) {
      const snapshot = {
        taskId: task.taskId, roomId: task.roomId, parentTaskId: task.parentTaskId,
        title: task.title, goal: task.goal, ownerMemberId: task.ownerMemberId,
        completionPolicy: task.completionPolicy, definitionRevision: task.definitionRevision,
        criteriaRevision: task.criteriaRevision, taskRevision: task.taskRevision,
        criteria: task.criteria, assignments: task.assignments, budgetPolicy: task.budgetPolicy
      };
      this.database.prepare(`
        INSERT INTO execution_plan_nodes (plan_id, revision, node_key, task_id, task_revision,
          definition_revision, criteria_revision, agent_id, owner_member_id, node_json, task_snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(plan.planId, plan.current.revision, node.nodeKey, task.taskId, task.taskRevision,
        task.definitionRevision, task.criteriaRevision, node.agentId, task.ownerMemberId,
        canonicalExecutionJSON(node), canonicalExecutionJSON(snapshot));
      this.database.prepare(`INSERT INTO execution_plan_task_claims (task_id, plan_id, revision, node_key)
        VALUES (?, ?, ?, ?)`).run(task.taskId, plan.planId, plan.current.revision, node.nodeKey);
    }
    if (command.decision === "approved") {
      for (const edge of plan.current.definition.edges) {
        this.database.prepare(`INSERT INTO execution_plan_edges
          (plan_id, revision, edge_key, from_node_key, to_node_key, gate, edge_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(plan.planId, plan.current.revision, edge.edgeKey, edge.fromNodeKey, edge.toNodeKey,
            edge.gate, canonicalExecutionJSON(edge));
      }
    }
    const compiledTasks = compiled.map(({ node, task }) => ({
      nodeKey: node.nodeKey, taskId: task.taskId, taskRevision: task.taskRevision,
      definitionRevision: task.definitionRevision, criteriaRevision: task.criteriaRevision
    })).sort((a, b) => a.nodeKey < b.nodeKey ? -1 : a.nodeKey > b.nodeKey ? 1 : 0);
    const approval: ExecutionPlanApprovalRecord = {
      operationId: command.operationId, planId: plan.planId, revision: plan.current.revision,
      digest: plan.current.digest, decision: command.decision, reason: command.reason,
      reviewedByMemberId: input.memberId, rootTaskRevisionBefore: command.expectedRootTaskRevision,
      rootTaskRevisionAfter: input.rootTaskRevisionAfter, compiledTasks, reviewedAt: input.now
    };
    const result: ExecutionPlanApprovalReceipt = {
      approval,
      plan: { ...plan, state: command.decision === "approved" ? "approved" : "draft",
        controlRevision: plan.controlRevision + (command.decision === "approved" ? 1 : 0),
        compiledTasks, updatedAt: input.now }
    };
    this.database.prepare(`INSERT INTO execution_plan_approvals (
      operation_id, plan_id, revision, digest, decision, reason, reviewed_by_member_id,
      root_task_revision_before, root_task_revision_after, compiled_tasks_json,
      request_digest, response_json, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(command.operationId, plan.planId, plan.current.revision, plan.current.digest,
      command.decision, command.reason, input.memberId, command.expectedRootTaskRevision,
      input.rootTaskRevisionAfter, canonicalExecutionJSON(compiledTasks), input.requestDigest,
      JSON.stringify(result), input.now);
    const changed = this.database.prepare(`UPDATE execution_plans
      SET state = ?, control_revision = ?, updated_at = ?
      WHERE plan_id = ? AND current_revision = ? AND control_revision = ? AND state = 'draft'
    `).run(result.plan.state, result.plan.controlRevision, input.now, plan.planId,
      plan.current.revision, plan.controlRevision);
    if (changed.changes !== 1) throw new ExecutionError("EXECUTION_REVISION_CONFLICT", 409);
    return result;
  }
}
