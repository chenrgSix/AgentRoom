import { assertExecutionCommand } from "@convene-wire/contracts/execution-validation";
import type { GovernedExecutionCapability } from "@convene-wire/contracts/execution-plan";

export interface BridgeSocket {
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface Connection {
  deviceId: string;
  epoch: number;
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
    if (hasGovernedExecution(message) && !this.supportsGovernedExecution(deviceId)) {
      return false;
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

function hasGovernedExecution(message: unknown): boolean {
  if (!message || typeof message !== "object" || !("type" in message) || message.type !== "run.requested" ||
    !("payload" in message) || !message.payload || typeof message.payload !== "object") return false;
  const payload = message.payload;
  if (!("contextManifest" in payload) || !payload.contextManifest || typeof payload.contextManifest !== "object") return false;
  return Object.hasOwn(payload.contextManifest, "execution");
}
