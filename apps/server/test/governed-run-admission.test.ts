import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { validateBridgeMessage } from "@convene-wire/contracts/bridge-validator";

import { createServerApp } from "../src/app.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import {
  defaultMigrationsDirectory,
  migrateDatabase
} from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { AuthService } from "../src/security/auth-service.js";
import { ExecutionDependencyResolver } from
  "../src/execution/execution-dependency-resolver.js";
import { ExecutionEvidenceAdoptionRepository } from
  "../src/execution/execution-evidence-adoption-repository.js";
import { backfillLegacyEvidenceAdoptions } from
  "../src/execution/execution-evidence-backfill.js";
import { ExecutionNodeMaterializationRepository } from
  "../src/execution/execution-node-materialization-repository.js";
import { ExecutionPlanRepository } from
  "../src/execution/execution-plan-repository.js";
import { AcceptedResultMaterializer } from
  "../src/execution/materialization/accepted-result-materializer.js";
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

interface RemovedAdoption {
  deleteTriggerSql: string;
  reuseDeleteTriggerSql: string;
  reuseRow: Record<string, string | number | null>;
  row: Record<string, string | number | null>;
}

function removeAdoption(
  database: Awaited<ReturnType<typeof fixture>>["database"],
  planId: string,
  planRevision: number,
  nodeKey: string,
  gate: "accepted_result" | "verified_output" | "integrated_commit"
): RemovedAdoption {
  const reuseTrigger = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger'
      AND name = 'execution_evidence_reuse_contracts_immutable_delete'
  `).get() as { sql: string };
  assert.ok(reuseTrigger?.sql);
  const reuseRow = database.prepare(`
    SELECT reuse.* FROM execution_evidence_reuse_contracts reuse
    JOIN execution_evidence_adoptions adoption
      ON adoption.adoption_id = reuse.adoption_id
    WHERE adoption.plan_id = ? AND adoption.plan_revision = ?
      AND adoption.node_key = ? AND adoption.gate = ?
  `).get(planId, planRevision, nodeKey, gate) as
    Record<string, string | number | null>;
  assert.ok(reuseRow);
  const trigger = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger'
      AND name = 'execution_evidence_adoptions_immutable_delete'
  `).get() as { sql: string };
  assert.ok(trigger?.sql);
  const row = database.prepare(`
    SELECT * FROM execution_evidence_adoptions
    WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND gate = ?
  `).get(planId, planRevision, nodeKey, gate) as
    Record<string, string | number | null>;
  assert.ok(row);
  database.exec(
    "DROP TRIGGER execution_evidence_reuse_contracts_immutable_delete"
  );
  assert.equal(database.prepare(`
    DELETE FROM execution_evidence_reuse_contracts WHERE adoption_id = ?
  `).run(row.adoption_id).changes, 1);
  database.exec("DROP TRIGGER execution_evidence_adoptions_immutable_delete");
  assert.equal(database.prepare(`
    DELETE FROM execution_evidence_adoptions
    WHERE plan_id = ? AND plan_revision = ? AND node_key = ? AND gate = ?
  `).run(planId, planRevision, nodeKey, gate).changes, 1);
  return {
    deleteTriggerSql: trigger.sql,
    reuseDeleteTriggerSql: reuseTrigger.sql,
    reuseRow,
    row
  };
}

function restoreAdoption(
  database: Awaited<ReturnType<typeof fixture>>["database"],
  removed: RemovedAdoption
): void {
  database.prepare(`
    INSERT INTO execution_evidence_adoptions (
      adoption_id, schema_version, operation_id, operation_digest,
      plan_id, plan_revision, node_key, gate, source_evidence_id,
      source_digest, source_run_id, dispatch_generation, proof_set_digest,
      node_contract_digest, resolved_input_set_digest, adoption_digest,
      adoption_json, legacy_materialization_digest, created_at
    ) VALUES (
      @adoption_id, @schema_version, @operation_id, @operation_digest,
      @plan_id, @plan_revision, @node_key, @gate, @source_evidence_id,
      @source_digest, @source_run_id, @dispatch_generation, @proof_set_digest,
      @node_contract_digest, @resolved_input_set_digest, @adoption_digest,
      @adoption_json, @legacy_materialization_digest, @created_at
    )
  `).run(removed.row);
  database.prepare(`
    INSERT INTO execution_evidence_reuse_contracts (
      reuse_contract_id, schema_version, adoption_id, adoption_digest,
      plan_id, plan_revision, node_key, gate,
      runtime_input_binding_digest, reuse_input_evidence_digest,
      node_execution_digest, node_reuse_contract_digest, contract_digest,
      contract_json, created_at
    ) VALUES (
      @reuse_contract_id, @schema_version, @adoption_id, @adoption_digest,
      @plan_id, @plan_revision, @node_key, @gate,
      @runtime_input_binding_digest, @reuse_input_evidence_digest,
      @node_execution_digest, @node_reuse_contract_digest, @contract_digest,
      @contract_json, @created_at
    )
  `).run(removed.reuseRow);
  database.exec(removed.deleteTriggerSql);
  database.exec(removed.reuseDeleteTriggerSql);
}

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

async function waitFor(
  check: () => boolean,
  maxAttempts = 100
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for governed Agent publication");
}

async function callMcp(
  app: FastifyInstance,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>
): Promise<{
  result: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`
    },
    payload: {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args }
    }
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function admissionFixture(
  t: TestContext,
  grantChange?: (grant: GovernedExecutionCapabilityReadyGrant) => void,
  options: {
    acceptedDependency?: boolean;
    integratedDependency?: boolean;
    requiredVerificationProfiles?: number;
    verifiedDependency?: boolean;
    agentCount?: number;
    captureScheduledDelivery?: boolean;
    fanInDependency?: boolean;
    independentAgentIndexes?: number[];
    maxConcurrency?: number;
    schedulerMilliseconds?: number;
    techLead?: boolean;
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
  const agentService = new AgentService(core, auth);
  const agentIndexes = options.independentAgentIndexes ?? [0];
  const agentCount = options.agentCount ?? Math.max(...agentIndexes) + 1;
  assert.ok(agentCount > Math.max(...agentIndexes));
  const managedAgents = Array.from({ length: agentCount }, (_, index) => {
    const token = "efcba9876543210d"[index] ?? "d";
    const workspaceRef = `workspace_${token.repeat(64)}`;
    const workspaceGeneration = token.repeat(64);
    const agent = agentService.publishAgent(owner, {
      teamId: f.teamId,
      deviceId: device.deviceId,
      name: `Governed builder ${index + 1}`,
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
    return { agent, workspaceRef, workspaceGeneration };
  });
  const primary = managedAgents[0]!;
  const { agent, workspaceRef, workspaceGeneration } = primary;
  const techLead = options.techLead
    ? await f.ok("POST", `/api/teams/${f.teamId}/manual-agents`, {
        name: "Bounded autonomy Tech Lead",
        role: "Tech Lead"
      })
    : undefined;
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, {
    memberIds: [f.ownerMemberId],
    agentIds: [
      ...managedAgents.map((entry) => entry.agent.agentId),
      ...(techLead ? [techLead.agent.agentId] : [])
    ]
  });
  let assignedRoot: { taskRevision: number } | undefined;
  if (techLead) {
    const root = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
    assignedRoot = await f.ok("PUT", `/api/tasks/${root.taskId}/definition`, {
      operationId: "op_governed_assign_tech_lead0001",
      expectedTaskRevision: root.taskRevision,
      title: root.title,
      goal: root.goal,
      ownerMemberId: root.ownerMemberId,
      completionPolicy: root.completionPolicy,
      priority: root.priority,
      dueAt: root.dueAt,
      criteria: root.criteria,
      assignments: [{ agentId: techLead.agent.agentId, role: "primary" }],
      budgetPolicy: root.budgetPolicy
    });
  }

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
  if (assignedRoot) command.expectedRootTaskRevision = assignedRoot.taskRevision;
  if (options.independentAgentIndexes) {
    const build = command.definition.nodes.find((node) =>
      node.nodeKey === "Build"
    );
    assert.ok(build?.repository);
    command.definition.nodes = agentIndexes.map((agentIndex, index) => {
      const node = structuredClone(build);
      node.nodeKey = `Node${index + 1}`;
      node.agentId = managedAgents[agentIndex]!.agent.agentId;
      node.task = {
        mode: "new",
        title: `Independent node ${index + 1}`,
        goal: `Produce independently schedulable output ${index + 1}`,
        ownerMemberId: f.ownerMemberId,
        criteria: structuredClone(build.task.criteria)
      };
      node.repository = {
        ...node.repository,
        grantId: `grant_capacity_node${index + 1}0001`
      };
      return node;
    });
    command.definition.edges = [];
    command.definition.policy.maxConcurrency = options.maxConcurrency ??
      agentIndexes.length;
  } else {
    for (const node of command.definition.nodes) node.agentId = agent.agentId;
  }
  if (options.fanInDependency) {
    const [first, second, destination] = command.definition.nodes;
    assert.ok(first && second && destination);
    first.inputs = [];
    second.inputs = [];
    first.outputs = [{ slotKey: "output", kind: "patch", required: true }];
    second.outputs = [{ slotKey: "output", kind: "patch", required: true }];
    destination.inputs = [
      { slotKey: "patch1", kind: "patch", required: true },
      { slotKey: "patch2", kind: "patch", required: true }
    ];
    destination.outputs = [{ slotKey: "output", kind: "patch", required: true }];
    command.definition.edges = [{
      edgeKey: "node1_node3",
      fromNodeKey: first.nodeKey,
      toNodeKey: destination.nodeKey,
      gate: "accepted_result",
      bindings: [{ outputSlot: "output", inputSlot: "patch1" }]
    }, {
      edgeKey: "node2_node3",
      fromNodeKey: second.nodeKey,
      toNodeKey: destination.nodeKey,
      gate: "accepted_result",
      bindings: [{ outputSlot: "output", inputSlot: "patch2" }]
    }];
    command.definition.policy.maxConcurrency = options.maxConcurrency ?? 2;
  }
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
  const primaryNodeKey = options.independentAgentIndexes ? "Node1" : "Build";
  const task = tasksByNode.get(primaryNodeKey);
  assert.ok(task);
  const node = plan.current.definition.nodes.find(
    (candidate: { nodeKey: string }) => candidate.nodeKey === primaryNodeKey
  );
  assert.ok(node?.repository);
  const grants = plan.current.definition.nodes
    .filter((candidate: { kind: string }) => candidate.kind === "implementation")
    .map((candidate: typeof node): GovernedExecutionCapabilityReadyGrant => {
      assert.ok(candidate.repository);
      const grantIndex = plan.current.definition.nodes.findIndex(
        (entry: { nodeKey: string }) => entry.nodeKey === candidate.nodeKey
      );
      return {
        grant: {
          grantId: candidate.repository.grantId,
          revision: candidate.repository.grantRevision,
          digest: options.independentAgentIndexes
            ? "abcdef0123456789"[grantIndex]!.repeat(64)
            : candidate.nodeKey === "Build"
              ? "d".repeat(64)
              : "e".repeat(64),
          expiresAt: "2026-08-31T13:00:00.000Z"
        },
        repositoryId: candidate.repository.repositoryId,
        bindingId: candidate.repository.bindingId,
        deviceId: device.deviceId,
        agentId: candidate.agentId,
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
  const grant = grants.find((candidate) =>
    candidate.nodeKey === primaryNodeKey
  );
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
  const agentCapability = {
    ...capability,
    readyGrants: grants.filter((candidate) =>
      candidate.agentId === agent.agentId
    )
  };
  const scheduledDelivery = options.captureScheduledDelivery
    ? nextMessage(socket)
    : undefined;
  for (const [index, managed] of managedAgents.entries()) {
    const readyGrants = grants.filter((candidate) =>
      candidate.agentId === managed.agent.agentId
    );
    if (readyGrants.length === 0) continue;
    await sendAndFlush(socket, envelope("agent.publish", {
      teamId: f.teamId,
      agentId: managed.agent.agentId,
      ownerMemberId: f.ownerMemberId,
      deviceId: device.deviceId,
      name: managed.agent.name,
      role: managed.agent.role,
      capabilities: {
        invocationMode: "managed",
        supportsStart: true,
        supportsResume: false,
        supportsStreaming: true,
        supportsInterrupt: true,
        supportsHandoff: false,
        supportsWorkspaceLeases: true,
        governedExecution: { ...capability, readyGrants }
      },
      workspaceRef: managed.workspaceRef,
      workspaceGeneration: managed.workspaceGeneration,
      workspaceAlias: `Governed test workspace ${index + 1}`
    }, `publish000${index + 1}`));
    await waitFor(() => {
      const row = f.database.prepare(`
        SELECT capabilities_json FROM agents WHERE agent_id = ?
      `).get(managed.agent.agentId) as { capabilities_json: string } | undefined;
      const persisted = row && JSON.parse(row.capabilities_json) as {
        governedExecution?: { readyGrants?: unknown[] };
      };
      return persisted?.governedExecution?.readyGrants?.length ===
        readyGrants.length;
    });
  }
  return {
    ...f,
    get app() {
      return f.app;
    },
    socket,
    device,
    credential,
    agent,
    managedAgents,
    plan,
    node,
    task,
    tasksByNode,
    grant,
    grants,
    agentCapability,
    workspaceRef,
    workspaceGeneration,
    scheduledDelivery,
    techLead
  };
}

type AdmissionFixture = Awaited<ReturnType<typeof admissionFixture>>;

async function createSharedAgentSiblingPlan(
  f: AdmissionFixture,
  suffix: string
) {
  const root = await f.ok("POST", `/api/rooms/${f.roomId}/tasks`, {
    title: `Shared Agent sibling ${suffix}`,
    goal: "Prove durable shared-Agent Plan rotation"
  });
  const source = (await f.ok("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: root.taskId,
    content: "Authorize the sibling scheduler Plan."
  })).message;
  const currentRoot = await f.ok("GET", `/api/tasks/${root.taskId}`);
  const definition = structuredClone(f.plan.current.definition);
  definition.rootTaskId = root.taskId;
  definition.title = `Shared Agent sibling Plan ${suffix}`;
  definition.policy.maxConcurrency = 1;
  definition.decision.sources = [{
    evidenceRefId: `evidence_shared_${suffix}_source0001`,
    kind: "message",
    messageId: source.messageId
  }];
  definition.decision.sourceRevisions = [{
    evidenceRefId: `evidence_shared_${suffix}_source0001`,
    revision: source.sequence
  }];
  for (const [index, node] of definition.nodes.entries()) {
    node.agentId = f.managedAgents[0]!.agent.agentId;
    node.repository.grantId = `grant_shared_${suffix}_node${index + 1}0001`;
    node.task.title = `Shared ${suffix} node ${index + 1}`;
  }
  const draft = await f.ok(
    "POST",
    `/api/tasks/${root.taskId}/execution-plans`,
    {
      operationId: `op_shared_${suffix}_create0001`,
      expectedRootTaskRevision: currentRoot.taskRevision,
      definition
    }
  );
  const plan = (await f.ok(
    "POST",
    `/api/execution-plans/${draft.planId}/approvals`,
    {
      operationId: `op_shared_${suffix}_approval0001`,
      expectedRevision: draft.current.revision,
      expectedDigest: draft.current.digest,
      expectedRootTaskRevision: currentRoot.taskRevision,
      decision: "approved",
      reason: "Authorize the exact shared-Agent sibling Plan."
    }
  )).plan;
  for (const compiled of plan.compiledTasks as Array<{
    nodeKey: string;
    taskId: string;
  }>) {
    const task = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
    await f.ok("POST", `/api/tasks/${compiled.taskId}/control`, {
      operationId: `op_shared_${suffix}_${compiled.nodeKey.toLowerCase()}_ready0001`,
      expectedTaskRevision: task.taskRevision,
      lifecycleState: "ready"
    });
  }
  const grants = plan.current.definition.nodes.map(
    (node: typeof f.node, index: number): GovernedExecutionCapabilityReadyGrant => ({
      ...structuredClone(f.grants[index]!),
      grant: {
        ...structuredClone(f.grants[index]!.grant),
        grantId: node.repository.grantId,
        digest: "76543210"[index]!.repeat(64)
      },
      agentId: node.agentId,
      planId: plan.planId,
      nodeKey: node.nodeKey
    })
  );
  return { plan, grants };
}

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
  const nodeSuffix = manifest.scope.nodeKey.toLowerCase();
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
    idempotencyKey: `idem_governed_dependency_${nodeSuffix}_patch0001`,
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
    checkpointId: `checkpoint_governed_dependency_${nodeSuffix}0001`,
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

async function completeAndAcceptScheduledNode(
  f: AdmissionFixture,
  nodeKey: string
) {
  const suffix = nodeKey.toLowerCase();
  const intent = f.database.prepare(`
    SELECT run_id FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = ?
  `).get(f.plan.planId, nodeKey) as { run_id: string } | undefined;
  assert.ok(intent);
  const runs = new RunRepository(f.database);
  const manifest = runs.getContextManifest(intent.run_id)?.execution;
  assert.ok(manifest);
  assert.equal(runs.applyEvent(intent.run_id, {
    type: "status",
    sequence: 1,
    status: "delivered"
  }, "2026-08-31T12:00:01.000Z").applied, true);
  assert.equal(runs.applyEvent(intent.run_id, {
    type: "status",
    sequence: 2,
    status: "working"
  }, "2026-08-31T12:00:02.000Z").applied, true);
  let task = await f.ok("GET", `/api/tasks/${f.tasksByNode.get(nodeKey).taskId}`);
  task = await f.ok("POST", `/api/tasks/${task.taskId}/control`, {
    operationId: `op_capacity_${suffix}_active0001`,
    expectedTaskRevision: task.taskRevision,
    lifecycleState: "active"
  });
  const captured = await publishCanonicalDependency(f, manifest);
  assert.equal(runs.applyEvent(intent.run_id, {
    type: "status",
    sequence: 3,
    status: "completed"
  }, "2026-08-31T12:00:03.000Z").applied, true);
  const criterion = task.criteria.find(
    (candidate: { required: boolean }) => candidate.required
  );
  assert.ok(criterion);
  const artifactEvidenceRef = `evidence_capacity_${suffix}_artifact0001`;
  const result = await f.ok("POST", "/api/bridge/results", {
    actorKind: "managed_agent",
    agentId: manifest.scope.agentId,
    runId: intent.run_id,
    proposal: {
      operationId: `op_capacity_${suffix}_result0001`,
      taskId: task.taskId,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision,
      proposedAtTaskRevision: task.taskRevision,
      supersedesResultId: null,
      outcome: "satisfied",
      summary: `The ${nodeKey} Run proposes its exact captured output.`,
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: artifactEvidenceRef,
        kind: "artifact",
        artifactId: captured.artifact.artifactId
      }, {
        evidenceRefId: `evidence_capacity_${suffix}_run0001`,
        kind: "run_event",
        runId: intent.run_id,
        sequence: 3
      }],
      criterionClaims: [{
        criterionKey: criterion.criterionKey,
        coverage: "satisfied",
        explanation: `The exact ${nodeKey} output satisfies this criterion.`,
        evidenceRefIds: [artifactEvidenceRef]
      }]
    }
  }, `Bearer ${f.credential.secret}`);
  task = await f.ok("GET", `/api/tasks/${task.taskId}`);
  const accepted = await f.ok(
    "POST",
    `/api/results/${result.resultId}/review-decisions`,
    {
      operationId: `op_capacity_${suffix}_accept0001`,
      decision: "accepted",
      expectedTaskRevision: task.taskRevision,
      expectedReviewRevision: 0,
      reason: `Accept the canonical ${nodeKey} output.`,
      completeTask: false
    }
  );
  assert.equal(accepted.result.state, "accepted");
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_evidence_adoptions
    WHERE plan_id = ? AND plan_revision = ? AND node_key = ?
      AND gate = 'accepted_result'
  `).get(f.plan.planId, f.plan.current.revision, nodeKey) as {
    n: number;
  }).n === 1);
  return { accepted, captured, manifest, result };
}

