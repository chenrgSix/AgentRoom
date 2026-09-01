import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type {
  GovernedExecutionCapabilityReadyGrant,
  GovernedExecutionManifest,
  RepositoryCheckpoint,
  RepositoryOperationReceipt,
  RepositoryOperationRequest,
  VerificationReceipt
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";

import { createServerApp } from "../src/app.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { AuthService } from "../src/security/auth-service.js";
import { ExecutionDependencyResolver } from
  "../src/execution/execution-dependency-resolver.js";
import { ExecutionNodeMaterializationRepository } from
  "../src/execution/execution-node-materialization-repository.js";
import { ExecutionPlanRepository } from
  "../src/execution/execution-plan-repository.js";
import { fixture, now } from "./helpers/execution-plan-fixture.js";

type BridgeSocket = Awaited<ReturnType<FastifyInstance["injectWS"]>>;

interface BridgeMessage {
  type: string;
  payload: Record<string, unknown>;
}

const capability = {
  version: 1 as const,
  workspaceBoundary: "enforced" as const,
  preventivePathEnforcement: false,
  operations: ["prepare", "capture", "verify", "integrate"] as const
};

function envelope(
  type: string,
  payload: Record<string, unknown>,
  suffix: string
): object {
  return {
    protocolVersion: "1.0",
    messageId: `msg_governed_admission_${suffix}`,
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

function nextMessage(socket: BridgeSocket): Promise<BridgeMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      reject(new Error("Timed out waiting for Bridge delivery"));
    }, 5_000);
    const onMessage = (source: { toString(): string }): void => {
      clearTimeout(timer);
      socket.off("close", onClose);
      resolve(JSON.parse(source.toString()) as BridgeMessage);
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

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for governed Agent publication");
}

async function admissionFixture(
  t: TestContext,
  grantChange?: (grant: GovernedExecutionCapabilityReadyGrant) => void,
  options: {
    acceptedDependency?: boolean;
    integratedDependency?: boolean;
    requiredVerificationProfiles?: number;
    verifiedDependency?: boolean;
    captureScheduledDelivery?: boolean;
    schedulerMilliseconds?: number;
  } = {}
) {
  const f = await fixture(t, () => now, {
    executionSchedulerSweepMilliseconds: options.schedulerMilliseconds ?? 0
  });
  const core = new CoreRepository(f.database);
  const auth = new AuthService(f.database);
  const owner = auth.authenticateWebSession(f.authorization.slice(7), now);
  const devices = new MemberDeviceService(core, auth);
  const device = devices.registerOwnDevice(owner, f.teamId, "Governed runner", now);
  const credential = auth.issueDeviceCredential(device.deviceId, now);
  const agents = new AgentService(core, auth);
  const workspaceRef = `workspace_${"e".repeat(64)}`;
  const workspaceGeneration = "e".repeat(64);
  const agent = agents.publishAgent(owner, {
    teamId: f.teamId,
    deviceId: device.deviceId,
    name: "Governed builder",
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
    workspaceRef,
    workspaceGeneration,
    now
  });
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, {
    memberIds: [f.ownerMemberId],
    agentIds: [agent.agentId]
  });

  const socket = await f.app.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${credential.secret}`,
      host: "127.0.0.1"
    }
  });
  t.after(() => socket.terminate());
  await sendAndFlush(socket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-test.1",
    connectionEpoch: 1,
    deviceId: device.deviceId,
    supportedProtocolVersions: ["1.0"],
    governedExecution: capability
  }, "hello0001"));

  const command = f.command();
  for (const node of command.definition.nodes) node.agentId = agent.agentId;
  if ((options.requiredVerificationProfiles ?? 1) > 1) {
    const build = command.definition.nodes.find((node) => node.nodeKey === "Build");
    assert.ok(build);
    build.verificationProfiles.push({
      profileId: "profile_governed_secondary0001",
      revision: 1,
      digest: "f".repeat(64),
      required: true
    });
  }
  if (options.acceptedDependency || options.verifiedDependency ||
    options.integratedDependency) {
    const build = command.definition.nodes.find((node) => node.nodeKey === "Build");
    const consume = command.definition.nodes.find((node) => node.nodeKey === "Review");
    assert.ok(build?.repository);
    assert.ok(consume);
    consume.nodeKey = "Consume";
    consume.kind = "implementation";
    consume.task = {
      mode: "new",
      title: "Consume governed patch",
      goal: "Consume only the exact retained predecessor output",
      ownerMemberId: f.ownerMemberId,
      criteria: structuredClone(build.task.criteria)
    };
    consume.repository = {
      ...structuredClone(build.repository),
      grantId: "grant_governed_consume0001"
    };
    consume.scope = structuredClone(build.scope);
    consume.inputs = [{ slotKey: "patch", kind: "patch", required: true }];
    consume.outputs = [{ slotKey: "output", kind: "patch", required: true }];
    command.definition.edges = [{
      edgeKey: "build_consume",
      fromNodeKey: "Build",
      toNodeKey: "Consume",
      gate: options.integratedDependency
        ? "integrated_commit"
        : options.verifiedDependency ? "verified_output" : "accepted_result",
      bindings: [{ outputSlot: "output", inputSlot: "patch" }]
    }];
    command.definition.policy.maxConcurrency = 1;
    if (options.integratedDependency) {
      command.definition.policy.integration = "local_integration";
      command.definition.policy.integrationTargets = [{
        repositoryId: build.repository.repositoryId,
        targetRef: "refs/heads/main",
        expectedCommit: build.repository.baseCommit
      }];
    }
  }
  const draft = await f.create(command);
  const plan = (await f.ok(
    "POST",
    `/api/execution-plans/${draft.planId}/approvals`,
    {
      operationId: "op_governed_approval0001",
      expectedRevision: draft.current.revision,
      expectedDigest: draft.current.digest,
      expectedRootTaskRevision: command.expectedRootTaskRevision,
      decision: "approved",
      reason: "Authorize one bounded governed capture"
    }
  )).plan;
  const tasksByNode = new Map<string, any>();
  for (const compiled of plan.compiledTasks as Array<{ nodeKey: string; taskId: string }>) {
    const definitionNode = plan.current.definition.nodes.find(
      (candidate: { nodeKey: string }) => candidate.nodeKey === compiled.nodeKey
    );
    if (definitionNode?.kind !== "implementation") continue;
    let compiledTask = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
    compiledTask = await f.ok("POST", `/api/tasks/${compiledTask.taskId}/control`, {
      operationId: `op_governed_task_ready_${compiled.nodeKey.toLowerCase()}0001`,
      expectedTaskRevision: compiledTask.taskRevision,
      lifecycleState: "ready"
    });
    tasksByNode.set(compiled.nodeKey, compiledTask);
  }
  const task = tasksByNode.get("Build");
  assert.ok(task);
  const node = plan.current.definition.nodes.find(
    (candidate: { nodeKey: string }) => candidate.nodeKey === "Build"
  );
  assert.ok(node?.repository);
  const grants = plan.current.definition.nodes
    .filter((candidate: { kind: string }) => candidate.kind === "implementation")
    .map((candidate: typeof node): GovernedExecutionCapabilityReadyGrant => {
      assert.ok(candidate.repository);
      return {
        grant: {
          grantId: candidate.repository.grantId,
          revision: candidate.repository.grantRevision,
          digest: candidate.nodeKey === "Build" ? "d".repeat(64) : "e".repeat(64),
          expiresAt: "2026-08-31T13:00:00.000Z"
        },
        repositoryId: candidate.repository.repositoryId,
        bindingId: candidate.repository.bindingId,
        deviceId: device.deviceId,
        agentId: agent.agentId,
        planId: plan.planId,
        nodeKey: candidate.nodeKey,
        operations: candidate.verificationProfiles.some(
          (profile: { required: boolean }) => profile.required
        )
          ? ["prepare", "capture", "verify"]
          : ["prepare", "capture"],
        runtimeProfile: {
          profileId: candidate.repository.runtimeProfileId,
          revision: 1,
          digest: candidate.repository.runtimeProfileDigest
        },
        verificationProfiles: candidate.verificationProfiles.map(
          (profile: { profileId: string; revision: number; digest: string }) => ({
            profileId: profile.profileId,
            revision: profile.revision,
            digest: profile.digest
          })
        ),
        scopePolicy: structuredClone(candidate.scope),
        integrationTargets: [],
        issuedAt: now,
        revokedAt: null
      };
    });
  const grant = grants.find((candidate) => candidate.nodeKey === "Build");
  assert.ok(grant);
  if (options.integratedDependency) {
    grants.push({
      ...structuredClone(grant),
      grant: {
        ...structuredClone(grant.grant),
        grantId: "grant_governed_integrate0001",
        digest: "c".repeat(64)
      },
      operations: ["integrate"],
      integrationTargets: structuredClone(
        command.definition.policy.integrationTargets
      )
    });
  }
  grantChange?.(grant);
  const agentCapability = { ...capability, readyGrants: grants };
  const scheduledDelivery = options.captureScheduledDelivery
    ? nextMessage(socket)
    : undefined;
  await sendAndFlush(socket, envelope("agent.publish", {
    teamId: f.teamId,
    agentId: agent.agentId,
    ownerMemberId: f.ownerMemberId,
    deviceId: device.deviceId,
    name: agent.name,
    role: agent.role,
    capabilities: {
      invocationMode: "managed",
      supportsStart: true,
      supportsResume: false,
      supportsStreaming: true,
      supportsInterrupt: true,
      supportsHandoff: false,
      supportsWorkspaceLeases: true,
      governedExecution: agentCapability
    },
    workspaceRef,
    workspaceGeneration,
    workspaceAlias: "Governed test workspace"
  }, "publish0001"));
  await waitFor(() => {
    const row = f.database.prepare(`
      SELECT capabilities_json FROM agents WHERE agent_id = ?
    `).get(agent.agentId) as { capabilities_json: string } | undefined;
    const persisted = row && JSON.parse(row.capabilities_json) as {
      governedExecution?: { readyGrants?: unknown[] };
    };
    return persisted?.governedExecution?.readyGrants?.length === grants.length;
  });
  return {
    ...f,
    get app() {
      return f.app;
    },
    socket,
    device,
    credential,
    agent,
    plan,
    node,
    task,
    tasksByNode,
    grant,
    grants,
    agentCapability,
    workspaceRef,
    workspaceGeneration,
    scheduledDelivery
  };
}

type AdmissionFixture = Awaited<ReturnType<typeof admissionFixture>>;
const dependencyBytes = Buffer.from(
  "diff --git a/src/dependency.ts b/src/dependency.ts\n" +
  "--- a/src/dependency.ts\n+++ b/src/dependency.ts\n@@ -1 +1 @@\n" +
  "-export const state = 'old';\n+export const state = 'accepted';\n"
);
const dependencySha256 = createHash("sha256")
  .update(dependencyBytes)
  .digest("hex");

function digestRequest(request: RepositoryOperationRequest): RepositoryOperationRequest {
  const { requestDigest: _, ...unsigned } = request;
  request.requestDigest = executionOperationDigest(unsigned);
  return request;
}

function digestCheckpoint(checkpoint: RepositoryCheckpoint): RepositoryCheckpoint {
  const { digest: _, ...unsigned } = checkpoint;
  checkpoint.digest = executionOperationDigest(unsigned);
  return checkpoint;
}

async function publishCanonicalDependency(
  f: AdmissionFixture,
  manifest: GovernedExecutionManifest
) {
  assert.ok(manifest.capture);
  const authorization = `Bearer ${f.credential.secret}`;
  const request = digestRequest({
    version: 1,
    operationId: manifest.capture.operationId,
    requestDigest: "0".repeat(64),
    plan: {
      planId: manifest.scope.planId,
      revision: manifest.scope.planRevision,
      digest: manifest.scope.planDigest,
      approvalOperationId: manifest.scope.approvalOperationId,
      roomId: manifest.scope.roomId,
      rootTaskId: manifest.capture.rootTaskId
    },
    execution: manifest.scope,
    repositoryId: manifest.repository.repositoryId,
    bindingId: manifest.repository.bindingId,
    deviceId: manifest.scope.deviceId,
    grant: manifest.grant,
    expectedGeneration: manifest.workspace.workspaceGeneration,
    deadline: manifest.deadline,
    action: {
      kind: "capture",
      capture: { manifestDigest: manifest.manifestDigest }
    }
  });
  const lease = await f.ok(
    "POST", "/api/bridge/repository-captures", request, authorization
  );
  const publication = await f.ok("POST", "/api/bridge/artifact-publications", {
    leaseId: lease.leaseId,
    runId: manifest.scope.runId,
    agentId: manifest.scope.agentId,
    workspaceRef: lease.workspaceRef,
    workspaceGeneration: lease.workspaceGeneration,
    idempotencyKey: "idem_governed_dependency_patch0001",
    artifactType: "patch",
    fileName: "accepted.patch",
    mediaType: "text/x-diff",
    title: "Accepted predecessor patch",
    summary: "Canonical captured output for the accepted_result edge",
    sizeBytes: dependencyBytes.length,
    sha256: dependencySha256
  }, authorization);
  await f.ok(
    "POST",
    `/api/bridge/artifact-publications/${publication.publicationId}/chunks`,
    {
      offset: 0,
      chunkBase64: dependencyBytes.toString("base64"),
      chunkSha256: dependencySha256
    },
    authorization
  );
  await f.ok(
    "POST",
    `/api/bridge/artifact-publications/${publication.publicationId}/seal`,
    {},
    authorization
  );
  const artifact = (await f.ok(
    "POST",
    `/api/bridge/artifact-publications/${publication.publicationId}/bind`,
    {},
    authorization
  )).artifact;
  const checkpoint = digestCheckpoint({
    checkpointId: "checkpoint_governed_dependency0001",
    operationId: request.operationId,
    scope: manifest.scope,
    repositoryId: manifest.repository.repositoryId,
    bindingId: manifest.repository.bindingId,
    baseCommit: manifest.repository.baseCommit,
    candidateCommit: "c".repeat(manifest.repository.baseCommit.length),
    candidateTree: "d".repeat(manifest.repository.baseCommit.length),
    inputDigest: manifest.inputDigest,
    workspaceRef: lease.workspaceRef,
    workspaceGeneration: lease.workspaceGeneration,
    outputs: [{
      slotKey: "output",
      artifact: {
        artifactId: artifact.artifactId,
        artifactRevision: artifact.artifactRevision,
        kind: "patch",
        byteLength: dependencyBytes.length,
        contentDigest: dependencySha256
      }
    }],
    capturedAt: now,
    digest: "0".repeat(64)
  });
  await f.ok(
    "POST", "/api/bridge/repository-checkpoints", checkpoint, authorization
  );
  return { artifact, checkpoint, lease, request };
}

async function retainIndependentVerification(
  f: AdmissionFixture,
  manifest: GovernedExecutionManifest,
  captured: Awaited<ReturnType<typeof publishCanonicalDependency>>,
  profileIndex = 0,
  outcome: "passed" | "failed" = "passed"
) {
  const profile = manifest.verificationProfiles.filter(
    (entry) => entry.required
  )[profileIndex];
  assert.ok(profile);
  const suffix = profileIndex + 1;
  const authorization = `Bearer ${f.credential.secret}`;
  const request = digestRequest({
    version: 1,
    operationId: `op_governed_verification000${suffix}`,
    requestDigest: "0".repeat(64),
    plan: {
      planId: manifest.scope.planId,
      revision: manifest.scope.planRevision,
      digest: manifest.scope.planDigest,
      approvalOperationId: manifest.scope.approvalOperationId,
      roomId: manifest.scope.roomId,
      rootTaskId: manifest.capture!.rootTaskId
    },
    execution: manifest.scope,
    repositoryId: manifest.repository.repositoryId,
    bindingId: manifest.repository.bindingId,
    deviceId: manifest.scope.deviceId,
    grant: manifest.grant,
    expectedGeneration: manifest.workspace.workspaceGeneration,
    deadline: manifest.deadline,
    action: {
      kind: "verify",
      verify: {
        candidateCommit: captured.checkpoint.candidateCommit,
        candidateTree: captured.checkpoint.candidateTree,
        inputDigest: captured.checkpoint.inputDigest,
        profile: {
          profileId: profile.profileId,
          revision: profile.revision,
          digest: profile.digest
        }
      }
    }
  });
  await f.ok(
    "POST",
    "/api/bridge/repository-verifications",
    request,
    authorization
  );
  const logBytes = Buffer.from(JSON.stringify({
    version: 1,
    stdout: outcome === "passed" ? "independent verification passed" : "",
    stderr: outcome === "failed" ? "independent verification failed" : "",
    truncated: false,
    spawned: true
  }));
  const logDigest = createHash("sha256").update(logBytes).digest("hex");
  const publication = await f.ok(
    "POST",
    "/api/bridge/artifact-publications",
    {
      leaseId: captured.lease.leaseId,
      runId: manifest.scope.runId,
      agentId: manifest.scope.agentId,
      workspaceRef: captured.lease.workspaceRef,
      workspaceGeneration: captured.lease.workspaceGeneration,
      verificationOperationId: request.operationId,
      idempotencyKey: `idem_governed_verification_log000${suffix}`,
      artifactType: "test_result",
      fileName: "verification.json",
      mediaType: "application/json",
      title: "Independent verification log",
      summary: "Exact output from the admitted verifier profile",
      sizeBytes: logBytes.length,
      sha256: logDigest
    },
    authorization
  );
  await f.ok(
    "POST",
    `/api/bridge/artifact-publications/${publication.publicationId}/chunks`,
    {
      offset: 0,
      chunkBase64: logBytes.toString("base64"),
      chunkSha256: logDigest
    },
    authorization
  );
  await f.ok(
    "POST",
    `/api/bridge/artifact-publications/${publication.publicationId}/seal`,
    {},
    authorization
  );
  const logArtifact = (await f.ok(
    "POST",
    `/api/bridge/artifact-publications/${publication.publicationId}/bind`,
    {},
    authorization
  )).artifact;
  const receipt: VerificationReceipt = {
    version: 1,
    verificationId: `verification_governed000${suffix}`,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    plan: request.plan,
    execution: manifest.scope,
    integrationOperationId: null,
    repositoryId: request.repositoryId,
    bindingId: request.bindingId,
    authority: { kind: "bridge", deviceId: f.device.deviceId },
    candidateCommit: captured.checkpoint.candidateCommit,
    candidateTree: captured.checkpoint.candidateTree,
    inputDigest: captured.checkpoint.inputDigest,
    profile: request.action.verify!.profile,
    startedAt: now,
    finishedAt: now,
    outcome,
    exitCode: outcome === "passed" ? 0 : 1,
    durationMilliseconds: 0,
    logArtifact: {
      artifactId: logArtifact.artifactId,
      artifactRevision: logArtifact.artifactRevision,
      contentDigest: logDigest,
      byteLength: logBytes.length,
      kind: "test_result"
    }
  };
  return f.ok(
    "POST",
    "/api/bridge/verification-receipts",
    receipt,
    authorization
  );
}

async function prepareVerifiedDependencySource(
  t: TestContext,
  integrated = false
) {
  const f = await admissionFixture(t, undefined, {
    integratedDependency: integrated,
    verifiedDependency: !integrated,
    captureScheduledDelivery: true,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { n: number }).n === 1);
  const buildRequest = await f.scheduledDelivery!;
  const manifest = (buildRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  await sendAndFlush(f.socket, envelope("run.accepted", {
    runId: manifest.scope.runId,
    traceId: buildRequest.payload.traceId,
    agentId: f.agent.agentId,
    sequence: 1
  }, "failed_verification_build_accepted0001"));
  await waitFor(() => new RunRepository(f.database)
    .getRun(manifest.scope.runId)?.state === "delivered");
  const runs = new RunRepository(f.database);
  runs.applyEvent(manifest.scope.runId, {
    type: "status",
    sequence: 2,
    status: "working"
  }, "2026-08-31T12:00:01.000Z");
  let task = await f.ok("GET", `/api/tasks/${f.task.taskId}`);
  task = await f.ok("POST", `/api/tasks/${f.task.taskId}/control`, {
    operationId: "op_failed_verification_build_active0001",
    expectedTaskRevision: task.taskRevision,
    lifecycleState: "active"
  });
  const captured = await publishCanonicalDependency(f, manifest);
  runs.applyEvent(manifest.scope.runId, {
    type: "status",
    sequence: 3,
    status: "completed"
  }, "2026-08-31T12:00:02.000Z");
  const criterion = task.criteria.find(
    (candidate: { required: boolean }) => candidate.required
  );
  assert.ok(criterion);
  const result = await f.ok("POST", "/api/bridge/results", {
    actorKind: "managed_agent",
    agentId: f.agent.agentId,
    runId: manifest.scope.runId,
    proposal: {
      operationId: "op_failed_verification_result0001",
      taskId: task.taskId,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision,
      proposedAtTaskRevision: task.taskRevision,
      supersedesResultId: null,
      outcome: "satisfied",
      summary: "The candidate still requires independent verification.",
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: "evidence_failed_verification_artifact0001",
        kind: "artifact",
        artifactId: captured.artifact.artifactId
      }, {
        evidenceRefId: "evidence_failed_verification_run0001",
        kind: "run_event",
        runId: manifest.scope.runId,
        sequence: 3
      }],
      criterionClaims: [{
        criterionKey: criterion.criterionKey,
        coverage: "satisfied",
        explanation: "The exact candidate is available to the verifier.",
        evidenceRefIds: ["evidence_failed_verification_artifact0001"]
      }]
    }
  }, `Bearer ${f.credential.secret}`);
  return { f, manifest, captured, result };
}

async function reconnectGovernedAgent(
  t: TestContext,
  f: AdmissionFixture,
  epoch: number,
  expectDelivery = true
) {
  await f.app.ready();
  const socket = await f.app.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${f.credential.secret}`,
      host: "127.0.0.1"
    }
  });
  t.after(() => socket.terminate());
  const delivery = expectDelivery ? nextMessage(socket) : undefined;
  await sendAndFlush(socket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-test.1",
    connectionEpoch: epoch,
    deviceId: f.device.deviceId,
    supportedProtocolVersions: ["1.0"],
    governedExecution: capability
  }, `dependency_hello${epoch}`));
  await sendAndFlush(socket, envelope("agent.publish", {
    teamId: f.teamId,
    agentId: f.agent.agentId,
    ownerMemberId: f.ownerMemberId,
    deviceId: f.device.deviceId,
    name: f.agent.name,
    role: f.agent.role,
    capabilities: {
      invocationMode: "managed",
      supportsStart: true,
      supportsResume: false,
      supportsStreaming: true,
      supportsInterrupt: true,
      supportsHandoff: false,
      supportsWorkspaceLeases: true,
      governedExecution: f.agentCapability
    },
    workspaceRef: f.workspaceRef,
    workspaceGeneration: f.workspaceGeneration,
    workspaceAlias: "Governed dependency workspace"
  }, `dependency_publish${epoch}`));
  return { socket, delivery };
}

