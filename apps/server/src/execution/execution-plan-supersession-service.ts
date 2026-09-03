import type Database from "better-sqlite3";
import type {
  ExecutionPlanApprovalReceipt,
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanRevision,
  ExecutionPlanSupersessionActivationCommand,
  ExecutionPlanSupersessionActivationReceipt,
  ExecutionPlanSupersessionCandidate,
  ExecutionPlanSupersessionCandidateCommand,
  ExecutionPlanSupersessionControlView,
  ExecutionReplanDelegation,
  ExecutionReplanDelegationIssueCommand,
  ExecutionReplanDelegationRevokeCommand,
  ExecutionReplanDelegationRevocation
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest,
  validateExecutionPlanDefinition
} from "@convene-wire/contracts/execution-validation";

import type { BridgeConnectionRegistry } from
  "../bridge/bridge-connection-registry.js";
import type { CoreRepository } from "../data/core-repository.js";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import {
  AuthorizationError,
  type AuthService,
  type MemberPrincipal,
  type WebPrincipal
} from "../security/auth-service.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "../task/task-repository.js";
import type { ExecutionEvidenceCarryForwardRepository } from
  "./execution-evidence-carry-forward-repository.js";
import { ExecutionError } from "./execution-error.js";
import type { ExecutionPlanRepository } from
  "./execution-plan-repository.js";
import type { ExecutionPlanSupersessionRepository } from
  "./execution-plan-supersession-repository.js";
import type { ExecutionSourceRepository } from
  "./execution-source-repository.js";

const activePlanStates = new Set<ExecutionPlanProjection["state"]>([
  "approved", "running", "paused", "review"
]);
const binary = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const same = (left: unknown, right: unknown): boolean =>
  canonicalExecutionJSON(left) === canonicalExecutionJSON(right);

interface CompiledNode {
  node: ExecutionPlanDefinition["nodes"][number];
  task: AgentTaskRecord;
}

interface AdoptedRow {
  adoption_id: string;
  adoption_digest: string;
  gate: ExecutionPlanSupersessionActivationCommand["carryForward"][number]["gate"];
  node_key: string;
  source_task_id: string;
}

