import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ExecutionInputBinding, ExecutionPlanProjection, GovernedExecutionManifest, RepositoryOperationRequest } from "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { ArtifactPublicationRepository } from "../src/artifact/artifact-publication-repository.js";
import { LocalArtifactBlobStore } from "../src/artifact/local-artifact-blob-store.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { ExecutionApprovalRepository } from "../src/execution/execution-approval-repository.js";
import { ExecutionInputRepository } from "../src/execution/execution-input-repository.js";
import { ExecutionInputService, type FreezeExecutionInputs } from "../src/execution/execution-input-service.js";
import { ExecutionPlanRepository } from "../src/execution/execution-plan-repository.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { AuthService } from "../src/security/auth-service.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { fixture, now } from "./helpers/execution-plan-fixture.js";
import { BridgeConnectionRegistry } from "../src/bridge/bridge-connection-registry.js";
import { IsolatedWorkspaceLeaseService, planIsolatedWorkspace } from "../src/workspace/isolated-workspace-lease-service.js";
import {
  capability,
  capabilityForManifest
} from "./helpers/isolated-workspace-fixture.js";

const expiresAt = "2026-08-31T12:05:00.000Z";
const bytes = Buffer.from("diff --git a/src/file b/src/file\n+accepted input\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const wire = JSON.parse(await readFile(new URL(
  "../../../packages/contracts/fixtures/execution-runtime-cases.json", import.meta.url
), "utf8")).cases.find((entry: { name: string }) => entry.name === "execution runtime: valid governed wire delivery").instance.payload;

