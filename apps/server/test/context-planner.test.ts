import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { RunRepository } from "../src/run/run-repository.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { AgentTaskService } from "../src/task/agent-task-service.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { TaskArtifactService } from "../src/task/task-artifact-service.js";
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
    const artifacts = new TaskArtifactService(
      new ArtifactRepository(database),
      taskRepository,
      new RunRepository(database),
      core,
      auth
    );
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

    artifacts.create(principal, task.taskId, {
      type: "commit",
      workspaceRef: "workspace_oauth",
      repository: "agent-room/network",
      commitSha: "21f9e8c",
      title: "OAuth implementation",
      summary: "Focused OAuth tests passed."
    }, now);

    const repeated = planner.plan({
      roomId: room.roomId,
      taskId: task.taskId,
      throughSequence: trigger.sequence,
      triggerMessageId: trigger.messageId
    }, now);
    assert.equal(repeated.contextPlan.roomMemory.revision, 1);
    assert.equal(repeated.contextPlan.taskMemory.revision, 1);
    const resultEvidence = repeated.contextPlan.resultEvidence;
    assert.ok(resultEvidence);
    assert.equal(resultEvidence.revision, 1);
    assert.deepEqual({
      deliveryKind: resultEvidence.deliveryKind,
      fromRevision: resultEvidence.fromRevision,
      throughRevision: resultEvidence.throughRevision,
      hasMore: resultEvidence.hasMore
    }, {
      deliveryKind: "bootstrap",
      fromRevision: 0,
      throughRevision: 1,
      hasMore: false
    });
    assert.deepEqual(resultEvidence.artifactRefs[0], {
      artifactId: resultEvidence.artifactRefs[0]?.artifactId,
      artifactRevision: 1,
      type: "commit",
      workspaceRef: "workspace_oauth",
      repository: "agent-room/network",
      commitSha: "21f9e8c",
      title: "OAuth implementation",
      summary: "Focused OAuth tests passed.",
      createdByMemberId: created.owner.memberId,
      createdAt: now
    });
    assert.throws(() => database.prepare(`
      UPDATE task_artifact_refs SET summary = 'rewritten'
      WHERE artifact_id = ?
    `).run(resultEvidence.artifactRefs[0]?.artifactId), /immutable/u);

    for (let index = 2; index <= 31; index += 1) {
      artifacts.create(principal, task.taskId, {
        type: "test_result",
        workspaceRef: "workspace_oauth",
        title: `OAuth verification ${index}`,
        summary: `Verification evidence ${index}.`
      }, now);
    }
    const firstDelta = planner.plan({
      roomId: room.roomId,
      taskId: task.taskId,
      throughSequence: trigger.sequence,
      triggerMessageId: trigger.messageId,
      resultEvidenceAfterRevision: 1
    }, now).contextPlan.resultEvidence;
    assert.ok(firstDelta);
    assert.deepEqual({
      deliveryKind: firstDelta.deliveryKind,
      fromRevision: firstDelta.fromRevision,
      throughRevision: firstDelta.throughRevision,
      hasMore: firstDelta.hasMore,
      revisions: firstDelta.artifactRefs.map(({ artifactRevision }) =>
        artifactRevision
      )
    }, {
      deliveryKind: "delta",
      fromRevision: 1,
      throughRevision: 21,
      hasMore: true,
      revisions: Array.from({ length: 20 }, (_, index) => index + 2)
    });
    const secondDelta = planner.plan({
      roomId: room.roomId,
      taskId: task.taskId,
      throughSequence: trigger.sequence,
      triggerMessageId: trigger.messageId,
      resultEvidenceAfterRevision: 21
    }, now).contextPlan.resultEvidence;
    assert.ok(secondDelta);
    assert.deepEqual({
      fromRevision: secondDelta.fromRevision,
      throughRevision: secondDelta.throughRevision,
      hasMore: secondDelta.hasMore,
      revisions: secondDelta.artifactRefs.map(({ artifactRevision }) =>
        artifactRevision
      )
    }, {
      fromRevision: 21,
      throughRevision: 31,
      hasMore: false,
      revisions: Array.from({ length: 10 }, (_, index) => index + 22)
    });

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

    const historical = planner.plan({
      roomId: room.roomId,
      taskId: task.taskId,
      throughSequence: trigger.sequence,
      triggerMessageId: trigger.messageId
    }, now);
    assert.equal(historical.contextPlan.roomMemory.projectionKind, "historical");
    assert.equal(historical.contextPlan.taskMemory.projectionKind, "historical");
    assert.ok(
      historical.contextPlan.roomMemory.sourceCursor <
        advanced.contextPlan.roomMemory.sourceCursor
    );
    assert.ok(
      historical.contextPlan.taskMemory.sourceCursor <
        advanced.contextPlan.taskMemory.sourceCursor
    );
    const canonicalRoom = database.prepare(`
      SELECT source_sequence, revision FROM room_memory_projections
      WHERE room_id = ?
    `).get(room.roomId) as { source_sequence: number; revision: number };
    assert.deepEqual(canonicalRoom, {
      source_sequence: advanced.contextPlan.roomMemory.sourceCursor,
      revision: advanced.contextPlan.roomMemory.revision
    });
    const canonicalTask = taskRepository.get(task.taskId);
    assert.equal(
      canonicalTask?.summarySourceSequence,
      advanced.contextPlan.taskMemory.sourceCursor
    );
    assert.equal(
      canonicalTask?.summaryRevision,
      advanced.contextPlan.taskMemory.revision
    );
    assert.throws(() => database.prepare(`
      UPDATE room_memory_projections SET source_sequence = 0 WHERE room_id = ?
    `).run(room.roomId), /cannot regress/u);
    assert.throws(() => database.prepare(`
      UPDATE agent_tasks SET summary_source_sequence = 0 WHERE task_id = ?
    `).run(task.taskId), /cannot regress/u);
  } finally {
    database.close();
  }
});
