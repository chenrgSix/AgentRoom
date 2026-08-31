import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { RepositoryCheckpoint, RepositoryOperationRequest } from "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { ArtifactPublicationRepository } from "../src/artifact/artifact-publication-repository.js";
import { LocalArtifactBlobStore } from "../src/artifact/local-artifact-blob-store.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { capability, workspaceFixture } from "./helpers/isolated-workspace-fixture.js";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
type ProcessResult = {
  CaptureDigest: string; WorkPath: string; CandidateCommit: string; CandidateTree: string;
  Error: string; Checkpoint: RepositoryCheckpoint;
};

async function runCapture(binary: string, input: unknown, signal: AbortSignal): Promise<ProcessResult> {
  const child = spawn(binary, ["-test.run=^TestCapturePublicationHTTPProcess$", "-test.timeout=50s"], {
    env: { ...process.env, CONVENE_WIRE_CAPTURE_HTTP_PROCESS: "1" }, stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "", error = "", exceeded = false, startError: Error | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
    if (output.length > 1 << 20) { exceeded = true; child.kill("SIGKILL"); }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    error += chunk;
    if (error.length > 1 << 20) { exceeded = true; child.kill("SIGKILL"); }
  });
  child.once("error", (error) => { startError = error; });
  // Always observe terminal close, including spawn failure or cancellation,
  // before a test cleanup is allowed to remove the owned repository directory.
  const closed = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
  const abort = () => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => child.kill("SIGKILL"), 55_000);
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(input));
  try {
    const code = await closed;
    assert.equal(startError, undefined);
    assert.equal(exceeded, false, "process output exceeded the fixture limit");
    assert.equal(code, 0, `${output}\n${error}`);
    const result = output.split("\n").find((line) => line.startsWith("CAPTURE_RESULT "));
    assert.ok(result, "Go process did not emit its fixture observation");
    return JSON.parse(result.slice("CAPTURE_RESULT ".length));
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

test("real Go capture publication seals actual Git bytes and reconciles lost responses across process restart", { timeout: 180_000 }, async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "convene-wire-go-capture-http-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, process.platform === "win32" ? "capture.test.exe" : "capture.test");
  await exec("go", ["test", "-c", "-o", binary, "./internal/repository"], {
    cwd: path.join(repositoryRoot, "bridge"), timeout: 90_000, maxBuffer: 2 << 20
  });
  const gitEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP, TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Capture fixture", GIT_AUTHOR_EMAIL: "capture@example.invalid",
    GIT_COMMITTER_NAME: "Capture fixture", GIT_COMMITTER_EMAIL: "capture@example.invalid"
  };
  const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-c", `core.hooksPath=${os.devNull}`, ...args], {
    cwd, env: gitEnv, timeout: 30_000, maxBuffer: 2 << 20
  })).stdout.trim();

  for (const mode of ["lost-responses", "bound-restart", "committed-restart", "uncommitted-restart"] as const) {
    await t.test(mode, async (t) => {
      const source = path.join(directory, mode, "source"), state = path.join(directory, mode, "owner-state");
      await mkdir(path.join(source, "src"), { recursive: true, mode: 0o700 });
      await mkdir(state, { recursive: true, mode: 0o700 });
      await writeFile(path.join(source, "src", "app.txt"), "base\n");
      await git(source, "init", "--template=", "-b", "main", ".");
      await git(source, "add", "--all");
      await git(source, "commit", "-m", "approved fixture base");
      const baseCommit = await git(source, "rev-parse", "HEAD");
      const now = new Date().toISOString();
      const f = await workspaceFixture(t, false, {
        now, clock: () => new Date().toISOString(),
        configurePlan: (definition) => {
          for (const node of definition.nodes) { if (node.repository) node.repository.baseCommit = baseCommit; }
        }
      });
      const lease = f.reserve();
      f.freeze();
      const authorization = `Bearer ${f.credential.secret}`;
      // Only the future-admission metadata fixture is synthetic. Actual Go
      // preparation/capture/HTTP publication runs below; no Agent is started.
      const socket = await f.app.injectWS("/ws/bridge", { headers: { authorization, host: "127.0.0.1" } });
      const ready = once(socket, "message", { signal: t.signal });
      socket.send(JSON.stringify({ protocolVersion: "1.0", messageId: "msg_real_capture_hello0001", timestamp: now,
        type: "bridge.hello", payload: { deviceId: f.device.deviceId, connectionEpoch: 1,
          bridgeVersion: "v0.4.0-fixture.1", supportedProtocolVersions: ["1.0"], governedExecution: capability } }));
      const [frame] = await ready;
      assert.equal(JSON.parse(String(frame)).type, "run.requested");
      const initialRun = f.database.prepare("SELECT state FROM runs WHERE run_id = ?").get(f.manifest.scope.runId);
      const serverURL = await f.app.listen({ host: "127.0.0.1", port: 0 });
      const operation: RepositoryOperationRequest = {
        version: 1, operationId: "op_real_capture0001", requestDigest: "",
        plan: { planId: f.plan.planId, revision: f.plan.current.revision, digest: f.plan.current.digest,
          approvalOperationId: f.manifest.scope.approvalOperationId, roomId: f.roomId, rootTaskId: f.root.taskId },
        execution: f.manifest.scope, repositoryId: f.manifest.repository.repositoryId, bindingId: f.manifest.repository.bindingId,
        deviceId: f.device.deviceId, grant: f.manifest.grant, expectedGeneration: lease.generation, deadline: f.manifest.deadline,
        action: { kind: "capture", capture: { manifestDigest: f.manifest.manifestDigest } }
      };
      const { requestDigest: _, ...unsigned } = operation;
      operation.requestDigest = executionOperationDigest(unsigned);
      const counts = new Map<string, number>();
      let dropBind = true, dropCheckpoint = true, blockLookup = mode === "committed-restart", leakedPath = false;
      let checkpointAttempted = false;
      const proxy = createServer(async (request, response) => {
        try {
          const url = request.url!, key = `${request.method} ${url}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
          const parts: Buffer[] = [];
          for await (const chunk of request) parts.push(Buffer.from(chunk));
          const body = Buffer.concat(parts);
          leakedPath ||= body.includes(source) || body.includes(state);
          if (request.method === "GET" && url.endsWith("/checkpoint") && blockLookup && checkpointAttempted) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { code: "TEST_UNAVAILABLE", message: "Fixture lookup unavailable" } }));
            return;
          }
          if (url === "/api/bridge/repository-checkpoints") {
            checkpointAttempted = true;
            if (dropCheckpoint && mode === "uncommitted-restart") { dropCheckpoint = false; response.destroy(); return; }
          }
          const upstream = await fetch(serverURL + url, {
            method: request.method,
            signal: AbortSignal.any([t.signal, AbortSignal.timeout(15_000)]),
            headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
            ...(body.length ? { body } : {})
          });
          const result = Buffer.from(await upstream.arrayBuffer());
          if (upstream.ok && url.endsWith("/bind") && dropBind) {
            if (mode !== "bound-restart") dropBind = false;
            response.destroy(); return;
          }
          if (upstream.ok && url === "/api/bridge/repository-checkpoints" && dropCheckpoint) {
            dropCheckpoint = false; response.destroy(); return;
          }
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(result);
        } catch { response.destroy(); }
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      t.after(async () => { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); });
      const address = proxy.address();
      assert.ok(address && typeof address !== "string");
      const input = { ServerURL: `http://127.0.0.1:${address.port}`, Token: f.credential.secret,
        SourcePath: source, StatePath: state, Manifest: f.manifest, Operation: operation,
        ExpectError: mode !== "lost-responses" };
      const first = await runCapture(binary, input, t.signal);
      const artifactPosts = () => counts.get("POST /api/bridge/artifact-publications") ?? 0;
      assert.equal(artifactPosts(), 1);
      if (input.ExpectError) assert.match(first.Error, /outcome is unknown/u);
      else assert.equal(first.Error, "");
      assert.equal((f.database.prepare("SELECT count(*) AS n FROM repository_checkpoints").get() as { n: number }).n,
        mode === "bound-restart" || mode === "uncommitted-restart" ? 0 : 1);
      // Late/uncollected edits must not change a sealed candidate on restart.
      await writeFile(path.join(first.WorkPath, "src", "app.txt"), "later uncollected edit\n");
      blockLookup = false;
      dropBind = false;
      const second = await runCapture(binary, { ...input, CaptureDigest: first.CaptureDigest, ExpectError: false }, t.signal);
      assert.equal(second.Error, "");
      assert.equal(artifactPosts(), mode === "bound-restart" ? 2 : 1, "unexpected publication intent retry");
      assert.equal(second.Checkpoint.candidateCommit, first.CandidateCommit);
      assert.equal(second.Checkpoint.candidateTree, first.CandidateTree);
      const stored = await f.ok("GET", `/api/bridge/repository-captures/${operation.operationId}/checkpoint`, undefined, authorization);
      assert.deepEqual(second.Checkpoint, stored);
      const pin = second.Checkpoint.outputs[0]!.artifact;
      const artifact = new ArtifactRepository(f.database).get(pin.artifactId)!;
      assert.equal(pin.artifactRevision, artifact.artifactRevision);
      assert.ok(pin.artifactRevision > 0);
      const content = new ArtifactPublicationRepository(f.database).getContent(artifact.contentId!)!;
      const dbPath = (f.database.pragma("database_list") as Array<{ file: string }>)[0]!.file;
      const patch = new LocalArtifactBlobStore(path.join(path.dirname(dbPath), "artifact-blobs"))
        .readVerified(content.storageKey, pin.contentDigest, pin.byteLength);
      assert.match(patch.toString(), /\+implemented through real capture/u);
      assert.doesNotMatch(patch.toString(), /later uncollected/u);
      const verification = path.join(directory, mode, "roundtrip");
      await git(directory, "clone", "--no-local", "--", source, verification);
      const patchPath = path.join(directory, mode, "returned.patch");
      await writeFile(patchPath, patch);
      await git(verification, "apply", "--index", "--", patchPath);
      assert.equal(await git(verification, "write-tree"), first.CandidateTree);
      assert.equal(await git(source, "rev-parse", "HEAD"), baseCommit);
      assert.equal(await git(source, "status", "--porcelain"), "");
      assert.equal(await readFile(path.join(first.WorkPath, "src", "app.txt"), "utf8"), "later uncollected edit\n");
      const callsBeforeReplay = [...counts];
      const third = await runCapture(binary, { ...input, CaptureDigest: first.CaptureDigest, ExpectError: false }, t.signal);
      assert.deepEqual(third.Checkpoint, second.Checkpoint);
      assert.deepEqual([...counts], callsBeforeReplay, "confirmed local replay performed new HTTP operations");
      await runCapture(binary, { ...input, CaptureDigest: first.CaptureDigest, Title: "Changed intent", ExpectError: true }, t.signal);
      assert.deepEqual([...counts], callsBeforeReplay, "changed replay intent reached HTTP");
      assert.equal(leakedPath, false);
      assert.ok(![...counts.keys()].some((key) => key.includes("read-source") || key.includes("source-snapshots")));
      assert.equal([...counts].filter(([key]) => key.endsWith("/chunks")).reduce((sum, [, count]) => sum + count, 0), 1);
      assert.deepEqual(f.database.prepare("SELECT state FROM runs WHERE run_id = ?").get(f.manifest.scope.runId), initialRun);
      for (const table of ["repository_checkpoints", "repository_checkpoint_outputs", "task_artifact_refs", "artifact_publications"]) {
        assert.equal((f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 1);
      }
    });
  }
});