async function inputFixture(t: TestContext, options: { gate?: "verified_output" | "integrated_commit"; twoInputs?: boolean; external?: boolean; captureOutput?: boolean } = {}) {
  const f = await fixture(t);
  const { database } = f;
  const core = new CoreRepository(database), auth = new AuthService(database);
  const member = auth.authenticateWebSession(f.authorization.slice(7), now);
  const registry = new MemberDeviceService(core, auth), agents = new AgentService(core, auth);
  const devices = ["Source", "Destination"].map((name, index) => {
    const device = registry.registerOwnDevice(member, f.teamId, name, now);
    const credential = auth.issueDeviceCredential(device.deviceId, now);
    let agent = agents.publishAgent(member, {
      teamId: f.teamId, deviceId: device.deviceId, name, role: name, integrationMode: "managed",
      workspaceRef: `workspace_${String(index + 1).repeat(64)}`, workspaceGeneration: "b".repeat(64),
      capabilities: { supportsStart: true, supportsResume: false, supportsStreaming: false, supportsInterrupt: true,
        supportsHandoff: false, supportsWorkspaceLeases: true, supportsArtifactPublication: true }, now
    });
    const principal = auth.authenticateDevice(credential.secret, now);
    if (name === "Destination") {
      agent = agents.publishDeviceAgent(principal, {
        agentId: agent.agentId, name: agent.name, role: agent.role, now,
        workspaceRef: agent.workspaceRef!, workspaceGeneration: agent.workspaceGeneration!,
        capabilities: { ...agent.capabilities, governedExecution: capability }
      });
    }
    return { device, agent, authorization: `Bearer ${credential.secret}`, principal };
  });
  const [source, destination] = devices as [typeof devices[number], typeof devices[number]];
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, {
    memberIds: [f.ownerMemberId], agentIds: devices.map((entry) => entry.agent.agentId)
  });
  const command = f.command();
  const tasks: any[] = [];
  for (const [index, node] of command.definition.nodes.entries()) {
    const task = await f.ok("POST", `/api/rooms/${f.roomId}/tasks`, {
      title: node.task.title, goal: node.task.goal, ownerMemberId: f.ownerMemberId,
      completionPolicy: "accepted_result_required", lifecycleState: "ready", criteria: node.task.criteria,
      budgetPolicy: node.budget, assignments: [{ agentId: devices[index]!.agent.agentId, role: "primary" }]
    });
    tasks.push(task);
    node.agentId = devices[index]!.agent.agentId;
  }
  const sourceMessage = (await f.ok("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: tasks[0].taskId, content: "Publish one accepted patch", mentionAgentId: source.agent.agentId
  })).message;
  const sourceRunRow = database.prepare("SELECT run_id FROM runs WHERE trigger_message_id = ?")
    .get(sourceMessage.messageId) as { run_id: string };
  assert.ok(sourceRunRow);
  const runs = new RunRepository(database);
  const sourceRun = runs.getRun(sourceRunRow.run_id)!;
  runs.applyEvent(sourceRun.runId, { type: "status", sequence: 1, status: "delivered" }, now);
  const lease = await f.ok("POST", "/api/bridge/workspace-leases/read-source", {
    runId: sourceRun.runId, agentId: source.agent.agentId, workspaceRef: source.agent.workspaceRef,
    workspaceGeneration: source.agent.workspaceGeneration, idempotencyKey: "idem_execution_source_lease_0001"
  }, source.authorization);
  const publication = await f.ok("POST", "/api/bridge/artifact-publications", {
    leaseId: lease.leaseId, runId: sourceRun.runId, agentId: source.agent.agentId,
    workspaceRef: source.agent.workspaceRef, workspaceGeneration: source.agent.workspaceGeneration,
    idempotencyKey: "idem_execution_source_publication_0001", artifactType: "patch", fileName: "change.patch",
    mediaType: "text/x-diff", title: "Accepted source patch", summary: "Exact sealed bytes",
    sizeBytes: bytes.length, sha256
  }, source.authorization);
  await f.ok("POST", `/api/bridge/artifact-publications/${publication.publicationId}/chunks`, {
    offset: 0, chunkBase64: bytes.toString("base64"), chunkSha256: sha256
  }, source.authorization);
  await f.ok("POST", `/api/bridge/artifact-publications/${publication.publicationId}/seal`, {}, source.authorization);
  const artifact = (await f.ok("POST", `/api/bridge/artifact-publications/${publication.publicationId}/bind`, {}, source.authorization)).artifact;
  runs.applyEvent(sourceRun.runId, { type: "status", sequence: 2, status: "completed" }, now);
  const currentSource = await f.ok("POST", `/api/tasks/${tasks[0].taskId}/control`, {
    operationId: "op_input_source_active0001", lifecycleState: "active",
    expectedTaskRevision: (await f.ok("GET", `/api/tasks/${tasks[0].taskId}`)).taskRevision
  });
  const result = await f.ok("POST", `/api/tasks/${tasks[0].taskId}/results`, {
    operationId: "op_input_result_0001", taskId: tasks[0].taskId,
    definitionRevision: currentSource.definitionRevision, criteriaRevision: currentSource.criteriaRevision,
    proposedAtTaskRevision: currentSource.taskRevision, supersedesResultId: null,
    outcome: "informational", summary: "Owner-selected sealed patch", risks: [], openQuestions: [],
    nextActions: [], criterionClaims: [], sources: [{ evidenceRefId: "evidence_input_0001", kind: "artifact", artifactId: artifact.artifactId }]
  });
  await f.ok("POST", `/api/results/${result.resultId}/review-decisions`, {
    operationId: "op_input_review_0001", expectedTaskRevision: (await f.ok("GET", `/api/tasks/${tasks[0].taskId}`)).taskRevision,
    expectedReviewRevision: 0, decision: "accepted", completeTask: false, reason: "Accept these exact bytes"
  });
  for (const [index, node] of command.definition.nodes.entries()) {
    tasks[index] = await f.ok("GET", `/api/tasks/${tasks[index].taskId}`);
    node.task = { mode: "existing", taskId: tasks[index].taskId, expectedTaskRevision: tasks[index].taskRevision,
      definitionRevision: tasks[index].definitionRevision, criteriaRevision: tasks[index].criteriaRevision };
  }
  command.definition.edges[0]!.gate = options.gate ?? "accepted_result";
  if (options.gate === "integrated_commit") {
    const repository = command.definition.nodes[0]!.repository!;
    command.definition.policy.integration = "local_integration";
    command.definition.policy.integrationTargets = [{ repositoryId: repository.repositoryId,
      targetRef: "refs/heads/main", expectedCommit: repository.baseCommit }];
  }
  if (options.twoInputs) {
    command.definition.nodes[1]!.inputs.push({ slotKey: "second", kind: "patch", required: true });
    command.definition.edges[0]!.bindings.push({ outputSlot: "output", inputSlot: "second" });
  }
  if (options.external) {
    command.definition.edges = [];
    command.definition.externalInputs = [{ nodeKey: "Review", inputSlot: "patch", sourceTaskId: tasks[0].taskId,
      sourceResultId: result.resultId, artifactId: artifact.artifactId, artifactRevision: artifact.artifactRevision,
      contentDigest: sha256, kind: "patch" }];
  }
  command.expectedRootTaskRevision = (await f.ok("GET", `/api/tasks/${f.root.taskId}`)).taskRevision;
  const draft = await f.create(command);
  const plan = (await f.ok("POST", `/api/execution-plans/${draft.planId}/approvals`, {
    operationId: "op_input_approval0001", expectedRevision: draft.current.revision, expectedDigest: draft.current.digest,
    expectedRootTaskRevision: command.expectedRootTaskRevision, decision: "approved", reason: "Approve exact input slots"
  })).plan as ExecutionPlanProjection;
  const trigger = (await f.ok("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: tasks[1].taskId, content: "Frozen input authorization fixture"
  })).message;
  const runId = "run_execution_destination0001";
  // This is a future admission-state fixture, not a working scheduler. Restore
  // the production prerequisite inside the same transaction immediately after
  // inserting one queued Run. No Runtime is invoked. Derived-output tests use
  // a synthetic capability peer to exercise the separate capture HTTP gate.
  database.transaction(() => {
    const guard = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'execution_runs_require_governed_admission_insert'")
      .get() as { sql: string };
    assert.ok(guard);
    database.exec("DROP TRIGGER execution_runs_require_governed_admission_insert");
    database.prepare(`INSERT INTO runs (run_id, trace_id, room_id, task_id, trigger_message_id, requester_member_id,
      target_agent_id, parent_run_id, instruction, state, last_sequence, deadline_at, created_at, updated_at,
      terminal_at, orchestration_key, attempt_number, retry_of_run_id, context_manifest_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'Read the exact input', 'queued', 0, ?, ?, ?, NULL, NULL, 1, NULL, NULL)`)
      .run(runId, "trace_execution_destination0001", f.roomId, tasks[1].taskId, trigger.messageId,
        f.ownerMemberId, destination.agent.agentId, expiresAt, now, now);
    database.exec(guard.sql);
  })();
  const databasePath = (database.pragma("database_list") as Array<{ file: string }>)[0]!.file;
  const inputRepository = new ExecutionInputRepository(database);
  const service = new ExecutionInputService(database, inputRepository, new ExecutionPlanRepository(database),
    new ExecutionApprovalRepository(database), new ArtifactRepository(database),
    new ArtifactPublicationRepository(database), new LocalArtifactBlobStore(path.join(path.dirname(databasePath), "artifact-blobs")), auth);
  const input: FreezeExecutionInputs = { planId: plan.planId, revision: plan.current.revision,
    expectedDigest: plan.current.digest, expectedControlRevision: plan.controlRevision, nodeKey: "Review", runId,
    deviceId: destination.device.deviceId, expiresAt, selections: [
      { inputSlot: "patch", sourceResultId: result.resultId, artifactId: artifact.artifactId },
      ...(options.twoInputs ? [{ inputSlot: "second", sourceResultId: result.resultId, artifactId: artifact.artifactId }] : [])
    ] };
  const freeze = (value = input, at = now) => database.transaction(() => service.freezeForRun(value, at))();
  const deliver = (bindings: ExecutionInputBinding[], mutate?: (manifest: GovernedExecutionManifest) => void,
    mutateDelivery?: (payload: typeof wire) => void) => {
    const payload = structuredClone(wire);
    payload.runId = runId;
    payload.targetAgentId = destination.agent.agentId;
    const context = payload.contextManifest;
    Object.assign(context, { runId, taskId: tasks[1].taskId, taskRevision: tasks[1].taskRevision,
      definitionRevision: tasks[1].definitionRevision, criteriaRevision: tasks[1].criteriaRevision,
      goal: tasks[1].goal, criteria: tasks[1].criteria });
    context.target.agentId = destination.agent.agentId;
    context.target.deviceId = destination.device.deviceId;
    const execution = context.execution as GovernedExecutionManifest;
    Object.assign(execution.scope, { planId: plan.planId, planRevision: plan.current.revision, planDigest: plan.current.digest,
      approvalOperationId: "op_input_approval0001", planControlRevision: plan.controlRevision, nodeKey: "Review",
      roomId: f.roomId, taskId: tasks[1].taskId, taskRevision: tasks[1].taskRevision,
      definitionRevision: tasks[1].definitionRevision, criteriaRevision: tasks[1].criteriaRevision,
      runId, agentId: destination.agent.agentId, deviceId: destination.device.deviceId });
    execution.inputs = bindings;
    execution.inputDigest = executionOperationDigest(bindings);
    execution.deadline = expiresAt;
    if (options.captureOutput) {
      const node = plan.current.definition.nodes.find((node) => node.nodeKey === "Review")!;
      execution.repository = node.repository!;
      execution.scopePolicy = node.scope;
      execution.outputs = node.outputs;
      execution.verificationProfiles = node.verificationProfiles;
      execution.grant = { ...execution.grant, grantId: node.repository!.grantId,
        revision: node.repository!.grantRevision, expiresAt };
      const current = database.prepare("SELECT task_revision FROM agent_tasks WHERE task_id = ?")
        .get(tasks[1].taskId) as { task_revision: number };
      context.taskRevision = current.task_revision;
      execution.scope.taskRevision = current.task_revision;
      execution.workspace = planIsolatedWorkspace(execution.scope, execution.repository, now, expiresAt);
    }
    mutate?.(execution);
    const { manifestDigest: _digest, ...unsigned } = execution;
    execution.manifestDigest = executionOperationDigest(unsigned);
    if (options.captureOutput) {
      const connections = new BridgeConnectionRegistry();
      connections.register(destination.device.deviceId, 1, { send() {}, close() {} }, { governedExecution: capability });
      assert.equal(connections.recordGovernedAgentCapability(
        destination.device.deviceId, 1, destination.agent.agentId, capability
      ), true);
      const isolated = new IsolatedWorkspaceLeaseService(database, new ExecutionPlanRepository(database), connections);
      database.transaction(() => isolated.reserveForRun(execution, now))();
    }
    database.prepare("UPDATE runs SET context_manifest_json = ? WHERE run_id = ?").run(JSON.stringify(context), runId);
    mutateDelivery?.(payload);
    database.prepare(`INSERT INTO run_deliveries (delivery_attempt_id, run_id, device_id, idempotency_key,
      payload_hash, payload_json, state, send_count, created_at)
      VALUES ('delivery_execution_input0001', ?, ?, 'delivery-execution-input-0001', ?, ?, 'pending', 0, ?)`)
      .run(runId, destination.device.deviceId, executionOperationDigest(payload), JSON.stringify(payload), now);
  };
  const count = () => (database.prepare("SELECT count(*) AS n FROM execution_input_bindings").get() as { n: number }).n;
  return { ...f, source, destination, tasks, artifact, result, plan, runId, service, inputRepository,
    input, freeze, deliver, count, bytes, auth, databasePath,
    contentUrl: (bindingId: string) => `/api/bridge/runs/${runId}/execution-inputs/${bindingId}/content` };
}

