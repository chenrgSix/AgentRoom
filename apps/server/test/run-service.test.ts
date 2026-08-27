import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-22T10:00:00.000Z";

test("one idempotent queued Run is created per structured Agent Mention", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-run-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(core, auth);
    const registry = new MemberDeviceService(core, auth);
    const agents = new AgentService(core, auth);
    const messages = new MessageService(core, auth);
    const runRepository = new RunRepository(database);
    const runService = new RunService(
      core, runRepository, auth, new AgentTaskRepository(database)
    );
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
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "general", now);
    const device = registry.registerOwnDevice(
      principal,
      created.team.teamId,
      "Alice Mac",
      now
    );
    const agent = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Backend",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const plain = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "@Builder plain text does not route.",
      now
    });
    assert.deepEqual(runService.createRunsForMessage(principal, plain.messageId, now), []);

    const mentioned = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Implement the Team API.",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Backend"
      }],
      now
    });
    const first = runService.createRunsForMessage(principal, mentioned.messageId, now);
    const repeated = runService.createRunsForMessage(principal, mentioned.messageId, now);
    assert.equal(first.length, 1);
    assert.equal(first[0]?.state, "queued");
    assert.equal(first[0]?.targetAgentId, agent.agentId);
    assert.deepEqual(repeated, first);
    assert.deepEqual(runService.listRoomRuns(principal, room.roomId), first);

    const runId = first[0]?.runId ?? "";
    assert.deepEqual(runRepository.getContextFence(runId), {
      runId,
      roomId: room.roomId,
      taskId: mentioned.taskId,
      triggerSequence: mentioned.sequence,
      roomLongTermMemoryRevision: 0,
      taskLongTermMemoryRevision: 0,
      taskArtifactRevision: 0,
      taskSummaryRevision: 0,
      taskState: "working",
      taskTitle: "Room work",
      taskGoal: "Continue work in this Room.",
      fenceKind: "captured",
      capturedAt: now
    });
    assert.equal(runRepository.applyEvent(runId, {
      type: "status",
      sequence: 1,
      status: "working"
    }, now).run.state, "working");
    assert.equal(runRepository.applyEvent(runId, {
      type: "reply",
      sequence: 1,
      content: "stale"
    }, now).applied, false);
    assert.equal(runRepository.applyEvent(runId, {
      type: "reply",
      sequence: 2,
      content: "done"
    }, now).applied, true);
    assert.equal(runRepository.applyEvent(runId, {
      type: "status",
      sequence: 3,
      status: "completed"
    }, now).run.state, "completed");
    assert.equal(runRepository.applyEvent(runId, {
      type: "status",
      sequence: 4,
      status: "failed"
    }, now).applied, false);
    assert.deepEqual(
      runRepository.listEvents(runId).map((event) => event.sequence),
      [1, 2, 3]
    );
  } finally {
    database.close();
  }
});
