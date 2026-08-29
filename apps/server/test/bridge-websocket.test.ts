import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import Database from "better-sqlite3";

import { createServerApp } from "../src/app.js";
import { isBridgeTraceId } from "../src/http/bridge-socket-routes.js";

const now = "2026-08-23T12:00:00.000Z";
const agentId = "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6";

interface BridgeWireMessage {
  messageId?: string;
  type: string;
  payload: Record<string, unknown>;
}

type BridgeSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

interface BridgeFixture {
  app: Awaited<ReturnType<typeof createServerApp>>;
  socket: BridgeSocket;
  authorization: { authorization: string };
  databasePath: string;
  deviceId: string;
  deviceToken: string;
  ownerMemberId: string;
  teamId: string;
  roomId: string;
  runId: string;
  traceId: string;
}

interface CapturedLog extends Record<string, unknown> {
  level: string;
}

function capturingLogger(entries: CapturedLog[]): FastifyBaseLogger {
  let logger: FastifyBaseLogger;
  const capture = (level: string) => (value?: unknown): void => {
    entries.push({
      level,
      ...(value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {})
    });
  };
  logger = {
    level: "trace",
    fatal: capture("fatal"),
    error: capture("error"),
    warn: capture("warn"),
    info: capture("info"),
    debug: capture("debug"),
    trace: capture("trace"),
    silent: capture("silent"),
    child: () => logger
  } as unknown as FastifyBaseLogger;
  return logger;
}

function envelope(type: string, payload: Record<string, unknown>): object {
  return {
    protocolVersion: "1.0",
    messageId: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
    timestamp: now,
    type,
    payload
  };
}

function send(socket: BridgeSocket, value: object): void {
  socket.send(JSON.stringify(value));
}

async function sendAndFlush(socket: BridgeSocket, value: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(value), (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function nextMessage(socket: BridgeSocket): Promise<BridgeWireMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (source: { toString(): string }): void => {
      socket.off("close", onClose);
      resolve(JSON.parse(source.toString()) as BridgeWireMessage);
    };
    const onClose = (code: number, reason: Buffer): void => {
      socket.off("message", onMessage);
      reject(new Error(`Bridge closed before message: ${code} ${reason.toString()}`));
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

function nextClose(socket: BridgeSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString() });
    });
  });
}

async function waitFor(
  read: () => Promise<boolean>,
  timeoutMilliseconds = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Bridge state");
}

async function createFixture(
  loggerInstance?: FastifyBaseLogger,
  supportsAgentProvisioning = true,
  agentLabels: { name?: string; role?: string } = {}
): Promise<BridgeFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-bridge-ws-"));
  const databasePath = path.join(directory, "server.sqlite");
  const app = await createServerApp({
    databasePath,
    clock: () => now,
    ...(loggerInstance ? { loggerInstance } : {})
  });
  await app.ready();
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/bootstrap",
    payload: { displayName: "Alice" }
  });
  const authorization = {
    authorization: `Bearer ${bootstrap.json().session.token as string}`
  };
  const team = await app.inject({
    method: "POST",
    url: "/api/teams",
    headers: authorization,
    payload: { name: "Bridge Protocol" }
  });
  const teamId = team.json().team.teamId as string;
  const room = await app.inject({
    method: "POST",
    url: `/api/teams/${teamId}/rooms`,
    headers: authorization,
    payload: { name: "protocol" }
  });
  const roomId = room.json().roomId as string;
  const invite = await app.inject({
    method: "POST",
    url: `/api/teams/${teamId}/bridge-invites`,
    headers: authorization,
    payload: { deviceName: "Protocol Bridge" }
  });
  const pairing = await app.inject({
    method: "POST",
    url: "/api/bridge/pair",
    payload: {
      code: invite.json().code as string,
      deviceName: "Protocol Bridge"
    }
  });
  const paired = pairing.json() as {
    device: { deviceId: string; ownerMemberId: string; teamId: string };
    credential: { token: string };
  };
  const socket = await app.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${paired.credential.token}`,
      host: "127.0.0.1"
    }
  });
  send(socket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-qa030.1",
    connectionEpoch: 1,
    deviceId: paired.device.deviceId,
    supportsAgentProvisioning,
    supportedProtocolVersions: ["1.0"]
  }));
  send(socket, envelope("agent.publish", {
    agentId,
    capabilities: {
      invocationMode: "managed",
      supportsHandoff: false,
      supportsInterrupt: true,
      supportsResume: false,
      supportsStart: true,
      supportsStreaming: false
    },
    deviceId: paired.device.deviceId,
    name: agentLabels.name ?? "Protocol Agent",
    ownerMemberId: paired.device.ownerMemberId,
    role: agentLabels.role ?? "Protocol Test",
    runtimePolicy: { filesystemAccess: "read-only" },
    workspaceAlias: "Protocol Workspace",
    workspaceRef: `workspace_${"a".repeat(64)}`,
    workspaceGeneration: "b".repeat(64),
    teamId: paired.device.teamId
  }));
  await waitFor(async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/agents`,
      headers: authorization
    });
    return response.json().some((agent: {
      agentId: string;
      presence: string;
      runtimePolicy?: { filesystemAccess?: string };
      workspaceAlias?: string;
    }) =>
      agent.agentId === agentId &&
      agent.presence === "ready" &&
      agent.workspaceAlias === "Protocol Workspace" &&
      agent.runtimePolicy?.filesystemAccess === "read-only"
    );
  });
  const requestedMessage = nextMessage(socket);
  const routed = await app.inject({
    method: "POST",
    url: `/api/rooms/${roomId}/messages`,
    headers: authorization,
    payload: { content: "Validate strict Bridge traces", mentionAgentId: agentId }
  });
  assert.equal(routed.statusCode, 200, routed.body);
  const requested = await requestedMessage;
  assert.equal(requested.type, "run.requested");
  return {
    app,
    socket,
    authorization,
    databasePath,
    deviceId: paired.device.deviceId,
    deviceToken: paired.credential.token,
    ownerMemberId: paired.device.ownerMemberId,
    teamId: paired.device.teamId,
    roomId,
    runId: requested.payload.runId as string,
    traceId: requested.payload.traceId as string
  };
}

