import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createServerApp } from "../../apps/server/src/app.js";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");

interface ProcessCapture {
  process: ChildProcess;
  stdout: () => string;
  stderr: () => string;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Device-onboarding state");
}

function captureProcess(
  executable: string,
  args: string[]
): ProcessCapture {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (source: Buffer) => {
    stdout = (stdout + source.toString()).slice(-8_000);
  });
  child.stderr?.on("data", (source: Buffer) => {
    stderr = (stderr + source.toString()).slice(-8_000);
  });
  return { process: child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForExit(capture: ProcessCapture, timeoutMs = 15_000): Promise<void> {
  if (capture.process.exitCode !== null) {
    assert.equal(capture.process.exitCode, 0, capture.stderr());
    return;
  }
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) =>
      capture.process.once("exit", (code) => resolve(code))
    ),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs)
    )
  ]);
  assert.notEqual(exitCode, "timeout", "Process did not exit in time");
  assert.equal(exitCode, 0, capture.stderr());
}

async function stopProcess(capture: ProcessCapture, signal: NodeJS.Signals): Promise<void> {
  if (capture.process.exitCode !== null) return;
  capture.process.kill(signal);
  await Promise.race([
    new Promise<void>((resolve) =>
      capture.process.once("exit", () => resolve())
    ),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000))
  ]);
}

async function startConsole(
  bridgeBinary: string,
  configPath: string
): Promise<ProcessCapture & { baseUrl: string; token: string }> {
  const capture = captureProcess(bridgeBinary, [
    "console",
    "--config",
    configPath,
    "--listen",
    "127.0.0.1:0",
    "--no-open"
  ]);
  const consoleUrl = await waitFor(async () => {
    const match = capture.stdout().match(/Bridge Console: (http:\/\/[^\s]+)/u);
    return match?.[1];
  });
  const parsed = new URL(consoleUrl);
  const token = parsed.searchParams.get("token");
  assert.ok(token);
  return {
    ...capture,
    baseUrl: parsed.origin,
    token
  };
}

