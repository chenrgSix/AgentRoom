import type {
  ExecutionPlanDefinition,
  ExecutionPlanApprovalCommand,
  ExecutionPlanApprovalReceipt,
  ExecutionPlanProjection,
  ExecutionPlanProposalCommand,
  ExecutionPlanRevisionCommand
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  executionOperationDigest,
  validateExecutionPlanDefinition
} from "@convene-wire/contracts/execution-validation";
import type { CoreRepository } from "../data/core-repository.js";
import type { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";
import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";
import type { AgentTaskRecord, AgentTaskRepository } from "../task/task-repository.js";
import type { AgentTaskService } from "../task/agent-task-service.js";
import { ExecutionError } from "./execution-error.js";
import type { ExecutionPlanRepository } from "./execution-plan-repository.js";
import type { ExecutionSourceRepository } from "./execution-source-repository.js";
import type { ExecutionApprovalRepository } from "./execution-approval-repository.js";
import type { ExecutionPlanCompiler } from "./execution-plan-compiler.js";
import type { ExecutionPlanDraftWriter } from "./execution-plan-draft-writer.js";

export class ExecutionPlanService {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly plans: ExecutionPlanRepository,
    private readonly sources: ExecutionSourceRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository,
    private readonly auth: AuthService,
    private readonly onChanged: (roomId: string) => void,
    private readonly approvals: ExecutionApprovalRepository,
    private readonly compiler: ExecutionPlanCompiler,
    private readonly taskService: AgentTaskService,
    private readonly draftWriter: ExecutionPlanDraftWriter
  ) {}

  public get(principal: WebPrincipal, planId: string): ExecutionPlanProjection {
    const plan = this.plans.get(planId);
    if (!plan) throw new ExecutionError("EXECUTION_PLAN_NOT_FOUND", 404);
    this.auth.requireRoomMember(principal, plan.roomId);
    return plan;
  }

  public list(principal: WebPrincipal, roomId: string, afterPlanId = "", limit = 20) {
    this.auth.requireRoomMember(principal, roomId);
    this.requirePageLimit(limit);
    if (afterPlanId && !/^plan_[A-Za-z0-9_-]{8,128}$/u.test(afterPlanId)) {
      throw new ExecutionError("EXECUTION_INVALID_CURSOR");
    }
    return this.plans.list(roomId, afterPlanId, limit);
  }

  public history(principal: WebPrincipal, planId: string, afterRevision = 0, limit = 20) {
    this.get(principal, planId);
    this.requirePageLimit(limit);
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) {
      throw new ExecutionError("EXECUTION_INVALID_CURSOR");
    }
    return this.plans.history(planId, afterRevision, limit);
  }

  public decision(principal: WebPrincipal, decisionId: string) {
    const decision = this.plans.decision(decisionId);
    if (!decision) throw new ExecutionError("EXECUTION_DECISION_NOT_FOUND", 404);
    this.auth.requireRoomMember(principal, decision.roomId);
    return decision;
  }

  public decisionSources(principal: WebPrincipal, decisionId: string) {
    this.decision(principal, decisionId);
    return this.plans.sources(decisionId);
  }

  public approvalHistory(principal: WebPrincipal, planId: string, afterRevision = 0, limit = 20) {
    this.get(principal, planId);
    this.requirePageLimit(limit);
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new ExecutionError("EXECUTION_INVALID_CURSOR");
    return this.approvals.history(planId, afterRevision, limit);
  }

  public review(
    principal: WebPrincipal, planId: string, value: unknown, now: string
  ): ExecutionPlanApprovalReceipt {
    assertExecutionCommand("approvalCommand", value);
    const command = value as ExecutionPlanApprovalCommand;
    if (command.reason.trim().length === 0) throw new ExecutionError("EXECUTION_REASON_REQUIRED");
    return this.transactions.immediate(() => {
      const plan = this.get(principal, planId);
      const root = this.tasks.get(plan.rootTaskId);
      if (!root) throw new ExecutionError("EXECUTION_ROOT_NOT_FOUND", 404);
      const member = this.auth.requireRoomMember(principal, root.roomId);
      if (member.memberId !== root.ownerMemberId && member.role !== "owner") {
        throw new AuthorizationError("FORBIDDEN", "Task Owner or Team Owner required");
      }
      const requestDigest = executionOperationDigest({
        action: "review", planId, actor: { kind: "member", memberId: member.memberId }, command
      });
      const replay = this.approvals.replay(command.operationId, requestDigest);
      if (replay) return replay;
      if (plan.state !== "draft" || plan.current.revision !== command.expectedRevision ||
        plan.current.digest !== command.expectedDigest || this.approvals.get(planId, command.expectedRevision)) {
        throw new ExecutionError("EXECUTION_APPROVAL_CONFLICT", 409);
      }
      if (root.taskRevision !== command.expectedRootTaskRevision) {
        throw new ExecutionError("EXECUTION_ROOT_REVISION_CONFLICT", 409);
      }
      let compiled: ReturnType<ExecutionPlanCompiler["compile"]> = [];
      let rootTaskRevisionAfter = root.taskRevision;
      if (command.decision === "approved") {
        if (root.isDefault || root.parentTaskId !== null ||
          root.lifecycleState === "completed" || root.lifecycleState === "canceled") {
          throw new ExecutionError("EXECUTION_ROOT_UNAVAILABLE");
        }
        if (root.taskRevision >= Number.MAX_SAFE_INTEGER || plan.controlRevision >= Number.MAX_SAFE_INTEGER) {
          throw new ExecutionError("EXECUTION_REVISION_EXHAUSTED", 409);
        }
        const validated = validateExecutionPlanDefinition(plan.current.definition);
        if (validated.digest !== plan.current.digest) throw new ExecutionError("EXECUTION_HISTORY_INCONSISTENT");
        if (validated.approvalBlockers.length > 0) throw new ExecutionError("EXECUTION_REQUIRED_QUESTIONS_UNRESOLVED", 409);
        this.requireReferences(validated.definition, root);
        const frozen = this.plans.sources(plan.current.decisionId);
        const current = this.sources.freeze(validated.definition, plan.roomId);
        if (frozen.length !== current.length || current.some((source) => !frozen.some((old) =>
          old.source.evidenceRefId === source.source.evidenceRefId && old.revision === source.revision && old.digest === source.digest))) {
          throw new ExecutionError("EXECUTION_SOURCE_REVISION_CONFLICT", 409);
        }
        this.sources.requireExternalInputs(validated.definition, plan.roomId);
        compiled = this.compiler.compile(member, plan, command.operationId, now);
        const fenced = this.taskService.recordExecutionApproval(member, root.taskId, {
          operationId: `op_${executionOperationDigest({ purpose: "execution_root_approval", operationId: command.operationId })}`,
          expectedTaskRevision: root.taskRevision
        }, now);
        if (fenced.taskRevision !== root.taskRevision + 1) throw new ExecutionError("EXECUTION_ROOT_REVISION_CONFLICT", 409);
        rootTaskRevisionAfter = fenced.taskRevision;
      }
      const receipt = this.approvals.persist({
        plan, command, memberId: member.memberId, requestDigest, rootTaskRevisionAfter, compiled, now
      });
      this.transactions.afterCommit(() => this.onChanged(plan.roomId), { key: `execution:${plan.roomId}` });
      return receipt;
    });
  }

  public create(principal: WebPrincipal, taskId: string, value: unknown, now: string) {
    assertExecutionCommand("proposalCommand", value);
    const command = value as ExecutionPlanProposalCommand;
    return this.draftWriter.write({
      rootTaskId: taskId,
      command,
      author: this.draftMemberAuthor(principal, taskId),
      authorize: (root) => this.requireDraftOwner(principal, root),
      now
    });
  }

  public revise(principal: WebPrincipal, planId: string, value: unknown, now: string) {
    assertExecutionCommand("revisionCommand", value);
    const command = value as ExecutionPlanRevisionCommand;
    const plan = this.get(principal, planId);
    return this.draftWriter.write({
      rootTaskId: plan.rootTaskId,
      planId,
      command,
      author: this.draftMemberAuthor(principal, plan.rootTaskId),
      authorize: (root) => this.requireDraftOwner(principal, root),
      now
    });
  }

  private draftMemberAuthor(principal: WebPrincipal, taskId: string) {
    const root = this.tasks.get(taskId);
    if (!root) throw new ExecutionError("EXECUTION_ROOT_NOT_FOUND", 404);
    const member = this.auth.requireRoomMember(principal, root.roomId);
    if (member.memberId !== root.ownerMemberId && member.role !== "owner") {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Task Owner or Team Owner required"
      );
    }
    return { kind: "member" as const, memberId: member.memberId };
  }

  private requireDraftOwner(
    principal: WebPrincipal,
    root: NonNullable<ReturnType<AgentTaskRepository["get"]>>
  ): void {
    const member = this.auth.requireRoomMember(principal, root.roomId);
    if (member.memberId !== root.ownerMemberId && member.role !== "owner") {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Task Owner or Team Owner required"
      );
    }
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

  private requirePageLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new ExecutionError("EXECUTION_INVALID_PAGE_LIMIT");
    }
  }
}
