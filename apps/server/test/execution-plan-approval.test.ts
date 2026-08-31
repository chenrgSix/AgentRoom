import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionPlanApprovalCommand, ExecutionPlanProjection } from "@convene-wire/contracts/execution-plan";
import { fixture, now } from "./helpers/execution-plan-fixture.js";
import { RunRepository } from "../src/run/run-repository.js";
import { executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import { CoreRepository } from "../src/data/core-repository.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";
import { HandoffService } from "../src/run/handoff-service.js";

function approval(plan: ExecutionPlanProjection, taskRevision: number, operationId = "op_plan_approval0001"): ExecutionPlanApprovalCommand {
  return { operationId, expectedRevision: plan.current.revision, expectedDigest: plan.current.digest,
    expectedRootTaskRevision: taskRevision, decision: "approved", reason: "Approve this exact bounded plan" };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function existingTask(f: Fixture, options: Record<string, unknown> = {}) {
  const node = f.command().definition.nodes[0]!;
  return f.ok("POST", `/api/rooms/${f.roomId}/tasks`, {
    title: node.task.title, goal: node.task.goal, ownerMemberId: f.ownerMemberId,
    completionPolicy: "accepted_result_required", criteria: node.task.criteria,
    lifecycleState: "ready", assignments: [{ agentId: f.agentId, role: "primary" }],
    budgetPolicy: node.budget, ...options
  });
}

function linkTask(f: Fixture, task: any) {
  const command = f.command();
  command.definition.nodes[0]!.task = {
    mode: "existing", taskId: task.taskId, expectedTaskRevision: task.taskRevision,
    definitionRevision: task.definitionRevision, criteriaRevision: task.criteriaRevision
  };
  return command;
}

async function propose(f: Fixture, taskId: string, nextActions: unknown[] = []) {
  const task = await f.ok("GET", `/api/tasks/${taskId}`);
  const message = (await f.ok("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId, content: "Attributed planning evidence"
  })).message;
  return f.ok("POST", `/api/tasks/${taskId}/results`, {
    operationId: "op_approval_source_result01", taskId,
    definitionRevision: task.definitionRevision, criteriaRevision: task.criteriaRevision,
    proposedAtTaskRevision: task.taskRevision, supersedesResultId: null,
    outcome: "informational", summary: "Explicit follow-up proposal", risks: [],
    openQuestions: [], nextActions, criterionClaims: [],
    sources: [{ evidenceRefId: "evidence_approval_source01", kind: "message", messageId: message.messageId }]
  });
}

test("execution approval atomically compiles canonical child Tasks and immutable graph/receipt", async (t) => {
  const f = await fixture(t);
  const before = f.counts();
  const plan = await f.create();
  const command = approval(plan, f.root.taskRevision);
  const receipt = await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
  assert.equal(receipt.plan.state, "approved");
  assert.equal(receipt.plan.controlRevision, 2);
  assert.equal(receipt.plan.compiledTasks.length, plan.current.definition.nodes.length);
  assert.equal(receipt.approval.rootTaskRevisionAfter, f.root.taskRevision + 1);
  assert.equal(receipt.approval.reviewedByMemberId, f.ownerMemberId);
  assert.equal(f.counts().runs, before.runs);
  assert.equal(f.counts().agent_tasks, before.agent_tasks! + 2);
  for (const compiled of receipt.plan.compiledTasks) {
    const task = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
    const node = plan.current.definition.nodes.find((entry) => entry.nodeKey === compiled.nodeKey)!;
    assert.equal(task.parentTaskId, f.root.taskId);
    assert.equal(task.title, node.task.title);
    assert.equal(task.goal, node.task.goal);
    assert.equal(task.ownerMemberId, node.task.ownerMemberId);
    assert.equal(task.completionPolicy, "accepted_result_required");
    assert.equal(task.lifecycleState, "draft");
    assert.deepEqual(task.criteria, node.task.criteria);
    assert.equal(task.assignments[0].agentId, node.agentId);
    assert.deepEqual(task.budgetPolicy, node.budget);
    assert.equal(task.taskRevision, compiled.taskRevision);
  }
  const root = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
  assert.equal(root.taskRevision, f.root.taskRevision + 1);
  assert.equal(root.definitionRevision, f.root.definitionRevision);
  assert.equal(root.lifecycleState, f.root.lifecycleState);
  assert.deepEqual(await f.ok("GET", `/api/execution-plans/${plan.planId}`), receipt.plan);
  const history = await f.ok("GET", `/api/execution-plans/${plan.planId}/approvals`);
  assert.deepEqual(history.approvals, [receipt.approval]);
  assert.equal(history.nextAfterRevision, null);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM execution_plan_edges").get() as { n: number }).n, 1);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
  assert.deepEqual(await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command), receipt);
  await f.restart();
  assert.deepEqual(await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command), receipt);
  assert.deepEqual(await f.ok("GET", `/api/execution-plans/${plan.planId}`), receipt.plan);
  assert.equal(f.counts().agent_tasks, before.agent_tasks! + 2);
});

