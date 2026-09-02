import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import type {
  DiscussionPlanProposalDraft,
  ExecutionPlanDefinition
} from "@convene-wire/contracts/execution-plan";

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
import { ExecutionPlanDraftWriter } from
  "../src/execution/execution-plan-draft-writer.js";
import { ExecutionPlanRepository } from
  "../src/execution/execution-plan-repository.js";
import { ExecutionSourceRepository } from
  "../src/execution/execution-source-repository.js";
import { RunRepository, type RunRecord } from
  "../src/run/run-repository.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";
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
