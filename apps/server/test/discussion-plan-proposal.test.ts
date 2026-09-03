import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import type {
  DiscussionPlanProposalDraft,
  ExecutionPlanDefinition
} from "@convene-wire/contracts/execution-plan";

import { BridgeConnectionRegistry } from
  "../src/bridge/bridge-connection-registry.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { SqliteTransactionBoundary } from
  "../src/data/sqlite-transaction-boundary.js";
import { DiscussionOrchestrator } from
  "../src/discussion/discussion-orchestrator.js";
import { parseDiscussionPlanProposalEnvelope } from
  "../src/discussion/discussion-plan-proposal-envelope.js";
import { DiscussionPlanProposalService } from
  "../src/discussion/discussion-plan-proposal-service.js";
import { DiscussionRepository } from
  "../src/discussion/discussion-repository.js";
import { DiscussionSupplementalEvidenceService } from
  "../src/discussion/discussion-supplemental-evidence-service.js";
import { ExecutionPlanDraftWriter } from
  "../src/execution/execution-plan-draft-writer.js";
import { ExecutionPlanRepository } from
  "../src/execution/execution-plan-repository.js";
import { ExecutionSourceRepository } from
  "../src/execution/execution-source-repository.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { RunRepository, type RunRecord } from
  "../src/run/run-repository.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import {
  fixture as executionFixture,
  now
} from "./helpers/execution-plan-fixture.js";

const open = "<convenewire-plan-proposal>";
const close = "</convenewire-plan-proposal>";
const planCases = JSON.parse(await readFile(new URL(
  "../../../packages/contracts/fixtures/execution-plan-cases.json",
  import.meta.url
), "utf8"));
const planTemplate = planCases.cases.find((entry: { name: string }) =>
  entry.name === "execution: valid full plan").instance as ExecutionPlanDefinition;

function proposalDraft(definition: ExecutionPlanDefinition): DiscussionPlanProposalDraft {
  return {
    schemaVersion: definition.schemaVersion,
    title: definition.title,
    decision: {
      summary: definition.decision.summary,
      items: definition.decision.items,
      unresolvedQuestions: definition.decision.unresolvedQuestions
    },
    nodes: definition.nodes,
    edges: definition.edges,
    externalInputs: definition.externalInputs,
    policy: definition.policy
  } as DiscussionPlanProposalDraft;
}

function envelope(draft: unknown): string {
  return `${open}${JSON.stringify(draft)}${close}`;
}

test("plan proposal envelope is exact, singular, bounded and closed-schema", () => {
  const valid = proposalDraft(structuredClone(planTemplate));
  assert.deepEqual(
    parseDiscussionPlanProposalEnvelope(`Conclusion\n${envelope(valid)}`),
    valid
  );
  for (const content of [
    "Conclusion only",
    `${envelope(valid)}\n`,
    `${envelope(valid)} trailing`,
    `${envelope(valid)}\n${envelope(valid)}`,
    `<agentroom-plan-proposal>${JSON.stringify(valid)}</agentroom-plan-proposal>`,
    `${open}{invalid}${close}`,
    envelope({ ...valid, approved: true }),
    `${open}${"x".repeat(512 * 1024 + 1)}${close}`
  ]) {
    assert.equal(parseDiscussionPlanProposalEnvelope(content), undefined);
  }
});

