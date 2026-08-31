import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { FastifyInstance, HTTPMethods } from "fastify";
import type {
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanProposalCommand
} from "@convene-wire/contracts/execution-plan";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { createServerApp } from "../src/app.js";
import { openDatabase } from "../src/data/database.js";
import { RunRepository } from "../src/run/run-repository.js";

const now = "2026-08-31T12:00:00.000Z";
const fixtures = JSON.parse(await readFile(new URL(
  "../../../packages/contracts/fixtures/execution-plan-cases.json", import.meta.url
), "utf8"));
const template = fixtures.cases.find((entry: { name: string }) =>
  entry.name === "execution: valid full plan").instance as ExecutionPlanDefinition;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-execution-history-"));
  let app: FastifyInstance | undefined;
  const connections: ReturnType<typeof openDatabase>[] = [];
  // Register ownership cleanup before migrations or bootstrap can fail.
  t.after(async () => {
    try {
      await app?.close();
    } finally {
      for (const connection of connections) if (connection.open) connection.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  const databasePath = path.join(directory, "server.sqlite");
  app = await createServerApp({ databasePath, clock: () => now, logger: false });
  let authorization = "";
  const request = (
    method: HTTPMethods, url: string, payload?: unknown, token = authorization
  ) => app!.inject({
    method, url, headers: { authorization: token },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> })
  });
  const ok = async (method: HTTPMethods, url: string, payload?: unknown, token?: string) => {
    const response = await request(method, url, payload, token);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const bootstrap = await ok("POST", "/api/bootstrap", {
    userId: "user_execution_owner0001", displayName: "Owner"
  });
  authorization = `Bearer ${bootstrap.session.token}`;
  const team = await ok("POST", "/api/teams", { name: "Execution" });
  const teamId = team.team.teamId as string;
  const ownerMemberId = team.owner.memberId as string;
  const room = await ok("POST", `/api/teams/${teamId}/rooms`, { name: "plans" });
  const roomId = room.roomId as string;
  const createdAgent = await ok("POST", `/api/teams/${teamId}/manual-agents`, {
    name: "Builder", role: "Builder"
  });
  const agentId = createdAgent.agent.agentId as string;
  await ok("PUT", `/api/rooms/${roomId}/participants`, {
    memberIds: [ownerMemberId], agentIds: [agentId]
  });
  const root = await ok("POST", `/api/rooms/${roomId}/tasks`, {
    title: "Ship a scoped change", goal: "Preserve authority and history"
  });
  const message = (await ok("POST", `/api/rooms/${roomId}/messages`, {
    taskId: root.taskId, content: "Use the existing work model."
  })).message;
  const definition = structuredClone(template);
  definition.rootTaskId = root.taskId;
  definition.decision.sources = [{
    evidenceRefId: "evidence_original0001", kind: "message", messageId: message.messageId
  }];
  definition.decision.sourceRevisions = [{
    evidenceRefId: "evidence_original0001", revision: message.sequence
  }];
  for (const node of definition.nodes) {
    node.agentId = agentId;
    node.task.ownerMemberId = ownerMemberId;
  }
  // Message bookkeeping can advance other fields; use the current authoritative pin.
  const currentRoot = await ok("GET", `/api/tasks/${root.taskId}`);
  const command = (): ExecutionPlanProposalCommand => ({
    operationId: "op_execution_create0001",
    expectedRootTaskRevision: currentRoot.taskRevision,
    definition: structuredClone(definition)
  });
  const create = async (value = command()) => await ok(
    "POST", `/api/tasks/${root.taskId}/execution-plans`, value
  ) as ExecutionPlanProjection;
  const database = openDatabase(databasePath);
  connections.push(database);
  const counts = () => Object.fromEntries([
    "execution_plans", "execution_decisions", "execution_plan_proposals",
    "execution_plan_revisions", "execution_decision_sources", "execution_plan_operations",
    "agent_tasks", "runs"
  ].map((table) => [table, (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n]));
  return {
    request, ok, create, command, database, counts, root: currentRoot, roomId,
    teamId, ownerMemberId, agentId, message, authorization,
    async restart() {
      await app!.close();
      app = undefined;
      app = await createServerApp({ databasePath, clock: () => now, logger: false });
    },
    async restartTrusted() {
      await app!.close();
      app = undefined;
      app = await createServerApp({ databasePath, clock: () => now, logger: false, webAuth: {
        mode: "trusted-team", publicOrigin: "https://central.example",
        ownerRecoveryToken: "execution-test-recovery-" + "r".repeat(32)
      } });
      return app;
    },
    async participant() {
      const bootstrap = await ok("POST", "/api/bootstrap", {
        userId: "user_execution_member0001", displayName: "Member"
      });
      const member = await ok("POST", `/api/teams/${teamId}/members`, {
        userId: "user_execution_member0001", displayName: "Member"
      });
      await ok("PUT", `/api/rooms/${roomId}/participants`, {
        memberIds: [ownerMemberId, member.memberId], agentIds: [agentId]
      });
      return { memberId: member.memberId, authorization: `Bearer ${bootstrap.session.token}` };
    }
  };
}

test("execution drafts freeze attributed decisions and append history without Tasks or Runs", async (t) => {
  const f = await fixture(t);
  const before = f.counts();
  const first = await f.create();
  assert.equal(first.state, "draft");
  assert.equal(first.controlRevision, 1);
  assert.equal(first.current.revision, 1);
  assert.deepEqual(first.current.author, { kind: "member", memberId: f.ownerMemberId });
  assert.deepEqual(first.compiledTasks, []);
  const decision = await f.ok("GET", `/api/execution-decisions/${first.current.decisionId}`);
  assert.equal(decision.supersedesDecisionId, null);
  assert.deepEqual(decision.content, first.current.definition.decision);
  const sources = await f.ok("GET", `/api/execution-decisions/${decision.decisionId}/sources`);
  const sourceSnapshot = JSON.parse(sources[0].snapshotJson);
  assert.equal(sourceSnapshot.content, f.message.content);
  assert.equal(sourceSnapshot.revision, f.message.sequence);
  assert.equal(sources[0].digest, executionOperationDigest(sourceSnapshot));
  const revised = f.command();
  revised.operationId = "op_execution_revise0001";
  revised.definition.title = "A clarified plan";
  const second = await f.ok("POST", `/api/execution-plans/${first.planId}/revisions`, {
    ...revised, expectedRevision: 1
  });
  assert.equal(second.current.revision, 2);
  assert.notEqual(second.current.digest, first.current.digest);
  assert.equal(second.controlRevision, 1);
  const nextDecision = await f.ok("GET", `/api/execution-decisions/${second.current.decisionId}`);
  assert.equal(nextDecision.supersedesDecisionId, first.current.decisionId);
  const history = await f.ok("GET", `/api/execution-plans/${first.planId}/revisions`);
  assert.deepEqual(history.revisions, [first.current, second.current]);
  assert.equal(history.nextAfterRevision, null);
  const after = f.counts();
  assert.equal(after.agent_tasks, before.agent_tasks);
  assert.equal(after.runs, before.runs);
  assert.equal(after.execution_plans, 1);
  assert.equal(after.execution_decisions, 2);
  assert.equal(after.execution_plan_operations, 2);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("execution response-loss retries return the original receipt across revisions and reopen", async (t) => {
  const f = await fixture(t);
  const command = f.command();
  const first = await f.create(command);
  const reordered = structuredClone(command);
  reordered.definition.nodes.reverse();
  assert.deepEqual(await f.create(reordered), first);
  const revision = { ...f.command(), operationId: "op_revision_reopen0001", expectedRevision: 1 };
  revision.definition.title = "Revised";
  const second = await f.ok("POST", `/api/execution-plans/${first.planId}/revisions`, revision);
  await f.restart();
  assert.deepEqual(await f.ok("GET", `/api/execution-plans/${first.planId}`), second);
  assert.deepEqual(await f.create(command), first);
  assert.deepEqual(await f.ok("POST", `/api/execution-plans/${first.planId}/revisions`, revision), second);
  const changed = { ...command, definition: { ...command.definition, title: "Changed retry" } };
  const response = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, changed);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "EXECUTION_OPERATION_CONFLICT");
  assert.equal(f.counts().execution_plan_revisions, 2);
});

test("execution revision races have one winner and root pins reject stale mutations", async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  const responses = await Promise.all(["a", "b"].map((suffix) => f.request(
    "POST", `/api/execution-plans/${first.planId}/revisions`, {
      ...f.command(), operationId: `op_revision_race000${suffix}`, expectedRevision: 1
    }
  )));
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  const stale = f.command();
  stale.operationId = "op_root_stale000001";
  stale.expectedRootTaskRevision += 1;
  const response = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, stale);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "EXECUTION_ROOT_REVISION_CONFLICT");
  assert.equal(f.counts().execution_decisions, 2);
});

