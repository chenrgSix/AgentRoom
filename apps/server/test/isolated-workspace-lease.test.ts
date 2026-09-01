import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import type { GovernedExecutionManifest } from "@convene-wire/contracts/execution-plan";
import { BridgeConnectionRegistry } from "../src/bridge/bridge-connection-registry.js";
import { openDatabase } from "../src/data/database.js";
import { ExecutionPlanRepository } from "../src/execution/execution-plan-repository.js";
import { RunRepository } from "../src/run/run-repository.js";
import { IsolatedWorkspaceLeaseService, planIsolatedWorkspace } from "../src/workspace/isolated-workspace-lease-service.js";
import { now } from "./helpers/execution-plan-fixture.js";

import { workspaceFixture, expiresAt, capability } from "./helpers/isolated-workspace-fixture.js";

test("isolated leases retain immutable attempt identity and canonical manifest pins across reopen", async (t) => {
  const f = await workspaceFixture(t);
  assert.throws(() => f.service.reserveForRun(f.manifest, now), /WORKSPACE_TRANSACTION_REQUIRED/u);
  const state = f.reserve();
  assert.deepEqual(f.reserve(), state);
  assert.notEqual(state.lease.workspaceRef, f.agent.workspaceRef);
  assert.throws(() => f.service.requireActiveForDevice(f.principal, state.lease.leaseId, now), /WORKSPACE_MANIFEST_REQUIRED/u);
  f.freeze();
  assert.deepEqual(f.service.requireActiveForDevice(f.principal, state.lease.leaseId, now), state);
  const databasePath = (f.database.pragma("database_list") as Array<{ file: string }>)[0]!.file;
  const reopened = openDatabase(databasePath);
  try {
    const service = new IsolatedWorkspaceLeaseService(reopened, new ExecutionPlanRepository(reopened), f.connections);
    assert.deepEqual(service.requireActiveForDevice(f.principal, state.lease.leaseId, now), state);
  } finally { reopened.close(); }
  assert.throws(() => f.database.exec("UPDATE isolated_workspace_leases SET expires_at = issued_at"), /immutable/u);
  assert.throws(() => f.database.exec("DELETE FROM isolated_workspace_leases"), /retained/u);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("a rolled-back admission leaves no isolated workspace reservation", async (t) => {
  const f = await workspaceFixture(t);
  assert.throws(() => f.database.transaction(() => {
    f.service.reserveForRun(f.manifest, now);
    throw new Error("admission failed");
  })(), /admission failed/u);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM isolated_workspace_leases").get() as { n: number }).n, 0);
  assert.equal(f.reserve().revision, 1);
});

test("Runtime authority is a read-only exact current observation", async (t) => {
  const f = await workspaceFixture(t), state = f.reserve();
  f.freeze();
  const request = {
    version: 1 as const, runId: f.manifest.scope.runId, leaseId: state.lease.leaseId,
    manifestDigest: f.manifest.manifestDigest, workspaceRef: state.lease.workspaceRef,
    workspaceGeneration: state.lease.workspaceGeneration
  };
  assert.deepEqual(f.service.requireRuntimeAuthority(f.principal, request, now), {
    ...request, state: "active", leaseRevision: 1, checkedAt: now, expiresAt: state.lease.expiresAt
  });
  assert.deepEqual(f.service.requireRuntimeAuthority(f.principal, request, now), {
    ...request, state: "active", leaseRevision: 1, checkedAt: now, expiresAt: state.lease.expiresAt
  });
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM isolated_workspace_operations").get() as { n: number }).n, 0);

  for (const changed of [
    { ...request, runId: "run_foreign0001" },
    { ...request, leaseId: "lease_foreign0001" },
    { ...request, manifestDigest: "f".repeat(64) },
    { ...request, workspaceRef: "workspace_foreign0001" },
    { ...request, workspaceGeneration: "f".repeat(64) },
    { ...request, extra: true },
    { ...request, version: 2 }
  ]) assert.throws(() => f.service.requireRuntimeAuthority(f.principal, changed, now),
    /RUNTIME_AUTHORITY_|WORKSPACE_LEASE_UNAVAILABLE/u);

  const advanced = { ...f.operation(state, "op_runtime_authority_advance01"), generation: "c".repeat(64) };
  assert.equal(f.service.advanceForDevice(f.principal, advanced, now).revision, 2);
  assert.throws(() => f.service.requireRuntimeAuthority(f.principal, request, now), /RUNTIME_AUTHORITY_STALE/u);
});

test("Runtime authority rechecks terminal Run and Device ownership", async (t) => {
  const f = await workspaceFixture(t), state = f.reserve();
  f.freeze();
  const request = { version: 1 as const, runId: f.manifest.scope.runId, leaseId: state.lease.leaseId,
    manifestDigest: f.manifest.manifestDigest, workspaceRef: state.lease.workspaceRef,
    workspaceGeneration: state.lease.workspaceGeneration };
  assert.throws(() => f.service.requireRuntimeAuthority(
    { ...f.principal, deviceId: "device_foreign0001" }, request, now
  ), /access denied/u);
  new RunRepository(f.database).applyEvent(f.manifest.scope.runId,
    { type: "status", sequence: 1, status: "outcome_unknown" }, now);
  assert.throws(() => f.service.requireRuntimeAuthority(f.principal, request, now), /WORKSPACE_SCOPE_UNAVAILABLE/u);
});

test("workspace reservations reject changed approval, scope, grant, identity and time pins", async (t) => {
  const f = await workspaceFixture(t);
  for (const mutate of [
    (m: GovernedExecutionManifest) => { m.scope.planControlRevision++; },
    (m: GovernedExecutionManifest) => { m.scope.approvalOperationId = "op_wrong_approval0001"; },
    (m: GovernedExecutionManifest) => { m.scope.taskRevision++; },
    (m: GovernedExecutionManifest) => { m.scopePolicy.allowedPaths.push("other"); },
    (m: GovernedExecutionManifest) => { m.grant.revision++; },
    (m: GovernedExecutionManifest) => { m.workspace.workspaceRef = f.agent.workspaceRef!; },
    (m: GovernedExecutionManifest) => { m.workspace.expiresAt = "2026-08-31T12:06:00.000Z"; },
    (m: GovernedExecutionManifest) => { m.workspace.issuedAt = "2026-08-31T12:01:00.000Z"; },
    (m: GovernedExecutionManifest) => { m.grant.expiresAt = now; }
  ]) {
    const changed = structuredClone(f.manifest);
    mutate(changed);
    assert.throws(() => f.reserve(f.rehash(changed)), /WORKSPACE_/u);
  }
});

test("workspace admission requires a current capability and cannot silently use an older Bridge", async (t) => {
  const f = await workspaceFixture(t);
  f.connections.register(f.device.deviceId, 2, { send() {}, close() {} });
  assert.throws(() => f.reserve(), /WORKSPACE_CAPABILITY_UNAVAILABLE/u);
  f.connections.register(f.device.deviceId, 3, { send() {}, close() {} }, { governedExecution: { ...capability, operations: ["prepare"] } });
  assert.equal(f.connections.recordGovernedAgentCapability(
    f.device.deviceId, 3, f.agent.agentId, { ...capability, operations: ["prepare"] }
  ), true);
  assert.throws(() => f.reserve(), /WORKSPACE_CAPABILITY_UNAVAILABLE/u);
  f.connections.register(f.device.deviceId, 4, { send() {}, close() {} }, { governedExecution: capability });
  assert.throws(() => f.reserve(), /WORKSPACE_CAPABILITY_UNAVAILABLE/u,
    "new Device hello reused the prior persisted Agent capability");
  assert.equal(f.connections.recordGovernedAgentCapability(
    f.device.deviceId, 4, f.agent.agentId, capability
  ), true);
  const withoutGoverned = { ...f.agent.capabilities };
  delete withoutGoverned.governedExecution;
  f.database.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?")
    .run(JSON.stringify(withoutGoverned), f.agent.agentId);
  assert.throws(() => f.reserve(), /WORKSPACE_CAPABILITY_UNAVAILABLE/u);
  f.database.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?")
    .run(JSON.stringify({ ...f.agent.capabilities,
      governedExecution: { ...capability, operations: ["prepare"] } }), f.agent.agentId);
  assert.throws(() => f.reserve(), /WORKSPACE_CAPABILITY_UNAVAILABLE/u);
  f.database.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?")
    .run(JSON.stringify(f.agent.capabilities), f.agent.agentId);
  f.reserve();
});

test("generation operations are exact-replay CAS receipts and reject stale or reused generations", async (t) => {
  const f = await workspaceFixture(t), initial = f.reserve();
  f.freeze();
  const first = { ...f.operation(initial, "op_workspace_advance0001"), generation: "c".repeat(64) };
  const state = f.service.advanceForDevice(f.principal, first, now);
  assert.equal(state.revision, 2);
  assert.deepEqual(f.service.advanceForDevice(f.principal, first, now), state);
  assert.throws(() => f.service.advanceForDevice(f.principal, { ...first, generation: "d".repeat(64) }, now), /WORKSPACE_OPERATION_CONFLICT/u);
  assert.throws(() => f.service.advanceForDevice(f.principal, { ...first, operationId: "op_workspace_stale0001" }, now), /WORKSPACE_GENERATION_CONFLICT/u);
  const next = f.service.advanceForDevice(f.principal, { ...f.operation(state, "op_workspace_advance0002"), generation: "d".repeat(64) }, now);
  assert.deepEqual(f.service.advanceForDevice(f.principal, first, now), state, "a replay returns its receipt, not the latest operation");
  assert.throws(() => f.service.advanceForDevice(f.principal, { ...f.operation(next, "op_workspace_aba0001"), generation: "c".repeat(64) }, now), /WORKSPACE_GENERATION_CONFLICT/u);
  assert.equal(f.service.requireActiveForDevice(f.principal, initial.lease.leaseId, now).generation, "d".repeat(64));
  assert.throws(() => f.database.exec("DELETE FROM isolated_workspace_operations"), /retained/u);
  assert.throws(() => f.database.exec("UPDATE isolated_workspace_operations SET revision = revision + 1"), /immutable/u);
});

test("preventive path requirements reject a Bridge with only a workspace boundary", async (t) => {
  const f = await workspaceFixture(t, true);
  assert.throws(() => f.reserve(), /WORKSPACE_CAPABILITY_UNAVAILABLE/u);
  f.connections.register(f.device.deviceId, 2, { send() {}, close() {} }, {
    governedExecution: { ...capability, preventivePathEnforcement: true }
  });
  assert.equal(f.connections.recordGovernedAgentCapability(
    f.device.deviceId, 2, f.agent.agentId,
    { ...capability, preventivePathEnforcement: true }
  ), true);
  f.database.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?")
    .run(JSON.stringify({ ...f.agent.capabilities,
      governedExecution: { ...capability, preventivePathEnforcement: true } }), f.agent.agentId);
  f.reserve();
});

test("another Run cannot reuse a dispatch generation and receives a distinct workspace when explicitly advanced", async (t) => {
  const f = await workspaceFixture(t), first = f.reserve();
  const second = structuredClone(f.manifest);
  second.scope.runId = "run_isolated_workspace0002";
  await f.insertRun(second.scope.runId);
  second.scope.taskRevision = (await f.ok("GET", `/api/tasks/${f.task.taskId}`)).taskRevision;
  second.workspace = planIsolatedWorkspace(second.scope, second.repository, now, expiresAt);
  assert.throws(() => f.reserve(f.rehash(second)), /WORKSPACE_ATTEMPT_IDENTITY_CONFLICT/u);
  second.scope.dispatchGeneration++;
  second.workspace = planIsolatedWorkspace(second.scope, second.repository, now, expiresAt);
  const reserved = f.reserve(f.rehash(second));
  assert.notEqual(reserved.lease.leaseId, first.lease.leaseId);
  assert.notEqual(reserved.lease.workspaceRef, first.lease.workspaceRef);
  assert.notEqual(reserved.lease.workspaceGeneration, first.lease.workspaceGeneration);
});

for (const mutation of ["room", "team", "participant", "task"] as const) {
  test(`current ${mutation} authorization is rechecked before workspace use`, async (t) => {
    const f = await workspaceFixture(t), state = f.reserve();
    f.freeze();
    if (mutation === "room") f.database.prepare("UPDATE rooms SET archived_at = ? WHERE room_id = ?").run(now, f.roomId);
    if (mutation === "team") f.database.prepare("UPDATE teams SET archived_at = ? WHERE team_id = ?").run(now, f.teamId);
    if (mutation === "participant") f.database.prepare("DELETE FROM room_agent_participants WHERE room_id = ? AND agent_id = ?").run(f.roomId, f.agent.agentId);
    if (mutation === "task") {
      const current = await f.ok("GET", `/api/tasks/${f.task.taskId}`);
      await f.ok("PUT", `/api/tasks/${f.task.taskId}/definition`, { ...current,
        operationId: "op_workspace_changed_goal01", expectedTaskRevision: current.taskRevision,
        goal: "A changed goal must not inherit old execution authority",
        assignments: current.assignments.map(({ agentId, role }: { agentId: string; role: string }) => ({ agentId, role }))
      });
    }
    assert.throws(() => f.service.requireActiveForDevice(f.principal, state.lease.leaseId, now), /WORKSPACE_SCOPE_UNAVAILABLE/u);
  });
}

test("overlapping processes advance one lease generation at most once", { timeout: 15_000 }, async (t) => {
  const children: ChildProcess[] = [];
  // Child shutdown is registered before fixture deletion, including failure cuts.
  t.after(async () => {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    }));
  });
  const f = await workspaceFixture(t), state = f.reserve();
  f.freeze();
  const databasePath = (f.database.pragma("database_list") as Array<{ file: string }>)[0]!.file;
  const code = `
    import { openDatabase } from ${JSON.stringify(new URL("../src/data/database.ts", import.meta.url).href)};
    import { ExecutionPlanRepository } from ${JSON.stringify(new URL("../src/execution/execution-plan-repository.ts", import.meta.url).href)};
    import { BridgeConnectionRegistry } from ${JSON.stringify(new URL("../src/bridge/bridge-connection-registry.ts", import.meta.url).href)};
    import { IsolatedWorkspaceLeaseService } from ${JSON.stringify(new URL("../src/workspace/isolated-workspace-lease-service.ts", import.meta.url).href)};
    process.send({ ready: true });
    process.once("message", ({ databasePath, principal, capability, agentId, command, now }) => {
      const database = openDatabase(databasePath), connections = new BridgeConnectionRegistry();
      connections.register(principal.deviceId, 1, { send() {}, close() {} }, { governedExecution: capability });
      connections.recordGovernedAgentCapability(principal.deviceId, 1, agentId, capability);
      try {
        const state = new IsolatedWorkspaceLeaseService(database, new ExecutionPlanRepository(database), connections)
          .advanceForDevice(principal, command, now);
        process.send({ state });
      } catch (error) { process.send({ error: error.message }); }
      finally { database.close(); process.disconnect(); }
    });
  `;
  const ready = ["c", "d"].map((generation, index) => new Promise<{
    child: ChildProcess; result: Promise<any>; command: ReturnType<typeof f.operation> & { generation: string }
  }>((resolve, reject) => {
    const command = { ...f.operation(state, `op_workspace_race000${index}`), generation: generation.repeat(64) };
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    const result = new Promise<any>((resolveResult, rejectResult) => {
      let value: any;
      child.on("message", (message: any) => {
        if (message.ready) resolve({ child, result, command });
        else value = message;
      });
      child.once("close", (exitCode) => {
        if (exitCode !== 0 || !value) {
          const error = new Error(`Workspace worker failed: ${exitCode} ${stderr}`);
          reject(error);
          rejectResult(error);
        } else resolveResult(value);
      });
    });
    result.catch(() => {});
  }));
  const workers = await Promise.all(ready);
  for (const { child, command } of workers) child.send!({
    databasePath, principal: f.principal, capability, agentId: f.agent.agentId, command, now
  });
  const results = await Promise.all(workers.map((worker) => worker.result));
  assert.equal(results.filter((result) => result.state?.revision === 2).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.error === "WORKSPACE_GENERATION_CONFLICT").length, 1, JSON.stringify(results));
});