test("accepted Result inputs pin sealed source evidence and expose only the exact destination Device bytes", async (t) => {
  const f = await inputFixture(t);
  assert.throws(() => f.service.freezeForRun(f.input, now), /EXECUTION_TRANSACTION_REQUIRED/u);
  const bindings = f.freeze();
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0]!.sourceTaskId, f.tasks[0].taskId);
  assert.equal(bindings[0]!.destinationTaskId, f.tasks[1].taskId);
  assert.equal(bindings[0]!.gateOperationId, "op_input_review_0001");
  assert.equal(bindings[0]!.artifact.contentDigest, sha256);
  assert.deepEqual(f.freeze(f.input, "2026-08-31T12:00:01.000Z"), bindings);
  assert.equal(f.count(), 1);
  f.deliver(bindings);
  const allowed = await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization);
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.deepEqual(allowed.rawPayload, bytes);
  assert.equal(allowed.headers["x-convenewire-content-sha256"], sha256);
  assert.match(String(allowed.headers["cache-control"]), /no-store/u);
  assert.equal((await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.source.authorization)).statusCode, 403);
  assert.equal((await f.request("GET", f.contentUrl("input_unknown_00000001"), undefined, f.destination.authorization)).statusCode, 403);
  const view = await f.ok("GET", `/api/execution-plans/${f.plan.planId}/inputs/${bindings[0]!.bindingId}`);
  assert.deepEqual(view, bindings[0]);
  assert.equal(JSON.stringify(view).includes("storageKey"), false);
  assert.equal(JSON.stringify(view).includes(f.databasePath), false);
  assert.throws(() => f.database.prepare("UPDATE execution_input_bindings SET expires_at = ?").run(expiresAt), /immutable/u);
  assert.throws(() => f.database.prepare("DELETE FROM execution_input_bindings").run(), /immutable/u);
  await f.restart();
  const reopened = await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization);
  assert.equal(reopened.statusCode, 200, reopened.body);
  assert.deepEqual(reopened.rawPayload, bytes);
  assert.deepEqual(f.freeze(), bindings, "an exact frozen-manifest retry preserves the original binding");
});

