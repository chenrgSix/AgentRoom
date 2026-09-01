import { assertExecutionCommand } from "@convene-wire/contracts/execution-validation";
import type {
  GovernedExecutionCapability,
  GovernedExecutionCapabilityReadyGrant
} from "@convene-wire/contracts/execution-plan";

export interface BridgeSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface Connection {
  deviceId: string;
  epoch: number;
  governedExecutionAgents: Map<string, GovernedExecutionCapability>;
  supportsAgentProvisioning: boolean;
  governedExecution?: GovernedExecutionCapability;
  socket: BridgeSocket;
}

export class BridgeConnectionRegistry {
  private readonly connections = new Map<string, Connection>();

  public register(
    deviceId: string,
    epoch: number,
    socket: BridgeSocket,
    capabilities: { supportsAgentProvisioning?: boolean; governedExecution?: unknown } = {}
  ): boolean {
    const existing = this.connections.get(deviceId);
    if (existing && existing.epoch >= epoch) {
      return false;
    }
    if (capabilities.governedExecution !== undefined) {
      assertExecutionCommand("executionCapability", capabilities.governedExecution);
      if ((capabilities.governedExecution as GovernedExecutionCapability).readyGrants !== undefined) {
        throw new Error("Device execution capability cannot publish Agent grants");
      }
    }
    if (existing) {
      existing.socket.close(4_001, "Superseded by a newer connection epoch");
    }
    this.connections.set(deviceId, {
      deviceId,
      epoch,
      supportsAgentProvisioning: capabilities.supportsAgentProvisioning === true,
      ...(capabilities.governedExecution !== undefined ? {
        governedExecution: structuredClone(capabilities.governedExecution) as GovernedExecutionCapability
      } : {}),
      governedExecutionAgents: new Map(),
      socket
    });
    return true;
  }

  public remove(deviceId: string, socket: BridgeSocket): void {
    if (this.connections.get(deviceId)?.socket === socket) {
      this.connections.delete(deviceId);
    }
  }

  public send(deviceId: string, message: unknown): boolean {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      return false;
    }
    if (hasGovernedExecution(message)) {
      const agentId = governedExecutionAgentId(message);
      if (!agentId || !this.supportsGovernedAgentExecution(deviceId, agentId)) {
        return false;
      }
    }
    connection.socket.send(JSON.stringify(message));
    return true;
  }

  public activeEpoch(deviceId: string): number | undefined {
    return this.connections.get(deviceId)?.epoch;
  }

  public supportsAgentProvisioning(deviceId: string): boolean {
    return this.connections.get(deviceId)?.supportsAgentProvisioning === true;
  }

  public supportsGovernedExecution(deviceId: string): boolean {
    const capability = this.connections.get(deviceId)?.governedExecution;
    return capability?.operations.includes("prepare") === true &&
      capability.operations.includes("capture");
  }

  public governedExecutionCapability(deviceId: string): GovernedExecutionCapability | undefined {
    const capability = this.connections.get(deviceId)?.governedExecution;
    return capability && structuredClone(capability);
  }

  public supportsGovernedAgentCapability(
    deviceId: string,
    agentId: string,
    agentCapability: GovernedExecutionCapability
  ): boolean {
    const deviceCapability = this.connections.get(deviceId)?.governedExecution;
    return deviceCapability !== undefined &&
      deviceCapability.version === agentCapability.version &&
      deviceCapability.workspaceBoundary === agentCapability.workspaceBoundary &&
      (!agentCapability.preventivePathEnforcement ||
        deviceCapability.preventivePathEnforcement) &&
      agentCapability.operations.every((operation) =>
        deviceCapability.operations.includes(operation)
      ) && readyGrantsBelongToAgent(
        deviceId,
        agentId,
        agentCapability
      );
  }

  public recordGovernedAgentCapability(
    deviceId: string,
    epoch: number,
    agentId: string,
    agentCapability: GovernedExecutionCapability | undefined
  ): boolean {
    const connection = this.connections.get(deviceId);
    if (!connection || connection.epoch !== epoch) {
      return false;
    }
    if (agentCapability === undefined) {
      connection.governedExecutionAgents.delete(agentId);
      return true;
    }
    if (!this.supportsGovernedAgentCapability(deviceId, agentId, agentCapability)) {
      return false;
    }
    connection.governedExecutionAgents.set(
      agentId,
      structuredClone(agentCapability)
    );
    return true;
  }

  public governedAgentExecutionCapability(
    deviceId: string,
    agentId: string
  ): GovernedExecutionCapability | undefined {
    const capability = this.connections
      .get(deviceId)
      ?.governedExecutionAgents.get(agentId);
    return capability && structuredClone(capability);
  }

  public governedAgentReadyGrants(
    deviceId: string,
    agentId: string
  ): GovernedExecutionCapabilityReadyGrant[] {
    const grants = this.connections
      .get(deviceId)
      ?.governedExecutionAgents.get(agentId)
      ?.readyGrants;
    return grants ? structuredClone(grants) : [];
  }

  public supportsGovernedAgentExecution(
    deviceId: string,
    agentId: string
  ): boolean {
    const capability = this.connections
      .get(deviceId)
      ?.governedExecutionAgents.get(agentId);
    return this.supportsGovernedExecution(deviceId) &&
      capability?.operations.includes("prepare") === true &&
      capability.operations.includes("capture");
  }

  public activeCount(): number {
    return this.connections.size;
  }

  public revoke(deviceId: string): void {
    const connection = this.connections.get(deviceId);
    if (!connection) return;
    this.connections.delete(deviceId);
    connection.socket.close(4_004, "Device revoked");
  }
}

function readyGrantsBelongToAgent(
  deviceId: string,
  agentId: string,
  capability: GovernedExecutionCapability
): boolean {
  const seen = new Set<string>();
  for (const grant of capability.readyGrants ?? []) {
    if (
      grant.deviceId !== deviceId ||
      grant.agentId !== agentId ||
      grant.revokedAt !== null ||
      seen.has(grant.grant.grantId) ||
      !grant.operations.includes("prepare") ||
      !grant.operations.includes("capture") ||
      !grant.operations.every((operation) =>
        capability.operations.includes(operation)
      )
    ) {
      return false;
    }
    seen.add(grant.grant.grantId);
  }
  return true;
}

function hasGovernedExecution(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "run.requested" ||
    !("payload" in message) || !message.payload || typeof message.payload !== "object") return false;
  const payload = message.payload;
  if (!("contextManifest" in payload) || !payload.contextManifest || typeof payload.contextManifest !== "object") return false;
  return Object.hasOwn(payload.contextManifest, "execution");
}

function governedExecutionAgentId(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("payload" in message) ||
    !message.payload || typeof message.payload !== "object" ||
    !("targetAgentId" in message.payload) ||
    typeof message.payload.targetAgentId !== "string") {
    return undefined;
  }
  return message.payload.targetAgentId;
}
