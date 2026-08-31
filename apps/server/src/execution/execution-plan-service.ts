import type {
  ExecutionPlanDefinition,
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
import { ExecutionError } from "./execution-error.js";
import type { ExecutionPlanRepository } from "./execution-plan-repository.js";
import type { ExecutionSourceRepository } from "./execution-source-repository.js";

export class ExecutionPlanService {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly plans: ExecutionPlanRepository,
    private readonly sources: ExecutionSourceRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository,
    private readonly auth: AuthService,
    private readonly onChanged: (roomId: string) => void
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

  public create(principal: WebPrincipal, taskId: string, value: unknown, now: string) {
    assertExecutionCommand("proposalCommand", value);
    const command = value as ExecutionPlanProposalCommand;
    return this.write(principal, taskId, undefined, command, now);
  }

  public revise(principal: WebPrincipal, planId: string, value: unknown, now: string) {
    assertExecutionCommand("revisionCommand", value);
    const command = value as ExecutionPlanRevisionCommand;
    return this.transactions.immediate(() => {
      const plan = this.get(principal, planId);
      return this.write(principal, plan.rootTaskId, plan, command, now);
    });
  }

  private write(
    principal: WebPrincipal,
    rootTaskId: string,
    plan: ExecutionPlanProjection | undefined,
    command: ExecutionPlanProposalCommand | ExecutionPlanRevisionCommand,
    now: string
  ): ExecutionPlanProjection {
    const validated = validateExecutionPlanDefinition(command.definition);
    if (validated.definition.rootTaskId !== rootTaskId) {
      throw new ExecutionError("EXECUTION_ROOT_MISMATCH");
    }
    return this.transactions.immediate(() => {
      const root = this.tasks.get(rootTaskId);
      if (!root) throw new ExecutionError("EXECUTION_ROOT_NOT_FOUND", 404);
      const member = this.auth.requireRoomMember(principal, root.roomId);
      if (member.memberId !== root.ownerMemberId && member.role !== "owner") {
        throw new AuthorizationError("FORBIDDEN", "Task Owner or Team Owner required");
      }
      const author = { kind: "member" as const, memberId: member.memberId };
      const digest = executionOperationDigest({
        action: plan ? "revise" : "create", author, rootTaskId,
        planId: plan?.planId ?? null,
        command: { ...command, definition: validated.definition }
      });
      // Replay follows current authorization, precedes stale source/task pins and
      // returns the original projection even when the plan has advanced.
      const replay = this.plans.replay(command.operationId, digest);
      if (replay) return replay;
      if (root.isDefault || root.parentTaskId !== null ||
        root.lifecycleState === "completed" || root.lifecycleState === "canceled") {
        throw new ExecutionError("EXECUTION_ROOT_UNAVAILABLE");
      }
      if (root.taskRevision !== command.expectedRootTaskRevision) {
        throw new ExecutionError("EXECUTION_ROOT_REVISION_CONFLICT", 409);
      }
      if (plan && (plan.state !== "draft" ||
        !("expectedRevision" in command) || command.expectedRevision !== plan.current.revision)) {
        throw new ExecutionError("EXECUTION_REVISION_CONFLICT", 409);
      }
      this.requireReferences(validated.definition, root);
      const snapshots = this.sources.freeze(validated.definition, root.roomId);
      this.sources.requireExternalInputs(validated.definition, root.roomId);
      const result = this.plans.append({
        ...(plan ? { plan } : {}), rootTaskId, rootTaskRevision: root.taskRevision,
        roomId: root.roomId, ownerMemberId: root.ownerMemberId,
        definition: validated.definition, definitionDigest: validated.digest,
        author, snapshots, operationId: command.operationId, operationDigest: digest, now
      });
      this.transactions.afterCommit(() => this.onChanged(root.roomId), {
        key: `execution:${root.roomId}`
      });
      return result;
    });
  }

  private requireReferences(definition: ExecutionPlanDefinition, root: AgentTaskRecord): void {
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
      if (!task.assignments.some((assignment) => assignment.agentId === node.agentId)) {
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
