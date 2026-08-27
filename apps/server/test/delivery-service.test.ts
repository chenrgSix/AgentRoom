import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BridgeConnectionRegistry,
  type BridgeSocket
} from "../src/bridge/bridge-connection-registry.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import {
  RollingRoomMemoryRepository
} from "../src/memory/rolling-room-memory-repository.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { TaskArtifactService } from "../src/task/task-artifact-service.js";
import {
  ResultEvidenceConsumptionRepository
} from "../src/task/result-evidence-consumption-repository.js";

const now = "2026-08-22T10:00:00.000Z";
const runtimeScopeId = "a".repeat(64);

class CapturingSocket implements BridgeSocket {
  public readonly messages: string[] = [];
  public close(): void {}
  public send(data: string): void { this.messages.push(data); }
}

test("ACK loss resends one durable Delivery identity and converges once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-delivery-"));
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
    const device = registry.registerOwnDevice(principal, created.team.teamId, "Mac", now);
    const agent = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Managed",
      integrationMode: "managed",
      runtimeScopeId,
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true,
        supportsRoomContextCoverage: true
      },
      now
    });
    const reviewer = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Reviewer",
      role: "Managed",
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
    const task = taskRepository.getDefaultForRoom(room.roomId);
    assert.ok(task);
    const taskArtifacts = new TaskArtifactService(
      new ArtifactRepository(database),
      taskRepository,
      runRepository,
      core,
      auth
    );
    for (let revision = 1; revision <= 25; revision += 1) {
      taskArtifacts.create(principal, task.taskId, {
        type: "test_result",
        workspaceRef: "workspace_delivery",
        title: `Delivery evidence ${revision}`,
        summary: `Evidence revision ${revision}.`
      }, now);
    }
    const message = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Implement delivery",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const run = runs.createRunsForMessage(principal, message.messageId, now)[0];
    assert.ok(run);
    const connections = new BridgeConnectionRegistry();
    const socket = new CapturingSocket();
    let currentTime = now;
    const delivery = new DeliveryService(
      database,
      core,
      runRepository,
      new ContextPlanner(database, core, taskRepository),
      connections,
      () => currentTime
    );
    const offline = delivery.dispatch(run.runId);
    assert.equal(offline?.sendCount, 0);
    assert.equal(socket.messages.length, 0);
    connections.register(device.deviceId, 1, socket);
    delivery.dispatchQueuedForDevice(device.deviceId);
    assert.equal(socket.messages.length, 1);
    const requested = JSON.parse(socket.messages[0] ?? "{}") as {
      payload?: {
        taskId?: string;
        session?: {
          scope?: string;
          resumePolicy?: string;
          contextCursor?: number;
          runtimeScopeId?: string;
        };
        targetAgentName?: string;
        contextPlan?: {
          roomMemory?: { revision?: number; sourceMessageIds?: string[] };
          taskMemory?: { revision?: number; summary?: string };
          resultEvidence?: {
            deliveryKind?: string;
            fromRevision?: number;
            throughRevision?: number;
            hasMore?: boolean;
            artifactRefs?: Array<{ artifactRevision?: number }>;
          };
        };
        contextManifest?: {
          runId?: string;
          taskId?: string;
          goal?: string;
          included?: { messageIds?: string[] };
        };
        contextMessages?: Array<{ sequence?: number; senderName?: string }>;
        routingAgents?: Array<{ agentId: string; name: string }>;
      };
    };
    assert.equal(requested.payload?.taskId, run.taskId);
    assert.deepEqual(requested.payload?.session, {
      scope: "task",
      resumePolicy: "resume_or_start",
      contextCursor: message.sequence,
      runtimeScopeId
    });
    assert.equal(requested.payload?.targetAgentName, "Builder");
    assert.deepEqual(
      requested.payload?.contextManifest,
      runRepository.getContextManifest(run.runId)
    );
    assert.equal(requested.payload?.contextManifest?.runId, run.runId);
    assert.equal(requested.payload?.contextManifest?.taskId, run.taskId);
    assert.deepEqual(requested.payload?.contextManifest?.included?.messageIds, [
      message.messageId
    ]);
    assert.equal(requested.payload?.contextPlan?.roomMemory?.revision, 1);
    assert.deepEqual(
      requested.payload?.contextPlan?.roomMemory?.sourceMessageIds,
      []
    );
    assert.match(
      requested.payload?.contextPlan?.taskMemory?.summary ?? "",
      /Task: Room work/u
    );
    assert.equal(requested.payload?.contextMessages?.at(-1)?.sequence, message.sequence);
    assert.equal(requested.payload?.contextMessages?.at(-1)?.senderName, "Alice");
    assert.deepEqual(requested.payload?.routingAgents, [{
      agentId: reviewer.agentId,
      name: "Reviewer"
    }]);
    assert.deepEqual(requested.payload?.contextPlan?.resultEvidence, {
      revision: 25,
      deliveryKind: "bootstrap",
      fromRevision: 5,
      throughRevision: 25,
      hasMore: false,
      artifactRefs: requested.payload?.contextPlan?.resultEvidence?.artifactRefs
    });
    assert.deepEqual(
      requested.payload?.contextPlan?.resultEvidence?.artifactRefs?.map(
        ({ artifactRevision }) => artifactRevision
      ),
      Array.from({ length: 20 }, (_, index) => index + 6)
    );
    const rollingMemory = new RollingRoomMemoryRepository(database);
    rollingMemory.enable(room.roomId, now);
    const roomLease = rollingMemory.acquireLease({
      roomId: room.roomId,
      leaseToken: "lease_delivery_context_0001",
      now,
      leaseExpiresAt: "2026-08-22T10:05:00.000Z"
    });
    assert.ok(roomLease);
    rollingMemory.commitCheckpoint({
      checkpoint: {
        checkpointId: "checkpoint_delivery_context_0001",
        roomId: room.roomId,
        parentCheckpointId: null,
        inputFromSequenceExclusive: 0,
        throughSequence: message.sequence,
        summary: "The owner requested delivery implementation.",
        provenance: [message.messageId],
        sourceMessageCount: 1,
        sourceDigest: "b".repeat(64),
        promptVersion: 1,
        modelFingerprint: "test-reducer-v1",
        buildKind: "incremental",
        createdAt: now
      },
      expectedGeneration: roomLease.generation,
      leaseToken: roomLease.leaseToken!,
      now
    });
    const consumption = new ResultEvidenceConsumptionRepository(database);
    assert.throws(() => consumption.acknowledge({
      runId: run.runId,
      taskId: task.taskId,
      agentId: agent.agentId,
      runtimeScopeId,
      throughRevision: 26,
      now
    }), /exceeds its delivered page/u);
    consumption.acknowledge({
      runId: run.runId,
      taskId: task.taskId,
      agentId: agent.agentId,
      runtimeScopeId,
      throughRevision: 25,
      now
    });
    for (let revision = 26; revision <= 55; revision += 1) {
      taskArtifacts.create(principal, task.taskId, {
        type: "test_result",
        workspaceRef: "workspace_delivery",
        title: `Delivery evidence ${revision}`,
        summary: `Evidence revision ${revision}.`
      }, now);
    }
    const deltaMessage = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Continue delivery",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const deltaRun = runs.createRunsForMessage(
      principal,
      deltaMessage.messageId,
      now
    )[0];
    assert.ok(deltaRun);
    const firstDeltaDelivery = delivery.dispatch(deltaRun.runId)?.payload;
    const firstDelta = firstDeltaDelivery?.contextPlan.resultEvidence;
    assert.deepEqual({
      legacyContextCount: firstDeltaDelivery?.contextMessages.length,
      target: firstDeltaDelivery?.roomContextBundle?.targetThroughSequence,
      prior: firstDeltaDelivery?.roomContextBundle?.priorContextThroughSequence,
      requestMessageId: firstDeltaDelivery?.roomContextBundle?.requestMessageId,
      checkpointThrough:
        firstDeltaDelivery?.roomContextBundle?.checkpoint.throughSequence,
      rawCount: firstDeltaDelivery?.roomContextBundle?.rawTail.messageCount,
      rawThrough:
        firstDeltaDelivery?.roomContextBundle?.rawTail.throughSequenceInclusive
    }, {
      legacyContextCount: 0,
      target: deltaMessage.sequence,
      prior: message.sequence,
      requestMessageId: deltaMessage.messageId,
      checkpointThrough: message.sequence,
      rawCount: 0,
      rawThrough: message.sequence
    });
    delivery.validateRoomContextConsumption(
      deltaRun.runId,
      "resumed",
      deltaMessage.sequence,
      {
        baseContextCursor: message.sequence,
        rawFromSequenceExclusive: message.sequence,
        rawThroughSequenceInclusive: message.sequence,
        rawMessageCount: 0,
        coverageThroughSequence: deltaMessage.sequence
      }
    );
    assert.throws(() => delivery.validateRoomContextConsumption(
      deltaRun.runId,
      "resumed",
      deltaMessage.sequence,
      {
        baseContextCursor: message.sequence,
        checkpointId: "checkpoint_delivery_context_0001",
        rawFromSequenceExclusive: message.sequence,
        rawThroughSequenceInclusive: message.sequence,
        rawMessageCount: 0,
        coverageThroughSequence: deltaMessage.sequence
      }
    ), /checkpoint receipt/u);
    assert.throws(() => delivery.validateRoomContextConsumption(
      deltaRun.runId,
      "resumed",
      deltaMessage.sequence,
      {
        baseContextCursor: message.sequence,
        rawFromSequenceExclusive: 0,
        rawThroughSequenceInclusive: message.sequence,
        rawMessageCount: 0,
        coverageThroughSequence: deltaMessage.sequence
      }
    ), /delivered interval/u);
    assert.deepEqual({
      deliveryKind: firstDelta?.deliveryKind,
      fromRevision: firstDelta?.fromRevision,
      throughRevision: firstDelta?.throughRevision,
      hasMore: firstDelta?.hasMore,
      revisions: firstDelta?.artifactRefs.map(({ artifactRevision }) => artifactRevision)
    }, {
      deliveryKind: "delta",
      fromRevision: 25,
      throughRevision: 45,
      hasMore: true,
      revisions: Array.from({ length: 20 }, (_, index) => index + 26)
    });
    consumption.acknowledge({
      runId: deltaRun.runId,
      taskId: task.taskId,
      agentId: agent.agentId,
      runtimeScopeId,
      throughRevision: 45,
      now
    });
    const finalMessage = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Finish delivery",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const finalRun = runs.createRunsForMessage(
      principal,
      finalMessage.messageId,
      now
    )[0];
    assert.ok(finalRun);
    const finalDelta = delivery.dispatch(finalRun.runId)?.payload.contextPlan.resultEvidence;
    assert.deepEqual({
      fromRevision: finalDelta?.fromRevision,
      throughRevision: finalDelta?.throughRevision,
      hasMore: finalDelta?.hasMore,
      revisions: finalDelta?.artifactRefs.map(({ artifactRevision }) => artifactRevision)
    }, {
      fromRevision: 45,
      throughRevision: 55,
      hasMore: false,
      revisions: Array.from({ length: 10 }, (_, index) => index + 46)
    });
    const first = delivery.getByRun(run.runId);
    const repeated = delivery.dispatch(run.runId);
    assert.equal(socket.messages.length, 4);
    assert.equal(first?.deliveryAttemptId, repeated?.deliveryAttemptId);
    assert.equal(first?.idempotencyKey, repeated?.idempotencyKey);
    assert.equal(repeated?.sendCount, 2);

    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const devicePrincipal = auth.authenticateDevice(credential.secret, now);
    assert.throws(() => delivery.accept(
      devicePrincipal, run.runId, "trace_wrong_identity", agent.agentId, 1, now
    ), /identity mismatch/u);
    assert.equal(
      delivery.accept(
        devicePrincipal, run.runId, run.traceId, agent.agentId, 1, now
      ).state,
      "delivered"
    );
    assert.equal(
      delivery.accept(
        devicePrincipal, run.runId, run.traceId, agent.agentId, 1, now
      ).state,
      "delivered"
    );
    assert.equal(delivery.getByRun(run.runId)?.state, "accepted");

    teams.updateRoomSettings(principal, room.roomId, {
      participants: {
        memberIds: [created.owner.memberId],
        agentIds: [agent.agentId, reviewer.agentId]
      },
      collaborationPolicy: {
        allowDiscussion: true,
        allowAll: true,
        allowAgentMentions: false,
        maxAgentMentionDepth: 4
      },
      expectedRevision: core.getRoom(room.roomId)?.settingsRevision ?? 0
    }, now);
    const isolatedMessage = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Do not advertise peer routing",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const isolatedRun = runs.createRunsForMessage(
      principal, isolatedMessage.messageId, now
    )[0];
    assert.ok(isolatedRun);
    delivery.dispatch(isolatedRun.runId);
    const isolatedRequest = JSON.parse(socket.messages.at(-1) ?? "{}") as {
      payload?: { routingAgents?: Array<{ agentId: string; name: string }> };
    };
    assert.deepEqual(isolatedRequest.payload?.routingAgents, []);

    const expiringMessage = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Expire offline",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed"
      }],
      now
    });
    const expiringRun = runs.createRunsForMessage(
      principal, expiringMessage.messageId, now
    )[0];
    assert.ok(expiringRun);
    currentTime = "2026-08-22T10:21:00.000Z";
    assert.equal(delivery.dispatch(expiringRun.runId), undefined);
    assert.equal(runRepository.getRun(expiringRun.runId)?.state, "expired");
  } finally {
    database.close();
  }
});
