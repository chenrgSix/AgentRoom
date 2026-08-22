import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

test("Room Message pagination remains ordered after a database restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-message-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  let database = openDatabase(databasePath);
  let repository = new CoreRepository(database);
  let auth = new AuthService(database);
  const teams = new TeamRoomService(repository, auth);
  const created = teams.createTeamForUser({
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
  let principal = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "general", now);
  let messages = new MessageService(repository, auth);
  const first = messages.createMemberMessage(principal, {
    roomId: room.roomId,
    content: "first",
    now
  });
  const second = messages.createMemberMessage(principal, {
    roomId: room.roomId,
    content: "second",
    parentMessageId: first.messageId,
    now
  });
  database.close();

  database = openDatabase(databasePath);
  try {
    repository = new CoreRepository(database);
    auth = new AuthService(database);
    principal = auth.authenticateWebSession(session.secret, now);
    messages = new MessageService(repository, auth);
    const pageOne = messages.listMessages(principal, {
      roomId: room.roomId,
      limit: 1
    });
    assert.deepEqual(pageOne.items, [first]);
    assert.ok(pageOne.nextCursor);
    const pageTwo = messages.listMessages(principal, {
      roomId: room.roomId,
      cursor: pageOne.nextCursor ?? undefined,
      limit: 1
    });
    assert.deepEqual(pageTwo.items, [second]);
    assert.equal(pageTwo.nextCursor, null);
    assert.throws(
      () => messages.listMessages(principal, {
        roomId: "room_01K4Z6J7Y8N9P0Q1R2S3T4V5ZZ",
        cursor: pageOne.nextCursor ?? undefined
      }),
      /Room access denied/
    );
  } finally {
    database.close();
  }
});
