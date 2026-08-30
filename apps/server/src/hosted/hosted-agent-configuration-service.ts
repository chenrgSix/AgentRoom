import type { CoreRepository } from "../data/core-repository.js";
import {
  type HostedAgentConfigurationRecord,
  HostedAgentRepository,
  type HostedProviderTestObservation,
  hostedProvider
} from "../data/hosted-agent-repository.js";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type { AgentService } from "../registry/agent-service.js";
import {
  AuthorizationError,
  type AuthService,
  type MemberPrincipal,
  type WebPrincipal
} from "../security/auth-service.js";

export interface HostedProviderProbeResult {
  status: "ready" | "failed";
  failureCode?: string;
}

export interface HostedProviderProbe {
  test(input: {
    provider: typeof hostedProvider;
    model: string;
    apiKey: string;
    signal?: AbortSignal;
  }): Promise<HostedProviderProbeResult>;
}

export interface CreateHostedAgentInput {
  teamId: string;
  name: string;
  role: string;
  provider: typeof hostedProvider;
  model: string;
  apiKey: string;
  roomIds: readonly string[];
  now: string;
}

export interface UpdateHostedAgentProfileInput {
  agentId: string;
  expectedProfileRevision: number;
  model: string;
  apiKey?: string;
  now: string;
}

function normalizedModel(value: string): string {
  const model = value.trim();
  if (
    model !== value ||
    model.length < 1 ||
    model.length > 160 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(model)
  ) {
    throw new Error("Hosted model identifier is invalid");
  }
  return model;
}

function validatedApiKey(value: string): string {
  const length = Buffer.byteLength(value, "utf8");
  if (
    value.trim() !== value ||
    length < 16 ||
    length > 512 ||
    /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new Error(
      "Hosted provider credential must contain 16 to 512 bytes without whitespace"
    );
  }
  return value;
}

function validatedProvider(value: string): typeof hostedProvider {
  if (value !== hostedProvider) {
    throw new Error("Hosted provider is not supported");
  }
  return value;
}

function validatedRoomIds(roomIds: readonly string[]): readonly string[] {
  if (
    !Array.isArray(roomIds) ||
    roomIds.length > 100 ||
    roomIds.some((roomId) =>
      typeof roomId !== "string" ||
      !/^room_[A-Za-z0-9_-]{8,128}$/u.test(roomId)
    ) ||
    new Set(roomIds).size !== roomIds.length
  ) {
    throw new Error("Hosted Agent Room IDs must contain up to 100 unique Rooms");
  }
  return roomIds;
}

function requirePositiveRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Hosted Runtime Profile revision is invalid");
  }
  return value;
}

export class HostedAgentConfigurationService {
  public constructor(
    private readonly repository: HostedAgentRepository,
    private readonly core: CoreRepository,
    private readonly agents: AgentService,
    private readonly auth: AuthService,
    private readonly transactions: SqliteTransactionBoundary,
    private readonly probe: HostedProviderProbe,
    private readonly onCredentialRevoked?: (agentId: string) => void
  ) {}

  public list(
    principal: WebPrincipal,
    teamId: string
  ): HostedAgentConfigurationRecord[] {
    this.requireOwner(principal, teamId);
    return this.repository.listConfigurations(teamId);
  }

  public async testConnection(
    principal: WebPrincipal,
    input: {
      teamId: string;
      provider: string;
      model: string;
      apiKey: string;
      now: string;
    }
  ): Promise<HostedProviderTestObservation> {
    this.requireOwner(principal, input.teamId);
    const provider = validatedProvider(input.provider);
    const model = normalizedModel(input.model);
    const apiKey = validatedApiKey(input.apiKey);
    const result = await this.safeProbe({ provider, model, apiKey });
    return this.repository.recordTestObservation({
      teamId: input.teamId,
      provider,
      model,
      observedByMemberId: this.requireOwner(principal, input.teamId).memberId,
      status: result.status === "ready" ? "succeeded" : "failed",
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      now: input.now
    });
  }