test("execution checks current human authority before mutation and idempotent reads", async (t) => {
  const f = await fixture(t);
  const other = await f.participant();
  const first = await f.create();
  const url = `/api/tasks/${f.root.taskId}/execution-plans`;
  const unauthorized = await f.request("POST", url, f.command(), other.authorization);
  assert.equal(unauthorized.statusCode, 403);
  assert.equal((await f.request("POST", url, f.command(), "")).statusCode, 401);
  assert.equal((await f.request("GET", `/api/execution-plans/${first.planId}`, undefined, other.authorization)).statusCode, 200);
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, {
    memberIds: [f.ownerMemberId], agentIds: [f.agentId]
  });
  for (const endpoint of [
    `/api/execution-plans/${first.planId}`,
    `/api/execution-plans/${first.planId}/revisions`,
    `/api/execution-decisions/${first.current.decisionId}`,
    `/api/execution-decisions/${first.current.decisionId}/sources`,
    `/api/rooms/${f.roomId}/execution-plans`
  ]) {
    const response = await f.request("GET", endpoint, undefined, other.authorization);
    assert.equal(response.statusCode, 403, endpoint);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.body.includes(first.current.definition.title), false);
  }
  f.database.prepare("UPDATE teams SET archived_at = ? WHERE team_id = ?").run(now, f.teamId);
  assert.equal((await f.request("POST", url, f.command())).statusCode, 403);
});

