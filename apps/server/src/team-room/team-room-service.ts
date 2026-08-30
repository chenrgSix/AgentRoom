import type {
  CoreRepository,
  MemberRecord,
  RoomParticipants,
  RoomRecord,
  TeamRecord
} from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type {
  AuthService,
  MemberPrincipal,
  WebPrincipal
} from "../security/auth-service.js";
import {
  defaultRoomCollaborationPolicy,
  parseRoomCollaborationPolicy,
  type RoomCollaborationPolicy
} from "./room-collaboration-policy.js";

export interface CreatedTeam {
  team: TeamRecord;
  owner: MemberRecord;
}

export interface RoomSettings {
  room: RoomRecord;
  participants: RoomParticipants;
}

export interface HostedRoomAvailabilitySource {
  getAvailability(agentId: string): "ready" | "degraded" | undefined;
}

function normalizedName(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    throw new Error(`${label} must contain 1 to 80 characters`);
  }
  return normalized;
}

export class TeamRoomService {
  public constructor(
    private readonly repository: CoreRepository,
    private readonly auth: AuthService,
    private readonly hostedAgents?: HostedRoomAvailabilitySource
  ) {}

  public createTeamForUser(input: {
    userId: string;
    userDisplayName: string;
    teamName: string;
    now: string;
  }): CreatedTeam {
    const displayName = normalizedName(input.userDisplayName, "User display name");
    const teamName = normalizedName(input.teamName, "Team name");
    this.repository.ensureUser({
      userId: input.userId,
      displayName,
      createdAt: input.now
    });
    const team: TeamRecord = {
      teamId: createOpaqueId("team"),
      name: teamName,
      createdAt: input.now,
      archivedAt: null
    };
    const owner: MemberRecord = {
      memberId: createOpaqueId("member"),
      teamId: team.teamId,
      userId: input.userId,
      displayName,
      role: "owner",
      createdAt: input.now
    };
    this.repository.createTeamWithOwner(team, owner);
    return { team, owner };
  }

  public listTeams(principal: WebPrincipal, includeArchived = false): TeamRecord[] {
    return this.repository.listTeamsForUser(principal.userId, includeArchived);
  }

  public createRoom(
    principal: WebPrincipal,
    teamId: string,
    name: string,
    now: string
  ): RoomRecord {
    this.auth.requireTeamMember(principal, teamId);
    const room: RoomRecord = {
      roomId: createOpaqueId("room"),
      teamId,
      name: normalizedName(name, "Room name"),
      collaborationPolicy: { ...defaultRoomCollaborationPolicy },
      settingsRevision: 1,
      createdAt: now,
      archivedAt: null
    };
    this.repository.createRoom(room);
    return room;
  }

  public listRooms(
    principal: WebPrincipal,
    teamId: string,
    includeArchived = false
  ): RoomRecord[] {
    const member = this.auth.requireTeamMember(principal, teamId, { includeArchived });
    return this.repository.listRoomsForMember(
      teamId,
      member.memberId,
      includeArchived
    );
  }

  public updateTeam(
    principal: WebPrincipal,
    teamId: string,
    input: { name?: string; archived?: boolean },
    now: string
  ): TeamRecord {
    const actor = this.auth.requireTeamMember(principal, teamId, {
      includeArchived: true
    });
    if (actor.role !== "owner") {
      throw new Error("Only a Team owner can manage Team lifecycle");
    }
    const existing = this.repository.getTeam(teamId);
    if (!existing) throw new Error("Authorized Team disappeared during lifecycle update");
    if (input.name === undefined && input.archived === undefined) {
      throw new Error("Team lifecycle update requires name or archived");
    }
    if (input.archived === true && this.repository.hasActiveWorkForTeam(teamId)) {
      throw new Error("Team cannot be archived while Runs or Discussions are active");
    }
    return this.repository.updateTeamLifecycle(teamId, {
      name: input.name === undefined
        ? existing.name
        : normalizedName(input.name, "Team name"),
      archivedAt: input.archived === undefined
        ? existing.archivedAt ?? null
        : input.archived ? now : null
    });
  }

