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
import { BridgeRunEventService } from
  "../src/run/bridge-run-event-service.js";
import { CancellationService } from "../src/run/cancellation-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const startedAt = "2026-08-29T08:00:00.000Z";

class CapturingSocket implements BridgeSocket {
  public readonly messages: string[] = [];

  public close(): void {}

  public send(data: string): void {
    this.messages.push(data);
  }
}

interface Fixture {
  agentId: string;
  auth: AuthService;
  core: CoreRepository;
  database: ReturnType<typeof openDatabase>;
  databasePath: string;
  deviceId: string;
  devicePrincipal: ReturnType<AuthService["authenticateDevice"]>;
  principal: ReturnType<AuthService["authenticateWebSession"]>;
  runId: string;
  runs: RunRepository;
  secondDeviceId: string;
  secondDevicePrincipal: ReturnType<AuthService["authenticateDevice"]>;
  traceId: string;
}

async function createWorkingRun(): Promise<Fixture> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "convene-wire-cancellation-")
  );
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(core, auth);
  const devices = new MemberDeviceService(core, auth);
  const agents = new AgentService(core, auth);
  const messages = new MessageService(core, auth);
  const runs = new RunRepository(database);
  const tasks = new AgentTaskRepository(database);
  const runService = new RunService(core, runs, auth, tasks);
  const created = teams.createTeamForUser({
    userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    userDisplayName: "Alice",
    teamName: "Cancellation Team",
    now: startedAt
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    startedAt,
    "2026-08-29T10:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, startedAt);
  const room = teams.createRoom(
    principal,
    created.team.teamId,
    "cancellation",
    startedAt
  );
  const device = devices.registerOwnDevice(
    principal,
    created.team.teamId,
    "Original Device",
    startedAt
  );
  const secondDevice = devices.registerOwnDevice(
    principal,
    created.team.teamId,
    "Replacement Device",
    startedAt
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
    now: startedAt
  });
  const message = messages.createMemberMessage(principal, {
    roomId: room.roomId,
    content: "Exercise durable cancellation",
    mentions: [{
      targetType: "agent",
      targetAgentId: agent.agentId,
      displayLabel: "Builder / Managed Runtime"
    }],
    now: startedAt
  });
  const run = runService.createRunsForMessage(
    principal,
    message.messageId,
    startedAt
  )[0];
  assert.ok(run);
  const delivery = new DeliveryService(
    database,
    core,
    runs,
    new ContextPlanner(database, core, tasks),
    new BridgeConnectionRegistry(),
    () => startedAt
  );
  assert.ok(delivery.dispatch(run.runId));
  const credential = auth.issueDeviceCredential(device.deviceId, startedAt);
  const secondCredential = auth.issueDeviceCredential(
    secondDevice.deviceId,
    startedAt
  );
  const devicePrincipal = auth.authenticateDevice(credential.secret, startedAt);
  const secondDevicePrincipal = auth.authenticateDevice(
    secondCredential.secret,
    startedAt
  );
  delivery.accept(
    devicePrincipal,
    run.runId,
    run.traceId,
    agent.agentId,
    1,
    startedAt
  );
  runs.applyEvent(run.runId, {
    type: "status",
    sequence: 2,
    status: "working"
  }, startedAt);
  return {
    agentId: agent.agentId,
    auth,
    core,
    database,
    databasePath,
    deviceId: device.deviceId,
    devicePrincipal,
    principal,
    runId: run.runId,
    runs,
    secondDeviceId: secondDevice.deviceId,
    secondDevicePrincipal,
    traceId: run.traceId
  };
}