test("execution operation IDs bind actor and target even with identical content", async (t) => {
  const f = await fixture(t);
  const other = await f.participant();
  const first = await f.create();
  f.database.prepare("UPDATE team_members SET role = 'owner' WHERE member_id = ?").run(other.memberId);
  const collision = await f.request(
    "POST", `/api/tasks/${f.root.taskId}/execution-plans`, f.command(), other.authorization
  );
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.json().error.code, "EXECUTION_OPERATION_CONFLICT");
  const second = await f.create({ ...f.command(), operationId: "op_second_plan00001" });
  const revision = { ...f.command(), operationId: "op_shared_revision001", expectedRevision: 1 };
  await f.ok("POST", `/api/execution-plans/${first.planId}/revisions`, revision);
  const targetCollision = await f.request("POST", `/api/execution-plans/${second.planId}/revisions`, revision);
  assert.equal(targetCollision.statusCode, 409);
  assert.equal(f.counts().execution_plan_revisions, 3);
});

test("execution rejects foreign, missing and stale source references without partial persistence", async (t) => {
  const f = await fixture(t);
  const foreignRoom = await f.ok("POST", `/api/teams/${f.teamId}/rooms`, { name: "other" });
  const message = (await f.ok("POST", `/api/rooms/${foreignRoom.roomId}/messages`, {
    content: "Private unrelated context"
  })).message;
  for (const [messageId, revision, expectedStatus] of [
    [message.messageId, message.sequence, 400],
    ["msg_missing000001", 1, 400],
    [f.message.messageId, f.message.sequence + 1, 409]
  ] as const) {
    const command = f.command();
    command.definition.decision.sources[0] = {
      evidenceRefId: "evidence_original0001", kind: "message", messageId
    };
    command.definition.decision.sourceRevisions[0]!.revision = revision;
    const response = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, command);
    assert.equal(response.statusCode, expectedStatus, response.body);
    assert.equal(response.body.includes("Private unrelated"), false);
  }
  assert.equal(f.counts().execution_plans, 0);
  assert.equal(f.counts().execution_decisions, 0);
});

