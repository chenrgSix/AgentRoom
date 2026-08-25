import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";

const now = "2026-08-25T10:00:00.000Z";

test("Agent Tasks scope Runs and allow independent Room Discussions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-task-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now,
    logger: false
  });
  try {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: {
        userId: "user_task_scope_owner",
        displayName: "Task Owner"
      }
    });
    assert.equal(bootstrap.statusCode, 200);
    const token = bootstrap.json().session.token as string;
    const authorization = `Bearer ${token}`;
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization },
      payload: { name: "Task Team" }
    });
    assert.equal(team.statusCode, 200);
    const teamId = team.json().team.teamId as string;
    const room = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: { authorization },
      payload: { name: "engineering" }
    });
    assert.equal(room.statusCode, 200);
    const roomId = room.json().roomId as string;

    const initialTasks = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/tasks`,
      headers: { authorization }
    });
    assert.equal(initialTasks.statusCode, 200);
    assert.equal(initialTasks.json().length, 1);
    assert.equal(initialTasks.json()[0].isDefault, true);

    const createTask = async (title: string) => app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/tasks`,
      headers: { authorization },
      payload: { title, goal: `Complete ${title}.` }
    });
    const oauthResponse = await createTask("OAuth migration");
    const ciResponse = await createTask("Fix CI");
    const completedTaskResponse = await createTask("Completed work");
    assert.equal(oauthResponse.statusCode, 200);
    assert.equal(ciResponse.statusCode, 200);
    assert.equal(completedTaskResponse.statusCode, 200);
    const oauthTaskId = oauthResponse.json().taskId as string;
    const ciTaskId = ciResponse.json().taskId as string;
    const completedTaskId = completedTaskResponse.json().taskId as string;
    assert.notEqual(oauthTaskId, ciTaskId);

    const artifact = await app.inject({
      method: "POST",
      url: `/api/tasks/${oauthTaskId}/artifacts`,
      headers: { authorization },
      payload: {
        type: "file",
        workspaceRef: "workspace_oauth",
        repository: "agent-room/network",
        path: "src/oauth/migration.ts",
        title: "OAuth migration source",
        summary: "Workspace-relative implementation reference."
      }
    });
    assert.equal(artifact.statusCode, 200);
    assert.equal(artifact.json().revision, 1);
    assert.equal(artifact.json().artifact.type, "file");
    assert.ok(artifact.json().artifact.createdByMemberId);
    const unsafeArtifact = await app.inject({
      method: "POST",
      url: `/api/tasks/${oauthTaskId}/artifacts`,
      headers: { authorization },
      payload: {
        type: "file",
        path: "/Users/alice/private/oauth.ts",
        title: "Unsafe local path",
        summary: "Must not cross the Server boundary."
      }
    });
    assert.equal(unsafeArtifact.statusCode, 400);
    assert.match(unsafeArtifact.json().error.message, /workspace-relative/u);
    const artifactList = await app.inject({
      method: "GET",
      url: `/api/tasks/${oauthTaskId}/artifacts`,
      headers: { authorization }
    });
    assert.equal(artifactList.statusCode, 200);
    assert.equal(artifactList.json().revision, 1);
    assert.equal(artifactList.json().artifacts.length, 1);
    const sourceArtifactId = artifact.json().artifact.artifactId as string;
    const derivedArtifact = await app.inject({
      method: "POST",
      url: `/api/tasks/${oauthTaskId}/artifacts`,
      headers: { authorization },
      payload: {
        type: "test_result",
        workspaceRef: "workspace_oauth",
        title: "OAuth migration verification",
        summary: "Verification derived from the implementation Artifact.",
        relations: [{
          type: "verifies",
          targetArtifactId: sourceArtifactId
        }]
      }
    });
    assert.equal(derivedArtifact.statusCode, 200);
    assert.equal(derivedArtifact.json().revision, 2);
    assert.deepEqual(
      derivedArtifact.json().artifact.relations.map((relation: {
        type: string;
        targetArtifactId: string;
      }) => ({ type: relation.type, targetArtifactId: relation.targetArtifactId })),
      [{ type: "verifies", targetArtifactId: sourceArtifactId }]
    );
    const crossTaskRelation = await app.inject({
      method: "POST",
      url: `/api/tasks/${ciTaskId}/artifacts`,
      headers: { authorization },
      payload: {
        type: "test_result",
        workspaceRef: "workspace_ci",
        title: "Cross-Task verification",
        summary: "Must not enter a different Task history.",
        relations: [{
          type: "verifies",
          targetArtifactId: sourceArtifactId
        }]
      }
    });
    assert.equal(crossTaskRelation.statusCode, 400);
    assert.match(crossTaskRelation.json().error.message, /same Task history/u);
    const lineageList = await app.inject({
      method: "GET",
      url: `/api/tasks/${oauthTaskId}/artifacts`,
      headers: { authorization }
    });
    assert.equal(lineageList.json().revision, 2);
    assert.equal(lineageList.json().artifacts[0].relations.length, 1);

    const agentIds: string[] = [];
    for (const name of ["Coder", "Reviewer"]) {
      const agent = await app.inject({
        method: "POST",
        url: `/api/teams/${teamId}/manual-agents`,
        headers: { authorization },
        payload: { name, role: "Participant" }
      });
      assert.equal(agent.statusCode, 200);
      agentIds.push(agent.json().agent.agentId as string);
    }

    const changesBeforeTaskUpdate = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/changes?after=0`,
      headers: { authorization }
    });
    assert.equal(changesBeforeTaskUpdate.statusCode, 200);
    const changeCursor = changesBeforeTaskUpdate.json().cursor as number;

    const completed = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${completedTaskId}`,
      headers: { authorization },
      payload: { state: "completed" }
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.json().state, "completed");

    const taskUpdateChange = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/changes?after=${changeCursor}`,
      headers: { authorization }
    });
    assert.equal(taskUpdateChange.statusCode, 200);
    assert.equal(taskUpdateChange.json().changed, true);
    assert.equal(taskUpdateChange.json().team, true);

    const closedTaskRun = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: {
        taskId: completedTaskId,
        content: "Do not route closed work.",
        mentionAgentId: agentIds[0]
      }
    });
    assert.equal(closedTaskRun.statusCode, 400);
    assert.match(closedTaskRun.json().error.message, /runnable/u);

    const routed = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization },
      payload: {
        taskId: oauthTaskId,
        content: "Implement the OAuth migration.",
        mentionAgentId: agentIds[0]
      }
    });
    assert.equal(routed.statusCode, 200);
    assert.equal(routed.json().message.taskId, oauthTaskId);
    assert.equal(routed.json().runs[0].taskId, oauthTaskId);
    const crossTaskArtifact = await app.inject({
      method: "POST",
      url: `/api/tasks/${ciTaskId}/artifacts`,
      headers: { authorization },
      payload: {
        type: "test_result",
        workspaceRef: "workspace_ci",
        title: "Misattributed test result",
        summary: "Must not cite another Task's Run.",
        sourceRunId: routed.json().runs[0].runId
      }
    });
    assert.equal(crossTaskArtifact.statusCode, 400);
    assert.match(crossTaskArtifact.json().error.message, /source Run/u);

    const startDiscussion = async (taskId: string, goal: string) => app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/discussions`,
      headers: { authorization },
      payload: { taskId, goal, participantAgentIds: agentIds }
    });
    const oauthDiscussion = await startDiscussion(
      oauthTaskId,
      "Review the OAuth migration."
    );
    const ciDiscussion = await startDiscussion(ciTaskId, "Diagnose CI failures.");
    assert.equal(oauthDiscussion.statusCode, 200);
    assert.equal(ciDiscussion.statusCode, 200);
    assert.equal(oauthDiscussion.json().discussion.taskId, oauthTaskId);
    assert.equal(ciDiscussion.json().discussion.taskId, ciTaskId);

    const competing = await startDiscussion(
      oauthTaskId,
      "Start a competing OAuth discussion."
    );
    assert.equal(competing.statusCode, 409);
    assert.equal(competing.json().error.code, "CONFLICT");

    const cannotCompleteActive = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${oauthTaskId}`,
      headers: { authorization },
      payload: { state: "completed" }
    });
    assert.equal(cannotCompleteActive.statusCode, 400);
    assert.match(cannotCompleteActive.json().error.message, /active Runs or Discussions/u);

    const roomMessages = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/messages`,
      headers: { authorization }
    });
    assert.equal(roomMessages.statusCode, 200);
    assert.equal(
      roomMessages.json().items.some((message: { content: string }) =>
        message.content === "Do not route closed work."
      ),
      false
    );
  } finally {
    await app.close();
  }
});
