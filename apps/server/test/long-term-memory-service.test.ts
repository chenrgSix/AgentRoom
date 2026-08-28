import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { SqliteTransactionBoundary } from "../src/data/sqlite-transaction-boundary.js";
import { RunRepository } from "../src/run/run-repository.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { AgentTaskService } from "../src/task/agent-task-service.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { LongTermMemoryService } from "../src/task/long-term-memory-service.js";
import { MemoryEntryRepository } from "../src/task/memory-entry-repository.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-25T14:00:00.000Z";

test("long-term Memory preserves old provenance and explicit lifecycle", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-memory-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(core, auth);
    const messages = new MessageService(core, auth);
    const taskRepository = new AgentTaskRepository(database);
    const tasks = new AgentTaskService(taskRepository, core, auth);
    const memoryRepository = new MemoryEntryRepository(
      database,
      new SqliteTransactionBoundary(database)
    );
    const memory = new LongTermMemoryService(
      database,
      memoryRepository,
      new ArtifactRepository(database),
      taskRepository,
      core,
      new RunRepository(database),
      auth
    );
    const created = teams.createTeamForUser({
      userId: "user_memory_owner",
      userDisplayName: "Alice",
      teamName: "Memory Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-25T16:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "architecture", now);
    const task = tasks.create(principal, {
      roomId: room.roomId,
      title: "Persistence migration",
      goal: "Choose and implement the durable store."
    }, now);
    const otherTask = tasks.create(principal, {
      roomId: room.roomId,
      title: "Unrelated UI",
      goal: "Keep UI evidence outside the persistence Task."
    }, now);
    const original = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      taskId: task.taskId,
      content: "Decision: use PostgreSQL for the durable store.",
      now
    });
    const otherSource = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      taskId: otherTask.taskId,
      content: "Use a blue UI theme.",
      now
    });
    const roomDecision = memory.createRoom(principal, room.roomId, {
      type: "decision",
      content: "Use PostgreSQL for durable shared state. token=memory-secret",
      sourceMessageIds: [original.messageId]
    }, now);
    assert.equal(roomDecision.revision, 1);
    assert.equal(roomDecision.content.includes("memory-secret"), false);
    const taskGoal = memory.createTask(principal, task.taskId, {
      type: "goal",
      content: "Complete the PostgreSQL migration without compatibility loss.",
      sourceMessageIds: [original.messageId]
    }, now);
    assert.equal(taskGoal.revision, 1);
    assert.throws(() => memory.createTask(principal, task.taskId, {
      type: "fact",
      content: "Invalid Task type.",
      sourceMessageIds: [original.messageId]
    }, now), /Task memory entry type is invalid/u);
    assert.throws(() => memory.createTask(principal, task.taskId, {
      type: "plan",
      content: "Cross Task evidence must fail.",
      sourceMessageIds: [otherSource.messageId]
    }, now), /outside its scope/u);
    assert.throws(() => memory.createRoom(principal, room.roomId, {
      type: "constraint",
      content: "Unproven claim."
    }, now), /requires authoritative provenance/u);

    let latest = original;
    for (let index = 1; index <= 60; index += 1) {
      latest = messages.createMemberMessage(principal, {
        roomId: room.roomId,
        taskId: task.taskId,
        content: `Later persistence discussion ${index}`,
        now
      });
    }
    const planner = new ContextPlanner(database, core, taskRepository);
    const planned = planner.plan({
      roomId: room.roomId,
      taskId: task.taskId,
      throughSequence: latest.sequence,
      triggerMessageId: latest.messageId
    }, now);
    assert.equal(
      planned.contextPlan.roomMemory.sourceMessageIds.includes(original.messageId),
      false
    );
    assert.deepEqual(
      planned.contextPlan.longTermMemory?.room?.entries[0]?.sourceMessageIds,
      [original.messageId]
    );
    assert.equal(
      planned.contextPlan.longTermMemory?.task?.entries[0]?.memoryId,
      taskGoal.memoryId
    );

    const replacement = memory.createRoom(principal, room.roomId, {
      type: "decision",
      content: "Use PostgreSQL 18 for durable shared state.",
      sourceMessageIds: [latest.messageId],
      supersedesMemoryId: roomDecision.memoryId
    }, "2026-08-25T14:10:00.000Z");
    assert.equal(memoryRepository.get(roomDecision.memoryId)?.state, "superseded");
    assert.equal(memoryRepository.get(roomDecision.memoryId)?.revision, 2);
    assert.equal(replacement.revision, 3);
    assert.deepEqual(
      memoryRepository.contextScopeAtRevision("room", room.roomId, 1)?.entries
        .map((entry) => [entry.memoryId, entry.state, entry.revision]),
      [[roomDecision.memoryId, "active", 1]]
    );
    assert.deepEqual(
      memoryRepository.contextScopeAtRevision("room", room.roomId, 3)?.entries
        .map((entry) => [entry.memoryId, entry.state, entry.revision]),
      [
        [roomDecision.memoryId, "superseded", 2],
        [replacement.memoryId, "active", 3]
      ]
    );
    assert.deepEqual(
      memory.listRoom(principal, room.roomId, 1).map((entry) => entry.revision),
      [2, 3]
    );
    const retracted = memory.retract(
      principal,
      replacement.memoryId,
      "2026-08-25T14:11:00.000Z"
    );
    assert.equal(retracted.state, "retracted");
    assert.equal(retracted.revision, 4);

    for (let index = 1; index <= 17; index += 1) {
      memory.createTask(principal, task.taskId, {
        type: "progress",
        content: `Durable progress checkpoint ${index}`,
        sourceMessageIds: [latest.messageId]
      }, now);
    }
    const bounded = memoryRepository.contextScope("task", task.taskId);
    assert.equal(bounded?.activeComplete, false);
    assert.equal(bounded?.entries.filter((entry) => entry.state === "active").length, 16);
    assert.equal(memoryRepository.contextScope("room", room.roomId)?.revision, 4);
  } finally {
    database.close();
  }
});
