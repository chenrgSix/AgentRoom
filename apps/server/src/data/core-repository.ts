import type Database from "better-sqlite3";

import type { RoomCollaborationPolicy } from "../team-room/room-collaboration-policy.js";
import {
  MessageRepository,
  type AppendMessageInput
} from "./message-repository.js";
import { AgentDeviceRepository } from "./agent-device-repository.js";
import { SqliteTransactionBoundary } from "./sqlite-transaction-boundary.js";
import { TeamRoomRepository } from "./team-room-repository.js";

export interface WebUserRecord {
  userId: string;
  displayName: string;
  createdAt: string;
}

export interface TeamRecord {
  teamId: string;
  name: string;
  createdAt: string;
  archivedAt?: string | null;
}

export interface MemberRecord {
  memberId: string;
  teamId: string;
  userId: string | null;
  displayName: string;
  role: "owner" | "member";
  createdAt: string;
}

export interface RoomRecord {
  roomId: string;
  teamId: string;
  name: string;
  collaborationPolicy: RoomCollaborationPolicy;
  settingsRevision: number;
  createdAt: string;
  archivedAt?: string | null;
}

export interface RoomParticipants {
  memberIds: string[];
  agentIds: string[];
}

export interface DeviceRecord {
  deviceId: string;
  teamId: string;
  ownerMemberId: string;
  name: string;
  status: "active" | "revoked";
  createdAt: string;
  revokedAt: string | null;
}

export interface AgentCapabilities {
  supportsHandoff: boolean;
  supportsInterrupt: boolean;
  supportsResume: boolean;
  supportsStart: boolean;
  supportsStreaming: boolean;
  supportsRoomContextCoverage?: boolean;
}

export interface AgentRecord {
  agentId: string;
  teamId: string;
  ownerMemberId: string;
  deviceId: string | null;
  name: string;
  role: string;
  integrationMode: "managed" | "manual" | "fake";
  capabilities: AgentCapabilities;
  runtimeScopeId?: string | null;
  enabled: boolean;
  presence: "ready" | "busy" | "degraded" | "manual" | "offline";
  createdAt: string;
  updatedAt: string;
}

export interface MentionRecord {
  targetType: "agent";
  targetAgentId: string;
  displayLabel: string;
}

export interface MessageRecord {
  messageId: string;
  traceId: string;
  roomId: string;
  taskId: string;
  sequence: number;
  senderType: "member" | "agent" | "system";
  senderId: string;
  content: string;
  mentions: MentionRecord[];
  parentMessageId: string | null;
  clientMessageId?: string | null;
  createdAt: string;
}

export interface DevicePresenceRecord {
  deviceId: string;
  connectionEpoch: number;
  adapterAvailable: boolean;
  lastHeartbeatAt: string;
}

export class CoreRepository {
  private readonly messages: MessageRepository;
  private readonly agentsAndDevices: AgentDeviceRepository;
  private readonly teamsAndRooms: TeamRoomRepository;

  public constructor(
    database: Database.Database,
    transactions = new SqliteTransactionBoundary(database)
  ) {
    this.messages = new MessageRepository(database, transactions);
    this.agentsAndDevices = new AgentDeviceRepository(database, transactions);
    this.teamsAndRooms = new TeamRoomRepository(database, transactions);
  }

  public createUser(user: WebUserRecord): void {
    this.teamsAndRooms.createUser(user);
  }

  public ensureUser(user: WebUserRecord): void {
    this.teamsAndRooms.ensureUser(user);
  }

  public getUser(userId: string): WebUserRecord | undefined {
    return this.teamsAndRooms.getUser(userId);
  }

  public createTeamWithOwner(team: TeamRecord, owner: MemberRecord): void {
    this.teamsAndRooms.createTeamWithOwner(team, owner);
  }

  public createMember(member: MemberRecord): void {
    this.teamsAndRooms.createMember(member);
  }

  public createRoom(room: RoomRecord): void {
    this.teamsAndRooms.createRoom(room);
  }

  public createDevice(device: DeviceRecord): void {
    this.agentsAndDevices.createDevice(device);
  }

  public createAgent(agent: AgentRecord): void {
    this.agentsAndDevices.createAgent(agent);
  }

  public updateAgentPublication(agent: AgentRecord): void {
    this.agentsAndDevices.updateAgentPublication(agent);
  }

  public appendMessage(
    message: AppendMessageInput
  ): MessageRecord {
    return this.messages.append(message);
  }

  public appendMessageWithResult(
    message: AppendMessageInput
  ): { created: boolean; message: MessageRecord } {
    return this.messages.appendWithResult(message);
  }

  public getTeam(teamId: string): TeamRecord | undefined {
    return this.teamsAndRooms.getTeam(teamId);
  }

  public listTeamsForUser(userId: string, includeArchived = false): TeamRecord[] {
    return this.teamsAndRooms.listTeamsForUser(userId, includeArchived);
  }

  public updateTeamLifecycle(
    teamId: string,
    input: { name: string; archivedAt: string | null }
  ): TeamRecord {
    return this.teamsAndRooms.updateTeamLifecycle(teamId, input);
  }