export class ExecutionPlanSupersessionService {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions: SqliteTransactionBoundary,
    private readonly plans: ExecutionPlanRepository,
    private readonly supersessions: ExecutionPlanSupersessionRepository,
    private readonly carry: ExecutionEvidenceCarryForwardRepository,
    private readonly sources: ExecutionSourceRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository,
    private readonly auth: AuthService,
    private readonly connections: BridgeConnectionRegistry,
    private readonly onChanged: (roomId: string) => void
  ) {}

  public getCandidate(
    principal: WebPrincipal,
    planId: string
  ): ExecutionPlanSupersessionCandidate | null {
    const plan = this.requirePlan(principal, planId);
    return this.plans.supersessionCandidate(plan.planId) ?? null;
  }

  public control(
    principal: WebPrincipal,
    planId: string,
    now: string
  ): ExecutionPlanSupersessionControlView {
    const plan = this.requirePlan(principal, planId);
    this.requireOwner(principal, plan);
    const root = this.requireRoot(plan);
    const candidate = this.plans.supersessionCandidate(plan.planId) ?? null;
    let activationTemplate: ExecutionPlanSupersessionControlView["activationTemplate"] =
      null;
    let activationBlockerCode: string | null = null;
    if (candidate) {
      try {
        activationTemplate = this.activationTemplate(
          plan,
          root,
          candidate,
          now
        );
      } catch (error) {
        if (!(error instanceof ExecutionError)) throw error;
        activationBlockerCode = error.code;
      }
    }
    const delegations = this.supersessions.listDelegations(plan.planId)
      .sort((left, right) =>
        binary(left.agentId, right.agentId) ||
        left.revision - right.revision ||
        binary(left.delegationId, right.delegationId)
      )
      .map((delegation) => ({
        delegation,
        state: this.delegationState(delegation, plan, root, now)
      }));
    const view = {
      planId: plan.planId,
      currentRevision: plan.current.revision,
      currentDigest: plan.current.digest,
      controlRevision: plan.controlRevision,
      rootTaskRevision: root.taskRevision,
      candidate,
      activationTemplate,
      activationBlockerCode,
      delegations
    } as ExecutionPlanSupersessionControlView;
    assertExecutionCommand("supersessionControlView", view);
    return view;
  }

  public propose(
    principal: WebPrincipal,
    planId: string,
    value: unknown,
    now: string
  ): ExecutionPlanSupersessionCandidate {
    const plan = this.requirePlan(principal, planId);
    const member = this.requireOwner(principal, plan);
    return this.proposeWithAuthor(
      planId,
      value,
      { kind: "member", memberId: member.memberId },
      now
    );
  }

  public proposeForAgent(
    planId: string,
    value: unknown,
    author: ExecutionPlanRevision["author"] & {
      kind: "agent"; agentId: string; runId: string;
    },
    now: string
  ): ExecutionPlanSupersessionCandidate {
    return this.proposeWithAuthor(planId, value, author, now);
  }

  public issueDelegation(
    principal: WebPrincipal,
    planId: string,
    value: unknown,
    now: string
  ): ExecutionReplanDelegation {
    assertExecutionCommand("replanDelegationIssueCommand", value);
    const command = value as ExecutionReplanDelegationIssueCommand;
    return this.transactions.immediate(() => {
      const plan = this.requirePlan(principal, planId);
      const member = this.requireOwner(principal, plan);
      const requestDigest = executionOperationDigest({
        action: "issue_replan_delegation",
        planId,
        memberId: member.memberId,
        command
      });
      const replay = this.supersessions.replayDelegation(
        command.operationId,
        requestDigest
      );
      if (replay) return replay;
      this.requireCurrentPins(plan, command.expectedPlanRevision,
        command.expectedPlanDigest, command.expectedControlRevision);
      const root = this.requireRoot(plan);
      if (root.taskRevision !== command.expectedRootTaskRevision) {
        throw new ExecutionError("EXECUTION_ROOT_REVISION_CONFLICT", 409);
      }
      if (!root.assignments.some(({ agentId, role }) =>
        agentId === command.agentId && role === "primary")) {
        throw new ExecutionError("EXECUTION_TECH_LEAD_DELEGATION_REQUIRED");
      }
      const expires = Date.parse(command.expiresAt);
      const nowMs = Date.parse(now);
      if (!Number.isFinite(expires) || expires <= nowMs ||
        expires > nowMs + 24 * 60 * 60 * 1000) {
        throw new ExecutionError("EXECUTION_REPLAN_DELEGATION_EXPIRY_INVALID");
      }
      const taskIds = plan.compiledTasks.map(({ taskId }) => taskId)
        .sort(binary) as [string, ...string[]];
      const unsigned = {
        revision: this.supersessions.nextDelegationRevision(
          planId,
          command.agentId
        ),
        operationId: command.operationId,
        planId,
        planRevision: plan.current.revision,
        planDigest: plan.current.digest,
        planControlRevision: plan.controlRevision,
        rootTaskRevision: root.taskRevision,
        agentId: command.agentId,
        issuedByMemberId: member.memberId,
        taskIds,
        expiresAt: command.expiresAt,
        reason: command.reason,
        issuedAt: now
      };
      const delegationDigest = executionOperationDigest(unsigned);
      const record: ExecutionReplanDelegation = {
        delegationId: `replan_${executionOperationDigest({
          operationId: command.operationId,
          delegationDigest
        })}`,
        ...unsigned,
        delegationDigest
      };
      const retained = this.supersessions.retainDelegation(
        record,
        requestDigest
      );
      this.changed(plan.roomId);
      return retained;
    });
  }

  public listDelegations(principal: WebPrincipal, planId: string) {
    const plan = this.requirePlan(principal, planId);
    this.requireOwner(principal, plan);
    return this.supersessions.listDelegations(planId).map((delegation) => ({
      delegation,
      revoked: this.supersessions.isRevoked(delegation.delegationId),
      consumed: this.supersessions.isConsumed(delegation.delegationId)
    }));
  }

  public revokeDelegation(
    principal: WebPrincipal,
    planId: string,
    delegationId: string,
    value: unknown,
    now: string
  ): ExecutionReplanDelegationRevocation {
    assertExecutionCommand("replanDelegationRevokeCommand", value);
    const command = value as ExecutionReplanDelegationRevokeCommand;
    return this.transactions.immediate(() => {
      const plan = this.requirePlan(principal, planId);
      const member = this.requireOwner(principal, plan);
      const delegation = this.supersessions.getDelegation(delegationId);
      if (!delegation || delegation.planId !== planId) {
        throw new ExecutionError("EXECUTION_REPLAN_DELEGATION_NOT_FOUND", 404);
      }
      const requestDigest = executionOperationDigest({
        action: "revoke_replan_delegation",
        planId,
        delegationId,
        memberId: member.memberId,
        command
      });
      const replay = this.supersessions.replayRevocation(
        command.operationId,
        requestDigest
      );
      if (replay) return replay;
      if (command.expectedRevision !== delegation.revision ||
        command.expectedDigest !== delegation.delegationDigest ||
        this.supersessions.isRevoked(delegationId)) {
        throw new ExecutionError("EXECUTION_REPLAN_DELEGATION_CONFLICT", 409);
      }
      const unsigned = {
        operationId: command.operationId,
        delegationId,
        delegationRevision: delegation.revision,
        delegationDigest: delegation.delegationDigest,
        revokedByMemberId: member.memberId,
        reason: command.reason,
        revokedAt: now
      };
      const record: ExecutionReplanDelegationRevocation = {
        ...unsigned,
        revocationDigest: executionOperationDigest(unsigned)
      };
      this.supersessions.retainRevocation(record, requestDigest);
      this.changed(plan.roomId);
      return record;
    });
  }

  public activate(
    principal: WebPrincipal,
    planId: string,
    value: unknown,
    now: string
  ): ExecutionPlanSupersessionActivationReceipt {
    const plan = this.requirePlan(principal, planId);
    const member = this.requireOwner(principal, plan);
    return this.activateWithActor(
      planId,
      value,
      { kind: "member", memberId: member.memberId },
      member.memberId,
      null,
      now
    );
  }

  public activateForAgent(
    planId: string,
    value: unknown,
    author: ExecutionPlanRevision["author"] & {
      kind: "agent"; agentId: string; runId: string;
    },
    delegationId: string,
    now: string
  ): ExecutionPlanSupersessionActivationReceipt {
    const delegation = this.supersessions.getDelegation(delegationId);
    if (!delegation || delegation.planId !== planId) {
      throw new ExecutionError("EXECUTION_REPLAN_DELEGATION_NOT_FOUND", 404);
    }
    return this.activateWithActor(
      planId,
      value,
      author,
      delegation.issuedByMemberId,
      delegationId,
      now
    );
  }

  public replayForAgent(
    planId: string,
    value: unknown,
    author: ExecutionPlanRevision["author"] & {
      kind: "agent"; agentId: string; runId: string;
    },
    delegationId: string
  ): ExecutionPlanSupersessionActivationReceipt | undefined {
    assertExecutionCommand("supersessionActivationCommand", value);
    const command = value as ExecutionPlanSupersessionActivationCommand;
    const delegation = this.supersessions.getDelegation(delegationId);
    if (!delegation || delegation.planId !== planId ||
      delegation.agentId !== author.agentId) {
      throw new ExecutionError("EXECUTION_REPLAN_DELEGATION_NOT_FOUND", 404);
    }
    return this.supersessions.replayActivation(
      command.operationId,
      executionOperationDigest({
        action: "activate_plan_supersession",
        planId,
        activatedBy: author,
        authorityMemberId: delegation.issuedByMemberId,
        delegationId,
        command
      })
    );
  }

  private proposeWithAuthor(
    planId: string,
    value: unknown,
    author: ExecutionPlanRevision["author"],
    now: string
  ): ExecutionPlanSupersessionCandidate {
    assertExecutionCommand("supersessionCandidateCommand", value);
    const command = value as ExecutionPlanSupersessionCandidateCommand;
    const validated = validateExecutionPlanDefinition(
      command.definition as ExecutionPlanDefinition
    );
    return this.transactions.immediate(() => {
      const plan = this.plans.get(planId);
      if (!plan) throw new ExecutionError("EXECUTION_PLAN_NOT_FOUND", 404);
      const requestDigest = executionOperationDigest({
        action: "propose_plan_supersession",
        planId,
        author,
        command: { ...command, definition: validated.definition }
      });
      const replay = this.plans.replaySupersessionCandidate(
        command.operationId,
        requestDigest
      );
      if (replay) return replay;
      this.requireCurrentPins(plan, command.expectedCurrentRevision,
        command.expectedCurrentDigest, command.expectedControlRevision);
      const root = this.requireRoot(plan);
      if (root.taskRevision !== command.expectedRootTaskRevision) {
        throw new ExecutionError("EXECUTION_ROOT_REVISION_CONFLICT", 409);
      }
      if (validated.definition.rootTaskId !== plan.rootTaskId) {
        throw new ExecutionError("EXECUTION_ROOT_MISMATCH");
      }
      if (validated.approvalBlockers.length > 0) {
        throw new ExecutionError(
          "EXECUTION_REQUIRED_QUESTIONS_UNRESOLVED",
          409
        );
      }
      if (this.plans.supersessionCandidate(planId)) {
        throw new ExecutionError("EXECUTION_SUPERSESSION_CANDIDATE_EXISTS", 409);
      }
      this.compileFixedTaskSet(plan, validated.definition);
      const snapshots = this.sources.freeze(validated.definition, plan.roomId);
      this.sources.requireExternalInputs(validated.definition, plan.roomId);
      const candidate = this.plans.appendSupersessionCandidate({
        plan,
        rootTaskRevision: root.taskRevision,
        definition: validated.definition,
        definitionDigest: validated.digest,
        author,
        snapshots,
        operationId: command.operationId,
        requestDigest,
        reason: command.reason,
        now
      });
      this.changed(plan.roomId);
      return candidate;
    });
  }

  private activateWithActor(
    planId: string,
    value: unknown,
    activatedBy: ExecutionPlanSupersessionActivationReceipt["activatedBy"],
    authorityMemberId: string,
    delegationId: string | null,
    now: string
  ): ExecutionPlanSupersessionActivationReceipt {
    assertExecutionCommand("supersessionActivationCommand", value);
    const command = value as ExecutionPlanSupersessionActivationCommand;
    return this.transactions.immediate(() => {
      const plan = this.plans.get(planId);
      if (!plan) throw new ExecutionError("EXECUTION_PLAN_NOT_FOUND", 404);
      this.requireAuthorityMember(plan, authorityMemberId);
      const requestDigest = executionOperationDigest({
        action: "activate_plan_supersession",
        planId,
        activatedBy,
        authorityMemberId,
        delegationId,
        command
      });
      const replay = this.supersessions.replayActivation(
        command.operationId,
        requestDigest
      );
      if (replay) return replay;
      this.requireCurrentPins(plan, command.expectedCurrentRevision,
        command.expectedCurrentDigest, command.expectedControlRevision);
      const root = this.requireRoot(plan);
      if (root.taskRevision !== command.expectedRootTaskRevision) {
        throw new ExecutionError("EXECUTION_ROOT_REVISION_CONFLICT", 409);
      }
      const candidate = this.plans.supersessionCandidateById(
        command.candidateId
      );
      if (!candidate || candidate.planId !== planId ||
        candidate.baseRevision !== plan.current.revision ||
        candidate.baseDigest !== plan.current.digest ||
        candidate.baseControlRevision !== plan.controlRevision ||
        candidate.rootTaskRevision !== root.taskRevision ||
        candidate.candidateRevision !== command.expectedCandidateRevision ||
        candidate.candidateDigest !== command.expectedCandidateDigest ||
        candidate.candidateRevision !== plan.current.revision + 1) {
        throw new ExecutionError("EXECUTION_SUPERSESSION_CANDIDATE_CONFLICT", 409);
      }
      const definition = validateExecutionPlanDefinition(
        candidate.definition as ExecutionPlanDefinition
      ).definition;
      const compiled = this.compileFixedTaskSet(plan, definition);
      const currentSources = this.sources.freeze(definition, plan.roomId);
      const frozenSources = this.plans.sources(
        this.plans.revision(planId, candidate.candidateRevision)!.decisionId
      );
      if (currentSources.length !== frozenSources.length ||
        currentSources.some((source) => !frozenSources.some((frozen) =>
          source.source.evidenceRefId === frozen.source.evidenceRefId &&
          source.revision === frozen.revision && source.digest === frozen.digest
        ))) {
        throw new ExecutionError("EXECUTION_SOURCE_REVISION_CONFLICT", 409);
      }
      this.sources.requireExternalInputs(definition, plan.roomId);
      const delegation = delegationId
        ? this.requireDelegation(
          delegationId,
          activatedBy,
          authorityMemberId,
          plan,
          candidate,
          definition,
          now
        )
        : undefined;
      const carryPlan = this.requireCarryCoverage(
        plan,
        definition,
        compiled,
        command
      );
      for (const selected of carryPlan) {
        this.requireCurrentLocalAuthority(
          plan,
          selected.node,
          selected.selection.sourceAdoptionId,
          now
        );
      }
      this.supersessions.beginActivation({
        operationId: command.operationId,
        planId,
        baseRevision: plan.current.revision,
        baseDigest: plan.current.digest,
        baseControlRevision: plan.controlRevision,
        candidateId: candidate.candidateId,
        candidateRevision: candidate.candidateRevision,
        candidateDigest: candidate.candidateDigest,
        rootTaskRevisionBefore: root.taskRevision,
        activatedBy,
        authorityMemberId,
        delegationId,
        reason: command.reason,
        requestDigest,
        now
      });
      this.insertCompilation(plan, candidate, definition, compiled);
      const fenced = this.tasks.fenceRevision({
        taskId: root.taskId,
        operationId: `op_${executionOperationDigest({
          purpose: "execution_root_supersession",
          operationId: command.operationId
        })}`,
        expectedTaskRevision: root.taskRevision,
        now
      });
      this.insertApproval(
        plan,
        candidate,
        compiled,
        authorityMemberId,
        command,
        fenced.taskRevision,
        now
      );
      const changed = this.database.prepare(`
        UPDATE execution_plans SET current_revision = ?,
          control_revision = control_revision + 1, updated_at = ?
        WHERE plan_id = ? AND current_revision = ? AND control_revision = ?
          AND state IN ('approved', 'running', 'paused', 'review')
      `).run(
        candidate.candidateRevision,
        now,
        planId,
        plan.current.revision,
        plan.controlRevision
      );
      if (changed.changes !== 1) {
        throw new ExecutionError("EXECUTION_REVISION_CONFLICT", 409);
      }
      const carryReceipts = carryPlan.map(({ node, selection, task }) =>
        this.carry.retain({
          planId,
          candidateRevision: candidate.candidateRevision,
          candidateDigest: candidate.candidateDigest,
          activationOperationId: command.operationId,
          activatedBy,
          delegationId,
          definition,
          node,
          task: this.taskSnapshot(task),
          selection,
          now
        }));
      if (delegation) {
        this.supersessions.consume(
          delegation.delegationId,
          command.operationId,
          now
        );
      }
      const current = this.plans.get(planId)!;
      const unsigned = {
        operationId: command.operationId,
        plan: current,
        candidate,
        activatedBy,
        delegationId,
        carryForward: carryReceipts,
        requestDigest,
        activatedAt: now
      };
      const receipt: ExecutionPlanSupersessionActivationReceipt = {
        ...unsigned,
        operationDigest: executionOperationDigest(unsigned)
      } as ExecutionPlanSupersessionActivationReceipt;
      this.supersessions.retainActivationReceipt(receipt);
      this.changed(plan.roomId);
      return receipt;
    });
  }

  private requireCarryCoverage(
    plan: ExecutionPlanProjection,
    definition: ExecutionPlanDefinition,
    compiled: CompiledNode[],
    command: ExecutionPlanSupersessionActivationCommand
  ): Array<CompiledNode & {
    selection: ExecutionPlanSupersessionActivationCommand["carryForward"][number];
  }> {
    const adopted = this.database.prepare(`
      SELECT adoption_id, adoption_digest, gate, node_key, source_task_id
      FROM execution_all_adopted_node_materializations
      WHERE plan_id = ? AND plan_revision = ?
      ORDER BY node_key COLLATE BINARY, gate COLLATE BINARY
    `).all(plan.planId, plan.current.revision) as AdoptedRow[];
    const keys = new Set<string>();
    for (const selection of command.carryForward) {
      const key = `${selection.targetNodeKey}\0${selection.gate}`;
      if (keys.has(key)) {
        throw new ExecutionError("EXECUTION_CARRY_SELECTION_DUPLICATE");
      }
      keys.add(key);
    }
    if (adopted.length !== command.carryForward.length) {
      throw new ExecutionError("EXECUTION_CARRY_COVERAGE_REQUIRED", 409);
    }
    const result = adopted.map((source) => {
      const target = compiled.find(({ task }) =>
        task.taskId === source.source_task_id);
      const selection = command.carryForward.find((entry) =>
        entry.targetNodeKey === target?.node.nodeKey &&
        entry.gate === source.gate &&
        entry.sourceAdoptionId === source.adoption_id &&
        entry.sourceAdoptionDigest === source.adoption_digest);
      if (!target || !selection) {
        throw new ExecutionError("EXECUTION_CARRY_COVERAGE_REQUIRED", 409);
      }
      return { ...target, selection };
    });
    const topology = validateExecutionPlanDefinition(definition).topologicalOrder;
    return result.sort((left, right) =>
      topology.indexOf(left.node.nodeKey) - topology.indexOf(right.node.nodeKey) ||
      binary(left.selection.gate, right.selection.gate)
    );
  }

  private activationTemplate(
    plan: ExecutionPlanProjection,
    root: AgentTaskRecord,
    candidate: ExecutionPlanSupersessionCandidate,
    now: string
  ): NonNullable<ExecutionPlanSupersessionControlView["activationTemplate"]> {
    if (candidate.baseRevision !== plan.current.revision ||
      candidate.baseDigest !== plan.current.digest ||
      candidate.baseControlRevision !== plan.controlRevision ||
      candidate.rootTaskRevision !== root.taskRevision ||
      candidate.candidateRevision !== plan.current.revision + 1) {
      throw new ExecutionError("EXECUTION_SUPERSESSION_CANDIDATE_CONFLICT", 409);
    }
    const definition = validateExecutionPlanDefinition(
      candidate.definition as ExecutionPlanDefinition
    ).definition;
    const compiled = this.compileFixedTaskSet(plan, definition);
    const adopted = this.database.prepare(`
      SELECT adoption_id, adoption_digest, gate, node_key, source_task_id
      FROM execution_all_adopted_node_materializations
      WHERE plan_id = ? AND plan_revision = ?
      ORDER BY node_key COLLATE BINARY, gate COLLATE BINARY
    `).all(plan.planId, plan.current.revision) as AdoptedRow[];
    const topology = validateExecutionPlanDefinition(definition).topologicalOrder;
    const carryForward = adopted.map((row) => {
      const source = this.carry.source(row.adoption_id);
      const target = compiled.find(({ task }) =>
        task.taskId === row.source_task_id
      );
      if (!source || !target ||
        source.adoption.planId !== plan.planId ||
        source.adoption.planRevision !== plan.current.revision ||
        source.adoption.adoptionDigest !== row.adoption_digest ||
        source.adoption.gate !== row.gate ||
        source.adoption.authority.service === "remote_evidence_adoption") {
        throw new ExecutionError("EXECUTION_CARRY_LOCAL_AUTHORITY_REQUIRED", 409);
      }
      this.requireCurrentLocalAuthority(
        plan,
        target.node,
        source.adoption.adoptionId,
        now
      );
      return {
        targetNodeKey: target.node.nodeKey,
        gate: row.gate,
        sourceAdoptionId: source.adoption.adoptionId,
        sourceAdoptionDigest: source.adoption.adoptionDigest,
        sourceReuseContractId: source.reuse.reuseContractId,
        sourceNodeReuseContractDigest: source.reuse.nodeReuseContractDigest,
        sourceReuseInputEvidenceDigest: source.reuse.reuseInputEvidenceDigest
      };
    }).sort((left, right) =>
      topology.indexOf(left.targetNodeKey) - topology.indexOf(right.targetNodeKey) ||
      binary(left.gate, right.gate)
    );
    return {
      expectedCurrentRevision: plan.current.revision,
      expectedCurrentDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      expectedRootTaskRevision: root.taskRevision,
      candidateId: candidate.candidateId,
      expectedCandidateRevision: candidate.candidateRevision,
      expectedCandidateDigest: candidate.candidateDigest,
      carryForward
    };
  }

  private delegationState(
    delegation: ExecutionReplanDelegation,
    plan: ExecutionPlanProjection,
    root: AgentTaskRecord,
    now: string
  ): ExecutionPlanSupersessionControlView["delegations"][number]["state"] {
    if (this.supersessions.isRevoked(delegation.delegationId)) return "revoked";
    if (this.supersessions.isConsumed(delegation.delegationId)) return "consumed";
    if (Date.parse(delegation.expiresAt) <= Date.parse(now)) return "expired";
    if (!this.supersessions.isCurrentDelegation(delegation)) return "superseded";
    if (delegation.planRevision !== plan.current.revision ||
      delegation.planDigest !== plan.current.digest ||
      delegation.planControlRevision !== plan.controlRevision ||
      delegation.rootTaskRevision !== root.taskRevision) return "stale";
    return "active";
  }

  private compileFixedTaskSet(
    plan: ExecutionPlanProjection,
    definition: ExecutionPlanDefinition
  ): CompiledNode[] {
    if (!activePlanStates.has(plan.state)) {
      throw new ExecutionError("EXECUTION_SUPERSESSION_STATE_INVALID", 409);
    }
    const expected = new Set(plan.compiledTasks.map(({ taskId }) => taskId));
    const actual = definition.nodes.map((node) => {
      if (node.task.mode !== "existing" || !node.task.taskId) {
        throw new ExecutionError("EXECUTION_SUPERSESSION_FIXED_TASK_SET_REQUIRED");
      }
      const task = this.tasks.get(node.task.taskId);
      if (!task || !expected.has(task.taskId) || task.roomId !== plan.roomId ||
        task.isDefault || task.lifecycleState === "completed" ||
        task.lifecycleState === "canceled" ||
        task.completionPolicy !== "accepted_result_required" ||
        task.taskRevision !== node.task.expectedTaskRevision ||
        task.definitionRevision !== node.task.definitionRevision ||
        task.criteriaRevision !== node.task.criteriaRevision ||
        !task.assignments.some(({ agentId }) => agentId === node.agentId)) {
        throw new ExecutionError("EXECUTION_SUPERSESSION_TASK_CONFLICT", 409);
      }
      const agent = this.core.getAgent(node.agentId);
      if (!agent || !agent.enabled || agent.teamId !== task.teamId ||
        !this.core.isRoomAgent(plan.roomId, node.agentId)) {
        throw new ExecutionError("EXECUTION_NODE_AGENT_UNAVAILABLE");
      }
      const owner = this.core.getMember(task.ownerMemberId);
      if (!owner || owner.teamId !== task.teamId ||
        !this.core.isRoomMember(plan.roomId, owner.memberId)) {
        throw new ExecutionError("EXECUTION_NODE_OWNER_UNAVAILABLE");
      }
      return { node, task };
    });
    const actualIds = new Set(actual.map(({ task }) => task.taskId));
    if (actualIds.size !== actual.length || actualIds.size !== expected.size ||
      [...expected].some((taskId) => !actualIds.has(taskId))) {
      throw new ExecutionError("EXECUTION_SUPERSESSION_FIXED_TASK_SET_REQUIRED");
    }
    return actual;
  }

  private requireDelegation(
    delegationId: string,
    actor: ExecutionPlanSupersessionActivationReceipt["activatedBy"],
    authorityMemberId: string,
    plan: ExecutionPlanProjection,
    candidate: ExecutionPlanSupersessionCandidate,
    definition: ExecutionPlanDefinition,
    now: string
  ): ExecutionReplanDelegation {
    const delegation = this.supersessions.getDelegation(delegationId);
    if (!delegation || actor.kind !== "agent" || !actor.agentId ||
      delegation.agentId !== actor.agentId ||
      delegation.issuedByMemberId !== authorityMemberId ||
      delegation.planId !== plan.planId ||
      delegation.planRevision !== plan.current.revision ||
      delegation.planDigest !== plan.current.digest ||
      delegation.planControlRevision !== plan.controlRevision ||
      delegation.rootTaskRevision !== this.requireRoot(plan).taskRevision ||
      Date.parse(delegation.expiresAt) <= Date.parse(now) ||
      !this.supersessions.isCurrentDelegation(delegation) ||
      this.supersessions.isRevoked(delegationId) ||
      this.supersessions.isConsumed(delegationId)) {
      throw new ExecutionError("EXECUTION_HUMAN_REVIEW_REQUIRED", 409);
    }
    const taskIds = plan.compiledTasks.map(({ taskId }) => taskId).sort(binary);
    if (!same(taskIds, delegation.taskIds) ||
      candidate.author.kind !== "agent" ||
      candidate.author.agentId !== actor.agentId ||
      candidate.author.runId !== actor.runId ||
      !this.isLowRisk(plan, definition)) {
      throw new ExecutionError("EXECUTION_HUMAN_REVIEW_REQUIRED", 409);
    }
    return delegation;
  }

  private isLowRisk(
    plan: ExecutionPlanProjection,
    next: ExecutionPlanDefinition
  ): boolean {
    if (next.policy.maxConcurrency > plan.current.definition.policy.maxConcurrency ||
      next.policy.budget.maxRunAttempts >
        plan.current.definition.policy.budget.maxRunAttempts ||
      next.policy.budget.maxExecutionDurationSeconds >
        plan.current.definition.policy.budget.maxExecutionDurationSeconds) {
      return false;
    }
    const { maxConcurrency: _oldConcurrency, budget: _oldBudget, ...oldPolicy } =
      plan.current.definition.policy;
    const { maxConcurrency: _newConcurrency, budget: _newBudget, ...newPolicy } =
      next.policy;
    if (!same(oldPolicy, newPolicy) ||
      !same(plan.current.definition.externalInputs, next.externalInputs)) {
      return false;
    }
    for (const compiled of plan.compiledTasks) {
      const oldNode = plan.current.definition.nodes.find(({ nodeKey }) =>
        nodeKey === compiled.nodeKey);
      const newNode = next.nodes.find((node) =>
        node.task.mode === "existing" && node.task.taskId === compiled.taskId);
      if (!oldNode || !newNode || oldNode.nodeKey !== newNode.nodeKey ||
        newNode.budget.maxRunAttempts > oldNode.budget.maxRunAttempts ||
        newNode.budget.maxExecutionDurationSeconds >
          oldNode.budget.maxExecutionDurationSeconds) {
        return false;
      }
      const { task: _oldTask, budget: _oldNodeBudget, ...oldContract } = oldNode;
      const { task: _newTask, budget: _newNodeBudget, ...newContract } = newNode;
      if (!same(oldContract, newContract)) return false;
    }
    return true;
  }

  private requireCurrentLocalAuthority(
    plan: ExecutionPlanProjection,
    node: ExecutionPlanDefinition["nodes"][number],
    sourceAdoptionId: string,
    now: string
  ): void {
    const source = this.carry.source(sourceAdoptionId);
    if (!source ||
      source.adoption.authority.service === "remote_evidence_adoption") {
      throw new ExecutionError("EXECUTION_CARRY_LOCAL_AUTHORITY_REQUIRED");
    }
    const authority = source.adoption.authority;
    if (!authority.agentId || !authority.deviceId || !authority.grantId ||
      !authority.grantRevision || !authority.grantDigest) {
      throw new ExecutionError("EXECUTION_CARRY_LOCAL_AUTHORITY_REQUIRED");
    }
    const expectedProfiles = node.verificationProfiles.map((profile) => ({
      profileId: profile.profileId,
      revision: profile.revision,
      digest: profile.digest
    }));
    const nowMs = Date.parse(now);
    const matches = this.connections.governedAgentReadyGrants(
      authority.deviceId,
      authority.agentId
    ).filter((grant) =>
      grant.planId === plan.planId && grant.nodeKey === node.nodeKey &&
      grant.agentId === node.agentId && grant.deviceId === authority.deviceId &&
      grant.repositoryId === node.repository.repositoryId &&
      grant.bindingId === node.repository.bindingId &&
      grant.grant.grantId === node.repository.grantId &&
      grant.grant.grantId === authority.grantId &&
      grant.grant.revision === node.repository.grantRevision &&
      grant.grant.revision === authority.grantRevision &&
      grant.grant.digest === authority.grantDigest &&
      grant.runtimeProfile.profileId === node.repository.runtimeProfileId &&
      grant.runtimeProfile.digest === node.repository.runtimeProfileDigest &&
      grant.revokedAt === null && same(grant.scopePolicy, node.scope) &&
      same(grant.verificationProfiles, expectedProfiles) &&
      Number.isFinite(nowMs) && Date.parse(grant.issuedAt) <= nowMs &&
      nowMs < Date.parse(grant.grant.expiresAt));
    if (matches.length !== 1) {
      throw new ExecutionError("EXECUTION_CARRY_LOCAL_AUTHORITY_UNAVAILABLE", 409);
    }
  }

  private insertCompilation(
    plan: ExecutionPlanProjection,
    candidate: ExecutionPlanSupersessionCandidate,
    definition: ExecutionPlanDefinition,
    compiled: CompiledNode[]
  ): void {
    for (const { node, task } of compiled) {
      this.database.prepare(`
        INSERT INTO execution_plan_nodes (
          plan_id, revision, node_key, task_id, task_revision,
          definition_revision, criteria_revision, agent_id, owner_member_id,
          node_json, task_snapshot_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.planId,
        candidate.candidateRevision,
        node.nodeKey,
        task.taskId,
        task.taskRevision,
        task.definitionRevision,
        task.criteriaRevision,
        node.agentId,
        task.ownerMemberId,
        canonicalExecutionJSON(node),
        canonicalExecutionJSON(this.taskSnapshot(task))
      );
      const claimed = this.database.prepare(`
        UPDATE execution_plan_task_claims SET revision = ?, node_key = ?
        WHERE task_id = ? AND plan_id = ? AND revision = ?
      `).run(
        candidate.candidateRevision,
        node.nodeKey,
        task.taskId,
        plan.planId,
        plan.current.revision
      );
      if (claimed.changes !== 1) {
        throw new ExecutionError("EXECUTION_SUPERSESSION_TASK_CONFLICT", 409);
      }
    }
    for (const edge of definition.edges) {
      this.database.prepare(`
        INSERT INTO execution_plan_edges (
          plan_id, revision, edge_key, from_node_key, to_node_key, gate,
          edge_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        plan.planId,
        candidate.candidateRevision,
        edge.edgeKey,
        edge.fromNodeKey,
        edge.toNodeKey,
        edge.gate,
        canonicalExecutionJSON(edge)
      );
    }
  }

  private insertApproval(
    plan: ExecutionPlanProjection,
    candidate: ExecutionPlanSupersessionCandidate,
    compiled: CompiledNode[],
    authorityMemberId: string,
    command: ExecutionPlanSupersessionActivationCommand,
    rootTaskRevisionAfter: number,
    now: string
  ): void {
    const compiledTasks = compiled.map(({ node, task }) => ({
      nodeKey: node.nodeKey,
      taskId: task.taskId,
      taskRevision: task.taskRevision,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision
    })).sort((left, right) => binary(left.nodeKey, right.nodeKey));
    const nextPlan: ExecutionPlanProjection = {
      ...plan,
      current: this.plans.revision(plan.planId, candidate.candidateRevision)!,
      controlRevision: plan.controlRevision + 1,
      compiledTasks,
      updatedAt: now
    };
    const approval = {
      operationId: command.operationId,
      planId: plan.planId,
      revision: candidate.candidateRevision,
      digest: candidate.candidateDigest,
      decision: "approved" as const,
      reason: command.reason,
      reviewedByMemberId: authorityMemberId,
      rootTaskRevisionBefore: command.expectedRootTaskRevision,
      rootTaskRevisionAfter,
      compiledTasks,
      reviewedAt: now
    };
    const response: ExecutionPlanApprovalReceipt = {
      plan: nextPlan,
      approval
    };
    this.database.prepare(`
      INSERT INTO execution_plan_approvals (
        operation_id, plan_id, revision, digest, decision, reason,
        reviewed_by_member_id, root_task_revision_before,
        root_task_revision_after, compiled_tasks_json, request_digest,
        response_json, reviewed_at
      ) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      command.operationId,
      plan.planId,
      candidate.candidateRevision,
      candidate.candidateDigest,
      command.reason,
      authorityMemberId,
      command.expectedRootTaskRevision,
      rootTaskRevisionAfter,
      canonicalExecutionJSON(compiledTasks),
      executionOperationDigest({
        purpose: "execution_supersession_approval_v1",
        command
      }),
      canonicalExecutionJSON(response),
      now
    );
  }

  private taskSnapshot(task: AgentTaskRecord) {
    return {
      taskId: task.taskId,
      roomId: task.roomId,
      parentTaskId: task.parentTaskId,
      title: task.title,
      goal: task.goal,
      ownerMemberId: task.ownerMemberId,
      completionPolicy: task.completionPolicy,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision,
      taskRevision: task.taskRevision,
      criteria: task.criteria,
      assignments: task.assignments,
      budgetPolicy: task.budgetPolicy
    };
  }

  private requirePlan(
    principal: WebPrincipal,
    planId: string
  ): ExecutionPlanProjection {
    const plan = this.plans.get(planId);
    if (!plan) throw new ExecutionError("EXECUTION_PLAN_NOT_FOUND", 404);
    this.auth.requireRoomMember(principal, plan.roomId);
    return plan;
  }

  private requireOwner(
    principal: WebPrincipal,
    plan: ExecutionPlanProjection
  ): MemberPrincipal {
    const member = this.auth.requireRoomMember(principal, plan.roomId);
    const root = this.requireRoot(plan);
    if (member.role !== "owner" && member.memberId !== root.ownerMemberId) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Task Owner or Team Owner required"
      );
    }
    return member;
  }

  private requireAuthorityMember(
    plan: ExecutionPlanProjection,
    memberId: string
  ): void {
    const root = this.requireRoot(plan);
    const member = this.core.getMember(memberId);
    if (!member || member.teamId !== root.teamId ||
      !this.core.isRoomMember(plan.roomId, memberId) ||
      (member.role !== "owner" && memberId !== root.ownerMemberId)) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Current Task Owner or Team Owner authority required"
      );
    }
  }

  private requireRoot(plan: ExecutionPlanProjection): AgentTaskRecord {
    const root = this.tasks.get(plan.rootTaskId);
    if (!root || root.isDefault || root.parentTaskId !== null ||
      root.lifecycleState === "completed" || root.lifecycleState === "canceled") {
      throw new ExecutionError("EXECUTION_ROOT_UNAVAILABLE");
    }
    return root;
  }

  private requireCurrentPins(
    plan: ExecutionPlanProjection,
    revision: number,
    digest: string,
    controlRevision: number
  ): void {
    if (!activePlanStates.has(plan.state) ||
      plan.current.revision !== revision || plan.current.digest !== digest ||
      plan.controlRevision !== controlRevision) {
      throw new ExecutionError("EXECUTION_REVISION_CONFLICT", 409);
    }
  }

  private changed(roomId: string): void {
    this.transactions.afterCommit(() => this.onChanged(roomId), {
      key: `execution:${roomId}`
    });
  }
}
