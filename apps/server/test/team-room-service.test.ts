import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { AuthService, AuthorizationError } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-team-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const repository = new CoreRepository(database);
  const auth = new AuthService(database);
  return {
    auth,
    database,
    repository,
    service: new TeamRoomService(repository, auth)
  };
}

test("a user creates and reloads Teams and Rooms", async () => {
  const { auth, database, service } = await createFixture();
  try {
    const created = service.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      userDisplayName: " Alice ",
      teamName: " Core Team ",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = service.createRoom(principal, created.team.teamId, " general ", now);

    assert.equal(created.team.name, "Core Team");
    assert.equal(room.name, "general");
    assert.deepEqual(service.listTeams(principal), [created.team]);
    assert.deepEqual(service.listRooms(principal, created.team.teamId), [room]);
    assert.equal(service.getRoom(principal, room.roomId).member.role, "owner");
  } finally {
    database.close();
  }
});

test("an Owner persists Room collaboration policy with participant settings", async () => {
  const { auth, database, repository, service } = await createFixture();
  try {
    const created = service.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5P1",
      userDisplayName: "Alice",
      teamName: "Policy Team",
      now
    });
    const ownerSession = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const owner = auth.authenticateWebSession(ownerSession.secret, now);
    const room = service.createRoom(owner, created.team.teamId, "governed", now);
    assert.deepEqual(room.collaborationPolicy, {
      allowDiscussion: true,
      allowAll: true,
      allowAgentMentions: true,
      maxAgentMentionDepth: 4
    });

    repository.createUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5P2",
      displayName: "Bob",
      createdAt: now
    });
    repository.createMember({
      memberId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5P2",
      teamId: created.team.teamId,
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5P2",
      displayName: "Bob",
      role: "member",
      createdAt: now
    });
    const bobSession = auth.issueWebSession(
      "user_01K4Z6J7Y8N9P0Q1R2S3T4V5P2",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const bob = auth.authenticateWebSession(bobSession.secret, now);
    const policy = {
      allowDiscussion: false,
      allowAll: false,
      allowAgentMentions: false,
      maxAgentMentionDepth: 2
    };
    assert.throws(() => service.updateRoomSettings(bob, room.roomId, {
      participants: service.getRoomParticipants(owner, room.roomId),
      expectedRevision: service.getRoomSettings(owner, room.roomId).room.settingsRevision,
      collaborationPolicy: policy
    }, now), /Only a Team owner/u);

    const initialSettings = service.getRoomSettings(owner, room.roomId);
    const settings = service.updateRoomSettings(owner, room.roomId, {
      participants: {
        memberIds: [created.owner.memberId],
        agentIds: []
      },
      expectedRevision: initialSettings.room.settingsRevision,
      collaborationPolicy: policy
    }, now);
    assert.deepEqual(settings.participants, {
      memberIds: [created.owner.memberId],
      agentIds: []
    });
    assert.deepEqual(settings.room.collaborationPolicy, policy);
    assert.equal(
      settings.room.settingsRevision,
      initialSettings.room.settingsRevision + 1
    );
    assert.deepEqual(service.getRoomSettings(owner, room.roomId), settings);
    assert.throws(() => service.updateRoomSettings(owner, room.roomId, {
      participants: initialSettings.participants,
      expectedRevision: initialSettings.room.settingsRevision,
      collaborationPolicy: { ...policy, allowAll: true }
    }, now), /Room settings changed; reload and retry/u);
    assert.throws(() => service.updateRoomSettings(owner, room.roomId, {
      participants: settings.participants,
      expectedRevision: settings.room.settingsRevision,
      collaborationPolicy: { ...policy, maxAgentMentionDepth: 5 }
    }, now), /depth from 1 to 4/u);
    assert.deepEqual(
      service.getRoomSettings(owner, room.roomId).room.collaborationPolicy,
      policy
    );
  } finally {
    database.close();
  }
});