async function reconcileVerifiedMaterializationConcurrently(
  t: TestContext,
  f: AdmissionFixture,
  identity: { planId: string; planRevision: number; nodeKey: string }
): Promise<void> {
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => resolve())
      );
      child.kill("SIGKILL");
      await closed;
    }));
  });
  const code = `
    import { openDatabase } from ${JSON.stringify(new URL("../src/data/database.ts", import.meta.url).href)};
    import { SqliteTransactionBoundary } from ${JSON.stringify(new URL("../src/data/sqlite-transaction-boundary.ts", import.meta.url).href)};
    import { ExecutionNodeMaterializationRepository } from ${JSON.stringify(new URL("../src/execution/execution-node-materialization-repository.ts", import.meta.url).href)};
    import { ExecutionNodeProjector } from ${JSON.stringify(new URL("../src/execution/execution-node-projector.ts", import.meta.url).href)};
    import { ExecutionNodeStateRepository } from ${JSON.stringify(new URL("../src/execution/execution-node-state-repository.ts", import.meta.url).href)};
    import { ExecutionSettlementService } from ${JSON.stringify(new URL("../src/execution/execution-settlement-service.ts", import.meta.url).href)};
    import { AcceptedResultMaterializer } from ${JSON.stringify(new URL("../src/execution/materialization/accepted-result-materializer.ts", import.meta.url).href)};
    import { ExecutionMaterializationService } from ${JSON.stringify(new URL("../src/execution/materialization/execution-materialization-service.ts", import.meta.url).href)};
    import { VerifiedOutputMaterializer } from ${JSON.stringify(new URL("../src/execution/materialization/verified-output-materializer.ts", import.meta.url).href)};
    import { IntegratedCommitMaterializer } from ${JSON.stringify(new URL("../src/execution/materialization/integrated-commit-materializer.ts", import.meta.url).href)};
    process.send({ ready: true });
    process.once("message", ({ databasePath, identity, now }) => {
      const database = openDatabase(databasePath);
      try {
        const nodes = new ExecutionNodeStateRepository(database);
        const materializations = new ExecutionNodeMaterializationRepository(database);
        const settlement = new ExecutionSettlementService(
          database,
          new SqliteTransactionBoundary(database),
          new ExecutionNodeProjector(nodes),
          new ExecutionMaterializationService(
            new AcceptedResultMaterializer(database, materializations),
            new VerifiedOutputMaterializer(database, materializations),
            new IntegratedCommitMaterializer(database, materializations)
          )
        );
        process.send({ state: settlement.reconcileOne(identity, now) });
      } catch (error) {
        process.send({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        database.close();
        process.disconnect();
      }
    });
  `;
  const workers = await Promise.all([0, 1].map(() => new Promise<{
    child: ChildProcess;
    result: Promise<{ error?: string; state?: unknown }>;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      code
    ], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let stderr = "";
    let value: { error?: string; state?: unknown } | undefined;
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    const result = new Promise<{ error?: string; state?: unknown }>(
      (resolveResult, rejectResult) => {
        child.on("message", (message: { ready?: boolean; error?: string; state?: unknown }) => {
          if (message.ready) resolve({ child, result });
          else value = message;
        });
        child.once("close", (exitCode) => {
          if (exitCode !== 0 || !value) {
            rejectResult(new Error(
              `Settlement worker failed: ${exitCode} ${stderr}`
            ));
          } else {
            resolveResult(value);
          }
        });
      }
    );
    result.catch(() => {});
  })));
  for (const worker of workers) {
    worker.child.send!({ databasePath: f.databasePath, identity, now });
  }
  const results = await Promise.all(workers.map((worker) => worker.result));
  assert.ok(results.some((result) => result.state), JSON.stringify(results));
  assert.ok(results.every((result) =>
    result.state || /locked|busy/u.test(result.error ?? "")
  ), JSON.stringify(results));
}

