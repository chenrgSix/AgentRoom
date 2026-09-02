import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type {
  ExecutionPlanDefinition,
  ExecutionPlanProposalCommand,
  ExecutionPlanRevisionCommand
} from "@convene-wire/contracts/execution-plan";

import { RunRepository } from "../src/run/run-repository.js";
import {
  fixture as executionFixture,
  now
} from "./helpers/execution-plan-fixture.js";

interface McpResponse {
  result: {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}

async function setupTechLead(
  t: TestContext,
  assignmentRole: "primary" | "contributor" = "primary"
) {
  const environment = await executionFixture(t);
  const manual = await environment.ok(
    "POST",
    `/api/teams/${environment.teamId}/manual-agents`,
    { name: "Tech Lead", role: "Tech Lead" }
  );
  const agentId = manual.agent.agentId as string;
  const mcpToken = manual.credential.token as string;
  await environment.ok("PUT", `/api/rooms/${environment.roomId}/participants`, {
    memberIds: [environment.ownerMemberId],
    agentIds: [environment.agentId, agentId]
  });
  let root = await environment.ok("GET", `/api/tasks/${environment.root.taskId}`);
  root = await environment.ok("PUT", `/api/tasks/${root.taskId}/definition`, {
    operationId: `op_assign_tech_lead_${assignmentRole}0001`,
    expectedTaskRevision: root.taskRevision,
    title: root.title,
    goal: root.goal,
    ownerMemberId: root.ownerMemberId,
    completionPolicy: root.completionPolicy,
    priority: root.priority,
    dueAt: root.dueAt,
    criteria: root.criteria,
    assignments: [{ agentId, role: assignmentRole }],
    budgetPolicy: root.budgetPolicy
  });
  const routed = await environment.ok(
    "POST",
    `/api/rooms/${environment.roomId}/messages`,
    {
      taskId: root.taskId,
      content: "Act as the assigned Tech Lead and produce an execution draft.",
      mentionAgentId: agentId
    }
  );
  const run = routed.runs[0] as { runId: string };
  assert.ok(run?.runId);
  let requestId = 100;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await environment.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: requestId++,
        method: "tools/call",
        params: { name, arguments: args }
      }
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as McpResponse;
  };
  const claim = await call("team.claim_run", { runId: run.runId });
  assert.equal(
    (claim.result.structuredContent?.run as { state: string }).state,
    "working"
  );
  const manifest = new RunRepository(environment.database)
    .getContextManifest(run.runId)!;
  const currentRoot = await environment.ok("GET", `/api/tasks/${root.taskId}`);
  assert.equal(currentRoot.taskRevision, manifest.taskRevision);
  const definition = structuredClone(
    environment.command().definition
  ) as ExecutionPlanDefinition;
  definition.rootTaskId = currentRoot.taskId;
  definition.decision.sources = [{
    evidenceRefId: "evidence_techlead_trigger0001",
    kind: "message",
    messageId: routed.message.messageId
  }];
  definition.decision.sourceRevisions = [{
    evidenceRefId: "evidence_techlead_trigger0001",
    revision: routed.message.sequence
  }];
  const proposal: ExecutionPlanProposalCommand = {
    operationId: "op_mcp_tech_lead_plan0001",
    expectedRootTaskRevision: manifest.taskRevision,
    definition
  };
  return {
    ...environment,
    agentId,
    call,
    currentRoot,
    definition,
    manifest,
    mcpToken,
    proposal,
    runId: run.runId
  };
}

function count(
  database: Awaited<ReturnType<typeof executionFixture>>["database"],
  table: string
): number {
  return (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
    n: number;
  }).n;
}

