import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServerApp } from "../../apps/server/src/app.js";
import type { DiscussionView } from "../../apps/server/src/discussion/discussion-orchestrator.js";
import type { RunRecord } from "../../apps/server/src/run/run-repository.js";
import { createTestResources } from "../test/resources.mjs";
import { spawnTestProcess } from "../test/child-process.mjs";
import { cases } from "./discussion-cases.mjs";
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const terminal = new Set(["completed", "failed", "canceled", "expired", "outcome_unknown"]);
const model = process.env.CONVENE_WIRE_BENCH_MODEL ?? "gpt-5.4-mini";
const synthetic = process.env.CONVENE_WIRE_BENCH_SYNTHETIC === "1";

test("bounded real single-Agent and Discussion task pairs", {
  skip: !synthetic && process.env.CONVENE_WIRE_BENCH_LIVE !== "1", timeout: 1_260_000
}, async (t) => {
  const resources = await createTestResources(t, "convenewire-discussion-bench-");
  const directory = resources.directory;
  const output = synthetic ? path.join(directory, "report") : path.join(root, "var", "discussion-benchmark", new Date().toISOString().replaceAll(":", "-"));
  await mkdir(output, { recursive: true });
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const quotaDirectory = path.join(directory, "invocation-quota");
  await mkdir(quotaDirectory);
  const app = await createServerApp({ databasePath: path.join(directory, "server.sqlite") });
  resources.defer(() => app.close());
  const report = { version: 2, synthetic, sourceCommit: (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
    model, observedProviderModel: null, reasoningEffort: "low", runtime: "codex exec via generic Bridge adapter",
    runtimeVersion: "", maximumRuns: 12, maximumModelWorkSeconds: 1200,
    cases, results: [] as Array<Record<string, unknown>>, error: null as string | null };
  const sources = await Promise.all(["discussion-cases.mjs", "codex-answer.mjs", "discussion-benchmark.test.ts"]
    .map(async (name) => ({ name, sha256: createHash("sha256").update(
      await readFile(path.join(root, "scripts/bench", name))).digest("hex") })));
  Object.assign(report, { benchmarkSources: sources,
    workingTreeDirty: (await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.length > 0 });
  let currentAttempt: Record<string, unknown> | undefined;
  let scheduled = 0;
  let deadline = 0;
  const persist = () => writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  async function waitFor<T>(read: () => Promise<T | undefined>, timeout = 310_000): Promise<T> {
    const until = Math.min(Date.now() + timeout, deadline || Infinity);
    while (Date.now() < until) {
      const result = await read();
      if (result !== undefined) return result;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Benchmark time limit reached; no retry was started");
  }
  try {
    let codex: string;
    if (synthetic) {
      // This branch has no path to a real provider executable or auth environment.
      codex = path.join(directory, "synthetic-codex");
      await writeFile(codex, `#!${process.execPath}
` + [
        'if (process.argv.includes("--version")) { console.log("synthetic-runtime 1"); process.exit(0); }',
        'process.stdin.resume();',
        'process.stdin.on("end", () => console.log(JSON.stringify({type:"item.completed", item:{type:"agent_message", text:',
        JSON.stringify('Synthetic plumbing check only.\n<agentroom-assessment>\n' + JSON.stringify({
          goalSatisfied: false, confidence: 0.5, newInformationAdded: true,
          disagreementRemaining: "none", recommendation: "continue", reviewerApproved: true
        }) + '\n</agentroom-assessment>'),
        '}})));'
      ].join("\n"));
      await chmod(codex, 0o700);
    } else {
      codex = process.env.CONVENE_WIRE_CODEX_BIN ?? (await exec("which", ["codex"])).stdout.trim();
    }
    report.runtimeVersion = (await exec(codex, ["--version"])).stdout.trim();
    const bridge = path.join(directory, "convenewire-bridge");
    await exec("go", ["build", "-o", bridge, "./cmd/convenewire-bridge"],
      { cwd: path.join(root, "bridge"), timeout: 300_000 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const bootstrap = await app.inject({ method: "POST", url: "/api/bootstrap", payload: { displayName: "Benchmark Owner" } });
    assert.equal(bootstrap.statusCode, 200);
    const headers = { authorization: `Bearer ${bootstrap.json().session.token}` };
    async function request<T = any>(method: "GET" | "POST", url: string, payload?: object): Promise<T> {
      const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, 200, `Unexpected status for ${url}: ${response.statusCode}`);
      return response.json() as T;
    }
    const teamId = (await request("POST", "/api/teams", { name: "Isolated Discussion benchmark" })).team.teamId;
    const invite = await request("POST", `/api/teams/${teamId}/bridge-invites`, { deviceName: "Benchmark Bridge" });
    const config = path.join(directory, "bridge.json");
    await writeFile(config, JSON.stringify({ serverUrl: `http://127.0.0.1:${address.port}`,
      deviceName: "Benchmark Bridge", dataDir: path.join(directory, "bridge-data"),
      agents: ["Solver", "Reviewer"].map((name) => ({ name, role: name === "Solver" ? "Solution author" : "Decision reviewer",
        adapter: "generic", runtimeKind: "generic", workspace, sandbox: "read-only",
        command: [process.execPath, path.join(root, "scripts/bench/codex-answer.mjs"), codex, model, quotaDirectory],
        envAllowlist: synthetic ? ["PATH"] : ["HOME", "PATH", "CODEX_HOME"] }))
    }));
    await exec(bridge, ["pair", "--config", config, "--code", invite.code], { timeout: 30_000 });
    spawnTestProcess(resources, bridge, ["run", "--config", config], { stdio: "ignore" });
    const agents = await waitFor(async () => {
      const rows = await request<Array<{ agentId: string; name: string; presence: string }>>("GET", `/api/teams/${teamId}/agents`);
      return rows.length === 2 && rows.every(({ presence }) => presence === "ready") ? rows : undefined;
    }, 30_000);
    const solver = agents.find(({ name }) => name === "Solver")!;
    const reviewer = agents.find(({ name }) => name === "Reviewer")!;
    deadline = Date.now() + 1_200_000;
    for (const [index, sample] of cases.entries()) {
      // Alternate pair order to avoid assigning all warm-cache advantage to one arm.
      for (const arm of index % 2 === 0 ? ["single_agent", "discussion"] : ["discussion", "single_agent"]) {
        assert.ok(Date.now() < deadline && scheduled + (arm === "discussion" ? 3 : 1) <= 12);
        const room = await request("POST", `/api/teams/${teamId}/rooms`, { name: `${sample.id}-${arm}` });
        const goal = `Closed-input benchmark: answer only from the task below. Do not use tools, read files, access the network, or modify anything. Give a concise English answer under 350 words. Do not propose execution plans.\n\n${sample.prompt}`;
        const startedAt = Date.now();
        currentAttempt = { caseId: sample.id, arm,
          promptSha256: createHash("sha256").update(goal).digest("hex"),
          runCount: null, runtimeSucceeded: null, finalAnswer: null, answers: [],
          manualRubric: sample.rubric.map((criterion: string) => ({ criterion, passed: null, evidence: null })) };
        report.results.push(currentAttempt);
        await persist();
        let discussion: DiscussionView | undefined;
        let runIds: string[] = [];
        if (arm === "single_agent") {
          const response = await request("POST", `/api/rooms/${room.roomId}/messages`, { content: goal, mentionAgentId: solver.agentId });
          runIds = response.runs.map((run: RunRecord) => run.runId);
          assert.equal(runIds.length, 1);
          scheduled += 1;
        } else {
          discussion = await request<DiscussionView>("POST", `/api/rooms/${room.roomId}/discussions`, {
            goal, participantAgentIds: [solver.agentId, reviewer.agentId], mode: "review", outputMode: "final_answer",
            policy: { initialLeaseTurns: 1, automaticMaxTurns: 1, hardMaxTurns: 3,
              maxDurationSeconds: 300, waveTimeoutSeconds: 300, requireReviewer: true, allowAutomaticFinish: false }
          });
          scheduled += 2;
          discussion = await waitFor(async () => {
            const view = await request<DiscussionView>("GET", `/api/discussions/${discussion!.discussion.discussionId}`);
            return ["active", "stop_requested"].includes(view.discussion.state) ? undefined : view;
          });
          if (discussion.turns.every(({ state }) => state === "completed") && discussion.discussion.state === "awaiting_extension") {
            discussion = await request("POST", `/api/discussions/${discussion.discussion.discussionId}/actions`, { action: "finish" });
            scheduled += 1;
            discussion = await waitFor(async () => {
              const view = await request<DiscussionView>("GET", `/api/discussions/${discussion!.discussion.discussionId}`);
              return view.discussion.state === "finalizing" ? undefined : view;
            });
          }
        }
        const runs = await waitFor(async () => {
          const rows = await request<RunRecord[]>("GET", `/api/rooms/${room.roomId}/runs`);
          return rows.length && rows.every(({ state }) => terminal.has(state)) ? rows : undefined;
        });
        runIds = runs.map(({ runId }) => runId);
        const messages = await request("GET", `/api/rooms/${room.roomId}/messages?limit=100`);
        const answers = messages.items.filter((message: any) => message.senderType === "agent")
          .map(({ senderId, content }: any) => ({ agent: agents.find(({ agentId }) => agentId === senderId)?.name, content }));
        const success = runs.every(({ state }) => state === "completed") && answers.length > 0 &&
          (arm === "single_agent" || discussion?.discussion.state === "completed");
        Object.assign(currentAttempt, { caseId: sample.id, arm, promptSha256: createHash("sha256").update(goal).digest("hex"),
          elapsedMilliseconds: Date.now() - startedAt, runCount: runIds.length,
          runs: runs.map(({ state, createdAt, terminalAt }) => ({ state, createdAt, terminalAt })),
          discussionUsage: discussion?.observedUsage ?? null,
          selection: discussion?.waves.map(({ selection }) => selection) ?? null,
          answers, finalAnswer: answers.at(-1)?.content ?? null, runtimeSucceeded: success,
          manualRubric: sample.rubric.map((criterion: string) => ({ criterion, passed: null, evidence: null })) });
        await persist();
        console.log(`${sample.id} ${arm}: ${runs.length} Runs, ${Date.now() - startedAt}ms, runtime ${success ? "completed" : "failed"}`);
        assert.ok(success, "Runtime failure retained in report; remaining paid runs were not started");
      }
    }
    assert.equal(scheduled, 12);
    assert.equal(Object.hasOwn(report, "tokens"), false);
    assert.equal(Object.hasOwn(report, "cost"), false);
    for (const result of report.results) {
      if (result.discussionUsage) {
        assert.equal(Object.hasOwn(result.discussionUsage, "tokens"), false);
        assert.equal(Object.hasOwn(result.discussionUsage, "estimatedCostMicros"), false);
      }
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : "Benchmark failed";
    if (currentAttempt) Object.assign(currentAttempt, { error: report.error,
      runtimeSucceeded: false, observationIncomplete: currentAttempt.runCount === null });
    throw error;
  } finally {
    await persist();
    console.log(`Benchmark report: ${path.relative(root, path.join(output, "report.json"))}`);
  }
});
