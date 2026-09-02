import type {
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanProposalCommand,
  ExecutionPlanRevision,
  ExecutionPlanRevisionCommand
} from "@convene-wire/contracts/execution-plan";
import {
  executionOperationDigest,
  validateExecutionPlanDefinition
} from "@convene-wire/contracts/execution-validation";
import type { CoreRepository } from "../data/core-repository.js";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "../task/task-repository.js";
import { ExecutionError } from "./execution-error.js";
import type { ExecutionPlanRepository } from
  "./execution-plan-repository.js";
import type { ExecutionSourceRepository } from
  "./execution-source-repository.js";

type DraftCommand = ExecutionPlanProposalCommand | ExecutionPlanRevisionCommand;

export interface ExecutionPlanDraftWrite {
  author: ExecutionPlanRevision["author"];
  command: DraftCommand;
  now: string;
  planId?: string;
  rootTaskId: string;
  authorize: (
    root: AgentTaskRecord,
    plan: ExecutionPlanProjection | undefined
  ) => void;
}

// Shared non-authoritative draft persistence. Entry adapters must prove their
// own actor scope through authorize(); this writer never approves or dispatches.
export class ExecutionPlanDraftWriter {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly plans: ExecutionPlanRepository,
    private readonly sources: ExecutionSourceRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository,
    private readonly onChanged: (roomId: string) => void
  ) {}

  public write(input: ExecutionPlanDraftWrite): ExecutionPlanProjection {
    const validated = validateExecutionPlanDefinition(input.command.definition);
    if (validated.definition.rootTaskId !== input.rootTaskId) {
      throw new ExecutionError("EXECUTION_ROOT_MISMATCH");
    }
    return this.transactions.immediate(() => {
      const root = this.tasks.get(input.rootTaskId);
      if (!root) throw new ExecutionError("EXECUTION_ROOT_NOT_FOUND", 404);
      const plan = input.planId ? this.plans.get(input.planId) : undefined;
      if (input.planId && !plan) {
        throw new ExecutionError("EXECUTION_PLAN_NOT_FOUND", 404);
      }
      if (plan && plan.rootTaskId !== root.taskId) {
        throw new ExecutionError("EXECUTION_ROOT_MISMATCH");
      }
      input.authorize(root, plan);
      const digest = executionOperationDigest({
        action: plan ? "revise" : "create",
        author: input.author,
        rootTaskId: root.taskId,
        planId: plan?.planId ?? null,
        command: { ...input.command, definition: validated.definition }
      });
      // Exact replay follows current adapter authorization but precedes stale
      // source/task pins and returns the original immutable projection.
      const replay = this.plans.replay(input.command.operationId, digest);
      if (replay) return replay;
      if (root.isDefault || root.parentTaskId !== null ||
        root.lifecycleState === "completed" || root.lifecycleState === "canceled") {
        throw new ExecutionError("EXECUTION_ROOT_UNAVAILABLE");
      }
      if (root.taskRevision !== input.command.expectedRootTaskRevision) {
        throw new ExecutionError("EXECUTION_ROOT_REVISION_CONFLICT", 409);
      }
      if (plan && (plan.state !== "draft" ||
        !("expectedRevision" in input.command) ||
        input.command.expectedRevision !== plan.current.revision)) {
        throw new ExecutionError("EXECUTION_REVISION_CONFLICT", 409);
      }
      this.requireReferences(validated.definition, root);
      const snapshots = this.sources.freeze(validated.definition, root.roomId);
      this.sources.requireExternalInputs(validated.definition, root.roomId);
      const result = this.plans.append({
        ...(plan ? { plan } : {}),
        rootTaskId: root.taskId,
        rootTaskRevision: root.taskRevision,
        roomId: root.roomId,
        ownerMemberId: root.ownerMemberId,
        definition: validated.definition,
        definitionDigest: validated.digest,
        author: input.author,
        snapshots,
        operationId: input.command.operationId,
        operationDigest: digest,
        now: input.now
      });
      this.transactions.afterCommit(() => this.onChanged(root.roomId), {
        key: `execution:${root.roomId}`
      });
      return result;
    });
  }

  private requireReferences(
    definition: ExecutionPlanDefinition,
    root: AgentTaskRecord
  ): void {
    const requireOwner = (memberId: string | undefined) => {
      const member = memberId ? this.core.getMember(memberId) : undefined;
      if (!member || member.teamId !== root.teamId ||
        !this.core.isRoomMember(root.roomId, member.memberId)) {
        throw new ExecutionError("EXECUTION_NODE_OWNER_UNAVAILABLE");
      }
    };
    requireOwner(root.ownerMemberId);
    for (const node of definition.nodes) {
      const agent = this.core.getAgent(node.agentId);
      if (!agent || !agent.enabled || agent.teamId !== root.teamId ||
        !this.core.isRoomAgent(root.roomId, agent.agentId)) {
        throw new ExecutionError("EXECUTION_NODE_AGENT_UNAVAILABLE");
      }
      if (node.task.mode === "new") {
        requireOwner(node.task.ownerMemberId);
        continue;
      }
      const task = node.task.taskId ? this.tasks.get(node.task.taskId) : undefined;
      if (!task || task.roomId !== root.roomId || task.isDefault ||
        task.lifecycleState === "completed" || task.lifecycleState === "canceled" ||
        task.completionPolicy !== "accepted_result_required") {
        throw new ExecutionError("EXECUTION_NODE_TASK_UNAVAILABLE");
      }
      requireOwner(task.ownerMemberId);
      if (task.taskRevision !== node.task.expectedTaskRevision ||
        task.definitionRevision !== node.task.definitionRevision ||
        task.criteriaRevision !== node.task.criteriaRevision) {
        throw new ExecutionError("EXECUTION_NODE_REVISION_CONFLICT", 409);
      }
      if (!task.assignments.some((assignment) =>
        assignment.agentId === node.agentId)) {
        throw new ExecutionError("EXECUTION_NODE_ASSIGNMENT_REQUIRED");
      }
    }
  }
}
