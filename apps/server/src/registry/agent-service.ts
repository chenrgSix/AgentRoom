import type {
  AgentCapabilities,
  AgentRecord,
  AgentRuntimePolicy,
  CoreRepository
} from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import { exceedsUnicodeCodePointLimit } from "../domain/unicode-length.js";
import {
  AuthorizationError,
  type AuthService,
  type DevicePrincipal,
  type WebPrincipal
} from "../security/auth-service.js";

export interface PublishAgentInput {
  teamId: string;
  deviceId: string | null;
  name: string;
  role: string;
  integrationMode: "managed" | "manual" | "fake" | "hosted";
  capabilities: AgentCapabilities;
  runtimePolicy?: AgentRuntimePolicy | null;
  runtimeScopeId?: string | null;
  workspaceRef?: string | null;
  workspaceGeneration?: string | null;
  roomIds?: readonly string[];
  now: string;
}

function normalizedLabel(value: string, label: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    exceedsUnicodeCodePointLimit(normalized, 80)
  ) {
    throw new Error(`${label} must contain 1 to 80 characters`);
  }
  return normalized;
}

function normalizedWorkspaceAlias(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (
    normalized !== value ||
    normalized.length === 0 ||
    [...normalized].length > 80 ||
    normalized === "." ||
    normalized === ".." ||
    /[\/\\\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    throw new Error("Bridge Workspace alias is invalid");
  }
  return normalized;
}

function validateCapabilities(input: PublishAgentInput): void {
  if (
    input.runtimePolicy != null &&
    (
      input.integrationMode !== "managed" ||
      !["read-only", "workspace-write", "local-policy"].includes(
        input.runtimePolicy.filesystemAccess
      )
    )
  ) {
    throw new Error("Runtime policy summary is invalid");
  }
  if (
    input.runtimeScopeId != null &&
    !/^[0-9a-f]{64}$/u.test(input.runtimeScopeId)
  ) {
    throw new Error("Runtime scope ID is invalid");
  }
  if (
    (input.workspaceRef == null) !== (input.workspaceGeneration == null) ||
    (input.workspaceRef != null &&
      !/^workspace_[0-9a-f]{64}$/u.test(input.workspaceRef)) ||
    (input.workspaceGeneration != null &&
      !/^[0-9a-f]{64}$/u.test(input.workspaceGeneration))
  ) {
    throw new Error("Workspace snapshot identity is invalid");
  }
  if (input.integrationMode === "hosted") {
    if (
      input.deviceId !== null ||
      input.runtimePolicy != null ||
      input.runtimeScopeId != null ||
      input.workspaceRef != null ||
      input.workspaceGeneration != null
    ) {
      throw new Error("Hosted Agents cannot bind Device or local Runtime state");
    }
    if (
      !input.capabilities.supportsStart ||
      !input.capabilities.supportsStreaming ||
      !input.capabilities.supportsInterrupt
    ) {
      throw new Error(
        "Hosted Agents require start, streaming, and interrupt capabilities"
      );
    }
    if (
      input.capabilities.supportsResume ||
      input.capabilities.supportsRoomContextCoverage === true ||
      input.capabilities.supportsWorkspaceLeases === true ||
      input.capabilities.supportsArtifactPublication === true ||
      input.capabilities.supportsArtifactMaterialization === true
    ) {
      throw new Error(
        "Hosted Agents cannot advertise Bridge Runtime capabilities"
      );
    }
    return;
  }
  if (
    input.capabilities.supportsWorkspaceLeases === true &&
    input.workspaceRef == null
  ) {
    throw new Error("Workspace lease capability requires a snapshot identity");
  }
  if (
    input.capabilities.supportsArtifactPublication === true &&
    input.capabilities.supportsWorkspaceLeases !== true
  ) {
    throw new Error("Artifact publication capability requires Workspace leases");
  }
  if (input.integrationMode === "managed" || input.integrationMode === "fake") {
    if (!input.deviceId || !input.capabilities.supportsStart) {
      throw new Error("Managed and Fake Agents require a Device and start capability");
    }
    return;
  }
  if (input.deviceId) {
    throw new Error("Manual Agents cannot bind a managed Device");
  }
  if (
    input.capabilities.supportsStart ||
    input.capabilities.supportsResume ||
    input.capabilities.supportsInterrupt ||
    input.capabilities.supportsArtifactPublication ||
    input.capabilities.supportsArtifactMaterialization
  ) {
    throw new Error("Manual Agents cannot advertise managed lifecycle capabilities");
  }
}

function explicitHostedRoomIds(
  input: PublishAgentInput
): readonly string[] | undefined {
  if (input.integrationMode !== "hosted") {
    if (input.roomIds !== undefined) {
      throw new Error("Explicit Room IDs are reserved for Hosted Agents");
    }
    return undefined;
  }
  if (!Array.isArray(input.roomIds)) {
    throw new Error("Hosted Agent creation requires explicit Room IDs");
  }
  const roomIds = input.roomIds as readonly unknown[];
  if (
    roomIds.some((roomId) =>
      typeof roomId !== "string" || roomId.length === 0
    )
  ) {
    throw new Error("Hosted Agent Room IDs are invalid");
  }
  const typedRoomIds = roomIds as readonly string[];
  if (new Set(typedRoomIds).size !== typedRoomIds.length) {
    throw new Error("Hosted Agent Room IDs must be unique");
  }
  return typedRoomIds;
}

export class AgentService {
  public constructor(
    private readonly repository: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public publishAgent(
    principal: WebPrincipal,
    input: PublishAgentInput
  ): AgentRecord {
    const member = this.auth.requireTeamMember(principal, input.teamId);
    validateCapabilities(input);
    const roomIds = explicitHostedRoomIds(input);
    if (input.integrationMode === "hosted" && member.role !== "owner") {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Only a Team owner can create a Hosted Agent"
      );
    }
    if (input.deviceId) {
      const device = this.repository.getDevice(input.deviceId);
      if (
        !device ||
        device.teamId !== input.teamId ||
        device.ownerMemberId !== member.memberId ||
        device.status !== "active"
      ) {
        throw new AuthorizationError("FORBIDDEN", "Device ownership denied");
      }
    }
    for (const roomId of roomIds ?? []) {
      const room = this.repository.getRoom(roomId);
      if (
        !room ||
        room.teamId !== input.teamId ||
        room.archivedAt != null
      ) {
        throw new AuthorizationError(
          "FORBIDDEN",
          "Hosted Agent Room access denied"
        );
      }
    }
    const agent: AgentRecord = {
      agentId: createOpaqueId("agent"),
      teamId: input.teamId,
      ownerMemberId: member.memberId,
      deviceId: input.deviceId,
      name: normalizedLabel(input.name, "Agent name"),
      role: normalizedLabel(input.role, "Agent role"),
      integrationMode: input.integrationMode,
      capabilities: input.capabilities,
      runtimePolicy: input.runtimePolicy ?? null,
      runtimeScopeId: input.runtimeScopeId ?? null,
      workspaceRef: input.workspaceRef ?? null,
      workspaceGeneration: input.workspaceGeneration ?? null,
      workspaceAlias: null,
      enabled: true,
      presence: input.integrationMode === "manual" ? "manual"
        : input.integrationMode === "hosted" ? "degraded"
          : "offline",
      createdAt: input.now,
      updatedAt: input.now
    };
    if (input.integrationMode === "hosted") {
      if (roomIds === undefined) {
        throw new Error("Hosted Agent Room validation did not return a Room list");
      }
      this.repository.createAgent(agent, { roomIds });
    } else {
      this.repository.createAgent(agent);
    }
    return agent;
  }

  public listAgents(
    principal: WebPrincipal,
    teamId: string
  ): AgentRecord[] {
    this.auth.requireTeamMember(principal, teamId);
    return this.repository.listAgents(teamId);
  }

  public publishDeviceAgent(
    principal: DevicePrincipal,
    input: {
      agentId: string;
      name: string;
      role: string;
      capabilities: AgentCapabilities;
      runtimePolicy?: AgentRuntimePolicy;
      runtimeScopeId?: string;
      workspaceRef?: string;
      workspaceGeneration?: string;
      workspaceAlias?: string;
      now: string;
    }
  ): AgentRecord {
    if (!/^agent_[A-Za-z0-9_-]{8,128}$/u.test(input.agentId)) {
      throw new Error("Bridge Agent ID is invalid");
    }
    if (!input.capabilities.supportsStart) {
      throw new Error("Managed Bridge Agent must support start");
    }
    if (
      input.runtimePolicy !== undefined &&
      !["read-only", "workspace-write", "local-policy"].includes(
        input.runtimePolicy.filesystemAccess
      )
    ) {
      throw new Error("Bridge Runtime policy summary is invalid");
    }
    if (
      input.runtimeScopeId !== undefined &&
      !/^[0-9a-f]{64}$/u.test(input.runtimeScopeId)
    ) {
      throw new Error("Bridge Runtime scope ID is invalid");
    }
    if (
      (input.workspaceRef === undefined) !==
        (input.workspaceGeneration === undefined) ||
      (input.workspaceRef !== undefined &&
        !/^workspace_[0-9a-f]{64}$/u.test(input.workspaceRef)) ||
      (input.workspaceGeneration !== undefined &&
        !/^[0-9a-f]{64}$/u.test(input.workspaceGeneration))
    ) {
      throw new Error("Bridge Workspace snapshot identity is invalid");
    }
    const workspaceAlias = normalizedWorkspaceAlias(input.workspaceAlias);
    if (workspaceAlias !== null && input.workspaceRef === undefined) {
      throw new Error("Bridge Workspace alias requires a snapshot identity");
    }
    if (
      input.capabilities.supportsWorkspaceLeases === true &&
      input.workspaceRef === undefined
    ) {
      throw new Error("Bridge Workspace lease capability requires a snapshot");
    }
    if (
      input.capabilities.supportsArtifactPublication === true &&
      input.capabilities.supportsWorkspaceLeases !== true
    ) {
      throw new Error(
        "Bridge Artifact publication capability requires Workspace leases"
      );
    }
    const existing = this.repository.getAgent(input.agentId);
    if (
      existing &&
      (
        existing.teamId !== principal.teamId ||
        existing.ownerMemberId !== principal.ownerMemberId ||
        existing.deviceId !== principal.deviceId ||
        existing.integrationMode !== "managed"
      )
    ) {
      throw new AuthorizationError("FORBIDDEN", "Bridge Agent identity ownership denied");
    }
    const agent: AgentRecord = {
      agentId: input.agentId,
      teamId: principal.teamId,
      ownerMemberId: principal.ownerMemberId,
      deviceId: principal.deviceId,
      name: normalizedLabel(input.name, "Agent name"),
      role: normalizedLabel(input.role, "Agent role"),
      integrationMode: "managed",
      capabilities: input.capabilities,
      runtimePolicy: input.runtimePolicy ?? null,
      runtimeScopeId: input.runtimeScopeId ?? existing?.runtimeScopeId ?? null,
      workspaceRef: input.workspaceRef ?? existing?.workspaceRef ?? null,
      workspaceGeneration: input.workspaceGeneration ??
        existing?.workspaceGeneration ?? null,
      workspaceAlias,
      enabled: existing?.enabled ?? true,
      presence: existing?.enabled === false ? "offline" : "ready",
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now
    };
    if (existing) {
      this.repository.updateAgentPublication(agent);
    } else {
      this.repository.createAgent(agent);
    }
    return agent;
  }

  public setEnabled(
    principal: WebPrincipal,
    agentId: string,
    enabled: boolean,
    now: string
  ): AgentRecord {
    const existing = this.repository.getAgent(agentId);
    if (!existing) throw new Error(`Agent not found: ${agentId}`);
    const actor = this.auth.requireTeamMember(principal, existing.teamId);
    if (actor.role !== "owner") {
      throw new Error("Only a Team owner can manage Agent enablement");
    }
    if (!enabled && this.repository.hasActiveWorkForAgent(agentId)) {
      throw new Error("Agent cannot be disabled while Runs or Discussions are active");
    }
    return this.repository.setAgentEnabled(agentId, enabled, now);
  }
}