  public updateRoom(
    principal: WebPrincipal,
    roomId: string,
    input: { name?: string; archived?: boolean },
    now: string
  ): RoomRecord {
    const existing = this.repository.getRoom(roomId);
    if (!existing) throw new Error(`Room not found: ${roomId}`);
    const actor = this.auth.requireTeamMember(principal, existing.teamId, {
      includeArchived: true
    });
    if (actor.role !== "owner") {
      throw new Error("Only a Team owner can manage Room lifecycle");
    }
    if (input.name === undefined && input.archived === undefined) {
      throw new Error("Room lifecycle update requires name or archived");
    }
    if (input.archived === false) {
      const team = this.repository.getTeam(existing.teamId);
      if (team?.archivedAt) {
        throw new Error("Room cannot be restored while its Team is archived");
      }
    }
    if (input.archived === true && this.repository.hasActiveWorkForRoom(roomId)) {
      throw new Error("Room cannot be archived while Runs or Discussions are active");
    }
    const participantIds = this.repository.getRoomParticipants(roomId).agentIds;
    const priorAvailability = this.captureHostedAvailability(participantIds);
    const updated = this.repository.updateRoomLifecycle(roomId, {
      name: input.name === undefined
        ? existing.name
        : normalizedName(input.name, "Room name"),
      archivedAt: input.archived === undefined
        ? existing.archivedAt ?? null
        : input.archived ? now : null
    });
    if (updated.archivedAt !== existing.archivedAt) {
      this.projectHostedAvailability(participantIds, priorAvailability, now);
    }
    return updated;
  }

  public getRoomParticipants(
    principal: WebPrincipal,
    roomId: string
  ): RoomParticipants {
    this.auth.requireRoomMember(principal, roomId);
    return this.repository.getRoomParticipants(roomId);
  }

  public getRoomSettings(
    principal: WebPrincipal,
    roomId: string
  ): RoomSettings {
    this.auth.requireRoomMember(principal, roomId);
    const room = this.repository.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    return {
      room,
      participants: this.repository.getRoomParticipants(roomId)
    };
  }

  public replaceRoomParticipants(
    principal: WebPrincipal,
    roomId: string,
    input: RoomParticipants,
    now: string
  ): RoomParticipants {
    const actor = this.auth.requireRoomMember(principal, roomId);
    if (actor.role !== "owner") {
      throw new Error("Only a Team owner can manage Room participants");
    }
    const room = this.repository.getRoom(roomId);
    if (!room) {
      throw new Error("Authorized Room disappeared during participant update");
    }
    const { memberIds, agentIds } = this.validateRoomParticipants(room, input);
    const previousAgentIds = this.repository.getRoomParticipants(roomId).agentIds;
    const affectedAgentIds = [...new Set([...previousAgentIds, ...agentIds])];
    const priorAvailability = this.captureHostedAvailability(affectedAgentIds);
    const participants = this.repository.replaceRoomParticipants(
      roomId,
      { memberIds, agentIds },
      now
    );
    this.projectHostedAvailability(affectedAgentIds, priorAvailability, now);
    return participants;
  }

