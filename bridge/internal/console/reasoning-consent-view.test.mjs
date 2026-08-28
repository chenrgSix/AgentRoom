import assert from "node:assert/strict";
import test from "node:test";

import {reasoningConsentView} from "./static/reasoning-consent-view.mjs";

test("running idle Bridge offers an explicit stop without changing consent", () => {
  const view = reasoningConsentView({
    paired: true,
    bridgeRunning: true,
    reasoningConsentEditable: false,
    agents: [{activeRuns: 0}]
  });

  assert.equal(view.action, "stop");
  assert.equal(view.disabled, false);
  assert.match(view.guidance, /只停止连接，不会修改当前授权/);
});

test("active Runs fence the privacy stop action", () => {
  const view = reasoningConsentView({
    paired: true,
    bridgeRunning: true,
    reasoningConsentEditable: false,
    agents: [{activeRuns: 2}]
  });

  assert.equal(view.action, "stop");
  assert.equal(view.disabled, true);
  assert.match(view.guidance, /2 个任务正在执行/);
});

test("stopping Bridge stays disabled until the backend worker drains", () => {
  const view = reasoningConsentView({
    paired: true,
    bridgeRunning: false,
    reasoningConsentEditable: false,
    agents: [{activeRuns: 0}]
  });

  assert.equal(view.action, "edit");
  assert.equal(view.disabled, true);
  assert.match(view.guidance, /正在停止/);
});

test("stopped and drained Bridge exposes the direct consent entry", () => {
  const view = reasoningConsentView({
    paired: true,
    bridgeRunning: false,
    reasoningConsentEditable: true,
    agents: [{activeRuns: 0}]
  });

  assert.deepEqual(view, {
    action: "edit",
    disabled: false,
    guidance: "更改只影响后续摘要；已经上传的内容无法撤回。"
  });
});

test("unpaired and busy states remain fenced", () => {
  assert.equal(reasoningConsentView({paired: false, agents: []}).disabled, true);
  assert.equal(reasoningConsentView({
    paired: true,
    bridgeRunning: false,
    reasoningConsentEditable: true,
    agents: []
  }, true).disabled, true);
});
