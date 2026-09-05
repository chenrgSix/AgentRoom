import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { TaskProjection } from "@convene-wire/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";

import { TaskWorkDetail, type TaskWorkDetailTab } from "../src/features/work/TaskWorkDetail.js";
import { WorkWorkspace, workActionTarget, type WorkbenchItem } from "../src/features/work/WorkWorkspace.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://team.example.com/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  return dom;
}

const taskId = "task_work_entry_0001";
const roomId = "room_work_entry_0001";
const teamId = "team_work_entry_0001";
const ownerMemberId = "member_work_entry_0001";
const runId = "run_work_entry_0001";
const nextRunId = "run_work_entry_0002";

function item(reason: WorkbenchItem["nextAction"]["reason"], number = 1): WorkbenchItem {
  return {
    taskId, roomId, taskDisplayNumber: number, title: "Inspect this authorized work",
    ownerMemberId, lifecycleState: "active", schedulingState: "enabled", priority: "normal",
    attentionReasons: [], primaryAttention: null, latestRun: null, latestResultId: null,
    latestResultCurrent: null, requiredCriteriaSatisfied: 0, requiredCriteriaTotal: 0,
    budgetUsage: { usageRevision: 0, runAttempts: 1, executionDurationSeconds: 0, providerTokens: null, providerCostUsd: null },
    nextAction: { actorKind: "member", reason, sourceId: runId, expectedMemberId: ownerMemberId, expectedAgentId: null },
    updatedAt: "2026-08-31T00:00:00.000Z"
  };
}

test("Work next-step mapping resolves input, review and the exact unknown Run without executing", () => {
  assert.deepEqual(workActionTarget(item("provide_input")), { view: "room", roomId, taskId });
  assert.deepEqual(workActionTarget(item("start_work")), { view: "room", roomId, taskId });
  assert.deepEqual(workActionTarget(item("review_result")), { view: "work", roomId, taskId, tab: "results" });
  assert.deepEqual(workActionTarget(item("acknowledge_outcome")), { view: "work", roomId, taskId, tab: "runs", runId });
  assert.deepEqual(workActionTarget(item("increase_budget")), { view: "work", roomId, taskId, tab: "overview" });
  assert.equal(workActionTarget(item("none")), null);
});

