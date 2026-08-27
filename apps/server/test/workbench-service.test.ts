import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";

test("Team Workbench pages one authorized projection with stable filters", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-workbench-"));
  let now = "2026-08-28T10:00:00.000Z";
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now,
    logger: false
  });
  try {
    const ownerBootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { userId: "user_workbench_owner_0001", displayName: "Owner" }
    });
    const ownerAuthorization =
      `Bearer ${ownerBootstrap.json().session.token as string}`;
    const teamResponse = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization: ownerAuthorization },
      payload: { name: "Workbench Team" }
    });
    const teamId = teamResponse.json().team.teamId as string;
    const ownerMemberId = teamResponse.json().owner.memberId as string;
    const firstRoom = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: { authorization: ownerAuthorization },
      payload: { name: "visible" }
    });
    const secondRoom = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: { authorization: ownerAuthorization },
      payload: { name: "restricted" }
    });
    const firstRoomId = firstRoom.json().roomId as string;
    const secondRoomId = secondRoom.json().roomId as string;
    const agentResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/fake-agents`,
      headers: { authorization: ownerAuthorization },
      payload: { name: "Builder", role: "Primary" }
    });
    const agentId = agentResponse.json().agentId as string;

    const memberBootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { userId: "user_workbench_member_0001", displayName: "Member" }
    });
    const memberAuthorization =
      `Bearer ${memberBootstrap.json().session.token as string}`;
    const memberResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/members`,
      headers: { authorization: ownerAuthorization },
      payload: {
        userId: "user_workbench_member_0001",
        displayName: "Member"
      }
    });
    const memberId = memberResponse.json().memberId as string;
    const participantUpdate = await app.inject({
      method: "PUT",
      url: `/api/rooms/${firstRoomId}/participants`,
      headers: { authorization: ownerAuthorization },
      payload: { memberIds: [ownerMemberId, memberId], agentIds: [agentId] }
    });
    assert.equal(participantUpdate.statusCode, 200);
    const restrictedParticipants = await app.inject({
      method: "PUT",
      url: `/api/rooms/${secondRoomId}/participants`,
      headers: { authorization: ownerAuthorization },
      payload: { memberIds: [ownerMemberId], agentIds: [agentId] }
    });
    assert.equal(restrictedParticipants.statusCode, 200);

    now = "2026-08-28T10:01:00.000Z";
    const firstTaskResponse = await app.inject({
      method: "POST",
      url: `/api/rooms/${firstRoomId}/tasks`,
      headers: { authorization: ownerAuthorization },
      payload: {
        title: "Resolve several blockers",
        goal: "Keep every simultaneous attention reason visible.",
        priority: "high",
        criteria: [{
          criterionKey: "criterion_workbench_0001",
          description: "The blockers are resolved.",
          required: true,
          ordinal: 1
        }],
        assignments: [{ agentId, role: "primary" }]
      }
    });
    assert.equal(firstTaskResponse.statusCode, 200);
    const firstTaskId = firstTaskResponse.json().taskId as string;
    now = "2026-08-28T10:02:00.000Z";
    const paused = await app.inject({
      method: "POST",
      url: `/api/tasks/${firstTaskId}/control`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_workbench_pause_0001",
        expectedTaskRevision: 1,
        schedulingState: "paused"
      }
    });
    assert.equal(paused.statusCode, 200);
    now = "2026-08-28T10:03:00.000Z";
    const blocked = await app.inject({
      method: "POST",
      url: `/api/tasks/${firstTaskId}/blocks`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_workbench_block_0001",
        expectedTaskRevision: 2,
        reason: "A human decision is required."
      }
    });
    assert.equal(blocked.statusCode, 200);

    now = "2026-08-28T10:04:00.000Z";
    const secondTaskResponse = await app.inject({
      method: "POST",
      url: `/api/rooms/${secondRoomId}/tasks`,
      headers: { authorization: ownerAuthorization },
      payload: {
        title: "Review verified delivery",
        goal: "Produce a current Result with Artifact evidence.",
        priority: "high",
        lifecycleState: "ready",
        completionPolicy: "accepted_result_required",
        criteria: [{
          criterionKey: "criterion_workbench_0002",
          description: "A durable test Artifact exists.",
          required: true,
          ordinal: 1
        }],
        assignments: [{ agentId, role: "primary" }]
      }
    });
    assert.equal(secondTaskResponse.statusCode, 200);
    const secondTaskId = secondTaskResponse.json().taskId as string;
    now = "2026-08-28T10:05:00.000Z";
    const activated = await app.inject({
      method: "POST",
      url: `/api/tasks/${secondTaskId}/control`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_workbench_activate_0001",
        expectedTaskRevision: 1,
        lifecycleState: "active"
      }
    });
    assert.equal(activated.statusCode, 200);
    now = "2026-08-28T10:05:15.000Z";
    const routed = await app.inject({
      method: "POST",
      url: `/api/rooms/${secondRoomId}/messages`,
      headers: { authorization: ownerAuthorization },
      payload: {
        taskId: secondTaskId,
        content: "Run the focused Workbench verification.",
        mentionAgentId: agentId
      }
    });
    assert.equal(routed.statusCode, 200);
    const runId = routed.json().runs[0].runId as string;
    const artifactResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${secondTaskId}/artifacts`,
      headers: { authorization: ownerAuthorization },
      payload: {
        type: "test_result",
        workspaceRef: "workspace_workbench",
        title: "Verified Workbench tests",
        summary: "The focused checks passed."
      }
    });
    assert.equal(artifactResponse.statusCode, 200);
    const artifactId = artifactResponse.json().artifact.artifactId as string;
    const taskBeforeResult = await app.inject({
      method: "GET",
      url: `/api/tasks/${secondTaskId}`,
      headers: { authorization: ownerAuthorization }
    });
    const task = taskBeforeResult.json();
    const changesBefore = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/changes?after=0`,
      headers: { authorization: ownerAuthorization }
    });
    now = "2026-08-28T10:06:00.000Z";
    const resultResponse = await app.inject({
      method: "POST",
      url: `/api/tasks/${secondTaskId}/results`,
      headers: { authorization: ownerAuthorization },
      payload: {
        operationId: "op_workbench_result_0001",
        taskId: secondTaskId,
        definitionRevision: task.definitionRevision,
        criteriaRevision: task.criteriaRevision,
        proposedAtTaskRevision: task.taskRevision,
        supersedesResultId: null,
        outcome: "satisfied",
        summary: "The delivery meets the current criteria.",
        risks: [],
        openQuestions: [],
        nextActions: [],
        sources: [{
          evidenceRefId: "evidence_workbench_0001",
          kind: "artifact",
          artifactId
        }],
        criterionClaims: [{
          criterionKey: "criterion_workbench_0002",
          coverage: "satisfied",
          explanation: "The test Artifact proves the criterion.",
          evidenceRefIds: ["evidence_workbench_0001"]
        }]
      }
    });
    assert.equal(resultResponse.statusCode, 200, JSON.stringify(resultResponse.json()));
    const changesAfter = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/changes?after=${changesBefore.json().cursor as number}`,
      headers: { authorization: ownerAuthorization }
    });
    assert.ok(changesAfter.json().cursor > changesBefore.json().cursor);
    assert.deepEqual(changesAfter.json().roomIds, [secondRoomId]);

    const firstPage = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/work-items?scope=team&priority=high&limit=1`,
      headers: { authorization: ownerAuthorization }
    });
    assert.equal(firstPage.statusCode, 200, JSON.stringify(firstPage.json()));
    assert.equal(firstPage.json().items.length, 1);
    assert.equal(firstPage.json().items[0].taskId, secondTaskId);
    assert.equal(firstPage.json().items[0].latestResultCurrent, true);
    assert.equal(firstPage.json().items[0].requiredCriteriaSatisfied, 1);
    assert.equal(firstPage.json().items[0].requiredCriteriaTotal, 1);
    assert.equal(firstPage.json().items[0].latestRun.runId, runId);
    assert.equal(firstPage.json().items[0].latestRun.phase, "unknown");
    assert.equal(firstPage.json().items[0].budgetUsage.providerTokens, null);
    assert.equal(firstPage.json().items[0].budgetUsage.providerCostUsd, null);
    assert.ok(firstPage.json().nextCursor);

    const secondPage = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/work-items?scope=team&priority=high&limit=1&cursor=${firstPage.json().nextCursor as string}`,
      headers: { authorization: ownerAuthorization }
    });
    assert.equal(secondPage.statusCode, 200);
    assert.equal(secondPage.json().items[0].taskId, firstTaskId);
    assert.equal(secondPage.json().nextCursor, null);
    assert.deepEqual(
      secondPage.json().items[0].attentionReasons.map(
        ({ reason }: { reason: string }) => reason
      ),
      ["blocked", "paused"]
    );
    assert.equal(secondPage.json().items[0].primaryAttention, "blocked");

    const attentionFilter = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/work-items?scope=team&attention=paused&agentId=${agentId}`,
      headers: { authorization: ownerAuthorization }
    });
    assert.deepEqual(
      attentionFilter.json().items.map(({ taskId }: { taskId: string }) => taskId),
      [firstTaskId]
    );
    const memberProjection = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/work-items?scope=team&priority=high`,
      headers: { authorization: memberAuthorization }
    });
    assert.equal(memberProjection.statusCode, 200);
    assert.deepEqual(
      memberProjection.json().items.map(({ taskId }: { taskId: string }) => taskId),
      [firstTaskId]
    );
    const memberMine = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/work-items?scope=mine&priority=high`,
      headers: { authorization: memberAuthorization }
    });
    assert.deepEqual(memberMine.json().items, []);
    const boundedFilter = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/work-items?scope=team&ownerMemberId=${ownerMemberId}&roomId=${secondRoomId}&lifecycleState=active&updatedAfter=2026-08-28T10%3A05%3A00.000Z&updatedBefore=2026-08-28T10%3A07%3A00.000Z`,
      headers: { authorization: ownerAuthorization }
    });
    assert.deepEqual(
      boundedFilter.json().items.map(({ taskId }: { taskId: string }) => taskId),
      [secondTaskId]
    );

    const mismatchedCursor = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/work-items?scope=team&priority=normal&cursor=${firstPage.json().nextCursor as string}`,
      headers: { authorization: ownerAuthorization }
    });
    assert.equal(mismatchedCursor.statusCode, 400);
    assert.match(mismatchedCursor.json().error.message, /does not match/u);
    const unsupportedFilter = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/work-items?percentage=75`,
      headers: { authorization: ownerAuthorization }
    });
    assert.equal(unsupportedFilter.statusCode, 400);
    const unauthorized = await app.inject({
      method: "GET",
      url: "/api/teams/team_notowned_0001/work-items",
      headers: { authorization: memberAuthorization }
    });
    assert.equal(unauthorized.statusCode, 403);
  } finally {
    await app.close();
  }
});
