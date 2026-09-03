import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type {
  GovernedExecutionCapabilityReadyGrant,
  GovernedExecutionManifest
} from "@convene-wire/contracts/execution-plan";
import {
  providerInputAttestationDigest,
  providerObservationDigest
} from "@convene-wire/contracts/execution-validation";
import { fixture, now } from "./helpers/execution-plan-fixture.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { ExecutionDependencyResolver } from
  "../src/execution/execution-dependency-resolver.js";
import { ExecutionNodeMaterializationRepository } from
  "../src/execution/execution-node-materialization-repository.js";
import { ExecutionPlanRepository } from
  "../src/execution/execution-plan-repository.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { backfillRemoteEvidenceReuseContracts } from
  "../src/remote/remote-evidence-reuse-backfill.js";
import { createRemoteProviderEgressFetch } from
  "../src/remote/remote-provider-egress-policy.js";

const run = promisify(execFile);
const digest = (source: Buffer) => createHash("sha256").update(source).digest("hex");
type BridgeSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

const capability = {
  version: 1 as const,
  workspaceBoundary: "enforced" as const,
  preventivePathEnforcement: false,
  operations: ["prepare", "capture", "verify", "integrate"] as const
};

function envelope(type: string, payload: Record<string, unknown>, suffix: string) {
  return {
    protocolVersion: "1.0",
    messageId: `msg_remote_evidence_${suffix}`,
    timestamp: now,
    type,
    payload
  };
}

async function sendAndFlush(socket: BridgeSocket, value: object): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(value), (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function nextMessage(socket: BridgeSocket): Promise<{
  type: string;
  payload: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      reject(new Error("Timed out waiting for remote-evidence dependency Run"));
    }, 5_000);
    const onMessage = (source: { toString(): string }): void => {
      clearTimeout(timer);
      socket.off("close", onClose);
      resolve(JSON.parse(source.toString()) as {
        type: string;
        payload: Record<string, unknown>;
      });
    };
    const onClose = (code: number, reason: Buffer): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      reject(new Error(`Bridge closed before delivery: ${code} ${reason.toString()}`));
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

