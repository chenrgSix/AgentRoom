import type Database from "better-sqlite3";
import type { GovernedExecutionManifest as Manifest } from "@convene-wire/contracts/execution-plan";
import { assertExecutionCommand, canonicalExecutionJSON, executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import type { BridgeConnectionRegistry } from "../bridge/bridge-connection-registry.js";
import { ExecutionError } from "../execution/execution-error.js";
import type { ExecutionPlanRepository } from "../execution/execution-plan-repository.js";
import { AuthorizationError, type DevicePrincipal } from "../security/auth-service.js";

type Lease = Manifest["workspace"];
type Kind = "advance" | "revoke" | "release";
interface Row {
  lease_id: string; run_id: string; team_id: string; owner_member_id: string; device_id: string;
  manifest_digest: string; lease_json: string; lease_digest: string;
}
interface Operation {
  operation_id: string; lease_id: string; revision: number; kind: Kind;
  expected_generation: string; generation: string; request_digest: string; recorded_at: string;
}
export interface IsolatedWorkspaceState {
  lease: Lease; revision: number; generation: string; state: "active" | "expired" | "revoked" | "released";
}
export interface WorkspaceOperationCommand {
  operationId: string; leaseId: string; expectedRevision: number; expectedGeneration: string;
}
const fail = (code: string): never => { throw new ExecutionError(code, 409); };
const equal = (a: unknown, b: unknown) => canonicalExecutionJSON(a) === canonicalExecutionJSON(b);

/** Coordination identities, not local paths, permissions, or proof of a stopped writer. */
export function planIsolatedWorkspace(
  scope: Manifest["scope"], repository: Manifest["repository"], issuedAt: string, expiresAt: string
): Lease {
  const identity = executionOperationDigest({ purpose: "isolated_attempt_v1", runId: scope.runId,
    deviceId: scope.deviceId, planId: scope.planId, planRevision: scope.planRevision,
    nodeKey: scope.nodeKey, dispatchGeneration: scope.dispatchGeneration });
  return { leaseId: `lease_${identity}`, workspaceRef: `workspace_${identity}`,
    workspaceGeneration: executionOperationDigest({ identity, repository, generation: 1 }),
    mode: "isolated_worktree", issuedAt, expiresAt };
}

/** Internal ports for Run admission and authenticated Repository operations. No filesystem IO. */
export class IsolatedWorkspaceLeaseService {
  public constructor(
    private readonly database: Database.Database,
    private readonly plans: ExecutionPlanRepository,
    private readonly connections: BridgeConnectionRegistry
  ) {}

  public reserveForRun(manifest: Manifest, now: string): IsolatedWorkspaceState {
    if (!this.database.inTransaction) return fail("WORKSPACE_TRANSACTION_REQUIRED");
    this.validateManifest(manifest);
    const owner = this.requireScope(manifest, true);
    const expected = planIsolatedWorkspace(manifest.scope, manifest.repository,
      manifest.workspace.issuedAt, manifest.workspace.expiresAt);
    if (!equal(expected, manifest.workspace)) return fail("WORKSPACE_ATTEMPT_IDENTITY_CONFLICT");
    this.requireTime(manifest, now);
    const existing = this.rowForRun(manifest.scope.runId);
    if (existing) {
      if (existing.manifest_digest !== manifest.manifestDigest) return fail("WORKSPACE_RESERVATION_CONFLICT");
      const state = this.project(existing, now);
      if (state.state !== "active") return fail("WORKSPACE_LEASE_INACTIVE");
      return state;
    }
    const s = manifest.scope, lease = manifest.workspace;
    if (this.database.prepare(`SELECT 1 FROM isolated_workspace_leases
      WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND dispatch_generation = ?`)
      .get(s.planId, s.planRevision, s.nodeKey, s.dispatchGeneration)) return fail("WORKSPACE_ATTEMPT_IDENTITY_CONFLICT");
    this.database.prepare(`INSERT INTO isolated_workspace_leases (
      lease_id, run_id, plan_id, plan_revision, node_key, task_id, dispatch_generation,
      team_id, room_id, agent_id, device_id, owner_member_id, workspace_ref, initial_generation,
      manifest_digest, lease_digest, lease_json, issued_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(lease.leaseId, s.runId, s.planId, s.planRevision, s.nodeKey, s.taskId, s.dispatchGeneration,
        owner.team_id, s.roomId, s.agentId, s.deviceId, owner.owner_member_id, lease.workspaceRef,
        lease.workspaceGeneration, manifest.manifestDigest, executionOperationDigest(lease), canonicalExecutionJSON(lease),
        lease.issuedAt, lease.expiresAt);
    return this.project(this.row(lease.leaseId), now);
  }

  public requireActiveForDevice(principal: DevicePrincipal, leaseId: string, now: string): IsolatedWorkspaceState {
    const row = this.row(leaseId);
    this.requireDevice(principal, row);
    const run = this.database.prepare("SELECT context_manifest_json FROM runs WHERE run_id = ?")
      .get(row.run_id) as { context_manifest_json: string | null };
    if (!run.context_manifest_json) return fail("WORKSPACE_MANIFEST_REQUIRED");
    const context = JSON.parse(run.context_manifest_json);
    const manifest = context.execution as Manifest;
    this.validateManifest(manifest);
    if (manifest.manifestDigest !== row.manifest_digest || !equal(manifest.workspace, JSON.parse(row.lease_json)) ||
      context.runId !== manifest.scope.runId || context.taskId !== manifest.scope.taskId ||
      context.taskRevision !== manifest.scope.taskRevision || context.definitionRevision !== manifest.scope.definitionRevision ||
      context.criteriaRevision !== manifest.scope.criteriaRevision || context.target?.deviceId !== principal.deviceId ||
      context.target?.agentId !== manifest.scope.agentId) return fail("WORKSPACE_MANIFEST_CONFLICT");
    this.requireScope(manifest, false);
    this.requireTime(manifest, now);
    const state = this.project(row, now);
    if (state.state !== "active") return fail("WORKSPACE_LEASE_INACTIVE");
    return state;
  }

  /** Called only after the Repository owner authenticates the exact capture operation. */
  public advanceForDevice(principal: DevicePrincipal, command: WorkspaceOperationCommand & { generation: string }, now: string) {
    return this.database.transaction(() => {
      const current = this.requireActiveForDevice(principal, command.leaseId, now);
      return this.append(principal, command, "advance", command.generation, current, now);
    }).immediate();
  }

  /** Reduces coordination authority only. Does not free Run capacity or authorize cleanup. */
  public closeForDevice(principal: DevicePrincipal, command: WorkspaceOperationCommand, kind: "revoke" | "release", now: string) {
    return this.database.transaction(() => {
      const row = this.row(command.leaseId);
      this.requireDevice(principal, row);
      return this.append(principal, command, kind, command.expectedGeneration, this.project(row, now), now);
    }).immediate();
  }

  private append(principal: DevicePrincipal, command: WorkspaceOperationCommand, kind: Kind,
    generation: string, current: IsolatedWorkspaceState, now: string): IsolatedWorkspaceState {
    if (!/^op_[A-Za-z0-9_-]{8,128}$/u.test(command.operationId) || !/^[0-9a-f]{64}$/u.test(generation) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1 ||
      !Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(current.lease.issuedAt)) return fail("WORKSPACE_OPERATION_INVALID");
    const digest = executionOperationDigest({ command, kind, generation,
      deviceId: principal.deviceId, ownerMemberId: principal.ownerMemberId });
    const previous = this.database.prepare("SELECT * FROM isolated_workspace_operations WHERE operation_id = ?")
      .get(command.operationId) as Operation | undefined;
    if (previous) {
      if (previous.request_digest !== digest || previous.lease_id !== command.leaseId) return fail("WORKSPACE_OPERATION_CONFLICT");
      return this.projectOperation(current.lease, previous, now);
    }
    if ((kind === "advance" && current.state !== "active") ||
      current.state === "released" || current.state === "revoked" || current.revision >= Number.MAX_SAFE_INTEGER ||
      current.revision !== command.expectedRevision || current.generation !== command.expectedGeneration ||
      (kind === "advance" && (generation === current.generation || generation === current.lease.workspaceGeneration))) {
      return fail("WORKSPACE_GENERATION_CONFLICT");
    }
    if (kind === "advance" && this.database.prepare(`SELECT 1 FROM isolated_workspace_operations
      WHERE lease_id = ? AND kind = 'advance' AND generation = ?`).get(command.leaseId, generation)) {
      return fail("WORKSPACE_GENERATION_CONFLICT");
    }
    this.database.prepare(`INSERT INTO isolated_workspace_operations
      (operation_id, lease_id, revision, kind, expected_generation, generation, request_digest, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(command.operationId, command.leaseId, current.revision + 1, kind,
        command.expectedGeneration, generation, digest, now);
    return this.project(this.row(command.leaseId), now);
  }

  private validateManifest(manifest: Manifest): void {
    assertExecutionCommand("executionManifest", manifest);
    const { manifestDigest, ...unsigned } = manifest;
    if (executionOperationDigest(unsigned) !== manifestDigest || executionOperationDigest(manifest.inputs) !== manifest.inputDigest) {
      return fail("WORKSPACE_MANIFEST_CONFLICT");
    }
  }

  private requireTime(manifest: Manifest, now: string): void {
    const at = Date.parse(now), start = Date.parse(manifest.workspace.issuedAt), end = Date.parse(manifest.workspace.expiresAt);
    if (!Number.isFinite(at) || at < start || end <= at || end > Date.parse(manifest.deadline) ||
      end > Date.parse(manifest.grant.expiresAt)) return fail("WORKSPACE_LEASE_EXPIRED");
  }

  private requireScope(manifest: Manifest, admission: boolean) {
    const s = manifest.scope, plan = this.plans.get(s.planId);
    const node = plan?.current.definition.nodes.find((entry) => entry.nodeKey === s.nodeKey);
    if (!plan || !node || plan.current.revision !== s.planRevision || plan.current.digest !== s.planDigest ||
      !(admission ? ["approved", "running"] : ["approved", "running", "paused", "review"]).includes(plan.state) ||
      (admission && plan.controlRevision !== s.planControlRevision) || !equal(node.repository, manifest.repository) ||
      !equal(node.scope, manifest.scopePolicy) || !equal(node.verificationProfiles, manifest.verificationProfiles) ||
      !equal(node.outputs, manifest.outputs) || manifest.grant.grantId !== node.repository?.grantId ||
      manifest.grant.revision !== node.repository?.grantRevision) return fail("WORKSPACE_PLAN_CONFLICT");
    const capability = this.connections.governedExecutionCapability(s.deviceId);
    if (!capability || !this.connections.supportsGovernedExecution(s.deviceId) ||
      (node.scope.requirePreventivePathEnforcement && !capability.preventivePathEnforcement)) {
      return fail("WORKSPACE_CAPABILITY_UNAVAILABLE");
    }
    const owner = this.database.prepare(`SELECT device.owner_member_id, device.team_id,
      run.deadline_at, run.context_manifest_json, task.task_revision
      FROM runs run JOIN agent_tasks task ON task.task_id = run.task_id AND task.room_id = run.room_id
      JOIN rooms room ON room.room_id = run.room_id AND room.archived_at IS NULL
      JOIN teams team ON team.team_id = room.team_id AND team.archived_at IS NULL
      JOIN agents agent ON agent.agent_id = run.target_agent_id AND agent.enabled = 1 AND agent.integration_mode = 'managed'
      JOIN devices device ON device.device_id = agent.device_id AND device.status = 'active'
      JOIN team_members member ON member.member_id = device.owner_member_id AND member.team_id = room.team_id
      JOIN room_human_participants human ON human.room_id = room.room_id AND human.member_id = member.member_id
      JOIN room_human_participants task_owner ON task_owner.room_id = room.room_id AND task_owner.member_id = task.owner_member_id
      JOIN room_agent_participants participant ON participant.room_id = room.room_id AND participant.agent_id = agent.agent_id
      JOIN agent_tasks root ON root.task_id = @rootTaskId AND root.room_id = room.room_id
        AND root.owner_member_id = @rootOwner AND root.lifecycle_state NOT IN ('completed', 'canceled')
      JOIN room_human_participants root_owner ON root_owner.room_id = room.room_id AND root_owner.member_id = root.owner_member_id
      JOIN execution_plan_nodes node ON node.plan_id = @planId AND node.revision = @revision
        AND node.node_key = @nodeKey AND node.task_id = task.task_id AND node.agent_id = agent.agent_id
      JOIN execution_plan_task_claims claim ON claim.task_id = task.task_id AND claim.plan_id = node.plan_id
        AND claim.revision = node.revision AND claim.node_key = node.node_key
      JOIN execution_plan_approvals approval ON approval.plan_id = node.plan_id AND approval.revision = node.revision
      WHERE run.run_id = @runId AND run.task_id = @taskId AND run.room_id = @roomId
        AND agent.agent_id = @agentId AND device.device_id = @deviceId AND agent.owner_member_id = member.member_id
        AND device.team_id = room.team_id AND agent.team_id = room.team_id
        AND approval.operation_id = @approvalId AND approval.digest = @planDigest AND approval.decision = 'approved'
        AND task.owner_member_id = node.owner_member_id AND task.definition_revision = @definitionRevision
        AND task.criteria_revision = @criteriaRevision AND task.definition_revision = node.definition_revision
        AND task.criteria_revision = node.criteria_revision AND task.lifecycle_state IN ('ready', 'active', 'review')
        AND run.state IN ('queued', 'delivered', 'working', 'input_required')
        AND (@admission = 0 OR task.scheduling_state = 'enabled')
        AND EXISTS (SELECT 1 FROM task_agent_assignments WHERE task_id = task.task_id AND agent_id = agent.agent_id)
    `).get({ rootTaskId: plan.rootTaskId, rootOwner: plan.ownerMemberId, planId: s.planId,
      revision: s.planRevision, nodeKey: s.nodeKey, runId: s.runId, taskId: s.taskId, roomId: s.roomId,
      agentId: s.agentId, deviceId: s.deviceId, approvalId: s.approvalOperationId, planDigest: s.planDigest,
      definitionRevision: s.definitionRevision, criteriaRevision: s.criteriaRevision, admission: admission ? 1 : 0 }) as
      { owner_member_id: string; team_id: string; deadline_at: string; context_manifest_json: string | null; task_revision: number } | undefined;
    if (!owner || Date.parse(manifest.deadline) > Date.parse(owner.deadline_at)) return fail("WORKSPACE_SCOPE_UNAVAILABLE");
    if (owner.context_manifest_json !== null) {
      if (!equal(JSON.parse(owner.context_manifest_json).execution, manifest)) return fail("WORKSPACE_MANIFEST_CONFLICT");
    } else if (!admission || owner.task_revision !== s.taskRevision) return fail("WORKSPACE_MANIFEST_CONFLICT");
    return owner;
  }

  private requireDevice(principal: DevicePrincipal, row: Row): void {
    const device = this.database.prepare("SELECT owner_member_id, team_id, status FROM devices WHERE device_id = ?")
      .get(row.device_id) as { owner_member_id: string; team_id: string; status: string } | undefined;
    if (!device || device.status !== "active" || row.device_id !== principal.deviceId ||
      row.owner_member_id !== principal.ownerMemberId || row.team_id !== principal.teamId ||
      device.owner_member_id !== row.owner_member_id || device.team_id !== row.team_id) {
      throw new AuthorizationError("FORBIDDEN", "Isolated workspace lease access denied");
    }
  }

  private row(leaseId: string): Row {
    const row = this.database.prepare("SELECT * FROM isolated_workspace_leases WHERE lease_id = ?").get(leaseId) as Row | undefined;
    return row ?? fail("WORKSPACE_LEASE_UNAVAILABLE");
  }
  private rowForRun(runId: string): Row | undefined {
    return this.database.prepare("SELECT * FROM isolated_workspace_leases WHERE run_id = ?").get(runId) as Row | undefined;
  }
  private project(row: Row, now: string): IsolatedWorkspaceState {
    const lease = JSON.parse(row.lease_json) as Lease;
    if (executionOperationDigest(lease) !== row.lease_digest) return fail("WORKSPACE_LEASE_CORRUPT");
    const operation = this.database.prepare(`SELECT * FROM isolated_workspace_operations
      WHERE lease_id = ? ORDER BY revision DESC LIMIT 1`).get(row.lease_id) as Operation | undefined;
    return operation ? this.projectOperation(lease, operation, now) : {
      lease, revision: 1, generation: lease.workspaceGeneration,
      state: Date.parse(lease.expiresAt) <= Date.parse(now) ? "expired" : "active"
    };
  }
  private projectOperation(lease: Lease, operation: Operation, now: string): IsolatedWorkspaceState {
    return { lease, revision: operation.revision, generation: operation.generation,
      state: operation.kind === "revoke" ? "revoked" : operation.kind === "release" ? "released" :
        Date.parse(lease.expiresAt) <= Date.parse(now) ? "expired" : "active" };
  }
}
