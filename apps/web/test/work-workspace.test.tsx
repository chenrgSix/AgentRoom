import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { WorkbenchPage } from "@agent-room/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";

import { WorkWorkspace } from "../src/features/work/WorkWorkspace.js";

type Item = WorkbenchPage["items"][number];

function item(overrides: Partial<Item> = {}): Item {
  return {
    taskId: "task_opaque_workbench_0001",
    taskDisplayNumber: 17,
    roomId: "room_workbench_0001",
    title: "Verify the Workbench",
    ownerMemberId: "member_workbench_0001",
    lifecycleState: "active",
    schedulingState: "enabled",
    priority: "high",
    attentionReasons: [],
    primaryAttention: null,
    latestRun: {
      runId: "run_workbench_0001",
      taskId: "task_opaque_workbench_0001",
      agentId: "agent_workbench_0001",
      state: "working",
      phase: "unknown",
      attemptNumber: 2,
      retryOfRunId: "run_workbench_0000",
      createdAt: "2026-08-28T10:00:00.000Z",
      updatedAt: "2026-08-28T10:01:00.000Z"
    },
    latestResultId: null,
    latestResultCurrent: null,
    requiredCriteriaSatisfied: 1,
    requiredCriteriaTotal: 3,
    budgetUsage: {
      usageRevision: 2,
      runAttempts: 2,
      executionDurationSeconds: 42,
      providerTokens: null,
      providerCostUsd: null
    },
    nextAction: {
      actorKind: "agent",
      reason: "submit_result",
      sourceId: "task_opaque_workbench_0001",
      expectedMemberId: null,
      expectedAgentId: "agent_workbench_0001"
    },
    updatedAt: "2026-08-28T10:01:00.000Z",
    ...overrides
  };
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example.com/"
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window }
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true
  });
  return dom;
}

test("Work groups authoritative items and opens by opaque Task identity", async () => {
  const dom = installDom();
  const opened: Array<{ taskId: string; roomId: string }> = [];
  const blocked = item({
    taskId: "task_opaque_workbench_0002",
    taskDisplayNumber: 18,
    title: "Resolve human and Runtime blocks",
    latestRun: null,
    attentionReasons: [
      {
        reason: "blocked",
        sourceId: "block_workbench_0001",
        occurredAt: "2026-08-28T10:02:00.000Z",
        actorKind: "member",
        expectedMemberId: "member_workbench_0001",
        expectedAgentId: null
      },
      {
        reason: "paused",
        sourceId: "task_opaque_workbench_0002",
        occurredAt: "2026-08-28T10:02:00.000Z",
        actorKind: "member",
        expectedMemberId: "member_workbench_0001",
        expectedAgentId: null
      },
      {
        reason: "runtime_unavailable",
        sourceId: "agent_workbench_0001",
        occurredAt: "2026-08-28T10:02:00.000Z",
        actorKind: "agent",
        expectedMemberId: null,
        expectedAgentId: "agent_workbench_0001"
      }
    ],
    primaryAttention: "blocked",
    schedulingState: "paused",
    nextAction: {
      actorKind: "member",
      reason: "resolve_block",
      sourceId: "block_workbench_0001",
      expectedMemberId: "member_workbench_0001",
      expectedAgentId: null
    }
  });
  const review = item({
    taskId: "task_opaque_workbench_0003",
    taskDisplayNumber: 19,
    title: "Review immutable Result",
    lifecycleState: "review",
    latestResultId: "result_workbench_0001",
    latestResultCurrent: false,
    attentionReasons: [{
      reason: "result_stale",
      sourceId: "result_workbench_0001",
      occurredAt: "2026-08-28T10:03:00.000Z",
      actorKind: "member",
      expectedMemberId: "member_workbench_0001",
      expectedAgentId: null
    }],
    primaryAttention: "result_stale"
  });
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(
      <WorkWorkspace
        agentNames={new Map([["agent_workbench_0001", "Builder"]])}
        error={null}
        items={[item(), blocked, review]}
        loading={false}
        locale="zh-CN"
        memberNames={new Map([["member_workbench_0001", "Alice"]])}
        onOpenTask={(taskId, roomId) => opened.push({ taskId, roomId })}
        onRefresh={() => undefined}
        onScopeChange={() => undefined}
        roomNames={new Map([["room_workbench_0001", "delivery"]])}
        scope="mine"
      />
    );
    const page = within(dom.window.document.body);
    assert.ok(page.getByRole("heading", { name: "正在执行" }));
    assert.ok(page.getByRole("heading", { name: "等待审核" }));
    assert.ok(page.getByRole("heading", { name: "阻塞与风险" }));
    assert.ok(page.getByText("已阻塞"));
    assert.ok(page.getAllByText("已暂停").length >= 1);
    assert.ok(page.getByText("运行时不可用"));
    assert.equal(page.getAllByText("1/3").length, 3);
    assert.equal(page.getAllByText("未知").length, 3);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /task_opaque/u);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /33%|percentage/u);
    fireEvent.click(page.getByRole("button", { name: "打开 TASK-18" }));
    assert.deepEqual(opened, [{
      taskId: "task_opaque_workbench_0002",
      roomId: "room_workbench_0001"
    }]);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Work layout collapses to one card column on narrow screens", async () => {
  const css = await readFile(
    new URL("../src/styles.css", import.meta.url),
    "utf8"
  );
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.work-card-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  assert.doesNotMatch(css, /\.work-card[^}]*min-width:\s*[4-9]\d\dpx/u);
});