test("Room settings restore Hosted availability without clearing unrelated failures", async () => {
  const { auth, database, repository, service } = await createFixture();
  try {
    const created = service.createTeamForUser({
      userId: "user_hosted_room_settings_12345678",
      userDisplayName: "Alice",
      teamName: "Hosted Room Settings",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const owner = auth.authenticateWebSession(session.secret, now);
    const room = service.createRoom(owner, created.team.teamId, "hosted", now);
    const agent = new AgentService(repository, auth).publishAgent(owner, {
      teamId: created.team.teamId,
      deviceId: null,
      name: "Hosted Reviewer",
      role: "Review",
      integrationMode: "hosted",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      roomIds: [],
      now
    });
    const projectedRooms = new TeamRoomService(repository, auth, {
      getAvailability(agentId) {
        if (agentId !== agent.agentId) return undefined;
        return repository.isRoomAgent(room.roomId, agentId) ? "ready" : "degraded";
      }
    });
    const updateParticipants = (agentIds: string[]) => {
      const settings = projectedRooms.getRoomSettings(owner, room.roomId);
      return projectedRooms.updateRoomSettings(owner, room.roomId, {
        participants: { memberIds: [created.owner.memberId], agentIds },
        collaborationPolicy: settings.room.collaborationPolicy,
        expectedRevision: settings.room.settingsRevision
      }, now);
    };

    assert.equal(repository.getAgent(agent.agentId)?.presence, "degraded");
    updateParticipants([agent.agentId]);
    assert.equal(repository.getAgent(agent.agentId)?.presence, "ready");

    repository.updateAgentPresence(agent.agentId, "degraded", now);
    updateParticipants([agent.agentId]);
    assert.equal(repository.getAgent(agent.agentId)?.presence, "degraded");

    updateParticipants([]);
    assert.equal(repository.getAgent(agent.agentId)?.presence, "degraded");
    updateParticipants([agent.agentId]);
    assert.equal(repository.getAgent(agent.agentId)?.presence, "ready");
  } finally {
    database.close();
  }
});

test("a non-member cannot discover Team Rooms", async () => {
  const { auth, database, repository, service } = await createFixture();
  try {
    const created = service.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      userDisplayName: "Alice",
      teamName: "Core Team",
      now
    });
    repository.createUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
      displayName: "Mallory",
      createdAt: now
    });
    const session = auth.issueWebSession(
      "user_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    assert.throws(
      () => service.listRooms(principal, created.team.teamId),
      (error: unknown) =>
        error instanceof AuthorizationError && error.code === "FORBIDDEN"
    );
  } finally {
    database.close();
  }
});

test("an Owner renames, archives, and restores Teams and Rooms without changing IDs", async () => {
  const { auth, database, repository, service } = await createFixture();
  try {
    const created = service.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      userDisplayName: "Alice",
      teamName: "Core Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = service.createRoom(principal, created.team.teamId, "general", now);

    const renamedRoom = service.updateRoom(
      principal,
      room.roomId,
      { name: "delivery" },
      now
    );
    assert.equal(renamedRoom.roomId, room.roomId);
    assert.equal(renamedRoom.name, "delivery");
    const archivedRoom = service.updateRoom(
      principal,
      room.roomId,
      { archived: true },
      now
    );
    assert.equal(archivedRoom.archivedAt, now);
    assert.deepEqual(service.listRooms(principal, created.team.teamId), []);
    assert.deepEqual(
      service.listRooms(principal, created.team.teamId, true),
      [archivedRoom]
    );
    assert.throws(() => service.getRoom(principal, room.roomId), /Room access denied/);
    assert.equal(
      service.updateRoom(principal, room.roomId, { archived: false }, now).archivedAt,
      null
    );

    const renamedTeam = service.updateTeam(
      principal,
      created.team.teamId,
      { name: "Delivery Team" },
      now
    );
    assert.equal(renamedTeam.teamId, created.team.teamId);
    assert.equal(renamedTeam.name, "Delivery Team");
    const archivedTeam = service.updateTeam(
      principal,
      created.team.teamId,
      { archived: true },
      now
    );
    assert.deepEqual(service.listTeams(principal), []);
    assert.deepEqual(service.listTeams(principal, true), [archivedTeam]);
    assert.throws(
      () => service.createRoom(principal, created.team.teamId, "blocked", now),
      /Team access denied/
    );
    assert.throws(
      () => service.updateRoom(principal, room.roomId, { archived: false }, now),
      /Team is archived/
    );
    assert.equal(
      service.updateTeam(principal, created.team.teamId, { archived: false }, now)
        .archivedAt,
      null
    );

    repository.createAgent({
      agentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      teamId: created.team.teamId,
      ownerMemberId: created.owner.memberId,
      deviceId: null,
      name: "Reviewer",
      role: "Reviewer",
      integrationMode: "manual",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: false,
        supportsResume: false,
        supportsStart: false,
        supportsStreaming: false
      },
      enabled: true,
      presence: "manual",
      createdAt: now,
      updatedAt: now
    });
    const message = repository.appendMessage({
      messageId: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      roomId: room.roomId,
      senderType: "member",
      senderId: created.owner.memberId,
      content: "Keep this active work fenced.",
      mentions: [],
      parentMessageId: null,
      createdAt: now
    });
    database.prepare(`
      INSERT INTO runs (
        run_id, room_id, task_id, trigger_message_id, requester_member_id,
        target_agent_id, parent_run_id, instruction, state, deadline_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'queued', ?, ?, ?)
    `).run(
      "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      room.roomId,
      message.taskId,
      message.messageId,
      created.owner.memberId,
      "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      "active",
      "2026-08-22T11:00:00.000Z",
      now,
      now
    );
    const agentService = new AgentService(repository, auth);
    assert.throws(
      () => service.updateRoom(principal, room.roomId, { archived: true }, now),
      /Runs or Discussions are active/
    );
    assert.throws(
      () => service.updateTeam(principal, created.team.teamId, { archived: true }, now),
      /Runs or Discussions are active/
    );
    assert.throws(
      () => agentService.setEnabled(
        principal,
        "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
        false,
        now
      ),
      /Runs or Discussions are active/
    );

    database.prepare(`
      UPDATE runs
      SET state = 'expired', updated_at = ?, terminal_at = ?
      WHERE run_id = ?
    `).run(now, now, "run_01K4Z6J7Y8N9P0Q1R2S3T4V5W6");

    assert.equal(
      agentService.setEnabled(
        principal,
        "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
        false,
        now
      ).enabled,
      false
    );
    assert.equal(
      agentService.setEnabled(
        principal,
        "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
        true,
        now
      ).enabled,
      true
    );
    assert.equal(
      service.updateRoom(principal, room.roomId, { archived: true }, now).archivedAt,
      now
    );
    assert.equal(
      service.updateRoom(principal, room.roomId, { archived: false }, now).archivedAt,
      null
    );
    assert.equal(
      service.updateTeam(principal, created.team.teamId, { archived: true }, now)
        .archivedAt,
      now
    );
    assert.equal(
      service.updateTeam(principal, created.team.teamId, { archived: false }, now)
        .archivedAt,
      null
    );
  } finally {
    database.close();
  }
});

