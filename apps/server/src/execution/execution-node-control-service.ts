import type { ExecutionNodeRetryCommand } from
  "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";

import type { CoreRepository } from "../data/core-repository.js";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRecord, RunRepository, RunState } from
  "../run/run-repository.js";
import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";
import type { AgentTaskRepository } from "../task/task-repository.js";
import { ExecutionError } from "./execution-error.js";
import type { ExecutionNodeStateRepository } from
  "./execution-node-state-repository.js";
import type { ExecutionNodeRetryRepository } from
  "./execution-node-retry-repository.js";
import type { ExecutionPlanRepository } from
  "./execution-plan-repository.js";
import type { ExecutionSettlementService } from
  "./execution-settlement-service.js";
import type { GovernedRunAdmissionService } from
  "./governed-run-admission-service.js";

type RetryableRunState = Extract<RunState,
  "failed" | "canceled" | "expired" | "outcome_unknown"
>;

const eligibleStates = new Set<RetryableRunState>([
  "failed",
  "canceled",
  "expired",
  "outcome_unknown"
]);

const isRetryableRunState = (state: RunState): state is RetryableRunState =>
  eligibleStates.has(state as RetryableRunState);

export interface ExecutionNodeRetryResult {
  authorization: ReturnType<ExecutionNodeRetryRepository["retain"]>;
  created: boolean;
  run: RunRecord;
}

const fail = (
  code: string,
  statusCode: 400 | 404 | 409 = 409
): never => {
  throw new ExecutionError(code, statusCode);
};