for (const kind of ["revoke", "release"] as const) {
  test(`${kind} is irreversible and does not report that the local writer stopped`, async (t) => {
    const f = await workspaceFixture(t), state = f.reserve();
    f.freeze();
    const command = f.operation(state, `op_workspace_${kind}0001`);
    const closed = f.service.closeForDevice(f.principal, command, kind, now);
    assert.equal(closed.state, kind === "revoke" ? "revoked" : "released");
    assert.deepEqual(f.service.closeForDevice(f.principal, command, kind, now), closed);
    assert.throws(() => f.service.requireActiveForDevice(f.principal, state.lease.leaseId, now), /WORKSPACE_LEASE_INACTIVE/u);
    assert.throws(() => f.reserve(), /WORKSPACE_LEASE_INACTIVE/u);
    assert.equal(new RunRepository(f.database).getRun(f.manifest.scope.runId)!.state, "queued");
  });
}

test("expired, terminal, revoked and foreign scopes cannot use an isolated lease", async (t) => {
  const f = await workspaceFixture(t), state = f.reserve();
  f.freeze();
  assert.throws(() => f.service.requireActiveForDevice(f.principal, state.lease.leaseId, expiresAt), /WORKSPACE_LEASE_EXPIRED/u);
  assert.throws(() => f.service.requireActiveForDevice({ ...f.principal, deviceId: "device_foreign0001" }, state.lease.leaseId, now), /access denied/u);
  new RunRepository(f.database).applyEvent(f.manifest.scope.runId, { type: "status", sequence: 1, status: "outcome_unknown" }, now);
  assert.throws(() => f.service.requireActiveForDevice(f.principal, state.lease.leaseId, now), /WORKSPACE_SCOPE_UNAVAILABLE/u);
  // Closing coordination never acknowledges an unknown Run or authorizes deleting its worktree.
  f.service.closeForDevice(f.principal, f.operation(state, "op_workspace_unknown0001"), "revoke", now);
  assert.equal(new RunRepository(f.database).getRun(f.manifest.scope.runId)!.state, "outcome_unknown");
  f.database.prepare("UPDATE devices SET status = 'revoked' WHERE device_id = ?").run(f.device.deviceId);
  assert.throws(() => f.service.requireActiveForDevice(f.principal, state.lease.leaseId, now), /access denied/u);
});
