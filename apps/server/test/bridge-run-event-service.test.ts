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
import { BridgeRunEventService } from "../src/run/bridge-run-event-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

test("Bridge events enforce ownership, ordering, and one reply projection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-events-"));
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
    const runs = new RunService(core, runRepository, auth);
    const created = teams.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6", userDisplayName: "Alice",
      teamName: "Core Team", now
    });
    const session = auth.issueWebSession(created.owner.userId ?? "", now, "2026-08-22T11:00:00.000Z");
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "general", now);
    const device = registry.registerOwnDevice(principal, created.team.teamId, "Mac", now);
    const agent = agents.publishAgent(principal, {
      teamId: created.team.teamId, deviceId: device.deviceId, name: "Builder", role: "Managed",
      integrationMode: "managed", capabilities: {
        supportsHandoff: false, supportsInterrupt: true, supportsResume: false,
        supportsStart: true, supportsStreaming: true
      }, now
    });
    const trigger = messages.createMemberMessage(principal, {
      roomId: room.roomId, content: "Implement events", mentions: [{
        targetType: "agent", targetAgentId: agent.agentId, displayLabel: "Builder / Managed"
      }], now
    });
    const run = runs.createRunsForMessage(principal, trigger.messageId, now)[0];
    assert.ok(run);
    runRepository.applyEvent(run.runId, { type: "status", sequence: 1, status: "delivered" }, now);
    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const devicePrincipal = auth.authenticateDevice(credential.secret, now);
    const service = new BridgeRunEventService(core, runRepository);

    assert.equal(service.applyStatus(devicePrincipal, {
      runId: run.runId, agentId: agent.agentId, sequence: 2, status: "working"
    }, now).run.state, "working");
    assert.equal(service.applyReply(devicePrincipal, {
      runId: run.runId, agentId: agent.agentId, sequence: 3,
      content: "Implemented. token=very-sensitive-value",
      assessment: {
        goalSatisfied: true,
        confidence: 0.92,
        newEvidenceRefs: ["token=assessment-sensitive-value"],
        recommendation: "finish"
      }
    }, now).applied, true);
    assert.equal(service.applyReply(devicePrincipal, {
      runId: run.runId, agentId: agent.agentId, sequence: 3,
      content: "Implemented. token=very-sensitive-value"
    }, now).applied, false);
    assert.equal(service.applyStatus(devicePrincipal, {
      runId: run.runId, agentId: agent.agentId, sequence: 4, status: "completed"
    }, now).run.state, "completed");
    assert.equal(core.listMessagesAfter(room.roomId, 0, 20).length, 2);
    assert.equal(
      core.listMessagesAfter(room.roomId, 0, 20).at(-1)?.content.includes("very-sensitive"),
      false
    );
    const replyEvent = runRepository.listEvents(run.runId).find(
      (event) => event.event.type === "reply"
    );
    assert.equal(
      replyEvent?.event.type === "reply" && replyEvent.event.content.includes("very-sensitive"),
      false
    );
    assert.deepEqual(
      replyEvent?.event.type === "reply" ? replyEvent.event.assessment : null,
      {
        goalSatisfied: true,
        confidence: 0.92,
        newEvidenceRefs: ["[REDACTED]"],
        recommendation: "finish"
      }
    );
    assert.equal(core.getAgent(agent.agentId)?.presence, "ready");
    assert.throws(() => service.applyStatus(devicePrincipal, {
      runId: run.runId, agentId: "agent_wrong_identity", sequence: 5, status: "failed"
    }, now), /identity mismatch/u);

    const bob = registry.addMember(principal, {
      teamId: created.team.teamId,
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4B0B0",
      displayName: "Bob",
      now
    });
    const bobSession = auth.issueWebSession(
      bob.userId ?? "", now, "2026-08-22T11:00:00.000Z"
    );
    const bobPrincipal = auth.authenticateWebSession(bobSession.secret, now);
    const bobDevice = registry.registerOwnDevice(
      bobPrincipal, created.team.teamId, "Bob Mac", now
    );
    const bobCredential = auth.issueDeviceCredential(bobDevice.deviceId, now);
    assert.throws(() => service.applyStatus(
      auth.authenticateDevice(bobCredential.secret, now),
      { runId: run.runId, agentId: agent.agentId, sequence: 5, status: "failed" },
      now
    ), /identity mismatch/u);

    const otherTeam = teams.createTeamForUser({
      userId: created.owner.userId ?? "",
      userDisplayName: "Alice",
      teamName: "Other Team",
      now
    });
    const otherDevice = registry.registerOwnDevice(
      principal, otherTeam.team.teamId, "Other Team Mac", now
    );
    const otherCredential = auth.issueDeviceCredential(otherDevice.deviceId, now);
    assert.throws(() => service.applyStatus(
      auth.authenticateDevice(otherCredential.secret, now),
      { runId: run.runId, agentId: agent.agentId, sequence: 5, status: "failed" },
      now
    ), /identity mismatch/u);
  } finally {
    database.close();
  }
});
