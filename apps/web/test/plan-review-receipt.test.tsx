import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";

import {
  clearPendingPlanReview,
  readPendingPlanReview,
  savePendingPlanReview,
  type PlanReviewReceiptScope
} from "../src/features/work/plan-review-receipt.js";

const scope: PlanReviewReceiptScope = {
  memberId: "member_plan_owner0001",
  teamId: "team_plan_review0001",
  taskId: "task_plan_review0001",
  planId: "plan_review_pending0001"
};
const command = {
  operationId: "op_plan_review_pending0001",
  expectedRevision: 2,
  expectedDigest: "a".repeat(64),
  expectedRootTaskRevision: 7,
  decision: "approved" as const,
  reason: "Approve the exact reviewed graph."
};

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example.com/"
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: dom.window
  });
  return dom;
}

test("pending plan review survives refresh with pins and no plan or credentials", () => {
  const first = installDom();
  savePendingPlanReview(scope, command);
  const key = first.window.sessionStorage.key(0)!;
  const raw = first.window.sessionStorage.getItem(key)!;
  assert.deepEqual(JSON.parse(raw), { version: 1, ...scope, command });
  assert.doesNotMatch(raw, /authorization|token|definition|sourceBytes/iu);
  first.window.close();

  const refreshed = installDom();
  try {
    refreshed.window.sessionStorage.setItem(key, raw);
    assert.deepEqual(readPendingPlanReview(scope), command);
    assert.equal(readPendingPlanReview({ ...scope, planId: "plan_other_0001" }), null);
    clearPendingPlanReview(scope, command);
    assert.equal(readPendingPlanReview(scope), null);
  } finally {
    refreshed.window.close();
  }
});

test("pending plan review fails closed for overwrite corruption and storage loss", () => {
  const dom = installDom();
  try {
    savePendingPlanReview(scope, command);
    assert.throws(() => savePendingPlanReview(scope, {
      ...command,
      operationId: "op_plan_review_other0001"
    }), /unresolved/u);
    assert.throws(() => clearPendingPlanReview(scope, {
      ...command,
      reason: "Changed"
    }), /changed/u);
    const key = dom.window.sessionStorage.key(0)!;
    dom.window.sessionStorage.setItem(key, "{broken");
    assert.throws(() => readPendingPlanReview(scope));
    assert.equal(dom.window.sessionStorage.getItem(key), "{broken");
  } finally {
    dom.window.close();
  }

  const denied = installDom();
  try {
    Object.defineProperty(denied.window, "sessionStorage", {
      configurable: true,
      get() { throw new Error("Storage denied"); }
    });
    assert.throws(() => readPendingPlanReview(scope), /denied/u);
  } finally {
    denied.window.close();
  }
});