test("execution freezes mutable Memory lifecycle and rejects a fresh stale-source operation", async (t) => {
  const f = await fixture(t);
  const memory = await f.ok("POST", `/api/tasks/${f.root.taskId}/memory-entries`, {
    type: "decision", content: "A bounded durable decision", sourceMessageIds: [f.message.messageId]
  });
  const command = f.command();
  command.definition.decision.sources = [{
    evidenceRefId: "evidence_memory0001", kind: "memory", memoryId: memory.memoryId
  }];
  command.definition.decision.sourceRevisions = [{
    evidenceRefId: "evidence_memory0001", revision: memory.revision
  }];
  const plan = await f.create(command);
  const sourceUrl = `/api/execution-decisions/${plan.current.decisionId}/sources`;
  const frozen = await f.ok("GET", sourceUrl);
  await f.ok("POST", `/api/memory-entries/${memory.memoryId}/retract`);
  assert.deepEqual(await f.create(command), plan);
  assert.deepEqual(await f.ok("GET", sourceUrl), frozen);
  assert.equal(JSON.parse(frozen[0].snapshotJson).state, "active");
  const response = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, {
    ...command, operationId: "op_memory_stale0001"
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "EXECUTION_SOURCE_REVISION_CONFLICT");
});

test("execution never treats an invented local grant or a malformed draft as authority", async (t) => {
  const f = await fixture(t);
  const mutations: Array<(command: any) => void> = [
    (c) => { c.author = { kind: "member", memberId: f.ownerMemberId }; },
    (c) => { c.definition.nodes[0].agentId = "agent_unknown0001"; },
    (c) => { c.definition.nodes[0].task.ownerMemberId = "member_unknown0001"; },
    (c) => { c.definition.nodes[0].scope.allowedPaths = ["../private"]; },
    (c) => { c.definition.edges[0].toNodeKey = c.definition.edges[0].fromNodeKey; },
    (c) => { c.definition.rootTaskId = "task_foreign0001"; }
  ];
  for (const mutate of mutations) {
    const command = f.command();
    mutate(command);
    const response = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, command);
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(f.counts().execution_decisions, 0);
  const plan = await f.create();
  assert.equal(plan.state, "draft");
  for (const endpoint of ["approve", "dispatch", "control"]) {
    assert.equal((await f.request("POST", `/api/execution-plans/${plan.planId}/${endpoint}`, {})).statusCode, 404);
  }
  assert.equal(f.counts().runs, 0);
});

