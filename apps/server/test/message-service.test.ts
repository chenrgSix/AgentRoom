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
    assert.ok(pageOne.syncCursor);
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

test("Room Message tail snapshot resumes after the newest message", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-tail-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const repository = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(repository, auth);
    const created = teams.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W7",
      userDisplayName: "Alice",
      teamName: "Long-lived Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "general", now);
    const messages = new MessageService(repository, auth);
    for (let ordinal = 1; ordinal <= 105; ordinal += 1) {
      messages.createMemberMessage(principal, {
        roomId: room.roomId,
        content: `message-${ordinal}`,
        now
      });
    }

    const snapshot = messages.listMessages(principal, {
      roomId: room.roomId,
      limit: 100,
      tail: true
    });
    assert.equal(snapshot.items.length, 100);
    assert.equal(snapshot.items[0]?.sequence, 6);
    assert.equal(snapshot.items.at(-1)?.sequence, 105);
    assert.equal(snapshot.nextCursor, null);

    const newest = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "message-106",
      now
    });
    const delta = messages.listMessages(principal, {
      roomId: room.roomId,
      cursor: snapshot.syncCursor,
      limit: 100
    });
    assert.deepEqual(delta.items, [newest]);
    assert.equal(delta.nextCursor, null);
    assert.throws(
      () => messages.listMessages(principal, {
        roomId: room.roomId,
        cursor: snapshot.syncCursor,
        tail: true
      }),
      /cursor and tail mode cannot be combined/
    );
  } finally {
    database.close();
  }
});

test("a client Message ID makes ambiguous member retries idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-client-message-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const repository = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(repository, auth);
    const created = teams.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W8",
      userDisplayName: "Alice",
      teamName: "Retry Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-22T11:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "general", now);
    const messages = new MessageService(repository, auth);
    const input = {
      roomId: room.roomId,
      content: "send exactly once",
      clientMessageId: "client_01K4Z6J7Y8N9P0Q1R2S3T4V5W8",
      now
    };
    const first = messages.createMemberMessageResult(principal, input);
    const retry = messages.createMemberMessageResult(principal, {
      ...input,
      content: "a retry cannot mutate the committed Message"
    });

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.deepEqual(retry.message, first.message);
    assert.equal(repository.latestMessageSequence(room.roomId), 1);
    assert.throws(
      () => messages.createMemberMessage(principal, {
        roomId: room.roomId,
        content: "invalid identity",
        clientMessageId: "retry",
        now
      }),
      /Client Message ID is invalid/
    );
  } finally {
    database.close();
  }
});
