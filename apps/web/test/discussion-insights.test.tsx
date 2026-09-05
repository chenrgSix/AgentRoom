import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscussionInsights } from "../src/features/discussion/DiscussionInsights.js";
import type { Agent, DiscussionView } from "../src/models.js";
const view = { discussion: { budget: { agentRunsUsed: 5 } }, observedUsage: {
  createdRuns: 3, runsByState: { completed: 1, working: 1, outcome_unknown: 1,
    queued: 0, delivered: 0, input_required: 0, canceled: 0, failed: 0, expired: 0 },
  unboundMemberSlots: 2, unavailableRunRecords: 1, wallDurationSeconds: 42
} } as DiscussionView;
const wave = { selection: { version: 2, selectedAgentIds: ["agent_primary"],
  strategy: "finalizer", focusQuestionIds: [], selectionDigest: "a".repeat(64),
  explanations: [{ agentId: "agent_primary", reasons: ["finalizer_primary"],
    reportedQuestionIds: [], matchedRoleTerms: [] }]
} } as DiscussionView["waves"][number];
const agentsById = new Map([["agent_primary", { name: "<script>Current role is irrelevant</script>" } as Agent]]);
test("frozen primary reason and observed versus budget usage render in both locales", () => {
  for (const locale of ["zh-CN", "en"] as const) {
    const html = renderToStaticMarkup(<DiscussionInsights {...{view, wave, agentsById, locale}} />);
    assert.ok(html.includes(locale === "zh-CN" ? "由任务主负责人汇总" : "Task primary consolidates"));
    assert.ok(html.includes(locale === "zh-CN" ? "已创建 3 个 Run" : "3 Runs created"));
    assert.ok(html.includes(locale === "zh-CN" ? "预算已记账槽位" : "Debited budget slots"));
    assert.ok(html.includes(locale === "zh-CN" ? "结果未知 1" : "1 outcome unknown"));
    assert.ok(html.includes("42s"));
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("$0"));
    assert.doesNotMatch(html, /tokens?|cost|费用/i);
  }
});
test("old snapshots and older Servers do not invent explanations or actual counts", () => {
  const legacy = { ...wave, selection: { ...wave.selection!, version: 1 as const, explanations: undefined } };
  const html = renderToStaticMarkup(<DiscussionInsights view={{ ...view, observedUsage: undefined }}
    wave={legacy} agentsById={agentsById} locale="zh-CN" />);
  assert.ok(html.includes("旧记录未保存逐项选择原因"));
  assert.ok(html.includes("当前服务器未提供实际运行统计"));
  assert.ok(!html.includes("已创建 0"));
  assert.ok(!html.includes("由任务主负责人汇总"));
  assert.doesNotMatch(html, /tokens?|cost|费用/i);
});

test("retired metrics from an older Server are ignored in both locales", () => {
  const legacyUsage = { ...view.observedUsage!, tokens: 120, estimatedCostMicros: 35 };
  for (const locale of ["zh-CN", "en"] as const) {
    const html = renderToStaticMarkup(<DiscussionInsights view={{ ...view, observedUsage: legacyUsage }}
      wave={wave} agentsById={agentsById} locale={locale} />);
    assert.doesNotMatch(html, /tokens?|cost|费用|120|35/i);
    assert.ok(html.includes("42s"));
  }
});
