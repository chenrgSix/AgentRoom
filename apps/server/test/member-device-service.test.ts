import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { AuthService, AuthorizationError } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

test("an owner adds a Member and each Member owns their registered Device", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-registry-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const repository = new CoreRepository(database);
    const auth = new AuthService(database);
    const teamRooms = new TeamRoomService(repository, auth);
    const registry = new MemberDeviceService(repository, auth);
    const created = teamRooms.createTeamForUser({
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
    const bob = registry.addMember(owner, {
      teamId: created.team.teamId,
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
      displayName: "Bob",
      now
    });
    const bobSession = auth.issueWebSession(
      bob.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const bobPrincipal = auth.authenticateWebSession(bobSession.secret, now);
    const device = registry.registerOwnDevice(
      bobPrincipal,
      created.team.teamId,
      "Bob Mac",
      now
    );

    assert.equal(device.ownerMemberId, bob.memberId);
    assert.equal(registry.listMembers(owner, created.team.teamId).length, 2);
    assert.deepEqual(registry.listDevices(owner, created.team.teamId), [device]);
    assert.throws(
      () => registry.addMember(bobPrincipal, {
        teamId: created.team.teamId,
        userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5ZY",
        displayName: "Mallory",
        now
      }),
      (error: unknown) =>
        error instanceof AuthorizationError && error.code === "FORBIDDEN"
    );
  } finally {
    database.close();
  }
});