test("input selection rejects missing, duplicate, foreign and stale pins without persisting a partial grant", async (t) => {
  const f = await inputFixture(t);
  for (const mutate of [
    (input: FreezeExecutionInputs) => { input.revision++; },
    (input: FreezeExecutionInputs) => { input.expectedDigest = "0".repeat(64); },
    (input: FreezeExecutionInputs) => { input.expectedControlRevision++; },
    (input: FreezeExecutionInputs) => { input.nodeKey = "Build"; },
    (input: FreezeExecutionInputs) => { input.deviceId = f.source.device.deviceId; },
    (input: FreezeExecutionInputs) => { input.runId = "run_missing_00000001"; },
    (input: FreezeExecutionInputs) => { input.expiresAt = now; },
    (input: FreezeExecutionInputs) => { input.expiresAt = "2026-08-31T13:00:00.000Z"; },
    (input: FreezeExecutionInputs) => { input.selections = []; },
    (input: FreezeExecutionInputs) => { input.selections.push(input.selections[0]!); },
    (input: FreezeExecutionInputs) => { input.selections[0]!.inputSlot = "other"; },
    (input: FreezeExecutionInputs) => { input.selections[0]!.sourceResultId = "result_other_000001"; },
    (input: FreezeExecutionInputs) => { input.selections[0]!.artifactId = "artifact_other_000001"; }
  ]) {
    const invalid = structuredClone(f.input);
    mutate(invalid);
    assert.throws(() => f.freeze(invalid), /EXECUTION_INPUT_/u);
    assert.equal(f.count(), 0);
  }
  const original = f.freeze();
  assert.throws(() => f.freeze({ ...f.input, expiresAt: "2026-08-31T12:04:00.000Z" }), /EXECUTION_INPUT_CONFLICT/u);
  assert.deepEqual(f.freeze(), original);
});