  public async create(
    principal: WebPrincipal,
    input: CreateHostedAgentInput
  ): Promise<HostedAgentConfigurationRecord> {
    const actor = this.requireOwner(principal, input.teamId);
    const provider = validatedProvider(input.provider);
    const model = normalizedModel(input.model);
    const apiKey = validatedApiKey(input.apiKey);
    const roomIds = validatedRoomIds(input.roomIds);
    this.requireRooms(input.teamId, roomIds);
    const test = await this.safeProbe({ provider, model, apiKey });
    if (test.status !== "ready") {
      throw new Error("Hosted provider connection test failed");
    }

    const agent = this.transactions.immediate(() => {
      const created = this.agents.publishAgent(principal, {
        teamId: input.teamId,
        deviceId: null,
        name: input.name,
        role: input.role,
        integrationMode: "hosted",
        capabilities: {
          supportsHandoff: true,
          supportsInterrupt: true,
          supportsResume: false,
          supportsStart: true,
          supportsStreaming: true
        },
        roomIds,
        now: input.now
      });
      const credential = this.repository.createCredential({
        agentId: created.agentId,
        teamId: created.teamId,
        createdByMemberId: actor.memberId,
        apiKey,
        now: input.now
      });
      const profile = this.repository.createProfile({
        agentId: created.agentId,
        teamId: created.teamId,
        provider,
        model,
        credentialVersion: credential.credentialVersion,
        createdByMemberId: actor.memberId,
        now: input.now
      });
      this.repository.recordTestObservation({
        teamId: created.teamId,
        agentId: created.agentId,
        profileRevision: profile.profileRevision,
        provider,
        model,
        observedByMemberId: actor.memberId,
        status: "succeeded",
        now: input.now
      });
      this.core.updateAgentPresence(
        created.agentId,
        roomIds.length > 0 ? "ready" : "degraded",
        input.now
      );
      return created;
    });
    return this.configuration(agent.teamId, agent.agentId);
  }

  public async testConfigured(
    principal: WebPrincipal,
    agentId: string,
    now: string
  ): Promise<HostedProviderTestObservation> {
    const agent = this.requireHostedAgent(principal, agentId);
    const execution = this.repository.resolveExecutionProfile(agentId);
    let result: HostedProviderProbeResult;
    try {
      result = await this.safeProbe(execution);
    } finally {
      execution.apiKey = "";
    }
    const observation = this.repository.recordTestObservation({
      teamId: agent.teamId,
      agentId,
      profileRevision: execution.profileRevision,
      provider: execution.provider,
      model: execution.model,
      observedByMemberId: this.requireOwner(principal, agent.teamId).memberId,
      status: result.status === "ready" ? "succeeded" : "failed",
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      now
    });
    if (agent.presence !== "busy") {
      this.core.updateAgentPresence(
        agentId,
        result.status === "ready" && this.repository.getAvailability(agentId) === "ready"
          ? "ready"
          : "degraded",
        now
      );
    }
    return observation;
  }

