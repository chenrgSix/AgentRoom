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
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-22T10:00:00.000Z";

test("Bridge events enforce ownership, ordering, and one reply projection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-events-"));
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
    const taskRepository = new AgentTaskRepository(database);
    const runs = new RunService(
      core, runRepository, auth, taskRepository
    );
    const created = teams.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6", userDisplayName: "Alice",
      teamName: "Core Team", now
    });
    const session = auth.issueWebSession(created.owner.userId ?? "", now, "2026-08-22T11:00:00.000Z");
    const principal = auth.authenticateWebSession(session.secret, now);
    const room = teams.createRoom(principal, created.team.teamId, "general", now);
    const device = registry.registerOwnDevice(principal, created.team.teamId, "Mac", now);
    const runtimeScopeId = "a".repeat(64);
    const agent = agents.publishAgent(principal, {
      teamId: created.team.teamId, deviceId: device.deviceId, name: "Builder", role: "Managed",
      integrationMode: "managed", capabilities: {
        supportsHandoff: false, supportsInterrupt: true, supportsResume: false,
        supportsStart: true, supportsStreaming: true,
        supportsRoomContextCoverage: true
      }, runtimeScopeId, now
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
    const validatedRoomContextReceipts: unknown[] = [];
    const service = new BridgeRunEventService(
      core,
      runRepository,
      undefined,
      {
        validateRoomContextConsumption: (...input) => {
          validatedRoomContextReceipts.push(input);
        }
      }
    );

    assert.throws(() => service.applyStatus(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 7, status: "completed",
      session: {
        disposition: "resumed",
        contextCursor: trigger.sequence,
        runtimeScopeId: "b".repeat(64),
        resultEvidenceRevision: 0
      }
    }, now), /logical Runtime session status/u);
    assert.equal(service.applyStatus(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 2, status: "working"
    }, now).run.state, "working");
    assert.equal(service.applyActivity(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 3,
      activityId: "reasoning-1", kind: "reasoning", phase: "updated",
      label: "Thinking", content: "Checking token=activity-sensitive-value"
    }, now).applied, true);
    assert.equal(service.applyOutput(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 4,
      content: "Draft token=output-sensitive-value"
    }, now).applied, true);
    assert.equal(service.applyOutput(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 5,
      content: "Final preview", reset: true
    }, now).applied, true);
    assert.equal(service.applyOutput(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 5,
      content: "Final preview", reset: true
    }, now).applied, false);
    assert.throws(() => service.applyOutput(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 7,
      content: "Gap"
    }, now), /sequence gap/u);
    assert.equal(core.listMessagesAfter(room.roomId, 0, 20).length, 1);
    assert.equal(service.applyReply(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 6,
      content: "Implemented. token=very-sensitive-value",
      assessment: {
        goalSatisfied: true,
        confidence: 0.92,
        newEvidenceRefs: ["token=assessment-sensitive-value"],
        recommendation: "finish"
      }
    }, now).applied, true);
    assert.equal(service.applyReply(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 6,
      content: "Implemented. token=very-sensitive-value"
    }, now).applied, false);
    assert.equal(service.applyStatus(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 7, status: "completed",
      session: {
        disposition: "resumed",
        contextCursor: trigger.sequence,
        runtimeScopeId,
        resultEvidenceRevision: 0,
        roomContextConsumption: {
          baseContextCursor: 0,
          checkpointId: "checkpoint_event_context_12345678",
          rawFromSequenceExclusive: 0,
          rawThroughSequenceInclusive: 0,
          rawMessageCount: 0,
          coverageThroughSequence: trigger.sequence
        }
      }
    }, now).run.state, "completed");
    const terminalEvent = runRepository.listEvents(run.runId).at(-1)?.event;
    assert.deepEqual(
      terminalEvent?.type === "status" ? terminalEvent.session : null,
      {
        disposition: "resumed", contextCursor: trigger.sequence,
        runtimeScopeId,
        resultEvidenceRevision: 0,
        roomContextConsumption: {
          baseContextCursor: 0,
          checkpointId: "checkpoint_event_context_12345678",
          rawFromSequenceExclusive: 0,
          rawThroughSequenceInclusive: 0,
          rawMessageCount: 0,
          coverageThroughSequence: trigger.sequence
        }
      }
    );
    assert.equal(validatedRoomContextReceipts.length, 1);
    assert.equal(
      taskRepository.get(run.taskId)?.lastRoomSequence,
      trigger.sequence
    );
    assert.throws(() => service.applyStatus(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 8, status: "completed",
      session: {
        disposition: "resumed",
        contextCursor: trigger.sequence + 1
      }
    }, now), /logical Runtime session status/u);
    assert.equal(service.applyOutput(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: agent.agentId, sequence: 8,
      content: "late output"
    }, now).applied, false);
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
    const activityEvent = runRepository.listEvents(run.runId).find(
      (event) => event.event.type === "activity"
    );
    assert.deepEqual(activityEvent?.event, {
      type: "activity",
      sequence: 3,
      activityId: "reasoning-1",
      kind: "reasoning",
      phase: "updated",
      label: "Thinking",
      content: "Checking [REDACTED]"
    });
    const routingIntent = runRepository.listPendingReplyRoutingIntents(run.runId)[0];
    assert.equal(routingIntent?.content.includes("very-sensitive"), false);
    assert.equal(routingIntent?.content, "Implemented. [REDACTED]");
    const outputEvents = runRepository.listEvents(run.runId, 2).filter(
      (event) => event.event.type === "output"
    );
    assert.deepEqual(outputEvents.map(({ event }) => event), [
      { type: "output", sequence: 4, content: "Draft [REDACTED]" },
      { type: "output", sequence: 5, content: "Final preview", reset: true }
    ]);
    assert.equal(core.getAgent(agent.agentId)?.presence, "ready");
    assert.throws(() => service.applyStatus(devicePrincipal, {
      runId: run.runId, traceId: run.traceId,
      agentId: "agent_wrong_identity", sequence: 8, status: "failed"
    }, now), /identity mismatch/u);
    assert.throws(() => service.applyStatus(devicePrincipal, {
      runId: run.runId, traceId: "trace_wrong_identity",
      agentId: agent.agentId, sequence: 8, status: "failed"
    }, now), /identity mismatch/u);

    const canceledTrigger = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Cancel this stream",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const canceledRun = runs.createRunsForMessage(
      principal, canceledTrigger.messageId, now
    )[0];
    assert.ok(canceledRun);
    runRepository.applyEvent(canceledRun.runId, {
      type: "status", sequence: 1, status: "delivered"
    }, now);
    service.applyStatus(devicePrincipal, {
      runId: canceledRun.runId, traceId: canceledRun.traceId,
      agentId: agent.agentId, sequence: 2, status: "working"
    }, now);
    service.applyOutput(devicePrincipal, {
      runId: canceledRun.runId, traceId: canceledRun.traceId,
      agentId: agent.agentId, sequence: 3, content: "Cancelable preview"
    }, now);
    service.applyStatus(devicePrincipal, {
      runId: canceledRun.runId, traceId: canceledRun.traceId,
      agentId: agent.agentId, sequence: 4, status: "canceled"
    }, now);
    assert.equal(service.applyOutput(devicePrincipal, {
      runId: canceledRun.runId, traceId: canceledRun.traceId,
      agentId: agent.agentId, sequence: 5, content: "late canceled output"
    }, now).applied, false);
    assert.deepEqual(
      runRepository.listEvents(canceledRun.runId).map(({ sequence }) => sequence),
      [1, 2, 3, 4]
    );
    assert.equal(core.listMessagesAfter(room.roomId, 0, 20).length, 3);

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
      { runId: run.runId, traceId: run.traceId,
        agentId: agent.agentId, sequence: 7, status: "failed" },
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
      { runId: run.runId, traceId: run.traceId,
        agentId: agent.agentId, sequence: 7, status: "failed" },
      now
    ), /identity mismatch/u);
  } finally {
    database.close();
  }
});