test("a persisted cancellation survives a crash before send and replays on hello", async () => {
  const fixture = await createWorkingRun();
  const messageId = "msg_cancellation_crash_boundary_12345678";
  fixture.runs.requestCancellation({
    runId: fixture.runId,
    messageId,
    requestedByMemberId:
      fixture.runs.getRun(fixture.runId)!.requesterMemberId,
    reason: "Crash boundary",
    now: startedAt,
    ackDeadlineAt: "2026-08-29T08:01:00.000Z"
  });
  assert.equal(fixture.runs.getCancellationIntent(fixture.runId)?.sendCount, 0);
  fixture.database.close();

  const restartedDatabase = openDatabase(fixture.databasePath);
  try {
    const restartedRuns = new RunRepository(restartedDatabase);
    const restartedConnections = new BridgeConnectionRegistry();
    const restartedService = new CancellationService(
      new CoreRepository(restartedDatabase),
      restartedRuns,
      new AuthService(restartedDatabase),
      restartedConnections,
      () => "2026-08-29T08:00:01.000Z",
      { retryIntervalMilliseconds: 1_000 }
    );
    assert.deepEqual(restartedService.recover(), {
      expiredRunIds: [],
      sentRunIds: []
    });
    const socket = new CapturingSocket();
    restartedConnections.register(fixture.deviceId, 2, socket);
    assert.deepEqual(
      restartedService.resendForDevice(fixture.deviceId),
      [fixture.runId]
    );
    assert.equal(socket.messages.length, 1);
    const replay = JSON.parse(socket.messages[0] ?? "{}") as {
      messageId?: string;
      timestamp?: string;
      type?: string;
      payload?: { reason?: string; runId?: string };
    };
    assert.deepEqual(replay, {
      protocolVersion: "1.0",
      messageId,
      timestamp: startedAt,
      type: "run.cancel_requested",
      payload: {
        runId: fixture.runId,
        traceId: fixture.traceId,
        agentId: fixture.agentId,
        reason: "Crash boundary"
      }
    });
    assert.equal(restartedRuns.getRun(fixture.runId)?.state, "working");
    assert.deepEqual(
      {
        state: restartedRuns.getCancellationIntent(fixture.runId)?.state,
        sendCount: restartedRuns.getCancellationIntent(fixture.runId)?.sendCount
      },
      { state: "pending", sendCount: 1 }
    );
  } finally {
    restartedDatabase.close();
  }
});

test("socket writes and duplicate requests retain one frozen cancellation intent", async () => {
  const fixture = await createWorkingRun();
  try {
    const connections = new BridgeConnectionRegistry();
    const socket = new CapturingSocket();
    connections.register(fixture.deviceId, 1, socket);
    const service = new CancellationService(
      fixture.core,
      fixture.runs,
      fixture.auth,
      connections,
      () => "2026-08-29T08:00:10.000Z"
    );
    const first = service.cancel(fixture.principal, fixture.runId, "First reason");
    const frozen = fixture.runs.getCancellationIntent(fixture.runId);
    assert.equal(first.state, "working");
    assert.deepEqual(
      { state: frozen?.state, sendCount: frozen?.sendCount },
      { state: "pending", sendCount: 1 }
    );
    assert.equal(socket.messages.length, 1);

    const duplicate = service.cancel(
      fixture.principal,
      fixture.runId,
      "A later request must not rewrite the intent"
    );
    const afterDuplicate = fixture.runs.getCancellationIntent(fixture.runId);
    assert.equal(duplicate.state, "working");
    assert.equal(socket.messages.length, 2);
    assert.equal(socket.messages[1], socket.messages[0]);
    assert.deepEqual(
      {
        messageId: afterDuplicate?.messageId,
        deviceId: afterDuplicate?.deviceId,
        reason: afterDuplicate?.reason,
        ackDeadlineAt: afterDuplicate?.ackDeadlineAt,
        sendCount: afterDuplicate?.sendCount
      },
      {
        messageId: frozen?.messageId,
        deviceId: fixture.deviceId,
        reason: "First reason",
        ackDeadlineAt: frozen?.ackDeadlineAt,
        sendCount: 2
      }
    );
  } finally {
    fixture.database.close();
  }
});

test("cancellation reasons truncate by Unicode code point without splitting astral text", async () => {
  const fixture = await createWorkingRun();
  try {
    const connections = new BridgeConnectionRegistry();
    const socket = new CapturingSocket();
    connections.register(fixture.deviceId, 1, socket);
    const service = new CancellationService(
      fixture.core,
      fixture.runs,
      fixture.auth,
      connections,
      () => "2026-08-29T08:00:10.000Z"
    );
    service.cancel(fixture.principal, fixture.runId, `  ${"😀".repeat(513)}  `);
    const reason = fixture.runs.getCancellationIntent(fixture.runId)?.reason;
    assert.equal(reason, "😀".repeat(512));
    assert.equal([...(reason ?? "")].length, 512);
    assert.equal(reason?.endsWith("\ud83d"), false);
    const message = JSON.parse(socket.messages[0] ?? "{}") as {
      payload?: { reason?: string };
    };
    assert.equal(message.payload?.reason, "😀".repeat(512));
  } finally {
    fixture.database.close();
  }
});

