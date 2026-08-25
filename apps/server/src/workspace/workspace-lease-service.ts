import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRepository } from "../run/run-repository.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import type { AgentTaskRepository } from "../task/task-repository.js";
import {
  type WorkspaceLeaseRecord,
  WorkspaceLeaseRepository
} from "./workspace-lease-repository.js";

const workspaceRefPattern = /^workspace_[0-9a-f]{64}$/u;
const generationPattern = /^[0-9a-f]{64}$/u;
const idempotencyKeyPattern = /^idem_[A-Za-z0-9_-]{8,128}$/u;

export interface IssueWorkspaceLeaseInput {
  runId: string;
  agentId: string;
  workspaceRef: string;
  workspaceGeneration: string;
  idempotencyKey: string;
  durationSeconds?: number;
}

export interface WorkspaceLeaseView extends Omit<WorkspaceLeaseRecord, "state"> {
  state: "active" | "released" | "expired";
}

function effectiveLease(
  lease: WorkspaceLeaseRecord,
  now: string
): WorkspaceLeaseView {
  return {
    ...lease,
    state: lease.state === "active" && Date.parse(lease.expiresAt) <= Date.parse(now)
      ? "expired"
      : lease.state
  };
}

function sameRequest(
  lease: WorkspaceLeaseRecord,
  input: IssueWorkspaceLeaseInput
): boolean {
  return lease.runId === input.runId &&
    lease.agentId === input.agentId &&
    lease.workspaceRef === input.workspaceRef &&
    lease.workspaceGeneration === input.workspaceGeneration &&
    lease.mode === "read_source";
}

export class WorkspaceLeaseService {
  public constructor(
    private readonly leases: WorkspaceLeaseRepository,
    private readonly runs: RunRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly core: CoreRepository
  ) {}

  public issueReadSource(
    principal: DevicePrincipal,
    input: IssueWorkspaceLeaseInput,
    now: string
  ): WorkspaceLeaseView {
    this.validateInput(input);
    const retry = this.leases.getByIdempotency(
      principal.deviceId,
      input.idempotencyKey
    );
    if (retry) {
      if (!sameRequest(retry, input)) {
        throw new Error("Workspace lease idempotency key conflicts");
      }
      this.requireCurrentScope(principal, retry);
      return effectiveLease(retry, now);
    }

    const scope = this.requireCurrentScope(principal, input);
    const durationSeconds = input.durationSeconds ?? 120;
    if (
      !Number.isSafeInteger(durationSeconds) ||
      durationSeconds < 30 || durationSeconds > 300
    ) {
      throw new Error("Workspace lease duration must be between 30 and 300 seconds");
    }
    const nowMilliseconds = Date.parse(now);
    if (!Number.isFinite(nowMilliseconds)) {
      throw new Error("Workspace lease time is invalid");
    }
    const lease: WorkspaceLeaseRecord = {
      leaseId: createOpaqueId("lease"),
      idempotencyKey: input.idempotencyKey,
      teamId: principal.teamId,
      roomId: scope.roomId,
      taskId: scope.taskId,
      runId: input.runId,
      agentId: input.agentId,
      deviceId: principal.deviceId,
      workspaceRef: input.workspaceRef,
      workspaceGeneration: input.workspaceGeneration,
      mode: "read_source",
      state: "active",
      issuedAt: now,
      expiresAt: new Date(nowMilliseconds + durationSeconds * 1_000).toISOString(),
      releasedAt: null
    };
    return effectiveLease(this.leases.create(lease), now);
  }

  public getForDevice(
    principal: DevicePrincipal,
    leaseId: string,
    now: string
  ): WorkspaceLeaseView {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.deviceId !== principal.deviceId) {
      throw new Error("Workspace lease access denied");
    }
    return effectiveLease(lease, now);
  }

  public requireActiveReadSource(
    principal: DevicePrincipal,
    leaseId: string,
    input: Pick<IssueWorkspaceLeaseInput, "runId" | "agentId" | "workspaceRef" |
      "workspaceGeneration">,
    now: string
  ): WorkspaceLeaseView {
    const lease = this.getForDevice(principal, leaseId, now);
    if (
      lease.state !== "active" || lease.mode !== "read_source" ||
      lease.runId !== input.runId || lease.agentId !== input.agentId ||
      lease.workspaceRef !== input.workspaceRef ||
      lease.workspaceGeneration !== input.workspaceGeneration
    ) {
      throw new Error("Workspace source lease is not active for this operation");
    }
    this.requireCurrentScope(principal, lease);
    return lease;
  }

  public release(
    principal: DevicePrincipal,
    leaseId: string,
    now: string
  ): WorkspaceLeaseView {
    const lease = this.getForDevice(principal, leaseId, now);
    if (lease.state === "expired") return lease;
    return effectiveLease(this.leases.release(leaseId, now), now);
  }

  private validateInput(input: IssueWorkspaceLeaseInput): void {
    if (!workspaceRefPattern.test(input.workspaceRef)) {
      throw new Error("Workspace reference is invalid");
    }
    if (!generationPattern.test(input.workspaceGeneration)) {
      throw new Error("Workspace generation is invalid");
    }
    if (!idempotencyKeyPattern.test(input.idempotencyKey)) {
      throw new Error("Workspace lease idempotency key is invalid");
    }
  }

  private requireCurrentScope(
    principal: DevicePrincipal,
    input: Pick<IssueWorkspaceLeaseInput, "runId" | "agentId" | "workspaceRef" |
      "workspaceGeneration">
  ): { roomId: string; taskId: string } {
    const run = this.runs.getRun(input.runId);
    if (!run || !new Set(["delivered", "working"]).has(run.state)) {
      throw new Error("Workspace source lease requires an active assigned Run");
    }
    if (run.targetAgentId !== input.agentId) {
      throw new Error("Workspace source lease Agent does not match its Run");
    }
    const task = this.tasks.get(run.taskId);
    if (
      !task || task.roomId !== run.roomId ||
      new Set(["completed", "canceled"]).has(task.state)
    ) {
      throw new Error("Workspace source lease Task is unavailable");
    }
    const agent = this.core.getAgent(input.agentId);
    if (
      !agent || !agent.enabled || agent.integrationMode !== "managed" ||
      agent.teamId !== principal.teamId ||
      agent.ownerMemberId !== principal.ownerMemberId ||
      agent.deviceId !== principal.deviceId
    ) {
      throw new Error("Workspace source lease Device assignment is invalid");
    }
    if (
      agent.capabilities.supportsWorkspaceLeases !== true ||
      agent.workspaceRef !== input.workspaceRef ||
      agent.workspaceGeneration !== input.workspaceGeneration
    ) {
      throw new Error("Workspace source lease snapshot is stale or unsupported");
    }
    return { roomId: run.roomId, taskId: run.taskId };
  }
}