  public getMember(memberId: string): MemberRecord | undefined {
    return this.teamsAndRooms.getMember(memberId);
  }

  public listMembers(teamId: string): MemberRecord[] {
    return this.teamsAndRooms.listMembers(teamId);
  }

  public getRoom(roomId: string): RoomRecord | undefined {
    return this.teamsAndRooms.getRoom(roomId);
  }

  public listRooms(teamId: string, includeArchived = false): RoomRecord[] {
    return this.teamsAndRooms.listRooms(teamId, includeArchived);
  }

  public listRoomsForMember(
    teamId: string,
    memberId: string,
    includeArchived = false
  ): RoomRecord[] {
    return this.teamsAndRooms.listRoomsForMember(
      teamId,
      memberId,
      includeArchived
    );
  }

  public updateRoomLifecycle(
    roomId: string,
    input: { name: string; archivedAt: string | null }
  ): RoomRecord {
    return this.teamsAndRooms.updateRoomLifecycle(roomId, input);
  }

  public replaceRoomSettings(
    roomId: string,
    participants: RoomParticipants,
    collaborationPolicy: RoomCollaborationPolicy,
    expectedRevision: number,
    updatedAt: string
  ): { participants: RoomParticipants; room: RoomRecord } {
    return this.teamsAndRooms.replaceRoomSettings(
      roomId,
      participants,
      collaborationPolicy,
      expectedRevision,
      updatedAt
    );
  }

  public hasActiveWorkForRoom(roomId: string): boolean {
    return this.teamsAndRooms.hasActiveWorkForRoom(roomId);
  }

  public hasActiveWorkForTeam(teamId: string): boolean {
    return this.teamsAndRooms.hasActiveWorkForTeam(teamId);
  }

  public hasActiveWorkForAgent(agentId: string): boolean {
    return this.agentsAndDevices.hasActiveWork(agentId);
  }

  public isRoomMember(roomId: string, memberId: string): boolean {
    return this.teamsAndRooms.isRoomMember(roomId, memberId);
  }

  public isRoomAgent(roomId: string, agentId: string): boolean {
    return this.teamsAndRooms.isRoomAgent(roomId, agentId);
  }

  public getRoomParticipants(roomId: string): RoomParticipants {
    return this.teamsAndRooms.getRoomParticipants(roomId);
  }

  public replaceRoomParticipants(
    roomId: string,
    participants: RoomParticipants,
    addedAt: string
  ): RoomParticipants {
    return this.teamsAndRooms.replaceRoomParticipants(
      roomId,
      participants,
      addedAt
    );
  }

  public getDevice(deviceId: string): DeviceRecord | undefined {
    return this.agentsAndDevices.getDevice(deviceId);
  }

  public listDevices(teamId: string): DeviceRecord[] {
    return this.agentsAndDevices.listDevices(teamId);
  }

  public revokeDevice(deviceId: string, now: string): DeviceRecord | undefined {
    return this.agentsAndDevices.revokeDevice(deviceId, now);
  }

  public getAgent(agentId: string): AgentRecord | undefined {
    return this.agentsAndDevices.getAgent(agentId);
  }

  public listAgents(teamId: string): AgentRecord[] {
    return this.agentsAndDevices.listAgents(teamId);
  }

  public setAgentEnabled(
    agentId: string,
    enabled: boolean,
    now: string
  ): AgentRecord {
    return this.agentsAndDevices.setAgentEnabled(agentId, enabled, now);
  }

  public recordDevicePresence(record: DevicePresenceRecord): void {
    this.agentsAndDevices.recordPresence(record);
  }

  public getDevicePresence(deviceId: string): DevicePresenceRecord | undefined {
    return this.agentsAndDevices.getPresence(deviceId);
  }

  public updateAgentPresence(
    agentId: string,
    presence: AgentRecord["presence"],
    now: string
  ): void {
    this.agentsAndDevices.updateAgentPresence(agentId, presence, now);
  }

  public getMessage(messageId: string): MessageRecord | undefined {
    return this.messages.get(messageId);
  }

  public findAgentReply(
    parentMessageId: string,
    agentId: string
  ): MessageRecord | undefined {
    return this.messages.findAgentReply(parentMessageId, agentId);
  }

  public listMessagesAfter(
    roomId: string,
    sequence: number,
    limit: number
  ): MessageRecord[] {
    return this.messages.listAfter(roomId, sequence, limit);
  }

  public listMessagesRange(
    roomId: string,
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
    limit: number
  ): MessageRecord[] {
    return this.messages.listRange(
      roomId,
      fromSequenceExclusive,
      throughSequenceInclusive,
      limit
    );
  }

  public listMessagesThrough(
    roomId: string,
    sequence: number,
    limit: number
  ): MessageRecord[] {
    return this.messages.listThrough(roomId, sequence, limit);
  }

  public listTaskMessagesThrough(
    taskId: string,
    sequence: number,
    limit: number
  ): MessageRecord[] {
    return this.messages.listTaskThrough(taskId, sequence, limit);
  }

  public latestMessageSequence(roomId: string): number {
    return this.messages.latestSequence(roomId);
  }
}
