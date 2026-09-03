import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanSupersessionCandidate
} from "@convene-wire/contracts/execution-plan";

import { fixture } from "./helpers/execution-plan-fixture.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function approve(f: Fixture): Promise<ExecutionPlanProjection> {
  const draft = await f.create();
  return (await f.ok(
    "POST",
    `/api/execution-plans/${draft.planId}/approvals`,
    {
      operationId: "op_supersession_initial_approval0001",
      expectedRevision: draft.current.revision,
      expectedDigest: draft.current.digest,
      expectedRootTaskRevision: f.root.taskRevision,
      decision: "approved",
      reason: "Approve the exact initial execution graph."
    }
  )).plan as ExecutionPlanProjection;
}

async function existingTaskDefinition(
  f: Fixture,
  plan: ExecutionPlanProjection
): Promise<ExecutionPlanDefinition> {
  const definition = structuredClone(plan.current.definition) as
    ExecutionPlanDefinition;
  for (const node of definition.nodes) {
    const compiled = plan.compiledTasks.find((entry) =>
      entry.nodeKey === node.nodeKey
    );
    assert.ok(compiled);
    const task = await f.ok("GET", `/api/tasks/${compiled.taskId}`);
    node.task = {
      mode: "existing",
      taskId: task.taskId,
      expectedTaskRevision: task.taskRevision,
      definitionRevision: task.definitionRevision,
      criteriaRevision: task.criteriaRevision
    };
  }
  definition.title = "Replanned bounded execution";
  definition.decision.summary = "Retain authority while replacing the active topology revision.";
  return definition;
}

async function propose(
  f: Fixture,
  plan: ExecutionPlanProjection,
  definition: ExecutionPlanDefinition
): Promise<ExecutionPlanSupersessionCandidate> {
  const root = await f.ok("GET", `/api/tasks/${plan.rootTaskId}`);
  return f.ok(
    "POST",
    `/api/execution-plans/${plan.planId}/supersession-candidates`,
    {
      operationId: "op_supersession_candidate0001",
      expectedCurrentRevision: plan.current.revision,
      expectedCurrentDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      expectedRootTaskRevision: root.taskRevision,
      definition,
      reason: "Propose an immutable next revision without advancing authority."
    }
  );
}

function activation(
  plan: ExecutionPlanProjection,
  candidate: ExecutionPlanSupersessionCandidate,
  rootTaskRevision: number
) {
  return {
    operationId: "op_supersession_activation0001",
    candidateId: candidate.candidateId,
    expectedCandidateRevision: candidate.candidateRevision,
    expectedCandidateDigest: candidate.candidateDigest,
    expectedCurrentRevision: plan.current.revision,
    expectedCurrentDigest: plan.current.digest,
    expectedControlRevision: plan.controlRevision,
    expectedRootTaskRevision: rootTaskRevision,
    carryForward: [],
    reason: "Activate the exact reviewed candidate."
  };
}