test("execution rejects default and nested roots and stale or foreign existing Tasks", async (t) => {
  const f = await fixture(t);
  const tasks = await f.ok("GET", `/api/rooms/${f.roomId}/tasks`);
  const defaultTask = tasks.find((task: { isDefault: boolean }) => task.isDefault);
  const child = await f.ok("POST", `/api/rooms/${f.roomId}/tasks`, {
    parentTaskId: f.root.taskId, title: "Nested", goal: "Cannot be the root"
  });
  for (const root of [defaultTask, child]) {
    const command = f.command();
    command.definition.rootTaskId = root.taskId;
    command.expectedRootTaskRevision = root.taskRevision;
    const response = await f.request("POST", `/api/tasks/${root.taskId}/execution-plans`, command);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, "EXECUTION_ROOT_UNAVAILABLE");
  }
  const node = f.command().definition.nodes[0]!;
  const existing = await f.ok("POST", `/api/rooms/${f.roomId}/tasks`, {
    title: "Canonical node", goal: "Use an existing Task", completionPolicy: "accepted_result_required",
    criteria: node.task.criteria, assignments: [{ agentId: f.agentId, role: "primary" }]
  });
  const command = f.command();
  command.definition.nodes[0]!.task = {
    mode: "existing", taskId: existing.taskId, expectedTaskRevision: existing.taskRevision,
    definitionRevision: existing.definitionRevision, criteriaRevision: existing.criteriaRevision
  };
  await f.create(command);
  command.operationId = "op_stale_node00001";
  command.definition.nodes[0]!.task.expectedTaskRevision! += 1;
  const response = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, command);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "EXECUTION_NODE_REVISION_CONFLICT");
});

test("execution SQLite failures roll back the complete aggregate and do not expose diagnostics", async (t) => {
  const f = await fixture(t);
  const before = f.counts();
  f.database.exec(`CREATE TRIGGER execution_test_cut BEFORE INSERT ON execution_plan_revisions
    BEGIN SELECT RAISE(ABORT, 'simulated failure /private/owner-secret'); END;`);
  const response = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, f.command());
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "EXECUTION_REQUEST_FAILED");
  assert.equal(response.body.includes("owner-secret"), false);
  assert.deepEqual(f.counts(), before);
  f.database.exec("DROP TRIGGER execution_test_cut");
  await f.create();
  assert.equal(f.counts().execution_plan_operations, 1);
});

test("execution decision, proposal, revision and operation history rejects SQL rewriting", async (t) => {
  const f = await fixture(t);
  await f.create();
  for (const [table, field] of [
    ["execution_decisions", "content_json"],
    ["execution_decision_sources", "snapshot_json"],
    ["execution_plan_proposals", "definition_json"],
    ["execution_plan_revisions", "revision"],
    ["execution_plan_operations", "response_json"]
  ]) {
    assert.throws(() => f.database.exec(`UPDATE ${table} SET ${field} = ${field}`), /immutable/u);
    assert.throws(() => f.database.exec(`DELETE FROM ${table}`), /immutable/u);
  }
  assert.throws(() => f.database.exec("UPDATE execution_plans SET current_revision = 3"), /advance exactly once/u);
  assert.throws(() => f.database.exec("UPDATE execution_plans SET root_task_id = 'task_missing0001'"), /immutable/u);
  assert.throws(() => f.database.exec(`INSERT INTO execution_decision_sources
    SELECT decision_id, 'evidence_extra0001', source_json, source_revision, snapshot_json, snapshot_digest
    FROM execution_decision_sources`), /sealed/u);
});