async function closeFixture(fixture: BridgeFixture): Promise<void> {
  for (const serverSocket of fixture.app.websocketServer.clients) {
    serverSocket.terminate();
  }
  if (fixture.socket.readyState < 2) {
    const closed = nextClose(fixture.socket);
    fixture.socket.terminate();
    await closed;
  }
  await new Promise((resolve) => setImmediate(resolve));
  await fixture.app.close();
}

async function runState(fixture: BridgeFixture, expected: string): Promise<boolean> {
  const response = await fixture.app.inject({
    method: "GET",
    url: `/api/rooms/${fixture.roomId}/runs`,
    headers: fixture.authorization
  });
  return response.json().some((run: { runId: string; state: string }) =>
    run.runId === fixture.runId && run.state === expected
  );
}

async function acceptRun(fixture: BridgeFixture): Promise<void> {
  let rejectClosed: ((reason?: unknown) => void) | undefined;
  const closed = new Promise<void>((_resolve, reject) => {
    rejectClosed = reject;
  });
  const onClose = (code: number, reason: Buffer): void => {
    rejectClosed?.(new Error(
      `Bridge closed before Run acceptance: ${code} ${reason.toString()}`
    ));
  };
  fixture.socket.once("close", onClose);
  await sendAndFlush(fixture.socket, envelope("run.accepted", {
    runId: fixture.runId,
    traceId: fixture.traceId,
    agentId,
    sequence: 1
  }));
  try {
    await Promise.race([
      waitFor(() => runState(fixture, "delivered")),
      closed
    ]);
  } finally {
    fixture.socket.off("close", onClose);
  }
}

test("Bridge trace validation accepts every contract-valid base64url prefix", () => {
  assert.equal(isBridgeTraceId("trace_-1K4Z6J7Y8N9P0Q1R2S3T4V5W6"), true);
  assert.equal(isBridgeTraceId("trace__1K4Z6J7Y8N9P0Q1R2S3T4V5W6"), true);
  assert.equal(isBridgeTraceId("trace_/1K4Z6J7Y8N9P0Q1R2S3T4V5W6"), false);
  assert.equal(isBridgeTraceId("trace_short"), false);
});

test("one committed Bridge Run event advances the Team cursor once", async () => {
  const fixture = await createFixture();
  try {
    const before = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/changes?after=0`,
      headers: fixture.authorization
    });
    assert.equal(before.statusCode, 200);
    const cursor = before.json().cursor as number;

    await acceptRun(fixture);

    const changed = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/changes?after=${cursor}`,
      headers: fixture.authorization
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().cursor, cursor + 1);
    assert.deepEqual(changed.json().runRoomIds, [fixture.roomId]);
  } finally {
    await closeFixture(fixture);
  }
});

test("an unaccepted Run resolves only from the frozen Bridge cancellation ACK", async () => {
  const fixture = await createFixture();
  try {
    const cancellationMessage = nextMessage(fixture.socket);
    const canceled = await fixture.app.inject({
      method: "POST",
      url: `/api/runs/${fixture.runId}/cancel`,
      headers: fixture.authorization,
      payload: { reason: "Cancel while Bridge is preparing" }
    });
    assert.equal(canceled.statusCode, 200);
    assert.equal(canceled.json().state, "queued");

    const cancellation = await cancellationMessage;
    assert.equal(cancellation.type, "run.cancel_requested");
    assert.deepEqual(cancellation.payload, {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      reason: "Cancel while Bridge is preparing"
    });

    const pendingDatabase = new Database(fixture.databasePath, {
      readonly: true
    });
    try {
      assert.deepEqual(pendingDatabase.prepare(`
        SELECT d.state AS delivery_state, d.send_count,
          c.state AS cancellation_state, c.device_id
        FROM run_deliveries d
        JOIN run_cancellation_intents c ON c.run_id = d.run_id
        WHERE d.run_id = ?
      `).get(fixture.runId), {
        delivery_state: "pending",
        send_count: 1,
        cancellation_state: "pending",
        device_id: fixture.deviceId
      });
    } finally {
      pendingDatabase.close();
    }

    await sendAndFlush(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 1,
      status: "canceled"
    }));
    await waitFor(() => runState(fixture, "canceled"));

    const resolvedDatabase = new Database(fixture.databasePath, {
      readonly: true
    });
    try {
      assert.deepEqual(resolvedDatabase.prepare(`
        SELECT state, terminal_status FROM run_cancellation_intents
        WHERE run_id = ?
      `).get(fixture.runId), {
        state: "resolved",
        terminal_status: "canceled"
      });
    } finally {
      resolvedDatabase.close();
    }
  } finally {
    await closeFixture(fixture);
  }
});