test("approved governed Build dispatch seals and delivers one exact capture manifest", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t);
  const delivery = nextMessage(f.socket);
  const payload = {
    taskId: f.task.taskId,
    content: "Implement the approved bounded change.",
    mentionAgentId: f.agent.agentId,
    clientMessageId: "client_governed_dispatch0001"
  };
  const response = await f.request(
    "POST",
    `/api/rooms/${f.roomId}/messages`,
    payload
  );
  assert.equal(response.statusCode, 200, response.body);
  const routed = response.json();
  assert.equal(routed.runs.length, 1);
  const requested = await delivery;
  assert.equal(requested.type, "run.requested");
  const context = requested.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  };
  const manifest = context.execution;
  assertExecutionCommand("executionManifest", manifest);
  const { manifestDigest: _, ...unsigned } = manifest;
  assert.equal(manifest.manifestDigest, executionOperationDigest(unsigned));
  assert.equal(manifest.scope.planId, f.plan.planId);
  assert.equal(manifest.scope.nodeKey, "Build");
  assert.equal(manifest.scope.agentId, f.agent.agentId);
  assert.equal(manifest.scope.deviceId, f.device.deviceId);
  assert.equal(manifest.grant.digest, f.grant.grant.digest);
  assert.deepEqual(manifest.verificationProfiles, f.node.verificationProfiles);
  assert.deepEqual(manifest.capture?.outputs.map((output) => output.slotKey),
    f.node.outputs.filter((output: { kind: string }) =>
      output.kind === "patch" || output.kind === "commit"
    ).map((output: { slotKey: string }) => output.slotKey));

  const admission = f.database.prepare(`
    SELECT manifest_digest, grant_json FROM execution_run_admissions
    WHERE run_id = ?
  `).get(routed.runs[0].runId) as {
    manifest_digest: string;
    grant_json: string;
  };
  assert.equal(admission.manifest_digest, manifest.manifestDigest);
  assert.deepEqual(JSON.parse(admission.grant_json), f.grant);
  assert.throws(() => f.database.prepare(`
    UPDATE execution_run_admissions SET manifest_digest = ? WHERE run_id = ?
  `).run(manifest.manifestDigest, routed.runs[0].runId), /seal one manifest only/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_run_admissions WHERE run_id = ?
  `).run(routed.runs[0].runId), /immutable/u);
  assert.throws(() => f.database.prepare(`
    UPDATE execution_dispatch_intents SET source = 'scheduler'
    WHERE run_id = ?
  `).run(routed.runs[0].runId), /immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_dispatch_intents WHERE run_id = ?
  `).run(routed.runs[0].runId), /immutable/u);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM isolated_workspace_leases WHERE run_id = ?
  `).get(routed.runs[0].runId) as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM run_deliveries WHERE run_id = ?
  `).get(routed.runs[0].runId) as { n: number }).n, 1);

  const replay = await f.request(
    "POST",
    `/api/rooms/${f.roomId}/messages`,
    payload
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().runs[0].runId, routed.runs[0].runId);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_run_admissions
  `).get() as { n: number }).n, 1);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("missing exact current grant rolls back governed Message and Run state", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, (grant) => {
    grant.planId = "plan_foreign0001";
  });
  const beforeMessages = (f.database.prepare(`
    SELECT count(*) AS n FROM messages
  `).get() as { n: number }).n;
  const response = await f.request(
    "POST",
    `/api/rooms/${f.roomId}/messages`,
    {
      taskId: f.task.taskId,
      content: "Do not bypass the frozen plan.",
      mentionAgentId: f.agent.agentId,
      clientMessageId: "client_governed_rejected0001"
    }
  );
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.body, /EXECUTION_DISPATCH_GRANT_UNAVAILABLE/u);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM messages
  `).get() as { n: number }).n, beforeMessages);
  for (const table of [
    "execution_dispatch_intents",
    "execution_run_admissions",
    "runs",
    "isolated_workspace_leases",
    "run_deliveries"
  ]) {
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM ${table}
    `).get() as { n: number }).n, 0, `${table} retained partial state`);
  }
  assert.throws(() => f.database.prepare(`
    INSERT INTO runs (
      run_id, trace_id, room_id, task_id, trigger_message_id,
      requester_member_id, target_agent_id, instruction, state,
      last_sequence, deadline_at, created_at, updated_at, attempt_number
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, 1)
  `).run(
    "run_governed_bypass0001",
    "trace_governed_bypass0001",
    f.roomId,
    f.task.taskId,
    f.message.messageId,
    f.ownerMemberId,
    f.agent.agentId,
    "Bypass admission",
    "2026-08-31T12:20:00.000Z",
    now,
    now
  ), /requires exact execution admission/u);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("scheduler blocker leaves no trace Message or partial admission", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, (grant) => {
    grant.planId = "plan_foreign0001";
  }, {
    schedulerMilliseconds: 100
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM messages
    WHERE sender_type = 'system' AND sender_id = 'execution-scheduler'
  `).get() as { n: number }).n, 0);
  for (const table of [
    "execution_dispatch_intents",
    "execution_run_admissions",
    "runs",
    "isolated_workspace_leases",
    "run_deliveries"
  ]) {
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM ${table}
    `).get() as { n: number }).n, 0, `${table} retained partial state`);
  }
  assert.equal((f.database.prepare(`
    SELECT blocker_code FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { blocker_code: string }).blocker_code,
  "EXECUTION_GRANT_UNAVAILABLE");
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("scheduler creates one system-traced DispatchIntent and ordinary Run", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    captureScheduledDelivery: true,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
  `).get() as { n: number }).n === 1);
  const requested = await f.scheduledDelivery!;
  assert.equal(requested.type, "run.requested");
  const manifest = (requested.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  const row = f.database.prepare(`
    SELECT intent.*, run.instruction, run.state AS run_state,
      message.sender_type, message.sender_id,
      (SELECT count(*) FROM message_mentions mention
        WHERE mention.message_id = message.message_id) AS mention_count,
      admission.manifest_digest
    FROM execution_dispatch_intents intent
    JOIN runs run ON run.run_id = intent.run_id
    JOIN messages message ON message.message_id = intent.trace_message_id
    JOIN execution_run_admissions admission ON admission.run_id = intent.run_id
    WHERE intent.plan_id = ? AND intent.node_key = 'Build'
  `).get(f.plan.planId) as {
    dispatch_generation: number;
    instruction: string;
    manifest_digest: string;
    mention_count: number;
    operation_digest: string;
    run_id: string;
    run_state: string;
    sender_id: string;
    sender_type: string;
    source: string;
  };
  assert.equal(row.source, "scheduler");
  assert.equal(row.dispatch_generation, 1);
  assert.equal(row.sender_type, "system");
  assert.equal(row.sender_id, "execution-scheduler");
  assert.equal(row.mention_count, 0);
  assert.equal(row.instruction, f.task.goal);
  assert.equal(row.manifest_digest, manifest.manifestDigest);
  assert.equal(row.run_id, manifest.scope.runId);
  assert.match(row.operation_digest, /^[a-f0-9]{64}$/u);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
  `).get() as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM runs
  `).get() as { n: number }).n, 1);
  const nodeState = f.database.prepare(`
    SELECT state, run_id, dispatch_generation
    FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    dispatch_generation: number;
    run_id: string;
    state: string;
  };
  assert.equal(nodeState.state, "dispatched");
  assert.equal(nodeState.run_id, row.run_id);
  assert.equal(nodeState.dispatch_generation, 1);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("dependency resolver keeps verified_output closed until retained verification", async (t) => {
  const f = await admissionFixture(t);
  const resolver = new ExecutionDependencyResolver(
    new ExecutionPlanRepository(f.database),
    new ExecutionNodeMaterializationRepository(f.database)
  );
  assert.deepEqual(resolver.resolve({
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Review"
  }), {
    ready: false,
    blocker: "EXECUTION_DEPENDENCY_NOT_MATERIALIZED"
  });
});