for (const gate of ["verified_output", "integrated_commit"] as const) {
  test(`accepted Results cannot substitute for independent ${gate} gates`, async (t) => {
    const f = await inputFixture(t, { gate });
    assert.equal(f.plan.current.definition.edges[0]!.gate, gate);
    assert.throws(() => f.freeze(), /EXECUTION_INPUT_GATE_UNAVAILABLE/u);
    assert.equal(f.count(), 0);
  });
}

test("approved external inputs pin the exact Result and sealed content without inheriting its acceptance", async (t) => {
  const f = await inputFixture(t, { external: true });
  const bindings = f.freeze();
  assert.equal(bindings[0]!.edgeKey, null);
  assert.equal(bindings[0]!.sourceOutputSlot, "external");
  f.deliver(bindings);
  assert.equal((await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization)).statusCode, 200);
  const destination = await f.ok("GET", `/api/tasks/${f.tasks[1].taskId}`);
  assert.equal(destination.completionResultId, null);
  assert.equal(destination.lifecycleState, "ready");
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM task_results WHERE task_id = ?").get(destination.taskId) as { n: number }).n, 0);
});

test("input grants cannot be added after the destination manifest has been frozen", async (t) => {
  const f = await inputFixture(t);
  f.deliver([]);
  assert.throws(() => f.freeze(), /EXECUTION_INPUT_MANIFEST_FROZEN/u);
  assert.equal(f.count(), 0);
});

test("a Delivery cannot substitute the outer context of the canonical Run manifest", async (t) => {
  const f = await inputFixture(t);
  const bindings = f.freeze();
  f.deliver(bindings, undefined, (payload) => { payload.contextManifest.goal = "A substituted goal"; });
  const rejected = await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization);
  assert.equal(rejected.statusCode, 403, rejected.body);
});

test("input bindings never enable ordinary Mention execution on a governed Task", async (t) => {
  const f = await inputFixture(t);
  f.deliver(f.freeze());
  const before = f.counts();
  const rejected = await f.request("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: f.tasks[1].taskId, content: "Bypass the plan", mentionAgentId: f.destination.agent.agentId
  });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.match(rejected.body, /EXECUTION_DISPATCH_SCOPE_INVALID/u);
  assert.equal(f.counts().runs, before.runs);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("an explicit input grant does not expand the ordinary same-Task content endpoint", async (t) => {
  const f = await inputFixture(t);
  const bindings = f.freeze();
  f.deliver(bindings);
  const ordinaryUrl = `/api/bridge/runs/${f.runId}/artifacts/${f.artifact.artifactId}/contents/${f.artifact.contentId}`;
  const rejected = await f.request("GET", ordinaryUrl, undefined, f.destination.authorization);
  assert.equal(rejected.statusCode, 403, rejected.body);
  assert.equal((await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization)).statusCode, 200);
});

test("input reads verify sealed bytes and do not disclose corrupt content or local storage paths", async (t) => {
  const f = await inputFixture(t);
  const bindings = f.freeze();
  f.deliver(bindings);
  const content = new ArtifactPublicationRepository(f.database).getContent(f.artifact.contentId)!;
  const blobs = new LocalArtifactBlobStore(path.join(path.dirname(f.databasePath), "artifact-blobs"));
  blobs.append(content.storageKey, 0, Buffer.alloc(bytes.length, 0x78));
  const rejected = await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization);
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.match(rejected.body, /EXECUTION_INPUT_CONTENT_UNAVAILABLE/u);
  assert.equal(rejected.body.includes(content.storageKey), false);
  assert.equal(rejected.body.includes(f.databasePath), false);
  assert.match(String(rejected.headers["cache-control"]), /no-store/u);
});

test("a second binding insert failure rolls back the whole binding set even when the caller catches it", async (t) => {
  const f = await inputFixture(t, { twoInputs: true });
  f.database.exec(`CREATE TEMP TRIGGER fail_second_input BEFORE INSERT ON execution_input_bindings
    WHEN NEW.input_slot = 'second' BEGIN SELECT RAISE(ABORT, 'injected second binding failure'); END`);
  f.database.transaction(() => {
    assert.throws(() => f.service.freezeForRun(f.input, now), /injected second binding failure/u);
  })();
  assert.equal(f.count(), 0);
  f.database.exec("DROP TRIGGER fail_second_input");
  assert.deepEqual(f.freeze().map((entry) => entry.inputSlot), ["patch", "second"]);
});

