import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { clearRecoveryReceipt, readRecoveryReceipt, saveRecoveryReceipt, type RecoveryReceiptScope } from "../src/features/work/recovery-receipt.js";

const scope: RecoveryReceiptScope = { memberId: "member_owner_0001", teamId: "team_receipt_0001", taskId: "task_receipt_0001", runId: "run_receipt_0001" };
const command = { operationId: "op_recovery_0001", expectedTaskRevision: 7 };

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://team.example.com/" });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  return dom;
}

test("recovery receipts survive a fresh page with the exact payload and no authentication secrets", () => {
  const first = installDom();
  saveRecoveryReceipt(scope, "retry", command);
  const key = first.window.sessionStorage.key(0)!;
  const persisted = first.window.sessionStorage.getItem(key)!;
  assert.deepEqual(JSON.parse(persisted), { version: 1, ...scope, kind: "retry", command });
  assert.doesNotMatch(persisted, /token|apiKey|authorization/iu);
  first.window.close();
  const refreshed = installDom();
  try {
    refreshed.window.sessionStorage.setItem(key, persisted);
    assert.deepEqual(readRecoveryReceipt(scope, "retry"), command);
    for (const field of ["memberId", "teamId", "taskId", "runId"] as const) {
      assert.equal(readRecoveryReceipt({ ...scope, [field]: `${scope[field]}_other` }, "retry"), null);
    }
    assert.equal(readRecoveryReceipt(scope, "ack"), null);
  } finally { refreshed.window.close(); }
});

test("pending receipts cannot be overwritten or cleared by another operation", () => {
  const dom = installDom();
  try {
    saveRecoveryReceipt(scope, "retry", command);
    const other = { ...command, operationId: "op_other_retry_0001" };
    assert.throws(() => saveRecoveryReceipt(scope, "retry", other), /unresolved/u);
    assert.throws(() => clearRecoveryReceipt(scope, "retry", other), /changed/u);
    assert.deepEqual(readRecoveryReceipt(scope, "retry"), command);
    clearRecoveryReceipt(scope, "retry", command);
    assert.equal(readRecoveryReceipt(scope, "retry"), null);
  } finally { dom.window.close(); }
});

test("acknowledgement receipts retain their original evidence and revision", () => {
  const dom = installDom();
  try {
    const acknowledgement = { ...command, reason: "Checked the remote effects and retained the evidence." };
    saveRecoveryReceipt(scope, "ack", acknowledgement);
    assert.deepEqual(readRecoveryReceipt(scope, "ack"), acknowledgement);
    assert.throws(() => saveRecoveryReceipt(scope, "ack", { ...acknowledgement, expectedTaskRevision: 8 }), /unresolved/u);
    assert.throws(() => saveRecoveryReceipt(scope, "ack", { ...acknowledgement, reason: "A different observation" }), /unresolved/u);
    assert.deepEqual(readRecoveryReceipt(scope, "ack"), acknowledgement);
    assert.throws(() => saveRecoveryReceipt(scope, "retry", { ...command, reason: "Unexpected extra field" }), /cannot be verified/u);
  } finally { dom.window.close(); }
});

test("corrupt or foreign-scoped receipts fail closed without erasing evidence", () => {
  const dom = installDom();
  try {
    saveRecoveryReceipt(scope, "retry", command);
    const key = dom.window.sessionStorage.key(0)!;
    for (const raw of ["{broken", JSON.stringify({ version: 1, ...scope, memberId: "member_other", kind: "retry", command })]) {
      dom.window.sessionStorage.setItem(key, raw);
      assert.throws(() => readRecoveryReceipt(scope, "retry"));
      assert.throws(() => saveRecoveryReceipt(scope, "retry", command));
      assert.equal(dom.window.sessionStorage.getItem(key), raw);
    }
  } finally { dom.window.close(); }
});

test("receipt persistence detects unavailable storage and silent write loss", () => {
  const dom = installDom();
  try {
    Object.defineProperty(dom.window, "sessionStorage", { configurable: true, get() { throw new Error("Storage denied"); } });
    assert.throws(() => readRecoveryReceipt(scope, "retry"), /denied/u);
    assert.throws(() => saveRecoveryReceipt(scope, "retry", command), /denied/u);
    Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: { getItem: () => null, setItem: () => undefined } });
    assert.throws(() => saveRecoveryReceipt(scope, "retry", command), /not persisted/u);
  } finally { dom.window.close(); }
});
