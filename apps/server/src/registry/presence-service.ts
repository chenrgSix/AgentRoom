import type {
  AgentRecord,
  CoreRepository,
  DeviceBridgeObservationRecord,
  DevicePresenceRecord
} from "../data/core-repository.js";
import { isCanonicalBridgeVersion } from "../domain/bridge-version.js";
import type {
  AuthService,
  DevicePrincipal,
  WebPrincipal
} from "../security/auth-service.js";

const sourceCommitPattern = /^[0-9a-f]{40}$/u;
const executableSha256Pattern = /^[0-9a-f]{64}$/u;
const bridgeAgentStatuses = new Set<AgentRecord["presence"]>([
  "ready",
  "busy",
  "degraded"
]);

export type HostedAgentAvailability = "ready" | "degraded";

export interface HostedAgentPresenceSource {
  getAvailability(agentId: string): HostedAgentAvailability | undefined;
}

const unavailableHostedAgents: HostedAgentPresenceSource = {
  getAvailability: () => undefined
};

export class PresenceService {
  public constructor(
    private readonly repository: CoreRepository,
    private readonly auth: AuthService,
    private readonly ttlMilliseconds = 30_000,
    private readonly hostedAgents: HostedAgentPresenceSource =
      unavailableHostedAgents
  ) {}

  public recordHeartbeat(
    principal: DevicePrincipal,
    input: {
      deviceId: string;
      connectionEpoch: number;
      adapterAvailable: boolean;
      now: string;
    }
  ): DevicePresenceRecord {
    const record = this.presenceRecord(principal, input);
    this.repository.recordDevicePresence(record);
    this.projectAgentPresence(principal, input);
    return record;
  }

  private presenceRecord(
    principal: DevicePrincipal,
    input: {
      deviceId: string;
      connectionEpoch: number;
      adapterAvailable: boolean;
      now: string;
    }
  ): DevicePresenceRecord {
    if (principal.deviceId !== input.deviceId) {
      throw new Error("Device heartbeat identity mismatch");
    }
    if (!Number.isSafeInteger(input.connectionEpoch) || input.connectionEpoch < 1) {
      throw new Error("Connection epoch must be a positive integer");
    }
    const record: DevicePresenceRecord = {
      deviceId: input.deviceId,
      connectionEpoch: input.connectionEpoch,
      adapterAvailable: input.adapterAvailable,
      lastHeartbeatAt: input.now
    };
    return record;
  }

  private projectAgentPresence(
    principal: DevicePrincipal,
    input: { deviceId: string; adapterAvailable: boolean; now: string }
  ): void {
    for (const agent of this.repository.listAgents(principal.teamId)) {
      if (agent.deviceId === input.deviceId && agent.enabled) {
        const projected = input.adapterAvailable
          ? agent.presence === "busy" ? "busy" : "ready"
          : "degraded";
        this.repository.updateAgentPresence(
          agent.agentId,
          projected,
          input.now
        );
      }
    }
  }

  public recordAgentStatus(
    principal: DevicePrincipal,
    input: {
      agentId: string;
      deviceId: string;
      connectionEpoch: number;
      status: "ready" | "busy" | "degraded";
      now: string;
    }
  ): AgentRecord {
    const currentDevicePresence = this.repository.getDevicePresence(
      input.deviceId
    );
    const agent = this.repository.getAgent(input.agentId);
    if (
      input.deviceId !== principal.deviceId ||
      !Number.isSafeInteger(input.connectionEpoch) ||
      input.connectionEpoch < 1 ||
      currentDevicePresence?.connectionEpoch !== input.connectionEpoch ||
      !agent ||
      agent.teamId !== principal.teamId ||
      agent.ownerMemberId !== principal.ownerMemberId ||
      agent.deviceId !== principal.deviceId ||
      agent.integrationMode !== "managed" ||
      !agent.enabled ||
      !bridgeAgentStatuses.has(input.status)
    ) {
      throw new Error("Agent status identity mismatch");
    }
    this.repository.updateAgentPresence(input.agentId, input.status, input.now);
    const updated = this.repository.getAgent(input.agentId);
    if (!updated) throw new Error("Agent disappeared after status update");
    return updated;
  }

  public recordHello(
    principal: DevicePrincipal,
    input: {
      deviceId: string;
      connectionEpoch: number;
      bridgeVersion: string;
      sourceCommit?: string;
      executableSha256?: string;
      adapterAvailable: boolean;
      now: string;
    }
  ): {
    observation: DeviceBridgeObservationRecord;
    presence: DevicePresenceRecord;
  } {
    if (!isCanonicalBridgeVersion(input.bridgeVersion)) {
      throw new Error("Bridge version must be canonical");
    }
    const hasBuildIdentity =
      input.sourceCommit !== undefined || input.executableSha256 !== undefined;
    if (hasBuildIdentity &&
        (!sourceCommitPattern.test(input.sourceCommit ?? "") ||
          !executableSha256Pattern.test(input.executableSha256 ?? ""))) {
      throw new Error("Bridge build observation must be one canonical pair");
    }
    const presence = this.presenceRecord(principal, input);
    const observation: DeviceBridgeObservationRecord = {
      deviceId: input.deviceId,
      connectionEpoch: input.connectionEpoch,
      bridgeVersion: input.bridgeVersion,
      sourceCommit: input.sourceCommit ?? null,
      executableSha256: input.executableSha256 ?? null,
      observedAt: input.now
    };
    this.repository.recordDeviceHello(presence, observation);
    this.projectAgentPresence(principal, input);
    return { observation, presence };
  }

  public listAgents(
    principal: WebPrincipal,
    teamId: string,
    now: string
  ): AgentRecord[] {
    this.auth.requireTeamMember(principal, teamId);
    const nowMilliseconds = Date.parse(now);
    return this.repository.listAgents(teamId).map((agent) => {
      let presence = agent.presence;
      if (agent.integrationMode === "hosted") {
        if (!agent.enabled) {
          presence = "offline";
        } else if (presence !== "busy") {
          presence = this.hostedAgents.getAvailability(agent.agentId) === "ready"
            ? "ready"
            : "degraded";
        }
      } else if (agent.integrationMode === "manual") {
        presence = "manual";
      } else if (!agent.deviceId) {
        presence = "offline";
      } else {
        const device = this.repository.getDevice(agent.deviceId);
        const heartbeat = this.repository.getDevicePresence(agent.deviceId);
        if (
          !device ||
          device.status !== "active" ||
          !heartbeat ||
          nowMilliseconds - Date.parse(heartbeat.lastHeartbeatAt) >
            this.ttlMilliseconds
        ) {
          presence = "offline";
        } else if (!heartbeat.adapterAvailable) {
          presence = "degraded";
        } else if (presence !== "busy") {
          presence = "ready";
        }
      }
      if (presence !== agent.presence) {
        this.repository.updateAgentPresence(agent.agentId, presence, now);
      }
      return { ...agent, presence, updatedAt: now };
    });
  }
}
