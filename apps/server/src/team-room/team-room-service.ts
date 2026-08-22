import type {
  CoreRepository,
  MemberRecord,
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
    this.auth.requireTeamMember(principal, teamId);
    return this.repository.listRooms(teamId);
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
