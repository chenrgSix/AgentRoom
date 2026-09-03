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
  assignmentRole: "primary" | "contributor" = "primary",
  clock: () => string = () => now
) {
  const environment = await executionFixture(t, clock);
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
  assert.equal(revised.result.isError, undefined, JSON.stringify(revised));
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
  assert.deepEqual(
    ["team.propose_plan_supersession", "team.activate_plan_supersession"]
      .map((name) => names.includes(name)),
    [true, true]
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

test("assigned Tech Lead consumes one bounded replan delegation", async (t) => {
  let testNow = now;
  const value = await setupTechLead(t, "primary", () => testNow);
  const proposed = await value.call("team.propose_plan", {
    runId: value.runId,
    command: value.proposal
  });
  const draft = proposed.result.structuredContent?.plan as any;
  const approved = (await value.ok(
    "POST",
    `/api/execution-plans/${draft.planId}/approvals`,
    {
      operationId: "op_mcp_supersession_approval0001",
      expectedRevision: draft.current.revision,
      expectedDigest: draft.current.digest,
      expectedRootTaskRevision: value.manifest.taskRevision,
      decision: "approved",
      reason: "Authorize the initial bounded graph."
    }
  )).plan;
  const delegated = await value.ok(
    "POST",
    `/api/execution-plans/${approved.planId}/replan-delegations`,
    {
      operationId: "op_mcp_replan_delegation0001",
      expectedPlanRevision: approved.current.revision,
      expectedPlanDigest: approved.current.digest,
      expectedControlRevision: approved.controlRevision,
      expectedRootTaskRevision: value.manifest.taskRevision + 1,
      agentId: value.agentId,
      expiresAt: "2026-08-31T12:30:00.000Z",
      reason: "Permit one low-risk Tech Lead replan."
    }
  );
  const newerDelegation = await value.ok(
    "POST",
    `/api/execution-plans/${approved.planId}/replan-delegations`,
    {
      operationId: "op_mcp_replan_delegation0002",
      expectedPlanRevision: approved.current.revision,
      expectedPlanDigest: approved.current.digest,
      expectedControlRevision: approved.controlRevision,
      expectedRootTaskRevision: value.manifest.taskRevision + 1,
      agentId: value.agentId,
      expiresAt: "2026-08-31T12:40:00.000Z",
      reason: "Replace the older unconsumed delegation."
    }
  );
  assert.equal(delegated.revision, 1);
  assert.equal(newerDelegation.revision, 2);

  const trigger = await value.ok(
    "POST",
    `/api/rooms/${value.roomId}/messages`,
    {
      taskId: value.currentRoot.taskId,
      content: "Replan the active graph inside the existing authority boundary.",
      mentionAgentId: value.agentId
    }
  );
  const runId = trigger.runs[0].runId as string;
  const claimed = await value.call("team.claim_run", { runId });
  assert.equal(
    (claimed.result.structuredContent?.run as { state: string }).state,
    "working"
  );
  const manifest = new RunRepository(value.database).getContextManifest(runId)!;
  const definition = structuredClone(approved.current.definition);
  for (const node of definition.nodes) {
    const compiled = approved.compiledTasks.find((entry: {
      nodeKey: string;
    }) => entry.nodeKey === node.nodeKey);
    assert.ok(compiled);
    const task = await value.ok("GET", `/api/tasks/${compiled.taskId}`);
    node.task = {
      mode: "existing",
      taskId: task.taskId,
      expectedTaskRevision: task.taskRevision,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision
    };
  }
  definition.decision.sources = [{
    evidenceRefId: "evidence_mcp_replan_trigger0001",
    kind: "message",
    messageId: trigger.message.messageId
  }];
  definition.decision.sourceRevisions = [{
    evidenceRefId: "evidence_mcp_replan_trigger0001",
    revision: trigger.message.sequence
  }];
  definition.decision.summary = "Use the delegated low-risk revision path.";
  const candidateCommand = {
    operationId: "op_mcp_supersession_candidate0001",
    expectedCurrentRevision: approved.current.revision,
    expectedCurrentDigest: approved.current.digest,
    expectedControlRevision: approved.controlRevision,
    expectedRootTaskRevision: manifest.taskRevision,
    definition,
    reason: "Propose the exact delegated active-plan revision."
  };
  const candidateResult = await value.call(
    "team.propose_plan_supersession",
    { runId, planId: approved.planId, command: candidateCommand }
  );
  assert.equal(candidateResult.result.isError, undefined);
  const candidate = candidateResult.result.structuredContent?.candidate as any;
  assert.deepEqual(candidate.author, {
    kind: "agent", agentId: value.agentId, runId
  });
  const activationCommand = {
    operationId: "op_mcp_supersession_activation0001",
    candidateId: candidate.candidateId,
    expectedCandidateRevision: candidate.candidateRevision,
    expectedCandidateDigest: candidate.candidateDigest,
    expectedCurrentRevision: approved.current.revision,
    expectedCurrentDigest: approved.current.digest,
    expectedControlRevision: approved.controlRevision,
    expectedRootTaskRevision: manifest.taskRevision,
    carryForward: [],
    reason: "Consume the exact one-shot delegation."
  };
  const stale = await value.call("team.activate_plan_supersession", {
    runId,
    planId: approved.planId,
    delegationId: delegated.delegationId,
    command: {
      ...activationCommand,
      operationId: "op_mcp_stale_delegation_activation0001"
    }
  });
  assert.equal(stale.result.isError, true);
  const revoked = await value.ok(
    "POST",
    `/api/execution-plans/${approved.planId}/replan-delegations/${newerDelegation.delegationId}/revocations`,
    {
      operationId: "op_mcp_replan_revocation0001",
      expectedRevision: newerDelegation.revision,
      expectedDigest: newerDelegation.delegationDigest,
      reason: "Revoke before the Agent may consume it."
    }
  );
  assert.equal(revoked.delegationId, newerDelegation.delegationId);
  const revokedAttempt = await value.call("team.activate_plan_supersession", {
    runId,
    planId: approved.planId,
    delegationId: newerDelegation.delegationId,
    command: {
      ...activationCommand,
      operationId: "op_mcp_revoked_delegation_activation0001"
    }
  });
  assert.equal(revokedAttempt.result.isError, true);
  const expiredDelegation = await value.ok(
    "POST",
    `/api/execution-plans/${approved.planId}/replan-delegations`,
    {
      operationId: "op_mcp_replan_delegation0003",
      expectedPlanRevision: approved.current.revision,
      expectedPlanDigest: approved.current.digest,
      expectedControlRevision: approved.controlRevision,
      expectedRootTaskRevision: value.manifest.taskRevision + 1,
      agentId: value.agentId,
      expiresAt: "2026-08-31T12:05:00.000Z",
      reason: "Retain a delegation that will expire before use."
    }
  );
  assert.equal(expiredDelegation.revision, 3);
  testNow = "2026-08-31T12:06:00.000Z";
  const expiredAttempt = await value.call("team.activate_plan_supersession", {
    runId,
    planId: approved.planId,
    delegationId: expiredDelegation.delegationId,
    command: {
      ...activationCommand,
      operationId: "op_mcp_expired_delegation_activation0001"
    }
  });
  assert.equal(expiredAttempt.result.isError, true);
  const currentDelegation = await value.ok(
    "POST",
    `/api/execution-plans/${approved.planId}/replan-delegations`,
    {
      operationId: "op_mcp_replan_delegation0004",
      expectedPlanRevision: approved.current.revision,
      expectedPlanDigest: approved.current.digest,
      expectedControlRevision: approved.controlRevision,
      expectedRootTaskRevision: value.manifest.taskRevision + 1,
      agentId: value.agentId,
      expiresAt: "2026-08-31T12:50:00.000Z",
      reason: "Issue the exact current one-shot delegation."
    }
  );
  assert.equal(currentDelegation.revision, 4);
  const controlBefore = await value.ok(
    "GET", `/api/execution-plans/${approved.planId}/supersession-control`
  );
  assert.equal(controlBefore.candidate.candidateId, candidate.candidateId);
  assert.deepEqual(controlBefore.activationTemplate, {
    expectedCurrentRevision: activationCommand.expectedCurrentRevision,
    expectedCurrentDigest: activationCommand.expectedCurrentDigest,
    expectedControlRevision: activationCommand.expectedControlRevision,
    expectedRootTaskRevision: activationCommand.expectedRootTaskRevision,
    candidateId: activationCommand.candidateId,
    expectedCandidateRevision: activationCommand.expectedCandidateRevision,
    expectedCandidateDigest: activationCommand.expectedCandidateDigest,
    carryForward: []
  });
  assert.equal(controlBefore.activationBlockerCode, null);
  assert.deepEqual(
    controlBefore.delegations.map(({ delegation, state }: any) => [
      delegation.revision, state
    ]),
    [[1, "superseded"], [2, "revoked"], [3, "expired"], [4, "active"]]
  );
  const activation = await value.call("team.activate_plan_supersession", {
    runId,
    planId: approved.planId,
    delegationId: currentDelegation.delegationId,
    command: activationCommand
  });
  assert.equal(activation.result.isError, undefined);
  const receipt = activation.result.structuredContent?.receipt as any;
  assert.equal(receipt.plan.current.revision, 2);
  assert.deepEqual(receipt.activatedBy, {
    kind: "agent", agentId: value.agentId, runId
  });
  assert.equal(receipt.delegationId, currentDelegation.delegationId);
  const listed = await value.ok(
    "GET", `/api/execution-plans/${approved.planId}/replan-delegations`
  );
  const current = listed.find(({ delegation }: any) =>
    delegation.delegationId === currentDelegation.delegationId);
  const withdrawn = listed.find(({ delegation }: any) =>
    delegation.delegationId === newerDelegation.delegationId);
  assert.equal(current.consumed, true);
  assert.equal(current.revoked, false);
  assert.equal(withdrawn.consumed, false);
  assert.equal(withdrawn.revoked, true);
  const controlAfter = await value.ok(
    "GET", `/api/execution-plans/${approved.planId}/supersession-control`
  );
  assert.equal(controlAfter.currentRevision, 2);
  assert.equal(controlAfter.candidate, null);
  assert.equal(controlAfter.activationTemplate, null);
  assert.equal(
    controlAfter.delegations.find(({ delegation }: any) =>
      delegation.delegationId === currentDelegation.delegationId).state,
    "consumed"
  );
  const replay = await value.call("team.activate_plan_supersession", {
    runId,
    planId: approved.planId,
    delegationId: currentDelegation.delegationId,
    command: activationCommand
  });
  assert.equal(replay.result.isError, undefined, JSON.stringify(replay));
  assert.deepEqual(replay.result.structuredContent?.receipt, receipt);
});

test("delegated replan rejects budget expansion without consuming authority", async (t) => {
  const value = await setupTechLead(t);
  const proposed = await value.call("team.propose_plan", {
    runId: value.runId,
    command: value.proposal
  });
  const draft = proposed.result.structuredContent?.plan as any;
  const approved = (await value.ok(
    "POST",
    `/api/execution-plans/${draft.planId}/approvals`,
    {
      operationId: "op_mcp_expansion_approval0001",
      expectedRevision: draft.current.revision,
      expectedDigest: draft.current.digest,
      expectedRootTaskRevision: value.manifest.taskRevision,
      decision: "approved",
      reason: "Authorize the original bounded graph only."
    }
  )).plan;
  const delegation = await value.ok(
    "POST",
    `/api/execution-plans/${approved.planId}/replan-delegations`,
    {
      operationId: "op_mcp_expansion_delegation0001",
      expectedPlanRevision: approved.current.revision,
      expectedPlanDigest: approved.current.digest,
      expectedControlRevision: approved.controlRevision,
      expectedRootTaskRevision: value.manifest.taskRevision + 1,
      agentId: value.agentId,
      expiresAt: "2026-08-31T12:30:00.000Z",
      reason: "Allow one bounded replan, but no budget expansion."
    }
  );
  const trigger = await value.ok(
    "POST",
    `/api/rooms/${value.roomId}/messages`,
    {
      taskId: value.currentRoot.taskId,
      content: "Propose a broader budget for explicit human review.",
      mentionAgentId: value.agentId
    }
  );
  const runId = trigger.runs[0].runId as string;
  await value.call("team.claim_run", { runId });
  const manifest = new RunRepository(value.database).getContextManifest(runId)!;
  const definition = structuredClone(approved.current.definition);
  for (const node of definition.nodes) {
    const compiled = approved.compiledTasks.find((entry: {
      nodeKey: string;
    }) => entry.nodeKey === node.nodeKey);
    assert.ok(compiled);
    const task = await value.ok("GET", `/api/tasks/${compiled.taskId}`);
    node.task = {
      mode: "existing",
      taskId: task.taskId,
      expectedTaskRevision: task.taskRevision,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision
    };
  }
  definition.policy.budget.maxRunAttempts += 1;
  definition.decision.sources = [{
    evidenceRefId: "evidence_mcp_expansion_trigger0001",
    kind: "message",
    messageId: trigger.message.messageId
  }];
  definition.decision.sourceRevisions = [{
    evidenceRefId: "evidence_mcp_expansion_trigger0001",
    revision: trigger.message.sequence
  }];
  definition.decision.summary = "Request broader authority for human review.";
  const candidateResult = await value.call(
    "team.propose_plan_supersession",
    {
      runId,
      planId: approved.planId,
      command: {
        operationId: "op_mcp_expansion_candidate0001",
        expectedCurrentRevision: approved.current.revision,
        expectedCurrentDigest: approved.current.digest,
        expectedControlRevision: approved.controlRevision,
        expectedRootTaskRevision: manifest.taskRevision,
        definition,
        reason: "Retain the candidate for explicit human review."
      }
    }
  );
  assert.equal(candidateResult.result.isError, undefined);
  const candidate = candidateResult.result.structuredContent?.candidate as any;
  const sideEffectTables = [
    "execution_plans",
    "execution_plan_approvals",
    "execution_plan_task_claims",
    "execution_plan_supersession_activations",
    "execution_replan_delegation_consumptions",
    "execution_carried_evidence_adoptions",
    "execution_evidence_adoptions",
    "execution_dispatch_intents",
    "isolated_workspace_leases",
    "repository_capture_operations",
    "repository_verification_operations",
    "repository_integration_operations",
    "runs"
  ];
  const beforeDenied = Object.fromEntries(sideEffectTables.map((table) =>
    [table, count(value.database, table)]
  ));
  const denied = await value.call("team.activate_plan_supersession", {
    runId,
    planId: approved.planId,
    delegationId: delegation.delegationId,
    command: {
      operationId: "op_mcp_expansion_activation0001",
      candidateId: candidate.candidateId,
      expectedCandidateRevision: candidate.candidateRevision,
      expectedCandidateDigest: candidate.candidateDigest,
      expectedCurrentRevision: approved.current.revision,
      expectedCurrentDigest: approved.current.digest,
      expectedControlRevision: approved.controlRevision,
      expectedRootTaskRevision: manifest.taskRevision,
      carryForward: [],
      reason: "The delegation must refuse this broader budget."
    }
  });
  assert.equal(denied.result.isError, true);
  assert.match(JSON.stringify(denied), /EXECUTION_HUMAN_REVIEW_REQUIRED/u);
  assert.deepEqual(
    Object.fromEntries(sideEffectTables.map((table) =>
      [table, count(value.database, table)]
    )),
    beforeDenied,
    "rejected delegated expansion must have no authority or execution side effects"
  );
  assert.equal(
    (await value.ok("GET", `/api/execution-plans/${approved.planId}`))
      .current.revision,
    1
  );
  const listed = await value.ok(
    "GET", `/api/execution-plans/${approved.planId}/replan-delegations`
  );
  const retained = listed.find(({ delegation: row }: any) =>
    row.delegationId === delegation.delegationId);
  assert.equal(retained.consumed, false);
  assert.equal(count(value.database,
    "execution_plan_supersession_activations"), 0);
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