for (const [label, mutate] of [
  ["binding contents", (manifest: GovernedExecutionManifest) => { manifest.inputs[0]!.artifact.contentDigest = "0".repeat(64); manifest.inputDigest = executionOperationDigest(manifest.inputs); }],
  ["binding destination", (manifest: GovernedExecutionManifest) => { manifest.inputs[0]!.destinationTaskId = "task_other_000001"; manifest.inputDigest = executionOperationDigest(manifest.inputs); }],
  ["node identity", (manifest: GovernedExecutionManifest) => { manifest.scope.nodeKey = "Build"; }],
  ["input digest", (manifest: GovernedExecutionManifest) => { manifest.inputDigest = "0".repeat(64); }],
  ["approval identity", (manifest: GovernedExecutionManifest) => { manifest.scope.approvalOperationId = "op_foreign_000001"; }],
  ["missing binding", (manifest: GovernedExecutionManifest) => { manifest.inputs = []; manifest.inputDigest = executionOperationDigest([]); }]
] as const) {
  test(`content read rejects a frozen manifest with substituted ${label}`, async (t) => {
    const f = await inputFixture(t);
    const bindings = f.freeze();
    f.deliver(structuredClone(bindings), mutate);
    const response = await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization);
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.body.includes(sha256), false);
  });
}

test("input access rechecks deadlines, Device identity and frozen Run scope", async (t) => {
  const f = await inputFixture(t);
  const bindings = f.freeze();
  f.deliver(bindings);
  const bindingId = bindings[0]!.bindingId;
  for (const at of [expiresAt, "2026-08-31T11:59:59.000Z", "invalid"]) {
    assert.throws(() => f.service.readForDevice(f.destination.principal, f.runId, bindingId, at), /not authorized/u);
  }
  assert.throws(() => f.service.readForDevice({ ...f.destination.principal, ownerMemberId: "member_wrong_000001" }, f.runId, bindingId, now), /not authorized/u);
  assert.throws(() => f.service.readForDevice(f.destination.principal, "run_other_000001", bindingId, now), /not authorized/u);
  f.database.prepare("UPDATE devices SET status = 'revoked' WHERE device_id = ?").run(f.destination.device.deviceId);
  assert.throws(() => f.service.readForDevice(f.destination.principal, f.runId, bindingId, now), /not authorized/u);
});

test("terminal Runs and removed Room participants lose input access while historical bindings remain", async (t) => {
  const f = await inputFixture(t);
  const bindings = f.freeze();
  f.deliver(bindings);
  f.database.prepare("DELETE FROM room_agent_participants WHERE room_id = ? AND agent_id = ?")
    .run(f.roomId, f.destination.agent.agentId);
  assert.equal((await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization)).statusCode, 403);
  f.database.prepare("INSERT INTO room_agent_participants VALUES (?, ?, ?)").run(f.roomId, f.destination.agent.agentId, now);
  new RunRepository(f.database).applyEvent(f.runId, { type: "status", sequence: 1, status: "canceled" }, now);
  assert.equal((await f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization)).statusCode, 403);
  assert.equal(f.count(), 1);
});

for (const change of ["definition", "criteria"] as const) {
  test(`paused input reads retain exact history but reject changed source ${change}`, async (t) => {
    const f = await inputFixture(t);
    const bindings = f.freeze();
    f.deliver(bindings);
    const read = () => f.request("GET", f.contentUrl(bindings[0]!.bindingId), undefined, f.destination.authorization);
    assert.equal((await read()).statusCode, 200);
    const source = await f.ok("GET", `/api/tasks/${f.tasks[0].taskId}`);
    const paused = await f.ok("POST", `/api/tasks/${source.taskId}/control`, {
      operationId: "op_input_pause_source0001", expectedTaskRevision: source.taskRevision,
      schedulingState: "paused"
    });
    assert.equal((await f.ok("GET", `/api/execution-plans/${f.plan.planId}`)).state, "paused");
    assert.equal((await read()).statusCode, 200, "scheduling pause does not revoke an unchanged in-flight input");
    assert.throws(() => f.freeze(), /EXECUTION_INPUT_PLAN_STALE/u);
    const changed = await f.ok("PUT", `/api/tasks/${source.taskId}/definition`, {
      operationId: "op_input_source_drift0001", expectedTaskRevision: paused.taskRevision,
      title: source.title, goal: change === "definition" ? "Changed accepted source goal" : source.goal,
      ownerMemberId: source.ownerMemberId, completionPolicy: source.completionPolicy,
      priority: source.priority, dueAt: source.dueAt, assignments: source.assignments,
      budgetPolicy: source.budgetPolicy,
      criteria: change === "criteria" ? source.criteria.map((criterion: { description: string }) =>
        ({ ...criterion, description: `${criterion.description} with a new requirement` })) : source.criteria
    });
    assert.equal(changed.definitionRevision, source.definitionRevision + 1);
    assert.equal(changed.criteriaRevision, source.criteriaRevision + (change === "criteria" ? 1 : 0));
    assert.equal((await read()).statusCode, 403, "historical acceptance cannot authorize changed source definitions");
    assert.equal(f.count(), 1);
    assert.deepEqual(f.inputRepository.get(bindings[0]!.bindingId)!.binding, bindings[0]);
  });
}

