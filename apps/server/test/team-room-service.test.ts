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