async function wiredFixture(t: TestContext) {
  const environment = await executionFixture(t);
  const reviewer = await environment.ok(
    "POST",
    `/api/teams/${environment.teamId}/manual-agents`,
    { name: "Reviewer", role: "Reviewer" }
  );
  const reviewerId = reviewer.agent.agentId as string;
  await environment.ok("PUT", `/api/rooms/${environment.roomId}/participants`, {
    memberIds: [environment.ownerMemberId],
    agentIds: [environment.agentId, reviewerId]
  });
  const root = await environment.ok("GET", `/api/tasks/${environment.root.taskId}`);
  await environment.ok("PUT", `/api/tasks/${root.taskId}/definition`, {
    operationId: "op_assign_discussion_agents0001",
    expectedTaskRevision: root.taskRevision,
    title: root.title,
    goal: root.goal,
    ownerMemberId: root.ownerMemberId,
    completionPolicy: root.completionPolicy,
    priority: root.priority,
    dueAt: root.dueAt,
    criteria: root.criteria,
    assignments: [
      { agentId: environment.agentId, role: "primary" },
      { agentId: reviewerId, role: "reviewer" }
    ],
    budgetPolicy: root.budgetPolicy
  });
  const database = environment.database;
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const tasks = new AgentTaskRepository(database);
  const discussions = new DiscussionRepository(database);
  const runs = new RunRepository(database);
  const transactions = new SqliteTransactionBoundary(database);
  const plans = new ExecutionPlanRepository(database);
  const drafts = new ExecutionPlanDraftWriter(
    transactions,
    plans,
    new ExecutionSourceRepository(database),
    tasks,
    core,
    () => undefined
  );
  const proposalService = new DiscussionPlanProposalService(
    transactions,
    core,
    discussions,
    drafts,
    tasks
  );
  const orchestrator = new DiscussionOrchestrator(
    core,
    new MessageService(core, auth),
    discussions,
    runs,
    auth,
    tasks,
    () => now,
    proposalService
  );
  return {
    ...environment,
    core,
    discussions,
    draft: proposalDraft(environment.command().definition),
    orchestrator,
    plans,
    principal: auth.authenticateWebSession(
      environment.authorization.slice("Bearer ".length),
      now
    ),
    proposalService,
    reviewerId,
    runs
  };
}

function completeRun(
  runs: RunRepository,
  run: RunRecord,
  content: string,
  assessment?: Record<string, unknown>
): void {
  runs.applyEvent(run.runId, {
    type: "status", sequence: 1, status: "working"
  }, now);
  runs.applyReply(run.runId, {
    type: "reply",
    sequence: 2,
    content,
    ...(assessment ? { assessment } : {})
  }, now);
  runs.applyEvent(run.runId, {
    type: "status", sequence: 3, status: "completed"
  }, now);
}

function stageRun(
  runs: RunRepository,
  run: RunRecord,
  content: string,
  assessment?: Record<string, unknown>
): void {
  runs.applyEvent(run.runId, {
    type: "status", sequence: 1, status: "working"
  }, now);
  runs.applyReply(run.runId, {
    type: "reply",
    sequence: 2,
    content,
    ...(assessment ? { assessment } : {})
  }, now);
}

function finishStagedRun(runs: RunRepository, run: RunRecord): void {
  runs.applyEvent(run.runId, {
    type: "status", sequence: 3, status: "completed"
  }, now);
}

async function quorumProposalFixture(t: TestContext) {
  const environment = await executionFixture(t);
  const clock = { value: now };
  const database = environment.database;
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const principal = auth.authenticateWebSession(
    environment.authorization.slice("Bearer ".length),
    now
  );
  const devices = new MemberDeviceService(core, auth);
  const device = devices.registerOwnDevice(
    principal,
    environment.teamId,
    "Read-only discussion Bridge",
    now
  );
  const devicePrincipal = auth.authenticateDevice(
    auth.issueDeviceCredential(device.deviceId, now).secret,
    now
  );
  const agents = new AgentService(core, auth);
  const agentIds = ["Coder", "Security", "Reviewer"].map((name) => {
    const agent = agents.publishAgent(principal, {
      teamId: environment.teamId,
      deviceId: device.deviceId,
      name: `Quorum ${name}`,
      role: name,
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: true,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      runtimePolicy: { filesystemAccess: "read-only" },
      now
    });
    return agents.publishDeviceAgent(devicePrincipal, {
      agentId: agent.agentId,
      name: agent.name,
      role: agent.role,
      capabilities: {
        ...agent.capabilities,
        supportsDiscussionSupplementalEvidence: true
      },
      runtimePolicy: { filesystemAccess: "read-only" },
      now
    }).agentId;
  });
  await environment.ok("PUT", `/api/rooms/${environment.roomId}/participants`, {
    memberIds: [environment.ownerMemberId],
    agentIds
  });
  let root = await environment.ok(
    "GET", `/api/tasks/${environment.root.taskId}`
  );
  root = await environment.ok("PUT", `/api/tasks/${root.taskId}/definition`, {
    operationId: "op_qa054_assign_quorum_agents0001",
    expectedTaskRevision: root.taskRevision,
    title: root.title,
    goal: root.goal,
    ownerMemberId: root.ownerMemberId,
    completionPolicy: root.completionPolicy,
    priority: root.priority,
    dueAt: root.dueAt,
    criteria: root.criteria,
    assignments: [
      { agentId: agentIds[0], role: "primary" },
      { agentId: agentIds[1], role: "contributor" },
      { agentId: agentIds[2], role: "reviewer" }
    ],
    budgetPolicy: root.budgetPolicy
  });
  const tasks = new AgentTaskRepository(database);
  const discussions = new DiscussionRepository(database);
  const runs = new RunRepository(database);
  const transactions = new SqliteTransactionBoundary(database);
  const plans = new ExecutionPlanRepository(database);
  const drafts = new ExecutionPlanDraftWriter(
    transactions,
    plans,
    new ExecutionSourceRepository(database),
    tasks,
    core,
    () => undefined
  );
  const proposalService = new DiscussionPlanProposalService(
    transactions,
    core,
    discussions,
    drafts,
    tasks
  );
  const delivery = new DeliveryService(
    database,
    core,
    runs,
    new ContextPlanner(database, core, tasks),
    new BridgeConnectionRegistry(),
    () => clock.value
  );
  const orchestrator = new DiscussionOrchestrator(
    core,
    new MessageService(core, auth),
    discussions,
    runs,
    auth,
    tasks,
    () => clock.value,
    proposalService
  );
  const definition = structuredClone(environment.command().definition);
  for (const node of definition.nodes) {
    node.agentId = agentIds[0]!;
    node.task.ownerMemberId = environment.ownerMemberId;
  }
  return {
    ...environment,
    agentIds,
    clock,
    core,
    delivery,
    devicePrincipal,
    discussions,
    draft: proposalDraft(definition),
    orchestrator,
    plans,
    principal,
    root,
    runs,
    supplemental: new DiscussionSupplementalEvidenceService(
      core,
      discussions,
      runs,
      delivery,
      tasks
    )
  };
}

