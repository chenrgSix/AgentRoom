import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createServerApp } from "../../apps/server/src/app.js";

const execFileAsync = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const liveRuntimeEnabled = process.env.AGENT_ROOM_LIVE_RUNTIME_E2E === "1";

interface DiscussionView {
  discussion: {
    discussionId: string;
    state: string;
    stateReason: string | null;
    currentTurn: number;
    budget: { extensions: number };
  };
  turns: Array<{
    kind: "discussion" | "finalization";
    speakerAgentId: string;
    state: string;
    assessment: unknown;
  }>;
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 240_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for live Runtime state");
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => process.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000))
  ]);
  if (!exited && process.exitCode === null) {
    process.kill("SIGKILL");
  }
}

async function executable(name: string, override: string | undefined): Promise<string> {
  if (override) return path.resolve(override);
  const result = await execFileAsync("which", [name]);
  return result.stdout.trim();
}

test("real Codex and Pi complete one governed Discussion", {
  timeout: 300_000,
  skip: !liveRuntimeEnabled
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-live-discussion-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite")
  });
  let bridgeProcess: ChildProcess | undefined;
  let bridgeStderr = "";
  try {
    const [codexBinary, piBinary] = await Promise.all([
      executable("codex", process.env.AGENT_ROOM_CODEX_BIN),
      executable("pi", process.env.AGENT_ROOM_PI_BIN)
    ]);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not bind TCP");
    }
    const serverUrl = `http://127.0.0.1:${address.port}`;

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Live QA Owner" }
    });
    assert.equal(bootstrap.statusCode, 200);
    const webToken = bootstrap.json().session.token as string;
    const authorization = { authorization: `Bearer ${webToken}` };
    const teamResponse = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: authorization,
      payload: { name: "Live Codex Pi QA" }
    });
    assert.equal(teamResponse.statusCode, 200);
    const teamId = teamResponse.json().team.teamId as string;
    const roomResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/rooms`,
      headers: authorization,
      payload: { name: "runtime-review" }
    });
    assert.equal(roomResponse.statusCode, 200);
    const roomId = roomResponse.json().roomId as string;
    const inviteResponse = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/bridge-invites`,
      headers: authorization,
      payload: { deviceName: "Live Runtime Bridge" }
    });
    assert.equal(inviteResponse.statusCode, 200);

    const bridgeBinary = path.join(directory, "agentroom-bridge");
    await execFileAsync(process.env.AGENT_ROOM_GO_BIN ?? "go", [
      "build", "-o", bridgeBinary, "./cmd/agentroom-bridge"
    ], { cwd: path.join(repositoryRoot, "bridge") });
    const configPath = path.join(directory, "bridge.json");
    await writeFile(configPath, JSON.stringify({
      serverUrl,
      deviceName: "Live Runtime Bridge",
      dataDir: path.join(directory, "bridge-data"),
      agents: [{
        name: "Live Codex Solver",
        role: "Solution author",
        adapter: "codex",
        command: [
          codexBinary,
          "exec",
          "--json",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "-"
        ],
        workspace: repositoryRoot,
        envAllowlist: ["HOME", "PATH", "CODEX_HOME"]
      }, {
        name: "Live Pi Reviewer",
        role: "Decision reviewer",
        adapter: "generic",
        command: [
          piBinary,
          "--print",
          "--no-tools",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-session"
        ],
        workspace: repositoryRoot,
        envAllowlist: ["HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_TELEMETRY"]
      }]
    }, null, 2));
    await execFileAsync(bridgeBinary, [
      "pair", "--config", configPath, "--code", inviteResponse.json().code as string
    ]);
    bridgeProcess = spawn(bridgeBinary, ["run", "--config", configPath], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    bridgeProcess.stderr?.on("data", (source: Buffer) => {
      bridgeStderr += source.toString();
    });

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
      }>;
      const codex = candidates.find(({ name, presence }) =>
        name === "Live Codex Solver" && presence === "ready"
      );
      const pi = candidates.find(({ name, presence }) =>
        name === "Live Pi Reviewer" && presence === "ready"
      );
      return codex && pi ? { codex, pi } : undefined;
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/rooms/${roomId}/discussions`,
      headers: authorization,
      payload: {
        goal: [
          "用简短中文确定一条 Agent Room 控制原则：Agent 提供结构化判断，",
          "Orchestrator 决定流程，用户保留最终控制。不要调用工具或修改文件。",
          "Solver 首轮提出具体表述并报告 newInformationAdded=true；",
          "Reviewer 下一轮检查后报告 reviewerApproved=true。"
        ].join(""),
        participantAgentIds: [agents.codex.agentId, agents.pi.agentId],
        mode: "review",
        outputMode: "decision_record",
        policy: {
          initialLeaseTurns: 1,
          automaticMaxTurns: 2,
          hardMaxTurns: 4,
          maxDurationSeconds: 300,
          plateauWindow: 2,
          minimumCompletionConfidence: 0.8,
          finalizationReserveTurns: 1,
          requireReviewer: true,
          allowAutomaticFinish: false
        }
      }
    });
    assert.equal(started.statusCode, 200, started.body);
    const discussionId = started.json().discussion.discussionId as string;

    const softBoundary = await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/discussions/${discussionId}`,
        headers: authorization
      });
      const view = response.json() as DiscussionView;
      return view.discussion.state === "awaiting_extension" ? view : undefined;
    });
    const ordinaryTurns = softBoundary.turns.filter(({ kind }) => kind === "discussion");
    assert.deepEqual(
      ordinaryTurns.map(({ speakerAgentId }) => speakerAgentId),
      [agents.codex.agentId, agents.pi.agentId]
    );
    assert.ok(ordinaryTurns.every(({ state }) => state === "completed"));
    assert.ok(ordinaryTurns.every(({ assessment }) => assessment !== null));
    assert.equal(softBoundary.discussion.budget.extensions, 1);

    const finish = await app.inject({
      method: "POST",
      url: `/api/discussions/${discussionId}/actions`,
      headers: authorization,
      payload: { action: "finish" }
    });
    assert.equal(finish.statusCode, 200, finish.body);
    const completed = await waitFor(async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/discussions/${discussionId}`,
        headers: authorization
      });
      const view = response.json() as DiscussionView;
      return view.discussion.state === "completed" ? view : undefined;
    });
    assert.equal(completed.discussion.stateReason, "user_requested_finish");
    assert.deepEqual(
      completed.turns.map(({ kind, speakerAgentId }) => [kind, speakerAgentId]),
      [
        ["discussion", agents.codex.agentId],
        ["discussion", agents.pi.agentId],
        ["finalization", agents.pi.agentId]
      ]
    );
    const timeline = await app.inject({
      method: "GET",
      url: `/api/rooms/${roomId}/messages?limit=100`,
      headers: authorization
    });
    const messages = timeline.json().items as Array<{
      senderId: string;
      content: string;
    }>;
    assert.ok(messages.some(({ senderId }) => senderId === agents.codex.agentId));
    assert.ok(messages.filter(({ senderId }) => senderId === agents.pi.agentId).length >= 2);
    assert.ok(messages.at(-1)?.content.trim());
  } catch (error) {
    throw new Error(`${String(error)}\nBridge stderr:\n${bridgeStderr}`);
  } finally {
    if (bridgeProcess) await stopProcess(bridgeProcess);
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
