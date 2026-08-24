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

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 25_000): Promise<T> {
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

test("Web Mention streams Pi output and completes through a paired Go Bridge", {
  timeout: 60_000
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-e2e-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite")
  });
  let bridgeProcess: ChildProcess | undefined;
  let stage = "setup";
  let bridgeStdout = "";
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
    const piReply = `PI STREAMING FINAL ${"RESULT ".repeat(14).trim()}`;
    const piHelperPath = path.join(directory, "pi-helper.mjs");
    await writeFile(piHelperPath, [
      `const reply = ${JSON.stringify(piReply)};`,
      "const send = (event) => process.stdout.write(`${JSON.stringify(event)}\\n`);",
      "send({ type: 'message_start', message: { role: 'assistant', content: [] } });",
      "send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: reply } });",
      "setTimeout(() => {",
      "  send({ type: 'message_end', message: {",
      "    role: 'assistant', content: [{ type: 'text', text: reply }], stopReason: 'stop'",
      "  } });",
      "}, 1200);"
    ].join("\n"));
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
        name: "Pi Builder",
        role: "Streaming Runtime",
        adapter: "generic",
        runtimeKind: "pi",
        presetVersion: 3,
        command: [process.execPath, piHelperPath],
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
      stdio: ["ignore", "pipe", "pipe"]
    });
    bridgeProcess.stdout?.on("data", (source: Buffer) => {
      bridgeStdout = (bridgeStdout + source.toString()).slice(-2_000);
    });
    bridgeProcess.stderr?.on("data", (source: Buffer) => {
      bridgeStderr = (bridgeStderr + source.toString()).slice(-2_000);
    });

    stage = "wait for Echo Builder presence";
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

    stage = "wait for Echo Builder completion";
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

    stage = "wait for Pi Builder presence";
    const piAgent = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/teams/${teamId}/agents`, headers: authorization
      });
      return (response.json() as Array<{
        agentId: string;
        name: string;
        presence: string;
      }>).find((candidate) =>
        candidate.name === "Pi Builder" && candidate.presence === "ready"
      );
    });
    const piSent = await app.inject({
      method: "POST", url: `/api/rooms/${roomId}/messages`, headers: authorization,
      payload: { content: "Stream through real Bridge", mentionAgentId: piAgent.agentId }
    });
    assert.equal(piSent.statusCode, 200);
    const piRunId = piSent.json().runs[0].runId as string;
    stage = "wait for Pi Builder output before final reply";
    const previewEvents = await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/runs/${piRunId}/events?after=0`, headers: authorization
      });
      const events = response.json() as Array<{
        sequence: number;
        event: { type: string; content?: string };
      }>;
      const output = events.find(({ event }) => event.type === "output");
      const reply = events.find(({ event }) => event.type === "reply");
      return output && !reply ? events : undefined;
    });
    const preview = previewEvents.find(({ event }) => event.type === "output");
    assert.ok(preview);
    assert.ok(preview.event.content);
    assert.ok(piReply.startsWith(preview.event.content));
    const timelineBeforeReply = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}/messages?limit=100`, headers: authorization
    });
    assert.equal(
      timelineBeforeReply.json().items.some((item: { content: string }) => item.content === piReply),
      false
    );

    stage = "wait for Pi Builder completion";
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET", url: `/api/rooms/${roomId}/runs`, headers: authorization
      });
      const run = (response.json() as Array<{ runId: string; state: string }>).find(
        (candidate) => candidate.runId === piRunId
      );
      return run?.state === "completed" ? run : undefined;
    });
    const completedEventsResponse = await app.inject({
      method: "GET", url: `/api/runs/${piRunId}/events?after=0`, headers: authorization
    });
    const completedEvents = completedEventsResponse.json() as Array<{
      sequence: number;
      event: { type: string; content?: string };
    }>;
    const outputEvent = completedEvents.find(({ event }) => event.type === "output");
    const replyEvent = completedEvents.find(({ event }) => event.type === "reply");
    assert.ok(outputEvent);
    assert.ok(replyEvent);
    assert.ok(outputEvent.sequence < replyEvent.sequence);
    assert.equal(replyEvent.event.content, piReply);
    const resumedEvents = await app.inject({
      method: "GET",
      url: `/api/runs/${piRunId}/events?after=${outputEvent.sequence}`,
      headers: authorization
    });
    assert.ok((resumedEvents.json() as Array<{ event: { type: string } }>).some(
      ({ event }) => event.type === "reply"
    ));
    const piTimeline = await app.inject({
      method: "GET", url: `/api/rooms/${roomId}/messages?limit=100`, headers: authorization
    });
    assert.equal(
      piTimeline.json().items.filter((item: { content: string }) => item.content === piReply).length,
      1
    );

    stage = "wait for Slow Builder presence";
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
    stage = "wait for Slow Builder working state";
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
    stage = "wait for Slow Builder cancellation";
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
    throw new Error(
      `${String(error)}\nStage: ${stage}` +
      `\nBridge exit: code=${String(bridgeProcess?.exitCode)} signal=${String(bridgeProcess?.signalCode)}` +
      `\nBridge stdout:\n${bridgeStdout}\nBridge stderr:\n${bridgeStderr}`
    );
  } finally {
    if (bridgeProcess) await stopProcess(bridgeProcess);
    await app.close();
  }
});