function count(database: ReturnType<typeof openDatabase>, table: string): number {
  return (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
    n: number;
  }).n;
}

async function reachFinalizer(t: TestContext) {
  const value = await wiredFixture(t);
  let result = value.orchestrator.create(value.principal, {
    roomId: value.roomId,
    taskId: value.root.taskId,
    goal: "Produce a bounded implementation plan.",
    participantAgentIds: [value.agentId, value.reviewerId],
    outputMode: "decision_record"
  });
  const assessment = {
    goalSatisfied: true,
    confidence: 0.98,
    newInformationAdded: true,
    disagreementRemaining: "none",
    recommendation: "finish"
  };
  for (const run of result.scheduledRuns) {
    completeRun(value.runs, run, "The plan is ready.", assessment);
    result = value.orchestrator.onRunTerminal(run.runId)!;
  }
  assert.equal(result.discussion.state, "finalizing");
  const finalRun = result.scheduledRuns[0];
  assert.ok(finalRun);
  assert.match(finalRun.instruction, /convenewire-plan-proposal/u);
  return { ...value, finalRun };
}

test("decision finalization atomically retains one immutable unapproved draft", async (t) => {
  const value = await reachFinalizer(t);
  const content = `Visible conclusion remains unchanged.\n${envelope(value.draft)}`;
  completeRun(value.runs, value.finalRun, content);
  const terminal = value.orchestrator.onRunTerminal(value.finalRun.runId)!;
  assert.equal(terminal.discussion.state, "completed");
  const finalTurn = terminal.turns.find(({ kind }) => kind === "finalization");
  assert.ok(finalTurn?.outputMessageId);
  assert.equal(value.core.getMessage(finalTurn.outputMessageId)?.content, content);
  assert.equal(count(value.database, "execution_plans"), 1);
  assert.equal(count(value.database, "execution_plan_approvals"), 0);
  assert.equal(count(value.database, "execution_plan_nodes"), 0);
  assert.equal(count(value.database, "runs"), 3);
  const planId = (value.database.prepare(
    "SELECT plan_id AS planId FROM execution_plans"
  ).get() as { planId: string }).planId;
  const plan = value.plans.get(planId)!;
  assert.equal(plan.state, "draft");
  assert.deepEqual(plan.current.author, {
    kind: "discussion",
    discussionId: terminal.discussion.discussionId
  });
  const sources = value.plans.sources(plan.current.decisionId);
  assert.deepEqual(sources.map(({ source, revision }) => ({ source, revision })), [
    {
      source: {
        evidenceRefId: "evidence_final_discussion",
        kind: "discussion",
        discussionId: terminal.discussion.discussionId
      },
      revision: terminal.discussion.version
    },
    {
      source: {
        evidenceRefId: "evidence_final_message",
        kind: "message",
        messageId: finalTurn.outputMessageId
      },
      revision: value.core.getMessage(finalTurn.outputMessageId)!.sequence
    }
  ]);

  const restartedDatabase = openDatabase(value.databasePath);
  t.after(() => restartedDatabase.close());
  const restartedCore = new CoreRepository(restartedDatabase);
  const restartedTasks = new AgentTaskRepository(restartedDatabase);
  const restartedDiscussions = new DiscussionRepository(restartedDatabase);
  const restartedPlans = new ExecutionPlanRepository(restartedDatabase);
  const replay = new DiscussionPlanProposalService(
    new SqliteTransactionBoundary(restartedDatabase),
    restartedCore,
    restartedDiscussions,
    new ExecutionPlanDraftWriter(
      new SqliteTransactionBoundary(restartedDatabase),
      restartedPlans,
      new ExecutionSourceRepository(restartedDatabase),
      restartedTasks,
      restartedCore,
      () => undefined
    ),
    restartedTasks
  ).reconcileTerminal(terminal.discussion.discussionId);
  assert.equal(replay?.planId, planId);
  assert.equal(count(restartedDatabase, "execution_plans"), 1);
});