export class ExecutionNodeControlService {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly core: CoreRepository,
    private readonly auth: AuthService,
    private readonly plans: ExecutionPlanRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly nodes: ExecutionNodeStateRepository,
    private readonly retries: ExecutionNodeRetryRepository,
    private readonly settlement: ExecutionSettlementService,
    private readonly admission: GovernedRunAdmissionService,
    private readonly runs: RunRepository
  ) {}

  public retry(
    principal: WebPrincipal,
    planId: string,
    pathNodeKey: string,
    value: unknown,
    now: string
  ): ExecutionNodeRetryResult {
    assertExecutionCommand("nodeRetryCommand", value);
    const command = value as ExecutionNodeRetryCommand;
    if (command.reason.trim().length === 0) {
      return fail("EXECUTION_NODE_RETRY_REASON_REQUIRED", 400);
    }
    if (command.nodeKey !== pathNodeKey) {
      return fail("EXECUTION_NODE_RETRY_NODE_MISMATCH", 400);
    }
    const initialPlan = this.plans.get(planId);
    if (!initialPlan) return fail("EXECUTION_PLAN_NOT_FOUND", 404);
    const initialMember = this.auth.requireRoomMember(
      principal,
      initialPlan.roomId
    );
    const requestDigest = executionOperationDigest({
      action: "execution_node_retry_v1",
      actor: { kind: "member", memberId: initialMember.memberId },
      planId,
      command
    });
    const identity = {
      planId,
      planRevision: command.expectedPlanRevision,
      nodeKey: command.nodeKey
    };

    // Project terminal Run facts before acquiring the retry transaction. The
    // exact projection revision is then rechecked inside that transaction.
    this.settlement.reconcileOne(identity, now);

    return this.transactions.immediate(() => {
      const plan = this.plans.get(planId);
      if (!plan) return fail("EXECUTION_PLAN_NOT_FOUND", 404);
      const member = this.auth.requireRoomMember(principal, plan.roomId);
      const replay = this.retries.replay(command.operationId, requestDigest);
      if (replay) {
        const run = this.runs.getRun(replay.newRunId);
        if (!run) throw new Error("Execution retry Run is unavailable");
        return { authorization: replay, created: false, run };
      }
      if (
        plan.current.revision !== command.expectedPlanRevision ||
        plan.current.digest !== command.expectedPlanDigest ||
        plan.controlRevision !== command.expectedControlRevision ||
        !["approved", "running"].includes(plan.state)
      ) {
        return fail("EXECUTION_NODE_RETRY_PLAN_CONFLICT");
      }
      const compiled = plan.compiledTasks.find(
        (candidate) => candidate.nodeKey === command.nodeKey
      );
      const node = plan.current.definition.nodes.find(
        (candidate) => candidate.nodeKey === command.nodeKey
      );
      const task = compiled ? this.tasks.get(compiled.taskId) : undefined;
      if (!compiled || !node || !task || node.kind !== "implementation") {
        return fail("EXECUTION_NODE_RETRY_SCOPE_INVALID");
      }
      if (member.memberId !== task.ownerMemberId && member.role !== "owner") {
        throw new AuthorizationError(
          "FORBIDDEN",
          "Task Owner or Team Owner required"
        );
      }
      const state = this.nodes.get(identity);
      if (
        !state ||
        state.projectionRevision !== command.expectedNodeProjectionRevision ||
        state.dispatchGeneration !== command.expectedPreviousGeneration ||
        state.runId !== command.expectedPreviousRunId ||
        !state.lastRunState ||
        !isRetryableRunState(state.lastRunState)
      ) {
        return fail("EXECUTION_NODE_RETRY_STATE_CONFLICT");
      }
      const previousRun = this.runs.getRun(command.expectedPreviousRunId);
      if (
        !previousRun ||
        previousRun.state !== state.lastRunState ||
        !isRetryableRunState(previousRun.state) ||
        previousRun.taskId !== task.taskId ||
        previousRun.targetAgentId !== node.agentId
      ) {
        return fail("EXECUTION_NODE_RETRY_STATE_CONFLICT");
      }
      if (this.retries.hasMaterialization(
        planId,
        command.expectedPlanRevision,
        command.nodeKey
      )) {
        return fail("EXECUTION_NODE_RETRY_PROOF_ALREADY_RETAINED");
      }
      const acknowledgement = this.runs.getAmbiguityAcknowledgement(
        previousRun.runId
      );
      if (previousRun.state === "outcome_unknown") {
        if (
          !acknowledgement ||
          acknowledgement.operationId !==
            command.ambiguityAcknowledgementOperationId
        ) {
          return fail("EXECUTION_NODE_RETRY_AMBIGUITY_ACK_REQUIRED");
        }
      } else if (command.ambiguityAcknowledgementOperationId !== null) {
        return fail("EXECUTION_NODE_RETRY_AMBIGUITY_ACK_INVALID", 400);
      }
      const readiness = this.admission.retryReadiness(identity, now);
      if (!readiness.ready) return fail(readiness.blocker);
      const newGeneration = command.expectedPreviousGeneration + 1;
      if (!Number.isSafeInteger(newGeneration)) {
        return fail("EXECUTION_DISPATCH_GENERATION_EXHAUSTED");
      }
      const newRunId = createOpaqueId("run");
      const newDispatchIntentId = createOpaqueId("dispatch");
      const authorization = this.retries.retain({
        operationId: command.operationId,
        planId,
        planRevision: plan.current.revision,
        planDigest: plan.current.digest,
        planControlRevision: plan.controlRevision,
        nodeKey: command.nodeKey,
        previousNodeProjectionRevision: state.projectionRevision,
        previousGeneration: command.expectedPreviousGeneration,
        previousRunId: previousRun.runId,
        previousRunState: previousRun.state,
        ambiguityAcknowledgementOperationId:
          command.ambiguityAcknowledgementOperationId,
        newGeneration,
        newRunId,
        newDispatchIntentId,
        requestedByMemberId: member.memberId,
        reason: command.reason,
        requestDigest,
        createdAt: now
      });
      const message = this.core.appendMessage({
        messageId: createOpaqueId("msg"),
        roomId: task.roomId,
        taskId: task.taskId,
        senderType: "member",
        senderId: member.memberId,
        content: `Execution node retry authorized: ${command.reason}`,
        mentions: [{
          targetType: "agent",
          targetAgentId: node.agentId,
          displayLabel: this.core.getAgent(node.agentId)?.name ?? node.nodeKey
        }],
        parentMessageId: previousRun.triggerMessageId,
        createdAt: now
      });
      const admitted = this.admission.admitRetry({
        authorization,
        member: { memberId: member.memberId, role: member.role },
        message,
        now,
        previousRun,
        task
      });
      if (!admitted.created || admitted.runs.length !== 1) {
        throw new Error("Execution retry admission did not create one Run");
      }
      return { authorization, created: true, run: admitted.runs[0]! };
    });
  }
}