test("Work creation, next steps, bounded search and copy link only call their shell callbacks", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error("Work entry cannot make requests"); };
  let created = 0;
  let copied = 0;
  const opened: WorkbenchItem[] = [];
  const searches: string[] = [];
  const props = {
    agentNames: new Map<string, string>(), memberNames: new Map<string, string>(), roomNames: new Map<string, string>(),
    locale: "en" as const, error: null, items: [item("provide_input")], loading: false, scope: "mine" as const,
    onOpenTask: () => undefined, onRefresh: () => undefined, onScopeChange: () => undefined,
    onCreateTask: () => { created += 1; }, onOpenAction: (value: WorkbenchItem) => { opened.push(value); },
    onCopyLink: () => { copied += 1; }, search: "Inspect", onSearchChange: (value: string) => { searches.push(value); }
  };
  const { cleanup, fireEvent, render, within, waitFor } = await import("@testing-library/react");
  try {
    const view = render(<WorkWorkspace {...props} />);
    const page = within(dom.window.document.body);
    assert.equal(created, 0);
    fireEvent.click(page.getByRole("button", { name: "New Task" }));
    fireEvent.click(page.getByRole("button", { name: /Open next step for TASK-1/u }));
    fireEvent.click(page.getByRole("button", { name: "Copy current link" }));
    assert.equal(created, 1);
    assert.deepEqual(opened, props.items);
    assert.equal(copied, 1);
    const search = page.getByRole("searchbox", { name: "Search work" }) as HTMLInputElement;
    search.focus();
    assert.equal(dom.window.document.activeElement, search);
    fireEvent.change(search, { target: { value: "x".repeat(101) } });
    await waitFor(() => assert.deepEqual(searches, ["x".repeat(100)]));
    fireEvent.change(search, { target: { value: "😀".repeat(101) } });
    await waitFor(() => assert.deepEqual(searches, ["x".repeat(100), "😀".repeat(100)]));
    assert.ok(page.getByText("Inspect this authorized work"), "search must not filter only the loaded page");
    fireEvent.click(page.getByRole("button", { name: "Clear filters" }));
    assert.deepEqual(searches, ["x".repeat(100), "😀".repeat(100), ""]);
    view.rerender(<WorkWorkspace {...props} createTaskDisabled items={[item("none")]} />);
    fireEvent.click(page.getByRole("button", { name: "New Task" }));
    assert.equal(created, 1, "the shell can disable creation without an authorized Room");
    assert.equal(page.queryByRole("button", { name: /Open next step/u }), null);
    assert.equal(requests, 0);
    for (const button of page.getAllByRole("button")) assert.equal(button.getAttribute("type"), "button");
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

const task = {
  taskId, roomId, teamId, ownerMemberId, taskDisplayNumber: 1,
  title: "Navigation preserves the selected surface", goal: "Inspect without running commands",
  lifecycleState: "active", schedulingState: "enabled", priority: "normal", isDefault: true,
  taskRevision: 1, definitionRevision: 1, criteriaRevision: 1, criteria: [], assignments: [],
  budgetPolicy: { maxRunAttempts: 5, maxExecutionDurationSeconds: 3600 },
  budgetUsage: { runAttempts: 2, executionDurationSeconds: 0 },
  attentionReasons: [], nextAction: { reason: "none", actorKind: "none" }, completionPolicy: "owner_confirmed"
} as TaskProjection;

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function detailFetch(requests: string[]) {
  return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    requests.push(`${init.method ?? "GET"} ${url}`);
    assert.equal(init.method ?? "GET", "GET", "navigating never issues a command");
    if (url === `/api/tasks/${taskId}`) return json(task);
    if (url === `/api/tasks/${taskId}/runs`) return json([runId, nextRunId].map((id, index) => ({
      runId: id, taskId, roomId, targetAgentId: "agent_work_entry_0001", state: "failed",
      lastSequence: 1, instruction: `Read attempt ${index + 1}`, attemptNumber: index + 1
    })));
    if (url.endsWith("/artifacts")) return json({ artifacts: [] });
    if (url.endsWith("/context-manifest")) return json({ error: { message: "Run Context Manifest was not recorded" } }, 400);
    if (url.endsWith("/results") || url.endsWith("/discussions") || url.endsWith("/events?after=0")) return json([]);
    throw new Error(`Unexpected navigation request: ${url}`);
  };
}

function detailProps() {
  return {
    taskId, token: "navigation-session", locale: "en" as const, refreshKey: "1",
    currentMember: { memberId: "member_observer_0001", teamId, userId: "user_observer_0001", displayName: "Observer", role: "member" as const },
    agentNames: new Map<string, string>(), memberNames: new Map<string, string>(), roomNames: new Map<string, string>(),
    onBack: () => undefined, onChanged: () => undefined, onOpenRoom: () => undefined, onOpenTask: () => undefined
  };
}

