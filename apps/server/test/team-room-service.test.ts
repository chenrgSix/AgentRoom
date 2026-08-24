import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AuthService, AuthorizationError } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-team-"));
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
    assert.deepEqual(service.listRooms(bob, created.team.teamId), [room]);
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
