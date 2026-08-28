import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { prepareDatabaseDirectory } from "../src/data/database-location.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { SqliteTransactionBoundary } from "../src/data/sqlite-transaction-boundary.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-25T09:00:00.000Z";

test("shared repository boundary rolls back cross-aggregate writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-uow-"));
  const databasePath = path.join(directory, "server.sqlite");
  await prepareDatabaseDirectory(databasePath);
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const transactions = new SqliteTransactionBoundary(database);
  const core = new CoreRepository(database, transactions);
  const tasks = new AgentTaskRepository(database);

  assert.throws(() => transactions.immediate(() => {
    core.createUser({ userId: "user_boundary1", displayName: "Alice", createdAt: now });
    core.createTeamWithOwner(
      { teamId: "team_boundary1", name: "Boundary", createdAt: now },
      {
        memberId: "member_boundary1",
        teamId: "team_boundary1",
        userId: "user_boundary1",
        displayName: "Alice",
        role: "owner",
        createdAt: now
      }
    );
    core.createRoom({
      roomId: "room_boundary1",
      teamId: "team_boundary1",
      name: "general",
      createdAt: now
    });
    const task = tasks.getDefaultForRoom("room_boundary1");
    assert.ok(task);
    core.appendMessage({
      messageId: "msg_boundary12",
      roomId: "room_boundary1",
      taskId: task.taskId,
      senderType: "member",
      senderId: "member_boundary1",
      content: "This must roll back.",
      mentions: [],
      parentMessageId: null,
      createdAt: now
    });
    throw new Error("force rollback");
  }), /force rollback/u);

  assert.equal(core.getUser("user_boundary1"), undefined);
  assert.equal(core.getTeam("team_boundary1"), undefined);
  assert.equal(core.getRoom("room_boundary1"), undefined);
  assert.equal(tasks.getDefaultForRoom("room_boundary1"), undefined);
  assert.equal(core.getMessage("msg_boundary12"), undefined);
  database.close();
});