test("assigned Tech Lead creates reads and revises only unapproved drafts", async (t) => {
  const value = await setupTechLead(t);
  const before = {
    tasks: count(value.database, "agent_tasks"),
    runs: count(value.database, "runs")
  };
  const proposed = await value.call("team.propose_plan", {
    runId: value.runId,
    command: value.proposal
  });
  assert.equal(proposed.result.isError, undefined);
  const first = proposed.result.structuredContent?.plan as {
    planId: string;
    state: string;
    current: {
      revision: number;
      digest: string;
      author: Record<string, unknown>;
    };
  };
  assert.equal(first.state, "draft");
  assert.equal(first.current.revision, 1);
  assert.deepEqual(first.current.author, {
    kind: "agent",
    agentId: value.agentId,
    runId: value.runId
  });
  const replay = await value.call("team.propose_plan", {
    runId: value.runId,
    command: value.proposal
  });
  assert.deepEqual(replay.result.structuredContent?.plan, first);
  const read = await value.call("team.get_plan", {
    runId: value.runId,
    planId: first.planId
  });
  assert.deepEqual(read.result.structuredContent?.plan, first);

  const revision: ExecutionPlanRevisionCommand = {
    operationId: "op_mcp_tech_lead_revision0001",
    expectedRevision: 1,
    expectedRootTaskRevision: value.manifest.taskRevision,
    definition: {
      ...structuredClone(value.definition),
      title: "Revised by the assigned Tech Lead"
    }
  };
  const revised = await value.call("team.propose_plan_revision", {
    runId: value.runId,
    planId: first.planId,
    command: revision
  });
  const second = revised.result.structuredContent?.plan as typeof first;
  assert.equal(second.current.revision, 2);
  assert.deepEqual(second.current.author, first.current.author);
  const revisedReplay = await value.call("team.propose_plan_revision", {
    runId: value.runId,
    planId: first.planId,
    command: revision
  });
  assert.deepEqual(revisedReplay.result.structuredContent?.plan, second);

  assert.equal(count(value.database, "execution_plans"), 1);
  assert.equal(count(value.database, "execution_decisions"), 2);
  assert.equal(count(value.database, "execution_plan_proposals"), 2);
  assert.equal(count(value.database, "execution_plan_revisions"), 2);
  assert.equal(count(value.database, "execution_plan_operations"), 2);
  assert.equal(count(value.database, "execution_plan_approvals"), 0);
  assert.equal(count(value.database, "execution_plan_nodes"), 0);
  assert.equal(count(value.database, "verification_receipts"), 0);
  assert.equal(count(value.database, "integration_receipts"), 0);
  assert.equal(count(value.database, "agent_tasks"), before.tasks);
  assert.equal(count(value.database, "runs"), before.runs);

  const toolsResponse = await value.app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${value.mcpToken}`
    },
    payload: {
      jsonrpc: "2.0",
      id: 999,
      method: "tools/list",
      params: {}
    }
  });
  const names = toolsResponse.json().result.tools.map(
    ({ name }: { name: string }) => name
  ) as string[];
  assert.deepEqual(
    ["team.propose_plan", "team.get_plan", "team.propose_plan_revision"]
      .map((name) => names.includes(name)),
    [true, true, true]
  );
  assert.equal(names.some((name) => [
    "team.approve_plan",
    "team.review_result",
    "team.acknowledge_outcome",
    "team.extend_budget",
    "team.grant_repository",
    "team.verify_candidate",
    "team.integrate_repository"
  ].includes(name)), false);

  await value.call("team.complete_run", {
    runId: value.runId,
    content: "The unapproved draft is ready for human review."
  });
  const afterTerminal = await value.call("team.get_plan", {
    runId: value.runId,
    planId: first.planId
  });
  assert.equal(afterTerminal.result.isError, true);
});

test("role labels schemas assignments Run substitution and stale context fail closed", async (t) => {
  await t.test("schema and changed replay", async (child) => {
    const value = await setupTechLead(child);
    const authorityField = await value.call("team.propose_plan", {
      runId: value.runId,
      command: { ...value.proposal, approved: true }
    });
    assert.equal(authorityField.result.isError, true);
    const proposed = await value.call("team.propose_plan", {
      runId: value.runId,
      command: value.proposal
    });
    assert.equal(proposed.result.isError, undefined);
    const conflict = await value.call("team.propose_plan", {
      runId: value.runId,
      command: {
        ...value.proposal,
        definition: { ...value.proposal.definition, title: "Changed replay" }
      }
    });
    assert.equal(conflict.result.isError, true);
    assert.equal(count(value.database, "execution_plans"), 1);
    assert.equal(count(value.database, "execution_plan_operations"), 1);
  });

  await t.test("Tech Lead display role without primary assignment", async (child) => {
    const value = await setupTechLead(child, "contributor");
    const denied = await value.call("team.propose_plan", {
      runId: value.runId,
      command: value.proposal
    });
    assert.equal(denied.result.isError, true);
    assert.equal(count(value.database, "execution_plans"), 0);
  });

  await t.test("another own Run and stale frozen Task revision", async (child) => {
    const value = await setupTechLead(child);
    const foreign = (await value.ok(
      "POST",
      `/api/rooms/${value.roomId}/messages`,
      {
        taskId: value.currentRoot.taskId,
        content: "A different Agent Run cannot delegate Tech Lead authority.",
        mentionAgentId: value.agentId
      }
    )).runs[0] as { runId: string };
    const foreignDenied = await value.call("team.propose_plan", {
      runId: foreign.runId,
      command: value.proposal
    });
    assert.equal(foreignDenied.result.isError, true);
    value.database.prepare(`
      UPDATE agent_tasks
      SET task_revision = task_revision + 1, updated_at = ?
      WHERE task_id = ?
    `).run(now, value.currentRoot.taskId);
    const stale = await value.call("team.propose_plan", {
      runId: value.runId,
      command: value.proposal
    });
    assert.equal(stale.result.isError, true);
    assert.equal(count(value.database, "execution_plans"), 0);
  });

  await t.test("removed Room access and non-manual identity", async (child) => {
    const removed = await setupTechLead(child);
    await removed.ok("PUT", `/api/rooms/${removed.roomId}/participants`, {
      memberIds: [removed.ownerMemberId],
      agentIds: [removed.definition.nodes[0]!.agentId]
    });
    const noRoom = await removed.call("team.propose_plan", {
      runId: removed.runId,
      command: removed.proposal
    });
    assert.equal(noRoom.result.isError, true);
    assert.equal(count(removed.database, "execution_plans"), 0);

    const changed = await setupTechLead(child);
    changed.database.prepare(
      "UPDATE agents SET integration_mode = 'fake' WHERE agent_id = ?"
    ).run(changed.agentId);
    const nonManual = await changed.call("team.propose_plan", {
      runId: changed.runId,
      command: changed.proposal
    });
    assert.equal(nonManual.result.isError, true);
    assert.equal(count(changed.database, "execution_plans"), 0);

    const disabled = await setupTechLead(child);
    disabled.database.prepare(
      "UPDATE agents SET enabled = 0 WHERE agent_id = ?"
    ).run(disabled.agentId);
    const unavailable = await disabled.app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${disabled.mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 450,
        method: "tools/call",
        params: {
          name: "team.propose_plan",
          arguments: { runId: disabled.runId, command: disabled.proposal }
        }
      }
    });
    assert.equal(unavailable.statusCode, 401);
    assert.equal(count(disabled.database, "execution_plans"), 0);
  });

  await t.test("cross-root plan read", async (child) => {
    const value = await setupTechLead(child);
    const otherRoot = await value.ok("POST", `/api/rooms/${value.roomId}/tasks`, {
      title: "Another root",
      goal: "Keep plan authority separate"
    });
    const currentOther = await value.ok("GET", `/api/tasks/${otherRoot.taskId}`);
    const definition = structuredClone(value.definition);
    definition.rootTaskId = currentOther.taskId;
    definition.decision.sources = [{
      evidenceRefId: "evidence_other_root_message0001",
      kind: "message",
      messageId: value.message.messageId
    }];
    definition.decision.sourceRevisions = [{
      evidenceRefId: "evidence_other_root_message0001",
      revision: value.message.sequence
    }];
    const otherPlan = await value.ok(
      "POST",
      `/api/tasks/${currentOther.taskId}/execution-plans`,
      {
        operationId: "op_other_root_plan0001",
        expectedRootTaskRevision: currentOther.taskRevision,
        definition
      }
    );
    const denied = await value.call("team.get_plan", {
      runId: value.runId,
      planId: otherPlan.planId
    });
    assert.equal(denied.result.isError, true);
  });
});
