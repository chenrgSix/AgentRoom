import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type {
  AuthService,
  MemberPrincipal,
  WebPrincipal
} from "../security/auth-service.js";
import {
  type AgentTaskRecord,
  type AgentTaskRepository,
  type AgentTaskState,
  type TaskAssignmentRole,
  type TaskBudgetPolicy,
  type TaskCompletionPolicy,
  type TaskCriterion,
  type TaskLifecycleState,
  type TaskPriority,
  type TaskSchedulingState
} from "./task-repository.js";

const taskStates = new Set<AgentTaskState>([
  "open", "working", "blocked", "review", "completed", "canceled"
]);
const lifecycleStates = new Set<TaskLifecycleState>([
  "draft", "ready", "active", "review", "completed", "canceled"
]);
const schedulingStates = new Set<TaskSchedulingState>(["enabled", "paused"]);
const completionPolicies = new Set<TaskCompletionPolicy>([
  "owner_confirmed", "accepted_result_required"
]);
const priorities = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);
const assignmentRoles = new Set<TaskAssignmentRole>([
  "primary", "contributor", "reviewer"
]);
const terminalTaskStates = new Set<AgentTaskState>(["completed", "canceled"]);
const terminalLifecycleStates = new Set<TaskLifecycleState>([
  "completed", "canceled"
]);
const allowedLifecycleTransitions = new Map<TaskLifecycleState, Set<TaskLifecycleState>>([
  ["draft", new Set(["ready", "canceled"])],
  ["ready", new Set(["draft", "active", "canceled"])],
  ["active", new Set(["review", "completed", "canceled"])],
  ["review", new Set(["active", "completed", "canceled"])],
  ["completed", new Set()],
  ["canceled", new Set()]
]);

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || value.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

export interface TaskDefinitionInput {
  operationId: string;
  expectedTaskRevision: number;
  title: string;
  goal: string;
  ownerMemberId: string;
  completionPolicy: TaskCompletionPolicy;
  priority: TaskPriority;
  dueAt: string | null;
  criteria: TaskCriterion[];
  assignments: Array<{ agentId: string; role: TaskAssignmentRole }>;
  budgetPolicy: TaskBudgetPolicy;
}

