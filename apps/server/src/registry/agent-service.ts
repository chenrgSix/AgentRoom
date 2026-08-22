import type {
  AgentCapabilities,
  AgentRecord,
  CoreRepository
} from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";

export interface PublishAgentInput {
  teamId: string;
  deviceId: string | null;
  name: string;
  role: string;
  integrationMode: "managed" | "manual";
  capabilities: AgentCapabilities;
  now: string;
}

function normalizedLabel(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    throw new Error(`${label} must contain 1 to 80 characters`);
  }
  return normalized;
}

function validateCapabilities(input: PublishAgentInput): void {
  if (input.integrationMode === "managed") {
    if (!input.deviceId || !input.capabilities.supportsStart) {
      throw new Error("Managed Agents require a Device and start capability");
    }
    return;
  }
  if (input.deviceId) {
    throw new Error("Manual Agents cannot bind a managed Device");
  }
  if (
    input.capabilities.supportsStart ||
    input.capabilities.supportsResume ||
    input.capabilities.supportsInterrupt
  ) {
    throw new Error("Manual Agents cannot advertise managed lifecycle capabilities");
  }
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
    const agent: AgentRecord = {
      agentId: createOpaqueId("agent"),
      teamId: input.teamId,
      ownerMemberId: member.memberId,
      deviceId: input.deviceId,
      name: normalizedLabel(input.name, "Agent name"),
      role: normalizedLabel(input.role, "Agent role"),
      integrationMode: input.integrationMode,
      capabilities: input.capabilities,
      enabled: true,
      presence: input.integrationMode === "manual" ? "manual" : "offline",
      createdAt: input.now,
      updatedAt: input.now
    };
    this.repository.createAgent(agent);
    return agent;
  }

  public listAgents(
    principal: WebPrincipal,
    teamId: string
  ): AgentRecord[] {
    this.auth.requireTeamMember(principal, teamId);
    return this.repository.listAgents(teamId);
  }
}