test("Task tabs accept location changes and keyboard navigation without resetting during refresh", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = detailFetch(requests);
  const tabs: TaskWorkDetailTab[] = [];
  const runs: string[] = [];
  let copies = 0;
  const props = { ...detailProps(), onTabChange: (tab: TaskWorkDetailTab) => tabs.push(tab), onRunChange: (id: string) => runs.push(id), onCopyLink: () => { copies += 1; } };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    const view = render(<TaskWorkDetail {...props} initialTab="results" />);
    const page = within(dom.window.document.body);
    await page.findByText("No Results yet");
    assert.equal(page.getByRole("tab", { name: "Results" }).getAttribute("aria-selected"), "true");
    fireEvent.keyDown(page.getByRole("tab", { name: "Results" }), { key: "ArrowRight" });
    assert.deepEqual(tabs, ["artifacts"]);
    assert.equal(dom.window.document.activeElement, page.getByRole("tab", { name: "Artifacts" }));
    view.rerender(<TaskWorkDetail {...props} initialTab="artifacts" refreshKey="2" />);
    await waitFor(() => assert.equal(requests.filter((request) => request === `GET /api/tasks/${taskId}`).length, 2));
    assert.equal(page.getByRole("tab", { name: "Artifacts" }).getAttribute("aria-selected"), "true");
    view.rerender(<TaskWorkDetail {...props} initialTab="runs" initialRunId={runId} refreshKey="2" />);
    await page.findByText("Read attempt 1");
    assert.deepEqual(runs, [], "restored navigation must not notify the shell as a new user action");
    assert.equal(page.queryByRole("button", { name: "Start new attempt" }), null, "navigation cannot grant Task ownership");
    fireEvent.click(page.getByRole("button", { name: /Attempt 2/u }));
    assert.deepEqual(runs, [nextRunId]);
    view.rerender(<TaskWorkDetail {...props} initialTab="runs" initialRunId={nextRunId} refreshKey="3" />);
    await page.findByText("Read attempt 2");
    await waitFor(() => assert.equal(requests.filter((request) => request === `GET /api/tasks/${taskId}`).length, 3));
    assert.equal(page.getByRole("button", { name: /Attempt 2/u }).getAttribute("aria-pressed"), "true");
    fireEvent.click(page.getByRole("button", { name: "Copy current link" }));
    assert.equal(copies, 1);
    assert.ok(requests.every((request) => request.startsWith("GET ")));
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a requested Run outside the authorized Task never loads evidence or enables recovery", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = detailFetch(requests);
  const { cleanup, render, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} initialTab="runs" initialRunId="run_another_task_0001" />);
    const page = within(dom.window.document.body);
    await page.findByText(/The requested Run is not available in this Task/u);
    assert.equal(requests.some((request) => request.includes("/api/runs/")), false);
    assert.equal(page.queryByRole("button", { name: "Start new attempt" }), null);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("an initial recovery target waits for Task authorization and selects the requested older Run", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const fallback = detailFetch(requests);
  let finishTask!: (response: Response) => void;
  globalThis.fetch = async (input, init) => {
    if (String(input) === `/api/tasks/${taskId}`) {
      requests.push(`GET /api/tasks/${taskId}`);
      return new Promise<Response>((resolve) => { finishTask = resolve; });
    }
    return fallback(input, init);
  };
  const { act, cleanup, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} initialTab="runs" initialRunId={runId} />);
    await waitFor(() => assert.equal(typeof finishTask, "function"));
    assert.deepEqual(requests, [`GET /api/tasks/${taskId}`]);
    await act(async () => { finishTask(json(task)); });
    const page = within(dom.window.document.body);
    await page.findByText("Read attempt 1");
    assert.equal(page.getByRole("button", { name: /Attempt 1/u }).getAttribute("aria-pressed"), "true");
    assert.ok(requests.some((request) => request === `GET /api/runs/${runId}/events?after=0`));
    assert.equal(requests.some((request) => request.includes(`/api/runs/${nextRunId}/`)), false);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("actionable Work controls wrap and retain visible keyboard focus at narrow widths", async () => {
  const css = await readFile(new URL("../src/features/work/work-experience.css", import.meta.url), "utf8");
  assert.match(css, /\.work-toolbar \{ flex-wrap: wrap; \}/u);
  assert.match(css, /\.work-next-action \{[^}]*white-space: normal;/u);
  assert.match(css, /\.work-search input:focus-visible/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.work-filters \.work-search \{ flex-basis: 100%; max-width: none; \}/u);
});