test("execution freezes real Artifact, Result, Discussion and exact Run-event source identities", async (t) => {
  const f = await fixture(t);
  await f.ok("PUT", `/api/tasks/${f.root.taskId}/definition`, {
    operationId: "op_source_definition001", expectedTaskRevision: f.root.taskRevision,
    title: f.root.title, goal: f.root.goal, ownerMemberId: f.ownerMemberId,
    completionPolicy: "owner_confirmed", priority: "normal", dueAt: null,
    criteria: [], assignments: [{ agentId: f.agentId, role: "primary" }],
    budgetPolicy: f.root.budgetPolicy
  });
  await f.ok("POST", `/api/tasks/${f.root.taskId}/control`, {
    operationId: "op_source_activate0001", expectedTaskRevision: 2, lifecycleState: "active"
  });
  const routed = await f.ok("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: f.root.taskId, content: "Create immutable event evidence", mentionAgentId: f.agentId
  });
  const runId = routed.runs[0].runId;
  const runs = new RunRepository(f.database);
  runs.applyEvent(runId, { type: "status", sequence: 1, status: "working" }, now);
  runs.applyReply(runId, { type: "reply", sequence: 2, content: "Source evidence" }, now);
  runs.applyEvent(runId, { type: "status", sequence: 3, status: "completed" }, now);
  const artifact = (await f.ok("POST", `/api/tasks/${f.root.taskId}/artifacts`, {
    type: "document", title: "Evidence", summary: "Frozen description", path: "private/owner-path"
  })).artifact;
  const task = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
  const result = await f.ok("POST", `/api/tasks/${f.root.taskId}/results`, {
    operationId: "op_source_result00001", taskId: task.taskId,
    definitionRevision: task.definitionRevision, criteriaRevision: task.criteriaRevision,
    proposedAtTaskRevision: task.taskRevision, supersedesResultId: null,
    outcome: "informational", summary: "An immutable proposal, not acceptance",
    risks: [], openQuestions: [], nextActions: [], criterionClaims: [],
    sources: [{ evidenceRefId: "evidence_resultartifact01", kind: "artifact", artifactId: artifact.artifactId }]
  });
  const secondAgent = await f.ok("POST", `/api/teams/${f.teamId}/manual-agents`, {
    name: "Reviewer", role: "Reviewer"
  });
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, {
    memberIds: [f.ownerMemberId], agentIds: [f.agentId, secondAgent.agent.agentId]
  });
  const discussion = (await f.ok("POST", `/api/rooms/${f.roomId}/discussions`, {
    // Room-level deliberation may inform this root without a cross-Task Run grant.
    goal: "Review source identity",
    participantAgentIds: [f.agentId, secondAgent.agent.agentId]
  })).discussion;
  const root = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
  const command = f.command();
  command.expectedRootTaskRevision = root.taskRevision;
  command.definition.decision.sources = [
    { evidenceRefId: "evidence_artifact0001", kind: "artifact", artifactId: artifact.artifactId },
    { evidenceRefId: "evidence_result000001", kind: "result", resultId: result.resultId },
    { evidenceRefId: "evidence_discussion01", kind: "discussion", discussionId: discussion.discussionId },
    { evidenceRefId: "evidence_runevent0001", kind: "run_event", runId, sequence: 2 }
  ];
  command.definition.decision.sourceRevisions = [
    { evidenceRefId: "evidence_artifact0001", revision: artifact.artifactRevision },
    { evidenceRefId: "evidence_result000001", revision: result.resultVersion },
    { evidenceRefId: "evidence_discussion01", revision: discussion.version },
    { evidenceRefId: "evidence_runevent0001", revision: 2 }
  ];
  const plan = await f.create(command);
  const sources = await f.ok("GET", `/api/execution-decisions/${plan.current.decisionId}/sources`);
  assert.equal(sources.length, 4);
  assert.equal(JSON.stringify(sources).includes("owner-path"), false);
  const snapshot = (kind: string) => JSON.parse(sources.find(
    (s: { source: { kind: string } }) => s.source.kind === kind
  ).snapshotJson);
  assert.equal(snapshot("run_event").content, "Source evidence");
  assert.equal(snapshot("run_event").revision, 2);
  assert.equal(snapshot("artifact").summary, artifact.summary);
  assert.equal(snapshot("result").summary, result.proposal.summary);
  assert.equal("state" in snapshot("result"), false);
  assert.equal("review" in snapshot("result"), false);
  assert.equal(snapshot("discussion").goal, discussion.goal);
  command.operationId = "op_missing_event0001";
  command.definition.decision.sources[3]!.sequence = 999;
  command.definition.decision.sourceRevisions[3]!.revision = 999;
  const missing = await f.request("POST", `/api/tasks/${root.taskId}/execution-plans`, command);
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.code, "EXECUTION_SOURCE_UNAVAILABLE");
});