test("a failed independent verification receipt leaves the dependency gate closed", {
  timeout: 30_000
}, async (t) => {
  const { f, manifest, captured, result } =
    await prepareVerifiedDependencySource(t);
  const retained = await retainIndependentVerification(
    f,
    manifest,
    captured,
    0,
    "failed"
  );
  assert.equal(retained.receipt.outcome, "failed");
  assert.equal(result.state, "proposed");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_verified_node_materializations
  `).get() as { n: number }).n, 0);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { n: number }).n, 0);
  assert.equal((f.database.prepare(`
    SELECT blocker_code FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { blocker_code: string }).blocker_code,
  "EXECUTION_DEPENDENCY_NOT_MATERIALIZED");
  await f.restart(0);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_verified_node_materializations
  `).get() as { n: number }).n, 0,
  "restart cannot reinterpret a failed receipt as passed proof");
  assert.equal((f.database.prepare(`
    SELECT outcome FROM verification_receipts
    WHERE verification_id = ?
  `).get(retained.receipt.verificationId) as { outcome: string }).outcome,
  "failed");
});

test("exact human integration approval admits one immutable serialized operation", {
  timeout: 30_000
}, async (t) => {
  const { f, manifest, captured } =
    await prepareVerifiedDependencySource(t, true);
  const verification = await retainIndependentVerification(
    f,
    manifest,
    captured
  );
  await f.restart(0);
  await reconnectGovernedAgent(t, f, 2, false);
  await waitFor(() => Boolean(f.database.prepare(`
    SELECT 1 FROM execution_verified_node_materializations
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId)));
  const materialization = new ExecutionNodeMaterializationRepository(
    f.database
  ).get({
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build"
  }, "verified_output");
  assert.ok(materialization?.gate === "verified_output");
  const target = f.plan.current.definition.policy.integrationTargets[0];
  assert.ok(target);
  const command = {
    operationId: "op_integration_approval0001",
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build",
    materializationDigest: materialization.materializationDigest,
    candidateCommit: materialization.candidateCommit,
    candidateTree: materialization.candidateTree,
    inputDigest: materialization.inputDigest,
    target,
    verificationReceipts: materialization.verificationReceipts.map((pin) => ({
      verificationId: pin.verificationId,
      receiptDigest: pin.receiptDigest
    })),
    deadline: "2026-08-31T12:30:00.000Z"
  };
  const approval = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/integration-approvals`,
    command
  );
  assert.match(approval.approvalDigest, /^[a-f0-9]{64}$/u);
  assert.match(approval.integrationOperationId, /^op_integration_[a-f0-9]{64}$/u);
  assert.equal(approval.approvedByMemberId, f.ownerMemberId);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM repository_integration_locks
    WHERE repository_id = ? AND target_ref = ?
  `).get(target.repositoryId, target.targetRef) as { n: number }).n, 1);

  const admission = await f.ok(
    "GET",
    `/api/bridge/repository-integrations/${approval.integrationOperationId}`,
    undefined,
    `Bearer ${f.credential.secret}`
  );
  const operation = admission.operation as RepositoryOperationRequest;
  assert.equal(admission.checkpoint.checkpointId, materialization.checkpointId);
  assert.equal(admission.checkpoint.candidateCommit, materialization.candidateCommit);
  assert.equal(admission.checkpoint.candidateTree, materialization.candidateTree);
  assert.equal(operation.action.kind, "integrate");
  assert.deepEqual(operation.action.integrate?.target, target);
  assert.equal(
    operation.action.integrate?.integrationApprovalOperationId,
    command.operationId
  );
  assert.deepEqual(
    operation.action.integrate?.verificationIds,
    [verification.receipt.verificationId]
  );
  const integrationGrant = f.grants.find((grant) =>
    grant.operations.length === 1 && grant.operations[0] === "integrate"
  );
  assert.ok(integrationGrant);
  assert.equal(operation.grant.digest, integrationGrant.grant.digest);

  const receipt: RepositoryOperationReceipt = {
    version: 1,
    operationId: operation.operationId,
    requestDigest: operation.requestDigest,
    kind: "integrate",
    repositoryId: operation.repositoryId,
    bindingId: operation.bindingId,
    deviceId: operation.deviceId,
    state: "succeeded",
    observedGeneration: operation.expectedGeneration,
    checkpointId: admission.checkpoint.checkpointId,
    verificationId: null,
    candidateCommit: operation.action.integrate!.candidateCommit,
    candidateTree: operation.action.integrate!.candidateTree,
    target: operation.action.integrate!.target,
    providerObservationId: null,
    errorCode: null,
    recordedAt: now
  };
  const retained = await f.ok(
    "POST",
    "/api/bridge/integration-receipts",
    receipt,
    `Bearer ${f.credential.secret}`
  );
  assert.deepEqual(retained.receipt, receipt);
  assert.match(retained.receiptDigest, /^[a-f0-9]{64}$/u);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM repository_integration_locks
  `).get() as { n: number }).n, 0);
  assert.throws(() => f.database.prepare(`
    UPDATE integration_receipts SET state = 'failed' WHERE operation_id = ?
  `).run(operation.operationId), /immutable/u);
  assert.deepEqual(await f.ok(
    "POST",
    "/api/bridge/integration-receipts",
    receipt,
    `Bearer ${f.credential.secret}`
  ), retained);
  assert.deepEqual(await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/integration-approvals`,
    command
  ), approval);
  const changed = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/integration-approvals`,
    { ...command, candidateTree: "e".repeat(command.candidateTree.length) }
  );
  assert.equal(changed.statusCode, 409, changed.body);
  assert.match(changed.body, /INTEGRATION_APPROVAL_OPERATION_CONFLICT/u);
  await f.restart(100);
  const downstream = await reconnectGovernedAgent(t, f, 3);
  let consumeRequest: BridgeMessage;
  try {
    consumeRequest = await downstream.delivery!;
  } catch (error) {
    const state = f.database.prepare(`
      SELECT state, blocker_code FROM execution_node_states
      WHERE plan_id = ? AND node_key = 'Consume'
    `).get(f.plan.planId);
    const integratedCount = (f.database.prepare(`
      SELECT count(*) AS n FROM execution_integrated_node_materializations
    `).get() as { n: number }).n;
    const dispatches = f.database.prepare(`
      SELECT node_key, run_id FROM execution_dispatch_intents
      WHERE plan_id = ? ORDER BY node_key
    `).all(f.plan.planId);
    throw new Error(`Consume was not scheduled: ${JSON.stringify({
      state,
      integratedCount,
      dispatches
    })}`, { cause: error });
  }
  const consumeManifest = (consumeRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  assert.equal(consumeManifest.scope.nodeKey, "Consume");
  assert.equal(consumeManifest.inputs.length, 1);
  assert.equal(consumeManifest.inputs[0]!.gate, "integrated_commit");
  assert.equal(consumeManifest.inputs[0]!.gateOperationId, operation.operationId);
  assert.equal(consumeManifest.inputs[0]!.sourceCommit,
    operation.action.integrate!.candidateCommit);
  assert.equal(consumeManifest.inputs[0]!.sourceTree,
    operation.action.integrate!.candidateTree);
  const content = await f.request(
    "GET",
    `/api/bridge/runs/${consumeManifest.scope.runId}/execution-inputs/${consumeManifest.inputs[0]!.bindingId}/content`,
    undefined,
    `Bearer ${f.credential.secret}`
  );
  assert.equal(content.statusCode, 200, content.body);
  assert.deepEqual(content.rawPayload, dependencyBytes);
  const integrated = new ExecutionNodeMaterializationRepository(
    f.database
  ).get({
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build"
  }, "integrated_commit");
  assert.ok(integrated?.gate === "integrated_commit");
  assert.equal(integrated.integrationReceiptDigest, retained.receiptDigest);
  assert.equal(integrated.verifiedMaterializationDigest,
    materialization.materializationDigest);
  assert.throws(() => f.database.prepare(`
    UPDATE execution_integrated_node_materializations
    SET integration_receipt_digest = ?
  `).run("0".repeat(64)), /immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_integrated_node_materializations
  `).run(), /retained evidence/u);
  assert.deepEqual(new ExecutionDependencyResolver(
    new ExecutionPlanRepository(f.database),
    new ExecutionNodeMaterializationRepository(f.database)
  ).resolve({
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Consume"
  }), {
    ready: true,
    selections: [{
      inputSlot: "patch",
      sourceResultId: materialization.sourceResultId,
      artifactId: materialization.artifactPins[0]!.artifactId
    }]
  });
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

