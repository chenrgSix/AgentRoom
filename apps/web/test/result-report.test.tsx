import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import type { ResultProjection, TaskProjection } from "@convene-wire/contracts/task-result";
import { resultReport } from "../src/features/work/result-report.js";
import { ResultReportActions } from "../src/features/work/ResultReportActions.js";
import { MarkdownMessage } from "../src/MarkdownMessage.js";

const task: TaskProjection = {
  taskId: "task_report0001", roomId: "room_report0001", teamId: "team_report0001", taskDisplayNumber: 1,
  title: "Inspect delivery", goal: "Deliver evidence", parentTaskId: null, ownerMemberId: "member_report001", createdByMemberId: "member_report001",
  lifecycleState: "review", schedulingState: "enabled", priority: "normal", isDefault: false,
  completionPolicy: "accepted_result_required", completionResultId: null, taskRevision: 2, definitionRevision: 1, criteriaRevision: 1,
  criteria: [{ criterionKey: "criterion_one", description: "Tests pass", ordinal: 1, required: true }], assignments: [],
  budgetPolicy: { maxRunAttempts: 5, maxExecutionDurationSeconds: 3600 },
  budgetUsage: { usageRevision: 1, runAttempts: 1, executionDurationSeconds: 5, providerTokens: null, providerCostUsd: null },
  attentionReasons: [], nextAction: { actorKind: "member", reason: "review_result", sourceId: "result_report001" },
  dueAt: null, createdAt: "2026-09-05T12:00:00.000Z", updatedAt: "2026-09-05T12:01:00.000Z"
};
const result: ResultProjection = {
  resultId: "result_report001", taskId: task.taskId, roomId: task.roomId, resultVersion: 3, state: "proposed", review: null,
  proposedAt: "2026-09-05T12:01:00.000Z", proposedBy: { kind: "member", memberId: task.ownerMemberId },
  proposal: { operationId: "op_report0001", taskId: task.taskId, definitionRevision: 1, criteriaRevision: 1, proposedAtTaskRevision: 2,
    supersedesResultId: null, outcome: "satisfied", summary: "## Findings\n\n**Evidence**\n\n<script>alert(1)</script>\n[bad](javascript:alert(1))",
    criterionClaims: [{ criterionKey: "criterion_one", coverage: "satisfied", explanation: "Passed the focused suite", evidenceRefIds: ["evidence_one"] }],
    sources: [{ evidenceRefId: "evidence_one", kind: "run_event", runId: "run_report0001", sequence: 3 }],
    risks: ["Physical Windows not checked"], openQuestions: ["Ship later?"], nextActions: [{ nextActionKey: "verify", description: "Run platform checks" }] }
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const key of ["document", "HTMLElement", "window", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
  return dom;
}

test("report preserves revision, explicit claims and missing review without promoting evidence references", () => {
  const text = resultReport(task, result, "en", "https://team.example/?token=never-export#secret");
  assert.match(text, /Result v3/u);
  assert.match(text, /No human review is recorded/u);
  assert.match(text, /Current revisions/u);
  assert.match(text, /Tests pass/u);
  assert.match(text, /coverage|satisfied/u);
  assert.match(text, /does not establish verified content/u);
  assert.match(text, /tab=runs&run=run_report0001/u);
  assert.doesNotMatch(text, /never-export|#secret|<script>|\[bad\]\(javascript:/u);
  assert.match(text, /&lt;script&gt;/u);
  const stale = resultReport({ ...task, criteriaRevision: 2, criteria: [{ ...task.criteria[0]!, description: "New requirement" }] }, result, "en", "https://team.example/");
  assert.match(stale, /Stale Result/u);
  assert.match(stale, /Current Task criteria · r2/u);
  assert.match(stale, /New requirement/u);
  assert.throws(() => resultReport({ ...task, taskId: "task_different" }, result, "en", "https://team.example"), /scope/u);
});

test("summary renders Markdown headings and tables while rejecting executable HTML and links", async () => {
  const dom = installDom();
  const { cleanup, render } = await import("@testing-library/react");
  try {
    const view = render(<MarkdownMessage content={`${result.proposal.summary}\n\n| Check | State |\n| --- | --- |\n| Tests | Passed |`} />);
    assert.ok(view.getByRole("heading", { name: "Findings" }));
    assert.ok(view.getByRole("table"));
    assert.equal(dom.window.document.querySelector("script"), null);
    assert.equal(dom.window.document.querySelector('a[href^="javascript:"]'), null);
  } finally { cleanup(); dom.window.close(); }
});

test("copy rechecks current review, handles clipboard failure and downloads the same bounded report", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let copied = "";
  let failClipboard = false;
  let blob: Blob | undefined;
  let filename = "";
  let revoked = "";
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { if (failClipboard) throw new Error("denied"); copied = text; } } });
  const approved = { ...result, state: "accepted", review: { decision: "accepted", reason: "Reviewed exact evidence", reviewedByMemberId: task.ownerMemberId, reviewedAt: task.updatedAt, reviewRevision: 1 } };
  globalThis.fetch = async (input) => response(String(input).includes("/api/results/") ? approved : task);
  URL.createObjectURL = (value) => { blob = value as Blob; return "blob:report"; };
  URL.revokeObjectURL = (value) => { revoked = value; };
  dom.window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
  try {
    const view = render(<ResultReportActions taskId={task.taskId} resultId={result.resultId} locale="en" token="fixture" />);
    fireEvent.click(view.getByRole("button", { name: "Copy Result" }));
    await waitFor(() => assert.match(copied, /Reviewed exact evidence/u));
    assert.match(copied, /Result state: accepted/u);
    failClipboard = true;
    fireEvent.click(view.getByRole("button", { name: "Copy Result" }));
    await waitFor(() => assert.match(view.getByRole("alert").textContent ?? "", /Clipboard unavailable/u));
    fireEvent.click(view.getByRole("button", { name: "Download report" }));
    await waitFor(() => assert.equal(filename, "TASK-1-Result-v3.md"));
    assert.equal(await blob!.text(), copied);
    assert.equal(dom.window.document.querySelector("a[download]"), null);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    assert.equal(revoked, "blob:report");
  } finally { cleanup(); globalThis.fetch = original; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; dom.window.close(); }
});

test("denied access and late old-context reads cannot copy or download a report", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  let copied = 0;
  let finish!: (response: Response) => void;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { copied += 1; } } });
  globalThis.fetch = async () => response({ message: "Denied" }, 403);
  const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
  const props = { taskId: task.taskId, resultId: result.resultId, locale: "en" as const, token: "fixture" };
  try {
    const view = render(<ResultReportActions {...props} />);
    fireEvent.click(view.getByRole("button", { name: "Copy Result" }));
    await waitFor(() => assert.match(view.getByRole("alert").textContent ?? "", /check your access/u));
    assert.equal(copied, 0);
    globalThis.fetch = async (input) => String(input).includes("/api/results/") ? new Promise((resolve) => { finish = resolve; }) : response(task);
    fireEvent.click(view.getByRole("button", { name: "Copy Result" }));
    await waitFor(() => assert.equal(typeof finish, "function"));
    view.rerender(<ResultReportActions {...props} taskId="task_other0001" resultId="result_other001" />);
    await act(async () => { finish(response(result)); });
    assert.equal(copied, 0);
    assert.equal(view.queryByRole("status"), null);
    assert.equal(view.queryByRole("alert"), null);
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});
