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
import { DeviceRevocationService } from
  "../src/registry/device-revocation-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-28T10:00:00.000Z";

class CapturingSocket implements BridgeSocket {
  public readonly messages: unknown[] = [];
  public closeCode: number | undefined;
  public closeReason: string | undefined;

  public close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
  }

  public send(data: string): void {
    this.messages.push(JSON.parse(data) as unknown);
  }
}

async function createFixture(): Promise<{
  databasePath: string;
  database: ReturnType<typeof openDatabase>;
  core: CoreRepository;
  auth: AuthService;
  registry: MemberDeviceService;
  principal: ReturnType<AuthService["authenticateWebSession"]>;
  deviceId: string;
  deviceCredential: ReturnType<AuthService["authenticateDevice"]>;
  teamId: string;
  agentId: string;
  pendingRunId: string;
  acceptedRunId: string;
  connections: BridgeConnectionRegistry;
  socket: CapturingSocket;
  runs: RunRepository;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-revoke-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(core, auth);
  const registry = new MemberDeviceService(core, auth);
  const agents = new AgentService(core, auth);
  const messages = new MessageService(core, auth);
  const runs = new RunRepository(database);
  const tasks = new AgentTaskRepository(database);
  const runService = new RunService(core, runs, auth, tasks);
  const created = teams.createTeamForUser({
    userId: "user_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    userDisplayName: "Alice",
    teamName: "Revocation Team",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-28T12:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "general", now);
  const device = registry.registerOwnDevice(
    principal,
    created.team.teamId,
    "Alice Mac",
    now
  );
  const credential = auth.issueDeviceCredential(device.deviceId, now);
  const deviceCredential = auth.authenticateDevice(credential.secret, now);
  const agent = agents.publishAgent(principal, {
    teamId: created.team.teamId,
    deviceId: device.deviceId,
    name: "Builder",
    role: "Managed Runtime",
    integrationMode: "managed",
    runtimeScopeId: "a".repeat(64),
    capabilities: {
      supportsHandoff: false,
      supportsInterrupt: true,
      supportsResume: true,
      supportsStart: true,
      supportsStreaming: true,
      supportsRoomContextCoverage: true
    },
    now
  });
  const createRun = (content: string) => {
    const message = messages.createMemberMessage(principal, {
      roomId: room.roomId,
      content,
      mentions: [{
        targetType: "agent",
        targetAgentId: agent.agentId,
        displayLabel: "Builder / Managed Runtime"
      }],
      now
    });
    const run = runService.createRunsForMessage(
      principal,
      message.messageId,
      now
    )[0];
    assert.ok(run);
    return run;
  };
  const acceptedRun = createRun("Start accepted work");
  const pendingRun = createRun("Keep this delivery pending");
  const connections = new BridgeConnectionRegistry();
  const socket = new CapturingSocket();
  connections.register(device.deviceId, 1, socket);
  const delivery = new DeliveryService(
    database,
    core,
    runs,
    new ContextPlanner(database, core, tasks),
    connections,
    () => now
  );
  delivery.dispatch(acceptedRun.runId);
  delivery.accept(
    deviceCredential,
    acceptedRun.runId,
    acceptedRun.traceId,
    agent.agentId,
    1,
    now
  );
  delivery.dispatch(pendingRun.runId);
  return {
    databasePath,
    database,
    core,
    auth,
    registry,
    principal,
    deviceId: device.deviceId,
    deviceCredential,
    teamId: created.team.teamId,
    agentId: agent.agentId,
    pendingRunId: pendingRun.runId,
    acceptedRunId: acceptedRun.runId,
    connections,
    socket,
    runs
  };
}

test("Device revocation distinguishes pending from accepted Run outcomes", async () => {
  const fixture = await createFixture();
  try {
    const service = new DeviceRevocationService(
      fixture.registry,
      fixture.core,
      fixture.runs,
      fixture.connections,
      () => now
    );
    const revoked = service.revoke(
      fixture.principal,
      fixture.teamId,
      fixture.deviceId
    );

    assert.equal(revoked.status, "revoked");
    assert.equal(fixture.core.getAgent(fixture.agentId)?.enabled, false);
    assert.equal(fixture.core.getAgent(fixture.agentId)?.presence, "offline");
    assert.equal(fixture.connections.activeCount(), 0);
    assert.equal(fixture.socket.closeCode, 4_004);
    assert.equal(fixture.socket.closeReason, "Device revoked");
    const cancellation = fixture.socket.messages.find((message) =>
      (message as { type?: string }).type === "run.cancel_requested"
    ) as { payload?: { runId?: string } } | undefined;
    assert.equal(cancellation?.payload?.runId, fixture.acceptedRunId);

    assert.equal(fixture.runs.getRun(fixture.pendingRunId)?.state, "failed");
    assert.equal(
      fixture.runs.listEvents(fixture.pendingRunId).at(-1)?.event.type,
      "status"
    );
    const pendingTerminal = fixture.runs.listEvents(fixture.pendingRunId).at(-1)
      ?.event;
    assert.equal(
      pendingTerminal?.type === "status" ? pendingTerminal.error?.code : undefined,
      "RUN_DEVICE_REVOKED"
    );
    assert.equal(
      fixture.runs.getRun(fixture.acceptedRunId)?.state,
      "outcome_unknown"
    );
    const acceptedTerminal = fixture.runs.listEvents(fixture.acceptedRunId).at(-1)
      ?.event;
    assert.equal(
      acceptedTerminal?.type === "status" ? acceptedTerminal.error?.code : undefined,
      "RUN_DEVICE_REVOKED_OUTCOME_UNKNOWN"
    );

    const eventCount = fixture.runs.listEvents(fixture.acceptedRunId).length;
    service.revoke(fixture.principal, fixture.teamId, fixture.deviceId);
    assert.equal(fixture.runs.listEvents(fixture.acceptedRunId).length, eventCount);
  } finally {
    fixture.database.close();
  }
});

test("startup recovery closes Runs left behind after durable Device revoke", async () => {
  const fixture = await createFixture();
  fixture.registry.revokeDevice(
    fixture.principal,
    fixture.teamId,
    fixture.deviceId,
    now
  );
  fixture.database.close();

  const database = openDatabase(fixture.databasePath);
  try {
    const core = new CoreRepository(database);
    const runs = new RunRepository(database);
    const service = new DeviceRevocationService(
      new MemberDeviceService(core, new AuthService(database)),
      core,
      runs,
      new BridgeConnectionRegistry(),
      () => now
    );
    service.recover();

    assert.equal(runs.getRun(fixture.pendingRunId)?.state, "failed");
    assert.equal(runs.getRun(fixture.acceptedRunId)?.state, "outcome_unknown");
    assert.deepEqual(runs.listRevokedDeviceIdsWithActiveRuns(), []);
  } finally {
    database.close();
  }
});
