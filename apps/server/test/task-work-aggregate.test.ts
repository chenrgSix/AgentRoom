import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createServerApp } from "../src/app.js";

const now = "2026-08-28T10:00:00.000Z";

test("versioned Task work aggregate enforces ownership, CAS, and recovery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-work-task-"));
  const databasePath = path.join(directory, "server.sqlite");
  const app = await createServerApp({ databasePath, clock: () => now, logger: false });
  try {
    const ownerBootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { userId: "user_work_owner_0001", displayName: "Work Owner" }
    });
    const ownerAuthorization =
      `Bearer ${ownerBootstrap.json().session.token as string}`;
    const teamResponse = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization: ownerAuthorization },
      payload: { name: "Work Team" }
    });
    const teamId = teamResponse.json().team.teamId as string;
    const ownerMemberId = teamResponse.json().owner.memberId as string;
    const roomResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: { authorization: ownerAuthorization },
      payload: { name: "work" }
    });
    const roomId = roomResponse.json().roomId as string;
    const agentResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/manual-agents`,
      headers: { authorization: ownerAuthorization },
      payload: { name: "Builder", role: "Primary" }
    });
    const agentId = agentResponse.json().agent.agentId as string;

    const memberBootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { userId: "user_work_member_0001", displayName: "Contributor" }
    });
    const memberAuthorization =
      `Bearer ${memberBootstrap.json().session.token as string}`;
    const memberResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/members`,
      headers: { authorization: ownerAuthorization },
      payload: {
        userId: "user_work_member_0001",
        displayName: "Contributor"
      }
    });
    const memberId = memberResponse.json().memberId as string;
    const participants = await app.inject({
      method: "PUT",
      url: `/api/rooms/${roomId}/participants`,
      headers: { authorization: ownerAuthorization },
      payload: { memberIds: [ownerMemberId, memberId], agentIds: [agentId] }
    });
    assert.equal(participants.statusCode, 200);

    const defaultTasks = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/tasks`,
      headers: { authorization: ownerAuthorization }
    });
    const defaultTask = defaultTasks.json()[0];
    assert.equal(defaultTask.isDefault, true);
    assert.equal(defaultTask.lifecycleState, "active");
    assert.equal(defaultTask.schedulingState, "enabled");
    assert.equal(defaultTask.completionPolicy, "owner_confirmed");
    assert.deepEqual(defaultTask.assignments, []);

    const created = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/tasks`,
      headers: { authorization: ownerAuthorization },
      payload: {
        title: "Deliver Task work model",
        goal: "Persist the aggregate with exact revision fences.",
        completionPolicy: "accepted_result_required",
        priority: "high",
        lifecycleState: "ready",
        criteria: [{
          criterionKey: "criterion_initial001",
          description: "The aggregate survives restart.",
          required: true,
          ordinal: 1
        }],
        assignments: [{ agentId, role: "primary" }],
        budgetPolicy: {
          maxRunAttempts: 2,
          maxExecutionDurationSeconds: 1800
        }
      }
    });
    assert.equal(created.statusCode, 200);
    const task = created.json();
    assert.equal(task.taskDisplayNumber, defaultTask.taskDisplayNumber + 1);
    assert.equal(task.taskRevision, 1);
    assert.equal(task.definitionRevision, 1);
    assert.equal(task.criteriaRevision, 1);
    assert.equal(task.ownerMemberId, ownerMemberId);
    assert.equal(task.assignments[0].assignedByMemberId, ownerMemberId);

    const denied = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.taskId as string}/definition`,
      headers: { authorization: memberAuthorization },
      payload: {
        operationId: "op_member_forbidden_0001",
        expectedTaskRevision: 1,
        title: task.title,
        goal: task.goal,
        ownerMemberId,
        completionPolicy: task.completionPolicy,
        priority: task.priority,
        dueAt: null,
        criteria: task.criteria,
        assignments: [{ agentId, role: "primary" }],
        budgetPolicy: task.budgetPolicy
      }
    });
    assert.equal(denied.statusCode, 400);
    assert.match(denied.json().error.message, /Task Owner or Team Owner/u);

    const definitionPayload = {
      operationId: "op_definition_update_0001",
      expectedTaskRevision: 1,
      title: "Deliver versioned Task work model",
      goal: "Persist canonical criteria with exact revision fences.",
      ownerMemberId,
      completionPolicy: "accepted_result_required",
      priority: "urgent",
      dueAt: null,
      criteria: [{
        criterionKey: "criterion_initial001",
        description: "The aggregate and immutable criteria survive restart.",
        required: true,
        ordinal: 1
      }],
      assignments: [{ agentId, role: "primary" }],
      budgetPolicy: {
        maxRunAttempts: 2,
        maxExecutionDurationSeconds: 1800
      }
    };
    const updated = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.taskId as string}/definition`,
      headers: { authorization: ownerAuthorization },
      payload: definitionPayload
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().taskRevision, 2);
    assert.equal(updated.json().definitionRevision, 2);
    assert.equal(updated.json().criteriaRevision, 2);

    const replay = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.taskId as string}/definition`,
      headers: { authorization: ownerAuthorization },
      payload: definitionPayload
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().taskRevision, 2);

    const conflict = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.taskId as string}/definition`,
      headers: { authorization: ownerAuthorization },
      payload: { ...definitionPayload, operationId: "op_stale_update_0001" }
    });
    assert.equal(conflict.statusCode, 400);
    assert.match(conflict.json().error.message, /revision conflict/u);

    const activated = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId as string}/control`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_activate_task_0001",
        expectedTaskRevision: 2,
        lifecycleState: "active"
      }
    });
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.json().taskRevision, 3);
    assert.equal(activated.json().lifecycleState, "active");

    const paused = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId as string}/control`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_pause_task_0001",
        expectedTaskRevision: 3,
        schedulingState: "paused"
      }
    });
    assert.equal(paused.statusCode, 200);
    assert.deepEqual(
      paused.json().attentionReasons.map(({ reason }: { reason: string }) => reason),
      ["paused"]
    );
    assert.equal(paused.json().nextAction.reason, "resume_scheduling");

    const pausedRun = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization: ownerAuthorization },
      payload: {
        taskId: task.taskId,
        content: "This must not route while paused.",
        mentionAgentId: agentId
      }
    });
    assert.equal(pausedRun.statusCode, 400);
    assert.match(pausedRun.json().error.message, /not runnable/u);

    const blocked = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId as string}/blocks`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_block_task_0001",
        expectedTaskRevision: 4,
        reason: "Waiting for an external decision."
      }
    });
    assert.equal(blocked.statusCode, 200);
    assert.equal(blocked.json().taskRevision, 5);
    assert.deepEqual(
      blocked.json().attentionReasons.map(({ reason }: { reason: string }) => reason),
      ["blocked", "paused"]
    );
    assert.equal(blocked.json().nextAction.reason, "resolve_block");
    const blockId = blocked.json().attentionReasons[0].sourceId as string;
    const resolved = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId as string}/blocks/${blockId}/resolve`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_resolve_block_0001",
        expectedTaskRevision: 5
      }
    });
    assert.equal(resolved.statusCode, 200);
    assert.equal(resolved.json().taskRevision, 6);
    assert.deepEqual(
      resolved.json().attentionReasons.map(({ reason }: { reason: string }) => reason),
      ["paused"]
    );

    const resumed = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId as string}/control`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_resume_task_0001",
        expectedTaskRevision: 6,
        schedulingState: "enabled"
      }
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().attentionReasons.length, 0);

    const routed = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization: ownerAuthorization },
      payload: {
        taskId: task.taskId,
        content: "Execute one budgeted attempt.",
        mentionAgentId: agentId
      }
    });
    assert.equal(routed.statusCode, 200);
    const runId = routed.json().runs[0].runId as string;
    const afterAttempt = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.taskId as string}`,
      headers: { authorization: ownerAuthorization }
    });
    assert.equal(afterAttempt.json().budgetUsage.runAttempts, 1);
    assert.equal(afterAttempt.json().budgetUsage.usageRevision, 1);
    const terminalWriter = new Database(databasePath);
    try {
      terminalWriter.prepare(`
        UPDATE runs SET state = 'expired',
          updated_at = '2026-08-28T10:02:00.000Z',
          terminal_at = '2026-08-28T10:02:00.000Z'
        WHERE run_id = ?
      `).run(runId);
    } finally {
      terminalWriter.close();
    }
    const afterDuration = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.taskId as string}`,
      headers: { authorization: ownerAuthorization }
    });
    assert.equal(afterDuration.json().budgetUsage.executionDurationSeconds, 120);
    assert.equal(afterDuration.json().budgetUsage.usageRevision, 2);

    const resultRequired = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId as string}/control`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_complete_without_result_0001",
        expectedTaskRevision: 7,
        lifecycleState: "completed"
      }
    });
    assert.equal(resultRequired.statusCode, 400);
    assert.match(resultRequired.json().error.message, /accepted current Result/u);

    const defaultMutation = await app.inject({
      method: "POST",
      url: `/api/tasks/${defaultTask.taskId as string}/control`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_cancel_default_0001",
        expectedTaskRevision: defaultTask.taskRevision,
        lifecycleState: "canceled"
      }
    });
    assert.equal(defaultMutation.statusCode, 400);
    assert.match(defaultMutation.json().error.message, /permanently active/u);
  } finally {
    await app.close();
  }

  const reopened = new Database(databasePath, { readonly: true });
  try {
    const taskId = (reopened.prepare(`
      SELECT task_id FROM agent_tasks WHERE is_default = 0
    `).get() as { task_id: string }).task_id;
    const definitions = reopened.prepare(`
      SELECT definition_revision, goal FROM task_definition_revisions
      WHERE task_id = ? ORDER BY definition_revision
    `).all(taskId) as Array<{ definition_revision: number; goal: string }>;
    const criteria = reopened.prepare(`
      SELECT criteria_revision, description FROM task_criteria_entries
      WHERE task_id = ? ORDER BY criteria_revision
    `).all(taskId) as Array<{ criteria_revision: number; description: string }>;
    assert.deepEqual(definitions.map(({ definition_revision }) =>
      definition_revision), [1, 2]);
    assert.deepEqual(criteria.map(({ criteria_revision }) =>
      criteria_revision), [1, 2]);
    assert.notEqual(definitions[0]!.goal, definitions[1]!.goal);
    assert.notEqual(criteria[0]!.description, criteria[1]!.description);
  } finally {
    reopened.close();
  }
});