for (const scope of ["room", "team"] as const) {
  test(`archived ${scope} scope prevents both input admission and further content reads`, async (t) => {
    const f = await inputFixture(t);
    const bindings = f.freeze();
    f.deliver(bindings);
    if (scope === "room") {
      f.database.prepare("UPDATE rooms SET archived_at = ? WHERE room_id = ?").run(now, f.roomId);
    } else {
      f.database.prepare("UPDATE teams SET archived_at = ? WHERE team_id = ?").run(now, f.teamId);
    }
    assert.throws(() => f.freeze(), /EXECUTION_INPUT_DESTINATION_UNAVAILABLE/u);
    assert.throws(() => f.service.readForDevice(f.destination.principal, f.runId, bindings[0]!.bindingId, now), /not authorized/u);
    assert.equal(f.count(), 1, "immutable history is retained after scope revocation");
  });
}

async function prepareDerived(f: Awaited<ReturnType<typeof inputFixture>>, relations?: unknown[]) {
  const manifest = (new RunRepository(f.database).getContextManifest(f.runId) as {
    execution: GovernedExecutionManifest;
  }).execution;
  const socket = await f.app.injectWS("/ws/bridge", { headers: { authorization: f.destination.authorization, host: "127.0.0.1" } });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Derived fixture handshake timeout")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      const frame = JSON.parse(String(data));
      if (frame.type !== "run.requested" || frame.payload.runId !== f.runId) reject(new Error("Unexpected derived fixture delivery"));
      else resolve();
    });
  });
  socket.send(JSON.stringify({ protocolVersion: "1.0", messageId: "msg_derived_handshake0001", timestamp: now,
    type: "bridge.hello", payload: { deviceId: f.destination.device.deviceId, connectionEpoch: 1,
      bridgeVersion: "v0.4.0-fixture.1", supportedProtocolVersions: ["1.0"], governedExecution: capability } }));
  socket.send(JSON.stringify({ protocolVersion: "1.0", messageId: "msg_derived_agentpub0001", timestamp: now,
    type: "agent.publish", payload: {
      agentId: f.destination.agent.agentId,
      capabilities: {
        ...f.destination.agent.capabilities,
        governedExecution: capabilityForManifest(manifest),
        invocationMode: "managed"
      },
      deviceId: f.destination.device.deviceId,
      name: f.destination.agent.name,
      ownerMemberId: f.destination.agent.ownerMemberId,
      role: f.destination.agent.role,
      teamId: f.teamId,
      workspaceRef: f.destination.agent.workspaceRef,
      workspaceGeneration: f.destination.agent.workspaceGeneration
  } }));
  await ready;
  const operation: RepositoryOperationRequest = { version: 1, operationId: "op_derived_capture0001", requestDigest: "a".repeat(64),
    plan: { planId: f.plan.planId, revision: f.plan.current.revision, digest: f.plan.current.digest,
      approvalOperationId: manifest.scope.approvalOperationId, roomId: f.roomId, rootTaskId: f.root.taskId },
    execution: manifest.scope, repositoryId: manifest.repository.repositoryId, bindingId: manifest.repository.bindingId,
    deviceId: f.destination.device.deviceId, grant: manifest.grant, expectedGeneration: manifest.workspace.workspaceGeneration,
    deadline: expiresAt, action: { kind: "capture", capture: { manifestDigest: manifest.manifestDigest } } };
  const { requestDigest: _, ...unsigned } = operation;
  operation.requestDigest = executionOperationDigest(unsigned);
  const lease = await f.ok("POST", "/api/bridge/repository-captures", operation, f.destination.authorization);
  const review = Buffer.from("# Review\nA bounded review of the supplied patch.\n");
  const digest = createHash("sha256").update(review).digest("hex");
  const publication = await f.ok("POST", "/api/bridge/artifact-publications", {
    leaseId: lease.leaseId, runId: f.runId, agentId: f.destination.agent.agentId,
    workspaceRef: lease.workspaceRef, workspaceGeneration: lease.workspaceGeneration,
    idempotencyKey: "idem_derived_publication0001", artifactType: "document", fileName: "review.md",
    mediaType: "text/markdown", title: "Review", summary: "Destination-owned output", sizeBytes: review.length,
    sha256: digest, ...(relations ? { relations } : {})
  }, f.destination.authorization);
  await f.ok("POST", `/api/bridge/artifact-publications/${publication.publicationId}/chunks`, {
    offset: 0, chunkBase64: review.toString("base64"), chunkSha256: digest
  }, f.destination.authorization);
  await f.ok("POST", `/api/bridge/artifact-publications/${publication.publicationId}/seal`, {}, f.destination.authorization);
  return `/api/bridge/artifact-publications/${publication.publicationId}/bind`;
}