async function consoleRequest<T>(
  console: { baseUrl: string; token: string },
  pathname: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${console.baseUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${console.token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
  const source = await response.text();
  assert.equal(
    response.status,
    200,
    `Console request failed: ${pathname}: ${source}`
  );
  return JSON.parse(source) as T;
}

test("one link pairs one Device with several Agents and recovers real Bridge work", {
  timeout: 120_000
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-device-e2e-"));
  const bridgeServerToken = "unused-zero-copy-server-token-12345678901234567890";
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    bridgeServerToken
  });
  let pairingProcess: ProcessCapture | undefined;
  let consoleProcess: Awaited<ReturnType<typeof startConsole>> | undefined;
  let stage = "setup";
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not bind TCP");
    }
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Alice" }
    });
    assert.equal(bootstrap.statusCode, 200);
    const authorization = {
      authorization: `Bearer ${bootstrap.json().session.token as string}`
    };
    const teamResponse = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: authorization,
      payload: { name: "One Device Team" }
    });
    const teamId = teamResponse.json().team.teamId as string;
    const roomResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: authorization,
      payload: { name: "acceptance" }
    });
    const roomId = roomResponse.json().roomId as string;

    stage = "build Bridge";
    const bridgeBinary = path.join(directory, "agentroom-bridge");
    const goBinary = process.env.AGENT_ROOM_GO_BIN ?? "go";
    await execFileAsync(goBinary, [
      "build",
      "-ldflags",
      "-X main.version=0.4.0-e2e",
      "-o",
      bridgeBinary,
      "./cmd/agentroom-bridge"
    ], { cwd: path.join(repositoryRoot, "bridge") });

    const dataDir = path.join(directory, "bridge-data");
    const configPath = path.join(directory, "bridge.json");
    const piHelperPath = path.join(directory, "pi-probe-helper.sh");
    await writeFile(piHelperPath, [
      "#!/bin/sh",
      "printf '%s\\n' '{\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"content\":[]}}'",
      "printf '%s\\n' '{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"AGENTROOM_READY\"}}'",
      "printf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"AGENTROOM_READY\"}],\"stopReason\":\"stop\"}}'"
    ].join("\n"));
    await chmod(piHelperPath, 0o700);
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 5,
      serverUrl,
      deviceName: "Acceptance Mac",
      dataDir,
      agents: [{
        name: "Probe Agent",
        role: "Ready Runtime",
        adapter: "generic",
        runtimeKind: "pi",
        presetVersion: 5,
        command: [piHelperPath],
        workspace: directory,
        workspaceAlias: "Acceptance Workspace",
        envAllowlist: []
      }, {
        name: "Slow Agent",
        role: "Long Running Runtime",
        adapter: "generic",
        runtimeKind: "generic",
        command: ["/bin/sh", "-c", "sleep 60; printf SLOW_DONE"],
        workspace: directory,
        workspaceAlias: "Slow Workspace",
        envAllowlist: []
      }]
    }, null, 2));
    const configSource = await readFile(configPath, "utf8");
    assert.equal(configSource.includes("serverToken"), false);

    stage = "create pairing session";
    const claimSecret = randomBytes(32).toString("base64url");
    const created = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions`,
      headers: authorization,
      payload: {
        operationId: "op_e2ecreate000000000000000000000001",
        claimSecret
      }
    });
    assert.equal(created.statusCode, 200, created.body);
    const pairingSessionId = created.json().pairingSessionId as string;
    const pairingLink = `agentroom://pair-device?${new URLSearchParams({
      origin: serverUrl,
      pairingSessionId,
      expiresAt: created.json().expiresAt as string
    }).toString()}#${new URLSearchParams({ claimSecret }).toString()}`;

    stage = "pair Device through canonical deep link";
    pairingProcess = captureProcess(bridgeBinary, [
      "pair-device",
      "--config",
      configPath,
      "--link",
      pairingLink
    ]);
    const ownerClaim = await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}`,
        headers: authorization
      });
      const body = response.json() as {
        state: string;
        verificationPhrase?: string;
      };
      return body.state === "claimed" ? body : undefined;
    });
    const localPhrase = await waitFor(async () =>
      pairingProcess?.stdout().match(
        /verify the phrase in Owner Web: ([A-Z]+-[A-Z]+-[0-9]{2})/u
      )?.[1]
    );
    assert.equal(localPhrase, ownerClaim.verificationPhrase);
    const approved = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}/approve`,
      headers: authorization,
      payload: {
        operationId: "op_e2eapprove00000000000000000000001",
        expectedState: "claimed"
      }
    });
    assert.equal(approved.statusCode, 200, approved.body);
    const deviceId = approved.json().deviceId as string;
    await waitForExit(pairingProcess);
    assert.equal(pairingProcess.stdout().includes(claimSecret), false);
    assert.equal(pairingProcess.stdout().includes(directory), false);
    assert.equal(pairingProcess.stdout().includes(bridgeServerToken), false);
    const credentialInfo = await stat(path.join(dataDir, "device-credential.json"));
    assert.equal(credentialInfo.mode & 0o777, 0o600);

    stage = "start paired Console and publish Agents";
    consoleProcess = await startConsole(bridgeBinary, configPath);
    const agents = await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${teamId}/agents`,
        headers: authorization
      });
      const candidates = response.json() as Array<{
        agentId: string;
        name: string;
        presence: string;
        workspaceRef?: string;
        workspaceAlias?: string;
      }>;
      return candidates.length === 2 && candidates.every(
        (agent) => agent.presence === "ready"
      ) ? candidates : undefined;
    });
    const devices = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/devices`,
      headers: authorization
    });
    assert.equal(devices.json().length, 1);
    assert.equal(devices.json()[0].deviceId, deviceId);
    const safeAgentProjection = JSON.stringify(agents);
    assert.equal(safeAgentProjection.includes(directory), false);
    assert.equal(safeAgentProjection.includes(piHelperPath), false);
    assert.deepEqual(
      agents.map((agent) => agent.workspaceAlias).sort(),
      ["Acceptance Workspace", "Slow Workspace"]
    );
    assert.ok(agents.every((agent) =>
      /^workspace_[A-Za-z0-9_-]+$/u.test(agent.workspaceRef ?? "")
    ));
    const probeAgent = agents.find((agent) => agent.name === "Probe Agent");
    const slowAgent = agents.find((agent) => agent.name === "Slow Agent");
    assert.ok(probeAgent && slowAgent);

    stage = "run explicit Runtime self-test";
    const consoleState = await consoleRequest<{
      agents: Array<{ agentId: string; name: string }>;
    }>(consoleProcess, "/api/state");
    const localProbe = consoleState.agents.find(
      (agent) => agent.name === "Probe Agent"
    );
    assert.ok(localProbe);
    const runtimeTest = await consoleRequest<{
      passed: boolean;
      code: string;
    }>(consoleProcess, "/api/runtime-tests", {
      method: "POST",
      body: JSON.stringify({ agentId: localProbe.agentId })
    });
    assert.deepEqual({
      passed: runtimeTest.passed,
      code: runtimeTest.code
    }, {
      passed: true,
      code: "RUNTIME_PROBE_OK"
    });

    stage = "queue offline work and reconnect";
    await stopProcess(consoleProcess, "SIGTERM");
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${teamId}/agents`,
        headers: authorization
      });
      return (response.json() as Array<{ presence: string }>).every(
        (agent) => agent.presence === "offline"
      ) ? true : undefined;
    });
    const offlineMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: authorization,
      payload: {
        content: "Complete exactly once after reconnect",
        mentionAgentId: probeAgent.agentId
      }
    });
    assert.equal(offlineMessage.statusCode, 200, offlineMessage.body);
    const offlineRunId = offlineMessage.json().runs[0].runId as string;
    assert.equal(offlineMessage.json().runs[0].state, "queued");
    consoleProcess = await startConsole(bridgeBinary, configPath);
    const reconnected = await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/runs/${offlineRunId}`,
        headers: authorization
      });
      const run = response.json() as { state: string };
      return run.state === "completed" ? run : undefined;
    });
    assert.equal(reconnected.state, "completed");
    const reconnectEvents = await app.inject({
      method: "GET",
      url: `/api/runs/${offlineRunId}/events`,
      headers: authorization
    });
    assert.equal(
      (reconnectEvents.json() as Array<{ event: { type: string } }>).filter(
        ({ event }) => event.type === "reply"
      ).length,
      1
    );

    stage = "leave accepted and pending Runs for Device revoke";
    const acceptedMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: authorization,
      payload: {
        content: "Hold this accepted Runtime",
        mentionAgentId: slowAgent.agentId
      }
    });
    assert.equal(acceptedMessage.statusCode, 200, acceptedMessage.body);
    const acceptedRunId = acceptedMessage.json().runs[0].runId as string;
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/runs/${acceptedRunId}`,
        headers: authorization
      });
      const run = response.json() as { state: string };
      return run.state === "working" ? true : undefined;
    });
    await stopProcess(consoleProcess, "SIGKILL");
    await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${teamId}/agents`,
        headers: authorization
      });
      return (response.json() as Array<{ presence: string }>).every(
        (agent) => agent.presence === "offline"
      ) ? true : undefined;
    });
    const pendingMessage = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/messages`,
      headers: authorization,
      payload: {
        content: "This delivery must not start",
        mentionAgentId: probeAgent.agentId
      }
    });
    assert.equal(pendingMessage.statusCode, 200, pendingMessage.body);
    const pendingRunId = pendingMessage.json().runs[0].runId as string;
    assert.equal(pendingMessage.json().runs[0].state, "queued");

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/teams/${teamId}/devices/${deviceId}`,
      headers: authorization
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(revoked.json().status, "revoked");
    const acceptedAfterRevoke = await app.inject({
      method: "GET",
      url: `/api/runs/${acceptedRunId}`,
      headers: authorization
    });
    const pendingAfterRevoke = await app.inject({
      method: "GET",
      url: `/api/runs/${pendingRunId}`,
      headers: authorization
    });
    assert.equal(acceptedAfterRevoke.json().state, "outcome_unknown");
    assert.equal(pendingAfterRevoke.json().state, "failed");
    const acceptedEvents = await app.inject({
      method: "GET",
      url: `/api/runs/${acceptedRunId}/events`,
      headers: authorization
    });
    const pendingEvents = await app.inject({
      method: "GET",
      url: `/api/runs/${pendingRunId}/events`,
      headers: authorization
    });
    assert.equal(
      acceptedEvents.json().at(-1).event.error.code,
      "RUN_DEVICE_REVOKED_OUTCOME_UNKNOWN"
    );
    assert.equal(
      pendingEvents.json().at(-1).event.error.code,
      "RUN_DEVICE_REVOKED"
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Device-onboarding E2E failed during ${stage}: ${detail}`, {
      cause: error
    });
  } finally {
    if (pairingProcess) await stopProcess(pairingProcess, "SIGTERM");
    if (consoleProcess) await stopProcess(consoleProcess, "SIGTERM");
    await app.close();
  }
});
