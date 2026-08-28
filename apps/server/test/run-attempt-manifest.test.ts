import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createServerApp } from "../src/app.js";

const now = "2026-08-28T12:00:00.000Z";

test("Run retry creates new lineage only after audited ambiguity acknowledgement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-run-attempt-"));
  const databasePath = path.join(directory, "server.sqlite");
  const app = await createServerApp({ databasePath, clock: () => now, logger: false });
  try {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { userId: "user_run_attempt_0001", displayName: "Run Owner" }
    });
    const authorization = `Bearer ${bootstrap.json().session.token as string}`;
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization },
      payload: { name: "Run Team" }
    });
    const teamId = team.json().team.teamId as string;
    const room = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: { authorization },
      payload: { name: "attempts" }
    });
    const roomId = room.json().roomId as string;
    const agent = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/manual-agents`,
      headers: { authorization },
      payload: { name: "Builder", role: "Primary" }
    });
    const agentId = agent.json().agent.agentId as string;
    const createdTask = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/tasks`,
      headers: { authorization },
      payload: {
        title: "Retry safely",
        goal: "Use the original frozen goal.",
        lifecycleState: "ready",
        completionPolicy: "owner_confirmed",
        criteria: [{
          criterionKey: "criterion_retryold01",
          description: "The first attempt is frozen.",
          required: true,
          ordinal: 1
        }],
        assignments: [{ agentId, role: "primary" }],
        budgetPolicy: {
          maxRunAttempts: 5,
          maxExecutionDurationSeconds: 3600
        }
      }
    });
    assert.equal(createdTask.statusCode, 200);
    const task = createdTask.json();
    const activatedTask = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId as string}/control`,
      headers: { authorization },
      payload: {
        operationId: "op_activate_retry_task_0001",
        expectedTaskRevision: 1,
        lifecycleState: "active"
      }
    });
    assert.equal(activatedTask.statusCode, 200);
    const routed = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: {
        taskId: task.taskId,
        content: "Perform the bounded attempt.",
        mentionAgentId: agentId
      }
    });
    assert.equal(routed.statusCode, 200);
    const firstRun = routed.json().runs[0];
    assert.equal(firstRun.attemptNumber, 1);
    assert.equal(firstRun.retryOfRunId, null);

    const taskRuns = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.taskId as string}/runs`,
      headers: { authorization }
    });
    assert.equal(taskRuns.statusCode, 200);
    assert.deepEqual(taskRuns.json().map(({ runId }: { runId: string }) => runId), [
      firstRun.runId
    ]);

    const runDetail = await app.inject({
      method: "GET",
      url: `/api/runs/${firstRun.runId as string}`,
      headers: { authorization }
    });
    assert.equal(runDetail.statusCode, 200);
    assert.equal(runDetail.json().taskId, task.taskId);
    assert.equal(runDetail.json().instruction, "Perform the bounded attempt.");

    const outsiderBootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: {
        userId: "user_run_attempt_outsider_0001",
        displayName: "Run Outsider"
      }
    });
    const outsiderAuthorization =
      `Bearer ${outsiderBootstrap.json().session.token as string}`;
    const hiddenTaskRuns = await app.inject({
      method: "GET",
      url: `/api/tasks/${task.taskId as string}/runs`,
      headers: { authorization: outsiderAuthorization }
    });
    assert.equal(hiddenTaskRuns.statusCode, 403);
    const hiddenRunDetail = await app.inject({
      method: "GET",
      url: `/api/runs/${firstRun.runId as string}`,
      headers: { authorization: outsiderAuthorization }
    });
    assert.equal(hiddenRunDetail.statusCode, 403);

    const firstManifestResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${firstRun.runId as string}/context-manifest`,
      headers: { authorization }
    });
    assert.equal(firstManifestResponse.statusCode, 200);
    const firstManifest = firstManifestResponse.json();
    assert.equal(firstManifest.taskRevision, 2);
    assert.equal(firstManifest.definitionRevision, 1);
    assert.equal(firstManifest.criteriaRevision, 1);
    assert.equal(firstManifest.goal, "Use the original frozen goal.");
    assert.deepEqual(firstManifest.included.messageIds, [
      routed.json().message.messageId
    ]);
    assert.equal(firstManifest.target.deviceId, null);
    assert.equal(firstManifest.target.runtimeKind, "manual");
    assert.deepEqual(firstManifest.omittedCategories, [
      "unrelated_room_history",
      "local_paths",
      "environment_values",
      "provider_credentials",
      "provider_session_ids",
      "hidden_reasoning",
      "tool_payloads",
      "other_workspaces"
    ]);
    assert.doesNotMatch(
      JSON.stringify(firstManifest),
      /workspacePath|"command":|environmentValue|providerCredential|providerSessionId/u
    );

    const changedDefinition = await app.inject({
      method: "PUT",
      url: `/api/tasks/${task.taskId as string}/definition`,
      headers: { authorization },
      payload: {
        operationId: "op_change_retry_context_0001",
        expectedTaskRevision: 2,
        title: task.title,
        goal: "Use the revised goal only for a new attempt.",
        ownerMemberId: task.ownerMemberId,
        completionPolicy: task.completionPolicy,
        priority: task.priority,
        dueAt: null,
        criteria: [{
          criterionKey: "criterion_retrynew01",
          description: "The retry receives the new frozen criterion.",
          required: true,
          ordinal: 1
        }],
        assignments: [{ agentId, role: "primary" }],
        budgetPolicy: task.budgetPolicy
      }
    });
    assert.equal(changedDefinition.statusCode, 200);
    assert.equal(changedDefinition.json().taskRevision, 3);

    const rereadFirstManifest = await app.inject({
      method: "GET",
      url: `/api/runs/${firstRun.runId as string}/context-manifest`,
      headers: { authorization }
    });
    assert.deepEqual(rereadFirstManifest.json(), firstManifest);

    const writer = new Database(databasePath);
    try {
      writer.prepare(`
        UPDATE runs SET state = 'outcome_unknown', terminal_at = ?, updated_at = ?
        WHERE run_id = ?
      `).run(now, now, firstRun.runId);
    } finally {
      writer.close();
    }

    const unsafeRetry = await app.inject({
      method: "POST",
      url: `/api/runs/${firstRun.runId as string}/retry`,
      headers: { authorization },
      payload: {
        operationId: "op_retry_before_ack_0001",
        expectedTaskRevision: 3
      }
    });
    assert.equal(unsafeRetry.statusCode, 400);
    assert.match(unsafeRetry.json().error.message, /requires acknowledgement/u);

    const unsafeCompletion = await app.inject({
      method: "POST",
      url: `/api/tasks/${task.taskId as string}/control`,
      headers: { authorization },
      payload: {
        operationId: "op_complete_ambiguous_0001",
        expectedTaskRevision: 3,
        lifecycleState: "completed"
      }
    });
    assert.equal(unsafeCompletion.statusCode, 400);
    assert.match(unsafeCompletion.json().error.message, /unacknowledged ambiguous/u);

    const acknowledgementPayload = {
      operationId: "op_ack_ambiguous_run_0001",
      expectedTaskRevision: 3,
      reason: "The external side effect cannot be determined; retry is intentional."
    };
    const acknowledged = await app.inject({
      method: "POST",
      url: `/api/runs/${firstRun.runId as string}/ambiguity-acknowledgement`,
      headers: { authorization },
      payload: acknowledgementPayload
    });
    assert.equal(acknowledged.statusCode, 200);
    assert.equal(acknowledged.json().taskRevisionBefore, 3);
    assert.equal(acknowledged.json().taskRevisionAfter, 4);
    const acknowledgementReplay = await app.inject({
      method: "POST",
      url: `/api/runs/${firstRun.runId as string}/ambiguity-acknowledgement`,
      headers: { authorization },
      payload: acknowledgementPayload
    });
    assert.deepEqual(acknowledgementReplay.json(), acknowledged.json());

    const retryPayload = {
      operationId: "op_retry_after_ack_0001",
      expectedTaskRevision: 4
    };
    const retried = await app.inject({
      method: "POST",
      url: `/api/runs/${firstRun.runId as string}/retry`,
      headers: { authorization },
      payload: retryPayload
    });
    assert.equal(retried.statusCode, 200, JSON.stringify(retried.json()));
    assert.notEqual(retried.json().runId, firstRun.runId);
    assert.equal(retried.json().attemptNumber, 2);
    assert.equal(retried.json().retryOfRunId, firstRun.runId);
    assert.equal(retried.json().state, "queued");
    const retryReplay = await app.inject({
      method: "POST",
      url: `/api/runs/${firstRun.runId as string}/retry`,
      headers: { authorization },
      payload: retryPayload
    });
    assert.equal(retryReplay.json().runId, retried.json().runId);

    const retryManifest = await app.inject({
      method: "GET",
      url: `/api/runs/${retried.json().runId as string}/context-manifest`,
      headers: { authorization }
    });
    assert.equal(retryManifest.statusCode, 200);
    assert.equal(retryManifest.json().taskRevision, 4);
    assert.equal(retryManifest.json().definitionRevision, 2);
    assert.equal(retryManifest.json().criteriaRevision, 2);
    assert.equal(
      retryManifest.json().goal,
      "Use the revised goal only for a new attempt."
    );
    assert.deepEqual(retryManifest.json().included.parentRunIds, [firstRun.runId]);
  } finally {
    await app.close();
  }
});