test("authenticated hello records the current Bridge version without replacing pairing identity", async () => {
  const fixture = await createFixture();
  try {
    const readObservation = (): {
      connection_epoch: number;
      bridge_version: string;
    } => {
      const database = new Database(fixture.databasePath, { readonly: true });
      try {
        return database.prepare(`
          SELECT connection_epoch, bridge_version
          FROM device_bridge_observations WHERE device_id = ?
        `).get(fixture.deviceId) as {
          connection_epoch: number;
          bridge_version: string;
        };
      } finally {
        database.close();
      }
    };
    assert.deepEqual(readObservation(), {
      connection_epoch: 1,
      bridge_version: "0.4.0-qa030.1"
    });

    await sendAndFlush(fixture.socket, envelope("bridge.heartbeat", {
      connectionEpoch: 1,
      deviceId: fixture.deviceId
    }));
    assert.deepEqual(readObservation(), {
      connection_epoch: 1,
      bridge_version: "0.4.0-qa030.1"
    });

    const invalidSocket = await fixture.app.injectWS("/ws/bridge", {
      headers: {
        authorization: `Bearer ${fixture.deviceToken}`,
        host: "127.0.0.1"
      }
    });
    const closed = nextClose(invalidSocket);
    send(invalidSocket, envelope("bridge.hello", {
      bridgeVersion: "not-a-version",
      connectionEpoch: 2,
      deviceId: fixture.deviceId,
      supportedProtocolVersions: ["1.0"]
    }));
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: invalid_envelope"
    });
    assert.deepEqual(readObservation(), {
      connection_epoch: 1,
      bridge_version: "0.4.0-qa030.1"
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("declared Agent status frames update the owned Agent without heartbeat drift", async () => {
  const fixture = await createFixture();
  const readPresence = async (): Promise<string | undefined> => {
    const response = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/agents`,
      headers: fixture.authorization
    });
    return (response.json() as Array<{ agentId: string; presence: string }>)
      .find((agent) => agent.agentId === agentId)?.presence;
  };
  try {
    send(fixture.socket, envelope("agent.status", {
      agentId,
      deviceId: fixture.deviceId,
      connectionEpoch: 1,
      status: "busy"
    }));
    await waitFor(async () => (await readPresence()) === "busy");

    send(fixture.socket, envelope("bridge.heartbeat", {
      connectionEpoch: 1,
      deviceId: fixture.deviceId
    }));
    await waitFor(async () => (await readPresence()) === "busy");

    send(fixture.socket, envelope("agent.status", {
      agentId,
      deviceId: fixture.deviceId,
      connectionEpoch: 1,
      status: "ready"
    }));
    await waitFor(async () => (await readPresence()) === "ready");
  } finally {
    await closeFixture(fixture);
  }
});

test("Agent publication counts astral labels as Unicode code points", async () => {
  const name = "😀".repeat(80);
  const role = "🛠".repeat(80);
  const fixture = await createFixture(undefined, true, { name, role });
  try {
    const response = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/agents`,
      headers: fixture.authorization
    });
    const published = (response.json() as Array<{
      agentId: string;
      name: string;
      role: string;
    }>).find((agent) => agent.agentId === agentId);
    assert.equal(published?.name, name);
    assert.equal(published?.role, role);
  } finally {
    await closeFixture(fixture);
  }
});

test("a restarted Central replays a durable cancellation on the frozen Device hello", async () => {
  const fixture = await createFixture();
  let restarted: Awaited<ReturnType<typeof createServerApp>> | undefined;
  let restartedSocket: BridgeSocket | undefined;
  try {
    await acceptRun(fixture);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "working"
    }));
    await waitFor(() => runState(fixture, "working"));
    const closed = nextClose(fixture.socket);
    fixture.socket.terminate();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));

    const canceled = await fixture.app.inject({
      method: "POST",
      url: `/api/runs/${fixture.runId}/cancel`,
      headers: fixture.authorization,
      payload: { reason: "Restart recovery" }
    });
    assert.equal(canceled.statusCode, 200);
    assert.equal(canceled.json().state, "working");
    const database = new Database(fixture.databasePath, { readonly: true });
    const frozen = database.prepare(`
      SELECT message_id, device_id, state, send_count
      FROM run_cancellation_intents WHERE run_id = ?
    `).get(fixture.runId) as {
      message_id: string;
      device_id: string;
      state: string;
      send_count: number;
    };
    database.close();
    assert.deepEqual(
      {
        deviceId: frozen.device_id,
        state: frozen.state,
        sendCount: frozen.send_count
      },
      { deviceId: fixture.deviceId, state: "pending", sendCount: 0 }
    );

    await fixture.app.close();
    restarted = await createServerApp({
      databasePath: fixture.databasePath,
      clock: () => now
    });
    await restarted.ready();
    restartedSocket = await restarted.injectWS("/ws/bridge", {
      headers: {
        authorization: `Bearer ${fixture.deviceToken}`,
        host: "127.0.0.1"
      }
    });
    const replayed = nextMessage(restartedSocket);
    send(restartedSocket, envelope("bridge.hello", {
      bridgeVersion: "v0.4.0-qa030.1",
      connectionEpoch: 2,
      deviceId: fixture.deviceId,
      supportsAgentProvisioning: true,
      supportedProtocolVersions: ["1.0"]
    }));
    const replay = await replayed;
    assert.equal(replay.messageId, frozen.message_id);
    assert.equal(replay.type, "run.cancel_requested");
    assert.deepEqual(replay.payload, {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      reason: "Restart recovery"
    });
    const replayDatabase = new Database(fixture.databasePath, { readonly: true });
    try {
      const intent = replayDatabase.prepare(`
        SELECT message_id, state, send_count
        FROM run_cancellation_intents WHERE run_id = ?
      `).get(fixture.runId) as {
        message_id: string;
        state: string;
        send_count: number;
      };
      assert.deepEqual(intent, {
        message_id: frozen.message_id,
        state: "pending",
        send_count: 1
      });
    } finally {
      replayDatabase.close();
    }
    send(restartedSocket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 3,
      status: "canceled"
    }));
    await waitFor(async () => {
      const response = await restarted?.inject({
        method: "GET",
        url: `/api/rooms/${fixture.roomId}/runs`,
        headers: fixture.authorization
      });
      return response?.json().some((run: { runId: string; state: string }) =>
        run.runId === fixture.runId && run.state === "canceled"
      ) === true;
    });
    const resolvedDatabase = new Database(
      fixture.databasePath,
      { readonly: true }
    );
    try {
      assert.deepEqual(resolvedDatabase.prepare(`
        SELECT state, terminal_status FROM run_cancellation_intents
        WHERE run_id = ?
      `).get(fixture.runId), {
        state: "resolved",
        terminal_status: "canceled"
      });
    } finally {
      resolvedDatabase.close();
    }
  } finally {
    if (restartedSocket && restartedSocket.readyState < 2) {
      restartedSocket.terminate();
    }
    if (restarted) {
      await new Promise((resolve) => setImmediate(resolve));
      await restarted.close();
    } else if (fixture.app.server.listening) {
      await closeFixture(fixture);
    }
  }
});

