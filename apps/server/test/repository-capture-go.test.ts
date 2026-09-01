import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  RepositoryCheckpoint,
  RepositoryOperationRequest,
  VerificationReceipt
} from "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { ArtifactPublicationRepository } from "../src/artifact/artifact-publication-repository.js";
import { LocalArtifactBlobStore } from "../src/artifact/local-artifact-blob-store.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";
import { inspectCommitBundleEnvelope } from "../src/artifact/commit-bundle-envelope.js";
import { planIsolatedWorkspace } from "../src/workspace/isolated-workspace-lease-service.js";
import {
  capability,
  capabilityForManifest,
  workspaceFixture
} from "./helpers/isolated-workspace-fixture.js";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
type ProcessResult = {
  CaptureDigest: string; WorkPath: string; PreparedTree: string; CandidateCommit: string; CandidateTree: string;
  Error: string; Checkpoint: RepositoryCheckpoint;
  CleanupPreview?: { digest: string; path: string; branch: string };
  CleanupReceipt?: { digest: string; removedWorktree: string; removedBranch: string; checkpointId: string };
};
type VerificationProcessResult = {
  error: string;
  receipts: Array<{
    receipt: VerificationReceipt;
    receiptDigest: string;
    recordedAt: string;
  }>;
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

async function runVerification(
  binary: string,
  input: unknown,
  signal: AbortSignal
): Promise<VerificationProcessResult> {
  const child = spawn(binary, [
    "-test.run=^TestGovernedVerificationHTTPProcess$",
    "-test.timeout=40s"
  ], {
    env: {
      ...process.env,
      CONVENE_WIRE_VERIFICATION_HTTP_PROCESS: "1"
    },
    stdio: ["pipe", "pipe", "pipe"]
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
  child.once("error", (cause) => { startError = cause; });
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code))
  );
  const abort = () => child.kill("SIGKILL");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(input));
  try {
    const code = await closed;
    assert.equal(startError, undefined);
    assert.equal(exceeded, false, "verification fixture output exceeded its limit");
    assert.equal(code, 0, `${output}\n${error}`);
    const result = output.split("\n").find((line) =>
      line.startsWith("VERIFICATION_RESULT ")
    );
    assert.ok(result, "Go verifier process did not emit its observation");
    return JSON.parse(result.slice("VERIFICATION_RESULT ".length));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

test("real Go capture publication seals actual Git bytes and reconciles lost responses across process restart", { timeout: 240_000 }, async (t) => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "convene-wire-go-capture-http-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, process.platform === "win32" ? "capture.test.exe" : "capture.test");
  const verificationBinary = path.join(
    directory,
    process.platform === "win32" ? "verification.test.exe" : "verification.test"
  );
  await Promise.all([
    exec("go", ["test", "-c", "-o", binary, "./internal/repository"], {
      cwd: path.join(repositoryRoot, "bridge"), timeout: 90_000, maxBuffer: 2 << 20
    }),
    exec("go", ["test", "-c", "-o", verificationBinary, "./internal/admission"], {
      cwd: path.join(repositoryRoot, "bridge"), timeout: 90_000, maxBuffer: 2 << 20
    })
  ]);
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
      await git(source, "init", "--template=", `--object-format=${mode === "bound-restart" ? "sha256" : "sha1"}`, "-b", "main", ".");
      await git(source, "add", "--all");
      await git(source, "commit", "-m", "approved fixture base");
      const baseCommit = await git(source, "rev-parse", "HEAD");
      const now = new Date().toISOString();
      const f = await workspaceFixture(t, false, {
        now, clock: () => new Date().toISOString(),
        configurePlan: (definition) => {
          for (const node of definition.nodes) {
            if (node.repository) node.repository.baseCommit = baseCommit;
            node.outputs.push({ slotKey: "commit", kind: "commit", required: true });
            if (mode === "lost-responses") node.outputs.push(
              { slotKey: "document", kind: "document", required: true },
              { slotKey: "report", kind: "test_result", required: true }
            );
          }
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
      socket.send(JSON.stringify({ protocolVersion: "1.0", messageId: "msg_real_capture_agentpub0001", timestamp: now,
        type: "agent.publish", payload: {
          agentId: f.agent.agentId,
          capabilities: { ...f.agent.capabilities,
            governedExecution: capabilityForManifest(f.manifest), invocationMode: "managed" },
          deviceId: f.device.deviceId,
          name: f.agent.name,
          ownerMemberId: f.agent.ownerMemberId,
          role: f.agent.role,
          teamId: f.teamId,
          workspaceRef: f.agent.workspaceRef,
          workspaceGeneration: f.agent.workspaceGeneration
        } }));
      const [frame] = await ready;
      assert.equal(JSON.parse(String(frame)).type, "run.requested");
      assert.equal(f.connections.recordGovernedAgentCapability(
        f.device.deviceId,
        1,
        f.agent.agentId,
        capabilityForManifest(f.manifest)
      ), true);
      const initialRun = f.database.prepare("SELECT state FROM runs WHERE run_id = ?").get(f.manifest.scope.runId);
      const initialTask = await f.ok("GET", `/api/tasks/${f.task.taskId}`);
      assert.ok(["ready", "active", "review"].includes(initialTask.lifecycleState));
      assert.equal(initialTask.completionResultId, null);
      const outputCount = f.manifest.outputs.length;
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
      assert.equal(artifactPosts(), mode === "bound-restart" ? 1 : outputCount);
      if (input.ExpectError) assert.match(first.Error, /outcome is unknown/u);
      else assert.equal(first.Error, "");
      assert.equal((f.database.prepare("SELECT count(*) AS n FROM repository_checkpoints").get() as { n: number }).n,
        mode === "bound-restart" || mode === "uncommitted-restart" ? 0 : 1);
      // Late/uncollected edits must not change a sealed candidate on restart.
      await writeFile(path.join(first.WorkPath, "src", "app.txt"), "later uncollected edit\n");
      if (mode === "lost-responses") {
        await writeFile(path.join(first.WorkPath, "src", "review.md"), "later uncollected review\n");
        await writeFile(path.join(first.WorkPath, "src", "results.json"), "later invalid JSON\n");
      }
      blockLookup = false;
      dropBind = false;
      const second = await runCapture(binary, { ...input, CaptureDigest: first.CaptureDigest, ExpectError: false }, t.signal);
      assert.equal(second.Error, "");
      assert.equal(artifactPosts(), mode === "bound-restart" ? outputCount + 1 : outputCount, "unexpected publication intent retry");
      assert.equal(second.Checkpoint.candidateCommit, first.CandidateCommit);
      assert.equal(second.Checkpoint.candidateTree, first.CandidateTree);
      const stored = await f.ok("GET", `/api/bridge/repository-captures/${operation.operationId}/checkpoint`, undefined, authorization);
      assert.deepEqual(second.Checkpoint, stored);
      const pin = second.Checkpoint.outputs.find((output) => output.artifact.kind === "patch")!.artifact;
      const artifact = new ArtifactRepository(f.database).get(pin.artifactId)!;
      assert.equal(pin.artifactRevision, artifact.artifactRevision);
      assert.ok(pin.artifactRevision > 0);
      const content = new ArtifactPublicationRepository(f.database).getContent(artifact.contentId!)!;
      const dbPath = (f.database.pragma("database_list") as Array<{ file: string }>)[0]!.file;
      const verifyCommitOutput = async (checkpoint: RepositoryCheckpoint, suffix: string) => {
        const pin = checkpoint.outputs.find((output) => output.artifact.kind === "commit")!.artifact;
        const artifact = new ArtifactRepository(f.database).get(pin.artifactId)!;
        const content = new ArtifactPublicationRepository(f.database).getContent(artifact.contentId!)!;
        const bytes = new LocalArtifactBlobStore(path.join(path.dirname(dbPath), "artifact-blobs"))
          .readVerified(content.storageKey, pin.contentDigest, pin.byteLength);
        assert.equal(artifact.commitSha, checkpoint.candidateCommit);
        assert.equal(artifact.contentMediaType, "application/x-git-bundle");
        assert.deepEqual(inspectCommitBundleEnvelope(bytes), {
          objectFormat: baseCommit.length === 40 ? "sha1" : "sha256",
          prerequisiteCommit: baseCommit, candidateCommit: checkpoint.candidateCommit
        });
        const consumer = path.join(directory, mode, `${suffix}-commit-consumer`);
        const bundleFile = path.join(directory, mode, `${suffix}.bundle`);
        await writeFile(bundleFile, bytes);
        await git(directory, "clone", "--no-local", "--", source, consumer);
        const refs = await git(consumer, "show-ref");
        await git(consumer, "bundle", "verify", bundleFile);
        await git(consumer, "bundle", "unbundle", bundleFile);
        await git(consumer, "fsck", "--strict", "--no-reflogs", checkpoint.candidateCommit);
        assert.equal(await git(consumer, "rev-parse", `${checkpoint.candidateCommit}^{tree}`), checkpoint.candidateTree);
        assert.equal(await git(consumer, "rev-parse", `${checkpoint.candidateCommit}^`), baseCommit);
        assert.equal(await git(consumer, "show", `${checkpoint.candidateCommit}:src/app.txt`), "implemented through real capture");
        assert.equal(await git(consumer, "show-ref"), refs, "reading commit content promoted a ref");
        assert.equal(await git(consumer, "status", "--porcelain"), "");
      };
      await verifyCommitOutput(second.Checkpoint, "published");
      const core = new CoreRepository(f.database);
      const trigger = f.database.prepare("SELECT trigger_message_id FROM runs WHERE run_id = ?").get(f.manifest.scope.runId) as { trigger_message_id: string };
      const message = core.getMessage(trigger.trigger_message_id)!;
      const legacy = new ContextPlanner(f.database, core, new AgentTaskRepository(f.database)).plan({
        roomId: f.roomId, taskId: f.task.taskId, triggerMessageId: message.messageId, throughSequence: message.sequence
      }, now);
      const commitRef = legacy.contextPlan.resultEvidence!.artifactRefs.find((entry) => entry.type === "commit")!;
      assert.ok(commitRef);
      assert.equal(commitRef.commitSha, second.Checkpoint.candidateCommit);
      assert.equal(commitRef.content, undefined, "legacy Run received an unsupported binary descriptor");
      const patch = new LocalArtifactBlobStore(path.join(path.dirname(dbPath), "artifact-blobs"))
        .readVerified(content.storageKey, pin.contentDigest, pin.byteLength);
      assert.match(patch.toString(), /\+implemented through real capture/u);
      assert.doesNotMatch(patch.toString(), /later uncollected/u);
      if (mode === "lost-responses") {
        for (const output of second.Checkpoint.outputs.filter((output) => ["document", "test_result"].includes(output.artifact.kind))) {
          const reportArtifact = new ArtifactRepository(f.database).get(output.artifact.artifactId)!;
          const reportContent = new ArtifactPublicationRepository(f.database).getContent(reportArtifact.contentId!)!;
          const bytes = new LocalArtifactBlobStore(path.join(path.dirname(dbPath), "artifact-blobs"))
            .readVerified(reportContent.storageKey, output.artifact.contentDigest, output.artifact.byteLength);
          assert.equal(reportArtifact.type, output.artifact.kind);
          assert.equal(bytes.toString(), output.artifact.kind === "document"
            ? "# Captured review\nSupplied fixture notes, not an approval.\n"
            : '{"claimedPassed":true,"fixture":true}\n');
        }
        const taskAfterReports = await f.ok("GET", `/api/tasks/${f.task.taskId}`);
        assert.equal(taskAfterReports.lifecycleState, initialTask.lifecycleState);
        assert.equal(taskAfterReports.completionResultId, initialTask.completionResultId);
      }
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
      assert.equal([...counts].filter(([key]) => key.endsWith("/chunks")).reduce((sum, [, count]) => sum + count, 0), outputCount);
      assert.deepEqual(f.database.prepare("SELECT state FROM runs WHERE run_id = ?").get(f.manifest.scope.runId), initialRun);
      for (const table of ["repository_checkpoints", "repository_checkpoint_outputs", "task_artifact_refs", "artifact_publications"]) {
        assert.equal((f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table === "repository_checkpoints" ? 1 : outputCount);
      }

      if (mode === "lost-responses") {
        // All old Go fixture processes have terminal close above. There was no
        // Agent Runtime. Only future Run admission/settlement metadata is seeded;
        // resume, publication and canonical content verification remain real.
        const resumedAt = new Date().toISOString();
        f.service.closeForDevice(f.principal, f.operation(lease, "op_resume_release0001"), "release", resumedAt);
        f.database.prepare("UPDATE runs SET state = 'failed', terminal_at = ?, updated_at = ? WHERE run_id = ?")
          .run(resumedAt, resumedAt, f.manifest.scope.runId);
        const next = structuredClone(f.manifest);
        next.scope.runId = "run_real_resumed0001";
        next.scope.dispatchGeneration++;
        await f.insertRun(next.scope.runId);
        next.scope.taskRevision = (await f.ok("GET", `/api/tasks/${f.task.taskId}`)).taskRevision;
        next.workspace = planIsolatedWorkspace(next.scope, next.repository, resumedAt, next.deadline);
        f.rehash(next);
        f.database.transaction(() => f.service.reserveForRun(next, resumedAt))();
        f.freeze(next);
        const preparation: RepositoryOperationRequest = {
          ...operation, operationId: "op_real_resume_prepare0001", execution: next.scope,
          expectedGeneration: next.workspace.workspaceGeneration,
          action: { kind: "prepare", prepare: { manifest: next, resumeCheckpointId: second.Checkpoint.checkpointId } }
        };
        const { requestDigest: ignoredPreparation, ...preparationContent } = preparation;
        preparation.requestDigest = executionOperationDigest(preparationContent);
        const resumedOperation: RepositoryOperationRequest = {
          ...operation, operationId: "op_real_resumed_capture0001", execution: next.scope,
          expectedGeneration: next.workspace.workspaceGeneration,
          action: { kind: "capture", capture: { manifestDigest: next.manifestDigest } }
        };
        const { requestDigest: ignoredCapture, ...captureContent } = resumedOperation;
        resumedOperation.requestDigest = executionOperationDigest(captureContent);
        const resumeInput = { ...input, Manifest: next, Operation: resumedOperation,
          ResumeOperation: preparation, ResumeCheckpoint: second.Checkpoint, ExpectError: false };
        const resumed = await runCapture(binary, resumeInput, t.signal);
        assert.equal(resumed.PreparedTree, second.Checkpoint.candidateTree);
        await verifyCommitOutput(resumed.Checkpoint, "resumed");
        assert.notEqual(resumed.WorkPath, first.WorkPath);
        assert.equal(await readFile(path.join(resumed.WorkPath, "src", "app.txt"), "utf8"), "implemented through real capture\n");
        assert.equal(await readFile(path.join(first.WorkPath, "src", "app.txt"), "utf8"), "later uncollected edit\n");
        const resumedPin = resumed.Checkpoint.outputs.find((output) => output.artifact.kind === "patch")!.artifact;
        assert.notEqual(resumedPin.artifactId, pin.artifactId);
        const resumedArtifact = new ArtifactRepository(f.database).get(resumedPin.artifactId)!;
        assert.equal(resumedArtifact.sourceRunId, next.scope.runId);
        assert.equal(resumedArtifact.artifactRevision, resumedPin.artifactRevision);
        const resumedContent = new ArtifactPublicationRepository(f.database).getContent(resumedArtifact.contentId!)!;
        const cumulativePatch = new LocalArtifactBlobStore(path.join(path.dirname(dbPath), "artifact-blobs"))
          .readVerified(resumedContent.storageKey, resumedPin.contentDigest, resumedPin.byteLength);
        assert.match(cumulativePatch.toString(), /\+implemented through real capture/u);
        assert.match(cumulativePatch.toString(), /\+continued after explicit checkpoint resume/u);
        assert.doesNotMatch(cumulativePatch.toString(), /later uncollected/u);
        const resumedVerification = path.join(directory, mode, "resumed-roundtrip");
        await git(directory, "clone", "--no-local", "--", source, resumedVerification);
        const cumulativePath = path.join(directory, mode, "cumulative.patch");
        await writeFile(cumulativePath, cumulativePatch);
        await git(resumedVerification, "apply", "--index", "--", cumulativePath);
        assert.equal(await git(resumedVerification, "write-tree"), resumed.CandidateTree);
        assert.deepEqual(await f.ok("GET", `/api/bridge/repository-captures/${resumedOperation.operationId}/checkpoint`, undefined, authorization), resumed.Checkpoint);
        const resumeCounts = [...counts];
        const resumedReplay = await runCapture(binary, { ...resumeInput, CaptureDigest: resumed.CaptureDigest }, t.signal);
        assert.deepEqual(resumedReplay.Checkpoint, resumed.Checkpoint);
        assert.deepEqual([...counts], resumeCounts, "resumed confirmed replay performed HTTP writes");
        assert.equal(await git(source, "rev-parse", "HEAD"), baseCommit);
        assert.equal(await git(source, "status", "--porcelain"), "");
        assert.equal(leakedPath, false);
        for (const table of ["repository_checkpoints", "repository_checkpoint_outputs", "task_artifact_refs", "artifact_publications"]) {
          assert.equal((f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table === "repository_checkpoints" ? 2 : 2 * outputCount);
        }
        assert.equal((f.database.prepare("SELECT state FROM runs WHERE run_id = ?").get(next.scope.runId) as { state: string }).state, "queued");
        // Owner-local retirement consumes the real canonical checkpoint but
        // performs no Central mutation or implicit Run settlement. All writer
        // fixture processes above have actually exited before its local fence.
        const cleanup = { operationId: "op_real_cleanup0001", checkpoint: resumed.Checkpoint, expectedPreviewDigest: "" };
        const cleanupInput = { StatePath: state, Cleanup: cleanup };
        const cleanupCounts = [...counts];
        const preview = await runCapture(binary, cleanupInput, t.signal);
        assert.ok(preview.CleanupPreview);
        assert.equal(preview.CleanupPreview.path, resumed.WorkPath);
        assert.equal(await readFile(path.join(resumed.WorkPath, "src", "continued.txt"), "utf8"), "continued after explicit checkpoint resume\n");
        cleanup.expectedPreviewDigest = preview.CleanupPreview.digest;
        const retired = await runCapture(binary, cleanupInput, t.signal);
        assert.ok(retired.CleanupReceipt);
        await verifyCommitOutput(resumed.Checkpoint, "retired");
        assert.equal(retired.CleanupReceipt.removedWorktree, resumed.WorkPath);
        assert.equal(retired.CleanupReceipt.removedBranch, preview.CleanupPreview.branch);
        assert.equal(retired.CleanupReceipt.checkpointId, resumed.Checkpoint.checkpointId);
        await assert.rejects(readFile(path.join(resumed.WorkPath, "src", "continued.txt")), { code: "ENOENT" });
        const retiredReplay = await runCapture(binary, cleanupInput, t.signal);
        assert.deepEqual(retiredReplay.CleanupReceipt, retired.CleanupReceipt);
        assert.deepEqual([...counts], cleanupCounts, "local cleanup performed HTTP writes");
        assert.equal(await readFile(path.join(first.WorkPath, "src", "app.txt"), "utf8"), "later uncollected edit\n");
        assert.equal(await git(source, "rev-parse", "HEAD"), baseCommit);
        assert.equal(await git(source, "status", "--porcelain"), "");
        assert.deepEqual(await f.ok("GET", `/api/bridge/repository-captures/${resumedOperation.operationId}/checkpoint`, undefined, authorization), resumed.Checkpoint);
        for (const table of ["repository_checkpoints", "repository_checkpoint_outputs", "task_artifact_refs", "artifact_publications"]) {
          assert.equal((f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table === "repository_checkpoints" ? 2 : 2 * outputCount);
        }
        assert.equal((f.database.prepare("SELECT state FROM runs WHERE run_id = ?").get(next.scope.runId) as { state: string }).state, "queued");
      }
    });
  }

  await t.test("real verifier pass failure timeout and lost receipt response", async (t) => {
    const source = path.join(directory, "verification", "source");
    const state = path.join(directory, "verification", "owner-state");
    const dataPath = path.join(directory, "verification", "verification-state");
    const temporaryParent = path.join(directory, "verification", "temporary-runs");
    const markerPath = path.join(directory, "verification", "process-markers.txt");
    for (const target of [path.join(source, "src"), state, dataPath, temporaryParent]) {
      await mkdir(target, { recursive: true, mode: 0o700 });
    }
    await writeFile(path.join(source, "src", "app.txt"), "base\n");
    await git(source, "init", "--template=", "--object-format=sha1", "-b", "main", ".");
    await git(source, "add", "--all");
    await git(source, "commit", "-m", "verified fixture base");
    const baseCommit = await git(source, "rev-parse", "HEAD");
    const profiles = [{
      profileId: "profile_e2e_fail0001",
      revision: 1,
      digest: "a".repeat(64),
      required: true,
      mode: "fail",
      timeoutMilliseconds: 2_000
    }, {
      profileId: "profile_e2e_pass0001",
      revision: 1,
      digest: "b".repeat(64),
      required: true,
      mode: "pass",
      timeoutMilliseconds: 2_000
    }, {
      profileId: "profile_e2e_timeout0001",
      revision: 1,
      digest: "c".repeat(64),
      required: true,
      mode: "timeout",
      timeoutMilliseconds: 150
    }];
    const observedAt = new Date().toISOString();
    const f = await workspaceFixture(t, false, {
      now: observedAt,
      clock: () => new Date().toISOString(),
      configurePlan: (definition) => {
        for (const node of definition.nodes) {
          if (node.repository) node.repository.baseCommit = baseCommit;
          if (node.nodeKey === "Build") {
            node.verificationProfiles = profiles.map((profile) => ({
              profileId: profile.profileId,
              revision: profile.revision,
              digest: profile.digest,
              required: profile.required
            }));
          }
        }
      }
    });
    assert.ok(f.manifest.capture);
    f.manifest.capture.operationId = "op_real_verification_capture0001";
    f.manifest.capture.rootTaskId = f.root.taskId;
    f.rehash(f.manifest);
    const lease = f.reserve();
    f.freeze();
    const authorization = `Bearer ${f.credential.secret}`;
    const socket = await f.app.injectWS("/ws/bridge", {
      headers: { authorization, host: "127.0.0.1" }
    });
    t.after(() => socket.terminate());
    const ready = once(socket, "message", { signal: t.signal });
    socket.send(JSON.stringify({
      protocolVersion: "1.0",
      messageId: "msg_real_verification_hello0001",
      timestamp: observedAt,
      type: "bridge.hello",
      payload: {
        deviceId: f.device.deviceId,
        connectionEpoch: 1,
        bridgeVersion: "v0.4.0-fixture.1",
        supportedProtocolVersions: ["1.0"],
        governedExecution: capability
      }
    }));
    socket.send(JSON.stringify({
      protocolVersion: "1.0",
      messageId: "msg_real_verification_agentpub0001",
      timestamp: observedAt,
      type: "agent.publish",
      payload: {
        agentId: f.agent.agentId,
        capabilities: {
          ...f.agent.capabilities,
          governedExecution: capabilityForManifest(f.manifest),
          invocationMode: "managed"
        },
        deviceId: f.device.deviceId,
        name: f.agent.name,
        ownerMemberId: f.agent.ownerMemberId,
        role: f.agent.role,
        teamId: f.teamId,
        workspaceRef: f.agent.workspaceRef,
        workspaceGeneration: f.agent.workspaceGeneration
      }
    }));
    const [frameBytes] = await ready;
    const frame = JSON.parse(String(frameBytes));
    assert.equal(frame.type, "run.requested");
    assert.deepEqual(
      frame.payload.contextManifest.execution.verificationProfiles,
      f.manifest.verificationProfiles
    );
    const serverURL = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const captureOperation: RepositoryOperationRequest = {
      version: 1,
      operationId: "op_real_verification_capture0001",
      requestDigest: "",
      plan: {
        planId: f.plan.planId,
        revision: f.plan.current.revision,
        digest: f.plan.current.digest,
        approvalOperationId: f.manifest.scope.approvalOperationId,
        roomId: f.roomId,
        rootTaskId: f.root.taskId
      },
      execution: f.manifest.scope,
      repositoryId: f.manifest.repository.repositoryId,
      bindingId: f.manifest.repository.bindingId,
      deviceId: f.device.deviceId,
      grant: f.manifest.grant,
      expectedGeneration: lease.generation,
      deadline: f.manifest.deadline,
      action: {
        kind: "capture",
        capture: { manifestDigest: f.manifest.manifestDigest }
      }
    };
    const { requestDigest: _requestDigest, ...captureUnsigned } = captureOperation;
    captureOperation.requestDigest = executionOperationDigest(captureUnsigned);
    const captured = await runCapture(binary, {
      ServerURL: serverURL,
      Token: f.credential.secret,
      SourcePath: source,
      StatePath: state,
      Manifest: f.manifest,
      Operation: captureOperation,
      ExpectError: false
    }, t.signal);
    assert.equal(captured.Error, "");
    assert.equal(captured.Checkpoint.candidateCommit, captured.CandidateCommit);
    assert.equal(captured.Checkpoint.candidateTree, captured.CandidateTree);

    const counts = new Map<string, number>();
    const rejections: string[] = [];
    let droppedPassedReceipt = false;
    const proxy = createServer(async (request, response) => {
      try {
        const url = request.url!;
        const key = `${request.method} ${url}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const parts: Buffer[] = [];
        for await (const chunk of request) parts.push(Buffer.from(chunk));
        const body = Buffer.concat(parts);
        const upstream = await fetch(serverURL + url, {
          method: request.method,
          signal: AbortSignal.any([t.signal, AbortSignal.timeout(15_000)]),
          headers: {
            authorization: request.headers.authorization ?? "",
            "content-type": "application/json"
          },
          ...(body.length ? { body } : {})
        });
        const result = Buffer.from(await upstream.arrayBuffer());
        if (!upstream.ok) {
          rejections.push(`${request.method} ${url}: ${result.toString()}`);
        }
        if (
          upstream.ok && !droppedPassedReceipt &&
          request.method === "POST" && url === "/api/bridge/verification-receipts" &&
          JSON.parse(body.toString()).outcome === "passed"
        ) {
          droppedPassedReceipt = true;
          response.destroy();
          return;
        }
        response.writeHead(upstream.status, { "content-type": "application/json" });
        response.end(result);
      } catch {
        response.destroy();
      }
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    t.after(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    });
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const verified = await runVerification(verificationBinary, {
      ServerURL: `http://127.0.0.1:${address.port}`,
      Token: f.credential.secret,
      StatePath: state,
      DataPath: dataPath,
      TemporaryParent: temporaryParent,
      MarkerPath: markerPath,
      Request: frame.payload,
      Manifest: f.manifest,
      Checkpoint: captured.Checkpoint,
      Profiles: profiles.map(({ required: _required, ...profile }) => profile)
    }, t.signal);
    assert.equal(verified.error, "", rejections.join("\n"));
    assert.deepEqual(
      verified.receipts.map(({ receipt }) => receipt.outcome).sort(),
      ["failed", "passed", "timed_out"]
    );
    assert.equal(droppedPassedReceipt, true);
    assert.equal((counts.get("POST /api/bridge/verification-receipts") ?? 0), 3);
    assert.equal(
      [...counts].filter(([key]) =>
        key.startsWith("GET /api/bridge/repository-verifications/") &&
        key.endsWith("/receipt")
      ).reduce((sum, [, count]) => sum + count, 0),
      1,
      "lost receipt response was not resolved by exact lookup"
    );
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM repository_verification_operations
    `).get() as { n: number }).n, 3);
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM verification_receipts
    `).get() as { n: number }).n, 3);
    assert.deepEqual((f.database.prepare(`
      SELECT outcome FROM verification_receipts ORDER BY outcome
    `).all() as Array<{ outcome: string }>).map(({ outcome }) => outcome),
    ["failed", "passed", "timed_out"]);
    const markers = (await readFile(markerPath, "utf8")).trim().split("\n");
    for (const mode of ["pass", "fail", "timeout"]) {
      assert.equal(markers.filter((line) => line === `${mode}:started`).length, 1);
    }
    assert.equal(markers.filter((line) => line === "pass:completed").length, 1);
    assert.equal(markers.filter((line) => line === "fail:completed").length, 1);
    assert.equal(markers.includes("timeout:completed"), false,
      "timed-out process continued after the owned process group was stopped");
    assert.deepEqual(await readdir(temporaryParent), [],
      "verification run root was not physically removed");
    const databasePath = (f.database.pragma("database_list") as Array<{
      file: string;
    }>)[0]!.file;
    for (const retained of verified.receipts) {
      assert.ok(retained.receipt.logArtifact);
      const artifact = new ArtifactRepository(f.database)
        .get(retained.receipt.logArtifact.artifactId)!;
      const content = new ArtifactPublicationRepository(f.database)
        .getContent(artifact.contentId!)!;
      const bytes = new LocalArtifactBlobStore(
        path.join(path.dirname(databasePath), "artifact-blobs")
      ).readVerified(
        content.storageKey,
        retained.receipt.logArtifact.contentDigest,
        retained.receipt.logArtifact.byteLength
      );
      const log = JSON.parse(bytes.toString());
      assert.equal(log.spawned, true);
      assert.equal(bytes.includes(Buffer.from(source)), false);
      assert.equal(bytes.includes(Buffer.from(state)), false);
      assert.equal(bytes.includes(Buffer.from(temporaryParent)), false);
    }
    assert.equal(await git(source, "rev-parse", "HEAD"), baseCommit);
    assert.equal(await git(source, "status", "--porcelain"), "");
    assert.deepEqual(f.database.pragma("foreign_key_check"), []);
  });
});
