import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type {
  RepositoryCheckpoint,
  RepositoryOperationRequest,
  VerificationReceipt
} from "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { ArtifactPublicationRepository } from "../src/artifact/artifact-publication-repository.js";
import { LocalArtifactBlobStore } from "../src/artifact/local-artifact-blob-store.js";
import { RepositoryCaptureService } from "../src/repository/repository-capture-service.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { RunRepository } from "../src/run/run-repository.js";
import { planIsolatedWorkspace } from "../src/workspace/isolated-workspace-lease-service.js";
import { openDatabase } from "../src/data/database.js";
import { now } from "./helpers/execution-plan-fixture.js";
import {
  workspaceFixture,
  capability,
  capabilityForManifest
} from "./helpers/isolated-workspace-fixture.js";
import { syntheticCommitBundle } from "./helpers/commit-bundle-fixture.js";

const bytes = Buffer.from("diff --git a/src/a b/src/a\n--- a/src/a\n+++ b/src/a\n@@ -1 +1 @@\n-old\n+new\n");
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function rehash<T extends { digest: string }>(value: T): T {
  const { digest: _, ...unsigned } = value;
  value.digest = executionOperationDigest(unsigned);
  return value;
}
function hashRequest(value: RepositoryOperationRequest) {
  const { requestDigest: _, ...unsigned } = value;
  value.requestDigest = executionOperationDigest(unsigned);
  return value;
}

