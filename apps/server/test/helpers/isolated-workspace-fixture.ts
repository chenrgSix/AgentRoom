import { readFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { GovernedExecutionManifest } from "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { BridgeConnectionRegistry } from "../../src/bridge/bridge-connection-registry.js";
import { CoreRepository } from "../../src/data/core-repository.js";
import { ExecutionPlanRepository } from "../../src/execution/execution-plan-repository.js";
import { AgentService } from "../../src/registry/agent-service.js";
import { MemberDeviceService } from "../../src/registry/member-device-service.js";
import { AuthService } from "../../src/security/auth-service.js";
import { IsolatedWorkspaceLeaseService, planIsolatedWorkspace } from "../../src/workspace/isolated-workspace-lease-service.js";
import { fixture, now } from "./execution-plan-fixture.js";

export const expiresAt = "2026-08-31T12:05:00.000Z";
const wire = JSON.parse(await readFile(new URL("../../../../packages/contracts/fixtures/execution-runtime-cases.json", import.meta.url), "utf8"))
  .cases.find((entry: { name: string }) => entry.name === "execution runtime: valid governed wire delivery").instance.payload;
export const capability = { version: 1 as const, workspaceBoundary: "enforced" as const,
  preventivePathEnforcement: false, operations: ["prepare", "capture"] as const };

export async function workspaceFixture(t: TestContext, preventivePathEnforcement = false) {
  const f = await fixture(t), core = new CoreRepository(f.database), auth = new AuthService(f.database);
  const member = auth.authenticateWebSession(f.authorization.slice(7), now);
  const device = new MemberDeviceService(core, auth).registerOwnDevice(member, f.teamId, "Workspace owner", now);
  const credential = auth.issueDeviceCredential(device.deviceId, now);
  const principal = auth.authenticateDevice(credential.secret, now);
  const agent = new AgentService(core, auth).publishAgent(member, {
    teamId: f.teamId, deviceId: device.deviceId, name: "Isolated builder", role: "Builder", integrationMode: "managed",
    workspaceRef: `workspace_${"b".repeat(64)}`, workspaceGeneration: "b".repeat(64), now,
    capabilities: { supportsStart: true, supportsResume: false, supportsInterrupt: true,
      supportsHandoff: false, supportsStreaming: false, supportsWorkspaceLeases: true }
  });
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, { memberIds: [f.ownerMemberId], agentIds: [agent.agentId] });
  const command = f.command();
  for (const node of command.definition.nodes) {
    node.agentId = agent.agentId;
    node.scope.requirePreventivePathEnforcement = preventivePathEnforcement;
  }
  const draft = await f.create(command);
  const plan = (await f.ok("POST", `/api/execution-plans/${draft.planId}/approvals`, {
    operationId: "op_workspace_approval0001", expectedRevision: draft.current.revision, expectedDigest: draft.current.digest,
    expectedRootTaskRevision: command.expectedRootTaskRevision, decision: "approved", reason: "Test isolated coordination"
  })).plan;
  const compiled = plan.compiledTasks.find((node: { nodeKey: string }) => node.nodeKey === "Build");
  let task = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
  task = await f.ok("POST", `/api/tasks/${task.taskId}/control`, {
    operationId: "op_workspace_ready0001", expectedTaskRevision: task.taskRevision, lifecycleState: "ready"
  });
  const insertRun = async (runId: string) => {
    const message = (await f.ok("POST", `/api/rooms/${f.roomId}/messages`, { taskId: task.taskId, content: "Reserved attempt" })).message;
    // Future admission-state fixture only. No production scheduler or local
    // permission is supplied, and the prerequisite is restored before commit.
    f.database.transaction(() => {
      const guard = f.database.prepare("SELECT sql FROM sqlite_master WHERE name = 'execution_runs_require_governed_admission_insert'").get() as { sql: string };
      f.database.exec("DROP TRIGGER execution_runs_require_governed_admission_insert");
      f.database.prepare(`INSERT INTO runs (run_id, trace_id, room_id, task_id, trigger_message_id, requester_member_id,
        target_agent_id, parent_run_id, instruction, state, last_sequence, deadline_at, created_at, updated_at,
        terminal_at, orchestration_key, attempt_number, retry_of_run_id, context_manifest_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'Lease fixture', 'queued', 0, ?, ?, ?, NULL, NULL,
          (SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM runs WHERE task_id = ?), NULL, NULL)`)
        .run(runId, `trace_${runId}`, f.roomId, task.taskId, message.messageId, f.ownerMemberId, agent.agentId, expiresAt, now, now, task.taskId);
      f.database.exec(guard.sql);
    })();
  };
  const runId = "run_isolated_workspace0001";
  await insertRun(runId);
  task = await f.ok("GET", `/api/tasks/${task.taskId}`);
  const connections = new BridgeConnectionRegistry();
  connections.register(device.deviceId, 1, { send() {}, close() {} }, { governedExecution: capability });
  const service = new IsolatedWorkspaceLeaseService(f.database, new ExecutionPlanRepository(f.database), connections);
  const manifest = structuredClone(wire.contextManifest.execution) as GovernedExecutionManifest;
  Object.assign(manifest.scope, { planId: plan.planId, planRevision: plan.current.revision,
    planDigest: plan.current.digest, planControlRevision: plan.controlRevision, approvalOperationId: "op_workspace_approval0001",
    nodeKey: "Build", dispatchGeneration: 1, roomId: f.roomId, taskId: task.taskId,
    taskRevision: task.taskRevision, definitionRevision: task.definitionRevision, criteriaRevision: task.criteriaRevision,
    runId, deviceId: device.deviceId, agentId: agent.agentId });
  const node = plan.current.definition.nodes.find((node: { nodeKey: string }) => node.nodeKey === "Build");
  manifest.repository = node.repository;
  manifest.scopePolicy = node.scope;
  manifest.outputs = node.outputs;
  manifest.verificationProfiles = node.verificationProfiles;
  manifest.inputs = [];
  manifest.inputDigest = executionOperationDigest([]);
  manifest.deadline = expiresAt;
  manifest.grant.expiresAt = expiresAt;
  manifest.workspace = planIsolatedWorkspace(manifest.scope, manifest.repository, now, expiresAt);
  const rehash = (value: GovernedExecutionManifest) => {
    const { manifestDigest: _, ...unsigned } = value;
    value.manifestDigest = executionOperationDigest(unsigned);
    return value;
  };
  rehash(manifest);
  const freeze = (value = manifest) => {
    const context = structuredClone(wire.contextManifest);
    Object.assign(context, { runId: value.scope.runId, taskId: task.taskId, taskRevision: value.scope.taskRevision,
      definitionRevision: task.definitionRevision, criteriaRevision: task.criteriaRevision, execution: value });
    context.target.agentId = agent.agentId;
    context.target.deviceId = device.deviceId;
    f.database.prepare("UPDATE runs SET context_manifest_json = ? WHERE run_id = ?")
      .run(JSON.stringify(context), value.scope.runId);
  };
  const reserve = (value = manifest) => f.database.transaction(() => service.reserveForRun(value, now))();
  const operation = (state: ReturnType<typeof reserve>, operationId: string) => ({
    operationId, leaseId: state.lease.leaseId, expectedRevision: state.revision, expectedGeneration: state.generation
  });
  return { ...f, credential, plan, service, manifest, rehash, reserve, freeze, principal, connections, device, task, agent, insertRun, operation };
}