async function carryLocalGate(
  f: AdmissionFixture,
  selectedGates: ("accepted_result" | "verified_output" |
    "integrated_commit")[],
  suffix: string
) {
  const sources = selectedGates.map((gate) => {
    const source = f.database.prepare(`
      SELECT adoption_id, adoption_digest FROM execution_evidence_adoptions
      WHERE plan_id = ? AND plan_revision = 1 AND node_key = 'Build'
        AND gate = ?
    `).get(f.plan.planId, gate) as {
      adoption_digest: string;
      adoption_id: string;
    };
    assert.ok(source);
    const reuse = f.database.prepare(`
      SELECT reuse_contract_id, reuse_input_evidence_digest,
        node_reuse_contract_digest
      FROM execution_evidence_reuse_contracts WHERE adoption_id = ?
    `).get(source.adoption_id) as {
      node_reuse_contract_digest: string;
      reuse_contract_id: string;
      reuse_input_evidence_digest: string;
    };
    assert.ok(reuse);
    return { gate, reuse, source };
  });
  const label = selectedGates.join(" and ");
  const current = await f.ok(
    "GET", `/api/execution-plans/${f.plan.planId}`
  );
  const definition = structuredClone(current.current.definition);
  for (const node of definition.nodes) {
    const compiled = current.compiledTasks.find((entry: {
      nodeKey: string;
    }) => entry.nodeKey === node.nodeKey);
    assert.ok(compiled);
    const task = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
    node.task = {
      mode: "existing",
      taskId: task.taskId,
      expectedTaskRevision: task.taskRevision,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision
    };
  }
  definition.decision.summary = `Carry the exact ${label} proof.`;
  const root = await f.ok("GET", `/api/tasks/${current.rootTaskId}`);
  const candidate = await f.ok(
    "POST",
    `/api/execution-plans/${current.planId}/supersession-candidates`,
    {
      operationId: `op_${suffix}_candidate0001`,
      expectedCurrentRevision: current.current.revision,
      expectedCurrentDigest: current.current.digest,
      expectedControlRevision: current.controlRevision,
      expectedRootTaskRevision: root.taskRevision,
      definition,
      reason: `Prepare an exact ${label} carry candidate.`
    }
  );
  const receipt = await f.ok(
    "POST",
    `/api/execution-plans/${current.planId}/supersession-activations`,
    {
      operationId: `op_${suffix}_activation0001`,
      candidateId: candidate.candidateId,
      expectedCandidateRevision: candidate.candidateRevision,
      expectedCandidateDigest: candidate.candidateDigest,
      expectedCurrentRevision: current.current.revision,
      expectedCurrentDigest: current.current.digest,
      expectedControlRevision: current.controlRevision,
      expectedRootTaskRevision: root.taskRevision,
      carryForward: sources.map(({ gate, reuse, source }) => ({
        targetNodeKey: "Build",
        gate,
        sourceAdoptionId: source.adoption_id,
        sourceAdoptionDigest: source.adoption_digest,
        sourceReuseContractId: reuse.reuse_contract_id,
        sourceNodeReuseContractDigest: reuse.node_reuse_contract_digest,
        sourceReuseInputEvidenceDigest: reuse.reuse_input_evidence_digest
      })),
      reason: `Adopt the exact ${label} proof into revision two.`
    }
  );
  return { current, receipt, sources };
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

async function retryFailedBuild(
  f: AdmissionFixture,
  firstRequest: BridgeMessage,
  operationId: string
) {
  const firstManifest = (firstRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  const runs = new RunRepository(f.database);
  assert.equal(runs.applyEvent(firstManifest.scope.runId, {
    type: "status",
    sequence: 1,
    status: "failed",
    error: {
      code: "IMPLEMENTATION_FAILED",
      message: "The first bounded implementation attempt failed.",
      retryable: false
    }
  }, "2026-08-31T12:00:00.500Z").applied, true);
  await waitFor(() => (f.database.prepare(`
    SELECT last_run_state FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    last_run_state: string | null;
  } | undefined)?.last_run_state === "failed");
  const state = f.database.prepare(`
    SELECT projection_revision, dispatch_generation, run_id
    FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    dispatch_generation: number;
    projection_revision: number;
    run_id: string;
  };
  const delivery = nextMessage(f.socket);
  const retried = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
    {
      operationId,
      expectedPlanRevision: f.plan.current.revision,
      expectedPlanDigest: f.plan.current.digest,
      expectedControlRevision: f.plan.controlRevision,
      nodeKey: "Build",
      expectedNodeProjectionRevision: state.projection_revision,
      expectedPreviousGeneration: state.dispatch_generation,
      expectedPreviousRunId: state.run_id,
      ambiguityAcknowledgementOperationId: null,
      reason: "Retry the failed implementation with a new isolated attempt."
    }
  );
  const secondRequest = await delivery;
  const secondManifest = (secondRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  assert.equal(retried.authorization.previousRunId, firstManifest.scope.runId);
  assert.equal(retried.authorization.previousGeneration, 1);
  assert.equal(retried.authorization.newRunId, secondManifest.scope.runId);
  assert.equal(secondManifest.scope.dispatchGeneration, 2);
  assert.equal(runs.getRun(firstManifest.scope.runId)?.state, "failed");
  return { firstManifest, secondManifest, secondRequest };
}

async function prepareVerifiedDependencySource(
  t: TestContext,
  integrated = false,
  retry = false
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
  const firstRequest = await f.scheduledDelivery!;
  const buildRequest = retry
    ? (await retryFailedBuild(
      f,
      firstRequest,
      "op_generation_two_verified_retry0001"
    )).secondRequest
    : firstRequest;
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

async function prepareRetryableNode(
  t: TestContext,
  terminalState: "failed" | "canceled" | "expired" | "outcome_unknown" |
    "completed"
) {
  const f = await admissionFixture(t, undefined, {
    captureScheduledDelivery: true,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { n: number }).n === 1);
  const requested = await f.scheduledDelivery!;
  const manifest = (requested.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  new RunRepository(f.database).applyEvent(manifest.scope.runId, {
    type: "status",
    sequence: 1,
    status: terminalState,
    ...(terminalState === "completed" ? {} : {
      error: {
        code: `TEST_${terminalState.toUpperCase()}`,
        message: `Test terminal state ${terminalState}.`,
        retryable: false
      }
    })
  }, "2026-08-31T12:00:01.000Z");
  await waitFor(() => (f.database.prepare(`
    SELECT last_run_state FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    last_run_state: string | null;
  } | undefined)?.last_run_state === terminalState);
  const state = f.database.prepare(`
    SELECT projection_revision, dispatch_generation, run_id
    FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    dispatch_generation: number;
    projection_revision: number;
    run_id: string;
  };
  return {
    f,
    manifest,
    command: {
      operationId: `op_execution_${terminalState}_retry0001`,
      expectedPlanRevision: f.plan.current.revision,
      expectedPlanDigest: f.plan.current.digest,
      expectedControlRevision: f.plan.controlRevision,
      nodeKey: "Build",
      expectedNodeProjectionRevision: state.projection_revision,
      expectedPreviousGeneration: state.dispatch_generation,
      expectedPreviousRunId: state.run_id,
      ambiguityAcknowledgementOperationId: null,
      reason: `Retry the ${terminalState} implementation attempt.`
    }
  };
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
  assert.deepEqual(f.database.prepare(`
    SELECT source, scheduler_operation_id
    FROM execution_scheduler_fairness_history WHERE run_id = ?
  `).get(routed.runs[0].runId), {
    source: "member_message",
    scheduler_operation_id: null
  });
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
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_scheduler_fairness_history
  `).get() as { n: number }).n, 1,
  "duplicate Message replay must not advance fairness");
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("manual scheduler mode admits only the exact owner-pinned node", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t);
  const control = await f.ok(
    "GET",
    `/api/execution-plans/${f.plan.planId}/scheduler`
  );
  const mode = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/mode-transitions`,
    {
      operationId: "op_scheduler_manual_mode0001",
      expectedPlanRevision: f.plan.current.revision,
      expectedPlanDigest: f.plan.current.digest,
      expectedPlanControlRevision: f.plan.controlRevision,
      expectedModeRevision: control.modeRevision,
      mode: "manual",
      reason: "Require one exact human-selected node."
    }
  );
  const state = f.database.prepare(`
    SELECT projection_revision FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    projection_revision: number;
  };
  const background = await createServerApp({
    databasePath: f.databasePath,
    logger: false,
    clock: () => now,
    executionSchedulerSweepMilliseconds: 100
  });
  await background.ready();
  const backgroundSocket = await background.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${f.credential.secret}`,
      host: "127.0.0.1"
    }
  });
  t.after(async () => {
    backgroundSocket.terminate();
    await background.close();
  });
  await sendAndFlush(backgroundSocket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-test.1",
    connectionEpoch: 2,
    deviceId: f.device.deviceId,
    supportedProtocolVersions: ["1.0"],
    governedExecution: capability
  }, "manual_background_hello0001"));
  await sendAndFlush(backgroundSocket, envelope("agent.publish", {
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
    workspaceAlias: "Manual-mode background exclusion"
  }, "manual_background_publish0001"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n, 0,
  "automatic timer must not select a manual Plan");
  const wrongMode = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/advances`,
    {
      operationId: "op_scheduler_manual_advance0001",
      expectedPlanRevision: f.plan.current.revision,
      expectedPlanDigest: f.plan.current.digest,
      expectedPlanControlRevision: f.plan.controlRevision,
      expectedModeRevision: mode.modeRevision,
      reason: "A manual Plan cannot invoke supervised selection."
    }
  );
  assert.equal(wrongMode.statusCode, 409, wrongMode.body);
  assert.match(wrongMode.body, /EXECUTION_SCHEDULER_MODE_CONFLICT/u);
  const staleNode = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/dispatches`,
    {
      operationId: "op_scheduler_manual_stale0001",
      expectedPlanRevision: f.plan.current.revision,
      expectedPlanDigest: f.plan.current.digest,
      expectedPlanControlRevision: f.plan.controlRevision,
      expectedModeRevision: mode.modeRevision,
      nodeKey: "Build",
      expectedNodeProjectionRevision: state.projection_revision + 1,
      reason: "Reject a stale node projection pin."
    }
  );
  assert.equal(staleNode.statusCode, 409, staleNode.body);
  assert.match(staleNode.body, /EXECUTION_SCHEDULER_NODE_CONFLICT/u);
  const command = {
    operationId: "op_scheduler_manual_dispatch0001",
    expectedPlanRevision: f.plan.current.revision,
    expectedPlanDigest: f.plan.current.digest,
    expectedPlanControlRevision: f.plan.controlRevision,
    expectedModeRevision: mode.modeRevision,
    nodeKey: "Build",
    expectedNodeProjectionRevision: state.projection_revision,
    reason: "Dispatch only the reviewed Build node."
  };
  const receipt = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/dispatches`,
    command
  );
  assert.equal(receipt.action, "manual_dispatch");
  assert.equal(receipt.mode, "manual");
  assert.equal(receipt.selection.nodeKey, "Build");
  assert.deepEqual(await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/dispatches`,
    command
  ), receipt);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_scheduler_fairness_history
    WHERE run_id = ?
  `).get(receipt.selection.runId) as { n: number }).n, 1,
  "manual command replay must not advance fairness");
  assert.deepEqual(f.database.prepare(`
    SELECT history.source, history.scheduler_operation_id,
      history.cursor_revision, history.plan_id, history.node_key,
      history.dispatch_intent_id, history.run_id
    FROM execution_scheduler_fairness_history history
    WHERE history.run_id = ?
  `).get(receipt.selection.runId), {
    source: "manual",
    scheduler_operation_id: command.operationId,
    cursor_revision: 1,
    plan_id: f.plan.planId,
    node_key: "Build",
    dispatch_intent_id: receipt.selection.dispatchIntentId,
    run_id: receipt.selection.runId
  });
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_scheduler_operations
    WHERE operation_id = ?
  `).get(command.operationId) as { n: number }).n, 1);
  assert.throws(() => f.database.prepare(`
    UPDATE execution_scheduler_fairness_history SET source = 'automatic'
    WHERE run_id = ?
  `).run(receipt.selection.runId), /history is immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_scheduler_fairness_cursors WHERE agent_id = ?
  `).run(f.agent.agentId), /cursor cannot be deleted/u);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("supervised scheduler mode advances one candidate and seals no-progress replay", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    independentAgentIndexes: [0, 1],
    maxConcurrency: 1
  });
  const control = await f.ok(
    "GET",
    `/api/execution-plans/${f.plan.planId}/scheduler`
  );
  const mode = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/mode-transitions`,
    {
      operationId: "op_scheduler_supervised_mode0001",
      expectedPlanRevision: f.plan.current.revision,
      expectedPlanDigest: f.plan.current.digest,
      expectedPlanControlRevision: f.plan.controlRevision,
      expectedModeRevision: control.modeRevision,
      mode: "supervised",
      reason: "Require one human-supervised scheduler step."
    }
  );
  const background = await createServerApp({
    databasePath: f.databasePath,
    logger: false,
    clock: () => now,
    executionSchedulerSweepMilliseconds: 100
  });
  await background.ready();
  const backgroundSocket = await background.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${f.credential.secret}`,
      host: "127.0.0.1"
    }
  });
  t.after(async () => {
    backgroundSocket.terminate();
    await background.close();
  });
  await sendAndFlush(backgroundSocket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-test.1",
    connectionEpoch: 2,
    deviceId: f.device.deviceId,
    supportedProtocolVersions: ["1.0"],
    governedExecution: capability
  }, "supervised_background_hello0001"));
  await sendAndFlush(backgroundSocket, envelope("agent.publish", {
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
    workspaceAlias: "Supervised-mode background exclusion"
  }, "supervised_background_publish0001"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n, 0,
  "automatic timer must not select a supervised Plan");
  const advance = (operationId: string) => ({
    operationId,
    expectedPlanRevision: f.plan.current.revision,
    expectedPlanDigest: f.plan.current.digest,
    expectedPlanControlRevision: f.plan.controlRevision,
    expectedModeRevision: mode.modeRevision,
    reason: "Advance at most one deterministic ready node."
  });
  const first = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/advances`,
    advance("op_scheduler_supervised_advance0001")
  );
  assert.equal(first.action, "supervised_advance");
  assert.equal(first.selection.nodeKey, "Node1");
  assert.deepEqual(f.database.prepare(`
    SELECT source, scheduler_operation_id FROM execution_scheduler_fairness_history
    WHERE run_id = ?
  `).get(first.selection.runId), {
    source: "supervised",
    scheduler_operation_id: first.operationId
  });

  const noProgressCommand = advance("op_scheduler_supervised_empty0001");
  const noProgress = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/advances`,
    noProgressCommand
  );
  assert.equal(noProgress.selection, null);
  assert.equal(new RunRepository(f.database).applyEvent(
    first.selection.runId,
    {
      type: "status",
      sequence: 1,
      status: "failed",
      error: {
        code: "EXPECTED_SUPERVISED_FAULT",
        message: "Release plan capacity for the next exact command.",
        retryable: false
      }
    },
    "2026-08-31T12:00:01.000Z"
  ).applied, true);
  assert.deepEqual(await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/advances`,
    noProgressCommand
  ), noProgress, "a no-progress replay cannot acquire later authority");
  const later = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/advances`,
    advance("op_scheduler_supervised_advance0002")
  );
  assert.equal(later.selection.nodeKey, "Node2");
  await f.restart();
  assert.deepEqual(await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/advances`,
    noProgressCommand
  ), noProgress);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n, 2);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("manual scheduler admission failure rolls back its entire authority chain", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, (grant) => {
    grant.planId = "plan_foreign0001";
  });
  const initial = await f.ok(
    "GET",
    `/api/execution-plans/${f.plan.planId}/scheduler`
  );
  const mode = await f.ok(
    "POST",
    `/api/execution-plans/${f.plan.planId}/scheduler/mode-transitions`,
    {
      operationId: "op_scheduler_failed_mode0001",
      expectedPlanRevision: f.plan.current.revision,
      expectedPlanDigest: f.plan.current.digest,
      expectedPlanControlRevision: f.plan.controlRevision,
      expectedModeRevision: initial.modeRevision,
      mode: "manual",
      reason: "Require exact manual failure evidence."
    }
  );
  const state = f.database.prepare(`
    SELECT projection_revision FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    projection_revision: number;
  };
  const beforeMessages = (f.database.prepare(`
    SELECT count(*) AS n FROM messages
  `).get() as { n: number }).n;
  const operationId = "op_scheduler_failed_dispatch0001";
  const response = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/dispatches`,
    {
      operationId,
      expectedPlanRevision: f.plan.current.revision,
      expectedPlanDigest: f.plan.current.digest,
      expectedPlanControlRevision: f.plan.controlRevision,
      expectedModeRevision: mode.modeRevision,
      nodeKey: "Build",
      expectedNodeProjectionRevision: state.projection_revision,
      reason: "This exact blocked node must not leave partial facts."
    }
  );
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.body, /EXECUTION_GRANT_UNAVAILABLE/u);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM messages
  `).get() as { n: number }).n, beforeMessages);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_scheduler_operations
    WHERE operation_id = ?
  `).get(operationId) as { n: number }).n, 0);
  for (const table of [
    "execution_dispatch_intents",
    "execution_run_admissions",
    "runs",
    "execution_scheduler_fairness_cursors",
    "execution_scheduler_fairness_history",
    "isolated_workspace_leases",
    "run_deliveries"
  ]) {
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM ${table}
    `).get() as { n: number }).n, 0, `${table} retained partial state`);
  }
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("explicit node retry retains one immutable generation-2 admission and replays after restart", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    captureScheduledDelivery: true,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { n: number }).n === 1);
  const firstRequest = await f.scheduledDelivery!;
  const firstManifest = (firstRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  const runs = new RunRepository(f.database);
  runs.applyEvent(firstManifest.scope.runId, {
    type: "status",
    sequence: 1,
    status: "failed",
    error: {
      code: "IMPLEMENTATION_FAILED",
      message: "The bounded implementation attempt failed.",
      retryable: false
    }
  }, "2026-08-31T12:00:01.000Z");
  await waitFor(() => (f.database.prepare(`
    SELECT last_run_state FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    last_run_state: string | null;
  } | undefined)?.last_run_state === "failed");
  const previousState = f.database.prepare(`
    SELECT projection_revision, dispatch_generation, run_id
    FROM execution_node_states
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision) as {
    dispatch_generation: number;
    projection_revision: number;
    run_id: string;
  };
  const command = {
    operationId: "op_execution_node_retry0001",
    expectedPlanRevision: f.plan.current.revision,
    expectedPlanDigest: f.plan.current.digest,
    expectedControlRevision: f.plan.controlRevision,
    nodeKey: "Build",
    expectedNodeProjectionRevision: previousState.projection_revision,
    expectedPreviousGeneration: previousState.dispatch_generation,
    expectedPreviousRunId: previousState.run_id,
    ambiguityAcknowledgementOperationId: null,
    reason: "Retry the failed implementation with a new isolated attempt."
  };
  const secondDelivery = nextMessage(f.socket);
  const response = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
    command
  );
  assert.equal(response.statusCode, 200, response.body);
  const retained = response.json();
  assert.equal(retained.created, true);
  assert.equal(retained.authorization.previousRunId, firstManifest.scope.runId);
  assert.equal(retained.authorization.previousGeneration, 1);
  assert.equal(retained.authorization.previousRunState, "failed");
  assert.equal(retained.authorization.newGeneration, 2);
  assert.equal(retained.run.retryOfRunId, firstManifest.scope.runId);
  assert.equal(retained.run.attemptNumber, 2);
  assert.equal(runs.getRun(firstManifest.scope.runId)?.state, "failed");
  const requested = await secondDelivery;
  const secondManifest = (requested.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  assert.equal(secondManifest.scope.runId, retained.authorization.newRunId);
  assert.equal(secondManifest.scope.dispatchGeneration, 2);
  assert.notEqual(
    secondManifest.workspace.workspaceGeneration,
    firstManifest.workspace.workspaceGeneration
  );
  assert.deepEqual(secondManifest.inputs, firstManifest.inputs);
  const {
    authorizationDigest,
    ...unsignedAuthorization
  } = retained.authorization;
  assert.equal(
    executionOperationDigest(unsignedAuthorization),
    authorizationDigest
  );
  assert.deepEqual(f.database.prepare(`
    SELECT dispatch_generation, run_id, retry_operation_id
    FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
    ORDER BY dispatch_generation
  `).all(f.plan.planId), [{
    dispatch_generation: 1,
    run_id: firstManifest.scope.runId,
    retry_operation_id: null
  }, {
    dispatch_generation: 2,
    run_id: retained.authorization.newRunId,
    retry_operation_id: command.operationId
  }]);
  assert.deepEqual(f.database.prepare(`
    SELECT source, scheduler_operation_id, cursor_revision
    FROM execution_scheduler_fairness_history WHERE run_id = ?
  `).get(retained.authorization.newRunId), {
    source: "node_retry",
    scheduler_operation_id: null,
    cursor_revision: 2
  });
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_node_retry_authorizations
  `).get() as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM isolated_workspace_leases
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { n: number }).n, 2);

  await f.restart(0);
  const replay = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
    command
  );
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().created, false);
  assert.deepEqual(replay.json().authorization, retained.authorization);
  const conflict = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
    { ...command, reason: "Changed retry request must not replay." }
  );
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(
    conflict.json().error.code,
    "EXECUTION_NODE_RETRY_OPERATION_CONFLICT"
  );
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { n: number }).n, 2);
});