  public async updateProfile(
    principal: WebPrincipal,
    input: UpdateHostedAgentProfileInput
  ): Promise<HostedAgentConfigurationRecord> {
    const agent = this.requireHostedAgent(principal, input.agentId);
    if (this.core.hasActiveWorkForAgent(agent.agentId)) {
      throw new Error("Hosted Agent configuration is locked while work is active");
    }
    const expectedProfileRevision = requirePositiveRevision(
      input.expectedProfileRevision
    );
    const model = normalizedModel(input.model);
    const currentProfile = this.repository.getCurrentProfile(agent.agentId);
    if (!currentProfile) {
      throw new Error("Hosted Agent Runtime Profile is unavailable");
    }
    const currentExecution = input.apiKey === undefined
      ? this.repository.resolveExecutionProfile(agent.agentId)
      : undefined;
    let apiKey = input.apiKey === undefined
      ? currentExecution!.apiKey
      : validatedApiKey(input.apiKey);
    try {
      const test = await this.safeProbe({
        provider: currentProfile.provider,
        model,
        apiKey
      });
      if (test.status !== "ready") {
        throw new Error("Hosted provider connection test failed");
      }
      this.transactions.immediate(() => {
        const actor = this.requireOwner(principal, agent.teamId);
        const credentialVersion = input.apiKey === undefined
          ? currentProfile.credentialVersion
          : this.repository.createCredential({
              agentId: agent.agentId,
              teamId: agent.teamId,
              createdByMemberId: actor.memberId,
              apiKey,
              now: input.now
            }).credentialVersion;
        const profile = this.repository.createProfile({
          agentId: agent.agentId,
          teamId: agent.teamId,
          provider: currentProfile.provider,
          model,
          credentialVersion,
          createdByMemberId: actor.memberId,
          expectedRevision: expectedProfileRevision,
          now: input.now
        });
        this.repository.recordTestObservation({
          teamId: agent.teamId,
          agentId: agent.agentId,
          profileRevision: profile.profileRevision,
          provider: profile.provider,
          model: profile.model,
          observedByMemberId: actor.memberId,
          status: "succeeded",
          now: input.now
        });
        this.core.updateAgentPresence(
          agent.agentId,
          this.repository.getAvailability(agent.agentId) === "ready"
            ? "ready"
            : "degraded",
          input.now
        );
      });
    } finally {
      if (currentExecution) currentExecution.apiKey = "";
      apiKey = "";
    }
    return this.configuration(agent.teamId, agent.agentId);
  }

  public revokeCredential(
    principal: WebPrincipal,
    agentId: string,
    expectedProfileRevision: number,
    now: string
  ): HostedAgentConfigurationRecord {
    const agent = this.requireHostedAgent(principal, agentId);
    const revoked = this.repository.revokeCurrentCredential(
      agentId,
      requirePositiveRevision(expectedProfileRevision),
      now
    );
    if (!revoked) throw new Error("Hosted Agent credential is already revoked");
    this.core.updateAgentPresence(agentId, "degraded", now);
    this.onCredentialRevoked?.(agentId);
    return this.configuration(agent.teamId, agentId);
  }

  private requireOwner(
    principal: WebPrincipal,
    teamId: string
  ): MemberPrincipal {
    const actor = this.auth.requireTeamMember(principal, teamId);
    if (actor.role !== "owner") {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Only a Team owner can configure Hosted Agents"
      );
    }
    return actor;
  }

  private requireHostedAgent(
    principal: WebPrincipal,
    agentId: string
  ) {
    const agent = this.core.getAgent(agentId);
    if (!agent || agent.integrationMode !== "hosted") {
      throw new Error(`Hosted Agent not found: ${agentId}`);
    }
    this.requireOwner(principal, agent.teamId);
    return agent;
  }

  private requireRooms(teamId: string, roomIds: readonly string[]): void {
    for (const roomId of roomIds) {
      const room = this.core.getRoom(roomId);
      if (!room || room.teamId !== teamId || room.archivedAt !== null) {
        throw new AuthorizationError("FORBIDDEN", "Hosted Agent Room access denied");
      }
    }
  }

  private configuration(
    teamId: string,
    agentId: string
  ): HostedAgentConfigurationRecord {
    const result = this.repository.listConfigurations(teamId)
      .find((candidate) => candidate.agentId === agentId);
    if (!result) throw new Error(`Hosted Agent configuration not found: ${agentId}`);
    return result;
  }

  private async safeProbe(input: {
    provider: typeof hostedProvider;
    model: string;
    apiKey: string;
  }): Promise<HostedProviderProbeResult> {
    try {
      const result = await this.probe.test(input);
      if (result.status === "ready") return result;
      return {
        status: "failed",
        failureCode: result.failureCode ?? "HOSTED_PROVIDER_UNAVAILABLE"
      };
    } catch {
      return {
        status: "failed",
        failureCode: "HOSTED_PROVIDER_UNAVAILABLE"
      };
    }
  }
}
