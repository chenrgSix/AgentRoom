import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type WebSocket from "ws";

import { createServerApp } from "../src/app.js";

const now = "2026-08-31T12:00:00.000Z";
const agentId = "agent_scope_replay_12345678";
const scopeA = "a".repeat(64);
const scopeB = "b".repeat(64);

function send(socket: WebSocket, type: string, payload: unknown): void {
  socket.send(JSON.stringify({
    protocolVersion: "1.0", messageId: "msg_scope_replay_12345678",
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

function receive(socket: WebSocket): Promise<{
  type: string;
  payload: { runId: string; traceId: string; session: { contextCursor: number } };
}> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", message);
      socket.off("close", closed);
    };
    const message = (raw: WebSocket.RawData) => {
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

for (const scenario of ["delivered", "unsent", "forged"] as const) {
  test(`Runtime scope replay: ${scenario} terminal after configuration change`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-scope-replay-"));
    const options = {
      databasePath: path.join(directory, "server.sqlite"), clock: () => now,
      hostedFetch: async () => { throw new Error("Provider calls are forbidden"); }
    };
    let app = await createServerApp(options);
    let socket: WebSocket | undefined;
    async function closeApp(): Promise<void> {
      for (const client of app.websocketServer.clients) client.terminate();
      socket?.terminate();
      await new Promise((resolve) => setImmediate(resolve));
      await app.close();
    }
    try {
      await app.ready();
      const bootstrap = (await app.inject({
        method: "POST", url: "/api/bootstrap", payload: { displayName: "Scope test" }
      })).json();
      const headers = { authorization: `Bearer ${bootstrap.session.token}` };
      const team = (await app.inject({
        method: "POST", url: "/api/teams", headers, payload: { name: "Scope Team" }
      })).json();
      const teamId = team.team.teamId;
      const room = (await app.inject({
        method: "POST", url: `/api/teams/${teamId}/rooms`, headers,
        payload: { name: "Scope room" }
      })).json();
      const invite = (await app.inject({
        method: "POST", url: `/api/teams/${teamId}/bridge-invites`, headers,
        payload: { deviceName: "Scope Bridge" }
      })).json();
      const paired = (await app.inject({
        method: "POST", url: "/api/bridge/pair",
        payload: { code: invite.code, deviceName: "Scope Bridge" }
      })).json();
      async function connect(epoch: number, scope: string): Promise<WebSocket> {
        const next = await app.injectWS("/ws/bridge", { headers: {
          authorization: `Bearer ${paired.credential.token}`, host: "127.0.0.1"
        } });
        send(next, "bridge.hello", {
          bridgeVersion: "v0.4.0", connectionEpoch: epoch,
          deviceId: paired.device.deviceId, supportedProtocolVersions: ["1.0"]
        });
        send(next, "agent.publish", {
          agentId, deviceId: paired.device.deviceId,
          ownerMemberId: paired.device.ownerMemberId, teamId,
          name: "Scope Agent", role: "Builder", runtimeScopeId: scope,
          runtimePolicy: { filesystemAccess: "read-only" }, workspaceAlias: "Scope Workspace",
          workspaceRef: `workspace_${"c".repeat(64)}`, workspaceGeneration: "d".repeat(64),
          capabilities: {
            invocationMode: "managed", supportsHandoff: false, supportsInterrupt: true,
            supportsResume: true, supportsStart: true, supportsStreaming: false
          }
        });
        await until(async () => {
          const agents = (await app.inject({
            method: "GET", url: `/api/teams/${teamId}/agents`, headers
          })).json();
          return agents.find((agent: { agentId: string }) => agent.agentId === agentId)
            ?.runtimeScopeId === scope;
        });
        return next;
      }
      async function state(runId: string): Promise<string> {
        return (await app.inject({
          method: "GET", url: `/api/rooms/${room.roomId}/runs`, headers
        })).json().find((run: { runId: string }) => run.runId === runId)?.state;
      }
      async function requestRun(connection: WebSocket) {
        const requested = receive(connection);
        const response = await app.inject({
          method: "POST", url: `/api/rooms/${room.roomId}/messages`, headers,
          payload: { content: "Synthetic scope regression", mentionAgentId: agentId }
        });
        assert.equal(response.statusCode, 200, response.body);
        const message = await requested;
        assert.equal(message.type, "run.requested");
        return message.payload;
      }
      function report(connection: WebSocket, run: Awaited<ReturnType<typeof requestRun>>, scope: string) {
        const identity = { runId: run.runId, traceId: run.traceId, agentId };
        send(connection, "run.accepted", { ...identity, sequence: 1 });
        send(connection, "run.status", { ...identity, sequence: 2, status: "working" });
        return { ...identity, sequence: 3, status: "completed", session: {
          disposition: "started", contextCursor: run.session.contextCursor,
          runtimeScopeId: scope, resultEvidenceRevision: 0
        } };
      }
      socket = await connect(1, scopeA);
      const original = await requestRun(socket);
      const terminal = report(socket, original, scopeA);
      await until(async () => await state(original.runId) === "working");
      if (scenario === "delivered") {
        send(socket, "run.status", terminal);
        await until(async () => await state(original.runId) === "completed");
        // Prove the scope is read from persisted Delivery after a Central restart.
        await closeApp();
        app = await createServerApp(options);
        await app.ready();
      } else {
        socket.terminate();
      }
      for (const epoch of [2, 3]) {
        socket = await connect(epoch, scopeB);
        const replay = report(socket, original, scopeA);
        if (scenario === "forged") {
          const rejected = assert.rejects(receive(socket), /Bridge closed 4008/u);
          send(socket, "run.status", {
            ...replay, session: { ...replay.session, runtimeScopeId: scopeB }
          });
          await rejected;
          assert.equal(await state(original.runId), "working");
          continue;
        }
        send(socket, "run.status", replay);
        await until(async () => await state(original.runId) === "completed");
        // A full subsequent Run proves replay did not merely preserve state
        // while asynchronously closing the Device's connection.
        const next = await requestRun(socket);
        send(socket, "run.status", report(socket, next, scopeB));
        await until(async () => await state(next.runId) === "completed");
        assert.equal(socket.readyState, 1);
        socket.terminate();
      }
    } finally {
      await closeApp();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
