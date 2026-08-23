import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createServerApp } from "../../apps/server/src/app.js";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 12_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for cross-process state");
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => process.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  ]);
}

test("Web Mention completes through a paired Go Bridge and Generic Runtime", {
  timeout: 30_000
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-e2e-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite")
  });
  let bridgeProcess: ChildProcess | undefined;
  let bridgeStderr = "";
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind TCP");
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const bootstrap = await app.inject({
      method: "POST", url: "/api/bootstrap", payload: { displayName: "Alice" }
    });
    const webToken = bootstrap.json().session.token as string;
    const authorization = { authorization: `Bearer ${webToken}` };
    const teamResponse = await app.inject({
      method: "POST", url: "/api/teams", headers: authorization,
      payload: { name: "Managed Team" }
    });
    const teamId = teamResponse.json().team.teamId as string;
    const roomResponse = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/rooms`, headers: authorization,
      payload: { name: "general" }
    });
    const roomId = roomResponse.json().roomId as string;
    const inviteResponse = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/bridge-invites`, headers: authorization,
      payload: { deviceName: "Bob Bridge" }
    });
    const pairingCode = inviteResponse.json().code as string;

    const bridgeBinary = path.join(directory, "agentroom-bridge");
    const goBinary = process.env.AGENT_ROOM_GO_BIN ?? "go";
    await execFileAsync(goBinary, ["build", "-o", bridgeBinary, "./cmd/agentroom-bridge"], {
      cwd: path.join(repositoryRoot, "bridge")
    });
    const configPath = path.join(directory, "bridge.json");
    await writeFile(configPath, JSON.stringify({
      serverUrl,
      deviceName: "Bob Bridge",
      dataDir: path.join(directory, "bridge-data"),
      agents: [{
        name: "Echo Builder",
        role: "Generic Runtime",
        adapter: "generic",
        command: ["/usr/bin/tr", "a-z", "A-Z"],
        workspace: directory,
        envAllowlist: []
      }, {
        name: "Slow Builder",
        role: "Cancelable Runtime",
        adapter: "generic",
        command: ["/bin/sh", "-c", "sleep 10"],
        workspace: directory,
        envAllowlist: []
      }]
    }, null, 2));
    await execFileAsync(bridgeBinary, ["pair", "--config", configPath, "--code", pairingCode]);
    bridgeProcess = spawn(bridgeBinary, ["run", "--config", configPath], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    bridgeProcess.stderr?.on("data", (source: Buffer) => {
      bridgeStderr += source.toString();
    });

    const agent = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/teams/${teamId}/agents`, headers: authorization
      });
      return (response.json() as Array<{
        agentId: string;
        name: string;
        integrationMode: string;
        presence: string;
      }>).find((candidate) =>
        candidate.name === "Echo Builder" && candidate.presence === "ready"
      );
    });
    const sent = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/messages`, headers: authorization,
      payload: { content: "Run through real Bridge", mentionAgentId: agent.agentId }
    });
    assert.equal(sent.statusCode, 200);
    const runId = sent.json().runs[0].runId as string;
    const traceId = sent.json().message.traceId as string;
    assert.equal(sent.json().runs[0].traceId, traceId);

    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as Array<{ runId: string; state: string }>).find(
        (candidate) => candidate.runId === runId
      );
      return run?.state === "completed" ? run : undefined;
    });
    const timeline = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}/messages?limit=100`, headers: authorization
    });
    assert.equal(timeline.json().items.at(-1).content, "RUN THROUGH REAL BRIDGE");
    assert.equal(timeline.json().items.at(-1).traceId, traceId);
    const traceResponse = await app.inject({
      method: "GET", url: `/api/traces/${traceId}`, headers: authorization
    });
    assert.equal(traceResponse.statusCode, 200);
    const traceEntries = traceResponse.json().entries as Array<{ kind: string }>;
    assert.deepEqual(
      new Set(traceEntries.map(({ kind }) => kind)),
      new Set(["message", "run", "delivery", "run_event"])
    );
    const outsider = await app.inject({
      method: "POST", url: "/api/bootstrap",
      payload: { displayName: "Mallory" }
    });
    const deniedTrace = await app.inject({
      method: "GET",
      url: `/api/traces/${traceId}`,
      headers: {
        authorization: `Bearer ${outsider.json().session.token as string}`
      }
    });
    assert.equal(deniedTrace.statusCode, 403);

    const slowAgent = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/teams/${teamId}/agents`, headers: authorization
      });
      return (response.json() as Array<{
        agentId: string;
        name: string;
        presence: string;
      }>).find((candidate) =>
        candidate.name === "Slow Builder" && candidate.presence === "ready"
      );
    });
    const slowSent = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/messages`, headers: authorization,
      payload: { content: "Wait until canceled", mentionAgentId: slowAgent.agentId }
    });
    const slowRunId = slowSent.json().runs[0].runId as string;
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as Array<{ runId: string; state: string }>).find(
        (candidate) => candidate.runId === slowRunId
      );
      return run?.state === "working" ? run : undefined;
    });
    const canceled = await app.inject({
      method: "POST", url: `/api/runs/${slowRunId}/cancel`, headers: authorization,
      payload: { reason: "E2E cancellation" }
    });
    assert.equal(canceled.statusCode, 200);
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as Array<{ runId: string; state: string }>).find(
        (candidate) => candidate.runId === slowRunId
      );
      return run?.state === "canceled" ? run : undefined;
    });
  } catch (error) {
    throw new Error(`${String(error)}\nBridge stderr:\n${bridgeStderr}`);
  } finally {
    if (bridgeProcess) await stopProcess(bridgeProcess);
    await app.close();
  }
});
