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
import { OperationalMetrics } from
  "../src/observability/operational-metrics.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { CancellationService } from "../src/run/cancellation-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const createdAt = "2026-08-28T10:00:00.000Z";
const canceledAt = "2026-08-28T10:00:10.000Z";

class CapturingSocket implements BridgeSocket {
  public readonly messages: string[] = [];

  public close(): void {}

  public send(data: string): void {
    this.messages.push(data);
  }
}

test("an offline canceled Run is not an actionable pending delivery", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "convene-wire-cancel-metrics-")
  );
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(core, auth);
    const devices = new MemberDeviceService(core, auth);
    const agents = new AgentService(core, auth);
    const messages = new MessageService(core, auth);
    const runRepository = new RunRepository(database);
    const taskRepository = new AgentTaskRepository(database);
    const runService = new RunService(
      core,
      runRepository,
      auth,
      taskRepository
    );
    const created = teams.createTeamForUser({
      userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      userDisplayName: "Alice",
      teamName: "Recovery Team",
      now: createdAt
    });
    const session = auth.issueWebSession(
      created.owner.userId ?? "",
      createdAt,
      "2026-08-28T12:00:00.000Z"
    );
    const principal = auth.authenticateWebSession(session.secret, createdAt);
    const room = teams.createRoom(
      principal,
      created.team.teamId,
      "recovery",
      createdAt
    );
    const device = devices.registerOwnDevice(
      principal,
      created.team.teamId,
      "Offline Device",
      createdAt
    );
    const agent = agents.publishAgent(principal, {
      teamId: created.team.teamId,
      deviceId: device.deviceId,
      name: "Builder",
      role: "Managed Runtime",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true
      },
      now: createdAt
    });
    const message = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content: "Cancel this while the Device is offline",
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed Runtime"
      }],
      now: createdAt
    });
    const run = runService.createRunsForMessage(
      principal,
      message.messageId,
      createdAt
    )[0];
    assert.ok(run);

    const connections = new BridgeConnectionRegistry();
    const delivery = new DeliveryService(
      database,
      core,
      runRepository,
      new ContextPlanner(database, core, taskRepository),
      connections,
      () => createdAt
    );
    const pending = delivery.dispatch(run.runId);
    assert.deepEqual(
      { state: pending?.state, sendCount: pending?.sendCount },
      { state: "pending", sendCount: 0 }
    );

    const metrics = new OperationalMetrics(
      database,
      connections,
      () => canceledAt
    );
    assert.equal(metrics.snapshot().pendingDeliveries, 1);
    assert.equal(metrics.snapshot().oldestPendingDeliveryAgeSeconds, 10);

    const canceled = new CancellationService(
      core,
      runRepository,
      auth,
      connections,
      () => canceledAt
    ).cancel(principal, run.runId, "Wrong target Agent");
    assert.equal(canceled.state, "canceled");
    const unaccepted = delivery.getByRun(run.runId);
    assert.deepEqual(
      { state: unaccepted?.state, sendCount: unaccepted?.sendCount },
      { state: "pending", sendCount: 0 }
    );

    const afterCancel = metrics.snapshot();
    assert.equal(afterCancel.queueDepth, 0);
    assert.equal(afterCancel.pendingDeliveries, 0);
    assert.equal(afterCancel.oldestPendingDeliveryAgeSeconds, 0);
    assert.equal(afterCancel.deliveryRetries, 0);

    const socket = new CapturingSocket();
    connections.register(device.deviceId, 1, socket);
    delivery.dispatchQueuedForDevice(device.deviceId);
    assert.equal(socket.messages.length, 0);
  } finally {
    database.close();
  }
});
