import type {
  ExecutionSchedulerAdvanceCommand,
  ExecutionSchedulerControl,
  ExecutionSchedulerDispatchReceipt,
  ExecutionSchedulerManualDispatchCommand,
  ExecutionSchedulerModeCommand,
  ExecutionSchedulerModeReceipt
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type { RunRecord } from "../run/run-repository.js";
import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";
import type { AgentTaskRepository } from "../task/task-repository.js";
import { ExecutionError } from "./execution-error.js";
import type { ExecutionNodeStateRepository } from
  "./execution-node-state-repository.js";
import type { ExecutionPlanRepository } from
  "./execution-plan-repository.js";
import type {
  ExecutionSchedulerControlRepository,
  ExecutionSchedulerMode,
  ExecutionSchedulerReceipt
} from "./execution-scheduler-control-repository.js";
import type { ExecutionSchedulerFairnessRepository } from
  "./execution-scheduler-fairness-repository.js";
import type { ExecutionScheduler } from "./execution-scheduler.js";
import type { GovernedRunAdmissionService } from
  "./governed-run-admission-service.js";

export interface ExecutionSchedulerDispatchResult {
  receipt: ExecutionSchedulerDispatchReceipt;
  runs: RunRecord[];
}

export class ExecutionSchedulerControlService {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly plans: ExecutionPlanRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly auth: AuthService,
    private readonly controls: ExecutionSchedulerControlRepository,
    private readonly fairness: ExecutionSchedulerFairnessRepository,
    private readonly nodes: ExecutionNodeStateRepository,
    private readonly scheduler: ExecutionScheduler,
    private readonly admission: GovernedRunAdmissionService
  ) {}

  public get(
    principal: WebPrincipal,
    planId: string
  ): ExecutionSchedulerControl {
    const plan = this.planForMember(principal, planId);
    const control = this.controls.get(plan.planId);
    if (!control) {
      throw new ExecutionError("EXECUTION_SCHEDULER_CONTROL_UNAVAILABLE");
    }
    return control;
  }

  public setMode(
    principal: WebPrincipal,
    planId: string,
    value: unknown,
    now: string
  ): ExecutionSchedulerModeReceipt {
    assertExecutionCommand("schedulerModeCommand", value);
    const command = value as ExecutionSchedulerModeCommand;
    this.requireReason(command.reason);
    const { member, plan } = this.owner(principal, planId);
    const requestDigest = executionOperationDigest({
      action: "execution_scheduler_mode_v1",
      planId,
      actor: { kind: "member", memberId: member.memberId },
      command
    });
    return this.transactions.immediate(() => {
      const replay = this.controls.replay(command.operationId, requestDigest);
      if (replay) return this.modeReplay(replay);
      this.requirePlanPins(plan, command);
      const current = this.controls.get(planId);
      if (!current || current.modeRevision !== command.expectedModeRevision) {
        throw new ExecutionError("EXECUTION_SCHEDULER_MODE_CONFLICT", 409);
      }
      if (current.mode === command.mode) {
        throw new ExecutionError("EXECUTION_SCHEDULER_MODE_UNCHANGED", 409);
      }
      this.controls.begin({
        action: "mode_transition",
        createdAt: now,
        expectedMode: current.mode,
        expectedModeRevision: command.expectedModeRevision,
        expectedNodeProjectionRevision: null,
        nodeKey: null,
        operationId: command.operationId,
        planControlRevision: plan.controlRevision,
        planDigest: plan.current.digest,
        planId,
        planRevision: plan.current.revision,
        reason: command.reason,
        request: command,
        requestDigest,
        requestedByMemberId: member.memberId,
        targetMode: command.mode
      });
      const updated = this.controls.transition({
        expectedMode: current.mode,
        expectedModeRevision: current.modeRevision,
        memberId: member.memberId,
        mode: command.mode,
        now,
        operationId: command.operationId,
        planId,
        reason: command.reason
      });
      this.nodes.ensureCurrent(now);
      const unsigned = {
        operationId: command.operationId,
        planId,
        planRevision: plan.current.revision,
        planDigest: plan.current.digest,
        planControlRevision: plan.controlRevision,
        previousMode: current.mode,
        previousModeRevision: current.modeRevision,
        mode: updated.mode,
        modeRevision: updated.modeRevision,
        updatedByMemberId: member.memberId,
        reason: command.reason,
        requestDigest,
        updatedAt: now
      };
      const receipt: ExecutionSchedulerModeReceipt = {
        ...unsigned,
        operationDigest: executionOperationDigest(unsigned)
      };
      this.controls.complete(receipt);
      return receipt;
    });
  }

  public manualDispatch(
    principal: WebPrincipal,
    planId: string,
    nodeKey: string,
    value: unknown,
    now: string
  ): ExecutionSchedulerDispatchResult {
    assertExecutionCommand("schedulerManualDispatchCommand", value);
    const command = value as ExecutionSchedulerManualDispatchCommand;
    this.requireReason(command.reason);
    if (command.nodeKey !== nodeKey) {
      throw new ExecutionError("EXECUTION_SCHEDULER_NODE_MISMATCH");
    }
    const { member, plan } = this.owner(principal, planId);
    const requestDigest = executionOperationDigest({
      action: "execution_scheduler_manual_dispatch_v1",
      planId,
      nodeKey,
      actor: { kind: "member", memberId: member.memberId },
      command
    });
    return this.transactions.immediate(() => {
      const replay = this.controls.replay(command.operationId, requestDigest);
      if (replay) return { receipt: this.dispatchReplay(replay), runs: [] };
      this.requirePlanPins(plan, command);
      const control = this.controls.require(
        planId,
        "manual",
        command.expectedModeRevision
      );
      this.nodes.ensureCurrent(now);
      const state = this.nodes.get({
        planId,
        planRevision: plan.current.revision,
        nodeKey
      });
      if (!state || state.projectionRevision !==
        command.expectedNodeProjectionRevision || state.runId !== null) {
        throw new ExecutionError("EXECUTION_SCHEDULER_NODE_CONFLICT", 409);
      }
      const definitionNode = plan.current.definition.nodes.find(
        (candidate) => candidate.nodeKey === nodeKey
      );
      if (!definitionNode) {
        throw new ExecutionError("EXECUTION_NODE_NOT_FOUND", 404);
      }
      this.controls.begin({
        action: "manual_dispatch",
        createdAt: now,
        expectedMode: "manual",
        expectedModeRevision: control.modeRevision,
        expectedNodeProjectionRevision: state.projectionRevision,
        nodeKey,
        operationId: command.operationId,
        planControlRevision: plan.controlRevision,
        planDigest: plan.current.digest,
        planId,
        planRevision: plan.current.revision,
        reason: command.reason,
        request: command,
        requestDigest,
        requestedByMemberId: member.memberId,
        targetMode: null
      });
      const admission = this.admission.admitScheduled({
        planId,
        planRevision: plan.current.revision,
        nodeKey
      }, now, {
        expectedFairnessCursorRevision:
          this.fairness.revision(definitionNode.agentId),
        mode: "manual",
        modeRevision: control.modeRevision,
        operationId: command.operationId
      });
      if (!admission.created || admission.runs.length !== 1) {
        throw new ExecutionError("EXECUTION_SCHEDULER_NODE_CONFLICT", 409);
      }
      const receipt = this.dispatchReceipt({
        action: "manual_dispatch",
        command,
        memberId: member.memberId,
        mode: "manual",
        modeRevision: control.modeRevision,
        now,
        plan,
        requestDigest,
        run: admission.runs[0]!
      });
      this.controls.complete(receipt);
      return { receipt, runs: admission.runs };
    });
  }

  public advance(
    principal: WebPrincipal,
    planId: string,
    value: unknown,
    now: string
  ): ExecutionSchedulerDispatchResult {
    assertExecutionCommand("schedulerAdvanceCommand", value);
    const command = value as ExecutionSchedulerAdvanceCommand;
    this.requireReason(command.reason);
    const { member, plan } = this.owner(principal, planId);
    const requestDigest = executionOperationDigest({
      action: "execution_scheduler_supervised_advance_v1",
      planId,
      actor: { kind: "member", memberId: member.memberId },
      command
    });
    return this.transactions.immediate(() => {
      const replay = this.controls.replay(command.operationId, requestDigest);
      if (replay) return { receipt: this.dispatchReplay(replay), runs: [] };
      this.requirePlanPins(plan, command);
      const control = this.controls.require(
        planId,
        "supervised",
        command.expectedModeRevision
      );
      this.controls.begin({
        action: "supervised_advance",
        createdAt: now,
        expectedMode: "supervised",
        expectedModeRevision: control.modeRevision,
        expectedNodeProjectionRevision: null,
        nodeKey: null,
        operationId: command.operationId,
        planControlRevision: plan.controlRevision,
        planDigest: plan.current.digest,
        planId,
        planRevision: plan.current.revision,
        reason: command.reason,
        request: command,
        requestDigest,
        requestedByMemberId: member.memberId,
        targetMode: null
      });
      const runs = this.scheduler.sweep({
        maxAdmissions: 1,
        mode: "supervised",
        operationId: command.operationId,
        planId
      });
      const receipt = this.dispatchReceipt({
        action: "supervised_advance",
        command,
        memberId: member.memberId,
        mode: "supervised",
        modeRevision: control.modeRevision,
        now,
        plan,
        requestDigest,
        ...(runs[0] ? { run: runs[0] } : {})
      });
      this.controls.complete(receipt);
      return { receipt, runs };
    });
  }

  private dispatchReceipt(input: {
    action: ExecutionSchedulerDispatchReceipt["action"];
    command: ExecutionSchedulerAdvanceCommand |
      ExecutionSchedulerManualDispatchCommand;
    memberId: string;
    mode: ExecutionSchedulerMode;
    modeRevision: number;
    now: string;
    plan: NonNullable<ReturnType<ExecutionPlanRepository["get"]>>;
    requestDigest: string;
    run?: RunRecord;
  }): ExecutionSchedulerDispatchReceipt {
    const unsigned = {
      operationId: input.command.operationId,
      action: input.action,
      planId: input.plan.planId,
      planRevision: input.plan.current.revision,
      planDigest: input.plan.current.digest,
      planControlRevision: input.plan.controlRevision,
      mode: input.mode,
      modeRevision: input.modeRevision,
      requestedByMemberId: input.memberId,
      reason: input.command.reason,
      selection: input.run ? {
        nodeKey: input.plan.compiledTasks.find(
          (task) => task.taskId === input.run!.taskId
        )!.nodeKey,
        dispatchIntentId: this.controls.dispatchIntent(input.run.runId),
        runId: input.run.runId
      } : null,
      requestDigest: input.requestDigest,
      createdAt: input.now
    };
    return { ...unsigned, operationDigest: executionOperationDigest(unsigned) };
  }

  private owner(principal: WebPrincipal, planId: string) {
    const plan = this.planForMember(principal, planId);
    const root = this.tasks.get(plan.rootTaskId);
    if (!root) throw new ExecutionError("EXECUTION_ROOT_NOT_FOUND", 404);
    const member = this.auth.requireRoomMember(principal, root.roomId);
    if (member.role !== "owner" && member.memberId !== root.ownerMemberId) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Task Owner or Team Owner required"
      );
    }
    return { member, plan };
  }

  private planForMember(principal: WebPrincipal, planId: string) {
    const plan = this.plans.get(planId);
    if (!plan) throw new ExecutionError("EXECUTION_PLAN_NOT_FOUND", 404);
    this.auth.requireRoomMember(principal, plan.roomId);
    return plan;
  }

  private requirePlanPins(
    plan: NonNullable<ReturnType<ExecutionPlanRepository["get"]>>,
    command: {
      expectedPlanControlRevision: number;
      expectedPlanDigest: string;
      expectedPlanRevision: number;
    }
  ): void {
    if (plan.current.revision !== command.expectedPlanRevision ||
      plan.current.digest !== command.expectedPlanDigest ||
      plan.controlRevision !== command.expectedPlanControlRevision) {
      throw new ExecutionError("EXECUTION_SCHEDULER_PLAN_CONFLICT", 409);
    }
  }

  private requireReason(reason: string): void {
    if (reason.trim().length === 0) {
      throw new ExecutionError("EXECUTION_REASON_REQUIRED");
    }
  }

  private modeReplay(
    receipt: ExecutionSchedulerReceipt
  ): ExecutionSchedulerModeReceipt {
    if (!("previousMode" in receipt)) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    return receipt;
  }

  private dispatchReplay(
    receipt: ExecutionSchedulerReceipt
  ): ExecutionSchedulerDispatchReceipt {
    if ("previousMode" in receipt) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    return receipt;
  }
}
