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
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

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
    const runs = new RunService(core, runRepository, auth);
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
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
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
    connections.register(device.deviceId, 1, socket);
    const delivery = new DeliveryService(
      database,
      core,
      runRepository,
      connections,
      () => now
    );
    const first = delivery.dispatch(run.runId);
    const repeated = delivery.dispatch(run.runId);
    assert.equal(socket.messages.length, 2);
    assert.equal(first?.deliveryAttemptId, repeated?.deliveryAttemptId);
    assert.equal(first?.idempotencyKey, repeated?.idempotencyKey);
    assert.equal(repeated?.sendCount, 2);

    const credential = auth.issueDeviceCredential(device.deviceId, now);
    const devicePrincipal = auth.authenticateDevice(credential.secret, now);
    assert.equal(
      delivery.accept(devicePrincipal, run.runId, agent.agentId, 1, now).state,
      "delivered"
    );
    assert.equal(
      delivery.accept(devicePrincipal, run.runId, agent.agentId, 1, now).state,
      "delivered"
    );
    assert.equal(delivery.getByRun(run.runId)?.state, "accepted");
  } finally {
    database.close();
  }
});
