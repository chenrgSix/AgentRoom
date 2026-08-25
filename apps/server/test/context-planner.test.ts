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
import { AgentTaskService } from "../src/task/agent-task-service.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-25T12:00:00.000Z";

test("Context Planner builds stable provenance projections and bounded relevant events", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-context-"));
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
    const planner = new ContextPlanner(database, core, taskRepository);
    const created = teams.createTeamForUser({
      userId: "user_context_owner",
      userDisplayName: "Alice",
      teamName: "Context Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-25T13:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "engineering", now);
    const task = tasks.create(principal, {
      roomId: room.roomId,
      title: "OAuth migration",
      goal: "Migrate OAuth without breaking existing clients."
    }, now);
    const otherTask = tasks.create(principal, {
      roomId: room.roomId,
      title: "CI repair",
      goal: "Repair CI independently."
    }, now);

    for (let index = 1; index <= 20; index += 1) {
      messages.createMemberMessage(principal, {
        roomId: room.roomId,
        taskId: task.taskId,
        content: `OAuth evidence ${index}`,
        now
      });
    }
    for (let index = 1; index <= 20; index += 1) {
      messages.createMemberMessage(principal, {
        roomId: room.roomId,
        taskId: otherTask.taskId,
        content: `CI evidence ${index}`,
        now
      });
    }
    const trigger = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      taskId: task.taskId,
      content: "Continue OAuth work.",
      now
    });

    const first = planner.plan({
      roomId: room.roomId,
      taskId: task.taskId,
      throughSequence: trigger.sequence,
      triggerMessageId: trigger.messageId
    }, now);
    assert.equal(first.contextPlan.roomMemory.revision, 1);
    assert.equal(first.contextPlan.taskMemory.revision, 1);
    assert.match(first.contextPlan.taskMemory.summary, /OAuth migration/u);
    assert.doesNotMatch(first.contextPlan.taskMemory.summary, /CI evidence/u);
    assert.ok(first.contextPlan.taskMemory.sourceMessageIds.length > 0);
    assert.ok(first.contextPlan.taskMemory.sourceMessageIds.every((messageId) =>
      core.getMessage(messageId)?.taskId === task.taskId
    ));
    assert.ok(first.contextMessages.length <= 30);
    assert.equal(first.contextMessages.at(-1)?.messageId, trigger.messageId);
    assert.ok(first.contextMessages.some((message) =>
      message.taskId === otherTask.taskId
    ));
    assert.ok(first.contextMessages.some((message) =>
      message.taskId === task.taskId && message.messageId !== trigger.messageId
    ));

    const repeated = planner.plan({
      roomId: room.roomId,
      taskId: task.taskId,
      throughSequence: trigger.sequence,
      triggerMessageId: trigger.messageId
    }, now);
    assert.equal(repeated.contextPlan.roomMemory.revision, 1);
    assert.equal(repeated.contextPlan.taskMemory.revision, 1);

    const nextTrigger = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      taskId: task.taskId,
      content: "Verify the next OAuth delta.",
      now
    });
    const advanced = planner.plan({
      roomId: room.roomId,
      taskId: task.taskId,
      throughSequence: nextTrigger.sequence,
      triggerMessageId: nextTrigger.messageId
    }, now);
    assert.equal(advanced.contextPlan.roomMemory.revision, 2);
    assert.equal(advanced.contextPlan.taskMemory.revision, 2);
    const persistedTask = taskRepository.get(task.taskId);
    assert.equal(persistedTask?.summaryRevision, 2);
    assert.deepEqual(
      persistedTask?.summaryProvenanceMessageIds,
      advanced.contextPlan.taskMemory.sourceMessageIds
    );
  } finally {
    database.close();
  }
});