export class AgentTaskService {
  public constructor(
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public list(principal: WebPrincipal, roomId: string): AgentTaskRecord[] {
    this.auth.requireRoomMember(principal, roomId);
    return this.tasks.listForRoom(roomId);
  }

  public get(principal: WebPrincipal, taskId: string): AgentTaskRecord {
    const task = this.requireTask(taskId);
    this.auth.requireRoomMember(principal, task.roomId);
    return task;
  }

  public create(
    principal: WebPrincipal,
    input: {
      roomId: string;
      parentTaskId?: string | null;
      title: string;
      goal: string;
      primaryAgentId?: string | null;
      workspaceRef?: string | null;
      ownerMemberId?: string;
      completionPolicy?: TaskCompletionPolicy;
      priority?: TaskPriority;
      dueAt?: string | null;
      lifecycleState?: "draft" | "ready";
      criteria?: TaskCriterion[];
      assignments?: Array<{ agentId: string; role: TaskAssignmentRole }>;
      budgetPolicy?: TaskBudgetPolicy;
    },
    now: string
  ): AgentTaskRecord {
    const member = this.auth.requireRoomMember(principal, input.roomId);
    const room = this.core.getRoom(input.roomId);
    if (!room || room.archivedAt) throw new Error("Task Room is unavailable");
    const parentTaskId = input.parentTaskId ?? null;
    if (parentTaskId) {
      const parent = this.tasks.get(parentTaskId);
      if (!parent || parent.roomId !== input.roomId) {
        throw new Error("Parent Task must belong to the same Room");
      }
    }
    const ownerMemberId = input.ownerMemberId ?? member.memberId;
    this.requireOwnerCandidate(room.teamId, input.roomId, ownerMemberId);
    const completionPolicy = input.completionPolicy ?? "owner_confirmed";
    if (!completionPolicies.has(completionPolicy)) {
      throw new Error("Unsupported Task completion policy");
    }
    const priority = input.priority ?? "normal";
    if (!priorities.has(priority)) throw new Error("Unsupported Task priority");
    const criteria = this.validateCriteria(input.criteria ?? []);
    const requestedAssignments = input.assignments ?? (
      input.primaryAgentId
        ? [{ agentId: input.primaryAgentId, role: "primary" as const }]
        : []
    );
    const assignments = this.validateAssignments(
      room.teamId,
      room.roomId,
      requestedAssignments
    );
    const primaryAgentId =
      assignments.find(({ role }) => role === "primary")?.agentId ?? null;
    const budgetPolicy = this.validateBudget(input.budgetPolicy ?? {
      maxRunAttempts: 1000,
      maxExecutionDurationSeconds: 2_592_000
    });
    const workspaceRef = input.workspaceRef === undefined || input.workspaceRef === null
      ? null
      : boundedText(input.workspaceRef, "Task workspace reference", 512);
    const lifecycleState = input.lifecycleState ?? "ready";
    const task: AgentTaskRecord = {
      taskId: createOpaqueId("task"),
      taskDisplayNumber: this.tasks.nextDisplayNumber(room.teamId),
      teamId: room.teamId,
      roomId: input.roomId,
      parentTaskId,
      title: boundedText(input.title, "Task title", 160),
      goal: boundedText(input.goal, "Task goal", 20_000),
      state: "open",
      lifecycleState,
      schedulingState: "enabled",
      completionPolicy,
      priority,
      dueAt: this.validateDueAt(input.dueAt ?? null),
      taskRevision: 1,
      definitionRevision: 1,
      criteriaRevision: 1,
      criteria,
      ownerMemberId,
      assignments: assignments.map((assignment) => ({
        ...assignment,
        assignedByMemberId: member.memberId,
        assignedAt: now
      })),
      budgetPolicy,
      budgetUsage: {
        usageRevision: 0,
        runAttempts: 0,
        executionDurationSeconds: 0,
        providerTokens: null,
        providerCostUsd: null
      },
      completionResultId: null,
      attentionReasons: [],
      nextAction: {
        actorKind: "member",
        reason: "start_work",
        sourceId: null,
        expectedMemberId: ownerMemberId,
        expectedAgentId: null
      },
      primaryAgentId,
      workspaceRef,
      summary: "",
      summaryRevision: 0,
      summarySourceSequence: 0,
      summaryProvenanceMessageIds: [],
      artifactRevision: 0,
      lastRoomSequence: 0,
      createdByMemberId: member.memberId,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    };
    return this.tasks.create(task);
  }

  public updateDefinition(
    principal: WebPrincipal,
    taskId: string,
    input: TaskDefinitionInput,
    now: string
  ): AgentTaskRecord {
    const existing = this.requireTask(taskId);
    const member = this.requireOwner(principal, existing);
    if (existing.isDefault && input.assignments.length > 0) {
      throw new Error("Default Task derives Agents from its Room roster");
    }
    this.requireOwnerCandidate(existing.teamId, existing.roomId, input.ownerMemberId);
    if (!completionPolicies.has(input.completionPolicy)) {
      throw new Error("Unsupported Task completion policy");
    }
    if (!priorities.has(input.priority)) throw new Error("Unsupported Task priority");
    return this.tasks.updateDefinition({
      taskId,
      operationId: boundedText(input.operationId, "Operation ID", 140),
      expectedTaskRevision: positiveInteger(
        input.expectedTaskRevision,
        "Expected Task revision",
        Number.MAX_SAFE_INTEGER
      ),
      title: boundedText(input.title, "Task title", 160),
      goal: boundedText(input.goal, "Task goal", 20_000),
      ownerMemberId: input.ownerMemberId,
      completionPolicy: input.completionPolicy,
      priority: input.priority,
      dueAt: this.validateDueAt(input.dueAt),
      criteria: this.validateCriteria(input.criteria),
      assignments: this.validateAssignments(
        existing.teamId,
        existing.roomId,
        input.assignments
      ),
      budgetPolicy: this.validateBudget(input.budgetPolicy),
      memberId: member.memberId,
      now
    });
  }

  public updateControl(
    principal: WebPrincipal,
    taskId: string,
    input: {
      operationId: string;
      expectedTaskRevision: number;
      lifecycleState?: TaskLifecycleState;
      schedulingState?: TaskSchedulingState;
    },
    now: string
  ): AgentTaskRecord {
    const existing = this.requireTask(taskId);
    this.requireOwner(principal, existing);
    if (input.lifecycleState === undefined && input.schedulingState === undefined) {
      throw new Error("Task control update requires lifecycle or scheduling state");
    }
    if (input.lifecycleState && !lifecycleStates.has(input.lifecycleState)) {
      throw new Error("Unsupported Task lifecycle state");
    }
    if (input.schedulingState && !schedulingStates.has(input.schedulingState)) {
      throw new Error("Unsupported Task scheduling state");
    }
    if (existing.isDefault &&
      (input.lifecycleState !== undefined || input.schedulingState === "paused")) {
      throw new Error("Default Task is permanently active");
    }
    if (input.lifecycleState && input.lifecycleState !== existing.lifecycleState &&
      !allowedLifecycleTransitions.get(existing.lifecycleState)?.has(
        input.lifecycleState
      )) {
      throw new Error(
        `Task cannot transition from ${existing.lifecycleState} to ` +
        input.lifecycleState
      );
    }
    if (input.lifecycleState && terminalLifecycleStates.has(input.lifecycleState)) {
      if (this.tasks.hasActiveWork(taskId)) {
        throw new Error("Task has active Runs or Discussions, or clarifications");
      }
      if (this.tasks.hasUnacknowledgedAmbiguity(taskId)) {
        throw new Error("Task has an unacknowledged ambiguous Run outcome");
      }
      if (input.lifecycleState === "completed" &&
        existing.completionPolicy === "accepted_result_required") {
        throw new Error("Task completion requires an accepted current Result");
      }
    }
    return this.tasks.updateControl({
      taskId,
      operationId: boundedText(input.operationId, "Operation ID", 140),
      expectedTaskRevision: positiveInteger(
        input.expectedTaskRevision,
        "Expected Task revision",
        Number.MAX_SAFE_INTEGER
      ),
      ...(input.lifecycleState ? { lifecycleState: input.lifecycleState } : {}),
      ...(input.schedulingState ? { schedulingState: input.schedulingState } : {}),
      now
    });
  }

  public addBlock(
    principal: WebPrincipal,
    taskId: string,
    input: {
      operationId: string;
      expectedTaskRevision: number;
      reason: string;
    },
    now: string
  ): AgentTaskRecord {
    const task = this.requireTask(taskId);
    const member = this.requireOwner(principal, task);
    if (terminalLifecycleStates.has(task.lifecycleState)) {
      throw new Error("Terminal Task cannot be blocked");
    }
    return this.tasks.addBlock({
      taskId,
      operationId: boundedText(input.operationId, "Operation ID", 140),
      expectedTaskRevision: positiveInteger(
        input.expectedTaskRevision,
        "Expected Task revision",
        Number.MAX_SAFE_INTEGER
      ),
      reason: boundedText(input.reason, "Task block reason", 2_000),
      memberId: member.memberId,
      now
    });
  }

  public resolveBlock(
    principal: WebPrincipal,
    taskId: string,
    blockId: string,
    input: { operationId: string; expectedTaskRevision: number },
    now: string
  ): AgentTaskRecord {
    const task = this.requireTask(taskId);
    const member = this.requireOwner(principal, task);
    return this.tasks.resolveBlock({
      taskId,
      blockId: boundedText(blockId, "Task block ID", 140),
      operationId: boundedText(input.operationId, "Operation ID", 140),
      expectedTaskRevision: positiveInteger(
        input.expectedTaskRevision,
        "Expected Task revision",
        Number.MAX_SAFE_INTEGER
      ),
      memberId: member.memberId,
      now
    });
  }

  public update(
    principal: WebPrincipal,
    taskId: string,
    input: {
      title?: string;
      goal?: string;
      state?: AgentTaskState;
      primaryAgentId?: string | null;
      workspaceRef?: string | null;
    },
    now: string
  ): AgentTaskRecord {
    const existing = this.requireTask(taskId);
    this.requireOwner(principal, existing);
    if (Object.keys(input).length === 0) {
      throw new Error("Task update requires at least one field");
    }
    if (input.state !== undefined && !taskStates.has(input.state)) {
      throw new Error("Unsupported Task state");
    }
    if (existing.isDefault && input.state !== undefined &&
      terminalTaskStates.has(input.state)) {
      throw new Error("Default Task is permanently active");
    }
    if (
      input.state !== undefined && terminalTaskStates.has(input.state) &&
      !terminalTaskStates.has(existing.state) && this.tasks.hasActiveWork(taskId)
    ) {
      throw new Error("Task has active Runs or Discussions, or clarifications");
    }
    if (input.state === "completed" &&
      existing.completionPolicy === "accepted_result_required") {
      throw new Error("Task completion requires an accepted current Result");
    }
    const primaryAgentId = input.primaryAgentId === undefined
      ? existing.primaryAgentId
      : input.primaryAgentId;
    if (primaryAgentId) {
      this.validateAssignments(existing.teamId, existing.roomId, [{
        agentId: primaryAgentId,
        role: "primary"
      }]);
    }
    return this.tasks.update(taskId, {
      title: input.title === undefined
        ? existing.title
        : boundedText(input.title, "Task title", 160),
      goal: input.goal === undefined
        ? existing.goal
        : boundedText(input.goal, "Task goal", 20_000),
      state: input.state ?? existing.state,
      primaryAgentId,
      workspaceRef: input.workspaceRef === undefined
        ? existing.workspaceRef
        : input.workspaceRef === null
          ? null
          : boundedText(input.workspaceRef, "Task workspace reference", 512),
      updatedAt: now
    });
  }

  public requireRunnable(
    principal: WebPrincipal,
    roomId: string,
    taskId?: string
  ): AgentTaskRecord {
    this.auth.requireRoomMember(principal, roomId);
    const task = taskId
      ? this.tasks.get(taskId)
      : this.tasks.getDefaultForRoom(roomId);
    if (!task || task.roomId !== roomId) {
      throw new Error("Task must belong to the target Room");
    }
    if (!["ready", "active", "review"].includes(task.lifecycleState)) {
      throw new Error(`Task is not runnable in state ${task.lifecycleState}`);
    }
    if (task.schedulingState !== "enabled") {
      throw new Error("Task scheduling is paused");
    }
    if (
      task.budgetUsage.runAttempts >= task.budgetPolicy.maxRunAttempts ||
      task.budgetUsage.executionDurationSeconds >=
        task.budgetPolicy.maxExecutionDurationSeconds
    ) {
      throw new Error("Task budget is exhausted");
    }
    return task;
  }

  // Internal coordination port: approval advances the canonical Task revision
  // without pretending to edit its goal, criteria, lifecycle or permissions.
  public recordExecutionApproval(
    principal: WebPrincipal,
    taskId: string,
    input: { operationId: string; expectedTaskRevision: number },
    now: string
  ): AgentTaskRecord {
    const task = this.requireTask(taskId);
    this.requireOwner(principal, task);
    if (task.isDefault || terminalLifecycleStates.has(task.lifecycleState)) {
      throw new Error("Execution approval requires a non-terminal ordinary Task");
    }
    return this.tasks.fenceRevision({
      taskId,
      operationId: boundedText(input.operationId, "Operation ID", 140),
      expectedTaskRevision: positiveInteger(input.expectedTaskRevision,
        "Expected Task revision", Number.MAX_SAFE_INTEGER),
      now
    });
  }

  private requireTask(taskId: string): AgentTaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private requireOwner(
    principal: WebPrincipal,
    task: AgentTaskRecord
  ): MemberPrincipal {
    const member = this.auth.requireRoomMember(principal, task.roomId);
    if (member.role !== "owner" && member.memberId !== task.ownerMemberId) {
      throw new Error("Only the Task Owner or Team Owner may mutate the Task");
    }
    return member;
  }

  private requireOwnerCandidate(
    teamId: string,
    roomId: string,
    memberId: string
  ): void {
    const member = this.core.getMember(memberId);
    if (!member || member.teamId !== teamId || !this.core.isRoomMember(roomId, memberId)) {
      throw new Error("Task Owner must be a human participant in the Task Room");
    }
  }

  private validateAssignments(
    teamId: string,
    roomId: string,
    assignments: Array<{ agentId: string; role: TaskAssignmentRole }>
  ): Array<{ agentId: string; role: TaskAssignmentRole }> {
    if (assignments.length > 100) throw new Error("Task has too many assignments");
    const agentIds = new Set<string>();
    let primaryCount = 0;
    for (const assignment of assignments) {
      if (agentIds.has(assignment.agentId)) {
        throw new Error("Task Agent assignments must be unique");
      }
      agentIds.add(assignment.agentId);
      if (!assignmentRoles.has(assignment.role)) {
        throw new Error("Unsupported Task assignment role");
      }
      if (assignment.role === "primary") primaryCount += 1;
      const agent = this.core.getAgent(assignment.agentId);
      if (!agent || !agent.enabled || agent.teamId !== teamId ||
        !this.core.isRoomAgent(roomId, assignment.agentId)) {
        throw new Error("Assigned Agent must be available in the Task Room");
      }
    }
    if (primaryCount > 1) throw new Error("Task may have at most one primary Agent");
    return assignments;
  }

  private validateCriteria(criteria: TaskCriterion[]): TaskCriterion[] {
    if (criteria.length > 100) throw new Error("Task has too many criteria");
    const keys = new Set<string>();
    const ordinals = new Set<number>();
    return criteria.map((criterion) => {
      if (!/^criterion_[A-Za-z0-9_-]{8,64}$/u.test(criterion.criterionKey)) {
        throw new Error("Task criterion key is invalid");
      }
      if (keys.has(criterion.criterionKey)) {
        throw new Error("Task criterion keys must be unique");
      }
      keys.add(criterion.criterionKey);
      if (!Number.isSafeInteger(criterion.ordinal) || criterion.ordinal < 1 ||
        criterion.ordinal > 100 || ordinals.has(criterion.ordinal)) {
        throw new Error("Task criterion ordinals must be unique from 1 to 100");
      }
      ordinals.add(criterion.ordinal);
      if (typeof criterion.required !== "boolean") {
        throw new Error("Task criterion required flag must be boolean");
      }
      return {
        criterionKey: criterion.criterionKey,
        description: boundedText(
          criterion.description,
          "Task criterion description",
          2_000
        ),
        required: criterion.required,
        ordinal: criterion.ordinal
      };
    }).sort((left, right) => left.ordinal - right.ordinal);
  }

  private validateBudget(policy: TaskBudgetPolicy): TaskBudgetPolicy {
    return {
      maxRunAttempts: positiveInteger(
        policy.maxRunAttempts,
        "Maximum Run attempts",
        1000
      ),
      maxExecutionDurationSeconds: positiveInteger(
        policy.maxExecutionDurationSeconds,
        "Maximum execution duration",
        2_592_000
      )
    };
  }

  private validateDueAt(dueAt: string | null): string | null {
    if (dueAt === null) return null;
    if (!Number.isFinite(Date.parse(dueAt)) || !dueAt.endsWith("Z")) {
      throw new Error("Task due date must be an RFC 3339 UTC timestamp");
    }
    return dueAt;
  }
}