test("execution rejection records one exact review without compiling or consuming a root revision", async (t) => {
  const f = await fixture(t);
  const plan = await f.create();
  const before = f.counts();
  const command = { ...approval(plan, f.root.taskRevision), decision: "rejected", reason: "Clarify the required question" };
  const receipt = await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
  assert.equal(receipt.plan.state, "draft");
  assert.equal(receipt.plan.controlRevision, 1);
  assert.deepEqual(receipt.plan.compiledTasks, []);
  assert.equal(receipt.approval.rootTaskRevisionAfter, f.root.taskRevision);
  assert.equal(f.counts().agent_tasks, before.agent_tasks);
  const conflict = await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, {
    ...approval(plan, f.root.taskRevision), operationId: "op_change_review0001"
  });
  assert.equal(conflict.statusCode, 409);
  const next = await f.ok("POST", `/api/execution-plans/${plan.planId}/revisions`, {
    ...f.command(), operationId: "op_after_rejection001", expectedRevision: 1
  });
  const accepted = await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`,
    approval(next, f.root.taskRevision, "op_second_approval001"));
  assert.equal(accepted.plan.current.revision, 2);
  const history = await f.ok("GET", `/api/execution-plans/${plan.planId}/approvals?limit=1`);
  assert.deepEqual(history.approvals, [receipt.approval]);
  assert.equal(history.nextAfterRevision, 1);
  assert.deepEqual(await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command), receipt);
});

test("execution approval rejects changed digest, root/revision pins, forged fields and unresolved questions", async (t) => {
  const f = await fixture(t);
  const input = f.command();
  input.definition.decision.unresolvedQuestions = [{ questionKey: "required", text: "Need an exact scope", required: true }];
  const plan = await f.create(input);
  const original = approval(plan, f.root.taskRevision);
  for (const command of [
    { ...original, expectedDigest: "0".repeat(64) },
    { ...original, expectedRevision: 2 },
    { ...original, expectedRootTaskRevision: f.root.taskRevision + 1 },
    original
  ]) {
    assert.equal((await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, command)).statusCode, 409);
  }
  for (const command of [
    { ...original, actorMemberId: f.ownerMemberId },
    { ...original, grantLocalPermission: true },
    { ...original, reason: "  " }
  ]) {
    assert.equal((await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, command)).statusCode, 400);
  }
  assert.equal(f.counts().execution_plan_approvals, 0);
  assert.equal(f.counts().execution_plan_nodes, 0);
});

test("execution approval operations bind the payload, actor and target across all draft operations", async (t) => {
  const f = await fixture(t);
  const other = await f.participant();
  const first = await f.create();
  const second = await f.create({ ...f.command(), operationId: "op_approval_otherplan01" });
  const command = approval(first, f.root.taskRevision);
  const receipt = await f.ok("POST", `/api/execution-plans/${first.planId}/approvals`, command);
  for (const value of [{ ...command, reason: "Changed intent" }, { ...command, decision: "rejected" }]) {
    assert.equal((await f.request("POST", `/api/execution-plans/${first.planId}/approvals`, value)).statusCode, 409);
  }
  f.database.prepare("UPDATE team_members SET role = 'owner' WHERE member_id = ?").run(other.memberId);
  assert.equal((await f.request("POST", `/api/execution-plans/${first.planId}/approvals`, command, other.authorization)).statusCode, 409);
  assert.equal((await f.request("POST", `/api/execution-plans/${second.planId}/approvals`, command)).statusCode, 409);
  const reused = await f.request("POST", `/api/tasks/${f.root.taskId}/execution-plans`, {
    ...f.command(), operationId: command.operationId
  });
  assert.equal(reused.statusCode, 409);
  const reusedDraft = await f.request("POST", `/api/execution-plans/${second.planId}/approvals`, {
    ...approval(second, receipt.approval.rootTaskRevisionAfter), operationId: f.command().operationId
  });
  assert.equal(reusedDraft.statusCode, 409);
  assert.equal(f.counts().execution_plan_approvals, 1);
});

test("execution approval rechecks human authority and source/Agent availability before any compilation", async (t) => {
  const f = await fixture(t);
  const other = await f.participant();
  const plan = await f.create();
  const command = approval(plan, f.root.taskRevision);
  assert.equal((await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, command, other.authorization)).statusCode, 403);
  f.database.prepare("UPDATE agents SET enabled = 0 WHERE agent_id = ?").run(f.agentId);
  const disabled = await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
  assert.equal(disabled.statusCode, 400);
  assert.equal(disabled.json().error.code, "EXECUTION_NODE_AGENT_UNAVAILABLE");
  f.database.prepare("UPDATE agents SET enabled = 1 WHERE agent_id = ?").run(f.agentId);
  await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
  f.database.prepare("UPDATE rooms SET archived_at = ? WHERE room_id = ?").run(now, f.roomId);
  assert.equal((await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, command)).statusCode, 403);
  assert.equal((await f.request("GET", `/api/execution-plans/${plan.planId}/approvals`)).statusCode, 403);
});

test("execution competing exact approvals compile once and leave the losing alternative a draft", async (t) => {
  const f = await fixture(t);
  const first = await f.create();
  const second = await f.create({ ...f.command(), operationId: "op_competing_draft001" });
  const commands = [approval(first, f.root.taskRevision), approval(second, f.root.taskRevision, "op_competing_approval01")];
  const results = await Promise.all([first, second].map((plan, index) =>
    f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, commands[index])));
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 409]);
  assert.equal(f.counts().execution_plan_approvals, 1);
  assert.equal(f.counts().execution_plan_nodes, 2);
  const loser = results[0]!.statusCode === 200 ? second : first;
  const root = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
  const conflict = await f.request("POST", `/api/execution-plans/${loser.planId}/approvals`,
    approval(loser, root.taskRevision, "op_competing_refresh01"));
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "EXECUTION_ROOT_ALREADY_GOVERNED");
  assert.equal((await f.ok("GET", `/api/execution-plans/${loser.planId}`)).state, "draft");
});

test("execution compilation failures roll back children, criteria, assignments, root CAS, graph and receipt", async (t) => {
  const f = await fixture(t);
  const plan = await f.create();
  const command = approval(plan, f.root.taskRevision);
  const before = f.counts();
  for (const [name, table, condition] of [
    ["second_task", "agent_tasks", "WHEN NEW.title = 'Task Review'"],
    ["graph", "execution_plan_edges", ""],
    ["receipt", "execution_plan_approvals", ""]
  ]) {
    f.database.exec(`CREATE TRIGGER execution_approval_test_cut BEFORE INSERT ON ${table} ${condition}
      BEGIN SELECT RAISE(ABORT, 'simulated ${name} failure /private/sensitive'); END;`);
    const response = await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.body.includes("sensitive"), false);
    assert.deepEqual(f.counts(), before);
    assert.equal((await f.ok("GET", `/api/tasks/${f.root.taskId}`)).taskRevision, f.root.taskRevision);
    f.database.exec("DROP TRIGGER execution_approval_test_cut");
  }
  await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
  assert.equal(f.counts().execution_plan_approvals, 1);
});

test("execution canonical Task trimming cannot silently change approved text", async (t) => {
  const f = await fixture(t);
  const command = f.command();
  command.definition.nodes[0]!.task.goal = " Leading or trailing text ";
  const plan = await f.create(command);
  const before = f.counts();
  const response = await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, f.root.taskRevision));
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "EXECUTION_TASK_TEXT_NOT_CANONICAL");
  assert.deepEqual(f.counts(), before);
});

test("execution new governed Tasks cannot dispatch through legacy messages or Discussions", async (t) => {
  const f = await fixture(t);
  const plan = await f.create();
  const receipt = await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, f.root.taskRevision));
  const task = receipt.plan.compiledTasks[0];
  await f.ok("POST", `/api/tasks/${task.taskId}/control`, {
    operationId: "op_enable_governed0001", expectedTaskRevision: task.taskRevision, lifecycleState: "ready"
  });
  const before = f.counts();
  const messagesBefore = f.database.prepare("SELECT count(*) AS n FROM messages").get();
  const routed = await f.request("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: task.taskId, content: "Bypass the graph via mention", mentionAgentId: f.agentId
  });
  assert.equal(routed.statusCode, 400);
  assert.match(routed.json().error.message, /execution admission/u);
  assert.deepEqual(f.database.prepare("SELECT count(*) AS n FROM messages").get(), messagesBefore);
  const discussion = await f.request("POST", `/api/rooms/${f.roomId}/discussions`, {
    taskId: task.taskId, goal: "Bypass graph admission", participantAgentIds: [f.agentId]
  });
  assert.equal(discussion.statusCode, 400);
  assert.equal(f.counts().runs, before.runs);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM discussions WHERE task_id = ?").get(task.taskId) as { n: number }).n, 0);
  const weakened = await f.request("PUT", `/api/tasks/${task.taskId}/definition`, {
    operationId: "op_weaken_completion001", expectedTaskRevision: 2,
    title: "Task Build", goal: "Deliver Build", ownerMemberId: f.ownerMemberId,
    completionPolicy: "owner_confirmed", priority: "normal", dueAt: null,
    criteria: plan.current.definition.nodes[0]!.task.criteria,
    assignments: [{ agentId: f.agentId, role: "primary" }], budgetPolicy: plan.current.definition.nodes[0]!.budget
  });
  assert.equal(weakened.statusCode, 400);
  assert.match(weakened.json().error.message, /cannot be weakened/u);
});

test("execution adopted Tasks preserve identity and reject valid legacy Discussion, retry and handoff work", async (t) => {
  const f = await fixture(t);
  const second = (await f.ok("POST", `/api/teams/${f.teamId}/manual-agents`, { name: "Reviewer", role: "Reviewer" })).agent;
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, {
    memberIds: [f.ownerMemberId], agentIds: [f.agentId, second.agentId]
  });
  let task = await existingTask(f, { assignments: [
    { agentId: f.agentId, role: "primary" }, { agentId: second.agentId, role: "reviewer" }
  ] });
  const routed = await f.ok("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: task.taskId, content: "Previous attempt", mentionAgentId: f.agentId
  });
  const runId = routed.runs[0].runId;
  const runs = new RunRepository(f.database);
  runs.applyEvent(runId, { type: "status", sequence: 1, status: "failed" }, now);
  task = await f.ok("GET", `/api/tasks/${task.taskId}`);
  const plan = await f.create(linkTask(f, task));
  const before = f.counts();
  const receipt = await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, f.root.taskRevision));
  assert.equal(receipt.plan.compiledTasks[0].taskId, task.taskId);
  assert.equal(f.counts().agent_tasks, before.agent_tasks! + 1);
  assert.deepEqual(await f.ok("GET", `/api/tasks/${task.taskId}`), task);
  const after = f.counts();
  const messages = f.database.prepare("SELECT count(*) AS n FROM messages").get();
  const discussion = await f.request("POST", `/api/rooms/${f.roomId}/discussions`, {
    taskId: task.taskId, goal: "A valid two-participant Discussion", participantAgentIds: [f.agentId, second.agentId]
  });
  assert.equal(discussion.statusCode, 400, discussion.body);
  assert.match(discussion.json().error.message, /execution admission/u);
  const retry = await f.request("POST", `/api/runs/${runId}/retry`, {
    operationId: "op_governed_retry0001", expectedTaskRevision: task.taskRevision
  });
  assert.equal(retry.statusCode, 400, retry.body);
  assert.match(retry.json().error.message, /execution admission/u);
  // Reply handoffs may be considered after the parent settled; the common Run
  // persistence gate still owns admission even when parent work predates adoption.
  const handoffs = new HandoffService(new CoreRepository(f.database), runs, new AgentTaskRepository(f.database));
  assert.throws(() => handoffs.createFromReply(runId, "@Reviewer inspect this", now), /execution admission/u);
  assert.deepEqual(f.counts(), after);
  assert.deepEqual(f.database.prepare("SELECT count(*) AS n FROM messages").get(), messages);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM discussions WHERE task_id = ?").get(task.taskId) as { n: number }).n, 0);
});

test("execution adoption rejects active or unknown work without changing canonical Tasks", async (t) => {
  const f = await fixture(t);
  const task = await existingTask(f);
  const runId = (await f.ok("POST", `/api/rooms/${f.roomId}/messages`, {
    taskId: task.taskId, content: "Work still in progress", mentionAgentId: f.agentId
  })).runs[0].runId;
  const current = await f.ok("GET", `/api/tasks/${task.taskId}`);
  const plan = await f.create(linkTask(f, current));
  const command = approval(plan, f.root.taskRevision);
  for (const state of ["queued", "outcome_unknown"] as const) {
    if (state === "outcome_unknown") new RunRepository(f.database).applyEvent(runId, {
      type: "status", sequence: 1, status: state
    }, now);
    const before = f.counts();
    const denied = await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().error.code, "EXECUTION_NODE_HAS_ACTIVE_OR_UNKNOWN_WORK");
    assert.deepEqual(f.counts(), before);
  }
});

test("execution adoption requires the linked Task Owner even when the caller owns the root", async (t) => {
  const f = await fixture(t);
  const member = await f.participant();
  const task = await existingTask(f, { ownerMemberId: member.memberId });
  const plan = await f.create(linkTask(f, task));
  // The caller remains root Owner but is no longer Team Owner.
  f.database.prepare("UPDATE team_members SET role = 'owner' WHERE member_id = ?").run(member.memberId);
  f.database.prepare("UPDATE team_members SET role = 'member' WHERE member_id = ?").run(f.ownerMemberId);
  const before = f.counts();
  const denied = await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, f.root.taskRevision));
  assert.equal(denied.statusCode, 403, denied.body);
  assert.deepEqual(f.counts(), before);
});

test("execution source retraction invalidates approval but preserves the reviewed draft history", async (t) => {
  const f = await fixture(t);
  const memory = await f.ok("POST", `/api/tasks/${f.root.taskId}/memory-entries`, {
    type: "decision", content: "A planning premise", sourceMessageIds: [f.message.messageId]
  });
  const command = f.command();
  command.definition.decision.sources = [{ evidenceRefId: "evidence_memory0001", kind: "memory", memoryId: memory.memoryId }];
  command.definition.decision.sourceRevisions = [{ evidenceRefId: "evidence_memory0001", revision: memory.revision }];
  const plan = await f.create(command);
  const frozen = await f.ok("GET", `/api/execution-decisions/${plan.current.decisionId}/sources`);
  await f.ok("POST", `/api/memory-entries/${memory.memoryId}/retract`);
  const before = f.counts();
  const denied = await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, f.root.taskRevision));
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error.code, "EXECUTION_SOURCE_REVISION_CONFLICT");
  assert.deepEqual(f.counts(), before);
  assert.deepEqual(await f.ok("GET", `/api/execution-decisions/${plan.current.decisionId}/sources`), frozen);
});

test("execution approved claims cannot be reused under another root or rewritten through SQL", async (t) => {
  const f = await fixture(t);
  const linked = await existingTask(f);
  const first = await f.create(linkTask(f, linked));
  await f.ok("POST", `/api/execution-plans/${first.planId}/approvals`, approval(first, f.root.taskRevision));
  const otherRoot = await f.ok("POST", `/api/rooms/${f.roomId}/tasks`, { title: "Other root", goal: "Another objective" });
  const command = linkTask(f, linked);
  command.operationId = "op_otherroot_plan0001";
  command.definition.rootTaskId = otherRoot.taskId;
  command.expectedRootTaskRevision = otherRoot.taskRevision;
  const second = await f.ok("POST", `/api/tasks/${otherRoot.taskId}/execution-plans`, command);
  const before = f.counts();
  const conflict = await f.request("POST", `/api/execution-plans/${second.planId}/approvals`,
    approval(second, otherRoot.taskRevision, "op_otherroot_approve01"));
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, "EXECUTION_TASK_ALREADY_GOVERNED");
  assert.deepEqual(f.counts(), before);
  for (const [table, column] of [
    ["execution_plan_approvals", "reason"], ["execution_plan_nodes", "node_json"], ["execution_plan_edges", "edge_json"]
  ]) {
    assert.throws(() => f.database.exec(`UPDATE ${table} SET ${column} = ${column}`), /immutable/u);
    assert.throws(() => f.database.exec(`DELETE FROM ${table}`), /immutable/u);
  }
  assert.throws(() => f.database.exec("DELETE FROM execution_plan_task_claims"), /terminal plan release/u);
  assert.throws(() => f.database.exec("UPDATE execution_plan_task_claims SET revision = revision"), /retargeted/u);
  assert.throws(() => f.database.prepare("UPDATE execution_plans SET state = 'approved' WHERE plan_id = ?").run(second.planId), /exact approval/u);
  assert.throws(() => f.database.exec("INSERT INTO execution_plan_nodes SELECT * FROM execution_plan_nodes"), /sealed/u);
  assert.throws(() => f.database.exec("INSERT INTO execution_plan_edges SELECT * FROM execution_plan_edges"), /sealed/u);
});

test("execution same-plan review and revise races each have one atomic winner", async (t) => {
  for (const revise of [false, true]) {
    const f = await fixture(t);
    const plan = await f.create();
    const first = f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, f.root.taskRevision));
    const second = revise
      ? f.request("POST", `/api/execution-plans/${plan.planId}/revisions`, {
        ...f.command(), operationId: "op_concurrent_revision01", expectedRevision: 1
      })
      : f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, f.root.taskRevision, "op_concurrent_review001"));
    const responses = await Promise.all([first, second]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    const current = await f.ok("GET", `/api/execution-plans/${plan.planId}`);
    assert.equal(f.counts().execution_plan_approvals, current.state === "approved" ? 1 : 0);
    assert.equal(f.counts().execution_plan_nodes, current.state === "approved" ? 2 : 0);
  }
});

test("execution task drift pauses the plan without rewriting exact compilation or approval receipts", async (t) => {
  for (const change of ["definition", "assignment", "root_owner", "pause"] as const) {
    const f = await fixture(t);
    const other = await f.participant();
    const plan = await f.create();
    const command = approval(plan, f.root.taskRevision);
    const receipt = await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
    const nodes = f.database.prepare("SELECT * FROM execution_plan_nodes ORDER BY node_key").all();
    const taskId = receipt.plan.compiledTasks[0].taskId;
    if (change === "assignment") {
      f.database.prepare("DELETE FROM task_agent_assignments WHERE task_id = ?").run(taskId);
    } else if (change === "root_owner") {
      f.database.prepare("UPDATE agent_tasks SET owner_member_id = ? WHERE task_id = ?").run(other.memberId, f.root.taskId);
    } else if (change === "pause") {
      await f.ok("POST", `/api/tasks/${taskId}/control`, {
        operationId: "op_pause_approved_task01", expectedTaskRevision: 1, schedulingState: "paused"
      });
    } else {
      const task = await f.ok("GET", `/api/tasks/${taskId}`);
      await f.ok("PUT", `/api/tasks/${taskId}/definition`, {
        operationId: "op_edit_approved_task001", expectedTaskRevision: task.taskRevision,
        title: task.title, goal: "Human revised scope", ownerMemberId: task.ownerMemberId,
        completionPolicy: task.completionPolicy, priority: task.priority, dueAt: task.dueAt,
        criteria: task.criteria, assignments: task.assignments.map(({ agentId, role }: any) => ({ agentId, role })),
        budgetPolicy: task.budgetPolicy
      });
    }
    const current = await f.ok("GET", `/api/execution-plans/${plan.planId}`);
    assert.equal(current.state, "paused", change);
    assert.equal(current.controlRevision, 3);
    assert.deepEqual(current.current, plan.current);
    assert.deepEqual(f.database.prepare("SELECT * FROM execution_plan_nodes ORDER BY node_key").all(), nodes);
    assert.equal(f.counts().execution_plan_drift_events, 1);
    assert.deepEqual(await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command), receipt);
    assert.throws(() => f.database.exec("UPDATE execution_plan_drift_events SET reason = reason"), /immutable/u);
    assert.throws(() => f.database.exec("DELETE FROM execution_plan_drift_events"), /immutable/u);
  }
});

test("execution approval uses canonical accepted Result action provenance and never copies acceptance", async (t) => {
  const f = await fixture(t);
  await f.ok("POST", `/api/tasks/${f.root.taskId}/control`, {
    operationId: "op_source_root_active01", expectedTaskRevision: f.root.taskRevision, lifecycleState: "active"
  });
const result = await propose(f, f.root.taskId, [{ nextActionKey: "next_build0001", description: "Deliver Build" }]);
  let root = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
  await f.ok("POST", `/api/results/${result.resultId}/review-decisions`, {
    operationId: "op_source_root_accept01", expectedTaskRevision: root.taskRevision,
    expectedReviewRevision: 0, decision: "accepted", reason: "Approved follow-up", completeTask: false
  });
  root = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
  const command = f.command();
  command.expectedRootTaskRevision = root.taskRevision;
  command.definition.nodes[0]!.task.sourceAction = { resultId: result.resultId, nextActionKey: "next_build0001" };
  command.definition.decision.sources.push({ evidenceRefId: "evidence_nextaction001", kind: "result", resultId: result.resultId });
  command.definition.decision.sourceRevisions.push({ evidenceRefId: "evidence_nextaction001", revision: result.resultVersion });
  const plan = await f.create(command);
  const approvalCommand = approval(plan, root.taskRevision);
  const receipt = await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, approvalCommand);
  const taskId = receipt.plan.compiledTasks[0].taskId;
  const source = f.database.prepare("SELECT * FROM task_result_sources WHERE child_task_id = ?").get(taskId) as any;
  assert.equal(source.source_result_id, result.resultId);
  assert.equal(source.next_action_key, "next_build0001");
  const task = await f.ok("GET", `/api/tasks/${taskId}`);
  assert.equal(task.completionResultId, null);
  assert.equal(task.lifecycleState, "draft");
  assert.deepEqual(await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, approvalCommand), receipt);
  assert.equal(f.counts().task_result_sources, 1);
});

test("execution approval denies unaccepted or mismatched source actions and derived operation collisions", async (t) => {
  for (const mode of ["unaccepted", "mismatch", "collision"] as const) {
    const f = await fixture(t);
    await f.ok("POST", `/api/tasks/${f.root.taskId}/control`, {
      operationId: "op_action_root_active01", expectedTaskRevision: f.root.taskRevision, lifecycleState: "active"
    });
    const result = await propose(f, f.root.taskId, [{ nextActionKey: "next_build0001", description: mode === "mismatch" ? "A different goal" : "Deliver Build" }]);
    let root = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
    if (mode !== "unaccepted") {
      await f.ok("POST", `/api/results/${result.resultId}/review-decisions`, {
        operationId: "op_action_root_accept01", expectedTaskRevision: root.taskRevision,
        expectedReviewRevision: 0, decision: "accepted", reason: "Follow-up accepted", completeTask: false
      });
    }
    const operationId = "op_source_collision001";
    if (mode === "collision") {
      await f.ok("POST", `/api/results/${result.resultId}/follow-up-tasks`, {
        operationId: `op_${executionOperationDigest({ purpose: "execution_source_action", operationId, nodeKey: "Build" })}`,
        nextActionKey: "next_build0001", title: "Other child", ownerMemberId: f.ownerMemberId
      });
    }
    root = await f.ok("GET", `/api/tasks/${f.root.taskId}`);
    const input = f.command();
    input.expectedRootTaskRevision = root.taskRevision;
    input.definition.nodes[0]!.task.sourceAction = { resultId: result.resultId, nextActionKey: "next_build0001" };
    input.definition.decision.sources.push({ evidenceRefId: "evidence_action0001", kind: "result", resultId: result.resultId });
    input.definition.decision.sourceRevisions.push({ evidenceRefId: "evidence_action0001", revision: result.resultVersion });
    const plan = await f.create(input);
    const before = f.counts();
    const denied = await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, root.taskRevision, operationId));
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().error.code, mode === "collision" ? "EXECUTION_OPERATION_CONFLICT" : "EXECUTION_SOURCE_ACTION_UNAVAILABLE");
    assert.deepEqual(f.counts(), before);
  }
});

test("execution adoption fences pre-existing Result acceptance but preserves human rejection", async (t) => {
  const f = await fixture(t);
  let task = await existingTask(f);
  await f.ok("POST", `/api/tasks/${task.taskId}/control`, {
    operationId: "op_result_link_active01", expectedTaskRevision: task.taskRevision, lifecycleState: "active"
  });
  const result = await propose(f, task.taskId);
  task = await f.ok("GET", `/api/tasks/${task.taskId}`);
  const plan = await f.create(linkTask(f, task));
  await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, approval(plan, f.root.taskRevision));
  const review = { operationId: "op_legacy_accept0001", expectedTaskRevision: task.taskRevision,
    expectedReviewRevision: 0, decision: "accepted", reason: "Legacy acceptance", completeTask: false };
  const denied = await f.request("POST", `/api/results/${result.resultId}/review-decisions`, review);
  assert.equal(denied.statusCode, 400);
  assert.match(denied.json().error.message, /verified execution review/u);
  assert.equal((await f.ok("GET", `/api/results/${result.resultId}`)).state, "proposed");
  await f.ok("POST", `/api/results/${result.resultId}/review-decisions`, { ...review, decision: "rejected" });
  assert.equal((await f.ok("GET", `/api/results/${result.resultId}`)).state, "rejected");
});

test("execution approval receipts require trusted Origin and current membership, with commit-only notifications", async (t) => {
  const f = await fixture(t);
  const plan = await f.create();
  const cursor = async () => (await f.ok("GET", `/api/teams/${f.teamId}/changes?after=0`)).cursor;
  const before = await cursor();
  const command = approval(plan, f.root.taskRevision);
  f.database.exec("CREATE TRIGGER approval_notification_cut BEFORE INSERT ON execution_plan_approvals BEGIN SELECT RAISE(ABORT, 'cut'); END");
  assert.equal((await f.request("POST", `/api/execution-plans/${plan.planId}/approvals`, command)).statusCode, 400);
  assert.equal(await cursor(), before);
  f.database.exec("DROP TRIGGER approval_notification_cut");
  const receipt = await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
  assert.equal(await cursor(), before + 1);
  await f.ok("POST", `/api/execution-plans/${plan.planId}/approvals`, command);
  assert.equal(await cursor(), before + 1);
  const app = await f.restartTrusted();
  const cookie = `__Host-agentroom_session=${f.authorization.slice("Bearer ".length)}`;
  for (const origin of [undefined, "https://foreign.example", "https://central.example"]) {
    const response = await app.inject({ method: "POST", url: `/api/execution-plans/${plan.planId}/approvals`,
      headers: { cookie, ...(origin ? { origin } : {}) }, payload: command });
    assert.equal(response.statusCode, origin === "https://central.example" ? 200 : 403);
    assert.equal(response.headers["cache-control"], "no-store");
    if (response.statusCode === 200) assert.deepEqual(response.json(), receipt);
  }
  for (const query of ["limit=51", "afterRevision=1x", "limit=0"]) {
    const response = await app.inject({ method: "GET", url: `/api/execution-plans/${plan.planId}/approvals?${query}`, headers: { cookie } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["cache-control"], "no-store");
  }
});
