import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";
import { BridgeConnectionRegistry } from "../src/bridge/bridge-connection-registry.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { BridgeRunEventService } from "../src/run/bridge-run-event-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { HandoffService } from "../src/run/handoff-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-22T10:00:00.000Z";

test("server restart preserves Run, Delivery, and contiguous event authority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-recovery-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  let database = openDatabase(databasePath);
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
    teamName: "Recovery Team", now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "", now, "2026-08-22T11:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "general", now);
  const device = registry.registerOwnDevice(principal, created.team.teamId, "Mac", now);
  const agent = agents.publishAgent(principal, {
    teamId: created.team.teamId, deviceId: device.deviceId, name: "Builder", role: "Managed",
    integrationMode: "managed", capabilities: {
      supportsHandoff: false, supportsInterrupt: true, supportsResume: false,
      supportsStart: true, supportsStreaming: false
    }, now
  });
  const trigger = messages.createMemberMessage(principal, {
    roomId: room.roomId, content: "Recover this", mentions: [{
      targetType: "agent", targetAgentId: agent.agentId, displayLabel: "Builder / Managed"
    }], now
  });
  const run = runs.createRunsForMessage(principal, trigger.messageId, now)[0];
  assert.ok(run);
  const credential = auth.issueDeviceCredential(device.deviceId, now);
  const delivery = new DeliveryService(
    database, core, runRepository, new BridgeConnectionRegistry(), () => now
  );
  const persistedDelivery = delivery.dispatch(run.runId);
  assert.ok(persistedDelivery);
  const devicePrincipal = auth.authenticateDevice(credential.secret, now);
  delivery.accept(devicePrincipal, run.runId, run.traceId, agent.agentId, 1, now);
  new BridgeRunEventService(core, runRepository).applyStatus(devicePrincipal, {
    runId: run.runId, traceId: run.traceId,
    agentId: agent.agentId, sequence: 2, status: "working"
  }, now);
  new BridgeRunEventService(core, runRepository).applyOutput(devicePrincipal, {
    runId: run.runId, traceId: run.traceId,
    agentId: agent.agentId, sequence: 3, content: "Recoverable "
  }, now);
  database.close();

  database = openDatabase(databasePath);
  try {
    const recoveredCore = new CoreRepository(database);
    const recoveredAuth = new AuthService(database);
    const recoveredRuns = new RunRepository(database);
    const recoveredDelivery = new DeliveryService(
      database, recoveredCore, recoveredRuns, new BridgeConnectionRegistry(), () => now
    );
    assert.equal(recoveredRuns.getRun(run.runId)?.state, "working");
    assert.equal(recoveredRuns.getRun(run.runId)?.lastSequence, 3);
    assert.deepEqual(recoveredRuns.listEvents(run.runId).map((event) => event.sequence), [1, 2, 3]);
    assert.deepEqual(
      recoveredRuns.listEvents(run.runId, 2).map((event) => event.event),
      [{ type: "output", sequence: 3, content: "Recoverable " }]
    );
    assert.equal(
      recoveredDelivery.getByRun(run.runId)?.deliveryAttemptId,
      persistedDelivery.deliveryAttemptId
    );
    new BridgeRunEventService(recoveredCore, recoveredRuns).applyReply(
      recoveredAuth.authenticateDevice(credential.secret, now),
      { runId: run.runId, traceId: run.traceId,
        agentId: agent.agentId, sequence: 4, content: "Recovered." },
      now
    );
    assert.equal(recoveredRuns.getRun(run.runId)?.lastSequence, 4);
  } finally {
    database.close();
  }
});

test("server restart completes a partially routed Agent reply exactly once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-reply-routing-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  let database = openDatabase(databasePath);
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(core, auth);
  const agents = new AgentService(core, auth);
  const messages = new MessageService(core, auth);
  const runRepository = new RunRepository(database);
  const runs = new RunService(core, runRepository, auth);
  const handoffs = new HandoffService(core, runRepository);
  const created = teams.createTeamForUser({
    userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4R0UT",
    userDisplayName: "Alice",
    teamName: "Routing Recovery Team",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "", now, "2026-08-22T11:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "general", now);
  const capabilities = {
    supportsHandoff: true,
    supportsInterrupt: false,
    supportsResume: false,
    supportsStart: false,
    supportsStreaming: false
  };
  const builder = agents.publishAgent(principal, {
    teamId: created.team.teamId, deviceId: null, name: "Builder", role: "Manual",
    integrationMode: "manual", capabilities, now
  });
  const reviewer = agents.publishAgent(principal, {
    teamId: created.team.teamId, deviceId: null, name: "Reviewer", role: "Manual",
    integrationMode: "manual", capabilities, now
  });
  const writer = agents.publishAgent(principal, {
    teamId: created.team.teamId, deviceId: null, name: "Writer", role: "Manual",
    integrationMode: "manual", capabilities, now
  });
  const trigger = messages.createMemberMessage(principal, {
    roomId: room.roomId,
    content: "Build it",
    mentions: [{
      targetType: "agent",
      targetAgentId: builder.agentId,
      displayLabel: "Builder / Manual"
    }],
    now
  });
  const root = runs.createRunsForMessage(principal, trigger.messageId, now)[0];
  assert.ok(root);
  runRepository.applyEvent(root.runId, {
    type: "reply",
    sequence: 1,
    content: "请 @Reviewer 和 @Writer 继续"
  }, now);
  const builderCredential = auth.issueMcpCredential(
    principal, builder.agentId, now, "2026-08-22T11:00:00.000Z"
  );
  handoffs.create(auth.authenticateMcp(builderCredential.secret, now), {
    parentRunId: root.runId,
    targetAgentId: reviewer.agentId,
    instruction: "partially persisted before crash"
  }, now);
  database.close();

  const app = await createServerApp({ databasePath, clock: () => now });
  await app.close();

  database = openDatabase(databasePath);
  try {
    const recoveredRuns = new RunRepository(database);
    const children = recoveredRuns.findByTrigger(trigger.messageId).filter(
      ({ parentRunId }) => parentRunId === root.runId
    );
    assert.deepEqual(
      children.map(({ targetAgentId }) => targetAgentId).sort(),
      [reviewer.agentId, writer.agentId].sort()
    );
    assert.equal(recoveredRuns.listPendingReplyRoutingIntents().length, 0);
  } finally {
    database.close();
  }

  const restarted = await createServerApp({ databasePath, clock: () => now });
  await restarted.close();
  database = openDatabase(databasePath);
  try {
    assert.equal(
      new RunRepository(database).findByTrigger(trigger.messageId).filter(
        ({ parentRunId }) => parentRunId === root.runId
      ).length,
      2
    );
  } finally {
    database.close();
  }
});