test("central provisioning keeps the code transient and converges after Bridge publication", async () => {
  const fixture = await createFixture();
  try {
    const requestId = "agentprov_websocket_12345678";
    const deliveredMessage = nextMessage(fixture.socket);
    const submitted = await fixture.app.inject({
      method: "POST",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization,
      payload: {
        requestId,
        deviceId: fixture.deviceId,
        templateAgentId: agentId,
        name: "Provisioned Reviewer",
        role: "Review",
        managementCode: "87654321"
      }
    });
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.json().status, "delivered");
    const provisionedAgentId = submitted.json().agentId as string;

    const delivered = await deliveredMessage;
    assert.equal(delivered.type, "agent.provision.requested");
    assert.deepEqual(delivered.payload, {
      requestId,
      deviceId: fixture.deviceId,
      templateAgentId: agentId,
      agentId: provisionedAgentId,
      name: "Provisioned Reviewer",
      role: "Review",
      managementCode: "87654321"
    });

    const retriedMessage = nextMessage(fixture.socket);
    const retried = await fixture.app.inject({
      method: "POST",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization,
      payload: {
        requestId,
        deviceId: fixture.deviceId,
        templateAgentId: agentId,
        name: "Provisioned Reviewer",
        role: "Review",
        managementCode: "87654321"
      }
    });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().agentId, provisionedAgentId);
    assert.equal((await retriedMessage).payload.agentId, provisionedAgentId);

    const listed = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(JSON.stringify(listed.json()).includes("87654321"), false);
    assert.equal(JSON.stringify(listed.json()).includes("managementCode"), false);

    await sendAndFlush(fixture.socket, envelope("agent.provision.result", {
      requestId,
      deviceId: fixture.deviceId,
      templateAgentId: agentId,
      agentId: provisionedAgentId,
      status: "accepted"
    }));
    await waitFor(async () => {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
        headers: fixture.authorization
      });
      return response.json()[0]?.status === "accepted";
    });

    await sendAndFlush(fixture.socket, envelope("agent.publish", {
      agentId: provisionedAgentId,
      capabilities: {
        invocationMode: "managed",
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: false
      },
      deviceId: fixture.deviceId,
      name: "Provisioned Reviewer",
      ownerMemberId: fixture.ownerMemberId,
      role: "Review",
      teamId: fixture.teamId
    }));
    await waitFor(async () => {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
        headers: fixture.authorization
      });
      return response.json()[0]?.status === "ready";
    });

    const agents = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/agents`,
      headers: fixture.authorization
    });
    assert.equal(agents.json().some((agent: { agentId: string }) =>
      agent.agentId === provisionedAgentId
    ), true);

    const closed = nextClose(fixture.socket);
    fixture.socket.terminate();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    const offline = await fixture.app.inject({
      method: "POST",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization,
      payload: {
        requestId: "agentprov_offline_12345678",
        deviceId: fixture.deviceId,
        templateAgentId: agentId,
        name: "Offline Agent",
        role: "Deferred",
        managementCode: "87654321"
      }
    });
    assert.equal(offline.statusCode, 409);
    const pending = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization
    });
    assert.equal(pending.json().find((request: { requestId: string }) =>
      request.requestId === "agentprov_offline_12345678"
    )?.status, "pending");
  } finally {
    await closeFixture(fixture);
  }
});

test("reserved Agent publication recovers a lost acceptance result atomically", async () => {
  const fixture = await createFixture();
  try {
    const requestId = "agentprov_lost_result_12345678";
    const deliveredMessage = nextMessage(fixture.socket);
    const submitted = await fixture.app.inject({
      method: "POST",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization,
      payload: {
        requestId,
        deviceId: fixture.deviceId,
        templateAgentId: agentId,
        name: "Recovered Publisher",
        role: "Recovery",
        managementCode: "87654321"
      }
    });
    assert.equal(submitted.statusCode, 200);
    const provisionedAgentId = submitted.json().agentId as string;
    await deliveredMessage;

    await sendAndFlush(fixture.socket, envelope("agent.publish", {
      agentId: provisionedAgentId,
      capabilities: {
        invocationMode: "managed",
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: false
      },
      deviceId: fixture.deviceId,
      name: "Recovered Publisher",
      ownerMemberId: fixture.ownerMemberId,
      role: "Recovery",
      teamId: fixture.teamId
    }));
    await waitFor(async () => {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
        headers: fixture.authorization
      });
      return response.json().find((request: { requestId: string }) =>
        request.requestId === requestId
      )?.status === "ready";
    });

    await sendAndFlush(fixture.socket, envelope("agent.provision.result", {
      requestId,
      deviceId: fixture.deviceId,
      templateAgentId: agentId,
      agentId: provisionedAgentId,
      status: "accepted"
    }));
    const devices = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/devices`,
      headers: fixture.authorization
    });
    assert.equal(devices.json()[0]?.supportsAgentProvisioning, true);
  } finally {
    await closeFixture(fixture);
  }
});