test("explicit node retry admits canceled and expired attempts without automatic retry", {
  timeout: 30_000
}, async (t) => {
  for (const state of ["canceled", "expired"] as const) {
    await t.test(state, async (child) => {
      const { f, command } = await prepareRetryableNode(child, state);
      const response = await f.request(
        "POST",
        `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
        command
      );
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().authorization.previousRunState, state);
      assert.equal(response.json().authorization.newGeneration, 2);
      assert.equal((f.database.prepare(`
        SELECT count(*) AS n FROM execution_node_retry_authorizations
      `).get() as { n: number }).n, 1);
    });
  }
});

test("outcome-unknown node retry requires the exact retained acknowledgement", {
  timeout: 30_000
}, async (t) => {
  const { f, command, manifest } = await prepareRetryableNode(
    t,
    "outcome_unknown"
  );
  const missing = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
    command
  );
  assert.equal(missing.statusCode, 409, missing.body);
  assert.equal(
    missing.json().error.code,
    "EXECUTION_NODE_RETRY_AMBIGUITY_ACK_REQUIRED"
  );
  const task = await f.ok("GET", `/api/tasks/${f.task.taskId}`);
  const acknowledgement = await f.ok(
    "POST",
    `/api/runs/${manifest.scope.runId}/ambiguity-acknowledgement`,
    {
      operationId: "op_execution_unknown_ack0001",
      expectedTaskRevision: task.taskRevision,
      reason: "The owner reviewed the ambiguous attempt before another writer."
    }
  );
  const wrong = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
    {
      ...command,
      operationId: "op_execution_unknown_retry_wrong0001",
      ambiguityAcknowledgementOperationId: "op_execution_wrong_ack0001"
    }
  );
  assert.equal(wrong.statusCode, 409, wrong.body);
  assert.equal(
    wrong.json().error.code,
    "EXECUTION_NODE_RETRY_AMBIGUITY_ACK_REQUIRED"
  );
  const admitted = await f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
    {
      ...command,
      operationId: "op_execution_unknown_retry_exact0001",
      ambiguityAcknowledgementOperationId: acknowledgement.operationId
    }
  );
  assert.equal(admitted.statusCode, 200, admitted.body);
  assert.equal(
    admitted.json().authorization.ambiguityAcknowledgementOperationId,
    acknowledgement.operationId
  );
});

test("node retry rejects completed attempts and non-owner control", {
  timeout: 30_000
}, async (t) => {
  await t.test("completed", async (child) => {
    const { f, command } = await prepareRetryableNode(child, "completed");
    const response = await f.request(
      "POST",
      `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
      command
    );
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(
      response.json().error.code,
      "EXECUTION_NODE_RETRY_STATE_CONFLICT"
    );
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM execution_node_retry_authorizations
    `).get() as { n: number }).n, 0);
  });
  await t.test("member", async (child) => {
    const { f, command } = await prepareRetryableNode(child, "failed");
    const participant = await f.participant();
    const response = await f.request(
      "POST",
      `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
      command,
      participant.authorization
    );
    assert.equal(response.statusCode, 403, response.body);
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM execution_node_retry_authorizations
    `).get() as { n: number }).n, 0);
  });
});

test("concurrent explicit retry controls retain one generation-2 winner", {
  timeout: 30_000
}, async (t) => {
  const { f, command } = await prepareRetryableNode(t, "failed");
  const responses = await Promise.all([1, 2].map((suffix) => f.request(
    "POST",
    `/api/execution-plans/${f.plan.planId}/nodes/Build/retries`,
    {
      ...command,
      operationId: `op_execution_concurrent_retry000${suffix}`
    }
  )));
  assert.deepEqual(
    responses.map((response) => response.statusCode).sort(),
    [200, 409]
  );
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_node_retry_authorizations
  `).get() as { n: number }).n, 1);
  assert.deepEqual(f.database.prepare(`
    SELECT dispatch_generation FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
    ORDER BY dispatch_generation
  `).all(f.plan.planId), [
    { dispatch_generation: 1 },
    { dispatch_generation: 2 }
  ]);
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
    "execution_scheduler_fairness_cursors",
    "execution_scheduler_fairness_history",
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
  assert.equal(validateBridgeMessage(requested), true);
  assert.equal(requested.payload.contextManifest?.target.runtimeKind, "codex");
  const schedulerContext = (requested.payload.contextMessages as Array<{
    senderId: string;
  }>).find(({ senderId }) => senderId === "execution_scheduler");
  assert.ok(schedulerContext);
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
  assert.deepEqual(f.database.prepare(`
    SELECT source, scheduler_operation_id, cursor_revision
    FROM execution_scheduler_fairness_history WHERE run_id = ?
  `).get(row.run_id), {
    source: "automatic",
    scheduler_operation_id: null,
    cursor_revision: 1
  });
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

test("generation-2 verified output admits one immutable serialized integration", {
  timeout: 30_000
}, async (t) => {
  const { f, manifest, captured } =
    await prepareVerifiedDependencySource(t, true, true);
  assert.equal(manifest.scope.dispatchGeneration, 2);
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
  assert.equal(materialization.dispatchGeneration, 2);
  assert.equal(materialization.sourceRunId, manifest.scope.runId);
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
  const missingVerifiedAdoption = removeAdoption(
    f.database,
    f.plan.planId,
    f.plan.current.revision,
    "Build",
    "verified_output"
  );
  try {
    assert.equal(new ExecutionNodeMaterializationRepository(f.database).get({
      planId: f.plan.planId,
      planRevision: f.plan.current.revision,
      nodeKey: "Build"
    }, "verified_output"), undefined,
    "a legacy-only verified row is not integration authority");
    const denied = await f.request(
      "POST",
      `/api/execution-plans/${f.plan.planId}/integration-approvals`,
      command
    );
    assert.equal(denied.statusCode, 409, denied.body);
    assert.match(denied.body, /INTEGRATION_VERIFIED_MATERIALIZATION_REQUIRED/u);
  } finally {
    restoreAdoption(f.database, missingVerifiedAdoption);
  }
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

  const missingAdmissionAdoption = removeAdoption(
    f.database,
    f.plan.planId,
    f.plan.current.revision,
    "Build",
    "verified_output"
  );
  try {
    const denied = await f.request(
      "GET",
      `/api/bridge/repository-integrations/${approval.integrationOperationId}`,
      undefined,
      `Bearer ${f.credential.secret}`
    );
    assert.equal(denied.statusCode, 409, denied.body);
    assert.match(denied.body, /INTEGRATION_VERIFIED_MATERIALIZATION_REQUIRED/u);
  } finally {
    restoreAdoption(f.database, missingAdmissionAdoption);
  }

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
  await waitFor(() => Boolean(f.database.prepare(`
    SELECT 1 FROM execution_integrated_node_materializations
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId)));
  const proofPage = await f.ok(
    "GET",
    `/api/tasks/${f.plan.rootTaskId}/execution-evidence`
  );
  const buildEvidence = proofPage.plans[0].nodes.find(
    (node: { nodeKey: string }) => node.nodeKey === "Build"
  );
  assert.equal(buildEvidence.integration.state, "succeeded");
  assert.equal(buildEvidence.integration.approval.approvalDigest,
    approval.approvalDigest);
  assert.equal(buildEvidence.integration.receipt.receiptDigest,
    retained.receiptDigest);
  assert.deepEqual(buildEvidence.stages.map((stage: { gate: string }) =>
    stage.gate), ["verified_output", "integrated_commit"]);
  assert.equal(buildEvidence.verifications[0].kind, "local_verification");
  assert.equal(buildEvidence.verifications[0].receipt.outcome, "passed");
  assert.doesNotMatch(JSON.stringify(proofPage), /workspace|localPath|grant_json/u);
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
  assert.equal(integrated.dispatchGeneration, 2);
  assert.equal(integrated.sourceRunId, manifest.scope.runId);
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
  const adoptedIntegrated = new ExecutionNodeMaterializationRepository(
    f.database
  ).getAdopted({
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build"
  }, "integrated_commit");
  assert.ok(adoptedIntegrated);
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
      sourceAuthority: {
        sourceEvidenceId: adoptedIntegrated.sourceEvidenceId,
        sourceDigest: adoptedIntegrated.sourceDigest,
        adoptionId: adoptedIntegrated.adoptionId,
        adoptionDigest: adoptedIntegrated.adoptionDigest
      },
      artifactId: materialization.artifactPins[0]!.artifactId
    }]
  });
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_evidence_adoptions
  `).get() as { n: number }).n, 2,
  "verified and integrated materialization transactions dual-write adoption");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_evidence_reuse_contracts
  `).get() as { n: number }).n, 2,
  "verified and integrated adoptions each retain one reuse companion");
  assert.equal(backfillLegacyEvidenceAdoptions(f.database), 2);
  const evidence = new ExecutionEvidenceAdoptionRepository(f.database);
  const verifiedAdoption = evidence.get({
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build"
  }, "verified_output");
  const integratedAdoption = evidence.get({
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build"
  }, "integrated_commit");
  assert.ok(verifiedAdoption?.source.kind === "repository_commit");
  assert.ok(integratedAdoption?.source.kind === "repository_commit");
  const verifiedReuse = evidence.getReuse(verifiedAdoption.adoption.adoptionId);
  const integratedReuse = evidence.getReuse(integratedAdoption.adoption.adoptionId);
  assert.ok(verifiedReuse);
  assert.ok(integratedReuse);
  assert.equal(verifiedReuse.runtimeInputBindingDigest,
    verifiedAdoption.adoption.resolvedInputSetDigest);
  assert.equal(verifiedReuse.nodeExecutionDigest,
    verifiedAdoption.adoption.nodeContractDigest);
  assert.equal(integratedReuse.runtimeInputBindingDigest,
    integratedAdoption.adoption.resolvedInputSetDigest);
  assert.equal(integratedReuse.nodeExecutionDigest,
    integratedAdoption.adoption.nodeContractDigest);
  assert.equal(verifiedReuse.nodeReuseContractDigest,
    integratedReuse.nodeReuseContractDigest,
    "gate-specific proof identity does not change the node reuse contract");
  assert.equal(
    integratedAdoption.source.sourceEvidenceId,
    verifiedAdoption.source.sourceEvidenceId,
    "verified and integrated gates adopt the same immutable checkpoint source"
  );
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_source_evidence
  `).get() as { n: number }).n, 2);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_gate_proof_refs
  `).get() as { n: number }).n, 2);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_evidence_adoptions
  `).get() as { n: number }).n, 2);
  assert.throws(() => f.database.prepare(`
    UPDATE execution_evidence_reuse_contracts
    SET contract_digest = contract_digest
  `).run(), /immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_evidence_reuse_contracts
  `).run(), /retained evidence/u);

  const deleteTrigger = f.database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'trigger'
      AND name = 'execution_evidence_reuse_contracts_immutable_delete'
  `).get() as { sql: string };
  const removedVerifiedReuse = f.database.prepare(`
    SELECT * FROM execution_evidence_reuse_contracts WHERE adoption_id = ?
  `).get(verifiedAdoption.adoption.adoptionId) as {
    contract_json: string;
  };
  const removedIntegratedReuse = f.database.prepare(`
    SELECT * FROM execution_evidence_reuse_contracts WHERE adoption_id = ?
  `).get(integratedAdoption.adoption.adoptionId) as {
    contract_json: string;
  };
  assert.ok(deleteTrigger.sql);
  assert.ok(removedVerifiedReuse.contract_json);
  assert.ok(removedIntegratedReuse.contract_json);
  f.database.exec(
    "DROP TRIGGER execution_evidence_reuse_contracts_immutable_delete"
  );
  assert.equal(f.database.prepare(`
    DELETE FROM execution_evidence_reuse_contracts WHERE adoption_id = ?
  `).run(verifiedAdoption.adoption.adoptionId).changes, 1);
  f.database.exec(deleteTrigger.sql);
  const { materializationDigest: _materializationDigest, ...verifiedUnsigned } =
    materialization;
  assert.throws(() => f.database.transaction(() =>
    new ExecutionNodeMaterializationRepository(f.database)
      .retainVerified(verifiedUnsigned)
  )(), /EvidenceReuseContract is unavailable/u,
  "ordinary replay cannot heal a missing reuse companion");
  f.database.exec(
    "DROP TRIGGER execution_evidence_reuse_contracts_immutable_delete"
  );
  assert.equal(f.database.prepare(`
    DELETE FROM execution_evidence_reuse_contracts WHERE adoption_id = ?
  `).run(integratedAdoption.adoption.adoptionId).changes, 1);
  f.database.exec(deleteTrigger.sql);
  f.database.exec(`
    CREATE TRIGGER fail_reuse_backfill
    BEFORE INSERT ON execution_evidence_reuse_contracts
    WHEN NEW.gate = 'integrated_commit'
    BEGIN SELECT RAISE(ABORT, 'injected reuse backfill failure'); END
  `);
  assert.throws(() => backfillLegacyEvidenceAdoptions(f.database),
    /injected reuse backfill failure/u);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_evidence_reuse_contracts
  `).get() as { n: number }).n, 0,
  "failed multi-row companion backfill rolls back its earlier insert");
  f.database.exec("DROP TRIGGER fail_reuse_backfill");
  assert.equal(backfillLegacyEvidenceAdoptions(f.database), 2,
    "the explicit migration backfill restores both exact companions");
  assert.deepEqual(f.database.prepare(`
    SELECT adoption_id, contract_json
    FROM execution_evidence_reuse_contracts
    ORDER BY adoption_id COLLATE BINARY
  `).all(), [{
    adoption_id: integratedAdoption.adoption.adoptionId,
    contract_json: removedIntegratedReuse.contract_json
  }, {
    adoption_id: verifiedAdoption.adoption.adoptionId,
    contract_json: removedVerifiedReuse.contract_json
  }].sort((left, right) => left.adoption_id < right.adoption_id ? -1 : 1));
  assert.equal(backfillLegacyEvidenceAdoptions(f.database), 2,
    "reopen backfill is byte-identical and idempotent");
  const carried = await carryLocalGate(
    f,
    ["verified_output", "integrated_commit"],
    "integrated_carry"
  );
  assert.deepEqual(
    carried.receipt.carryForward.map((entry: { gate: string }) => entry.gate),
    ["integrated_commit", "verified_output"]
  );
  const carriedResolution = new ExecutionDependencyResolver(
    new ExecutionPlanRepository(f.database),
    new ExecutionNodeMaterializationRepository(f.database)
  ).resolve({
    planId: f.plan.planId,
    planRevision: 2,
    nodeKey: "Consume"
  });
  assert.equal(carriedResolution.ready, true);
  if (!carriedResolution.ready) throw new Error(carriedResolution.blocker);
  assert.equal(
    carriedResolution.selections[0]!.sourceAuthority.adoptionId,
    carried.receipt.carryForward.find(
      (entry: { gate: string }) => entry.gate === "integrated_commit"
    )!.adoptionId
  );
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
      errorCode: terminal === "failed"
        ? "INTEGRATION_TARGET_MOVED"
        : `INTEGRATION_${terminal.toUpperCase()}`,
      recordedAt: now
    };
    await f.ok(
      "POST",
      "/api/bridge/integration-receipts",
      receipt,
      `Bearer ${f.credential.secret}`
    );
    await f.restart(0);
    const proofPage = await f.ok(
      "GET",
      `/api/tasks/${f.plan.rootTaskId}/execution-evidence`
    );
    const buildEvidence = proofPage.plans[0].nodes.find(
      (node: { nodeKey: string }) => node.nodeKey === "Build"
    );
    assert.equal(buildEvidence.integration.state,
      terminal === "failed" ? "conflict" : terminal);
    assert.equal(buildEvidence.integration.blockerCode, receipt.errorCode);
    assert.equal(buildEvidence.integration.commandTemplate, null);
    const consumeEvidence = proofPage.plans[0].nodes.find(
      (node: { nodeKey: string }) => node.nodeKey === "Consume"
    );
    assert.equal(consumeEvidence.runtime.state, "blocked");
    assert.deepEqual(consumeEvidence.nextAction, {
      kind: "none",
      actorKind: "none",
      reasonCode: "NODE_BLOCKED"
    });
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

test("generation-2 accepted output materializes once and drives exact downstream input", {
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
  const firstBuildRequest = await f.scheduledDelivery!;
  const retried = await retryFailedBuild(
    f,
    firstBuildRequest,
    "op_generation_two_accepted_retry0001"
  );
  const buildRequest = retried.secondRequest;
  assert.equal(buildRequest.type, "run.requested");
  const buildManifest = (buildRequest.payload.contextManifest as {
    execution: GovernedExecutionManifest;
  }).execution;
  const buildRunId = buildManifest.scope.runId;
  assert.equal(buildManifest.scope.dispatchGeneration, 2);
  assert.notEqual(buildRunId, retried.firstManifest.scope.runId);
  assert.equal(buildManifest.inputs.length, 0);
  let buildTask = await f.ok(
    "GET",
    `/api/tasks/${f.task.taskId}`
  );
  buildTask = await f.ok("POST", `/api/tasks/${f.task.taskId}/control`, {
    operationId: "op_dependency_build_active0001",
    expectedTaskRevision: buildTask.taskRevision,
    lifecycleState: "active"
  });
  const lateOldResult = await f.ok("POST", "/api/bridge/results", {
    actorKind: "managed_agent",
    agentId: f.agent.agentId,
    runId: retried.firstManifest.scope.runId,
    proposal: {
      operationId: "op_generation_one_late_result0001",
      taskId: buildTask.taskId,
      definitionRevision: buildTask.definitionRevision,
      criteriaRevision: buildTask.criteriaRevision,
      proposedAtTaskRevision: buildTask.taskRevision,
      supersedesResultId: null,
      outcome: "informational",
      summary: "Late evidence from the failed first generation.",
      risks: [],
      openQuestions: [],
      nextActions: [],
      sources: [{
        evidenceRefId: "evidence_generation_one_failure0001",
        kind: "run_event",
        runId: retried.firstManifest.scope.runId,
        sequence: 1
      }],
      criterionClaims: []
    }
  }, `Bearer ${f.credential.secret}`);
  const lateAcceptance = await f.request(
    "POST",
    `/api/results/${lateOldResult.resultId}/review-decisions`,
    {
      operationId: "op_generation_one_late_accept0001",
      decision: "accepted",
      expectedTaskRevision: buildTask.taskRevision,
      expectedReviewRevision: 0,
      reason: "A superseded generation must not release the dependency.",
      completeTask: false
    }
  );
  assert.equal(lateAcceptance.statusCode, 400, lateAcceptance.body);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_node_materializations
  `).get() as { n: number }).n, 0);
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

  buildTask = await f.ok("GET", `/api/tasks/${f.task.taskId}`);
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
  f.database.exec(`
    CREATE TRIGGER fail_evidence_adoption_dual_write
    BEFORE INSERT ON execution_evidence_adoptions
    BEGIN SELECT RAISE(ABORT, 'injected adoption dual-write failure'); END
  `);
  const buildIdentity = {
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build"
  };
  assert.throws(() => f.database.transaction(() =>
    new AcceptedResultMaterializer(
      f.database,
      new ExecutionNodeMaterializationRepository(f.database)
    ).reconcile(buildIdentity)
  )(), /injected adoption dual-write failure/u);
  for (const table of [
    "execution_node_materializations",
    "execution_source_evidence",
    "execution_gate_proof_refs",
    "execution_evidence_adoptions",
    "execution_evidence_reuse_contracts"
  ]) {
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM ${table}
    `).get() as { n: number }).n, 0, `${table} escaped failed dual-write`);
  }
  f.database.exec("DROP TRIGGER fail_evidence_adoption_dual_write");
  f.database.exec(`
    CREATE TRIGGER fail_evidence_reuse_dual_write
    BEFORE INSERT ON execution_evidence_reuse_contracts
    BEGIN SELECT RAISE(ABORT, 'injected reuse dual-write failure'); END
  `);
  assert.throws(() => f.database.transaction(() =>
    new AcceptedResultMaterializer(
      f.database,
      new ExecutionNodeMaterializationRepository(f.database)
    ).reconcile(buildIdentity)
  )(), /injected reuse dual-write failure/u);
  for (const table of [
    "execution_node_materializations",
    "execution_source_evidence",
    "execution_gate_proof_refs",
    "execution_evidence_adoptions",
    "execution_evidence_reuse_contracts"
  ]) {
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM ${table}
    `).get() as { n: number }).n, 0,
    `${table} escaped failed reuse companion dual-write`);
  }
  f.database.exec("DROP TRIGGER fail_evidence_reuse_dual_write");
  const schedulerDisabledApp = f.app;
  await f.restart(100);
  assert.notEqual(f.app, schedulerDisabledApp);
  await waitFor(() => Boolean(f.database.prepare(`
    SELECT 1 FROM execution_node_materializations
    WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
  `).get(f.plan.planId, f.plan.current.revision)));
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
  assert.equal(materialization.dispatch_generation, 2);
  assert.equal(materialization.source_run_id, buildRunId);
  assert.equal(materialization.source_result_id, good.resultId);
  assert.equal(materialization.gate_operation_id, "op_dependency_accept_canonical0001");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_evidence_adoptions
  `).get() as { n: number }).n, 1,
  "accepted materialization transaction dual-writes adoption");
  assert.equal(backfillLegacyEvidenceAdoptions(f.database), 1);
  const evidence = new ExecutionEvidenceAdoptionRepository(f.database);
  const acceptedAdoption = evidence.get({
    planId: f.plan.planId,
    planRevision: f.plan.current.revision,
    nodeKey: "Build"
  }, "accepted_result");
  assert.ok(acceptedAdoption?.source.kind === "task_result");
  assert.equal(acceptedAdoption.source.resultId, good.resultId);
  const acceptedReuse = evidence.getReuse(acceptedAdoption.adoption.adoptionId);
  assert.ok(acceptedReuse);
  assert.equal(acceptedReuse.runtimeInputBindingDigest,
    acceptedAdoption.adoption.resolvedInputSetDigest);
  assert.equal(acceptedReuse.nodeExecutionDigest,
    acceptedAdoption.adoption.nodeContractDigest);
  assert.deepEqual(acceptedReuse.reuseInputs, []);
  const projectionRepository = new ExecutionNodeMaterializationRepository(
    f.database
  );
  const localProjection = projectionRepository.project(
    buildIdentity,
    "accepted_result",
    1
  );
  assert.ok(localProjection?.projectionVersion === 1);
  assert.equal(localProjection.sourceResultId, good.resultId);
  const generalizedProjection = projectionRepository.project(
    buildIdentity,
    "accepted_result",
    2
  );
  assert.ok(generalizedProjection?.projectionVersion === 2);
  assert.equal(generalizedProjection.sourceEvidence.kind, "task_result");
  assert.equal(generalizedProjection.companionResult?.resultId, good.resultId);
  assert.equal("sourceResultId" in generalizedProjection, false);
  assert.equal(
    acceptedAdoption.legacyMaterializationDigest,
    (f.database.prepare(`
      SELECT materialization_digest FROM execution_node_materializations
      WHERE plan_id = ? AND plan_revision = ? AND node_key = 'Build'
    `).get(f.plan.planId, f.plan.current.revision) as {
      materialization_digest: string;
    }).materialization_digest
  );
  assert.deepEqual(f.database.prepare(`
    SELECT dispatch_generation, run_id FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Build'
    ORDER BY dispatch_generation
  `).all(f.plan.planId), [{
    dispatch_generation: 1,
    run_id: retried.firstManifest.scope.runId
  }, {
    dispatch_generation: 2,
    run_id: buildRunId
  }]);
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
  removeAdoption(
    f.database,
    f.plan.planId,
    f.plan.current.revision,
    "Build",
    "accepted_result"
  );
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_node_materializations
  `).get() as { n: number }).n, 1, "legacy proof remains in the fault fixture");
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
  const deniedAfterAdoptionLoss = await f.request(
    "GET",
    `/api/bridge/runs/${consumeManifest.scope.runId}/execution-inputs/${input.bindingId}/content`,
    undefined,
    `Bearer ${f.credential.secret}`
  );
  assert.equal(deniedAfterAdoptionLoss.statusCode, 403,
    "frozen physical bytes are withheld when adoption authority disappears");
});

