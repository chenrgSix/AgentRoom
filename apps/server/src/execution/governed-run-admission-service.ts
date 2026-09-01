import type Database from "better-sqlite3";
import type {
  GovernedExecutionCapabilityReadyGrant,
  GovernedExecutionManifest
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest,
  validateExecutionPlanDefinition
} from "@convene-wire/contracts/execution-validation";
import type { BridgeConnectionRegistry } from
  "../bridge/bridge-connection-registry.js";
import type { CoreRepository, MessageRecord } from
  "../data/core-repository.js";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRecord, RunRepository } from "../run/run-repository.js";
import { defaultRunDurationMilliseconds } from "../run/run-service.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "../task/task-repository.js";
import {
  planIsolatedWorkspace,
  type IsolatedWorkspaceLeaseService
} from "../workspace/isolated-workspace-lease-service.js";
import type { ExecutionApprovalRepository } from
  "./execution-approval-repository.js";
import type { ExecutionDependencyResolver } from
  "./execution-dependency-resolver.js";
import { ExecutionError } from "./execution-error.js";
import {
  evaluateExecutionReadiness,
  type ExecutionReadiness
} from "./execution-readiness-evaluator.js";
import type { ExecutionNodeIdentity } from
  "./execution-node-state-repository.js";
import type { ExecutionInputService } from "./execution-input-service.js";
import type { ExecutionPlanRepository } from
  "./execution-plan-repository.js";

export interface GovernedMessageAdmissionInput {
  member: { memberId: string; role: "owner" | "member" };
  message: MessageRecord;
  now: string;
  task: AgentTaskRecord;
}

export interface GovernedMessageAdmissionResult {
  created: boolean;
  runs: RunRecord[];
}

export interface GovernedMessageAdmissionPort {
  createRunsForMessage(
    input: GovernedMessageAdmissionInput
  ): GovernedMessageAdmissionResult | undefined;
}

interface GovernanceRow {
  node_key: string;
  plan_id: string;
  revision: number;
}

type AdmissionSource = "member_message" | "scheduler";

interface DispatchIntentRow {
  run_id: string;
}

const fail = (code: string): never => {
  throw new ExecutionError(code, 409);
};

const equal = (left: unknown, right: unknown): boolean =>
  canonicalExecutionJSON(left) === canonicalExecutionJSON(right);

/**
 * The sole initial RUN-018 admission path. It derives an exact frozen manifest
 * from an approved compiled node and one current path-free Bridge grant
 * summary. The summary is never treated as local bearer authority.
 */