test("supersession candidate is inert until one atomic human activation", async (t) => {
  const f = await fixture(t);
  const plan = await approve(f);
  const definition = await existingTaskDefinition(f, plan);
  const candidate = await propose(f, plan, definition);

  const inert = await f.ok("GET", `/api/execution-plans/${plan.planId}`);
  assert.equal(inert.current.revision, 1);
  assert.equal(inert.controlRevision, 2);
  assert.deepEqual(
    await f.ok("GET", `/api/execution-plans/${plan.planId}/supersession-candidate`),
    candidate
  );
  assert.deepEqual(
    f.database.prepare(`
      SELECT DISTINCT revision FROM execution_plan_task_claims
      WHERE plan_id = ?
    `).all(plan.planId),
    [{ revision: 1 }]
  );
  assert.throws(() => f.database.prepare(`
    UPDATE execution_plan_supersession_candidates SET reason = 'changed'
    WHERE candidate_id = ?
  `).run(candidate.candidateId), /immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_plan_supersession_candidates WHERE candidate_id = ?
  `).run(candidate.candidateId), /retained/u);
  const competingCandidate = await f.request(
    "POST",
    `/api/execution-plans/${plan.planId}/supersession-candidates`,
    {
      operationId: "op_supersession_candidate0002",
      expectedCurrentRevision: plan.current.revision,
      expectedCurrentDigest: plan.current.digest,
      expectedControlRevision: plan.controlRevision,
      expectedRootTaskRevision: candidate.rootTaskRevision,
      definition,
      reason: "A second pending candidate must lose."
    }
  );
  assert.equal(competingCandidate.statusCode, 409);

  const root = await f.ok("GET", `/api/tasks/${plan.rootTaskId}`);
  const commands = [
    activation(plan, candidate, root.taskRevision),
    {
      ...activation(plan, candidate, root.taskRevision),
      operationId: "op_supersession_activation0002"
    }
  ];
  const attempts = await Promise.all(commands.map((command) => f.request(
    "POST",
    `/api/execution-plans/${plan.planId}/supersession-activations`,
    command
  )));
  assert.deepEqual(attempts.map(({ statusCode }) => statusCode).sort(),
    [200, 409]);
  const winner = attempts.find(({ statusCode }) => statusCode === 200)!;
  const winnerIndex = attempts.indexOf(winner);
  const command = commands[winnerIndex]!;
  const receipt = winner.json();
  assert.equal(receipt.plan.current.revision, 2);
  assert.equal(receipt.plan.current.digest, candidate.candidateDigest);
  assert.equal(receipt.plan.controlRevision, 3);
  assert.deepEqual(receipt.carryForward, []);
  assert.equal(receipt.activatedBy.kind, "member");
  assert.equal(receipt.activatedBy.memberId, f.ownerMemberId);
  assert.deepEqual(
    f.database.prepare(`
      SELECT DISTINCT revision FROM execution_plan_task_claims
      WHERE plan_id = ?
    `).all(plan.planId),
    [{ revision: 2 }]
  );
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_plan_supersession_activations
  `).get() as { n: number }).n, 1);
  assert.deepEqual(await f.ok(
    "POST",
    `/api/execution-plans/${plan.planId}/supersession-activations`,
    command
  ), receipt);
  await f.restart();
  assert.deepEqual(await f.ok(
    "POST",
    `/api/execution-plans/${plan.planId}/supersession-activations`,
    command
  ), receipt);
});

test("supersession activation rollback leaves current authority untouched", async (t) => {
  const f = await fixture(t);
  const plan = await approve(f);
  const candidate = await propose(f, plan, await existingTaskDefinition(f, plan));
  const root = await f.ok("GET", `/api/tasks/${plan.rootTaskId}`);
  const before = {
    rootRevision: root.taskRevision,
    claims: f.database.prepare(`
      SELECT * FROM execution_plan_task_claims WHERE plan_id = ?
      ORDER BY task_id
    `).all(plan.planId)
  };
  f.database.exec(`
    CREATE TRIGGER execution_supersession_test_abort
    BEFORE INSERT ON execution_plan_approvals
    WHEN NEW.plan_id = '${plan.planId}' AND NEW.revision = 2
    BEGIN SELECT RAISE(ABORT, 'simulated private activation failure'); END
  `);
  const response = await f.request(
    "POST",
    `/api/execution-plans/${plan.planId}/supersession-activations`,
    activation(plan, candidate, root.taskRevision)
  );
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.body.includes("private activation failure"), false);
  assert.equal((await f.ok("GET", `/api/execution-plans/${plan.planId}`)).current.revision, 1);
  assert.equal((await f.ok("GET", `/api/tasks/${plan.rootTaskId}`)).taskRevision,
    before.rootRevision);
  assert.deepEqual(f.database.prepare(`
    SELECT * FROM execution_plan_task_claims WHERE plan_id = ?
    ORDER BY task_id
  `).all(plan.planId), before.claims);
  for (const table of [
    "execution_plan_supersession_activations",
    "execution_plan_supersession_receipts"
  ]) {
    assert.equal((f.database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    }).n, 0);
  }
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_plan_nodes WHERE plan_id = ? AND revision = 2
  `).get(plan.planId) as { n: number }).n, 0);
  f.database.exec("DROP TRIGGER execution_supersession_test_abort");
});