  public updateRoomSettings(
    principal: WebPrincipal,
    roomId: string,
    input: {
      participants: RoomParticipants;
      collaborationPolicy: RoomCollaborationPolicy;
      expectedRevision: number;
    },
    now: string
  ): RoomSettings {
    const actor = this.auth.requireRoomMember(principal, roomId);
    if (actor.role !== "owner") {
      throw new Error("Only a Team owner can manage Room settings");
    }
    const room = this.repository.getRoom(roomId);
    if (!room) throw new Error("Authorized Room disappeared during settings update");
    const participants = this.validateRoomParticipants(room, input.participants);
    const collaborationPolicy = parseRoomCollaborationPolicy(
      input.collaborationPolicy
    );
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      throw new Error("Room settings revision must be a positive integer");
    }
    const previousAgentIds = this.repository.getRoomParticipants(roomId).agentIds;
    const affectedAgentIds = [
      ...new Set([...previousAgentIds, ...participants.agentIds])
    ];
    const priorAvailability = this.captureHostedAvailability(affectedAgentIds);
    const settings = this.repository.replaceRoomSettings(
      roomId,
      participants,
      collaborationPolicy,
      input.expectedRevision,
      now
    );
    this.projectHostedAvailability(affectedAgentIds, priorAvailability, now);
    return settings;
  }

  public getRoom(
    principal: WebPrincipal,
    roomId: string
  ): { member: MemberPrincipal; room: RoomRecord } {
    const member = this.auth.requireRoomMember(principal, roomId);
    const room = this.repository.getRoom(roomId);
    if (!room) {
      throw new Error("Authorized Room disappeared during lookup");
    }
    return { member, room };
  }

  private validateRoomParticipants(
    room: RoomRecord,
    input: RoomParticipants
  ): RoomParticipants {
    if (!Array.isArray(input.memberIds) || !Array.isArray(input.agentIds)) {
      throw new Error("Room participant IDs must be arrays");
    }
    const memberIds = [...new Set(input.memberIds)];
    const agentIds = [...new Set(input.agentIds)];
    if (
      memberIds.length !== input.memberIds.length ||
      agentIds.length !== input.agentIds.length
    ) {
      throw new Error("Room participant IDs must be unique");
    }
    const teamMembers = this.repository.listMembers(room.teamId);
    const allowedMembers = new Set(teamMembers.map(({ memberId }) => memberId));
    if (memberIds.some((memberId) => !allowedMembers.has(memberId))) {
      throw new Error("Room member must belong to the Room Team");
    }
    const requiredOwners = teamMembers
      .filter(({ role }) => role === "owner")
      .map(({ memberId }) => memberId);
    if (requiredOwners.some((memberId) => !memberIds.includes(memberId))) {
      throw new Error("Team owners cannot be removed from a Room");
    }
    const teamAgents = new Map(
      this.repository.listAgents(room.teamId).map((agent) => [agent.agentId, agent])
    );
    if (agentIds.some((agentId) => {
      const agent = teamAgents.get(agentId);
      return !agent || !agent.enabled;
    })) {
      throw new Error("Room Agent must be an enabled Agent in the Room Team");
    }
    return { memberIds, agentIds };
  }

  private captureHostedAvailability(
    agentIds: string[]
  ): Map<string, "ready" | "degraded" | undefined> {
    const availability = new Map<
      string,
      "ready" | "degraded" | undefined
    >();
    if (!this.hostedAgents) return availability;
    for (const agentId of agentIds) {
      const agent = this.repository.getAgent(agentId);
      if (agent?.integrationMode === "hosted") {
        availability.set(agentId, this.hostedAgents.getAvailability(agentId));
      }
    }
    return availability;
  }

  private projectHostedAvailability(
    agentIds: string[],
    priorAvailability: Map<string, "ready" | "degraded" | undefined>,
    now: string
  ): void {
    if (!this.hostedAgents) return;
    for (const agentId of agentIds) {
      const agent = this.repository.getAgent(agentId);
      if (!agent || agent.integrationMode !== "hosted" || !agent.enabled) continue;
      const availability = this.hostedAgents.getAvailability(agentId);
      if (availability !== "ready") {
        this.repository.updateAgentPresence(agentId, "degraded", now);
      } else if (
        priorAvailability.get(agentId) !== "ready" &&
        agent.presence !== "busy"
      ) {
        // Promote only when this Room mutation repairs an availability gap.
        // Unrelated Room edits must not erase a persisted provider failure.
        this.repository.updateAgentPresence(agentId, "ready", now);
      }
    }
  }
}