test("only the frozen Device can acknowledge a terminal status and resolution stops replay", async () => {
  const fixture = await createWorkingRun();
  try {
    const connections = new BridgeConnectionRegistry();
    const originalSocket = new CapturingSocket();
    connections.register(fixture.deviceId, 1, originalSocket);
    const service = new CancellationService(
      fixture.core,
      fixture.runs,
      fixture.auth,
      connections,
      () => "2026-08-29T08:00:10.000Z",
      { retryIntervalMilliseconds: 1_000 }
    );
    service.cancel(fixture.principal, fixture.runId, "Stop work");
    fixture.database.prepare(`
      UPDATE agents SET device_id = ?, updated_at = ? WHERE agent_id = ?
    `).run(
      fixture.secondDeviceId,
      "2026-08-29T08:00:11.000Z",
      fixture.agentId
    );
    const events = new BridgeRunEventService(fixture.core, fixture.runs);
    assert.throws(() => events.applyStatus(fixture.secondDevicePrincipal, {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId: fixture.agentId,
      sequence: 3,
      status: "canceled"
    }, "2026-08-29T08:00:12.000Z"), /identity mismatch/u);
    assert.equal(fixture.runs.getCancellationIntent(fixture.runId)?.state, "pending");

    assert.equal(events.applyStatus(fixture.devicePrincipal, {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId: fixture.agentId,
      sequence: 3,
      status: "canceled"
    }, "2026-08-29T08:00:13.000Z").run.state, "canceled");
    assert.deepEqual(
      {
        state: fixture.runs.getCancellationIntent(fixture.runId)?.state,
        resolvedAt: fixture.runs.getCancellationIntent(fixture.runId)?.resolvedAt,
        terminalStatus:
          fixture.runs.getCancellationIntent(fixture.runId)?.terminalStatus
      },
      {
        state: "resolved",
        resolvedAt: "2026-08-29T08:00:13.000Z",
        terminalStatus: "canceled"
      }
    );
    const messagesBeforeSweep = originalSocket.messages.length;
    assert.deepEqual(service.sweep(true), {
      expiredRunIds: [],
      sentRunIds: []
    });
    assert.equal(originalSocket.messages.length, messagesBeforeSweep);
  } finally {
    fixture.database.close();
  }
});

test("an unacknowledged cancellation reaches outcome_unknown at its deadline", async () => {
  const fixture = await createWorkingRun();
  try {
    let currentTime = "2026-08-29T08:00:10.000Z";
    const service = new CancellationService(
      fixture.core,
      fixture.runs,
      fixture.auth,
      new BridgeConnectionRegistry(),
      () => currentTime,
      { ackTimeoutMilliseconds: 5_000, retryIntervalMilliseconds: 1_000 }
    );
    assert.equal(
      service.cancel(fixture.principal, fixture.runId, "Stop offline work").state,
      "working"
    );
    currentTime = "2026-08-29T08:00:15.000Z";
    assert.deepEqual(service.sweep(), {
      expiredRunIds: [fixture.runId],
      sentRunIds: []
    });
    assert.equal(fixture.runs.getRun(fixture.runId)?.state, "outcome_unknown");
    assert.deepEqual(
      {
        state: fixture.runs.getCancellationIntent(fixture.runId)?.state,
        terminalStatus:
          fixture.runs.getCancellationIntent(fixture.runId)?.terminalStatus
      },
      { state: "resolved", terminalStatus: "outcome_unknown" }
    );
    const terminal = fixture.runs.listEvents(fixture.runId).at(-1)?.event;
    assert.equal(terminal?.type, "status");
    assert.deepEqual(terminal?.type === "status" ? terminal.error : undefined, {
      code: "RUN_CANCEL_ACK_TIMEOUT",
      message:
        "The managed Runtime did not confirm a terminal outcome before the cancellation deadline.",
      retryable: false
    });
  } finally {
    fixture.database.close();
  }
});

test("terminal Run state and cancellation resolution roll back together", async () => {
  const fixture = await createWorkingRun();
  try {
    const service = new CancellationService(
      fixture.core,
      fixture.runs,
      fixture.auth,
      new BridgeConnectionRegistry(),
      () => "2026-08-29T08:00:10.000Z"
    );
    service.cancel(fixture.principal, fixture.runId, "Atomic resolution");
    fixture.database.exec(`
      CREATE TEMP TRIGGER fail_cancellation_resolution
      BEFORE UPDATE OF state ON run_cancellation_intents
      WHEN NEW.state = 'resolved'
      BEGIN
        SELECT RAISE(ABORT, 'injected cancellation resolution failure');
      END;
    `);
    const events = new BridgeRunEventService(fixture.core, fixture.runs);
    assert.throws(() => events.applyStatus(fixture.devicePrincipal, {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId: fixture.agentId,
      sequence: 3,
      status: "canceled"
    }, "2026-08-29T08:00:11.000Z"), /injected cancellation resolution failure/u);
    assert.deepEqual(
      {
        state: fixture.runs.getRun(fixture.runId)?.state,
        lastSequence: fixture.runs.getRun(fixture.runId)?.lastSequence,
        intentState: fixture.runs.getCancellationIntent(fixture.runId)?.state,
        eventCount: fixture.runs.listEvents(fixture.runId).length
      },
      { state: "working", lastSequence: 2, intentState: "pending", eventCount: 2 }
    );
  } finally {
    fixture.database.close();
  }
});
