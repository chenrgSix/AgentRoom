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

export interface CreatedTeam {
  team: TeamRecord;
  owner: MemberRecord;
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
    private readonly auth: AuthService
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
      createdAt: input.now
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

  public listTeams(principal: WebPrincipal): TeamRecord[] {
    return this.repository.listTeamsForUser(principal.userId);
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
      createdAt: now
    };
    this.repository.createRoom(room);
    return room;
  }

  public listRooms(
    principal: WebPrincipal,
    teamId: string
  ): RoomRecord[] {
    const member = this.auth.requireTeamMember(principal, teamId);
    return this.repository.listRoomsForMember(teamId, member.memberId);
  }

  public getRoomParticipants(
    principal: WebPrincipal,
    roomId: string
  ): RoomParticipants {
    this.auth.requireRoomMember(principal, roomId);
    return this.repository.getRoomParticipants(roomId);
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
    if (!Array.isArray(input.memberIds) || !Array.isArray(input.agentIds)) {
      throw new Error("Room participant IDs must be arrays");
    }
    const memberIds = [...new Set(input.memberIds)];
    const agentIds = [...new Set(input.agentIds)];
    if (memberIds.length !== input.memberIds.length || agentIds.length !== input.agentIds.length) {
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
    return this.repository.replaceRoomParticipants(
      roomId,
      { memberIds, agentIds },
      now
    );
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
}