export class GovernedRunAdmissionService
implements GovernedMessageAdmissionPort {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions: SqliteTransactionBoundary,
    private readonly core: CoreRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly plans: ExecutionPlanRepository,
    private readonly approvals: ExecutionApprovalRepository,
    private readonly inputs: ExecutionInputService,
    private readonly dependencies: ExecutionDependencyResolver,
    private readonly workspaces: IsolatedWorkspaceLeaseService,
    private readonly connections: BridgeConnectionRegistry,
    private readonly runs: RunRepository
  ) {}

  public createRunsForMessage(
    input: GovernedMessageAdmissionInput
  ): GovernedMessageAdmissionResult | undefined {
    const governance = this.database.prepare(`
      SELECT plan_id, revision, node_key
      FROM execution_active_task_governance
      WHERE task_id = ?
    `).get(input.task.taskId) as GovernanceRow | undefined;
    if (!governance) return undefined;
    return this.transactions.immediate(() =>
      this.admit(input, governance, "member_message")
    );
  }

  public readiness(
    identity: ExecutionNodeIdentity,
    now: string
  ): ExecutionReadiness {
    const plan = this.plans.get(identity.planId);
    const approval = plan && this.approvals.get(
      identity.planId,
      identity.planRevision
    );
    const node = plan?.current.definition.nodes.find(
      (candidate) => candidate.nodeKey === identity.nodeKey
    );
    const compiled = plan?.compiledTasks.find(
      (candidate) => candidate.nodeKey === identity.nodeKey
    );
    const task = compiled ? this.tasks.get(compiled.taskId) : undefined;
    const dependency = this.dependencies.resolve(identity);
    const agent = node ? this.database.prepare(`
      SELECT device_id, team_id, capabilities_json
      FROM agents
      WHERE agent_id = ? AND enabled = 1 AND integration_mode = 'managed'
    `).get(node.agentId) as {
      capabilities_json: string;
      device_id: string | null;
      team_id: string;
    } | undefined : undefined;
    let capabilityAvailable = false;
    if (agent?.device_id && node) {
      const current = this.connections.governedAgentExecutionCapability(
        agent.device_id,
        node.agentId
      );
      try {
        const persisted = (JSON.parse(agent.capabilities_json) as {
          governedExecution?: unknown;
        }).governedExecution;
        assertExecutionCommand("executionCapability", persisted);
        capabilityAvailable = Boolean(
          current &&
          this.connections.supportsGovernedAgentExecution(
            agent.device_id,
            node.agentId
          ) &&
          equal(current, persisted)
        );
      } catch {
        capabilityAvailable = false;
      }
    }
    const usage = this.database.prepare(`
      SELECT
        count(*) AS attempts,
        coalesce(sum(max(0, cast(
          (julianday(CASE WHEN run.state IN (
            'queued', 'delivered', 'working', 'input_required'
          ) THEN run.deadline_at ELSE coalesce(run.terminal_at, run.updated_at) END) -
            julianday(run.created_at)) * 86400 AS INTEGER
        ))), 0) AS duration_seconds,
        coalesce(sum(CASE WHEN run.state IN (
          'queued', 'delivered', 'working', 'input_required'
        ) THEN 1 ELSE 0 END), 0) AS active_runs
      FROM execution_dispatch_intents intent
      JOIN runs run ON run.run_id = intent.run_id
      WHERE intent.plan_id = ? AND intent.plan_revision = ?
    `).get(identity.planId, identity.planRevision) as {
      active_runs: number;
      attempts: number;
      duration_seconds: number;
    };
    const activeAgentRuns = node ? (this.database.prepare(`
      SELECT count(*) AS count
      FROM execution_dispatch_intents intent
      JOIN runs run ON run.run_id = intent.run_id
      WHERE intent.agent_id = ? AND run.state IN (
        'queued', 'delivered', 'working', 'input_required'
      )
    `).get(node.agentId) as { count: number }).count : 0;
    const existingAttempt = Boolean(this.database.prepare(`
      SELECT 1 FROM execution_dispatch_intents
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ?
    `).get(identity.planId, identity.planRevision, identity.nodeKey));
    const reviewer = approval
      ? this.core.getMember(approval.reviewedByMemberId)
      : undefined;
    const reviewerCurrent = Boolean(
      reviewer && task &&
      reviewer.teamId === task.teamId &&
      this.core.isRoomMember(task.roomId, reviewer.memberId) &&
      (reviewer.role === "owner" || reviewer.memberId === task.ownerMemberId)
    );
    const planCurrent = Boolean(
      plan && approval && node && compiled &&
      plan.current.revision === identity.planRevision &&
      ["approved", "running"].includes(plan.state) &&
      plan.current.digest === approval.digest &&
      approval.decision === "approved" && reviewerCurrent
    );
    const agentAvailable = Boolean(
      task && node && agent?.device_id && agent.team_id === task.teamId
    );
    const grants = plan && node && agent?.device_id
      ? this.matchingGrants(plan.planId, node, agent.device_id, now)
      : [];
    const nowMs = Date.parse(now);
    const grantExpiry = grants.length === 1
      ? Date.parse(grants[0]!.grant.expiresAt)
      : Number.NaN;
    const nextRunReservationSeconds = Number.isFinite(nowMs) &&
      Number.isFinite(grantExpiry)
      ? Math.max(0, Math.ceil((Math.min(
          nowMs + defaultRunDurationMilliseconds,
          grantExpiry
        ) - nowMs) / 1_000))
      : 0;
    const policy = plan?.current.definition.policy;
    return evaluateExecutionReadiness({
      activeAgentRuns,
      activePlanRuns: usage.active_runs,
      agentAvailable,
      capabilityAvailable,
      dependencyBlocker: dependency.ready ? null : dependency.blocker,
      existingAttempt,
      grantMatches: grants.length,
      nodeKind: node?.kind ?? "verification",
      nextRunReservationSeconds,
      outputsSupported: Boolean(node &&
        !node.outputs.some((output) =>
          output.required && !["patch", "commit"].includes(output.kind)
        ) && node.outputs.some((output) =>
          ["patch", "commit"].includes(output.kind)
        )),
      planAttempts: usage.attempts,
      planCurrent,
      planDurationSeconds: usage.duration_seconds,
      planMaxConcurrency: policy?.maxConcurrency ?? 1,
      planMaxDurationSeconds:
        policy?.budget.maxExecutionDurationSeconds ?? 0,
      planMaxRunAttempts: policy?.budget.maxRunAttempts ?? 0,
      taskBudgetAvailable: Boolean(task &&
        task.budgetUsage.runAttempts < task.budgetPolicy.maxRunAttempts &&
        task.budgetUsage.executionDurationSeconds + nextRunReservationSeconds <=
          task.budgetPolicy.maxExecutionDurationSeconds),
      taskPinsCurrent: Boolean(task && node && compiled &&
        compiled.taskId === task.taskId &&
        compiled.definitionRevision === task.definitionRevision &&
        compiled.criteriaRevision === task.criteriaRevision &&
        task.assignments.some((assignment) =>
          assignment.agentId === node.agentId
        )),
      taskRunnable: Boolean(task &&
        ["ready", "active", "review"].includes(task.lifecycleState) &&
        task.schedulingState === "enabled")
    });
  }

  public admitScheduled(
    identity: ExecutionNodeIdentity,
    now: string
  ): GovernedMessageAdmissionResult {
    return this.transactions.immediate(() => {
      const existing = this.findIntentRun(identity);
      if (existing) return { created: false, runs: [existing] };
      const readiness = this.readiness(identity, now);
      if (!readiness.ready) fail(readiness.blocker);
      const plan = this.plans.get(identity.planId)!;
      const approval = this.approvals.get(
        identity.planId,
        identity.planRevision
      )!;
      const compiled = plan.compiledTasks.find(
        (candidate) => candidate.nodeKey === identity.nodeKey
      )!;
      const task = this.tasks.get(compiled.taskId)!;
      const member = this.core.getMember(approval.reviewedByMemberId);
      if (!member) return fail("EXECUTION_DISPATCH_OWNER_REQUIRED");
      const message = this.core.appendMessage({
        messageId: createOpaqueId("msg"),
        roomId: task.roomId,
        taskId: task.taskId,
        senderType: "system",
        senderId: "execution-scheduler",
        content: `Execution Plan ${plan.planId} scheduled node ${identity.nodeKey}.`,
        mentions: [],
        parentMessageId: null,
        createdAt: now
      });
      return this.admit({
        member: { memberId: member.memberId, role: member.role },
        message,
        now,
        task
      }, {
        plan_id: identity.planId,
        revision: identity.planRevision,
        node_key: identity.nodeKey
      }, "scheduler");
    });
  }

  private admit(
    input: GovernedMessageAdmissionInput,
    governance: GovernanceRow,
    source: AdmissionSource
  ): GovernedMessageAdmissionResult {
    const { member, message, now, task } = input;
    const existing = this.runs.findByTrigger(message.messageId);
    if (existing.length > 0) return { created: false, runs: existing };
    const intentRun = this.findIntentRun({
      planId: governance.plan_id,
      planRevision: governance.revision,
      nodeKey: governance.node_key
    });
    if (intentRun) return { created: false, runs: [intentRun] };
    if (source === "member_message" &&
      member.role !== "owner" && member.memberId !== task.ownerMemberId) {
      return fail("EXECUTION_DISPATCH_OWNER_REQUIRED");
    }
    if (source === "member_message" && message.mentions.length !== 1) {
      return fail("EXECUTION_DISPATCH_TARGET_INVALID");
    }
    const plan = this.plans.get(governance.plan_id);
    const approval = plan && this.approvals.get(
      plan.planId,
      governance.revision
    );
    if (
      !plan ||
      !approval ||
      !["approved", "running"].includes(plan.state) ||
      plan.current.revision !== governance.revision ||
      plan.current.digest !== approval.digest ||
      plan.controlRevision < 1 ||
      approval.decision !== "approved"
    ) {
      return fail("EXECUTION_DISPATCH_PLAN_STALE");
    }
    const validated = validateExecutionPlanDefinition(plan.current.definition);
    if (validated.digest !== plan.current.digest) {
      return fail("EXECUTION_DISPATCH_PLAN_STALE");
    }
    const node = validated.definition.nodes.find(
      (candidate) => candidate.nodeKey === governance.node_key
    );
    const compiled = plan.compiledTasks.find(
      (candidate) => candidate.nodeKey === governance.node_key
    );
    const targetAgentId = source === "scheduler"
      ? node?.agentId
      : message.mentions[0]?.targetAgentId;
    if (
      !node ||
      !compiled ||
      compiled.taskId !== task.taskId ||
      compiled.definitionRevision !== task.definitionRevision ||
      compiled.criteriaRevision !== task.criteriaRevision ||
      node.agentId !== targetAgentId ||
      !task.assignments.some((assignment) =>
        assignment.agentId === node.agentId
      ) ||
      !node.repository ||
      node.kind !== "implementation"
    ) {
      return fail("EXECUTION_DISPATCH_SCOPE_INVALID");
    }
    const dependency = this.dependencies.resolve({
      planId: plan.planId,
      planRevision: plan.current.revision,
      nodeKey: node.nodeKey
    });
    if (!dependency.ready) return fail(dependency.blocker);
    const agent = this.database.prepare(`
      SELECT device_id, team_id, capabilities_json
      FROM agents
      WHERE agent_id = ? AND enabled = 1 AND integration_mode = 'managed'
    `).get(node.agentId) as {
      capabilities_json: string;
      device_id: string | null;
      team_id: string;
    } | undefined;
    if (
      !agent?.device_id ||
      agent.team_id !== task.teamId ||
      !this.connections.supportsGovernedAgentExecution(
        agent.device_id,
        node.agentId
      )
    ) {
      return fail("EXECUTION_DISPATCH_CAPABILITY_UNAVAILABLE");
    }
    const currentCapability = this.connections.governedAgentExecutionCapability(
      agent.device_id,
      node.agentId
    );
    let persistedCapability: unknown;
    try {
      persistedCapability = (JSON.parse(agent.capabilities_json) as {
        governedExecution?: unknown;
      }).governedExecution;
      assertExecutionCommand("executionCapability", persistedCapability);
    } catch {
      return fail("EXECUTION_DISPATCH_CAPABILITY_UNAVAILABLE");
    }
    if (!currentCapability || !equal(currentCapability, persistedCapability)) {
      return fail("EXECUTION_DISPATCH_CAPABILITY_UNAVAILABLE");
    }
    const grant = this.exactGrant(
      plan.planId,
      node,
      agent.device_id,
      now
    );
    const nowMs = Date.parse(now);
    const grantExpiry = Date.parse(grant.grant.expiresAt);
    if (!Number.isFinite(nowMs) || !Number.isFinite(grantExpiry)) {
      return fail("EXECUTION_DISPATCH_TIME_INVALID");
    }
    const deadlineAt = new Date(Math.min(
      nowMs + defaultRunDurationMilliseconds,
      grantExpiry
    )).toISOString();
    if (Date.parse(deadlineAt) <= nowMs) {
      return fail("EXECUTION_DISPATCH_GRANT_UNAVAILABLE");
    }
    const unsupportedRequiredOutput = node.outputs.some((output) =>
      output.required && output.kind !== "patch" && output.kind !== "commit"
    );
    const captureOutputCandidates = node.outputs
      .filter((output) => output.kind === "patch" || output.kind === "commit")
      .map((output) => ({
        slotKey: output.slotKey,
        title: `${node.nodeKey} ${output.kind}`,
        summary: `Captured governed ${output.kind} output for ${node.nodeKey}.`,
        path: null
      }));
    const firstCaptureOutput = captureOutputCandidates[0];
    if (unsupportedRequiredOutput || !firstCaptureOutput) {
      return fail("EXECUTION_CAPTURE_OUTPUT_UNSUPPORTED");
    }
    const captureOutputs: NonNullable<
      GovernedExecutionManifest["capture"]
    >["outputs"] = [
      firstCaptureOutput,
      ...captureOutputCandidates.slice(1)
    ];
    const dispatchGeneration = this.nextDispatchGeneration(
      plan.planId,
      plan.current.revision,
      node.nodeKey
    );
    if (source === "scheduler" && dispatchGeneration !== 1) {
      return fail("EXECUTION_AUTOMATIC_RETRY_FORBIDDEN");
    }
    const runId = createOpaqueId("run");
    const run: RunRecord = {
      runId,
      traceId: message.traceId,
      roomId: message.roomId,
      taskId: task.taskId,
      triggerMessageId: message.messageId,
      requesterMemberId: member.memberId,
      targetAgentId: node.agentId,
      parentRunId: null,
      instruction: source === "scheduler" ? task.goal : message.content,
      state: "queued",
      lastSequence: 0,
      deadlineAt,
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    };
    const requestDigest = executionOperationDigest({
      action: "governed_run_admission_v2",
      source,
      run,
      planId: plan.planId,
      planRevision: plan.current.revision,
      planDigest: plan.current.digest,
      planControlRevision: plan.controlRevision,
      approvalOperationId: approval.operationId,
      nodeKey: node.nodeKey,
      dispatchGeneration,
      inputSelections: dependency.selections,
      grant
    });
    this.database.prepare(`
      INSERT INTO execution_dispatch_intents (
        intent_id, source, plan_id, plan_revision, plan_digest,
        plan_control_revision, approval_operation_id, node_key,
        dispatch_generation, task_id, room_id, agent_id, device_id, run_id,
        trace_message_id, requester_member_id, operation_digest, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      createOpaqueId("dispatch"),
      source,
      plan.planId,
      plan.current.revision,
      plan.current.digest,
      plan.controlRevision,
      approval.operationId,
      node.nodeKey,
      dispatchGeneration,
      task.taskId,
      task.roomId,
      node.agentId,
      agent.device_id,
      runId,
      message.messageId,
      member.memberId,
      requestDigest,
      now
    );
    this.database.prepare(`
      INSERT INTO execution_run_admissions (
        run_id, plan_id, plan_revision, plan_digest, plan_control_revision,
        approval_operation_id, node_key, dispatch_generation, task_id,
        room_id, agent_id, device_id, trigger_message_id,
        requester_member_id, deadline_at, grant_json, manifest_digest,
        request_digest, admitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      runId,
      plan.planId,
      plan.current.revision,
      plan.current.digest,
      plan.controlRevision,
      approval.operationId,
      node.nodeKey,
      dispatchGeneration,
      task.taskId,
      task.roomId,
      node.agentId,
      agent.device_id,
      message.messageId,
      member.memberId,
      deadlineAt,
      canonicalExecutionJSON(grant),
      requestDigest,
      now
    );
    let manifest: GovernedExecutionManifest | undefined;
    const created = this.runs.createGovernedRun(run, () => {
      const frozenInputs = this.inputs.freezeForRun({
        planId: plan.planId,
        revision: plan.current.revision,
        expectedDigest: plan.current.digest,
        expectedControlRevision: plan.controlRevision,
        nodeKey: node.nodeKey,
        runId,
        deviceId: agent.device_id!,
        selections: dependency.selections,
        expiresAt: deadlineAt
      }, now);
      const scope: GovernedExecutionManifest["scope"] = {
        planId: plan.planId,
        planRevision: plan.current.revision,
        planDigest: plan.current.digest,
        approvalOperationId: approval.operationId,
        planControlRevision: plan.controlRevision,
        nodeKey: node.nodeKey,
        dispatchGeneration,
        roomId: task.roomId,
        taskId: task.taskId,
        taskRevision: task.taskRevision,
        definitionRevision: task.definitionRevision,
        criteriaRevision: task.criteriaRevision,
        runId,
        agentId: node.agentId,
        deviceId: agent.device_id!
      };
      const workspace = planIsolatedWorkspace(
        scope,
        node.repository!,
        now,
        deadlineAt
      );
      const unsigned = {
        version: 1 as const,
        scope,
        repository: node.repository!,
        grant: structuredClone(grant.grant),
        workspace,
        inputs: frozenInputs,
        inputDigest: executionOperationDigest(frozenInputs),
        scopePolicy: node.scope,
        verificationProfiles: node.verificationProfiles,
        outputs: node.outputs,
        capture: {
          operationId: `op_${executionOperationDigest({
            purpose: "governed_capture_v1",
            runId,
            planId: plan.planId,
            planRevision: plan.current.revision,
            nodeKey: node.nodeKey,
            dispatchGeneration
          })}`,
          rootTaskId: plan.rootTaskId,
          outputs: captureOutputs
        },
        deadline: deadlineAt
      };
      const builtManifest: GovernedExecutionManifest = {
        ...unsigned,
        manifestDigest: executionOperationDigest(unsigned)
      };
      assertExecutionCommand("executionManifest", builtManifest);
      const sealed = this.database.prepare(`
        UPDATE execution_run_admissions SET manifest_digest = ?
        WHERE run_id = ? AND manifest_digest IS NULL
      `).run(builtManifest.manifestDigest, runId);
      if (sealed.changes !== 1) {
        return fail("EXECUTION_DISPATCH_MANIFEST_CONFLICT");
      }
      manifest = builtManifest;
      return builtManifest;
    });
    if (!manifest) return fail("EXECUTION_DISPATCH_MANIFEST_CONFLICT");
    this.workspaces.reserveForRun(manifest, now);
    return { created: true, runs: [created] };
  }

  private exactGrant(
    planId: string,
    node: ReturnType<typeof validateExecutionPlanDefinition>["definition"]["nodes"][number],
    deviceId: string,
    now: string
  ): GovernedExecutionCapabilityReadyGrant {
    const matches = this.matchingGrants(planId, node, deviceId, now);
    if (matches.length !== 1) {
      return fail(matches.length === 0
        ? "EXECUTION_DISPATCH_GRANT_UNAVAILABLE"
        : "EXECUTION_DISPATCH_GRANT_AMBIGUOUS");
    }
    return matches[0]!;
  }

  private matchingGrants(
    planId: string,
    node: ReturnType<typeof validateExecutionPlanDefinition>["definition"]["nodes"][number],
    deviceId: string,
    now: string
  ): GovernedExecutionCapabilityReadyGrant[] {
    const expectedProfiles = node.verificationProfiles.map((profile) => ({
      profileId: profile.profileId,
      revision: profile.revision,
      digest: profile.digest
    }));
    const expectedOperations = node.verificationProfiles.some(
      (profile) => profile.required
    )
      ? ["prepare", "capture", "verify"]
      : ["prepare", "capture"];
    const nowMs = Date.parse(now);
    return this.connections.governedAgentReadyGrants(
      deviceId,
      node.agentId
    ).filter((grant) =>
      grant.planId === planId &&
      grant.nodeKey === node.nodeKey &&
      grant.repositoryId === node.repository?.repositoryId &&
      grant.bindingId === node.repository.bindingId &&
      grant.grant.grantId === node.repository.grantId &&
      grant.grant.revision === node.repository.grantRevision &&
      grant.runtimeProfile.profileId === node.repository.runtimeProfileId &&
      grant.runtimeProfile.revision === 1 &&
      grant.runtimeProfile.digest === node.repository.runtimeProfileDigest &&
      grant.revokedAt === null &&
      grant.operations.length === expectedOperations.length &&
      expectedOperations.every((operation) =>
        grant.operations.includes(operation as "prepare" | "capture" | "verify")
      ) &&
      grant.integrationTargets.length === 0 &&
      equal(grant.scopePolicy, node.scope) &&
      equal(grant.verificationProfiles, expectedProfiles) &&
      Number.isFinite(nowMs) &&
      Date.parse(grant.issuedAt) <= nowMs &&
      nowMs < Date.parse(grant.grant.expiresAt)
    );
  }

  private findIntentRun(
    identity: ExecutionNodeIdentity
  ): RunRecord | undefined {
    const row = this.database.prepare(`
      SELECT run_id FROM execution_dispatch_intents
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ?
      ORDER BY dispatch_generation DESC LIMIT 1
    `).get(
      identity.planId,
      identity.planRevision,
      identity.nodeKey
    ) as DispatchIntentRow | undefined;
    return row ? this.runs.getRun(row.run_id) : undefined;
  }

  private nextDispatchGeneration(
    planId: string,
    planRevision: number,
    nodeKey: string
  ): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(dispatch_generation), 0) + 1 AS generation
      FROM execution_dispatch_intents
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ?
    `).get(planId, planRevision, nodeKey) as { generation: number };
    if (!Number.isSafeInteger(row.generation) || row.generation < 1) {
      return fail("EXECUTION_DISPATCH_GENERATION_EXHAUSTED");
    }
    return row.generation;
  }
}
