import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExecutionSchedulerModeCommand,
  ExecutionSchedulerModeReceipt
} from "@convene-wire/contracts/execution-plan";
import { assertExecutionCommand, executionOperationDigest } from
  "@convene-wire/contracts/execution-validation";
import { fixture } from "./helpers/execution-plan-fixture.js";

test("scheduler mode control is independent, exact, replayable and owner-governed", async (t) => {
  const f = await fixture(t);
  const plan = await f.create();
  const initial = await f.ok(
    "GET",
    `/api/execution-plans/${plan.planId}/scheduler`
  );
  assert.deepEqual(initial, {
    planId: plan.planId,
    mode: "automatic",
    modeRevision: 1,
    lastOperationId: null,
    updatedByMemberId: null,
    reason: "Initial automatic scheduler mode.",
    updatedAt: plan.createdAt
  });
  assert.equal((f.database.prepare(`
    SELECT count(*) AS n FROM execution_scheduler_controls WHERE plan_id = ?
  `).get(plan.planId) as { n: number }).n, 1);

  const command: ExecutionSchedulerModeCommand = {
    operationId: "op_scheduler_mode_manual0001",
    expectedPlanRevision: plan.current.revision,
    expectedPlanDigest: plan.current.digest,
    expectedPlanControlRevision: plan.controlRevision,
    expectedModeRevision: initial.modeRevision,
    mode: "manual",
    reason: "Require exact human-selected node dispatch."
  };
  const receipt = await f.ok(
    "POST",
    `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
    command
  ) as ExecutionSchedulerModeReceipt;
  const { operationDigest: _, ...unsigned } = receipt;
  assert.equal(receipt.operationDigest, executionOperationDigest(unsigned));
  assert.equal(receipt.previousMode, "automatic");
  assert.equal(receipt.previousModeRevision, 1);
  assert.equal(receipt.mode, "manual");
  assert.equal(receipt.modeRevision, 2);
  assert.equal(receipt.updatedByMemberId, f.ownerMemberId);
  assert.equal(receipt.requestDigest, executionOperationDigest({
    action: "execution_scheduler_mode_v1",
    planId: plan.planId,
    actor: { kind: "member", memberId: f.ownerMemberId },
    command
  }));
  assert.equal(
    (await f.ok("GET", `/api/execution-plans/${plan.planId}`)).controlRevision,
    plan.controlRevision,
    "mode transitions must not invalidate frozen Run/proof control pins"
  );
  assert.deepEqual(await f.ok(
    "POST",
    `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
    command
  ), receipt);

  await f.restart();
  assert.deepEqual(await f.ok(
    "POST",
    `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
    command
  ), receipt);
  assert.equal((await f.ok(
    "GET",
    `/api/execution-plans/${plan.planId}/scheduler`
  )).mode, "manual");

  const conflict = await f.request(
    "POST",
    `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
    { ...command, reason: "Substitute a different operation payload." }
  );
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.match(conflict.body, /EXECUTION_OPERATION_CONFLICT/u);

  const stale = await f.request(
    "POST",
    `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
    {
      ...command,
      operationId: "op_scheduler_mode_stale0001",
      mode: "supervised"
    }
  );
  assert.equal(stale.statusCode, 409, stale.body);
  assert.match(stale.body, /EXECUTION_SCHEDULER_MODE_CONFLICT/u);

  const stalePlanPins = [
    {
      operationId: "op_scheduler_plan_revision0001",
      expectedPlanRevision: plan.current.revision + 1
    },
    {
      operationId: "op_scheduler_plan_digest0001",
      expectedPlanDigest: "f".repeat(64)
    },
    {
      operationId: "op_scheduler_plan_control0001",
      expectedPlanControlRevision: plan.controlRevision + 1
    }
  ];
  for (const stalePin of stalePlanPins) {
    const response = await f.request(
      "POST",
      `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
      {
        ...command,
        operationId: stalePin.operationId,
        expectedModeRevision: 2,
        mode: "supervised",
        ...stalePin
      }
    );
    assert.equal(response.statusCode, 409, response.body);
    assert.match(response.body, /EXECUTION_SCHEDULER_PLAN_CONFLICT/u);
    assert.equal((f.database.prepare(`
      SELECT count(*) AS n FROM execution_scheduler_operations
      WHERE operation_id = ?
    `).get(stalePin.operationId) as { n: number }).n, 0);
  }

  const participant = await f.participant();
  const denied = await f.request(
    "POST",
    `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
    {
      ...command,
      operationId: "op_scheduler_mode_denied0001",
      expectedModeRevision: 2,
      mode: "supervised"
    },
    participant.authorization
  );
  assert.equal(denied.statusCode, 403, denied.body);
  const detachedCommand = {
    ...command,
    operationId: "op_scheduler_sql_denied0001",
    expectedModeRevision: 2,
    mode: "supervised" as const,
    reason: "A non-owner cannot manufacture scheduler authority in SQL."
  };
  assert.throws(() => f.database.prepare(`
    INSERT INTO execution_scheduler_operations (
      operation_id, action, plan_id, plan_revision, plan_digest,
      plan_control_revision, expected_mode, expected_mode_revision,
      target_mode, node_key, expected_node_projection_revision,
      requested_by_member_id, reason, request_digest, request_json, created_at
    ) VALUES (?, 'mode_transition', ?, ?, ?, ?, 'manual', 2,
      'supervised', NULL, NULL, ?, ?, ?, ?, ?)
  `).run(
    detachedCommand.operationId,
    plan.planId,
    plan.current.revision,
    plan.current.digest,
    plan.controlRevision,
    participant.memberId,
    detachedCommand.reason,
    "a".repeat(64),
    JSON.stringify(detachedCommand),
    plan.updatedAt
  ), /operation scope is not current/u);

  const competing = await Promise.all([
    f.request(
      "POST",
      `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
      {
        ...command,
        operationId: "op_scheduler_mode_race_a0001",
        expectedModeRevision: 2,
        mode: "supervised",
        reason: "First exact competing transition."
      }
    ),
    f.request(
      "POST",
      `/api/execution-plans/${plan.planId}/scheduler/mode-transitions`,
      {
        ...command,
        operationId: "op_scheduler_mode_race_b0001",
        expectedModeRevision: 2,
        mode: "automatic",
        reason: "Second exact competing transition."
      }
    )
  ]);
  assert.deepEqual(competing.map((response) => response.statusCode).sort(), [
    200,
    409
  ]);
  assert.equal((await f.ok(
    "GET",
    `/api/execution-plans/${plan.planId}/scheduler`
  )).modeRevision, 3);

  assert.throws(() => f.database.prepare(`
    UPDATE execution_scheduler_controls SET mode = 'automatic'
    WHERE plan_id = ?
  `).run(plan.planId), /transition is invalid/u);
  assert.throws(() => f.database.prepare(`
    UPDATE execution_scheduler_operations SET reason = 'rewritten'
    WHERE operation_id = ?
  `).run(command.operationId), /operation is immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM execution_scheduler_receipts WHERE operation_id = ?
  `).run(command.operationId), /receipt is immutable/u);
  assert.deepEqual(f.database.pragma("foreign_key_check"), []);
});

test("scheduler mode contracts reject open or ambiguous commands", () => {
  const command: ExecutionSchedulerModeCommand = {
    operationId: "op_scheduler_contract0001",
    expectedPlanRevision: 1,
    expectedPlanDigest: "a".repeat(64),
    expectedPlanControlRevision: 1,
    expectedModeRevision: 1,
    mode: "manual",
    reason: "Use exact manual scheduling."
  };
  assert.doesNotThrow(() => assertExecutionCommand(
    "schedulerModeCommand",
    command
  ));
  assert.throws(() => assertExecutionCommand(
    "schedulerModeCommand",
    { ...command, command: "run everything" }
  ));
  assert.throws(() => assertExecutionCommand(
    "schedulerModeCommand",
    { ...command, expectedModeRevision: 0 }
  ));
});
