import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type {
  GovernedExecutionCapabilityReadyGrant,
  GovernedExecutionManifest
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
  operations: ["prepare", "capture"] as const
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
    const onMessage = (source: { toString(): string }): void => {
      socket.off("close", onClose);
      resolve(JSON.parse(source.toString()) as BridgeMessage);
    };
    const onClose = (code: number, reason: Buffer): void => {
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
  const compiled = plan.compiledTasks.find(
    (candidate: { nodeKey: string }) => candidate.nodeKey === "Build"
  );
  assert.ok(compiled);
  let task = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
  task = await f.ok("POST", `/api/tasks/${task.taskId}/control`, {
    operationId: "op_governed_task_ready0001",
    expectedTaskRevision: task.taskRevision,
    lifecycleState: "ready"
  });
  const node = plan.current.definition.nodes.find(
    (candidate: { nodeKey: string }) => candidate.nodeKey === "Build"
  );
  assert.ok(node?.repository);
  const grant: GovernedExecutionCapabilityReadyGrant = {
    grant: {
      grantId: node.repository.grantId,
      revision: node.repository.grantRevision,
      digest: "d".repeat(64),
      expiresAt: "2026-08-31T13:00:00.000Z"
    },
    repositoryId: node.repository.repositoryId,
    bindingId: node.repository.bindingId,
    deviceId: device.deviceId,
    agentId: agent.agentId,
    planId: plan.planId,
    nodeKey: node.nodeKey,
    operations: ["prepare", "capture"],
    runtimeProfile: {
      profileId: node.repository.runtimeProfileId,
      revision: 1,
      digest: node.repository.runtimeProfileDigest
    },
    verificationProfiles: node.verificationProfiles.map(
      (profile: { profileId: string; revision: number; digest: string }) => ({
        profileId: profile.profileId,
        revision: profile.revision,
        digest: profile.digest
      })
    ),
    scopePolicy: structuredClone(node.scope),
    integrationTargets: [],
    issuedAt: now,
    revokedAt: null
  };
  grantChange?.(grant);
  const agentCapability = { ...capability, readyGrants: [grant] };
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
    return persisted?.governedExecution?.readyGrants?.length === 1;
  });
  return {
    ...f,
    socket,
    device,
    credential,
    agent,
    plan,
    node,
    task,
    grant,
    agentCapability,
    workspaceRef,
    workspaceGeneration,
    scheduledDelivery
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
