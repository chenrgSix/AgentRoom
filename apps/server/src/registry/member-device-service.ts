import type {
  CoreRepository,
  DeviceRecord,
  MemberRecord
} from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";

function normalizedName(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 80) {
    throw new Error(`${label} must contain 1 to 80 characters`);
  }
  return normalized;
}

export class MemberDeviceService {
  public constructor(
    private readonly repository: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public addMember(
    principal: WebPrincipal,
    input: {
      teamId: string;
      userId: string;
      displayName: string;
      now: string;
    }
  ): MemberRecord {
    const actor = this.auth.requireTeamMember(principal, input.teamId);
    if (actor.role !== "owner") {
      throw new AuthorizationError("FORBIDDEN", "Only a Team owner can add members");
    }
    const displayName = normalizedName(input.displayName, "Member display name");
    this.repository.ensureUser({
      userId: input.userId,
      displayName,
      createdAt: input.now
    });
    const member: MemberRecord = {
      memberId: createOpaqueId("member"),
      teamId: input.teamId,
      userId: input.userId,
      displayName,
      role: "member",
      createdAt: input.now
    };
    this.repository.createMember(member);
    return member;
  }

  public listMembers(
    principal: WebPrincipal,
    teamId: string
  ): MemberRecord[] {
    this.auth.requireTeamMember(principal, teamId);
    return this.repository.listMembers(teamId);
  }

  public registerOwnDevice(
    principal: WebPrincipal,
    teamId: string,
    name: string,
    now: string
  ): DeviceRecord {
    const member = this.auth.requireTeamMember(principal, teamId);
    const device: DeviceRecord = {
      deviceId: createOpaqueId("device"),
      teamId,
      ownerMemberId: member.memberId,
      name: normalizedName(name, "Device name"),
      status: "active",
      createdAt: now,
      revokedAt: null
    };
    this.repository.createDevice(device);
    return device;
  }

  public listDevices(
    principal: WebPrincipal,
    teamId: string
  ): DeviceRecord[] {
    this.auth.requireTeamMember(principal, teamId);
    return this.repository.listDevices(teamId);
  }
}
