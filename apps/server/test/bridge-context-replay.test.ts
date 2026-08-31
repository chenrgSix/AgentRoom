import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createServerApp } from "../src/app.js";
import { openDatabase } from "../src/data/database.js";
import { RollingRoomMemoryRepository } from "../src/memory/rolling-room-memory-repository.js";
import type {
  DeliveryRecord,
  RoomContextConsumptionReceipt
} from "../src/run/delivery-service.js";

const now = "2026-08-31T12:00:00.000Z";
const agentId = "agent_context_replay_12345678";
const runtimeScopeId = "a".repeat(64);
const checkpointId = "checkpoint_context_replay_12345678";
type RequestedRun = DeliveryRecord["payload"];

interface TestSocket extends EventEmitter {
  readonly readyState: number;
  send(source: string): void;
  terminate(): void;
}

function send(socket: TestSocket, type: string, payload: unknown): void {
  socket.send(JSON.stringify({
    protocolVersion: "1.0", messageId: "msg_context_replay_12345678",
    timestamp: now, type, payload
  }));
}

async function until(read: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Server state did not converge");
}

function receive(socket: TestSocket): Promise<{ type: string; payload: RequestedRun }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", message);
      socket.off("close", closed);
    };
    const message = (raw: Buffer) => {
      cleanup();
      resolve(JSON.parse(raw.toString()));
    };
    const closed = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`Bridge closed ${code}: ${reason.toString()}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Bridge response timed out"));
    }, 3_000);
    socket.once("message", message);
    socket.once("close", closed);
  });
}

function consumption(run: RequestedRun): RoomContextConsumptionReceipt {
  const bundle = run.roomContextBundle;
  assert.ok(bundle);
  return {
    baseContextCursor: 0,
    checkpointId: bundle.checkpoint.checkpointId,
    rawFromSequenceExclusive: bundle.rawTail.fromSequenceExclusive,
    rawThroughSequenceInclusive: bundle.rawTail.throughSequenceInclusive,
    rawMessageCount: bundle.rawTail.messageCount,
    coverageThroughSequence: bundle.targetThroughSequence
  };
}

function report(socket: TestSocket, run: RequestedRun): void {
  const identity = { runId: run.runId, traceId: run.traceId, agentId };
  send(socket, "run.accepted", { ...identity, sequence: 1 });
  send(socket, "run.status", { ...identity, sequence: 2, status: "working" });
}

function terminal(run: RequestedRun, receipt?: RoomContextConsumptionReceipt) {
  return {
    runId: run.runId, traceId: run.traceId, agentId, sequence: 3,
    status: "completed", session: {
      disposition: "started", runtimeScopeId, resultEvidenceRevision: 0,
      contextCursor: receipt?.coverageThroughSequence ?? run.session.contextCursor,
      ...(receipt ? { roomContextConsumption: receipt } : {})
    }
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-context-replay-"));
  const options = {
    databasePath: path.join(directory, "server.sqlite"), clock: () => now,
    hostedFetch: async () => { throw new Error("Provider calls are forbidden"); }
  };
  let app: Awaited<ReturnType<typeof createServerApp>> | undefined;
  function server() { assert.ok(app); return app; }
  async function closeApp(): Promise<void> {
    if (!app) return;
    const current = app;
    app = undefined;
    for (const socket of current.websocketServer.clients) socket.terminate();
    await new Promise((resolve) => setImmediate(resolve));
    await current.close();
  }
  t.after(async () => {
    try { await closeApp(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  async function restart(): Promise<void> {
    await closeApp();
    app = await createServerApp(options);
    await app.ready();
  }
  await restart();
  const bootstrap = (await server().inject({
    method: "POST", url: "/api/bootstrap", payload: { displayName: "Context test" }
  })).json();
  const headers = { authorization: `Bearer ${bootstrap.session.token}` };
  const teamId = (await server().inject({
    method: "POST", url: "/api/teams", headers, payload: { name: "Context Team" }
  })).json().team.teamId;
  const roomId = (await server().inject({
    method: "POST", url: `/api/teams/${teamId}/rooms`, headers,
    payload: { name: "Context room" }
  })).json().roomId;
  const invite = (await server().inject({
    method: "POST", url: `/api/teams/${teamId}/bridge-invites`, headers,
    payload: { deviceName: "Context Bridge" }
  })).json();
  const paired = (await server().inject({
    method: "POST", url: "/api/bridge/pair",
    payload: { code: invite.code, deviceName: "Context Bridge" }
  })).json();
  const prior = (await server().inject({
    method: "POST", url: `/api/rooms/${roomId}/messages`, headers,
    payload: { content: "Synthetic checkpoint input" }
  })).json().message;
  assert.equal(prior.sequence, 1);
  const database = openDatabase(options.databasePath);
  try {
    const rolling = new RollingRoomMemoryRepository(database);
    rolling.enable(roomId, now);
    const lease = rolling.acquireLease({
      roomId, leaseToken: "lease_context_replay_12345678", now,
      leaseExpiresAt: "2026-08-31T12:05:00.000Z"
    });
    assert.ok(lease?.leaseToken);
    rolling.commitCheckpoint({
      checkpoint: {
        checkpointId, roomId, parentCheckpointId: null,
        inputFromSequenceExclusive: 0, throughSequence: prior.sequence,
        summary: "Synthetic checkpoint", provenance: [prior.messageId],
        sourceMessageCount: 1, sourceDigest: "b".repeat(64), promptVersion: 1,
        modelFingerprint: "test-reducer-v1", buildKind: "incremental", createdAt: now
      },
      expectedGeneration: lease.generation, leaseToken: lease.leaseToken, now
    });
  } finally { database.close(); }
  const tail = await server().inject({
    method: "POST", url: `/api/rooms/${roomId}/messages`, headers,
    payload: { content: "Synthetic raw-tail input" }
  });
  assert.equal(tail.statusCode, 200, tail.body);
  assert.equal(tail.json().message.sequence, 2);

  return {
    restart,
    async connect(epoch: number, coverage: boolean | undefined): Promise<TestSocket> {
      const socket = await server().injectWS("/ws/bridge", { headers: {
        authorization: `Bearer ${paired.credential.token}`, host: "127.0.0.1"
      } });
      send(socket, "bridge.hello", {
        bridgeVersion: "v0.4.0", connectionEpoch: epoch,
        deviceId: paired.device.deviceId, supportedProtocolVersions: ["1.0"]
      });
      send(socket, "agent.publish", {
        agentId, teamId, deviceId: paired.device.deviceId,
        ownerMemberId: paired.device.ownerMemberId,
        name: "Context Agent", role: "Builder", runtimeScopeId,
        capabilities: {
          invocationMode: "managed", supportsStart: true, supportsHandoff: false,
          supportsInterrupt: true, supportsResume: true, supportsStreaming: false,
          ...(coverage === undefined ? {} : { supportsRoomContextCoverage: coverage })
        }
      });
      await until(async () => {
        const agents = (await server().inject({
          method: "GET", url: `/api/teams/${teamId}/agents`, headers
        })).json();
        return agents.find((agent: { agentId: string }) => agent.agentId === agentId)
          ?.capabilities.supportsRoomContextCoverage === (coverage === true);
      });
      return socket;
    },
    async request(socket: TestSocket): Promise<RequestedRun> {
      const requested = receive(socket);
      const response = await server().inject({
        method: "POST", url: `/api/rooms/${roomId}/messages`, headers,
        payload: { content: "Synthetic context replay", mentionAgentId: agentId }
      });
      assert.equal(response.statusCode, 200, response.body);
      const message = await requested;
      assert.equal(message.type, "run.requested");
      return message.payload;
    },
    async state(runId: string): Promise<string> {
      return (await server().inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers
      })).json().find((run: { runId: string }) => run.runId === runId)?.state;
    },
    snapshot(runId: string) {
      const database = openDatabase(options.databasePath);
      try {
        const row = database.prepare(`
          SELECT payload_json, payload_hash FROM run_deliveries WHERE run_id = ?
        `).get(runId);
        assert.ok(row);
        return row;
      } finally { database.close(); }
    }
  };
}

for (const coverage of [false, undefined]) {
  for (const outcome of ["delivered", "unsent"] as const) {
    test(`Room context replay: ${outcome} terminal with capability ${coverage === false ? "disabled" : "omitted"}`, async (t) => {
      const f = await fixture(t);
      let socket = await f.connect(1, true);
      const original = await f.request(socket);
      const receipt = consumption(original);
      assert.equal(receipt.rawMessageCount, 1);
      const persisted = f.snapshot(original.runId);
      const completed = terminal(original, receipt);
      report(socket, original);
      await until(async () => await f.state(original.runId) === "working");
      if (outcome === "delivered") {
        send(socket, "run.status", completed);
        await until(async () => await f.state(original.runId) === "completed");
      }
      socket.terminate();
      for (const epoch of [2, 3]) {
        socket = await f.connect(epoch, coverage);
        report(socket, original);
        send(socket, "run.status", completed);
        await until(async () => await f.state(original.runId) === "completed");
        // Complete new work on the same socket: a duplicate terminal must not
        // merely preserve its existing state while closing the whole Device.
        const next = await f.request(socket);
        assert.equal(next.roomContextBundle, undefined);
        report(socket, next);
        send(socket, "run.status", terminal(next));
        await until(async () => await f.state(next.runId) === "completed");
        assert.equal(socket.readyState, 1);
        assert.deepEqual(f.snapshot(original.runId), persisted);
        if (epoch === 2) await f.restart();
        else socket.terminate();
      }
    });
  }
}

for (const forgery of ["checkpoint", "raw-interval", "coverage", "missing-bundle"] as const) {
  test(`Room context replay still rejects ${forgery} forgery after republication`, async (t) => {
    const f = await fixture(t);
    let socket = await f.connect(1, forgery !== "missing-bundle");
    const original = await f.request(socket);
    const receipt: RoomContextConsumptionReceipt = forgery === "missing-bundle"
      ? {
          baseContextCursor: 0, checkpointId, rawFromSequenceExclusive: 1,
          rawThroughSequenceInclusive: 2, rawMessageCount: 1,
          coverageThroughSequence: original.session.contextCursor
        }
      : consumption(original);
    if (forgery === "missing-bundle") assert.equal(original.roomContextBundle, undefined);
    report(socket, original);
    await until(async () => await f.state(original.runId) === "working");
    if (forgery === "checkpoint") {
      send(socket, "run.status", terminal(original, receipt));
      await until(async () => await f.state(original.runId) === "completed");
      receipt.checkpointId = "checkpoint_forged_12345678";
    } else if (forgery === "raw-interval") {
      receipt.rawFromSequenceExclusive--;
      receipt.rawMessageCount++;
    } else if (forgery === "coverage") {
      receipt.coverageThroughSequence++;
    }
    socket.terminate();
    // A later capability grant cannot authorize a bundle that was never sent.
    socket = await f.connect(2, forgery === "missing-bundle");
    const rejected = assert.rejects(receive(socket), /Bridge closed 4008/u);
    send(socket, "run.status", terminal(original, receipt));
    await rejected;
    assert.equal(await f.state(original.runId), forgery === "checkpoint" ? "completed" : "working");
  });
}