test("configuration save failure retries the same reserved Agent identity", async () => {
  const fixture = await createFixture();
  try {
    const payload = {
      requestId: "agentprov_config_retry_12345678",
      deviceId: fixture.deviceId,
      templateAgentId: agentId,
      name: "Retryable Configuration",
      role: "Recovery",
      managementCode: "87654321"
    };
    const firstDelivery = nextMessage(fixture.socket);
    const submitted = await fixture.app.inject({
      method: "POST",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization,
      payload
    });
    const provisionedAgentId = submitted.json().agentId as string;
    await firstDelivery;
    await sendAndFlush(fixture.socket, envelope("agent.provision.result", {
      requestId: payload.requestId,
      deviceId: fixture.deviceId,
      templateAgentId: agentId,
      agentId: provisionedAgentId,
      status: "rejected",
      reason: "configuration_failed"
    }));
    await waitFor(async () => {
      const response = await fixture.app.inject({
        method: "GET",
        url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
        headers: fixture.authorization
      });
      return response.json().find((request: { requestId: string }) =>
        request.requestId === payload.requestId
      )?.rejectionReason === "configuration_failed";
    });

    const retriedDelivery = nextMessage(fixture.socket);
    const retried = await fixture.app.inject({
      method: "POST",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization,
      payload: { ...payload, managementCode: "12345678" }
    });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().agentId, provisionedAgentId);
    assert.equal(retried.json().status, "delivered");
    assert.equal(retried.json().rejectionReason, null);
    assert.equal((await retriedDelivery).payload.agentId, provisionedAgentId);
  } finally {
    await closeFixture(fixture);
  }
});