async function captureFixture(
  t: TestContext,
  commitOutput = false,
  independentVerification = false
) {
  const f = await workspaceFixture(t, false, { configurePlan: (definition) => {
    for (const node of definition.nodes) {
      if (commitOutput) {
        node.outputs.push({
          slotKey: "commit",
          kind: "commit",
          required: true
        });
      }
      if (independentVerification) {
        node.verificationProfiles = [{
          profileId: "profile_verification0001",
          revision: 1,
          digest: "e".repeat(64),
          required: true
        }];
      }
    }
  } }), initial = f.reserve();
  f.freeze();
  const authorization = `Bearer ${f.credential.secret}`;
  const socket = await f.app.injectWS("/ws/bridge", { headers: { authorization, host: "127.0.0.1" } });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture handshake timed out")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      const frame = JSON.parse(String(data));
      // Hello recovery delivers the prebuilt future-admission fixture. There
      // is no Runtime here and no delivery acceptance/start acknowledgement.
      if (frame.type !== "run.requested" || frame.payload.runId !== f.manifest.scope.runId) reject(new Error(`unexpected fixture frame ${frame.type}`));
      else resolve();
    });
  });
  socket.send(JSON.stringify({ protocolVersion: "1.0", messageId: "msg_capture_handshake0001", timestamp: now,
    type: "bridge.hello", payload: { deviceId: f.device.deviceId, connectionEpoch: 1,
      bridgeVersion: "v0.4.0-fixture.1", supportedProtocolVersions: ["1.0"], governedExecution: capability } }));
  socket.send(JSON.stringify({ protocolVersion: "1.0", messageId: "msg_capture_agentpub0001", timestamp: now,
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
  await ready;
  assert.equal(f.connections.recordGovernedAgentCapability(
    f.device.deviceId,
    1,
    f.agent.agentId,
    capabilityForManifest(f.manifest)
  ), true);
  const initialRunState = new RunRepository(f.database).getRun(f.manifest.scope.runId)!.state;
  const request = hashRequest({ version: 1, operationId: "op_capture_publication0001", requestDigest: "a".repeat(64),
    plan: { planId: f.manifest.scope.planId, revision: f.manifest.scope.planRevision, digest: f.manifest.scope.planDigest,
      approvalOperationId: f.manifest.scope.approvalOperationId, roomId: f.roomId, rootTaskId: f.root.taskId },
    execution: f.manifest.scope, repositoryId: f.manifest.repository.repositoryId, bindingId: f.manifest.repository.bindingId,
    deviceId: f.device.deviceId, grant: f.manifest.grant, expectedGeneration: initial.generation,
    deadline: f.manifest.deadline, action: { kind: "capture", capture: { manifestDigest: f.manifest.manifestDigest } } });
  const ok = (method: "GET" | "POST", url: string, value?: unknown) => f.ok(method, url, value, authorization);
  const http = (method: "GET" | "POST", url: string, value?: unknown, token = authorization) => f.request(method, url, value, token);
  const lease = await ok("POST", "/api/bridge/repository-captures", request);
  const dbPath = (f.database.pragma("database_list") as Array<{ file: string }>)[0]!.file;
  const blobRoot = path.join(path.dirname(dbPath), "artifact-blobs");
  const makeService = (database = f.database) => new RepositoryCaptureService(database, f.service,
    new ArtifactRepository(database), new ArtifactPublicationRepository(database), new LocalArtifactBlobStore(blobRoot));
  const prepare = (suffix = "0001", content = bytes) => ok("POST", "/api/bridge/artifact-publications", {
    leaseId: lease.leaseId, runId: f.manifest.scope.runId, agentId: f.agent.agentId,
    workspaceRef: lease.workspaceRef, workspaceGeneration: lease.workspaceGeneration,
    idempotencyKey: `idem_capture_publication_${suffix}`, artifactType: "patch", fileName: "output.patch",
    mediaType: "text/x-diff", title: "Captured patch", summary: "Not independent verification", sizeBytes: content.length, sha256: sha(content)
  });
  const upload = async (publicationId: string, content = bytes) => {
    await ok("POST", `/api/bridge/artifact-publications/${publicationId}/chunks`, {
      offset: 0, chunkBase64: content.toString("base64"), chunkSha256: sha(content)
    });
    await ok("POST", `/api/bridge/artifact-publications/${publicationId}/seal`);
  };
  const publish = async (suffix = "0001") => {
    const p = await prepare(suffix);
    await upload(p.publicationId);
    return (await ok("POST", `/api/bridge/artifact-publications/${p.publicationId}/bind`)).artifact;
  };
  const checkpoint = (artifact: Awaited<ReturnType<typeof publish>>): RepositoryCheckpoint => rehash({
    checkpointId: "checkpoint_capture_test0001", operationId: request.operationId, scope: f.manifest.scope,
    repositoryId: request.repositoryId, bindingId: request.bindingId, baseCommit: f.manifest.repository.baseCommit,
    candidateCommit: "c".repeat(f.manifest.repository.baseCommit.length), candidateTree: "d".repeat(f.manifest.repository.baseCommit.length),
    inputDigest: f.manifest.inputDigest, workspaceRef: lease.workspaceRef, workspaceGeneration: lease.workspaceGeneration,
    outputs: [{ slotKey: f.manifest.outputs.find((o) => o.kind === "patch")!.slotKey, artifact: {
      artifactId: artifact.artifactId, artifactRevision: artifact.artifactRevision, kind: "patch", byteLength: bytes.length,
      contentDigest: sha(bytes)
    } }], capturedAt: now, digest: "a".repeat(64)
  });
  return { ...f, initial, initialRunState, request, lease, http, deviceOK: ok, prepare, upload, publish, checkpoint, makeService, blobRoot, dbPath };
}

test("commit transport rejects malformed bytes and binds only the checkpoint's exact candidate", async (t) => {
  const f = await captureFixture(t, true), patch = await f.publish();
  // This fixture proves envelope and authority validation only. Real packed
  // objects are generated and consumed in repository-capture-go.test.ts.
  const content = syntheticCommitBundle("sha1", f.manifest.repository.baseCommit);
  const prepareCommit = (id: string, source = content) => f.deviceOK("POST", "/api/bridge/artifact-publications", {
    leaseId: f.lease.leaseId, runId: f.manifest.scope.runId, agentId: f.agent.agentId,
    workspaceRef: f.lease.workspaceRef, workspaceGeneration: f.lease.workspaceGeneration,
    idempotencyKey: `idem_commit_${id}`, artifactType: "commit", fileName: "candidate.bundle",
    mediaType: "application/x-git-bundle", title: "Commit transport fixture", summary: "Envelope only, not verified Git objects",
    sizeBytes: source.length, sha256: sha(source)
  });
  const malformed = Buffer.from(content); malformed[malformed.length - 1]! ^= 1;
  const invalid = await prepareCommit("malformed0001", malformed);
  await f.deviceOK("POST", `/api/bridge/artifact-publications/${invalid.publicationId}/chunks`, {
    offset: 0, chunkBase64: malformed.toString("base64"), chunkSha256: sha(malformed)
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejected = await f.http("POST", `/api/bridge/artifact-publications/${invalid.publicationId}/seal`);
    assert.notEqual(rejected.statusCode, 200);
    assert.match(rejected.body, /Commit bundle envelope is invalid/u);
  }
  assert.equal(new ArtifactPublicationRepository(f.database).get(invalid.publicationId)!.contentId, null);
  const publication = await prepareCommit("valid0001");
  await f.upload(publication.publicationId, content);
  const bound = await f.deviceOK("POST", `/api/bridge/artifact-publications/${publication.publicationId}/bind`);
  assert.equal(bound.artifact.commitSha, "c".repeat(40));
  const preview = await f.http("GET", `/api/tasks/${f.task.taskId}/artifacts/${bound.artifact.artifactId}/preview`, undefined, f.authorization);
  assert.notEqual(preview.statusCode, 200);
  assert.match(preview.body, /no previewable snapshot/u);
  assert.deepEqual(await f.deviceOK("POST", `/api/bridge/artifact-publications/${publication.publicationId}/bind`), bound);
  const checkpoint = f.checkpoint(patch);
  checkpoint.outputs.push({ slotKey: "commit", artifact: { artifactId: bound.artifact.artifactId,
    artifactRevision: bound.artifact.artifactRevision, kind: "commit", byteLength: content.length, contentDigest: sha(content) } });
  rehash(checkpoint);
  const changed = rehash({ ...checkpoint, candidateCommit: "e".repeat(40) });
  const rejected = await f.http("POST", "/api/bridge/repository-checkpoints", changed);
  assert.equal(rejected.statusCode, 409);
  assert.match(rejected.body, /COMMIT_MISMATCH/u);
  assert.deepEqual(await f.deviceOK("POST", "/api/bridge/repository-checkpoints", checkpoint), checkpoint);
  assert.equal(new RunRepository(f.database).getRun(f.manifest.scope.runId)!.state, f.initialRunState);
});

test("commit checkpoint cannot substitute a different prepared prerequisite", async (t) => {
  const f = await captureFixture(t, true), patch = await f.publish();
  const content = syntheticCommitBundle("sha1", "f".repeat(40));
  const publication = await f.deviceOK("POST", "/api/bridge/artifact-publications", {
    leaseId: f.lease.leaseId, runId: f.manifest.scope.runId, agentId: f.agent.agentId,
    workspaceRef: f.lease.workspaceRef, workspaceGeneration: f.lease.workspaceGeneration,
    idempotencyKey: "idem_commit_wrongbase0001", artifactType: "commit", fileName: "candidate.bundle",
    mediaType: "application/x-git-bundle", title: "Wrong prerequisite", summary: "Must not satisfy the checkpoint",
    sizeBytes: content.length, sha256: sha(content)
  });
  await f.upload(publication.publicationId, content);
  const { artifact } = await f.deviceOK("POST", `/api/bridge/artifact-publications/${publication.publicationId}/bind`);
  const checkpoint = f.checkpoint(patch);
  checkpoint.outputs.push({ slotKey: "commit", artifact: { artifactId: artifact.artifactId, artifactRevision: artifact.artifactRevision,
    kind: "commit", byteLength: content.length, contentDigest: sha(content) } });
  const rejected = await f.http("POST", "/api/bridge/repository-checkpoints", rehash(checkpoint));
  assert.equal(rejected.statusCode, 409);
  assert.match(rejected.body, /COMMIT_MISMATCH/u);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM repository_checkpoints").get() as { n: number }).n, 0);
});

test("capture publishes real canonical content and an immutable checkpoint through authenticated HTTP", async (t) => {
  const f = await captureFixture(t), artifact = await f.publish(), checkpoint = f.checkpoint(artifact);
  assert.equal(f.lease.mode, "read_capture");
  assert.notEqual(f.lease.workspaceRef, f.agent.workspaceRef);
  assert.deepEqual(await f.deviceOK("POST", "/api/bridge/repository-captures", f.request), f.lease);
  assert.deepEqual(await f.deviceOK("POST", "/api/bridge/repository-checkpoints", checkpoint), checkpoint);
  assert.deepEqual(await f.deviceOK("POST", "/api/bridge/repository-checkpoints", checkpoint), checkpoint);
  assert.deepEqual(await f.deviceOK("GET", `/api/bridge/repository-captures/${f.request.operationId}/checkpoint`), checkpoint);
  const reopened = openDatabase(f.dbPath);
  try { assert.deepEqual(f.makeService(reopened).getForDevice(f.principal, f.request.operationId), checkpoint); }
  finally { reopened.close(); }
  assert.equal(new RunRepository(f.database).getRun(f.manifest.scope.runId)!.state, f.initialRunState, "publication does not settle a Run");
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM repository_checkpoint_outputs").get() as { n: number }).n, 1);
  assert.throws(() => f.database.exec("UPDATE repository_checkpoints SET digest = digest"), /immutable/u);
  assert.throws(() => f.database.exec("DELETE FROM repository_capture_operations"), /retained/u);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
  await assert.rejects(f.prepare("after_checkpoint"), /ALREADY_SEALED/u);
});

test("Central admits exact candidate verification and retains only the paired Device receipt", async (t) => {
  const f = await captureFixture(t, false, true);
  const output = await f.publish();
  const checkpoint = f.checkpoint(output);
  await f.deviceOK("POST", "/api/bridge/repository-checkpoints", checkpoint);
  const profile = f.manifest.verificationProfiles[0]!;
  const verificationRequest = hashRequest({
    version: 1,
    operationId: "op_verification_candidate0001",
    requestDigest: "a".repeat(64),
    plan: {
      planId: f.manifest.scope.planId,
      revision: f.manifest.scope.planRevision,
      digest: f.manifest.scope.planDigest,
      approvalOperationId: f.manifest.scope.approvalOperationId,
      roomId: f.roomId,
      rootTaskId: f.root.taskId
    },
    execution: f.manifest.scope,
    repositoryId: f.manifest.repository.repositoryId,
    bindingId: f.manifest.repository.bindingId,
    deviceId: f.device.deviceId,
    grant: f.manifest.grant,
    expectedGeneration: f.initial.generation,
    deadline: f.manifest.deadline,
    action: {
      kind: "verify",
      verify: {
        candidateCommit: checkpoint.candidateCommit,
        candidateTree: checkpoint.candidateTree,
        inputDigest: checkpoint.inputDigest,
        profile: {
          profileId: profile.profileId,
          revision: profile.revision,
          digest: profile.digest
        }
      }
    }
  });
  for (const [suffix, mutate] of [
    ["generation", (request: RepositoryOperationRequest) => {
      request.expectedGeneration = "f".repeat(64);
    }],
    ["profile", (request: RepositoryOperationRequest) => {
      request.action.verify!.profile.digest = "f".repeat(64);
    }],
    ["candidate", (request: RepositoryOperationRequest) => {
      request.action.verify!.candidateTree = "f".repeat(40);
    }]
  ] as const) {
    const changed = structuredClone(verificationRequest);
    changed.operationId = `op_verification_wrong_${suffix}0001`;
    mutate(changed);
    hashRequest(changed);
    const response = await f.http(
      "POST",
      "/api/bridge/repository-verifications",
      changed
    );
    assert.equal(response.statusCode, 409, response.body);
  }
  const admitted = await f.deviceOK(
    "POST",
    "/api/bridge/repository-verifications",
    verificationRequest
  );
  assert.deepEqual(admitted, {
    operationId: verificationRequest.operationId,
    requestDigest: verificationRequest.requestDigest,
    admittedAt: now,
    deadline: verificationRequest.deadline
  });
  assert.deepEqual(await f.deviceOK(
    "POST",
    "/api/bridge/repository-verifications",
    verificationRequest
  ), admitted);
  const changedRequest = structuredClone(verificationRequest);
  changedRequest.action.verify!.candidateTree = "f".repeat(40);
  hashRequest(changedRequest);
  assert.equal((await f.http(
    "POST",
    "/api/bridge/repository-verifications",
    changedRequest
  )).statusCode, 409);

  const logBytes = Buffer.from(JSON.stringify({
    version: 1,
    stdout: "verification passed",
    stderr: "",
    truncated: false,
    spawned: true
  }));
  const publication = await f.deviceOK(
    "POST",
    "/api/bridge/artifact-publications",
    {
      leaseId: f.lease.leaseId,
      runId: f.manifest.scope.runId,
      agentId: f.agent.agentId,
      workspaceRef: f.lease.workspaceRef,
      workspaceGeneration: f.lease.workspaceGeneration,
      verificationOperationId: verificationRequest.operationId,
      idempotencyKey: "idem_verification_log0001",
      artifactType: "test_result",
      fileName: "verification.json",
      mediaType: "application/json",
      title: "Independent verification log",
      summary: "Bounded output from the admitted Bridge verifier",
      sizeBytes: logBytes.length,
      sha256: sha(logBytes)
    }
  );
  await f.upload(publication.publicationId, logBytes);
  const logArtifact = (await f.deviceOK(
    "POST",
    `/api/bridge/artifact-publications/${publication.publicationId}/bind`
  )).artifact;
  const receipt: VerificationReceipt = {
    version: 1,
    verificationId: "verification_candidate0001",
    operationId: verificationRequest.operationId,
    requestDigest: verificationRequest.requestDigest,
    plan: verificationRequest.plan,
    execution: f.manifest.scope,
    integrationOperationId: null,
    repositoryId: verificationRequest.repositoryId,
    bindingId: verificationRequest.bindingId,
    authority: { kind: "bridge", deviceId: f.device.deviceId },
    candidateCommit: checkpoint.candidateCommit,
    candidateTree: checkpoint.candidateTree,
    inputDigest: checkpoint.inputDigest,
    profile: verificationRequest.action.verify!.profile,
    startedAt: now,
    finishedAt: now,
    outcome: "passed",
    exitCode: 0,
    durationMilliseconds: 0,
    logArtifact: {
      artifactId: logArtifact.artifactId,
      artifactRevision: logArtifact.artifactRevision,
      contentDigest: sha(logBytes),
      byteLength: logBytes.length,
      kind: "test_result"
    }
  };
  const forged = structuredClone(receipt);
  forged.candidateTree = "f".repeat(40);
  const rejected = await f.http(
    "POST",
    "/api/bridge/verification-receipts",
    forged
  );
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal((f.database.prepare(
    "SELECT count(*) AS n FROM verification_receipts"
  ).get() as { n: number }).n, 0);
  assert.equal((await f.http(
    "POST",
    "/api/bridge/verification-receipts",
    receipt,
    f.authorization
  )).statusCode, 401, "a Web member cannot mint a receipt");
  const missingLog = structuredClone(receipt);
  missingLog.logArtifact = null;
  assert.equal((await f.http(
    "POST",
    "/api/bridge/verification-receipts",
    missingLog
  )).statusCode, 409, "a trustworthy terminal outcome requires its exact log");
  const retained = await f.deviceOK(
    "POST",
    "/api/bridge/verification-receipts",
    receipt
  );
  assert.deepEqual(retained.receipt, receipt);
  assert.equal(retained.receiptDigest, executionOperationDigest(receipt));
  assert.deepEqual(await f.deviceOK(
    "GET",
    `/api/bridge/repository-verifications/${verificationRequest.operationId}/receipt`
  ), retained, "a lost terminal response is recovered by exact lookup");
  assert.deepEqual(await f.deviceOK(
    "POST",
    "/api/bridge/verification-receipts",
    receipt
  ), retained);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM artifact_publications
    WHERE verification_operation_id = ? AND state = 'bound'
  `).get(verificationRequest.operationId) as { n: number }).n, 1);
  const content = new ArtifactPublicationRepository(f.database)
    .getContent(logArtifact.contentId)!;
  assert.deepEqual(
    await readFile(path.join(f.blobRoot, content.storageKey)),
    logBytes
  );
  assert.throws(() => f.database.exec(
    "UPDATE verification_receipts SET outcome = outcome"
  ), /immutable/u);
  assert.throws(() => f.database.exec(
    "DELETE FROM repository_verification_operations"
  ), /retained/u);
  assert.throws(() => f.database.exec(
    "UPDATE artifact_publications SET verification_operation_id = NULL"
  ), /immutable|state transition/u);
  assert.equal((f.database.prepare(`
    SELECT verification_operation_id AS operationId
    FROM artifact_publications WHERE publication_id = ?
  `).get(publication.publicationId) as { operationId: string }).operationId,
  verificationRequest.operationId);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("runtime authority HTTP observes only the exact current isolated lease", async (t) => {
  const f = await captureFixture(t);
  const request = {
    version: 1, runId: f.manifest.scope.runId, leaseId: f.initial.lease.leaseId,
    manifestDigest: f.manifest.manifestDigest, workspaceRef: f.initial.lease.workspaceRef,
    workspaceGeneration: f.initial.generation
  };
  const accepted = await f.http("POST", "/api/bridge/governed-runtime-authority", request);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.headers["cache-control"], "no-store");
  assert.deepEqual(accepted.json(), {
    ...request, state: "active", leaseRevision: 1, checkedAt: now,
    expiresAt: f.initial.lease.expiresAt
  });
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM isolated_workspace_operations").get() as { n: number }).n, 0);

  const changed = await f.http("POST", "/api/bridge/governed-runtime-authority", {
    ...request, workspaceGeneration: "f".repeat(64)
  });
  assert.equal(changed.statusCode, 409);
  assert.equal((await f.http("POST", "/api/bridge/governed-runtime-authority", request, f.authorization)).statusCode, 401);

  new RunRepository(f.database).requestCancellation({
    runId: f.manifest.scope.runId, messageId: "msg_runtime_authority_cancel0001",
    requestedByMemberId: f.ownerMemberId, reason: "Stop before Runtime admission", now,
    ackDeadlineAt: new Date(Date.parse(now) + 30_000).toISOString()
  });
  const canceled = await f.http("POST", "/api/bridge/governed-runtime-authority", request);
  assert.equal(canceled.statusCode, 409);
  assert.match(canceled.body, /RUNTIME_AUTHORITY_CANCELED/u);
});

test("capture rejects changed request identity, scope and competing generation claims", async (t) => {
  const f = await captureFixture(t);
  for (const mutate of [
    (r: RepositoryOperationRequest) => { r.bindingId = "repobind_wrong0001"; },
    (r: RepositoryOperationRequest) => { r.execution!.runId = "run_wrongcapture0001"; },
    (r: RepositoryOperationRequest) => { r.grant.revision++; },
    (r: RepositoryOperationRequest) => { r.expectedGeneration = "f".repeat(64); },
    (r: RepositoryOperationRequest) => { r.deadline = "2026-08-31T13:00:00Z"; }
  ]) {
    const changed = structuredClone(f.request); mutate(changed); hashRequest(changed);
    assert.equal((await f.http("POST", "/api/bridge/repository-captures", changed)).statusCode, 409);
    changed.operationId = "op_capture_other0001"; hashRequest(changed);
    assert.notEqual((await f.http("POST", "/api/bridge/repository-captures", changed)).statusCode, 200);
  }
  const changed = hashRequest({ ...f.request, operationId: "op_capture_competing0001" });
  assert.equal((await f.http("POST", "/api/bridge/repository-captures", changed)).statusCode, 409);
});

test("governed capture cannot publish from the default Agent source lease", async (t) => {
  const f = await captureFixture(t);
  const response = await f.http("POST", "/api/bridge/workspace-leases/read-source", {
    runId: f.manifest.scope.runId, agentId: f.agent.agentId, workspaceRef: f.agent.workspaceRef,
    workspaceGeneration: f.agent.workspaceGeneration, idempotencyKey: "idem_capture_legacy_bypass01"
  });
  assert.notEqual(response.statusCode, 200);
  assert.match(response.body, /capture lease/u);
  assert.equal((await f.http("POST", "/api/bridge/repository-captures", f.request, f.authorization)).statusCode, 401);
});

test("checkpoint requires approved slots and exact canonical artifact identities", async (t) => {
  const f = await captureFixture(t), artifact = await f.publish(), checkpoint = f.checkpoint(artifact);
  for (const mutate of [
    (c: RepositoryCheckpoint) => { c.outputs = []; },
    (c: RepositoryCheckpoint) => { c.outputs[0]!.slotKey = "unapproved"; },
    (c: RepositoryCheckpoint) => { c.outputs[0]!.artifact.artifactId = "artifact_forged0001"; },
    (c: RepositoryCheckpoint) => { c.outputs[0]!.artifact.artifactRevision++; },
    (c: RepositoryCheckpoint) => { c.outputs[0]!.artifact.contentDigest = "f".repeat(64); },
    (c: RepositoryCheckpoint) => { c.outputs[0]!.artifact.byteLength++; },
    (c: RepositoryCheckpoint) => { c.outputs.push(structuredClone(c.outputs[0]!)); },
    (c: RepositoryCheckpoint) => { c.baseCommit = "e".repeat(40); },
    (c: RepositoryCheckpoint) => { c.scope.taskRevision++; },
    (c: RepositoryCheckpoint) => { c.inputDigest = "f".repeat(64); },
    (c: RepositoryCheckpoint) => { c.workspaceGeneration = "f".repeat(64); },
    (c: RepositoryCheckpoint) => { c.capturedAt = "2026-08-31T12:01:00Z"; }
  ]) {
    const changed = structuredClone(checkpoint); mutate(changed); rehash(changed);
    assert.notEqual((await f.http("POST", "/api/bridge/repository-checkpoints", changed)).statusCode, 200);
  }
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM repository_checkpoints").get() as { n: number }).n, 0);
  await f.deviceOK("POST", "/api/bridge/repository-checkpoints", checkpoint);
  const changed = rehash({ ...checkpoint, candidateCommit: "e".repeat(40) });
  assert.equal((await f.http("POST", "/api/bridge/repository-checkpoints", changed)).statusCode, 409);
});

test("checkpoint verifies actual sealed bytes and rolls back a failed output link", async (t) => {
  const f = await captureFixture(t), artifact = await f.publish(), checkpoint = f.checkpoint(artifact);
  const content = new ArtifactPublicationRepository(f.database).getContent(artifact.contentId)!;
  const file = path.join(f.blobRoot, content.storageKey), original = await readFile(file);
  await writeFile(file, Buffer.from("corrupt"));
  assert.notEqual((await f.http("POST", "/api/bridge/repository-checkpoints", checkpoint)).statusCode, 200);
  await writeFile(file, original);
  f.database.exec(`CREATE TRIGGER fixture_checkpoint_failure BEFORE INSERT ON repository_checkpoint_outputs
    BEGIN SELECT RAISE(ABORT, 'fixture output failure'); END`);
  assert.notEqual((await f.http("POST", "/api/bridge/repository-checkpoints", checkpoint)).statusCode, 200);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM repository_checkpoints").get() as { n: number }).n, 0);
  f.database.exec("DROP TRIGGER fixture_checkpoint_failure");
  await f.deviceOK("POST", "/api/bridge/repository-checkpoints", checkpoint);
});

for (const stage of ["prepare", "chunk", "seal", "bind", "checkpoint"] as const) {
  test(`capture revocation blocks new ${stage} effects`, async (t) => {
    const f = await captureFixture(t);
    const publication = stage === "prepare" ? undefined : await f.prepare();
    let artifact;
    if (publication && ["seal", "bind", "checkpoint"].includes(stage)) {
      await f.deviceOK("POST", `/api/bridge/artifact-publications/${publication.publicationId}/chunks`, {
        offset: 0, chunkBase64: bytes.toString("base64"), chunkSha256: sha(bytes)
      });
    }
    if (publication && ["bind", "checkpoint"].includes(stage)) await f.deviceOK("POST", `/api/bridge/artifact-publications/${publication.publicationId}/seal`);
    if (stage === "checkpoint") artifact = (await f.deviceOK("POST", `/api/bridge/artifact-publications/${publication!.publicationId}/bind`)).artifact;
    f.service.closeForDevice(f.principal, f.operation(f.initial, "op_capture_revoke0001"), "revoke", now);
    if (stage === "prepare") await assert.rejects(f.prepare());
    if (stage === "chunk") assert.notEqual((await f.http("POST", `/api/bridge/artifact-publications/${publication!.publicationId}/chunks`, {
      offset: 0, chunkBase64: bytes.toString("base64"), chunkSha256: sha(bytes)
    })).statusCode, 200);
    if (stage === "seal" || stage === "bind") assert.notEqual((await f.http("POST", `/api/bridge/artifact-publications/${publication!.publicationId}/${stage}`)).statusCode, 200);
    if (stage === "checkpoint") assert.notEqual((await f.http("POST", "/api/bridge/repository-checkpoints", f.checkpoint(artifact))).statusCode, 200);
  });
}

test("committed checkpoint replay survives lease closure without starting another capture", async (t) => {
  const f = await captureFixture(t), checkpoint = f.checkpoint(await f.publish());
  await f.deviceOK("POST", "/api/bridge/repository-checkpoints", checkpoint);
  f.service.closeForDevice(f.principal, f.operation(f.initial, "op_capture_release0001"), "release", now);
  assert.deepEqual(await f.deviceOK("POST", "/api/bridge/repository-checkpoints", checkpoint), checkpoint);
  assert.deepEqual(await f.deviceOK("GET", `/api/bridge/repository-captures/${f.request.operationId}/checkpoint`), checkpoint);
  await assert.rejects(f.prepare("new_upload"));
});

for (const change of ["generation", "unknown_run", "participant", "foreign_device", "capability", "expiry"] as const) {
  test(`capture rejects stale ${change} authorization`, async (t) => {
    const f = await captureFixture(t), checkpoint = f.checkpoint(await f.publish());
    if (change === "generation") f.service.advanceForDevice(f.principal, {
      ...f.operation(f.initial, "op_capture_advance0001"), generation: "f".repeat(64)
    }, now);
    if (change === "unknown_run") new RunRepository(f.database).applyEvent(f.manifest.scope.runId,
      { type: "status", sequence: 1, status: "outcome_unknown" }, now);
    if (change === "participant") f.database.prepare("DELETE FROM room_agent_participants WHERE room_id = ? AND agent_id = ?")
      .run(f.roomId, f.agent.agentId);
    if (change === "capability") f.connections.register(f.device.deviceId, 2, { send() {}, close() {} });
    const principal = change === "foreign_device" ? { ...f.principal, deviceId: "device_foreign0001" } : f.principal;
    assert.throws(() => f.makeService().seal(principal, checkpoint,
      change === "expiry" ? f.manifest.deadline : now), /REPOSITORY_|WORKSPACE_|access denied/u);
    assert.equal((f.database.prepare("SELECT count(*) AS n FROM repository_checkpoints").get() as { n: number }).n, 0);
  });
}

test("a sealed but unbound Artifact and an unapproved output kind cannot enter a checkpoint", async (t) => {
  const f = await captureFixture(t), publication = await f.prepare();
  await f.upload(publication.publicationId);
  const bad = await f.http("POST", "/api/bridge/artifact-publications", {
    leaseId: f.lease.leaseId, runId: f.manifest.scope.runId, agentId: f.agent.agentId,
    workspaceRef: f.lease.workspaceRef, workspaceGeneration: f.lease.workspaceGeneration,
    idempotencyKey: "idem_unapproved_document01", artifactType: "document", fileName: "fake.md",
    mediaType: "text/markdown", title: "Unapproved", summary: "No document slot", sizeBytes: bytes.length, sha256: sha(bytes)
  });
  assert.equal(bad.statusCode, 409);
  const checkpoint = f.checkpoint({ artifactId: "artifact_not_bound0001", artifactRevision: 1 });
  assert.equal((await f.http("POST", "/api/bridge/repository-checkpoints", checkpoint)).statusCode, 409);
  assert.throws(() => f.database.prepare(`INSERT INTO repository_checkpoints
    (checkpoint_id, operation_id, digest, checkpoint_json, recorded_at) VALUES (?, ?, ?, ?, ?)`)
    .run(checkpoint.checkpointId, checkpoint.operationId, checkpoint.digest,
      JSON.stringify(checkpoint), now), /canonical|scope/u);
});

test("capture publication holds one write transaction through authorization and blob bookkeeping", async (t) => {
  const f = await captureFixture(t);
  const repository = new ArtifactPublicationRepository(f.database);
  assert.equal(f.database.inTransaction, false);
  repository.withCaptureWrite(f.lease.leaseId, () => assert.equal(f.database.inTransaction, true));
  assert.equal(f.database.inTransaction, false);
  const artifact = await f.publish();
  assert.equal(artifact.contentSha256, sha(bytes));
});

test("another capture cannot borrow an earlier canonical Artifact even in the same Task with identical bytes", async (t) => {
  const f = await captureFixture(t), artifact = await f.publish();
  const next = structuredClone(f.manifest);
  next.scope.runId = "run_capture_next_attempt0001";
  next.scope.dispatchGeneration++;
  await f.insertRun(next.scope.runId);
  next.scope.taskRevision = (await f.ok("GET", `/api/tasks/${f.task.taskId}`)).taskRevision;
  next.workspace = planIsolatedWorkspace(next.scope, next.repository, now, next.deadline);
  f.reserve(f.rehash(next));
  f.freeze(next);
  const request = hashRequest({ ...f.request, operationId: "op_capture_next_attempt0001",
    execution: next.scope, expectedGeneration: next.workspace.workspaceGeneration,
    action: { kind: "capture", capture: { manifestDigest: next.manifestDigest } } });
  await f.deviceOK("POST", "/api/bridge/repository-captures", request);
  const checkpoint = rehash({ ...f.checkpoint(artifact), operationId: request.operationId,
    scope: next.scope, workspaceRef: next.workspace.workspaceRef, workspaceGeneration: next.workspace.workspaceGeneration });
  const rejected = await f.http("POST", "/api/bridge/repository-checkpoints", checkpoint);
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.match(rejected.body, /OUTPUT_NOT_CANONICAL/u);
});
