import assert from "node:assert/strict";
import test from "node:test";

import {
  assertExecutionCommand,
  executionOperationDigest
} from "../src/execution-validation.mjs";

const at = "2026-09-03T00:00:00.000Z";
const planId = "plan_scheduler0001";
const memberId = "member_scheduler0001";
const digest = "a".repeat(64);

test("scheduler control commands and receipts are closed exact values", () => {
  const control = {
    planId,
    mode: "automatic",
    modeRevision: 1,
    lastOperationId: null,
    updatedByMemberId: null,
    reason: "Initial automatic scheduler mode.",
    updatedAt: at
  };
  const modeCommand = {
    operationId: "op_scheduler_mode0001",
    expectedPlanRevision: 1,
    expectedPlanDigest: digest,
    expectedPlanControlRevision: 1,
    expectedModeRevision: 1,
    mode: "manual",
    reason: "Require an exact node selection."
  };
  const manualCommand = {
    operationId: "op_scheduler_manual0001",
    expectedPlanRevision: 1,
    expectedPlanDigest: digest,
    expectedPlanControlRevision: 1,
    expectedModeRevision: 2,
    nodeKey: "Build",
    expectedNodeProjectionRevision: 3,
    reason: "Dispatch only Build."
  };
  const advanceCommand = {
    operationId: "op_scheduler_advance0001",
    expectedPlanRevision: 1,
    expectedPlanDigest: digest,
    expectedPlanControlRevision: 1,
    expectedModeRevision: 3,
    reason: "Advance one deterministic candidate."
  };
  const modeUnsigned = {
    operationId: modeCommand.operationId,
    planId,
    planRevision: 1,
    planDigest: digest,
    planControlRevision: 1,
    previousMode: "automatic",
    previousModeRevision: 1,
    mode: "manual",
    modeRevision: 2,
    updatedByMemberId: memberId,
    reason: modeCommand.reason,
    requestDigest: "b".repeat(64),
    updatedAt: at
  };
  const dispatchUnsigned = {
    operationId: manualCommand.operationId,
    action: "manual_dispatch",
    planId,
    planRevision: 1,
    planDigest: digest,
    planControlRevision: 1,
    mode: "manual",
    modeRevision: 2,
    requestedByMemberId: memberId,
    reason: manualCommand.reason,
    selection: {
      nodeKey: "Build",
      dispatchIntentId: "dispatch_scheduler0001",
      runId: "run_scheduler0001"
    },
    requestDigest: "c".repeat(64),
    createdAt: at
  };
  const values = [
    ["schedulerControl", control],
    ["schedulerModeCommand", modeCommand],
    ["schedulerManualDispatchCommand", manualCommand],
    ["schedulerAdvanceCommand", advanceCommand],
    ["schedulerModeReceipt", {
      ...modeUnsigned,
      operationDigest: executionOperationDigest(modeUnsigned)
    }],
    ["schedulerDispatchReceipt", {
      ...dispatchUnsigned,
      operationDigest: executionOperationDigest(dispatchUnsigned)
    }]
  ];
  for (const [kind, value] of values) {
    assert.doesNotThrow(() => assertExecutionCommand(kind, value));
    assert.throws(() => assertExecutionCommand(kind, {
      ...value,
      command: "unbounded work"
    }));
  }
});

test("scheduler controls reject invalid modes, revisions and selections", () => {
  const command = {
    operationId: "op_scheduler_invalid0001",
    expectedPlanRevision: 1,
    expectedPlanDigest: digest,
    expectedPlanControlRevision: 1,
    expectedModeRevision: 1,
    mode: "manual",
    reason: "Use manual scheduling."
  };
  for (const mutation of [
    { ...command, mode: "adaptive" },
    { ...command, expectedModeRevision: 0 },
    { ...command, expectedPlanDigest: "A".repeat(64) }
  ]) {
    assert.throws(() => assertExecutionCommand(
      "schedulerModeCommand",
      mutation
    ));
  }
  assert.throws(() => assertExecutionCommand("schedulerDispatchReceipt", {
    operationId: "op_scheduler_invalid_receipt0001",
    action: "supervised_advance",
    planId,
    planRevision: 1,
    planDigest: digest,
    planControlRevision: 1,
    mode: "supervised",
    modeRevision: 2,
    requestedByMemberId: memberId,
    reason: "Advance once.",
    selection: {
      nodeKey: "Build",
      dispatchIntentId: "not-an-intent",
      runId: "run_scheduler0001"
    },
    requestDigest: "b".repeat(64),
    operationDigest: "c".repeat(64),
    createdAt: at
  }));
});