test("an older Bridge cannot receive central Agent provisioning", async () => {
  const fixture = await createFixture(undefined, false);
  try {
    const submitted = await fixture.app.inject({
      method: "POST",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization,
      payload: {
        requestId: "agentprov_upgrade_required_12345678",
        deviceId: fixture.deviceId,
        templateAgentId: agentId,
        name: "Unsupported Agent",
        role: "Upgrade",
        managementCode: "87654321"
      }
    });
    assert.equal(submitted.statusCode, 409);
    assert.match(submitted.body, /Bridge upgrade required/u);
    const listed = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/agent-provision-requests`,
      headers: fixture.authorization
    });
    assert.deepEqual(listed.json(), []);
    const devices = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/devices`,
      headers: fixture.authorization
    });
    assert.equal(devices.json()[0]?.supportsAgentProvisioning, false);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge schema rejects a missing traceId as an invalid envelope", async () => {
  const fixture = await createFixture();
  try {
    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("run.accepted", {
      runId: fixture.runId,
      agentId,
      sequence: 1
    }));
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: invalid_envelope"
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge raw decoding rejects a fractional integer before JavaScript rounding", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    const closed = nextClose(fixture.socket);
    const raw = JSON.stringify(envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "working"
    })).replace(
      '"sequence":2',
      '"sequence":2.0000000000000000000001'
    );
    fixture.socket.send(raw);
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: invalid_envelope"
    });
    assert.equal(await runState(fixture, "delivered"), true);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge schema closes required identity and unknown envelope fields", async (t) => {
  const valid = envelope("run.accepted", {
    runId: "run_schema_boundary_12345678",
    traceId: "trace_schema_boundary_12345678",
    agentId,
    sequence: 1
  }) as Record<string, unknown>;
  const cases: Array<{ name: string; value: Record<string, unknown> }> = [
    {
      name: "missing messageId",
      value: Object.fromEntries(Object.entries(valid).filter(([key]) =>
        key !== "messageId"
      ))
    },
    {
      name: "missing timestamp",
      value: Object.fromEntries(Object.entries(valid).filter(([key]) =>
        key !== "timestamp"
      ))
    },
    {
      name: "unknown top-level field",
      value: { ...valid, localPath: "/must/not/cross/the/wire" }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const logs: CapturedLog[] = [];
      const fixture = await createFixture(capturingLogger(logs));
      try {
        const closed = nextClose(fixture.socket);
        send(fixture.socket, scenario.value);
        assert.deepEqual(await closed, {
          code: 4_008,
          reason: "Bridge message rejected: invalid_envelope"
        });
        assert.doesNotMatch(JSON.stringify(logs), /must\/not\/cross/u);
      } finally {
        await closeFixture(fixture);
      }
    });
  }
});