async function gitCandidate(t: Parameters<typeof test>[1] extends (...args: infer P) => unknown
  ? P[0] : never) {
  const root = await mkdtemp(path.join(os.tmpdir(), "convenewire-remote-provider-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "source");
  await run("git", ["init", "-b", "main", repository]);
  const git = (...args: string[]) => run("git", args, { cwd: repository });
  await git("config", "user.name", "Remote Provider Test");
  await git("config", "user.email", "provider@example.invalid");
  await writeFile(path.join(repository, "feature.txt"), "base\n");
  await git("add", "feature.txt");
  await git("commit", "-m", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(repository, "feature.txt"), "base\nremote candidate\n");
  await git("add", "feature.txt");
  await git("commit", "-m", "candidate");
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();
  const tree = (await git("rev-parse", "HEAD^{tree}")).stdout.trim();
  await git("branch", "base", base);
  await git("branch", "candidate", commit);
  const bundlePath = path.join(root, "candidate.bundle");
  await git("bundle", "create", bundlePath,
    "refs/heads/base", "refs/heads/candidate");
  const bundle = await import("node:fs/promises").then(({ readFile }) =>
    readFile(bundlePath));
  return { base, commit, tree, bundle, root };
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

test("authenticated remote commit and CI observations retain result-free evidence", {
  timeout: 30_000
}, async (t) => {
  const candidate = await gitCandidate(t);
  const effects = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const provider = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== "Bearer provider-test-token") {
      response.writeHead(401).end();
      return;
    }
    const commitLookup = request.url?.match(/^\/v1\/commit-observations\/(op_[^/]+)$/u);
    const ciLookup = request.url?.match(/^\/v1\/ci-observations\/(op_[^/]+)$/u);
    const inputLookup = request.url?.match(/^\/v1\/input-attestations\/(op_[^/]+)$/u);
    const bundleLookup = request.url?.match(/^\/v1\/commit-observations\/(observation_[^/]+)\/bundle$/u);
    if (request.method === "GET" && (commitLookup || ciLookup || inputLookup)) {
      const retained = effects.get((commitLookup ?? ciLookup ?? inputLookup)![1]!);
      if (!retained) response.writeHead(404).end();
      else response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(retained));
      return;
    }
    if (request.method === "GET" && bundleLookup) {
      response.writeHead(200, {
        "content-type": "application/x-git-bundle",
        "content-length": candidate.bundle.length
      }).end(candidate.bundle);
      return;
    }
    if (request.method === "POST" && request.url === "/v1/commit-observations") {
      const command = await body(request);
      const operationId = String(command.operationId);
      const pending = {
        version: 1,
        operationId: command.operationId,
        observationId: `observation_remote_${operationId.slice(3)}`,
        providerRepositoryId: operationId.includes("foreign")
          ? "foreign/repository" : command.providerRepositoryId,
        objectFormat: operationId.includes("objectformat") ? "sha256" : "sha1",
        baseCommit: operationId.includes("wrongbase")
          ? "d".repeat(40) : candidate.base,
        commit: operationId.includes("wrongcommit")
          ? "d".repeat(40) : candidate.commit,
        tree: operationId.includes("wrongtree")
          ? "d".repeat(40) : candidate.tree,
        bundleDigest: digest(candidate.bundle),
        bundleByteLength: candidate.bundle.length,
        pullRequest: null,
        providerObservationDigest: "0".repeat(64),
        observedAt: now
      };
      pending.providerObservationDigest = providerObservationDigest(pending);
      effects.set(command.operationId as string, pending);
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(pending));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/ci-observations") {
      const command = await body(request);
      const pending = {
        version: 1,
        operationId: command.operationId,
        observationId: `observation_ci_${String(command.operationId).slice(3)}`,
        providerRepositoryId: command.providerRepositoryId,
        checkKey: command.checkKey,
        attempt: command.attempt,
        commit: command.commit,
        tree: command.tree,
        outcome: command.attempt === 2 ? "failed" : "passed",
        providerObservationDigest: "0".repeat(64),
        observedAt: now
      };
      pending.providerObservationDigest = providerObservationDigest(pending);
      effects.set(command.operationId as string, pending);
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(pending));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/input-attestations") {
      const command = await body(request);
      const operationId = String(command.operationId);
      const pending = {
        version: 1,
        operationId: command.operationId,
        attestationId: `attestation_remote_${String(command.operationId).slice(3)}`,
        providerRepositoryId: command.providerRepositoryId,
        nodeKey: command.nodeKey,
        commit: command.commit,
        tree: command.tree,
        inputs: command.inputs,
        remoteInputEvidenceDigest: operationId.includes("wrongdigest")
          ? "d".repeat(64) : command.remoteInputEvidenceDigest,
        providerAttestationDigest: "0".repeat(64),
        attestedAt: now
      };
      pending.providerAttestationDigest = providerInputAttestationDigest(pending);
      effects.set(command.operationId as string, pending);
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(pending));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    provider.closeAllConnections();
    provider.close((error) => error ? reject(error) : resolve());
  }));
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const f = await fixture(t, () => now, {
    remoteProviderCredentialResolver: () => "provider-test-token",
    remoteProviderFetch: createRemoteProviderEgressFetch({
      testOnlyAllowLoopback: true
    }),
    remoteGitTemporaryBase: candidate.root
  });
  const core = new CoreRepository(f.database);
  const auth = new AuthService(f.database);
  const owner = auth.authenticateWebSession(f.authorization.slice(7), now);
  const device = new MemberDeviceService(core, auth).registerOwnDevice(
    owner, f.teamId, "Remote evidence consumer", now
  );
  const credential = auth.issueDeviceCredential(device.deviceId, now);
  const destination = new AgentService(core, auth).publishAgent(owner, {
    teamId: f.teamId,
    deviceId: device.deviceId,
    name: "Remote evidence consumer",
    role: "Builder",
    integrationMode: "managed",
    capabilities: {
      supportsStart: true,
      supportsResume: false,
      supportsStreaming: true,
      supportsInterrupt: true,
      supportsHandoff: false,
      supportsWorkspaceLeases: true
    },
    workspaceRef: `workspace_${"e".repeat(64)}`,
    workspaceGeneration: "e".repeat(64),
    now
  });
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, {
    memberIds: [f.ownerMemberId],
    agentIds: [f.agentId, destination.agentId]
  });
  const command = f.command();
  for (const node of command.definition.nodes) {
    node.repository.baseCommit = candidate.base;
  }
  const build = command.definition.nodes.find((node) => node.nodeKey === "Build");
  const consume = command.definition.nodes.find((node) => node.nodeKey === "Review");
  assert.ok(build?.repository);
  assert.ok(consume?.repository);
  consume.nodeKey = "Consume";
  consume.kind = "implementation";
  consume.agentId = destination.agentId;
  consume.task = {
    mode: "new",
    title: "Consume authenticated remote evidence",
    goal: "Receive only the explicitly adopted exact patch bytes",
    ownerMemberId: f.ownerMemberId,
    criteria: structuredClone(build.task.criteria)
  };
  consume.repository = {
    ...structuredClone(build.repository),
    grantId: "grant_remote_consume0001"
  };
  consume.scope = structuredClone(build.scope);
  consume.inputs = [{ slotKey: "patch", kind: "patch", required: true }];
  consume.outputs = [{ slotKey: "output", kind: "patch", required: true }];
  const remoteConsume = structuredClone(consume);
  remoteConsume.nodeKey = "RemoteConsume";
  remoteConsume.agentId = f.agentId;
  remoteConsume.task = {
    ...structuredClone(consume.task),
    title: "Consume an attested remote input",
    goal: "Produce a remote patch from the exact adopted Build evidence"
  };
  remoteConsume.repository.grantId = "grant_remote_input00001";
  command.definition.nodes.push(remoteConsume);
  command.definition.edges = [
    {
      edgeKey: "build_remote_consume",
      fromNodeKey: "Build",
      toNodeKey: "RemoteConsume",
      gate: "verified_output",
      bindings: [{ outputSlot: "output", inputSlot: "patch" }]
    },
    {
      edgeKey: "remote_consume_local",
      fromNodeKey: "RemoteConsume",
      toNodeKey: "Consume",
      gate: "verified_output",
      bindings: [{ outputSlot: "output", inputSlot: "patch" }]
    }
  ];
  command.definition.policy.maxConcurrency = 1;
  const draft = await f.create(command);
  const plan = (await f.ok("POST",
    `/api/execution-plans/${draft.planId}/approvals`, {
      operationId: "op_remote_plan_approval0001",
      expectedRevision: draft.current.revision,
      expectedDigest: draft.current.digest,
      expectedRootTaskRevision: command.expectedRootTaskRevision,
      decision: "approved",
      reason: "Admit exact authenticated remote evidence"
    })).plan;
  const consumeTaskRef = plan.compiledTasks.find((entry: { nodeKey: string }) =>
    entry.nodeKey === "Consume");
  assert.ok(consumeTaskRef);
  const consumeTask = await f.ok("GET", `/api/tasks/${consumeTaskRef.taskId}`);
  await f.ok("POST", `/api/tasks/${consumeTask.taskId}/control`, {
    operationId: "op_remote_consume_ready0001",
    expectedTaskRevision: consumeTask.taskRevision,
    lifecycleState: "ready"
  });
  const binding = (await f.ok("POST",
    `/api/teams/${f.teamId}/remote-provider-bindings`, {
      operationId: "op_remote_binding0000001",
      repositoryId: "repo_00000001",
      providerOrigin: `http://127.0.0.1:${address.port}`,
      providerRepositoryId: "owner/repository",
      ciChecks: [{
        checkKey: "unit",
        profileId: "profile_00000002",
        profileRevision: 1,
        profileDigest: "c".repeat(64)
      }]
    })).binding;
  const commitCommand = {
    operationId: "op_remote_commit0000001",
    providerBindingId: binding.providerBindingId,
    planRevision: plan.current.revision,
    nodeKey: "Build",
    expectedPlanDigest: plan.current.digest,
    expectedControlRevision: plan.controlRevision,
    expectedBaseCommit: candidate.base,
    candidateCommit: candidate.commit,
    patchOutputSlot: "output"
  };
  for (const operationId of [
    "op_remote_foreign_repo0001",
    "op_remote_wrongbase000001",
    "op_remote_wrongcommit0001",
    "op_remote_wrongtree000001",
    "op_remote_objectformat0001"
  ]) {
    const rejected = await f.request("POST",
      `/api/execution-plans/${plan.planId}/remote-commit-observations`, {
        ...commitCommand,
        operationId
      });
    assert.equal(rejected.statusCode, 409, rejected.body);
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM execution_remote_source_evidence
    `).get() as { n: number }).n, 0);
  }
  const commitPostsBeforeConcurrent = calls.filter((call) =>
    call === "POST /v1/commit-observations").length;
  const [observed, concurrentReplay] = await Promise.all([
    f.ok("POST",
      `/api/execution-plans/${plan.planId}/remote-commit-observations`,
      commitCommand),
    f.ok("POST",
      `/api/execution-plans/${plan.planId}/remote-commit-observations`,
      commitCommand)
  ]);
  assert.deepEqual(concurrentReplay, observed);
  assert.equal(observed.observation.commit, candidate.commit);
  assert.equal(observed.source.origin.kind, "remote_observation");
  assert.equal(observed.source.resultId, undefined);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }).n, 0);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM task_results").get() as { n: number }).n, 0);
  assert.equal(calls.filter((call) => call ===
    "POST /v1/commit-observations").length,
  commitPostsBeforeConcurrent + 1);
  const patch = f.database.prepare(`
    SELECT content.storage_key, content.sha256, content.size_bytes
    FROM task_artifact_refs artifact JOIN artifact_contents content
      ON content.content_id = artifact.content_id
    WHERE artifact.artifact_id = ?
  `).get(observed.observation.patchArtifactId) as {
    storage_key: string; sha256: string; size_bytes: number;
  };
  assert.ok(patch.size_bytes > 0);
  assert.equal(patch.sha256, observed.observation.patchDigest);

  const failedReceipt = await f.ok("POST",
    `/api/execution-plans/${plan.planId}/remote-ci-observations`, {
      operationId: "op_remote_ci_failed000001",
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "Build",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId: observed.source.sourceEvidenceId,
      checkKey: "unit",
      attempt: 2
    });
  assert.equal(failedReceipt.outcome, "failed");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_remote_gate_proof_refs
  `).get() as { n: number }).n, 0);
  const rejectedBeforePass = await f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-evidence-adoptions`, {
      operationId: "op_remote_adoption_failed0001",
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "Build",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId: observed.source.sourceEvidenceId
    });
  assert.equal(rejectedBeforePass.statusCode, 409, rejectedBeforePass.body);
  assert.match(rejectedBeforePass.body, /REMOTE_CI_PROOF_SET_INCOMPLETE/u);

  const receipt = await f.ok("POST",
    `/api/execution-plans/${plan.planId}/remote-ci-observations`, {
      operationId: "op_remote_ci0000000001",
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "Build",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId: observed.source.sourceEvidenceId,
      checkKey: "unit",
      attempt: 1
    });
  assert.equal(receipt.outcome, "passed");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_remote_gate_proof_refs
  `).get() as { n: number }).n, 1);
  const evidenceBeforeAdoption = await f.ok("GET",
    `/api/tasks/${f.root.taskId}/execution-evidence`);
  const buildEvidenceBefore = evidenceBeforeAdoption.plans[0].nodes.find(
    (node: { nodeKey: string }) => node.nodeKey === "Build"
  );
  assert.equal(buildEvidenceBefore.remote.adoptionState, "ready");
  assert.deepEqual(buildEvidenceBefore.remote.blockerCodes, []);
  assert.deepEqual(buildEvidenceBefore.remote.commandTemplate, {
    providerBindingId: binding.providerBindingId,
    planRevision: plan.current.revision,
    nodeKey: "Build",
    expectedPlanDigest: plan.current.digest,
    expectedControlRevision: plan.controlRevision,
    sourceEvidenceId: observed.source.sourceEvidenceId
  });
  assert.equal(buildEvidenceBefore.verifications.length, 2);
  assert.doesNotMatch(JSON.stringify(evidenceBeforeAdoption),
    /provider-test-token|providerOrigin|candidate\.bundle/u);
  const resolver = () => new ExecutionDependencyResolver(
    new ExecutionPlanRepository(f.database),
    new ExecutionNodeMaterializationRepository(f.database)
  );
  assert.deepEqual(resolver().resolve({
    planId: plan.planId,
    planRevision: plan.current.revision,
    nodeKey: "RemoteConsume"
  }), { ready: false, blocker: "EXECUTION_DEPENDENCY_NOT_MATERIALIZED" });
  const adopted = await f.ok("POST",
    `/api/execution-plans/${plan.planId}/remote-evidence-adoptions`, {
      operationId: "op_remote_adoption00001",
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "Build",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId: observed.source.sourceEvidenceId
    });
  assert.equal(adopted.adoption.gate, "verified_output");
  assert.equal(adopted.adoption.sourceExecution, null);
  assert.equal(adopted.adoption.authority.service, "remote_evidence_adoption");
  const evidenceAfterAdoption = await f.ok("GET",
    `/api/tasks/${f.root.taskId}/execution-evidence`);
  const buildEvidenceAfter = evidenceAfterAdoption.plans[0].nodes.find(
    (node: { nodeKey: string }) => node.nodeKey === "Build"
  );
  assert.equal(buildEvidenceAfter.remote.adoptionState, "adopted");
  assert.equal(buildEvidenceAfter.remote.commandTemplate, null);
  assert.equal(buildEvidenceAfter.stages[0].gate, "verified_output");
  assert.deepEqual(buildEvidenceAfter.nextAction, {
    kind: "none",
    actorKind: "none",
    reasonCode: "NO_ACTION"
  });
  assert.equal(buildEvidenceAfter.stages[0].adoption.adoptionId,
    adopted.adoption.adoptionId);
  const duplicatePass = await f.ok("POST",
    `/api/execution-plans/${plan.planId}/remote-ci-observations`, {
      operationId: "op_remote_ci_duplicate0001",
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "Build",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId: observed.source.sourceEvidenceId,
      checkKey: "unit",
      attempt: 3
    });
  assert.equal(duplicatePass.outcome, "passed");
  const duplicateAdoption = await f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-evidence-adoptions`, {
      operationId: "op_remote_adoption_duplicate0001",
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "Build",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId: observed.source.sourceEvidenceId
    });
  assert.equal(duplicateAdoption.statusCode, 409, duplicateAdoption.body);
  assert.match(duplicateAdoption.body, /REMOTE_CI_PROOF_SET_INCOMPLETE/u);
  const projected = f.database.prepare(`
    SELECT source_result_id, source_run_id, adoption_id, source_evidence_id
    FROM execution_all_adopted_node_materializations
    WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND gate = ?
  `).get(plan.planId, plan.current.revision, "Build", "verified_output") as {
    source_result_id: string | null; source_run_id: string | null;
    adoption_id: string; source_evidence_id: string;
  };
  assert.equal(projected.source_result_id, null);
  assert.equal(projected.source_run_id, null);
  assert.equal(projected.adoption_id, adopted.adoption.adoptionId);
  assert.equal(projected.source_evidence_id, observed.source.sourceEvidenceId);
  const resolved = resolver().resolve({
    planId: plan.planId,
    planRevision: plan.current.revision,
    nodeKey: "RemoteConsume"
  });
  assert.equal(resolved.ready, true);
  if (!resolved.ready) assert.fail("remote adoption did not release dependency");
  assert.equal(resolved.selections[0]?.sourceResultId, null);
  assert.equal(resolved.selections[0]?.sourceAuthority?.adoptionId,
    adopted.adoption.adoptionId);
  const expectedPatch = Buffer.from((await run("git", ["diff", "--binary",
    "--full-index", candidate.base, candidate.commit, "--", "."], {
    cwd: path.join(candidate.root, "source"), encoding: "buffer"
  })).stdout);
  const sealedPatch = await readFile(path.join(
    path.dirname(f.databasePath), "artifact-blobs", patch.storage_key
  ));
  assert.deepEqual(sealedPatch, expectedPatch);

  const remoteCommit = await f.ok("POST",
    `/api/execution-plans/${plan.planId}/remote-commit-observations`, {
      ...commitCommand,
      operationId: "op_remote_input_commit01",
      nodeKey: "RemoteConsume"
    });
  await f.ok("POST",
    `/api/execution-plans/${plan.planId}/remote-ci-observations`, {
      operationId: "op_remote_input_ci00001",
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "RemoteConsume",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId: remoteCommit.source.sourceEvidenceId,
      checkKey: "unit",
      attempt: 1
    });
  const remoteAdoptionCommand = {
    operationId: "op_remote_input_adopt001",
    providerBindingId: binding.providerBindingId,
    planRevision: plan.current.revision,
    nodeKey: "RemoteConsume",
    expectedPlanDigest: plan.current.digest,
    expectedControlRevision: plan.controlRevision,
    sourceEvidenceId: remoteCommit.source.sourceEvidenceId
  };
  const unattested = await f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-evidence-adoptions`,
    remoteAdoptionCommand);
  assert.equal(unattested.statusCode, 409, unattested.body);
  assert.match(unattested.body, /REMOTE_INPUT_ATTESTATION_REQUIRED/u);
  const attestationCommand = {
    operationId: "op_remote_input_attest01",
    providerBindingId: binding.providerBindingId,
    planRevision: plan.current.revision,
    nodeKey: "RemoteConsume",
    expectedPlanDigest: plan.current.digest,
    expectedControlRevision: plan.controlRevision,
    sourceEvidenceId: remoteCommit.source.sourceEvidenceId
  };
  const sealedPatchPath = path.join(
    path.dirname(f.databasePath), "artifact-blobs", patch.storage_key
  );
  await writeFile(sealedPatchPath, Buffer.alloc(sealedPatch.length, 0x78));
  const tamperedArtifact = await f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-input-attestations`, {
      ...attestationCommand,
      operationId: "op_remote_input_tamper001"
    });
  assert.equal(tamperedArtifact.statusCode, 409, tamperedArtifact.body);
  assert.match(tamperedArtifact.body, /REMOTE_INPUT_ARTIFACT_INVALID/u);
  await writeFile(sealedPatchPath, sealedPatch);
  const providerMismatch = await f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-input-attestations`, {
      ...attestationCommand,
      operationId: "op_remote_input_wrongdigest1"
    });
  assert.equal(providerMismatch.statusCode, 409, providerMismatch.body);
  assert.match(providerMismatch.body, /REMOTE_PROVIDER_RESPONSE_INVALID/u);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM remote_input_attestations
  `).get() as { n: number }).n, 0);
  const inputPostsBefore = calls.filter((call) =>
    call === "POST /v1/input-attestations").length;
  const [attestation, attestationReplay] = await Promise.all([
    f.ok("POST",
      `/api/execution-plans/${plan.planId}/remote-input-attestations`,
      attestationCommand),
    f.ok("POST",
      `/api/execution-plans/${plan.planId}/remote-input-attestations`,
      attestationCommand)
  ]);
  assert.deepEqual(attestationReplay, attestation);
  assert.equal(calls.filter((call) =>
    call === "POST /v1/input-attestations").length, inputPostsBefore + 1);
  assert.equal(attestation.inputs.length, 1);
  assert.equal(attestation.inputs[0].reuseInput.inputSlot, "patch");
  assert.equal(attestation.inputs[0].adoptionId, adopted.adoption.adoptionId);
  assert.equal(attestation.inputs[0].reuseInput.producer.sourceEvidenceId,
    adopted.source.sourceEvidenceId);
  f.database.exec(`
    CREATE TRIGGER fail_remote_reuse_once
    BEFORE INSERT ON execution_remote_evidence_reuse_contracts
    BEGIN SELECT RAISE(ABORT, 'injected remote reuse failure'); END;
  `);
  const injected = await f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-evidence-adoptions`, {
      ...remoteAdoptionCommand,
      operationId: "op_remote_input_fault001"
    });
  assert.equal(injected.statusCode, 400, injected.body);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_remote_evidence_adoptions
    WHERE node_key = 'RemoteConsume'
  `).get() as { n: number }).n, 0);
  f.database.exec("DROP TRIGGER fail_remote_reuse_once");
  const remoteAdopted = await f.ok("POST",
    `/api/execution-plans/${plan.planId}/remote-evidence-adoptions`,
    remoteAdoptionCommand);
  assert.equal(remoteAdopted.reuse.reuseInputEvidenceDigest,
    attestation.remoteInputEvidenceDigest);
  assert.deepEqual(remoteAdopted.reuse.reuseInputs,
    attestation.inputs.map((entry: { reuseInput: unknown }) => entry.reuseInput));
  const localResolution = resolver().resolve({
    planId: plan.planId,
    planRevision: plan.current.revision,
    nodeKey: "Consume"
  });
  assert.equal(localResolution.ready, true);
  if (!localResolution.ready) {
    assert.fail("attested remote adoption did not release local dependency");
  }
  assert.equal(localResolution.selections[0]?.sourceAuthority?.adoptionId,
    remoteAdopted.adoption.adoptionId);

  const consumeNode = plan.current.definition.nodes.find(
    (node: { nodeKey: string }) => node.nodeKey === "Consume"
  );
  assert.ok(consumeNode?.repository);
  const readyGrant = {
    grant: {
      grantId: consumeNode.repository.grantId,
      revision: consumeNode.repository.grantRevision,
      digest: "e".repeat(64),
      expiresAt: "2026-08-31T13:00:00.000Z"
    },
    repositoryId: consumeNode.repository.repositoryId,
    bindingId: consumeNode.repository.bindingId,
    deviceId: device.deviceId,
    agentId: destination.agentId,
    planId: plan.planId,
    nodeKey: "Consume",
    operations: ["prepare", "capture", "verify"],
    runtimeProfile: {
      profileId: consumeNode.repository.runtimeProfileId,
      revision: 1,
      digest: consumeNode.repository.runtimeProfileDigest
    },
    verificationProfiles: consumeNode.verificationProfiles.map(
      (profile: { profileId: string; revision: number; digest: string }) => ({
        profileId: profile.profileId,
        revision: profile.revision,
        digest: profile.digest
      })
    ),
    scopePolicy: structuredClone(consumeNode.scope),
    integrationTargets: [],
    issuedAt: now,
    revokedAt: null
  } satisfies GovernedExecutionCapabilityReadyGrant;
  await f.restart(100);
  await f.app.ready();
  const socket = await f.app.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${credential.secret}`,
      host: "127.0.0.1"
    }
  });
  t.after(() => socket.terminate());
  const delivery = nextMessage(socket);
  await sendAndFlush(socket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-test.1",
    connectionEpoch: 1,
    deviceId: device.deviceId,
    supportedProtocolVersions: ["1.0"],
    governedExecution: capability
  }, "hello0001"));
  await sendAndFlush(socket, envelope("agent.publish", {
    teamId: f.teamId,
    agentId: destination.agentId,
    ownerMemberId: f.ownerMemberId,
    deviceId: device.deviceId,
    name: destination.name,
    role: destination.role,
    capabilities: {
      invocationMode: "managed",
      supportsStart: true,
      supportsResume: false,
      supportsStreaming: true,
      supportsInterrupt: true,
      supportsHandoff: false,
      supportsWorkspaceLeases: true,
      governedExecution: { ...capability, readyGrants: [readyGrant] }
    },
    workspaceRef: destination.workspaceRef,
    workspaceGeneration: destination.workspaceGeneration,
    workspaceAlias: "Remote evidence consumer workspace"
  }, "publish0001"));
  const requested = await delivery;
  assert.equal(requested.type, "run.requested");
  const manifest = (requested.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  assert.equal(manifest.scope.nodeKey, "Consume");
  assert.equal(manifest.inputs.length, 1);
  const input = manifest.inputs[0]!;
  assert.equal(input.gate, "verified_output");
  assert.equal(input.sourceResultId, null);
  assert.equal(input.sourceAuthority?.sourceEvidenceId,
    remoteCommit.source.sourceEvidenceId);
  assert.equal(input.sourceAuthority?.adoptionId,
    remoteAdopted.adoption.adoptionId);
  const delivered = await f.request("GET",
    `/api/bridge/runs/${manifest.scope.runId}/execution-inputs/${input.bindingId}/content`,
    undefined,
    `Bearer ${credential.secret}`);
  assert.equal(delivered.statusCode, 200, delivered.body);
  assert.deepEqual(delivered.rawPayload, expectedPatch);
  assert.equal(delivered.headers["x-convenewire-content-sha256"],
    observed.observation.patchDigest);
  const remoteGitRoots = (await import("node:fs/promises")).readdir(candidate.root);
  assert.equal((await remoteGitRoots).some((entry) =>
    entry.startsWith("convenewire-remote-git-")), false);
  assert.throws(() => f.database.exec(`
    UPDATE execution_remote_evidence_adoptions SET gate = 'verified_output'
  `), /immutable/u);
  assert.throws(() => f.database.exec(`
    DELETE FROM execution_remote_evidence_adoptions
  `), /retained authority/u);

  socket.terminate();
  await f.restart();
  const callsBeforeReplay = [...calls];
  assert.deepEqual(await f.ok("POST",
    `/api/execution-plans/${plan.planId}/remote-commit-observations`,
    commitCommand), observed);
  assert.deepEqual(calls, callsBeforeReplay);
  const changedReplay = await f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-commit-observations`, {
      ...commitCommand,
      candidateCommit: "b".repeat(40)
    });
  assert.equal(changedReplay.statusCode, 409, changedReplay.body);
  assert.match(changedReplay.body, /REMOTE_EVIDENCE_OPERATION_CONFLICT/u);
  assert.deepEqual(calls, callsBeforeReplay);
  assert.equal(calls.filter((call) =>
    call === "POST /v1/commit-observations").length, 7);
  assert.throws(() => f.database.exec(`
    UPDATE remote_input_attestations SET source_digest = '${"f".repeat(64)}'
  `), /RemoteInputAttestation is immutable/u);
  assert.throws(() => f.database.exec(`
    DELETE FROM remote_input_attestations
  `), /RemoteInputAttestation is retained evidence/u);
  assert.throws(() => f.database.exec(`
    UPDATE execution_remote_evidence_reuse_contracts
    SET reuse_input_evidence_digest = '${"f".repeat(64)}'
  `), /Remote EvidenceReuseContract is immutable/u);
  f.database.exec("DROP TRIGGER execution_remote_reuse_contracts_immutable_delete");
  f.database.prepare(`
    DELETE FROM execution_remote_evidence_reuse_contracts
    WHERE adoption_id = ?
  `).run(adopted.adoption.adoptionId);
  assert.equal(new ExecutionNodeMaterializationRepository(f.database).getAdopted({
    planId: plan.planId,
    planRevision: plan.current.revision,
    nodeKey: "Build"
  }, "verified_output"), undefined);
  assert.equal(backfillRemoteEvidenceReuseContracts(f.database), 1);
  assert.ok(new ExecutionNodeMaterializationRepository(f.database).getAdopted({
    planId: plan.planId,
    planRevision: plan.current.revision,
    nodeKey: "Build"
  }, "verified_output"));
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("missing runtime credentials and revocation retain no usable remote evidence", async (t) => {
  let providerCalls = 0;
  const f = await fixture(t, () => now, {
    remoteProviderFetch: async () => {
      providerCalls += 1;
      return new Response(null, { status: 500 });
    }
  });
  const command = f.command();
  const draft = await f.create(command);
  const plan = (await f.ok("POST",
    `/api/execution-plans/${draft.planId}/approvals`, {
      operationId: "op_remote_negative_approval0001",
      expectedRevision: draft.current.revision,
      expectedDigest: draft.current.digest,
      expectedRootTaskRevision: command.expectedRootTaskRevision,
      decision: "approved",
      reason: "Exercise fail-closed remote authority"
    })).plan;
  const retained = await f.ok("POST",
    `/api/teams/${f.teamId}/remote-provider-bindings`, {
      operationId: "op_remote_negative_binding0001",
      repositoryId: "repo_00000001",
      providerOrigin: "https://provider.example",
      providerRepositoryId: "owner/repository",
      ciChecks: [{
        checkKey: "unit",
        profileId: "profile_00000002",
        profileRevision: 1,
        profileDigest: "c".repeat(64)
      }]
    });
  const binding = retained.binding;
  const observe = (operationId: string) => f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-commit-observations`, {
      operationId,
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "Build",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      expectedBaseCommit: command.definition.nodes[0]!.repository.baseCommit,
      candidateCommit: "b".repeat(40),
      patchOutputSlot: "output"
    });
  const absent = await observe("op_remote_missing_credential0001");
  assert.equal(absent.statusCode, 409, absent.body);
  assert.equal(absent.json().error.code,
    "REMOTE_PROVIDER_CREDENTIAL_UNAVAILABLE");
  assert.equal(providerCalls, 0);
  assert.deepEqual(f.database.prepare(`
    SELECT state, error_code FROM remote_evidence_operations
    WHERE operation_id = 'op_remote_missing_credential0001'
  `).get(), {
    state: "outcome_unknown",
    error_code: "REMOTE_PROVIDER_CREDENTIAL_UNAVAILABLE"
  });
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_remote_source_evidence
  `).get() as { n: number }).n, 0);
  const adoption = await f.request("POST",
    `/api/execution-plans/${plan.planId}/remote-evidence-adoptions`, {
      operationId: "op_remote_missing_adoption0001",
      providerBindingId: binding.providerBindingId,
      planRevision: plan.current.revision,
      nodeKey: "Build",
      expectedPlanDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      sourceEvidenceId: `source_${"0".repeat(64)}`
    });
  assert.equal(adoption.statusCode, 409, adoption.body);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_remote_evidence_adoptions
  `).get() as { n: number }).n, 0);
  await f.ok("POST",
    `/api/remote-provider-bindings/${binding.providerBindingId}/revocations`, {
      operationId: "op_remote_negative_revoke0001",
      expectedBindingDigest: binding.bindingDigest,
      reason: "Stop all new remote evidence I/O"
    });
  const revoked = await observe("op_remote_revoked_observation0001");
  assert.equal(revoked.statusCode, 409, revoked.body);
  assert.equal(revoked.json().error.code, "REMOTE_PROVIDER_BINDING_UNAVAILABLE");
  assert.equal(providerCalls, 0);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM remote_evidence_operations
  `).get() as { n: number }).n, 1);
});
