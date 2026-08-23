import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { createServerApp } from "../src/app.js";

const now = "2026-08-23T12:00:00.000Z";
const agentId = "agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6";

interface BridgeWireMessage {
  type: string;
  payload: Record<string, unknown>;
}

type BridgeSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

interface BridgeFixture {
  app: Awaited<ReturnType<typeof createServerApp>>;
  socket: BridgeSocket;
  authorization: { authorization: string };
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
  loggerInstance?: FastifyBaseLogger
): Promise<BridgeFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-bridge-ws-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
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
    bridgeVersion: "test",
    connectionEpoch: 1,
    deviceId: paired.device.deviceId,
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
    name: "Protocol Agent",
    ownerMemberId: paired.device.ownerMemberId,
    role: "Protocol Test",
    teamId: paired.device.teamId
  }));
  await waitFor(async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/agents`,
      headers: authorization
    });
    return response.json().some((agent: { agentId: string; presence: string }) =>
      agent.agentId === agentId && agent.presence === "ready"
    );
  });
  const requestedMessage = nextMessage(socket);
  const routed = await app.inject({
    method: "POST",
    url: `/api/rooms/${roomId}/messages`,
    headers: authorization,
    payload: { content: "Validate strict Bridge traces", mentionAgentId: agentId }
  });
  assert.equal(routed.statusCode, 200);
  const requested = await requestedMessage;
  assert.equal(requested.type, "run.requested");
  return {
    app,
    socket,
    authorization,
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
  send(fixture.socket, envelope("run.accepted", {
    runId: fixture.runId,
    traceId: fixture.traceId,
    agentId,
    sequence: 1
  }));
  await waitFor(() => runState(fixture, "delivered"));
}

test("Bridge rejects missing traceId as a processed message, not malformed JSON", async () => {
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
      reason: "Bridge message rejected: invalid_trace_id"
    });
  } finally {
    await closeFixture(fixture);
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
    assert.equal(rejection.reason, "Bridge message rejected: invalid_trace_id");
    assert.doesNotMatch(rejection.reason, /must-not-be-echoed|token/u);
    assert.equal(logs.some((entry) =>
      entry.event === "bridge.message.rejected" &&
      entry.errorCategory === "invalid_trace_id"
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

test("Bridge applies accepted, status, and reply messages with the matching traceId", async () => {
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
    send(fixture.socket, envelope("run.reply", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 3,
      content: "Strict trace accepted."
    }));
    send(fixture.socket, envelope("run.status", {
      runId: fixture.runId,
      traceId: fixture.traceId,
      agentId,
      sequence: 4,
      status: "completed"
    }));
    await waitFor(() => runState(fixture, "completed"));
    const timeline = await fixture.app.inject({
      method: "GET",
      url: `/api/rooms/${fixture.roomId}/messages?limit=100`,
      headers: fixture.authorization
    });
    assert.equal(timeline.json().items.at(-1).content, "Strict trace accepted.");
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
          category: "configuration",
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
        category: "configuration",
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