test("Bridge rejects a parsed non-object payload as an invalid envelope", async () => {
  const logs: CapturedLog[] = [];
  const fixture = await createFixture(capturingLogger(logs));
  try {
    const closed = nextClose(fixture.socket);
    fixture.socket.send(JSON.stringify({
      protocolVersion: "1.0",
      messageId: "msg_01K4Z6J7Y8N9P0Q1R2S3T4V5W6",
      timestamp: now,
      type: "run.accepted",
      payload: []
    }));
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: invalid_envelope"
    });
    assert.equal(logs.some((entry) =>
      entry.event === "bridge.message.rejected" &&
      entry.errorCategory === "invalid_envelope"
    ), true);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge rejects empty traceId on Run status", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: "",
      agentId,
      sequence: 2,
      status: "working"
    }));
    assert.equal((await closed).code, 4_008);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge rejects whitespace traceId on Run reply without echoing content", async () => {
  const logs: CapturedLog[] = [];
  const fixture = await createFixture(capturingLogger(logs));
  try {
    await acceptRun(fixture);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "working"
    }));
    await waitFor(() => runState(fixture, "working"));
    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("run.reply", {
      runId: fixture.runId,
      traceId: "   ",
      agentId,
      sequence: 3,
      content: "token=must-not-be-echoed"
    }));
    const rejection = await closed;
    assert.equal(rejection.code, 4_008);
    assert.equal(rejection.reason, "Bridge message rejected: invalid_envelope");
    assert.doesNotMatch(rejection.reason, /must-not-be-echoed|token/u);
    assert.equal(logs.some((entry) =>
      entry.event === "bridge.message.rejected" &&
      entry.errorCategory === "invalid_envelope"
    ), true);
    assert.doesNotMatch(JSON.stringify(logs), /must-not-be-echoed|token=/u);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge rejects a well-formed but incorrect traceId", async () => {
  const logs: CapturedLog[] = [];
  const fixture = await createFixture(capturingLogger(logs));
  try {
    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("run.accepted", {
      runId: fixture.runId,
      traceId: "trace_wrong_identity",
      agentId,
      sequence: 1
    }));
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: run_acceptance_rejected"
    });
    assert.equal(logs.some((entry) =>
      entry.event === "bridge.message.processing_failed" &&
      entry.errorCategory === "run_acceptance_rejected"
    ), true);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge applies accepted, output, activity, status, and reply messages with the matching traceId", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "working"
    }));
    await waitFor(() => runState(fixture, "working"));
    send(fixture.socket, envelope("run.output_delta", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 3,
      content: "Strict trace "
    }));
    send(fixture.socket, envelope("run.activity", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 4,
      activityId: "reasoning-1",
      kind: "reasoning",
      phase: "updated",
      label: "Thinking",
      content: "Validated the strict trace."
    }));
    send(fixture.socket, envelope("run.reply", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 5,
      content: "Strict trace accepted."
    }));
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 6,
      status: "completed",
      session: {
        disposition: "resumed",
        contextCursor: 1
      }
    }));
    await waitFor(() => runState(fixture, "completed"));
    const timeline = await fixture.app.inject({
      method: "GET",
      url: `/api/rooms/${fixture.roomId}/messages?limit=100`,
      headers: fixture.authorization
    });
    assert.equal(timeline.json().items.at(-1).content, "Strict trace accepted.");
    const output = await fixture.app.inject({
      method: "GET",
      url: `/api/runs/${fixture.runId}/events?after=2`,
      headers: fixture.authorization
    });
    assert.equal(output.statusCode, 200);
    assert.deepEqual(
      output.json().map((record: { event: { type: string } }) => record.event.type),
      ["output", "activity", "reply", "status"]
    );
    assert.deepEqual(output.json()[1].event, {
      type: "activity",
      sequence: 4,
      activityId: "reasoning-1",
      kind: "reasoning",
      phase: "updated",
      label: "Thinking",
      content: "Validated the strict trace."
    });
    assert.deepEqual(output.json().at(-1).event.session, {
      disposition: "resumed",
      contextCursor: 1
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge and JSON Schema share Unicode code-point length semantics", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "working"
    }));
    await waitFor(() => runState(fixture, "working"));

    const outputHalf = "😀".repeat(10_000);
    send(fixture.socket, envelope("run.output_delta", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 3,
      content: outputHalf
    }));
    send(fixture.socket, envelope("run.output_delta", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 4,
      content: outputHalf
    }));
    send(fixture.socket, envelope("run.activity", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 5,
      activityId: "😀".repeat(100),
      kind: "reasoning",
      phase: "updated",
      label: "😀".repeat(100),
      content: "😀".repeat(3_000)
    }));
    const reply = "😀".repeat(10_001);
    send(fixture.socket, envelope("run.reply", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 6,
      content: reply,
      assessment: {
        openQuestions: [{
          id: "😀".repeat(100),
          question: "😀".repeat(1_001),
          importance: "high"
        }]
      }
    }));
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 7,
      status: "failed",
      error: {
        code: "RUNTIME_FAILED",
        message: "😀".repeat(300),
        retryable: false
      }
    }));
    await waitFor(() => runState(fixture, "failed"));

    const events = await fixture.app.inject({
      method: "GET",
      url: `/api/runs/${fixture.runId}/events?after=0`,
      headers: fixture.authorization
    });
    assert.equal(events.statusCode, 200);
    const records = events.json() as Array<{
      event: { type: string; content?: string; error?: { message: string } };
    }>;
    assert.equal(
      records.filter(({ event }) => event.type === "output")
        .reduce((length, { event }) =>
          length + [...(event.content ?? "")].length, 0),
      20_000
    );
    assert.equal(
      [...(records.find(({ event }) => event.type === "reply")?.event.content ?? "")]
        .length,
      10_001
    );
    assert.equal(
      [...(records.at(-1)?.event.error?.message ?? "")].length,
      300
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge rejects malformed Runtime output metadata", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("run.output_delta", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      content: "private preview",
      reset: "yes"
    }));
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: invalid_envelope"
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge schema enforces the Runtime error bound before persistence", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "working"
    }));
    await waitFor(() => runState(fixture, "working"));

    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 3,
      status: "failed",
      error: {
        code: "A".repeat(65),
        message: "must not persist",
        retryable: false
      }
    }));
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: invalid_envelope"
    });
    assert.equal(await runState(fixture, "working"), true);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge persists only allowlisted Runtime failure details", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "working"
    }));
    await waitFor(() => runState(fixture, "working"));
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 3,
      status: "failed",
      error: {
        code: "RUNTIME_EXIT_FAILED",
        message: "Runtime process exited unsuccessfully.",
        retryable: false,
        details: {
          category: "future_runtime_category",
          exitCode: 7,
          stderrCaptured: true,
          rawStderr: "token=must-never-be-persisted",
          arbitrary: "must-never-be-persisted"
        }
      }
    }));
    await waitFor(() => runState(fixture, "failed"));
    const response = await fixture.app.inject({
      method: "GET",
      url: `/api/runs/${fixture.runId}/events`,
      headers: fixture.authorization
    });
    assert.equal(response.statusCode, 200);
    const events = response.json() as Array<{
      event: { type: string; status?: string; error?: unknown };
    }>;
    const terminal = events.find(({ event }) =>
      event.type === "status" && event.status === "failed"
    );
    assert.deepEqual(terminal?.event.error, {
      code: "RUNTIME_EXIT_FAILED",
      message: "Runtime process exited unsuccessfully.",
      retryable: false,
      details: {
        category: "unknown",
        exitCode: 7,
        stderrCaptured: true
      }
    });
    assert.doesNotMatch(
      JSON.stringify(events),
      /must-never-be-persisted|rawStderr|arbitrary/u
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge Task clarification resumes through one authorized same-Task Run", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "working"
    }));
    await waitFor(() => runState(fixture, "working"));
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 3,
      status: "input_required",
      clarification: {
        kind: "task",
        question: "Which region should this deployment use?",
        choices: ["eu-west-1", "eu-central-1"]
      },
      session: {
        disposition: "started",
        contextCursor: 1
      }
    }));
    await waitFor(() => runState(fixture, "input_required"));
    const tasks = await fixture.app.inject({
      method: "GET",
      url: `/api/rooms/${fixture.roomId}/tasks`,
      headers: fixture.authorization
    });
    const taskId = tasks.json()[0].taskId as string;
    const waiting = await fixture.app.inject({
      method: "GET",
      url: `/api/tasks/${taskId}/clarifications`,
      headers: fixture.authorization
    });
    assert.equal(waiting.statusCode, 200);
    assert.equal(waiting.json().length, 1);
    assert.equal(waiting.json()[0].state, "waiting");
    assert.deepEqual(waiting.json()[0].choices, ["eu-west-1", "eu-central-1"]);

    const continuationRequest = nextMessage(fixture.socket);
    const answered = await fixture.app.inject({
      method: "POST",
      url: `/api/clarifications/${waiting.json()[0].clarificationId as string}/answer`,
      headers: fixture.authorization,
      payload: { answer: "Use eu-west-1." }
    });
    assert.equal(answered.statusCode, 200);
    assert.equal(answered.json().clarification.state, "resumed");
    assert.equal(answered.json().run.taskId, taskId);
    assert.notEqual(answered.json().run.runId, fixture.runId);
    assert.equal(await runState(fixture, "outcome_unknown"), true);
    const requested = await continuationRequest;
    assert.equal(requested.type, "run.requested");
    assert.equal(requested.payload.runId, answered.json().run.runId);
    assert.equal(requested.payload.taskId, taskId);
    assert.deepEqual(requested.payload.session, {
      scope: "task",
      resumePolicy: "resume_or_start",
      contextCursor: 3
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge rejects permission-shaped Task clarification fields", async () => {
  const fixture = await createFixture();
  try {
    await acceptRun(fixture);
    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 2,
      status: "input_required",
      clarification: {
        kind: "task",
        question: "May I run this command?",
        approvalKind: "shell"
      }
    }));
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: invalid_envelope"
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge rejects local details inside a Runtime policy summary", async () => {
  const fixture = await createFixture();
  try {
    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("agent.publish", {
      agentId,
      capabilities: {
        invocationMode: "managed",
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: false
      },
      deviceId: fixture.deviceId,
      name: "Unsafe Agent",
      ownerMemberId: fixture.ownerMemberId,
      role: "Unsafe",
      runtimePolicy: {
        filesystemAccess: "read-only",
        workspacePath: "/Users/alice/private"
      },
      teamId: fixture.teamId
    }));
    assert.deepEqual(await closed, {
      code: 4_008,
      reason: "Bridge message rejected: invalid_envelope"
    });
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge rejects local Workspace binding detail without changing its safe projection", async () => {
  const fixture = await createFixture();
  try {
    const closed = nextClose(fixture.socket);
    send(fixture.socket, envelope("agent.publish", {
      agentId,
      capabilities: {
        invocationMode: "managed",
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: false
      },
      deviceId: fixture.deviceId,
      name: "Unsafe Agent",
      ownerMemberId: fixture.ownerMemberId,
      role: "Unsafe",
      workspaceAlias: "Private",
      workspacePath: "/Users/alice/private",
      teamId: fixture.teamId
    }));
    assert.equal((await closed).code, 4_008);
    const listed = await fixture.app.inject({
      method: "GET",
      url: `/api/teams/${fixture.teamId}/agents`,
      headers: fixture.authorization
    });
    const projected = listed.json().find((agent: { agentId: string }) =>
      agent.agentId === agentId
    ) as Record<string, unknown>;
    assert.equal(projected.workspaceAlias, "Protocol Workspace");
    assert.equal("workspacePath" in projected, false);
    assert.equal(JSON.stringify(projected).includes("/Users/alice/private"), false);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge reserves close code 4007 for malformed JSON", async () => {
  const logs: CapturedLog[] = [];
  const fixture = await createFixture(capturingLogger(logs));
  try {
    const closed = nextClose(fixture.socket);
    fixture.socket.send("{");
    assert.deepEqual(await closed, {
      code: 4_007,
      reason: "Malformed Bridge message"
    });
    assert.equal(logs.some((entry) =>
      entry.event === "bridge.message.malformed"
    ), true);
  } finally {
    await closeFixture(fixture);
  }
});

test("Bridge rejects binary and invalid UTF-8 frames before JSON decoding", async () => {
  const fixture = await createFixture();
  try {
    const closed = nextClose(fixture.socket);
    fixture.socket.send(Buffer.from([0xff]), { binary: true });
    assert.deepEqual(await closed, {
      code: 4_007,
      reason: "Malformed Bridge message"
    });
  } finally {
    await closeFixture(fixture);
  }
});