test("execution history/list pagination and no-store errors remain bounded and unambiguous", async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  await f.create({ ...f.command(), operationId: "op_page_plan000001" });
  await f.ok("POST", `/api/execution-plans/${first.planId}/revisions`, {
    ...f.command(), expectedRevision: 1, operationId: "op_page_revision0001"
  });
  const page = await f.ok("GET", `/api/rooms/${f.roomId}/execution-plans?limit=1`);
  const next = await f.ok("GET", `/api/rooms/${f.roomId}/execution-plans?limit=1&afterPlanId=${page.nextAfterPlanId}`);
  assert.equal(page.plans.length, 1);
  assert.equal(next.plans.length, 1);
  assert.notEqual(page.plans[0].planId, next.plans[0].planId);
  assert.equal(next.nextAfterPlanId, null);
  const revisions = await f.ok("GET", `/api/execution-plans/${first.planId}/revisions?limit=1`);
  assert.equal(revisions.nextAfterRevision, 1);
  const last = await f.ok("GET", `/api/execution-plans/${first.planId}/revisions?afterRevision=1`);
  assert.equal(last.revisions[0].revision, 2);
  for (const query of ["limit=51", "limit=-1", "limit=1.5", "afterRevision=NaN", "afterRevision=1x"]) {
    const response = await f.request("GET", `/api/execution-plans/${first.planId}/revisions?${query}`);
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("execution trusted mutations require the exact Web Origin before replaying receipts", async (t) => {
  const f = await fixture(t);
  const plan = await f.create();
  const app = await f.restartTrusted();
  const cookie = `__Host-agentroom_session=${f.authorization.slice("Bearer ".length)}`;
  for (const origin of [undefined, "https://foreign.example"]) {
    const response = await app.inject({
      method: "POST", url: `/api/tasks/${f.root.taskId}/execution-plans`,
      headers: { cookie, ...(origin ? { origin } : {}) }, payload: f.command()
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers["cache-control"], "no-store");
  }
  const replay = await app.inject({
    method: "POST", url: `/api/tasks/${f.root.taskId}/execution-plans`,
    headers: { cookie, origin: "https://central.example" }, payload: f.command()
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.deepEqual(replay.json(), plan);
  assert.equal(f.counts().execution_plan_operations, 1);
});

test("execution external input declarations cannot authorize nonexistent snapshot delivery", async (t) => {
  const f = await fixture(t);
  const command = f.command();
  const node = command.definition.nodes[0]!;
  node.inputs.push({ slotKey: "outside", kind: "document", required: false });
  command.definition.externalInputs = [{
    nodeKey: node.nodeKey, inputSlot: "outside", sourceTaskId: "task_external0001",
    sourceResultId: "result_external0001", artifactId: "artifact_external0001",
    artifactRevision: 1, contentDigest: "a".repeat(64), kind: "document"
  }];
  const response = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, command);
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "EXECUTION_EXTERNAL_INPUT_UNAVAILABLE");
  assert.equal(f.counts().execution_decisions, 0);
});

test("execution change notifications follow commits, not HTTP retries or rolled-back writes", async (t) => {
  const f = await fixture(t);
  const cursor = async () => (await f.ok("GET", `/api/teams/${f.teamId}/changes?after=0`)).cursor as number;
  const before = await cursor();
  const plan = await f.create();
  assert.equal(await cursor(), before + 1);
  await f.create();
  assert.equal(await cursor(), before + 1);
  const revision = { ...f.command(), operationId: "op_notify_revision001", expectedRevision: 1 };
  await f.ok("POST", `/api/execution-plans/${plan.planId}/revisions`, revision);
  assert.equal(await cursor(), before + 2);
  await f.ok("POST", `/api/execution-plans/${plan.planId}/revisions`, revision);
  assert.equal(await cursor(), before + 2);
  f.database.exec(`CREATE TRIGGER execution_test_notify_cut BEFORE INSERT ON execution_plan_operations
    BEGIN SELECT RAISE(ABORT, 'simulated receipt failure'); END;`);
  const failed = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, {
    ...f.command(), operationId: "op_notify_rollback001"
  });
  assert.equal(failed.statusCode, 400);
  assert.equal(await cursor(), before + 2);
});