test("read-only focused quorum produces an unapproved Plan and separate late evidence", {
  timeout: 30_000
}, async (t) => {
  const value = await quorumProposalFixture(t);
  let result = value.orchestrator.create(value.principal, {
    roomId: value.roomId,
    taskId: value.root.taskId,
    goal: "Produce a bounded implementation plan after focused review.",
    participantAgentIds: value.agentIds,
    mode: "review",
    outputMode: "decision_record",
    policy: {
      focusedParticipantLimit: 2,
      requireReviewer: true,
      waveCompletionMode: "read_only_quorum",
      quorumMinimumCompleted: 2,
      quorumSoftDeadlineSeconds: 30
    }
  });
  assert.equal(result.scheduledRuns.length, 3);
  const offers = new Map(result.scheduledRuns.map((run) => {
    const delivery = value.delivery.dispatch(run.runId);
    assert.ok(delivery?.payload.discussionSupplementalEvidence);
    return [run.runId, delivery!.payload.discussionSupplementalEvidence!];
  }));
  const [coder, lateSecurity, reviewer] = result.scheduledRuns;
  assert.ok(coder && lateSecurity && reviewer);
  stageRun(
    value.runs,
    lateSecurity,
    "LATE-SECURITY-EVIDENCE-MUST-NOT-ENTER-THE-PLAN",
    { newInformationAdded: true, recommendation: "continue" }
  );
  completeRun(value.runs, coder, "Open the exact security question.", {
    newInformationAdded: true,
    openQuestions: [{
      id: "question:qa054-security",
      question: "Which boundary keeps execution authority human-governed?",
      importance: "high"
    }],
    recommendation: "continue"
  });
  value.orchestrator.onRunTerminal(coder.runId);
  completeRun(value.runs, reviewer, "Review the bounded authority model.", {
    newInformationAdded: true,
    reviewerApproved: true,
    recommendation: "continue"
  });
  value.orchestrator.onRunTerminal(reviewer.runId);

  value.clock.value = "2026-08-31T12:00:31.000Z";
  const focusedRuns = value.orchestrator.sweepDueWaves();
  assert.equal(focusedRuns.length, 2);
  const afterSeal = value.orchestrator.get(
    value.principal,
    result.discussion.discussionId
  );
  assert.equal(afterSeal.seals.length, 1);
  assert.equal(afterSeal.waves[0]?.state, "partial");
  assert.equal(afterSeal.waves[1]?.selection?.strategy, "question_focused");
  assert.deepEqual(afterSeal.waves[1]?.selection?.selectedAgentIds, [
    value.agentIds[0],
    value.agentIds[2]
  ]);
  assert.equal(value.runs.getRun(lateSecurity.runId)?.state, "working");

  for (const run of focusedRuns) {
    const reviewerRun = run.targetAgentId === value.agentIds[2];
    completeRun(value.runs, run, "Resolve the focused authority question.", {
      goalSatisfied: true,
      confidence: 0.99,
      newInformationAdded: true,
      resolvedQuestionIds: ["question:qa054-security"],
      disagreementRemaining: "none",
      recommendation: "finish",
      ...(reviewerRun ? { reviewerApproved: true } : {})
    });
    result = value.orchestrator.onRunTerminal(run.runId)!;
  }
  assert.equal(result.discussion.state, "finalizing");
  const finalRun = result.scheduledRuns[0];
  assert.ok(finalRun);
  completeRun(
    value.runs,
    finalRun,
    `Human-readable conclusion.\n${envelope(value.draft)}`
  );
  result = value.orchestrator.onRunTerminal(finalRun.runId)!;
  assert.equal(result.discussion.state, "completed");
  const plan = value.plans.listForRootTask(value.root.taskId, "", 10).plans[0];
  assert.ok(plan);
  assert.equal(plan.state, "draft");
  assert.deepEqual(plan.current.author, {
    kind: "discussion",
    discussionId: result.discussion.discussionId
  });
  assert.equal(count(value.database, "execution_plan_approvals"), 0);
  assert.equal(count(value.database, "execution_plan_nodes"), 0);
  assert.equal(count(value.database, "execution_dispatch_intents"), 0);

  finishStagedRun(value.runs, lateSecurity);
  value.orchestrator.onRunTerminal(lateSecurity.runId);
  const offer = offers.get(lateSecurity.runId)!;
  const retained = value.supplemental.submit(value.devicePrincipal, {
    operationId: offer.operationId,
    discussionId: offer.discussionId,
    waveId: offer.waveId,
    turnId: offer.turnId,
    runId: lateSecurity.runId,
    traceId: lateSecurity.traceId,
    agentId: lateSecurity.targetAgentId,
    sourceReplySequence: 2
  }, value.clock.value);
  assert.equal(retained.state, "retained");
  const audit = value.orchestrator.get(
    value.principal,
    result.discussion.discussionId
  );
  assert.equal(audit.seals.length, 1);
  assert.equal(audit.supplementalEvidence.length, 1);
  assert.equal(count(value.database, "execution_plan_approvals"), 0,
    "late evidence and quorum never approve the Plan");
  assert.equal(count(value.database, "execution_evidence_adoptions"), 0,
    "Discussion facts never satisfy execution proof gates");
});