test("plan supersession carries exact local evidence by semantic reuse digests", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    acceptedDependency: true,
    schedulerMilliseconds: 100,
    techLead: true
  });
  assert.ok(f.techLead);
  await waitFor(() => Boolean(f.database.prepare(`
    SELECT 1 FROM execution_dispatch_intents
    WHERE plan_id = ? AND plan_revision = 1 AND node_key = 'Build'
  `).get(f.plan.planId)));
  await completeAndAcceptScheduledNode(f, "Build");
  await waitFor(() => Boolean(f.database.prepare(`
    SELECT 1 FROM execution_dispatch_intents
    WHERE plan_id = ? AND plan_revision = 1 AND node_key = 'Consume'
  `).get(f.plan.planId)));

  const source = f.database.prepare(`
    SELECT adoption_id, adoption_digest FROM execution_evidence_adoptions
    WHERE plan_id = ? AND plan_revision = 1 AND node_key = 'Build'
      AND gate = 'accepted_result'
  `).get(f.plan.planId) as {
    adoption_digest: string;
    adoption_id: string;
  };
  const sourceReuse = f.database.prepare(`
    SELECT reuse_contract_id, reuse_input_evidence_digest,
      node_reuse_contract_digest, contract_digest
    FROM execution_evidence_reuse_contracts WHERE adoption_id = ?
  `).get(source.adoption_id) as {
    contract_digest: string;
    node_reuse_contract_digest: string;
    reuse_contract_id: string;
    reuse_input_evidence_digest: string;
  };
  assert.ok(source && sourceReuse);

  const current = await f.ok(
    "GET", `/api/execution-plans/${f.plan.planId}`
  );
  const trigger = await f.ok(
    "POST",
    `/api/rooms/${f.roomId}/messages`,
    {
      taskId: current.rootTaskId,
      content: "Carry the exact accepted evidence under bounded delegation.",
      mentionAgentId: f.techLead.agent.agentId
    }
  );
  const techLeadRunId = trigger.runs[0].runId as string;
  const claimed = await callMcp(
    f.app,
    f.techLead.credential.token,
    5401,
    "team.claim_run",
    { runId: techLeadRunId }
  );
  assert.equal(
    (claimed.result.structuredContent?.run as { state: string }).state,
    "working"
  );
  const techLeadManifest = new RunRepository(f.database)
    .getContextManifest(techLeadRunId)!;
  const definition = structuredClone(current.current.definition);
  for (const node of definition.nodes) {
    const compiled = current.compiledTasks.find((entry: {
      nodeKey: string;
    }) => entry.nodeKey === node.nodeKey);
    assert.ok(compiled);
    const task = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
    node.task = {
      mode: "existing",
      taskId: task.taskId,
      expectedTaskRevision: task.taskRevision,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision
    };
  }
  definition.decision.summary =
    "Carry only evidence whose execution semantics and logical inputs match.";
  definition.decision.sources = [{
    evidenceRefId: "evidence_bounded_carry_trigger0001",
    kind: "message",
    messageId: trigger.message.messageId
  }];
  definition.decision.sourceRevisions = [{
    evidenceRefId: "evidence_bounded_carry_trigger0001",
    revision: trigger.message.sequence
  }];
  const candidateResult = await callMcp(
    f.app,
    f.techLead.credential.token,
    5402,
    "team.propose_plan_supersession",
    {
      runId: techLeadRunId,
      planId: current.planId,
      command: {
        operationId: "op_carry_candidate0001",
        expectedCurrentRevision: current.current.revision,
        expectedCurrentDigest: current.current.digest,
        expectedControlRevision: current.controlRevision,
        expectedRootTaskRevision: techLeadManifest.taskRevision,
        definition,
        reason: "Retain the exact semantic contract in revision two."
      }
    }
  );
  assert.equal(candidateResult.result.isError, undefined,
    JSON.stringify(candidateResult));
  const candidate = candidateResult.result.structuredContent?.candidate as any;
  assert.deepEqual(candidate.author, {
    kind: "agent",
    agentId: f.techLead.agent.agentId,
    runId: techLeadRunId
  });
  const delegation = await f.ok(
    "POST",
    `/api/execution-plans/${current.planId}/replan-delegations`,
    {
      operationId: "op_carry_delegation0001",
      expectedPlanRevision: current.current.revision,
      expectedPlanDigest: current.current.digest,
      expectedControlRevision: current.controlRevision,
      expectedRootTaskRevision: techLeadManifest.taskRevision,
      agentId: f.techLead.agent.agentId,
      expiresAt: "2026-08-31T12:30:00.000Z",
      reason: "Allow this Tech Lead Run one low-risk evidence carry."
    }
  );
  const command = {
    operationId: "op_carry_activation0001",
    candidateId: candidate.candidateId,
    expectedCandidateRevision: candidate.candidateRevision,
    expectedCandidateDigest: candidate.candidateDigest,
    expectedCurrentRevision: current.current.revision,
    expectedCurrentDigest: current.current.digest,
    expectedControlRevision: current.controlRevision,
    expectedRootTaskRevision: techLeadManifest.taskRevision,
    carryForward: [{
      targetNodeKey: "Build",
      gate: "accepted_result",
      sourceAdoptionId: source.adoption_id,
      sourceAdoptionDigest: source.adoption_digest,
      sourceReuseContractId: sourceReuse.reuse_contract_id,
      sourceNodeReuseContractDigest: sourceReuse.node_reuse_contract_digest,
      sourceReuseInputEvidenceDigest:
        sourceReuse.reuse_input_evidence_digest
    }],
    reason: "Adopt the exact retained Build proof into revision two."
  };
  const control = await f.ok(
    "GET", `/api/execution-plans/${current.planId}/supersession-control`
  );
  const { operationId: _operationId, reason: _reason, ...expectedTemplate } =
    command;
  assert.deepEqual(control.activationTemplate, expectedTemplate,
    "the browser receives the complete Server-owned carry selection");
  assert.equal(control.activationBlockerCode, null);
  assert.equal(control.delegations.find(({ delegation: row }: any) =>
    row.delegationId === delegation.delegationId).state, "active");
  const omitted = await callMcp(
    f.app,
    f.techLead.credential.token,
    5403,
    "team.activate_plan_supersession",
    {
      runId: techLeadRunId,
      planId: current.planId,
      delegationId: delegation.delegationId,
      command: {
        ...command,
        operationId: "op_carry_omitted0001",
        carryForward: []
      }
    }
  );
  assert.equal(omitted.result.isError, true);
  const mismatched = await callMcp(
    f.app,
    f.techLead.credential.token,
    5404,
    "team.activate_plan_supersession",
    {
      runId: techLeadRunId,
      planId: current.planId,
      delegationId: delegation.delegationId,
      command: {
        ...command,
        operationId: "op_carry_mismatch0001",
        carryForward: [{
          ...command.carryForward[0],
          sourceNodeReuseContractDigest: "f".repeat(64)
        }]
      }
    }
  );
  assert.equal(mismatched.result.isError, true);
  assert.equal(
    (await f.ok("GET", `/api/execution-plans/${current.planId}`))
      .current.revision,
    1,
    "failed carry attempts must leave the active revision unchanged"
  );
  const activation = await callMcp(
    f.app,
    f.techLead.credential.token,
    5405,
    "team.activate_plan_supersession",
    {
      runId: techLeadRunId,
      planId: current.planId,
      delegationId: delegation.delegationId,
      command
    }
  );
  assert.equal(activation.result.isError, undefined, JSON.stringify(activation));
  const receipt = activation.result.structuredContent?.receipt as any;
  assert.equal(receipt.plan.current.revision, 2);
  assert.equal(receipt.carryForward.length, 1);
  assert.equal(receipt.carryForward[0].sourceAdoptionId, source.adoption_id);
  assert.deepEqual(receipt.activatedBy, {
    kind: "agent",
    agentId: f.techLead.agent.agentId,
    runId: techLeadRunId
  });
  assert.equal(receipt.delegationId, delegation.delegationId);
  const delegationState = (await f.ok(
    "GET", `/api/execution-plans/${current.planId}/replan-delegations`
  )).find(({ delegation: row }: any) =>
    row.delegationId === delegation.delegationId);
  assert.equal(delegationState.consumed, true);
  await f.restart(100);
  const recoveredBridge = await reconnectGovernedAgent(t, f, 2);
  await recoveredBridge.delivery;
  const replay = await callMcp(
    f.app,
    f.techLead.credential.token,
    5406,
    "team.activate_plan_supersession",
    {
      runId: techLeadRunId,
      planId: current.planId,
      delegationId: delegation.delegationId,
      command
    }
  );
  assert.equal(replay.result.isError, undefined, JSON.stringify(replay));
  assert.deepEqual(replay.result.structuredContent?.receipt, receipt);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_plan_supersession_activations
    WHERE operation_id = ?
  `).get(command.operationId) as { n: number }).n, 1);

  const carried = f.database.prepare(`
    SELECT adoption_id, source_adoption_id, adoption_json
    FROM execution_carried_evidence_adoptions
    WHERE plan_id = ? AND plan_revision = 2 AND node_key = 'Build'
  `).get(current.planId) as {
    adoption_id: string;
    adoption_json: string;
    source_adoption_id: string;
  };
  const targetReuse = f.database.prepare(`
    SELECT contract_digest, node_reuse_contract_digest,
      reuse_input_evidence_digest, source_reuse_contract_id
    FROM execution_carried_evidence_reuse_contracts WHERE adoption_id = ?
  `).get(carried.adoption_id) as {
    contract_digest: string;
    node_reuse_contract_digest: string;
    reuse_input_evidence_digest: string;
    source_reuse_contract_id: string;
  };
  assert.equal(carried.source_adoption_id, source.adoption_id);
  assert.equal(targetReuse.source_reuse_contract_id,
    sourceReuse.reuse_contract_id);
  assert.equal(targetReuse.node_reuse_contract_digest,
    sourceReuse.node_reuse_contract_digest);
  assert.equal(targetReuse.reuse_input_evidence_digest,
    sourceReuse.reuse_input_evidence_digest);
  assert.notEqual(targetReuse.contract_digest, sourceReuse.contract_digest,
    "adoption-specific contract digests must not decide reuse");
  assert.equal(
    JSON.parse(carried.adoption_json).authority.service,
    "execution_supersession"
  );
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND plan_revision = 2 AND node_key = 'Build'
  `).get(current.planId) as { n: number }).n, 0,
  "a carried node must not dispatch again");
  const resolution = new ExecutionDependencyResolver(
    new ExecutionPlanRepository(f.database),
    new ExecutionNodeMaterializationRepository(f.database)
  ).resolve({
    planId: current.planId,
    planRevision: 2,
    nodeKey: "Consume"
  });
  assert.equal(resolution.ready, true);
  if (!resolution.ready) throw new Error(resolution.blocker);
  assert.equal(resolution.selections.length, 1);
  assert.equal(resolution.selections[0]!.inputSlot, "patch");
  assert.equal(resolution.selections[0]!.sourceAuthority.adoptionId,
    receipt.carryForward[0].adoptionId);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND plan_revision = 2 AND node_key = 'Consume'
  `).get(current.planId) as { n: number }).n, 0,
  "the active prior-revision Run for the same Task must block new admission");
  const priorConsume = f.database.prepare(`
    SELECT run_id FROM execution_dispatch_intents
    WHERE plan_id = ? AND plan_revision = 1 AND node_key = 'Consume'
  `).get(current.planId) as { run_id: string };
  assert.ok(priorConsume);
  assert.equal(new RunRepository(f.database).applyEvent(priorConsume.run_id, {
    type: "status",
    sequence: 1,
    status: "outcome_unknown",
    error: {
      code: "TEST_AMBIGUOUS_PRIOR_REVISION",
      message: "The prior revision outcome is deliberately ambiguous.",
      retryable: false
    }
  }, "2026-08-31T12:00:04.000Z").applied, true);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM run_ambiguity_acknowledgements
    WHERE run_id = ?
  `).get(priorConsume.run_id) as { n: number }).n, 0);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND plan_revision = 2 AND node_key = 'Consume'
  `).get(current.planId) as { n: number }).n, 0,
  "an unacknowledged ambiguous prior-revision Run must remain a blocker");
  const priorRun = new RunRepository(f.database).getRun(priorConsume.run_id);
  assert.ok(priorRun);
  const priorTask = await f.ok("GET", `/api/tasks/${priorRun.taskId}`);
  await f.ok(
    "POST",
    `/api/runs/${priorConsume.run_id}/ambiguity-acknowledgement`,
    {
      operationId: "op_carry_prior_ambiguity_ack0001",
      expectedTaskRevision: priorTask.taskRevision,
      reason: "The Owner reviewed the old revision before continuing revision two."
    }
  );
  const acknowledgedTask = await f.ok(
    "GET", `/api/tasks/${priorRun.taskId}`
  );
  await f.ok("POST", `/api/tasks/${priorRun.taskId}/control`, {
    operationId: "op_carry_prior_task_ready0001",
    expectedTaskRevision: acknowledgedTask.taskRevision,
    lifecycleState: "ready"
  });
  await waitFor(() => Boolean(f.database.prepare(`
    SELECT 1 FROM execution_dispatch_intents
    WHERE plan_id = ? AND plan_revision = 2 AND node_key = 'Consume'
  `).get(current.planId)));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND plan_revision = 2 AND node_key = 'Consume'
  `).get(current.planId) as { n: number }).n, 1,
  "the deterministic scheduler must continue after exact ambiguity review");
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_carried_evidence_adoptions
    WHERE plan_id = ? AND plan_revision = 2
  `).get(current.planId) as { n: number }).n, 1);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("plan supersession carries verified output into the dependency reader", {
  timeout: 30_000
}, async (t) => {
  const { f, manifest, captured } = await prepareVerifiedDependencySource(t);
  const verification = await retainIndependentVerification(
    f,
    manifest,
    captured
  );
  assert.equal(verification.receipt.outcome, "passed");
  await waitFor(() => Boolean(f.database.prepare(`
    SELECT 1 FROM execution_evidence_adoptions
    WHERE plan_id = ? AND plan_revision = 1 AND node_key = 'Build'
      AND gate = 'verified_output'
  `).get(f.plan.planId)));
  const { receipt } = await carryLocalGate(
    f,
    ["verified_output"],
    "verified_carry"
  );
  assert.equal(receipt.carryForward[0].gate, "verified_output");
  const resolution = new ExecutionDependencyResolver(
    new ExecutionPlanRepository(f.database),
    new ExecutionNodeMaterializationRepository(f.database)
  ).resolve({
    planId: f.plan.planId,
    planRevision: 2,
    nodeKey: "Consume"
  });
  assert.equal(resolution.ready, true);
  if (!resolution.ready) throw new Error(resolution.blocker);
  assert.equal(resolution.selections[0]!.sourceAuthority.adoptionId,
    receipt.carryForward[0].adoptionId);
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

test("scheduler migration backfills automatic controls and retained admission history", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n === 1);
  const retained = f.database.prepare(`
    SELECT intent_id, run_id, agent_id, plan_id, plan_revision, node_key
    FROM execution_dispatch_intents WHERE plan_id = ?
  `).get(f.plan.planId) as {
    agent_id: string;
    intent_id: string;
    node_key: string;
    plan_id: string;
    plan_revision: number;
    run_id: string;
  };
  const planControlRevision = (f.database.prepare(`
    SELECT control_revision FROM execution_plans WHERE plan_id = ?
  `).get(f.plan.planId) as { control_revision: number }).control_revision;
  f.socket.terminate();
  await f.app.close();
  f.database.exec(`
    DROP VIEW execution_all_adopted_node_materializations;
    CREATE VIEW execution_all_adopted_node_materializations AS
    SELECT materialization.plan_id, materialization.plan_revision,
      materialization.node_key, materialization.gate,
      materialization.dispatch_generation, materialization.source_run_id,
      materialization.source_result_id, materialization.source_result_version,
      materialization.gate_operation_id, materialization.materialization_digest,
      materialization.candidate_commit, materialization.candidate_tree,
      materialization.checkpoint_id, materialization.artifact_pins_json,
      materialization.adoption_id, materialization.adoption_digest,
      materialization.source_evidence_id, materialization.source_digest,
      node.task_id AS source_task_id, node.definition_revision,
      node.criteria_revision
    FROM execution_adopted_node_materializations materialization
    JOIN execution_plan_nodes node ON node.plan_id = materialization.plan_id
      AND node.revision = materialization.plan_revision
      AND node.node_key = materialization.node_key
    UNION ALL
    SELECT adoption.plan_id, adoption.plan_revision, adoption.node_key,
      adoption.gate, NULL, NULL, NULL, NULL,
      adoption.operation_id, adoption.adoption_digest,
      source.candidate_commit, source.candidate_tree, NULL,
      source.artifact_pins_json, adoption.adoption_id,
      adoption.adoption_digest, adoption.source_evidence_id,
      adoption.source_digest, node.task_id, node.definition_revision,
      node.criteria_revision
    FROM execution_remote_evidence_adoptions adoption
    JOIN execution_remote_source_evidence source
      ON source.source_evidence_id = adoption.source_evidence_id
      AND source.source_digest = adoption.source_digest
    JOIN execution_plan_nodes node ON node.plan_id = adoption.plan_id
      AND node.revision = adoption.plan_revision
      AND node.node_key = adoption.node_key;
    DROP TRIGGER execution_approval_require_exact_compilation_insert;
    DROP TRIGGER execution_claim_supersession_update;
    DROP TRIGGER execution_plan_supersession_current_update;
    DROP TABLE execution_carried_evidence_reuse_contracts;
    DROP TABLE execution_carried_evidence_adoptions;
    DROP TABLE execution_plan_supersession_receipts;
    DROP TABLE execution_replan_delegation_consumptions;
    DROP TABLE execution_plan_supersession_activations;
    DROP TABLE execution_replan_delegation_revocations;
    DROP TABLE execution_replan_delegations;
    DROP TABLE execution_plan_supersession_candidates;
    DROP TRIGGER execution_plan_create_scheduler_control;
    DROP TRIGGER execution_scheduler_operations_require_scope_insert;
    DROP TRIGGER execution_scheduler_operations_immutable_update;
    DROP TRIGGER execution_scheduler_operations_immutable_delete;
    DROP TRIGGER execution_scheduler_receipts_require_operation_insert;
    DROP TRIGGER execution_scheduler_receipts_immutable_update;
    DROP TRIGGER execution_scheduler_receipts_immutable_delete;
    DROP TRIGGER execution_scheduler_controls_transition_guard;
    DROP TRIGGER execution_scheduler_controls_immutable_delete;
    DROP TRIGGER execution_dispatch_intents_require_scheduler_mode_insert;
    DROP TRIGGER execution_scheduler_fairness_history_require_admission_insert;
    DROP TRIGGER execution_scheduler_fairness_history_immutable_update;
    DROP TRIGGER execution_scheduler_fairness_history_immutable_delete;
    DROP TRIGGER execution_scheduler_fairness_cursor_insert_guard;
    DROP TRIGGER execution_scheduler_fairness_cursor_update_guard;
    DROP TRIGGER execution_scheduler_fairness_cursor_immutable_delete;
    ALTER TABLE execution_dispatch_intents DROP COLUMN scheduler_operation_id;
    DROP TABLE execution_scheduler_fairness_cursors;
    DROP TABLE execution_scheduler_fairness_history;
    DROP TABLE execution_scheduler_receipts;
    DROP TABLE execution_scheduler_operations;
    DROP TABLE execution_scheduler_controls;
    DELETE FROM schema_migrations WHERE version IN (81, 82, 83, 84, 85, 86, 87);
  `);
  f.database.close();

  const migrationDirectory = await mkdtemp(path.join(
    os.tmpdir(),
    "convene-wire-scheduler-migrations-"
  ));
  t.after(() => rm(migrationDirectory, { recursive: true, force: true }));
  for (const name of await readdir(defaultMigrationsDirectory)) {
    if (/^00(?:[0-7][0-9]|80|81)_/u.test(name)) {
      await copyFile(
        path.join(defaultMigrationsDirectory, name),
        path.join(migrationDirectory, name)
      );
    }
  }
  const migration = await migrateDatabase(f.databasePath, migrationDirectory);
  assert.deepEqual(migration.appliedVersions, [81]);
  const migrated = openDatabase(f.databasePath);
  t.after(() => {
    if (migrated.open) migrated.close();
  });
  assert.deepEqual(migrated.prepare(`
    SELECT mode, mode_revision, last_operation_id,
      updated_by_member_id, reason
    FROM execution_scheduler_controls WHERE plan_id = ?
  `).get(f.plan.planId), {
    mode: "automatic",
    mode_revision: 1,
    last_operation_id: null,
    updated_by_member_id: null,
    reason: "Initial automatic scheduler mode."
  });
  assert.equal((migrated.prepare(`
    SELECT control_revision FROM execution_plans WHERE plan_id = ?
  `).get(f.plan.planId) as { control_revision: number }).control_revision,
  planControlRevision);
  assert.deepEqual(migrated.prepare(`
    SELECT agent_id, cursor_revision, plan_id, plan_revision, node_key,
      source, scheduler_operation_id, dispatch_intent_id, run_id
    FROM execution_scheduler_fairness_history WHERE agent_id = ?
  `).get(retained.agent_id), {
    agent_id: retained.agent_id,
    cursor_revision: 1,
    plan_id: retained.plan_id,
    plan_revision: retained.plan_revision,
    node_key: retained.node_key,
    source: "automatic",
    scheduler_operation_id: null,
    dispatch_intent_id: retained.intent_id,
    run_id: retained.run_id
  });
  assert.deepEqual(migrated.prepare(`
    SELECT cursor_revision, last_plan_id, last_plan_revision, last_node_key,
      last_dispatch_intent_id, last_run_id
    FROM execution_scheduler_fairness_cursors WHERE agent_id = ?
  `).get(retained.agent_id), {
    cursor_revision: 1,
    last_plan_id: retained.plan_id,
    last_plan_revision: retained.plan_revision,
    last_node_key: retained.node_key,
    last_dispatch_intent_id: retained.intent_id,
    last_run_id: retained.run_id
  });
  assert.deepEqual(migrated.pragma("foreign_key_check"), []);
});

test("scheduler fills plan capacity with independent Agents in topology order", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    independentAgentIndexes: [0, 1, 2],
    maxConcurrency: 3,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n === 3);
  const intents = f.database.prepare(`
    SELECT node_key, agent_id, run_id, dispatch_generation
    FROM execution_dispatch_intents
    WHERE plan_id = ?
    ORDER BY rowid
  `).all(f.plan.planId) as Array<{
    agent_id: string;
    dispatch_generation: number;
    node_key: string;
    run_id: string;
  }>;
  assert.deepEqual(intents.map((entry) => entry.node_key), [
    "Node1",
    "Node2",
    "Node3"
  ]);
  assert.deepEqual(intents.map((entry) => entry.agent_id),
    f.managedAgents.map((entry) => entry.agent.agentId));
  assert.deepEqual(intents.map((entry) => entry.dispatch_generation), [1, 1, 1]);
  assert.equal(new Set(intents.map((entry) => entry.run_id)).size, 3);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM runs
    WHERE run_id IN (
      SELECT run_id FROM execution_dispatch_intents WHERE plan_id = ?
    ) AND state NOT IN ('completed', 'failed', 'canceled', 'expired',
      'outcome_unknown')
  `).get(f.plan.planId) as { n: number }).n, 3);
  const manifests = intents.map((intent) =>
    new RunRepository(f.database).getContextManifest(intent.run_id)?.execution
  );
  const isolatedWorkspaces = manifests.map(
    (manifest) => manifest?.workspace.workspaceRef
  );
  assert.equal(new Set(isolatedWorkspaces).size, 3);
  assert.ok(isolatedWorkspaces.every((workspaceRef) =>
    typeof workspaceRef === "string" &&
    !f.managedAgents.some((entry) => entry.workspaceRef === workspaceRef)
  ));
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("one shared sweep gives two approved plans fair physical progress", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    agentCount: 4,
    independentAgentIndexes: [0, 1],
    maxConcurrency: 2,
    schedulerMilliseconds: 0
  });
  const root = await f.ok("POST", `/api/rooms/${f.roomId}/tasks`, {
    title: "Ship a second scoped change",
    goal: "Prove fair shared scheduler progress"
  });
  const source = (await f.ok("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: root.taskId,
    content: "Authorize the independent second plan."
  })).message;
  const currentRoot = await f.ok("GET", `/api/tasks/${root.taskId}`);
  const definition = structuredClone(f.plan.current.definition);
  definition.rootTaskId = root.taskId;
  definition.title = "Independent fair scheduler plan";
  definition.decision.sources = [{
    evidenceRefId: "evidence_capacity_planb_source0001",
    kind: "message",
    messageId: source.messageId
  }];
  definition.decision.sourceRevisions = [{
    evidenceRefId: "evidence_capacity_planb_source0001",
    revision: source.sequence
  }];
  for (const [index, node] of definition.nodes.entries()) {
    node.agentId = f.managedAgents[index + 2]!.agent.agentId;
    node.repository.grantId = `grant_capacity_planb_node${index + 1}0001`;
    node.task.title = `Second plan node ${index + 1}`;
  }
  const secondDraft = await f.ok(
    "POST",
    `/api/tasks/${root.taskId}/execution-plans`,
    {
      operationId: "op_capacity_planb_create0001",
      expectedRootTaskRevision: currentRoot.taskRevision,
      definition
    }
  );
  const secondPlan = (await f.ok(
    "POST",
    `/api/execution-plans/${secondDraft.planId}/approvals`,
    {
      operationId: "op_capacity_planb_approval0001",
      expectedRevision: secondDraft.current.revision,
      expectedDigest: secondDraft.current.digest,
      expectedRootTaskRevision: currentRoot.taskRevision,
      decision: "approved",
      reason: "Authorize the second independent capacity plan."
    }
  )).plan;
  for (const compiled of secondPlan.compiledTasks as Array<{
    nodeKey: string;
    taskId: string;
  }>) {
    let task = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
    task = await f.ok("POST", `/api/tasks/${compiled.taskId}/control`, {
      operationId: `op_capacity_planb_${compiled.nodeKey.toLowerCase()}_ready0001`,
      expectedTaskRevision: task.taskRevision,
      lifecycleState: "ready"
    });
    assert.equal(task.lifecycleState, "ready");
  }
  const secondPlanGrants = secondPlan.current.definition.nodes.map(
    (node: typeof f.node, index: number): GovernedExecutionCapabilityReadyGrant => {
      const sourceGrant = f.grants[index]!;
      return {
        ...structuredClone(sourceGrant),
        grant: {
          ...structuredClone(sourceGrant.grant),
          grantId: node.repository.grantId,
          digest: "89abcdef"[index]!.repeat(64)
        },
        agentId: node.agentId,
        planId: secondPlan.planId,
        nodeKey: node.nodeKey
      };
    }
  );

  const schedulerApp = await createServerApp({
    databasePath: f.databasePath,
    logger: false,
    clock: () => now,
    executionSchedulerSweepMilliseconds: 1_000
  });
  await schedulerApp.ready();
  const socket = await schedulerApp.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${f.credential.secret}`,
      host: "127.0.0.1"
    }
  });
  t.after(async () => {
    socket.terminate();
    await schedulerApp.close();
  });
  await sendAndFlush(socket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-test.1",
    connectionEpoch: 2,
    deviceId: f.device.deviceId,
    supportedProtocolVersions: ["1.0"],
    governedExecution: capability
  }, "fair_scheduler_hello0001"));
  for (const [index, managed] of f.managedAgents.entries()) {
    const readyGrants = index < 2
      ? f.grants.filter((grant) => grant.agentId === managed.agent.agentId)
      : secondPlanGrants.filter(
        (grant) => grant.agentId === managed.agent.agentId
      );
    await sendAndFlush(socket, envelope("agent.publish", {
      teamId: f.teamId,
      agentId: managed.agent.agentId,
      ownerMemberId: f.ownerMemberId,
      deviceId: f.device.deviceId,
      name: managed.agent.name,
      role: managed.agent.role,
      capabilities: {
        invocationMode: "managed",
        supportsStart: true,
        supportsResume: false,
        supportsStreaming: true,
        supportsInterrupt: true,
        supportsHandoff: false,
        supportsWorkspaceLeases: true,
        governedExecution: { ...capability, readyGrants }
      },
      workspaceRef: managed.workspaceRef,
      workspaceGeneration: managed.workspaceGeneration,
      workspaceAlias: `Fair scheduler workspace ${index + 1}`
    }, `fair_scheduler_publish000${index + 1}`));
  }
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id IN (?, ?)
  `).get(f.plan.planId, secondPlan.planId) as { n: number }).n === 4, 300);
  const planOrder = [f.plan.planId, secondPlan.planId].sort();
  assert.deepEqual(f.database.prepare(`
    SELECT plan_id, node_key FROM execution_dispatch_intents
    WHERE plan_id IN (?, ?) ORDER BY rowid
  `).all(f.plan.planId, secondPlan.planId), [{
    plan_id: planOrder[0],
    node_key: "Node1"
  }, {
    plan_id: planOrder[1],
    node_key: "Node1"
  }, {
    plan_id: planOrder[0],
    node_key: "Node2"
  }, {
    plan_id: planOrder[1],
    node_key: "Node2"
  }]);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("shared-Agent Plan rotation survives a later sweep and Server restart", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    independentAgentIndexes: [0, 0],
    maxConcurrency: 1,
    schedulerMilliseconds: 0
  });
  const sibling = await createSharedAgentSiblingPlan(f, "rotation");
  let schedulerApp: Awaited<ReturnType<typeof createServerApp>> | undefined;
  let schedulerSocket: BridgeSocket | undefined;
  t.after(async () => {
    schedulerSocket?.terminate();
    await schedulerApp?.close();
  });
  const start = async (epoch: number) => {
    schedulerApp = await createServerApp({
      databasePath: f.databasePath,
      logger: false,
      clock: () => now,
      executionSchedulerSweepMilliseconds: 100
    });
    await schedulerApp.ready();
    schedulerSocket = await schedulerApp.injectWS("/ws/bridge", {
      headers: {
        authorization: `Bearer ${f.credential.secret}`,
        host: "127.0.0.1"
      }
    });
    await sendAndFlush(schedulerSocket, envelope("bridge.hello", {
      bridgeVersion: "v0.4.0-test.1",
      connectionEpoch: epoch,
      deviceId: f.device.deviceId,
      supportedProtocolVersions: ["1.0"],
      governedExecution: capability
    }, `rotation_hello000${epoch}`));
    const managed = f.managedAgents[0]!;
    await sendAndFlush(schedulerSocket, envelope("agent.publish", {
      teamId: f.teamId,
      agentId: managed.agent.agentId,
      ownerMemberId: f.ownerMemberId,
      deviceId: f.device.deviceId,
      name: managed.agent.name,
      role: managed.agent.role,
      capabilities: {
        invocationMode: "managed",
        supportsStart: true,
        supportsResume: false,
        supportsStreaming: true,
        supportsInterrupt: true,
        supportsHandoff: false,
        supportsWorkspaceLeases: true,
        governedExecution: {
          ...capability,
          readyGrants: [...f.grants, ...sibling.grants]
        }
      },
      workspaceRef: managed.workspaceRef,
      workspaceGeneration: managed.workspaceGeneration,
      workspaceAlias: "Durable rotation workspace"
    }, `rotation_publish000${epoch}`));
  };

  await start(2);
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id IN (?, ?)
  `).get(f.plan.planId, sibling.plan.planId) as { n: number }).n === 1);
  const first = f.database.prepare(`
    SELECT plan_id, node_key, run_id FROM execution_dispatch_intents
    WHERE plan_id IN (?, ?)
  `).get(f.plan.planId, sibling.plan.planId) as {
    node_key: string;
    plan_id: string;
    run_id: string;
  };
  schedulerSocket!.terminate();
  await schedulerApp!.close();
  schedulerSocket = undefined;
  schedulerApp = undefined;
  assert.equal(new RunRepository(f.database).applyEvent(first.run_id, {
    type: "status",
    sequence: 1,
    status: "failed",
    error: {
      code: "EXPECTED_FAULT",
      message: "Release shared Agent capacity for the next Plan.",
      retryable: false
    }
  }, "2026-08-31T12:00:01.000Z").applied, true);

  await start(3);
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id IN (?, ?)
  `).get(f.plan.planId, sibling.plan.planId) as { n: number }).n === 2);
  const selections = f.database.prepare(`
    SELECT plan_id, node_key FROM execution_scheduler_fairness_history
    WHERE agent_id = ? ORDER BY cursor_revision
  `).all(f.managedAgents[0]!.agent.agentId) as Array<{
    node_key: string;
    plan_id: string;
  }>;
  assert.equal(selections.length, 2);
  assert.equal(selections[0]!.plan_id, first.plan_id);
  assert.notEqual(selections[1]!.plan_id, first.plan_id,
    "the prior Plan must not reacquire the shared Agent before its peer");
  assert.deepEqual(f.database.prepare(`
    SELECT cursor_revision, last_plan_id, last_node_key
    FROM execution_scheduler_fairness_cursors WHERE agent_id = ?
  `).get(f.managedAgents[0]!.agent.agentId), {
    cursor_revision: 2,
    last_plan_id: selections[1]!.plan_id,
    last_node_key: selections[1]!.node_key
  });
  assert.equal((f.database.prepare(`
    SELECT count(DISTINCT run_id) AS n FROM execution_dispatch_intents
    WHERE plan_id IN (?, ?)
  `).get(f.plan.planId, sibling.plan.planId) as { n: number }).n, 2);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("same-Agent serialization leaves capacity for another Agent", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    independentAgentIndexes: [0, 0, 1],
    maxConcurrency: 3,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n === 2);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const intents = f.database.prepare(`
    SELECT node_key, agent_id FROM execution_dispatch_intents
    WHERE plan_id = ? ORDER BY rowid
  `).all(f.plan.planId) as Array<{ agent_id: string; node_key: string }>;
  assert.deepEqual(intents.map((entry) => entry.node_key), ["Node1", "Node3"]);
  assert.equal(intents[0]!.agent_id, f.managedAgents[0]!.agent.agentId);
  assert.equal(intents[1]!.agent_id, f.managedAgents[1]!.agent.agentId);
  assert.deepEqual(f.database.prepare(`
    SELECT state, blocker_code FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Node2'
  `).get(f.plan.planId), {
    state: "blocked",
    blocker_code: "EXECUTION_AGENT_CAPACITY_EXHAUSTED"
  });
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("fan-in schedules once only after every adopted predecessor proof", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    fanInDependency: true,
    independentAgentIndexes: [0, 1, 2],
    maxConcurrency: 2,
    schedulerMilliseconds: 100
  });
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n === 2);
  assert.deepEqual(f.database.prepare(`
    SELECT node_key FROM execution_dispatch_intents
    WHERE plan_id = ? ORDER BY rowid
  `).all(f.plan.planId), [{ node_key: "Node1" }, { node_key: "Node2" }]);
  assert.deepEqual(f.database.prepare(`
    SELECT state, blocker_code FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Node3'
  `).get(f.plan.planId), {
    state: "blocked",
    blocker_code: "EXECUTION_DEPENDENCY_NOT_MATERIALIZED"
  });

  await completeAndAcceptScheduledNode(f, "Node1");
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Node3'
  `).get(f.plan.planId) as { n: number }).n, 0,
  "one adopted predecessor cannot release a two-input fan-in");

  await completeAndAcceptScheduledNode(f, "Node2");
  try {
    await waitFor(() => (f.database.prepare(`
      SELECT count(*) AS n FROM execution_dispatch_intents
      WHERE plan_id = ? AND node_key = 'Node3'
    `).get(f.plan.planId) as { n: number }).n === 1);
  } catch (error) {
    const state = f.database.prepare(`
      SELECT state, blocker_code FROM execution_node_states
      WHERE plan_id = ? AND node_key = 'Node3'
    `).get(f.plan.planId);
    const adoptions = f.database.prepare(`
      SELECT node_key, gate FROM execution_evidence_adoptions
      WHERE plan_id = ? ORDER BY node_key, gate
    `).all(f.plan.planId);
    throw new Error(`Fan-in destination was not scheduled: ${JSON.stringify({
      state,
      adoptions
    })}`, { cause: error });
  }
  const destination = f.database.prepare(`
    SELECT intent.run_id, run.context_manifest_json
    FROM execution_dispatch_intents intent
    JOIN runs run ON run.run_id = intent.run_id
    WHERE intent.plan_id = ? AND intent.node_key = 'Node3'
  `).get(f.plan.planId) as {
    context_manifest_json: string;
    run_id: string;
  };
  const manifest = JSON.parse(destination.context_manifest_json).execution as
    GovernedExecutionManifest;
  assert.equal(manifest.inputs.length, 2);
  assert.deepEqual(manifest.inputs.map((input) => input.edgeKey).sort(), [
    "node1_node3",
    "node2_node3"
  ]);
  assert.ok(manifest.inputs.every((input) => input.gate === "accepted_result"));
  await f.restart(100);
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Node3'
  `).get(f.plan.planId) as { n: number }).n, 1);
  assert.equal((f.database.prepare(`
    SELECT count(DISTINCT run_id) AS n FROM execution_dispatch_intents
    WHERE plan_id = ? AND node_key = 'Node3'
  `).get(f.plan.planId) as { n: number }).n, 1);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("offline node stays blocked and reconnect releases the same generation", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    schedulerMilliseconds: 500
  });
  f.socket.terminate();
  await waitFor(() => (f.database.prepare(`
    SELECT blocker_code FROM execution_node_states
    WHERE plan_id = ? AND node_key = 'Build'
  `).get(f.plan.planId) as { blocker_code: string } | undefined)
    ?.blocker_code === "EXECUTION_CAPABILITY_UNAVAILABLE");
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