test("an Owner controls Room humans and Agents without deleting the Room", async () => {
  const { auth, database, repository, service } = await createFixture();
  try {
    const created = service.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      userDisplayName: "Alice",
      teamName: "Core Team",
      now
    });
    const ownerSession = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const owner = auth.authenticateWebSession(ownerSession.secret, now);
    const room = service.createRoom(owner, created.team.teamId, "private", now);

    repository.createUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
      displayName: "Bob",
      createdAt: now
    });
    repository.createMember({
      memberId: "member_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
      teamId: created.team.teamId,
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
      displayName: "Bob",
      role: "member",
      createdAt: now
    });
    repository.createAgent({
      agentId: "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
      teamId: created.team.teamId,
      ownerMemberId: created.owner.memberId,
      deviceId: null,
      name: "Reviewer",
      role: "Reviewer",
      integrationMode: "manual",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: false,
        supportsResume: false,
        supportsStart: false,
        supportsStreaming: false
      },
      enabled: true,
      presence: "manual",
      createdAt: now,
      updatedAt: now
    });
    const bobSession = auth.issueWebSession(
      "user_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const bob = auth.authenticateWebSession(bobSession.secret, now);
    assert.deepEqual(
      service.listRooms(bob, created.team.teamId),
      [repository.getRoom(room.roomId)]
    );
    assert.deepEqual(service.getRoomParticipants(owner, room.roomId), {
      memberIds: [
        "member_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
        created.owner.memberId
      ].sort(),
      agentIds: ["agent_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ"]
    });
    assert.throws(
      () => service.replaceRoomParticipants(bob, room.roomId, {
        memberIds: [created.owner.memberId],
        agentIds: []
      }, now),
      /Only a Team owner/
    );

    const updated = service.replaceRoomParticipants(owner, room.roomId, {
      memberIds: [created.owner.memberId],
      agentIds: []
    }, now);
    assert.deepEqual(updated, {
      memberIds: [created.owner.memberId],
      agentIds: []
    });
    assert.deepEqual(service.listRooms(bob, created.team.teamId), []);
    assert.throws(() => service.getRoom(bob, room.roomId), /Room access denied/);
    assert.equal(repository.getRoom(room.roomId)?.name, "private");
    assert.throws(
      () => service.replaceRoomParticipants(owner, room.roomId, {
        memberIds: [],
        agentIds: []
      }, now),
      /owners cannot be removed/
    );
  } finally {
    database.close();
  }
});
