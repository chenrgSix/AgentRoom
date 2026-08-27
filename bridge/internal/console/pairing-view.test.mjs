import assert from "node:assert/strict";
import test from "node:test";
import { pairingView } from "./static/pairing-view.mjs";

const now = Date.parse("2026-08-26T00:00:00Z");
const paired = {
  configured: true, paired: true, teamId: "team_original", deviceId: "device_original",
  bridgeRunning: false, connection: {state: "stopped"}, enrollment: {canRequest: true},
};

test("paired Console retains binding and explicit recovery without treating credentials as online", () => {
  const view = pairingView(paired, now);
  assert.equal(view.status, "已保存配对");
  assert.match(view.binding, /team_original/);
  assert.equal(view.showRequest, true);
  assert.equal(view.canStartExisting, true);
  assert.equal(view.showApproval, false);
  assert.equal(view.canCopy, false);
});

test("online but missing Web Agents points to user and Team scope, not automatic re-pairing", () => {
  const view = pairingView({...paired, bridgeRunning: true, connection: {state: "online"}, enrollment: {canRequest: false}}, now);
  assert.match(view.guidance, /网页用户/);
  assert.match(view.guidance, /不会恢复旧 Team/);
  assert.equal(view.canRequest, false);
  assert.equal(view.canStartExisting, false);
});

test("pending code is copyable with countdown and blocks concurrent start", () => {
  const view = pairingView({...paired, joinCode: "ABCD-1234", joinExpiresAt: new Date(now + 61_000).toISOString(), enrollment: {active: true, recovery: true}}, now);
  assert.equal(view.codeText, "ABCD-1234");
  assert.equal(view.canCopy, true);
  assert.match(view.expiry, /1 分 1 秒/);
  assert.equal(view.canRequest, false);
  assert.equal(view.canStartExisting, false);
  assert.equal(view.canCancel, true);
});

test("Device pairing shows a non-copyable verification phrase and its own expiry", () => {
  const view = pairingView({
    configured: false, paired: false,
    enrollment: {
      active: true, pairingMethod: "link", pairingState: "claimed",
      verificationPhrase: "violet river", pairingExpiresAt: new Date(now + 61_000).toISOString()
    }
  }, now);
  assert.equal(view.status, "等待确认短语");
  assert.equal(view.codeText, "violet river");
  assert.equal(view.canCopy, false);
  assert.match(view.approvalTitle, /完全相同/);
  assert.match(view.guidance, /本机配置与 Runtime 操作保持锁定/);
  assert.match(view.expiry, /配对有效期/);
});

test("expired code is never copyable even if the last state still contains it", () => {
  const view = pairingView({...paired, joinCode: "ABCD-1234", joinExpiresAt: new Date(now - 1).toISOString(), enrollment: {active: true}}, now);
  assert.equal(view.canCopy, false);
  assert.equal(view.codeText, "审批码已过期");
  assert.equal(view.canRequest, true);
  assert.equal(view.requestLabel, "重新申请审批码");
});

test("invalid deadline and consumed code cannot be copied", () => {
  for (const state of [
    {...paired, joinCode: "ABCD-1234", joinExpiresAt: "invalid", enrollment: {active: true}},
    {...paired, joinCode: "ABCD-1234", joinExpiresAt: new Date(now + 61_000).toISOString()},
  ]) assert.equal(pairingView(state, now).canCopy, false);
});

test("a completed request never resurfaces as expired after its old deadline", () => {
  const view = pairingView({...paired, joinCode: "ABCD-1234", joinExpiresAt: new Date(now - 1).toISOString(), enrollment: {active: false, canRequest: true, codeExpired: true}}, now);
  assert.equal(view.showApproval, false);
  assert.equal(view.canCopy, false);
  assert.equal(view.requestLabel, "申请新审批码（重新配对）");
});

test("connection and recovery failure guidance preserves old identity", () => {
  assert.match(pairingView({...paired, connection: {state: "retrying"}}, now).guidance, /协议错误不等于配对失效/);
  assert.match(pairingView({...paired, lastError: "save failed", enrollment: {recovery: true}}, now).guidance, /旧配对仍保留/);
});

test("unconfigured setup has instructions but no misleading re-pair action", () => {
  const view = pairingView({configured: false, paired: false}, now);
  assert.equal(view.showRequest, false);
  assert.equal(view.canStartExisting, false);
  assert.match(view.guidance, /无需打开终端/);
});