test("two Server schedulers retain exact multi-node generation-1 winners", {
  timeout: 30_000
}, async (t) => {
  const f = await admissionFixture(t, undefined, {
    independentAgentIndexes: [0, 1, 2],
    maxConcurrency: 3,
    schedulerMilliseconds: 1_000
  });
  const second = await createServerApp({
    databasePath: f.databasePath,
    logger: false,
    clock: () => now,
    executionSchedulerSweepMilliseconds: 1_000
  });
  await second.ready();
  const secondSocket = await second.injectWS("/ws/bridge", {
    headers: {
      authorization: `Bearer ${f.credential.secret}`,
      host: "127.0.0.1"
    }
  });
  t.after(async () => {
    secondSocket.terminate();
    await second.close();
  });
  await sendAndFlush(secondSocket, envelope("bridge.hello", {
    bridgeVersion: "v0.4.0-test.1",
    connectionEpoch: 2,
    deviceId: f.device.deviceId,
    supportedProtocolVersions: ["1.0"],
    governedExecution: capability
  }, "second_server_hello0001"));
  for (const [index, managed] of f.managedAgents.entries()) {
    const readyGrants = f.grants.filter((candidate) =>
      candidate.agentId === managed.agent.agentId
    );
    await sendAndFlush(secondSocket, envelope("agent.publish", {
      teamId: f.teamId,
      agentId: managed.agent.agentId,
      ownerMemberId: f.ownerMemberId,
      deviceId: f.device.deviceId,
      name: managed.agent.name,
      role: managed.agent.role,
      capabilities: {
        invocationMode: "managed",
        supportsStart: true,
        supportsResume: false,
        supportsStreaming: true,
        supportsInterrupt: true,
        supportsHandoff: false,
        supportsWorkspaceLeases: true,
        governedExecution: { ...capability, readyGrants }
      },
      workspaceRef: managed.workspaceRef,
      workspaceGeneration: managed.workspaceGeneration,
      workspaceAlias: `Second Server workspace ${index + 1}`
    }, `second_server_publish000${index + 1}`));
  }
  await waitFor(() => (f.database.prepare(`
    SELECT count(*) AS n FROM execution_dispatch_intents
    WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n === 3);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const intents = f.database.prepare(`
    SELECT node_key, dispatch_generation, run_id, trace_message_id
    FROM execution_dispatch_intents
    WHERE plan_id = ? ORDER BY node_key
  `).all(f.plan.planId) as Array<{
    dispatch_generation: number;
    node_key: string;
    run_id: string;
    trace_message_id: string;
  }>;
  assert.deepEqual(intents.map((entry) => entry.node_key), [
    "Node1",
    "Node2",
    "Node3"
  ]);
  assert.ok(intents.every((entry) => entry.dispatch_generation === 1));
  assert.equal(new Set(intents.map((entry) => entry.run_id)).size, 3);
  assert.equal(new Set(intents.map((entry) => entry.trace_message_id)).size, 3);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM runs
    WHERE run_id IN (
      SELECT run_id FROM execution_dispatch_intents WHERE plan_id = ?
    )
  `).get(f.plan.planId) as { n: number }).n, 3);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM isolated_workspace_leases
    WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n, 3);
  assert.equal((f.database.prepare(`
    SELECT count(DISTINCT workspace_ref) AS n FROM isolated_workspace_leases
    WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n, 3);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_input_bindings
    WHERE plan_id = ?
  `).get(f.plan.planId) as { n: number }).n, 0);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_scheduler_fairness_history
    WHERE run_id IN (
      SELECT run_id FROM execution_dispatch_intents WHERE plan_id = ?
    )
  `).get(f.plan.planId) as { n: number }).n, 3);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_scheduler_fairness_cursors
    WHERE agent_id IN (
      SELECT agent_id FROM execution_dispatch_intents WHERE plan_id = ?
    ) AND cursor_revision = 1
  `).get(f.plan.planId) as { n: number }).n, 3);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});