test("derived Artifacts atomically record supplied input bindings without copying cross-Task Result evidence", async (t) => {
  const f = await inputFixture(t, { captureOutput: true });
  const bindings = f.freeze();
  f.deliver(bindings);
  const bindUrl = await prepareDerived(f);
  const output = await f.ok("POST", bindUrl, {}, f.destination.authorization);
  assert.equal(output.artifact.taskId, f.tasks[1].taskId);
  assert.equal(output.artifact.sourceRunId, f.runId);
  assert.deepEqual(output.artifact.relations, []);
  const metadataUrl = `/api/execution-plans/${f.plan.planId}/artifacts/${output.artifact.artifactId}/inputs`;
  assert.deepEqual(await f.ok("GET", metadataUrl), bindings);
  assert.deepEqual(await f.ok("POST", bindUrl, {}, f.destination.authorization), output);
  assert.throws(() => f.database.prepare("UPDATE execution_artifact_input_sources SET recorded_at = ?").run(now), /immutable/u);
  assert.throws(() => f.database.prepare("DELETE FROM execution_artifact_input_sources").run(), /immutable/u);
  assert.throws(() => f.database.prepare("INSERT INTO execution_artifact_input_sources VALUES (?, ?, ?)")
    .run(output.artifact.artifactId, bindings[0]!.bindingId, now), /requires a new canonical/u);
  const task = await f.ok("POST", `/api/tasks/${f.tasks[1].taskId}/control`, {
    operationId: "op_input_destination_active01", lifecycleState: "active",
    expectedTaskRevision: (await f.ok("GET", `/api/tasks/${f.tasks[1].taskId}`)).taskRevision
  });
  const proposal = { operationId: "op_input_foreign_claim0001", taskId: task.taskId,
    definitionRevision: task.definitionRevision, criteriaRevision: task.criteriaRevision,
    proposedAtTaskRevision: task.taskRevision, supersedesResultId: null, outcome: "informational",
    summary: "Foreign evidence must remain forbidden", risks: [], openQuestions: [], nextActions: [], criterionClaims: [],
    sources: [{ evidenceRefId: "evidence_foreign_claim0001", kind: "artifact", artifactId: f.artifact.artifactId }] };
  const rejected = await f.request("POST", `/api/tasks/${task.taskId}/results`, proposal);
  assert.equal(rejected.statusCode, 400, rejected.body);
  const own = await f.ok("POST", `/api/tasks/${task.taskId}/results`, { ...proposal,
    sources: [{ ...proposal.sources[0], artifactId: output.artifact.artifactId }] });
  assert.equal(own.state, "proposed");
  await f.restart();
  assert.deepEqual(await f.ok("GET", metadataUrl), bindings);
});

test("provenance failure rolls back canonical Artifact creation and can safely retry the sealed publication", async (t) => {
  const f = await inputFixture(t, { captureOutput: true });
  f.deliver(f.freeze());
  const bindUrl = await prepareDerived(f);
  const artifacts = () => (f.database.prepare("SELECT count(*) AS n FROM task_artifact_refs WHERE task_id = ?")
    .get(f.tasks[1].taskId) as { n: number }).n;
  // The HTTP application has another SQLite connection. A TEMP trigger here
  // would never inject a failure into its canonical binding transaction.
  f.database.exec(`CREATE TRIGGER fail_input_provenance BEFORE INSERT ON execution_artifact_input_sources
    BEGIN SELECT RAISE(ABORT, 'injected provenance failure'); END`);
  const failed = await f.request("POST", bindUrl, {}, f.destination.authorization);
  assert.equal(failed.statusCode, 400, failed.body);
  assert.equal(artifacts(), 0);
  assert.equal(f.count(), 1);
  f.database.exec("DROP TRIGGER fail_input_provenance");
  await f.ok("POST", bindUrl, {}, f.destination.authorization);
  assert.equal(artifacts(), 1);
});

test("an input read grant does not permit legacy cross-Task Artifact relations", async (t) => {
  const f = await inputFixture(t, { captureOutput: true });
  f.deliver(f.freeze());
  const bindUrl = await prepareDerived(f, [{ type: "reviews", targetArtifactId: f.artifact.artifactId }]);
  const rejected = await f.request("POST", bindUrl, {}, f.destination.authorization);
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM task_artifact_refs WHERE task_id = ?")
    .get(f.tasks[1].taskId) as { n: number }).n, 0);
});
