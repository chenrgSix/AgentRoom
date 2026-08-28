import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-28T16:00:00.000Z";

test("Device-authenticated managed Result proposal is explicit and idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-result-http-"));
  const databasePath = path.join(directory, "server.sqlite");
  const app = await createServerApp({ databasePath, clock: () => now, logger: false });
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(core, auth);
    const registry = new MemberDeviceService(core, auth);
    const agents = new AgentService(core, auth);
    const messages = new MessageService(core, auth);
    const taskRepository = new AgentTaskRepository(database);
    const runRepository = new RunRepository(database);
    const runs = new RunService(core, runRepository, auth, taskRepository);
    const created = teams.createTeamForUser({
      userId: "user_managed_result_12345678",
      userDisplayName: "Alice",
      teamName: "Managed Result Team",
      now
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      now,
      "2026-08-28T17:00:00.000Z"
    );
    const member = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(member, created.team.teamId, "results", now);
    const device = registry.registerOwnDevice(
      member,
      created.team.teamId,
      "Builder Mac",
      now
    );
    const foreignDevice = registry.registerOwnDevice(
      member,
      created.team.teamId,
      "Other Mac",
      now
    );
    const agent = agents.publishAgent(member, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Managed",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const message = messages.createMemberMessage(member, {
      roomId: room.roomId,
      content: "Produce an explicit Result proposal.",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const run = runs.createRunsForMessage(member, message.messageId, now)[0]!;
    runRepository.applyEvent(run.runId, {
      type: "status",
      sequence: 1,
      status: "delivered"
    }, now);
    const task = taskRepository.get(run.taskId)!;
    const proposal = {
      operationId: "op_managed_result_http_0001",
      taskId: task.taskId,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision,
      proposedAtTaskRevision: task.taskRevision,
      supersedesResultId: null,
      outcome: "informational",
      summary: "The managed Runtime explicitly submitted this bounded Result.",
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: "evidence_managed_event_0001",
        kind: "run_event",
        runId: run.runId,
        sequence: 1
      }],
      criterionClaims: []
    };
    const payload = {
      actorKind: "managed_agent",
      agentId: agent.agentId,
      runId: run.runId,
      proposal
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/bridge/results",
      headers: { authorization: "Bearer invalid-device-secret" },
      payload
    });
    assert.equal(unauthorized.statusCode, 401);

    const foreignCredential = auth.issueDeviceCredential(foreignDevice.deviceId, now);
    const wrongDevice = await app.inject({
      method: "POST",
      url: "/api/bridge/results",
      headers: { authorization: `Bearer ${foreignCredential.secret}` },
      payload
    });
    assert.equal(wrongDevice.statusCode, 400);
    assert.match(wrongDevice.json().error.message, /authenticated Device/u);

    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const proposed = await app.inject({
      method: "POST",
      url: "/api/bridge/results",
      headers: { authorization: `Bearer ${credential.secret}` },
      payload
    });
    assert.equal(proposed.statusCode, 200, proposed.body);
    assert.deepEqual(proposed.json().proposedBy, {
      kind: "managed_agent",
      agentId: agent.agentId,
      runId: run.runId
    });
    assert.equal(proposed.headers["cache-control"], "no-store");
    const replay = await app.inject({
      method: "POST",
      url: "/api/bridge/results",
      headers: { authorization: `Bearer ${credential.secret}` },
      payload
    });
    assert.deepEqual(replay.json(), proposed.json());

    const localField = await app.inject({
      method: "POST",
      url: "/api/bridge/results",
      headers: { authorization: `Bearer ${credential.secret}` },
      payload: {
        ...payload,
        proposal: { ...proposal, workspacePath: "/private/workspace" }
      }
    });
    assert.equal(localField.statusCode, 400);
    assert.match(localField.json().error.message, /unsupported fields/u);
    assert.equal(localField.body.includes("/private/workspace"), false);

    const bridgeReview = await app.inject({
      method: "POST",
      url: `/api/results/${proposed.json().resultId as string}/review-decisions`,
      headers: { authorization: `Bearer ${credential.secret}` },
      payload: {
        operationId: "op_managed_review_forbidden_0001",
        decision: "accepted",
        expectedTaskRevision: task.taskRevision + 1,
        expectedReviewRevision: 0,
        reason: "A Device cannot review its own Result.",
        completeTask: false
      }
    });
    assert.equal(bridgeReview.statusCode, 401);
  } finally {
    database.close();
    await app.close();
  }
});