test("missing and domain-invalid envelopes finish visibly without a plan", async (t) => {
  const missing = await reachFinalizer(t);
  completeRun(missing.runs, missing.finalRun, "Visible conclusion only.");
  const first = missing.orchestrator.onRunTerminal(missing.finalRun.runId)!;
  assert.equal(first.discussion.state, "completed");
  assert.equal(count(missing.database, "execution_plans"), 0);

  const invalid = await reachFinalizer(t);
  const duplicateNode = structuredClone(invalid.draft) as unknown as {
    nodes: unknown[];
  };
  duplicateNode.nodes.push(structuredClone(duplicateNode.nodes[0]));
  const invalidContent = `Invalid topology remains visible.\n${envelope(duplicateNode)}`;
  completeRun(invalid.runs, invalid.finalRun, invalidContent);
  const second = invalid.orchestrator.onRunTerminal(invalid.finalRun.runId)!;
  assert.equal(second.discussion.state, "completed");
  assert.equal(count(invalid.database, "execution_plans"), 0);
  const finalTurn = second.turns.find(({ kind }) => kind === "finalization")!;
  assert.equal(invalid.core.getMessage(finalTurn.outputMessageId!)?.content, invalidContent);
});

test("proposal persistence failure rolls final closure back and recovery completes once", async (t) => {
  const value = await reachFinalizer(t);
  completeRun(
    value.runs,
    value.finalRun,
    `Visible conclusion.\n${envelope(value.draft)}`
  );
  value.database.exec(`
    CREATE TEMP TRIGGER fail_discussion_proposal
    BEFORE INSERT ON execution_decisions
    BEGIN SELECT RAISE(ABORT, 'injected proposal persistence failure'); END
  `);
  assert.throws(
    () => value.orchestrator.onRunTerminal(value.finalRun.runId),
    /injected proposal persistence failure/u
  );
  assert.equal(value.discussions.get(
    value.discussions.findTurnByRun(value.finalRun.runId)!.discussionId
  )?.state, "finalizing");
  assert.equal(value.discussions.getWave(
    value.discussions.findTurnByRun(value.finalRun.runId)!.waveId!
  )?.state, "open");
  assert.equal(count(value.database, "execution_plans"), 0);
  value.database.exec("DROP TRIGGER fail_discussion_proposal");
  value.orchestrator.recover();
  assert.equal(value.discussions.get(
    value.discussions.findTurnByRun(value.finalRun.runId)!.discussionId
  )?.state, "completed");
  assert.equal(count(value.database, "execution_plans"), 1);
});