for (const terminal of ["failed", "canceled", "outcome_unknown"] as const) {
  test(`${terminal} integration receipts never materialize integrated_commit`, {
    timeout: 30_000
  }, async (t) => {
    const { f, manifest, captured } =
      await prepareVerifiedDependencySource(t, true);
    await retainIndependentVerification(f, manifest, captured);
    await f.restart(0);
    await reconnectGovernedAgent(t, f, 2, false);
    await waitFor(() => Boolean(f.database.prepare(`
      SELECT 1 FROM execution_verified_node_materializations
      WHERE plan_id = ? AND node_key = 'Build'
    `).get(f.plan.planId)));
    const materialization = new ExecutionNodeMaterializationRepository(
      f.database
    ).get({
      planId: f.plan.planId,
      planRevision: f.plan.current.revision,
      nodeKey: "Build"
    }, "verified_output");
    assert.ok(materialization?.gate === "verified_output");
    const target = f.plan.current.definition.policy.integrationTargets[0];
    assert.ok(target);
    const approval = await f.ok(
      "POST",
      `/api/execution-plans/${f.plan.planId}/integration-approvals`,
      {
        operationId: "op_integration_terminal0001",
        planId: f.plan.planId,
        planRevision: f.plan.current.revision,
        nodeKey: "Build",
        materializationDigest: materialization.materializationDigest,
        candidateCommit: materialization.candidateCommit,
        candidateTree: materialization.candidateTree,
        inputDigest: materialization.inputDigest,
        target,
        verificationReceipts: materialization.verificationReceipts.map((pin) => ({
          verificationId: pin.verificationId,
          receiptDigest: pin.receiptDigest
        })),
        deadline: "2026-08-31T12:30:00.000Z"
      }
    );
    const admission = await f.ok(
      "GET",
      `/api/bridge/repository-integrations/${approval.integrationOperationId}`,
      undefined,
      `Bearer ${f.credential.secret}`
    );
    const operation = admission.operation as RepositoryOperationRequest;
    const receipt: RepositoryOperationReceipt = {
      version: 1,
      operationId: operation.operationId,
      requestDigest: operation.requestDigest,
      kind: "integrate",
      repositoryId: operation.repositoryId,
      bindingId: operation.bindingId,
      deviceId: operation.deviceId,
      state: terminal,
      observedGeneration: operation.expectedGeneration,
      checkpointId: admission.checkpoint.checkpointId,
      verificationId: null,
      candidateCommit: operation.action.integrate!.candidateCommit,
      candidateTree: operation.action.integrate!.candidateTree,
      target: operation.action.integrate!.target,
      providerObservationId: null,
      errorCode: `INTEGRATION_${terminal.toUpperCase()}`,
      recordedAt: now
    };
    await f.ok(
      "POST",
      "/api/bridge/integration-receipts",
      receipt,
      `Bearer ${f.credential.secret}`
    );
    await f.restart(0);
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM execution_integrated_node_materializations
    `).get() as { n: number }).n, 0);
    assert.deepEqual(new ExecutionDependencyResolver(
      new ExecutionPlanRepository(f.database),
      new ExecutionNodeMaterializationRepository(f.database)
    ).resolve({
      planId: f.plan.planId,
      planRevision: f.plan.current.revision,
      nodeKey: "Consume"
    }), {
      ready: false,
      blocker: "EXECUTION_DEPENDENCY_NOT_MATERIALIZED"
    });
  });
}

test("independently verified predecessor output materializes and drives exact downstream bytes", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    verifiedDependency: true,
    requiredVerificationProfiles: 2,
    captureScheduledDelivery: true,
    schedulerMilliseconds: 100
  });
  try {
    await waitFor(() => (f.database.prepare(`
      SELECT count(*) AS n FROM execution_dispatch_intents
      WHERE plan_id = ? AND node_key = 'Build'
    `).get(f.plan.planId) as { n: number }).n === 1);
  } catch (error) {
    const state = f.database.prepare(`
      SELECT state, blocker_code FROM execution_node_states
      WHERE plan_id = ? AND node_key = 'Build'
    `).get(f.plan.planId);
    throw new Error(`Build was not scheduled: ${JSON.stringify(state)}`, {
      cause: error
    });
  }
  const buildRequest = await f.scheduledDelivery!;
  const buildManifest = (buildRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  const buildRunId = buildManifest.scope.runId;
  await sendAndFlush(f.socket, envelope("run.accepted", {
    runId: buildRunId,
    traceId: buildRequest.payload.traceId,
    agentId: f.agent.agentId,
    sequence: 1
  }, "verified_build_accepted0001"));
  await waitFor(() => new RunRepository(f.database).getRun(buildRunId)?.state === "delivered");
  const runs = new RunRepository(f.database);
  assert.equal(runs.applyEvent(buildRunId, {
    type: "status",
    sequence: 2,
    status: "working"
  }, "2026-08-31T12:00:01.000Z").applied, true);
  let buildTask = await f.ok("GET", `/api/tasks/${f.task.taskId}`);
  buildTask = await f.ok("POST", `/api/tasks/${f.task.taskId}/control`, {
    operationId: "op_verified_build_active0001",
    expectedTaskRevision: buildTask.taskRevision,
    lifecycleState: "active"
  });
  const captured = await publishCanonicalDependency(f, buildManifest);
  assert.equal(runs.applyEvent(buildRunId, {
    type: "status",
    sequence: 3,
    status: "completed"
  }, "2026-08-31T12:00:02.000Z").applied, true);
  const criterion = buildTask.criteria.find(
    (candidate: { required: boolean }) => candidate.required
  );
  assert.ok(criterion);
  const result = await f.ok("POST", "/api/bridge/results", {
    actorKind: "managed_agent",
    agentId: f.agent.agentId,
    runId: buildRunId,
    proposal: {
      operationId: "op_verified_result_canonical0001",
      taskId: buildTask.taskId,
      definitionRevision: buildTask.definitionRevision,
      criteriaRevision: buildTask.criteriaRevision,
      proposedAtTaskRevision: buildTask.taskRevision,
      supersedesResultId: null,
      outcome: "satisfied",
      summary: "The managed Run proposes the exact captured candidate.",
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: "evidence_verified_artifact0001",
        kind: "artifact",
        artifactId: captured.artifact.artifactId
      }, {
        evidenceRefId: "evidence_verified_run0001",
        kind: "run_event",
        runId: buildRunId,
        sequence: 3
      }],
      criterionClaims: [{
        criterionKey: criterion.criterionKey,
        coverage: "satisfied",
        explanation: "The exact candidate is independently verifiable.",
        evidenceRefIds: ["evidence_verified_artifact0001"]
      }]
    }
  }, `Bearer ${f.credential.secret}`);
  assert.equal(result.state, "proposed", "verification does not accept a Result");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM result_reviews WHERE result_id = ?
  `).get(result.resultId) as { n: number }).n, 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_verified_node_materializations
  `).get() as { n: number }).n, 0, "a Result claim is not verification authority");
  assert.equal((f.database.prepare(`
    SELECT blocker_code FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { blocker_code: string }).blocker_code,
  "EXECUTION_DEPENDENCY_NOT_MATERIALIZED");

  await f.restart(0);
  const firstReceipt = await retainIndependentVerification(
    f,
    buildManifest,
    captured,
    0
  );
  assert.equal(firstReceipt.receipt.outcome, "passed");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_verified_node_materializations
  `).get() as { n: number }).n, 0,
  "one passed receipt cannot substitute for the complete required profile set");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { n: number }).n, 0);
  const secondReceipt = await retainIndependentVerification(
    f,
    buildManifest,
    captured,
    1
  );
  assert.equal(secondReceipt.receipt.outcome, "passed");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_verified_node_materializations
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { n: number }).n, 0,
  "receipt retention alone cannot bypass settlement authority");
  await reconcileVerifiedMaterializationConcurrently(t, f, {
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build"
  });
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_verified_node_materializations
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { n: number }).n, 1,
  "concurrent reconciliation created more than one materialization");
  const materialization = f.database.prepare(`
    SELECT * FROM execution_verified_node_materializations
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    artifact_pins_json: string;
    candidate_commit: string;
    candidate_tree: string;
    checkpoint_id: string;
    gate: string;
    gate_operation_id: string;
    materialization_digest: string;
    source_result_id: string;
    verification_receipts_json: string;
  };
  assert.equal(materialization.gate, "verified_output");
  assert.equal(materialization.source_result_id, result.resultId);
  assert.equal(materialization.checkpoint_id, captured.checkpoint.checkpointId);
  assert.equal(materialization.candidate_commit, captured.checkpoint.candidateCommit);
  assert.equal(materialization.candidate_tree, captured.checkpoint.candidateTree);
  assert.match(materialization.gate_operation_id, /^op_verified_materialization_[a-f0-9]{64}$/u);
  assert.deepEqual(
    JSON.parse(materialization.verification_receipts_json),
    [firstReceipt, secondReceipt].map((retained) => ({
      verificationId: retained.receipt.verificationId,
      operationId: retained.receipt.operationId,
      receiptDigest: retained.receiptDigest,
      profileId: retained.receipt.profile.profileId,
      profileRevision: retained.receipt.profile.revision,
      profileDigest: retained.receipt.profile.digest
    })).sort((left, right) => left.profileId.localeCompare(right.profileId))
  );
  assert.deepEqual(JSON.parse(materialization.artifact_pins_json), [{
    outputSlot: "output",
    artifactId: captured.artifact.artifactId,
    artifactRevision: captured.artifact.artifactRevision,
    kind: "patch",
    contentDigest: dependencySha256,
    byteLength: dependencyBytes.length
  }]);

  await f.restart(100);
  const { delivery: consumeDelivery } = await reconnectGovernedAgent(t, f, 2);
  assert.ok(consumeDelivery);
  let consumeRequest: BridgeMessage;
  try {
    consumeRequest = await consumeDelivery;
  } catch (error) {
    const state = f.database.prepare(`
      SELECT state, blocker_code FROM execution_node_states
      WHERE plan_id = ? AND node_key = 'Consume'
    `).get(f.plan.planId);
    const intent = f.database.prepare(`
      SELECT run_id FROM execution_dispatch_intents
      WHERE plan_id = ? AND node_key = 'Consume'
    `).get(f.plan.planId);
    const deliveries = f.database.prepare(`
      SELECT count(*) AS n FROM run_deliveries
      WHERE run_id = (SELECT run_id FROM execution_dispatch_intents
        WHERE plan_id = ? AND node_key = 'Consume')
    `).get(f.plan.planId);
    throw new Error(`Consume delivery unavailable: ${JSON.stringify({
      state,
      intent,
      deliveries
    })}`, { cause: error });
  }
  const consumeManifest = (consumeRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  assert.equal(consumeManifest.scope.nodeKey, "Consume");
  assert.equal(consumeManifest.inputs.length, 1);
  const input = consumeManifest.inputs[0]!;
  assert.equal(input.gate, "verified_output");
  assert.equal(input.gateOperationId, materialization.gate_operation_id);
  assert.equal(input.gateDigest, materialization.materialization_digest);
  assert.equal(input.sourceResultId, result.resultId);
  assert.equal(input.artifact.artifactId, captured.artifact.artifactId);
  assert.equal(input.sourceCommit, captured.checkpoint.candidateCommit);
  assert.equal(input.sourceTree, captured.checkpoint.candidateTree);
  const exactBytes = await f.request(
    "GET",
    `/api/bridge/runs/${consumeManifest.scope.runId}/execution-inputs/${input.bindingId}/content`,
    undefined,
    `Bearer ${f.credential.secret}`
  );
  assert.equal(exactBytes.statusCode, 200, exactBytes.body);
  assert.deepEqual(exactBytes.rawPayload, dependencyBytes);
  assert.equal(exactBytes.headers["x-convenewire-content-sha256"], dependencySha256);
  assert.throws(() => f.database.prepare(`
    UPDATE execution_verified_node_materializations SET created_at = created_at
  `).run(), /immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_verified_node_materializations
  `).run(), /retained evidence/u);
  await f.restart(0);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_verified_node_materializations
  `).get() as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_input_bindings
  `).get() as { n: number }).n, 1);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("accepted predecessor output materializes once and drives exact downstream input", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    acceptedDependency: true,
    captureScheduledDelivery: true,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { n: number }).n === 1);
  const buildRequest = await f.scheduledDelivery!;
  assert.equal(buildRequest.type, "run.requested");
  const buildManifest = (buildRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  const buildRunId = buildManifest.scope.runId;
  assert.equal(buildManifest.inputs.length, 0);
  await sendAndFlush(f.socket, envelope("run.accepted", {
    runId: buildRunId,
    traceId: buildRequest.payload.traceId,
    agentId: f.agent.agentId,
    sequence: 1
  }, "dependency_build_accepted0001"));
  await waitFor(() => new RunRepository(f.database).getRun(buildRunId)?.state === "delivered");
  const runs = new RunRepository(f.database);
  assert.equal(runs.applyEvent(buildRunId, {
    type: "status",
    sequence: 2,
    status: "working"
  }, "2026-08-31T12:00:01.000Z").applied, true);

  let buildTask = await f.ok("GET", `/api/tasks/${f.task.taskId}`);
  buildTask = await f.ok("POST", `/api/tasks/${f.task.taskId}/control`, {
    operationId: "op_dependency_build_active0001",
    expectedTaskRevision: buildTask.taskRevision,
    lifecycleState: "active"
  });
  const captured = await publishCanonicalDependency(f, buildManifest);
  assert.equal(runs.applyEvent(buildRunId, {
    type: "status",
    sequence: 3,
    status: "completed"
  }, "2026-08-31T12:00:02.000Z").applied, true);
  await waitFor(() => {
    const state = f.database.prepare(`
      SELECT state, blocker_code FROM execution_node_states
      WHERE plan_id = ? AND node_key = 'Build'
    `).get(f.plan.planId) as { blocker_code: string | null; state: string };
    return state.state === "awaiting_result" &&
      state.blocker_code === "EXECUTION_RESULT_REQUIRED";
  });
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { n: number }).n, 0);
  assert.equal((f.database.prepare(`
    SELECT blocker_code FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { blocker_code: string }).blocker_code,
  "EXECUTION_DEPENDENCY_NOT_MATERIALIZED");

  const badProposal = {
    operationId: "op_dependency_result_missing_artifact0001",
    taskId: buildTask.taskId,
    definitionRevision: buildTask.definitionRevision,
    criteriaRevision: buildTask.criteriaRevision,
    proposedAtTaskRevision: buildTask.taskRevision,
    supersedesResultId: null,
    outcome: "informational",
    summary: "This Result intentionally omits the canonical Artifact.",
    risks: [],
    openQuestions: [],
    nextActions: [],
    sources: [{
      evidenceRefId: "evidence_dependency_bad_run0001",
      kind: "run_event",
      runId: buildRunId,
      sequence: 3
    }],
    criterionClaims: []
  };
  const bad = await f.ok("POST", "/api/bridge/results", {
    actorKind: "managed_agent",
    agentId: f.agent.agentId,
    runId: buildRunId,
    proposal: badProposal
  }, `Bearer ${f.credential.secret}`);
  let currentTask = await f.ok("GET", `/api/tasks/${buildTask.taskId}`);
  const rejected = await f.request(
    "POST",
    `/api/results/${bad.resultId}/review-decisions`,
    {
      operationId: "op_dependency_bad_accept0001",
      decision: "accepted",
      expectedTaskRevision: currentTask.taskRevision,
      expectedReviewRevision: 0,
      reason: "This must fail without canonical Artifact evidence.",
      completeTask: false
    }
  );
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_node_materializations
  `).get() as { n: number }).n, 0);

  const criterion = currentTask.criteria.find(
    (candidate: { required: boolean }) => candidate.required
  );
  assert.ok(criterion);
  const good = await f.ok("POST", "/api/bridge/results", {
    actorKind: "managed_agent",
    agentId: f.agent.agentId,
    runId: buildRunId,
    proposal: {
      operationId: "op_dependency_result_canonical0001",
      taskId: currentTask.taskId,
      definitionRevision: currentTask.definitionRevision,
      criteriaRevision: currentTask.criteriaRevision,
      proposedAtTaskRevision: currentTask.taskRevision,
      supersedesResultId: bad.resultId,
      outcome: "satisfied",
      summary: "The managed Run proposes its exact canonical checkpoint output.",
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: "evidence_dependency_artifact0001",
        kind: "artifact",
        artifactId: captured.artifact.artifactId
      }, {
        evidenceRefId: "evidence_dependency_run0001",
        kind: "run_event",
        runId: buildRunId,
        sequence: 3
      }],
      criterionClaims: [{
        criterionKey: criterion.criterionKey,
        coverage: "satisfied",
        explanation: "The canonical captured patch satisfies this criterion.",
        evidenceRefIds: ["evidence_dependency_artifact0001"]
      }]
    }
  }, `Bearer ${f.credential.secret}`);

  await f.restart(0);
  currentTask = await f.ok("GET", `/api/tasks/${buildTask.taskId}`);
  const accepted = await f.ok(
    "POST",
    `/api/results/${good.resultId}/review-decisions`,
    {
      operationId: "op_dependency_accept_canonical0001",
      decision: "accepted",
      expectedTaskRevision: currentTask.taskRevision,
      expectedReviewRevision: 0,
      reason: "Accept the canonical output without completing the Task.",
      completeTask: false
    }
  );
  assert.equal(accepted.result.state, "accepted");
  assert.equal(accepted.completedTask, false);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_node_materializations
  `).get() as { n: number }).n, 0, "review and materialization remain separate commits");

  f.database.exec(`
    CREATE TRIGGER fail_dependency_input
    BEFORE INSERT ON execution_input_bindings
    BEGIN SELECT RAISE(ABORT, 'injected downstream input failure'); END
  `);
  const schedulerDisabledApp = f.app;
  await f.restart(100);
  assert.notEqual(f.app, schedulerDisabledApp);
  const materialization = f.database.prepare(`
    SELECT * FROM execution_node_materializations
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    artifact_pins_json: string;
    dispatch_generation: number;
    gate: string;
    gate_operation_id: string;
    source_result_id: string;
    source_run_id: string;
  };
  assert.equal(materialization.gate, "accepted_result");
  assert.equal(materialization.dispatch_generation, 1);
  assert.equal(materialization.source_run_id, buildRunId);
  assert.equal(materialization.source_result_id, good.resultId);
  assert.equal(materialization.gate_operation_id, "op_dependency_accept_canonical0001");
  assert.deepEqual(JSON.parse(materialization.artifact_pins_json), [{
    outputSlot: "output",
    artifactId: captured.artifact.artifactId,
    artifactRevision: captured.artifact.artifactRevision,
    kind: "patch",
    contentDigest: dependencySha256,
    byteLength: dependencyBytes.length
  }]);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { n: number }).n, 0);

  const reconnected = await reconnectGovernedAgent(t, f, 2, false);
  await waitFor(() => (f.database.prepare(`
    SELECT state FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { state: string }).state === "ready");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { n: number }).n, 0);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_input_bindings
  `).get() as { n: number }).n, 0,
  "failed admission rolls back its frozen input and every downstream side effect");
  f.database.exec(`
    CREATE TRIGGER fail_dependency_delivery
    BEFORE INSERT ON run_deliveries
    BEGIN SELECT RAISE(ABORT, 'injected downstream delivery failure'); END
  `);
  f.database.exec("DROP TRIGGER fail_dependency_input");

  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { n: number }).n === 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_input_bindings
  `).get() as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM run_deliveries
    WHERE run_id = (
      SELECT run_id FROM execution_dispatch_intents
      WHERE plan_id = ? AND node_key = 'Consume'
    )
  `).get(f.plan.planId) as { n: number }).n, 0,
  "the B intent and frozen input commit before Delivery");
  reconnected.socket.terminate();
  f.database.exec("DROP TRIGGER fail_dependency_delivery");
  await f.restart(0);
  const recovered = await reconnectGovernedAgent(t, f, 3);
  const consumeRequest = await recovered.delivery!;
  assert.equal(consumeRequest.type, "run.requested");
  const consumeManifest = (consumeRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  assert.equal(consumeManifest.scope.nodeKey, "Consume");
  assert.equal(consumeManifest.scope.dispatchGeneration, 1);
  assert.equal(consumeManifest.inputs.length, 1);
  const input = consumeManifest.inputs[0]!;
  assert.equal(input.edgeKey, "build_consume");
  assert.equal(input.gate, "accepted_result");
  assert.equal(input.gateOperationId, materialization.gate_operation_id);
  assert.equal(input.sourceOutputSlot, "output");
  assert.equal(input.inputSlot, "patch");
  assert.equal(input.sourceResultId, good.resultId);
  assert.equal(input.artifact.artifactId, captured.artifact.artifactId);
  assert.equal(input.artifact.artifactRevision, captured.artifact.artifactRevision);
  assert.equal(input.artifact.contentDigest, dependencySha256);
  assert.equal(input.artifact.byteLength, dependencyBytes.length);
  const exactBytes = await f.request(
    "GET",
    `/api/bridge/runs/${consumeManifest.scope.runId}/execution-inputs/${input.bindingId}/content`,
    undefined,
    `Bearer ${f.credential.secret}`
  );
  assert.equal(exactBytes.statusCode, 200, exactBytes.body);
  assert.deepEqual(exactBytes.rawPayload, dependencyBytes);
  assert.equal(
    exactBytes.headers["x-convenewire-content-sha256"],
    dependencySha256
  );
  const forbidden = await f.request(
    "GET",
    `/api/bridge/runs/${buildRunId}/execution-inputs/${input.bindingId}/content`,
    undefined,
    `Bearer ${f.credential.secret}`
  );
  assert.equal(forbidden.statusCode, 403);
  assert.equal((await f.request(
    "GET",
    `/api/bridge/runs/${consumeManifest.scope.runId}/execution-inputs/${input.bindingId}/content`,
    undefined,
    "Bearer invalid-device-secret"
  )).statusCode, 401);

  await sendAndFlush(recovered.socket, envelope("run.accepted", {
    runId: consumeManifest.scope.runId,
    traceId: consumeRequest.payload.traceId,
    agentId: f.agent.agentId,
    sequence: 1
  }, "dependency_consume_accepted0001"));
  await waitFor(() => new RunRepository(f.database)
    .getRun(consumeManifest.scope.runId)?.state === "delivered");
  await f.restart(0);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_node_materializations
  `).get() as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Consume'
  `).get(f.plan.planId) as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_input_bindings
  `).get() as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT completion_result_id FROM agent_tasks WHERE task_id = ?
  `).get(buildTask.taskId) as { completion_result_id: string | null })
    .completion_result_id, null);
  assert.throws(() => f.database.prepare(`
    UPDATE execution_node_materializations SET created_at = created_at
  `).run(), /immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_node_materializations
  `).run(), /retained evidence/u);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("restart and duplicate scheduler wakeups retain one generation and Run", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    captureScheduledDelivery: true,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
  `).get() as { n: number }).n === 1);
  await f.scheduledDelivery!;
  const original = f.database.prepare(`
    SELECT run_id FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { run_id: string };
  await new Promise((resolve) => setTimeout(resolve, 250));
  await f.restart();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const rows = f.database.prepare(`
    SELECT run_id, dispatch_generation FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
  `).all(f.plan.planId) as Array<{
    dispatch_generation: number;
    run_id: string;
  }>;
  assert.deepEqual(rows, [{ run_id: original.run_id, dispatch_generation: 1 }]);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM runs WHERE task_id = ?
  `).get(f.task.taskId) as { n: number }).n, 1);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("offline node stays blocked and reconnect releases the same generation", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    schedulerMilliseconds: 500
  });
  f.socket.terminate();
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
  `).get() as { n: number }).n, 0);
  assert.equal((f.database.prepare(`
    SELECT blocker_code FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { blocker_code: string }).blocker_code,
  "EXECUTION_CAPABILITY_UNAVAILABLE");

  const socket = await f.app.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${f.credential.secret}`,
      host: "127.0.0.1"
    }
  });
  t.after(() => socket.terminate());
  await sendAndFlush(socket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-test.1",
    connectionEpoch: 2,
    deviceId: f.device.deviceId,
    supportedProtocolVersions: ["1.0"],
    governedExecution: capability
  }, "reconnect_hello0001"));
  const delivery = nextMessage(socket);
  await sendAndFlush(socket, envelope("agent.publish", {
    teamId: f.teamId,
    agentId: f.agent.agentId,
    ownerMemberId: f.ownerMemberId,
    deviceId: f.device.deviceId,
    name: f.agent.name,
    role: f.agent.role,
    capabilities: {
      invocationMode: "managed",
      supportsStart: true,
      supportsResume: false,
      supportsStreaming: true,
      supportsInterrupt: true,
      supportsHandoff: false,
      supportsWorkspaceLeases: true,
      governedExecution: f.agentCapability
    },
    workspaceRef: f.workspaceRef,
    workspaceGeneration: f.workspaceGeneration,
    workspaceAlias: "Governed test workspace"
  }, "reconnect_publish0001"));
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
  `).get() as { n: number }).n === 1);
  assert.equal((await delivery).type, "run.requested");
  assert.equal((f.database.prepare(`
    SELECT dispatch_generation FROM execution_dispatch_intents
  `).get() as { dispatch_generation: number }).dispatch_generation, 1);
});

test("terminal Run settlement never creates an automatic retry", {
  timeout: 30_000
}, async (t) => {
  const cases = [
    ["completed", "awaiting_result"],
    ["failed", "failed"],
    ["canceled", "canceled"],
    ["expired", "failed"],
    ["outcome_unknown", "outcome_unknown"]
  ] as const;
  for (const [terminal, expected] of cases) {
    await t.test(terminal, async (child) => {
      const f = await admissionFixture(child, undefined, {
        captureScheduledDelivery: true,
        schedulerMilliseconds: 100
      });
      await waitFor(() => (f.database.prepare(`
        SELECT count(*) AS n FROM execution_dispatch_intents
      `).get() as { n: number }).n === 1);
      await f.scheduledDelivery!;
      const intent = f.database.prepare(`
        SELECT run_id FROM execution_dispatch_intents
      `).get() as { run_id: string };
      const runs = new RunRepository(f.database);
      const applied = runs.applyEvent(intent.run_id, {
        type: "status",
        sequence: 1,
        status: terminal
      }, "2026-08-31T12:01:00.000Z");
      assert.equal(applied.applied, true);
      await waitFor(() => (f.database.prepare(`
        SELECT state FROM execution_node_states
        WHERE plan_id = ? AND node_key = 'Build'
      `).get(f.plan.planId) as { state: string }).state === expected);
      const late = runs.applyEvent(intent.run_id, {
        type: "status",
        sequence: 2,
        status: terminal === "completed" ? "failed" : "completed"
      }, "2026-08-31T12:02:00.000Z");
      assert.equal(late.applied, false);
      await new Promise((resolve) => setTimeout(resolve, 220));
      assert.equal((f.database.prepare(`
        SELECT count(*) AS n FROM execution_dispatch_intents
      `).get() as { n: number }).n, 1);
      assert.equal((f.database.prepare(`
        SELECT count(*) AS n FROM runs WHERE task_id = ?
      `).get(f.task.taskId) as { n: number }).n, 1);
      assert.equal((f.database.prepare(`
        SELECT state FROM execution_node_states
        WHERE plan_id = ? AND node_key = 'Build'
      `).get(f.plan.planId) as { state: string }).state, expected);
    });
  }
});

test("two Server schedulers share the unique generation-1 winner", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    schedulerMilliseconds: 1_000
  });
  const second = await createServerApp({
    databasePath: f.databasePath,
    logger: false,
    clock: () => now,
    executionSchedulerSweepMilliseconds: 1_000
  });
  t.after(() => second.close());
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
  `).get() as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM runs WHERE task_id = ?
  `).get(f.task.taskId) as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT dispatch_generation FROM execution_dispatch_intents
  `).get() as { dispatch_generation: number }).dispatch_generation, 1);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});
