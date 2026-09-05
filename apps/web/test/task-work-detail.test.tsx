import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ResultProjection,
  RunContextManifest,
  TaskProjection
} from "@convene-wire/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";

import { TaskWorkDetail } from "../src/features/work/TaskWorkDetail.js";
import type { Member } from "../src/models.js";

const task: TaskProjection = {
  taskId: "task_work_detail_0001",
  taskDisplayNumber: 24,
  teamId: "team_work_detail_0001",
  roomId: "room_work_detail_0001",
  parentTaskId: null,
  title: "Verify immutable delivery",
  goal: "Review the exact evidence before accepting the work.",
  lifecycleState: "review",
  schedulingState: "enabled",
  priority: "high",
  ownerMemberId: "member_owner_0001",
  createdByMemberId: "member_owner_0001",
  completionPolicy: "accepted_result_required",
  completionResultId: null,
  isDefault: true,
  taskRevision: 4,
  definitionRevision: 2,
  criteriaRevision: 2,
  criteria: [{
    criterionKey: "criterion_detail_0001",
    description: "The review is evidence-backed.",
    required: true,
    ordinal: 1
  }],
  assignments: [{
    agentId: "agent_detail_0001",
    role: "primary",
    assignedAt: "2026-08-28T10:00:00.000Z",
    assignedByMemberId: "member_owner_0001"
  }],
  budgetPolicy: { maxRunAttempts: 5, maxExecutionDurationSeconds: 3600 },
  budgetUsage: {
    usageRevision: 2,
    runAttempts: 2,
    executionDurationSeconds: 80,
    providerTokens: null,
    providerCostUsd: null
  },
  attentionReasons: [{
    reason: "needs_approval",
    sourceId: "result_detail_0001",
    occurredAt: "2026-08-28T10:03:00.000Z",
    actorKind: "member",
    expectedMemberId: "member_owner_0001",
    expectedAgentId: null
  }],
  nextAction: {
    actorKind: "member",
    reason: "review_result",
    sourceId: "result_detail_0001",
    expectedMemberId: "member_owner_0001",
    expectedAgentId: null
  },
  dueAt: null,
  createdAt: "2026-08-28T10:00:00.000Z",
  updatedAt: "2026-08-28T10:03:00.000Z"
};

const result: ResultProjection = {
  resultId: "result_detail_0001",
  taskId: task.taskId,
  roomId: task.roomId,
  resultVersion: 1,
  state: "proposed",
  proposedBy: {
    kind: "managed_agent",
    agentId: "agent_detail_0001",
    runId: "run_detail_0002"
  },
  proposal: {
    operationId: "op_result_detail_0001",
    taskId: task.taskId,
    definitionRevision: 2,
    criteriaRevision: 2,
    proposedAtTaskRevision: 4,
    supersedesResultId: null,
    outcome: "satisfied",
    summary: "Exact summary <script>window.compromised = true</script>",
    risks: ["A review can still reject this Result."],
    openQuestions: ["Does the Owner accept the evidence?"],
    nextActions: [{
      nextActionKey: "ship_verified_change",
      description: "Ship the verified change"
    }],
    sources: [{
      evidenceRefId: "evidence_detail_0001",
      kind: "artifact",
      artifactId: "artifact_detail_0001"
    }],
    criterionClaims: [{
      criterionKey: "criterion_detail_0001",
      coverage: "satisfied",
      explanation: "The immutable test evidence passed.",
      evidenceRefIds: ["evidence_detail_0001"]
    }]
  },
  proposedAt: "2026-08-28T10:03:00.000Z",
  review: null
};

const owner: Member = {
  memberId: "member_owner_0001",
  teamId: task.teamId,
  userId: "user_owner_0001",
  displayName: "Owner",
  role: "owner",
  createdAt: "2026-08-28T09:00:00.000Z"
};

const manifest: RunContextManifest = {
  manifestVersion: "1.0",
  runId: "run_detail_0002",
  taskId: task.taskId,
  taskRevision: 4,
  definitionRevision: 2,
  criteriaRevision: 2,
  goal: task.goal,
  criteria: task.criteria,
  target: {
    agentId: "agent_detail_0001",
    deviceId: "device_detail_0001",
    runtimeKind: "codex",
    workspaceAlias: "delivery-worktree"
  },
  included: {
    messageIds: ["message_detail_0001"],
    artifactIds: [],
    memoryIds: [],
    parentRunIds: ["run_detail_0001"],
    roomContextRevision: 3,
    taskMemoryRevision: 1,
    artifactRevision: 1
  },
  permissions: {
    filesystemAccess: "workspace-write",
    networkAccess: "local-policy",
    interrupt: "supported",
    handoff: "supported",
    maxDurationSeconds: 3600
  },
  omittedCategories: ["local_paths", "provider_credentials"],
  recordedAt: "2026-08-28T10:01:00.000Z"
};

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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function baseFetch(activeResult: () => ResultProjection = () => result) {
  return async (input: string | URL | Request): Promise<Response> => {
    const path = String(input);
    if (path === `/api/tasks/${task.taskId}`) return json(task);
    if (path === `/api/tasks/${task.taskId}/runs`) return json([{
      runId: "run_detail_0002",
      traceId: "trace_detail_0002",
      roomId: task.roomId,
      taskId: task.taskId,
      triggerMessageId: "message_detail_0001",
      requesterMemberId: owner.memberId,
      targetAgentId: "agent_detail_0001",
      parentRunId: "run_detail_0001",
      attemptNumber: 2,
      retryOfRunId: "run_detail_0001",
      instruction: "Return exact evidence <img src=x onerror=alert(1)>",
      state: "outcome_unknown",
      lastSequence: 2,
      deadlineAt: "2026-08-28T11:00:00.000Z",
      createdAt: "2026-08-28T10:01:00.000Z",
      updatedAt: "2026-08-28T10:02:00.000Z",
      terminalAt: "2026-08-28T10:02:00.000Z"
    }]);
    if (path === `/api/tasks/${task.taskId}/results`) return json([activeResult()]);
    if (path === `/api/tasks/${task.taskId}/artifacts`) return json({
      revision: 1,
      artifacts: [{
        artifactId: "artifact_detail_0001",
        artifactRevision: 1,
        taskId: task.taskId,
        roomId: task.roomId,
        type: "test_result",
        title: "Focused test evidence",
        summary: "All focused tests passed.",
        contentMode: "snapshot_blob",
        contentMediaType: "text/markdown",
        contentSizeBytes: 100,
        contentSha256: "a".repeat(64),
        createdAt: "2026-08-28T10:02:00.000Z"
      }]
    });
    if (path === `/api/rooms/${task.roomId}/discussions`) return json([{
      discussion: {
        discussionId: "discussion_detail_0001",
        taskId: task.taskId,
        goal: "Review tradeoffs",
        state: "completed",
        stateReason: null,
        currentTurn: 2,
        currentWave: 1,
        progress: { confidence: 0.8, openQuestions: [], plateauCount: 0 },
        budget: { turnsUsed: 2, durationSeconds: 30 }
      },
      participants: [{ agentId: "agent_detail_0001", role: "reviewer" }],
      waves: [],
      turns: []
    }]);
    if (path === "/api/runs/run_detail_0002/events?after=0") return json([{
      sequence: 2,
      createdAt: "2026-08-28T10:02:00.000Z",
      event: { type: "reply", sequence: 2, content: "<script>alert('event')</script>" }
    }, {
      sequence: 1,
      createdAt: "2026-08-28T10:01:00.000Z",
      event: { type: "status", sequence: 1, status: "working" }
    }]);
    if (path === "/api/runs/run_detail_0002/context-manifest") {
      return json({ ...manifest, workspacePath: "/Users/alice/private" });
    }
    if (path === "/api/runs/run_detail_0002/ambiguity-acknowledgement") return json({ acknowledgement: null });
    throw new Error(`Unexpected request: ${path}`);
  };
}

function detailProps(currentMember: Member | null = owner) {
  return {
    agentNames: new Map([["agent_detail_0001", "Builder"]]),
    currentMember,
    locale: "en" as const,
    memberNames: new Map([[owner.memberId, owner.displayName]]),
    onBack: () => undefined,
    onChanged: () => undefined,
    onOpenRoom: () => undefined,
    onOpenTask: () => undefined,
    refreshKey: task.updatedAt,
    roomNames: new Map([[task.roomId, "delivery"]]),
    taskId: task.taskId,
    token: "session_detail_0001"
  };
}

test("Task detail renders authoritative tabs and untrusted content as text", async () => {
  const dom = installDom();
  globalThis.fetch = baseFetch();
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    assert.ok(page.getByText("Quick Room work"));
    assert.ok(page.getByText("1/1 required criteria evidenced"));
    assert.ok(page.getByText("Attempt 2 · outcome unknown"));
    assert.ok(page.getByText("v1 · proposed"));
    assert.ok(page.getAllByText("Unknown").length >= 2);

    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    await page.findByText("Ordered events");
    await page.findByText("<script>alert('event')</script>");
    assert.equal(dom.window.document.querySelector("script"), null);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /\/Users\/alice\/private/u);
    assert.ok(page.getByText(/Outcome unknown/u));
    assert.ok(page.getByText("prior attempt", { exact: false }));
    assert.ok(page.getByText(/Linked Results: v1 \(proposed\)/u));

    fireEvent.keyDown(page.getByRole("tab", { name: "Runs" }), { key: "ArrowRight" });
    await page.findByText("Result v1");
    assert.equal(page.getByRole("tab", { name: "Results" }).getAttribute("tabindex"), "0");
    assert.ok(page.getByText("Exact summary window.compromised = true"));
    assert.equal(dom.window.document.querySelector("img"), null);
    assert.ok(page.getByRole("button", { name: "Accept" }));

    fireEvent.click(page.getByRole("tab", { name: "Artifacts" }));
    assert.ok(page.getByText("Focused test evidence"));
    fireEvent.click(page.getByRole("tab", { name: "Discussion" }));
    assert.ok(page.getByText("Review tradeoffs"));
    fireEvent.click(page.getByRole("tab", { name: "Audit" }));
    assert.ok(page.getByText(/does not infer missing history/u));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Result controls follow domain ownership instead of projected next action", async () => {
  const dom = installDom();
  globalThis.fetch = baseFetch();
  const member: Member = {
    ...owner,
    memberId: "member_not_owner_0001",
    userId: "user_not_owner_0001",
    role: "member"
  };
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps(member)} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Results" }));
    assert.equal(page.queryByRole("button", { name: "Accept" }), null);
    assert.equal(page.queryByRole("region", { name: "Review Result" }), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("review and follow-up retries preserve stable operation identities", async () => {
  const dom = installDom();
  let activeResult = result;
  let reviewAttempts = 0;
  let followUpAttempts = 0;
  const reviewOperations: string[] = [];
  const followUpOperations: string[] = [];
  const opened: string[] = [];
  const fallback = baseFetch(() => activeResult);
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === `/api/results/${result.resultId}/review-decisions`) {
      const body = JSON.parse(String(init?.body)) as { operationId: string };
      reviewOperations.push(body.operationId);
      reviewAttempts += 1;
      if (reviewAttempts === 1) return json({ error: { message: "Task revision changed" } }, 409);
      activeResult = {
        ...result,
        state: "accepted",
        review: {
          decision: "accepted",
          reason: "Evidence is sufficient.",
          reviewedAt: "2026-08-28T10:04:00.000Z",
          reviewedByMemberId: owner.memberId,
          reviewRevision: 1
        }
      };
      return json({ result: activeResult, taskRevisionBefore: 4, taskRevisionAfter: 5, completedTask: false });
    }
    if (path === `/api/results/${result.resultId}/follow-up-tasks`) {
      const body = JSON.parse(String(init?.body)) as { operationId: string };
      followUpOperations.push(body.operationId);
      followUpAttempts += 1;
      if (followUpAttempts === 1) return json({ error: { message: "Response lost" } }, 503);
      return json({ ...task, taskId: "task_child_detail_0001", parentTaskId: task.taskId, taskDisplayNumber: 25 });
    }
    return fallback(input);
  };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} onOpenTask={(taskId) => opened.push(taskId)} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Results" }));
    fireEvent.change(page.getByRole("textbox", { name: "Review reason" }), {
      target: { value: "Evidence is sufficient." }
    });
    fireEvent.click(page.getByRole("button", { name: "Accept" }));
    await page.findByText(/Authoritative state was reloaded/u);
    fireEvent.click(page.getByRole("button", { name: "Accept" }));
    await waitFor(() => assert.equal(reviewOperations.length, 2));
    assert.equal(reviewOperations[0], reviewOperations[1]);
    await page.findByText("Create follow-up Tasks from accepted Result");

    fireEvent.click(page.getByRole("button", { name: "Create Task" }));
    await page.findByText(/Follow-up Task state is unknown/u);
    fireEvent.click(page.getByRole("button", { name: "Create Task" }));
    await waitFor(() => assert.deepEqual(opened, ["task_child_detail_0001"]));
    assert.equal(followUpOperations[0], followUpOperations[1]);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Task detail remains single-column and horizontally bounded on narrow screens", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.work-overview-grid, \.work-run-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/u);
  assert.match(css, /\.work-tabs \{[^}]*overflow-x: auto/u);
  assert.doesNotMatch(css, /\.work-detail[^}]*min-width:\s*[4-9]\d\dpx/u);
});

test("unknown outcome acknowledgement and retry remain separate, fenced, explicit actions", async () => {
  const dom = installDom();
  const fallback = baseFetch();
  let activeTask = structuredClone(task);
  let acknowledgement: { runId: string; reason: string; taskRevisionAfter: number } | null = null;
  const acknowledgements: Array<Record<string, unknown>> = [];
  const retries: Array<Record<string, unknown>> = [];
  const acknowledgementPath = "/api/runs/run_detail_0002/ambiguity-acknowledgement";
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === `/api/tasks/${task.taskId}`) return json(activeTask);
    if (path === acknowledgementPath && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      acknowledgements.push(body);
      acknowledgement = { runId: "run_detail_0002", reason: String(body.reason), taskRevisionAfter: 5 };
      activeTask = { ...activeTask, taskRevision: 5 };
      return json(acknowledgement);
    }
    if (path === acknowledgementPath) return json({ acknowledgement });
    if (path === "/api/runs/run_detail_0002/retry") {
      retries.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (retries.length === 1) {
        activeTask = { ...activeTask, taskRevision: 6, budgetUsage: { ...activeTask.budgetUsage, runAttempts: 5 } };
        return json({ error: { message: "Response lost" } }, 503);
      }
      return json({ runId: "run_detail_0003" });
    }
    return fallback(input);
  };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    const reason = await page.findByRole("textbox", { name: "Observed outcome and acknowledgement reason" });
    assert.equal((page.getByRole("button", { name: "Start new attempt" }) as HTMLButtonElement).disabled, true);
    assert.equal((page.getByRole("button", { name: "Record acknowledgement" }) as HTMLButtonElement).disabled, true);
    fireEvent.change(reason, { target: { value: "Checked the remote operation; no duplicate side effect." } });
    fireEvent.click(page.getByRole("checkbox", { name: "I have checked the evidence and external effects." }));
    fireEvent.click(page.getByRole("button", { name: "Record acknowledgement" }));
    await page.findByText(/Acknowledgement recorded:/u);
    assert.equal(acknowledgements.length, 1);
    assert.equal(acknowledgements[0]?.expectedTaskRevision, 4);
    assert.equal(retries.length, 0, "acknowledgement must never dispatch a retry");
    fireEvent.click(page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }));
    fireEvent.click(page.getByRole("button", { name: "Start new attempt" }));
    await page.findByText(/The operation is not confirmed/u);
    await waitFor(() => assert.equal((page.getByRole("button", { name: "Check previous new attempt" }) as HTMLButtonElement).disabled, false));
    fireEvent.click(page.getByRole("tab", { name: "Overview" }));
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    await page.findByRole("button", { name: "Check previous new attempt" });
    fireEvent.click(page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }));
    fireEvent.click(page.getByRole("button", { name: "Check previous new attempt" }));
    await waitFor(() => assert.equal(retries.length, 2));
    assert.deepEqual(retries[0], retries[1], "uncertain retry preserves the exact operation and original revision across tabs");
    assert.equal(retries[0]?.expectedTaskRevision, 5);
    assert.notEqual(retries[0]?.operationId, acknowledgements[0]?.operationId);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("unknown Run controls fail closed when its exact acknowledgement cannot be read", async () => {
  const dom = installDom();
  const fallback = baseFetch();
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") writes += 1;
    if (String(input).endsWith("/ambiguity-acknowledgement")) return json({ error: { message: "Unavailable" } }, 503);
    return fallback(input);
  };
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    await page.findByText(/Could not verify this attempt/u);
    assert.equal((page.getByRole("button", { name: "Start new attempt" }) as HTMLButtonElement).disabled, true);
    assert.equal(page.queryByRole("button", { name: "Record acknowledgement" }), null);
    assert.equal(writes, 0);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("an unconfirmed acknowledgement retains its original payload across tabs", async () => {
  const dom = installDom();
  const fallback = baseFetch();
  const writes: Array<Record<string, unknown>> = [];
  let acknowledgement: { runId: string; reason: string; taskRevisionAfter: number } | null = null;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith("/ambiguity-acknowledgement")) {
      if (init?.method !== "POST") return json({ acknowledgement });
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      writes.push(body);
      if (writes.length === 1) return json({ error: { message: "Response unavailable" } }, 503);
      acknowledgement = { runId: "run_detail_0002", reason: String(body.reason), taskRevisionAfter: 5 };
      return json(acknowledgement);
    }
    return fallback(input);
  };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    fireEvent.change(await page.findByRole("textbox", { name: "Observed outcome and acknowledgement reason" }), { target: { value: "Manually checked the external outcome." } });
    fireEvent.click(page.getByRole("checkbox", { name: "I have checked the evidence and external effects." }));
    fireEvent.click(page.getByRole("button", { name: "Record acknowledgement" }));
    await page.findByText(/The operation is not confirmed/u);
    await page.findByRole("button", { name: "Check previous acknowledgement" });
    fireEvent.click(page.getByRole("tab", { name: "Overview" }));
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    const field = await page.findByRole("textbox", { name: "Observed outcome and acknowledgement reason" }) as HTMLTextAreaElement;
    assert.equal(field.value, "Manually checked the external outcome.");
    assert.equal(field.disabled, true, "an uncertain command must not silently change its evidence");
    fireEvent.click(page.getByRole("checkbox", { name: "I have checked the evidence and external effects." }));
    fireEvent.click(page.getByRole("button", { name: "Check previous acknowledgement" }));
    await waitFor(() => assert.equal(writes.length, 2));
    assert.deepEqual(writes[0], writes[1]);
    await page.findByText(/Acknowledgement recorded:/u);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("an already acknowledged outcome can be recovered after a fresh page load", async () => {
  const dom = installDom();
  const fallback = baseFetch();
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/ambiguity-acknowledgement")) return json({
      acknowledgement: { runId: "run_detail_0002", reason: "Checked earlier by the Owner.", taskRevisionAfter: 5 }
    });
    return fallback(input);
  };
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    await page.findByText(/Acknowledgement recorded: Checked earlier/u);
    assert.equal(page.queryByRole("button", { name: "Record acknowledgement" }), null);
    fireEvent.click(page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }));
    assert.equal((page.getByRole("button", { name: "Start new attempt" }) as HTMLButtonElement).disabled, false);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("an uncertain retry survives closing details and reuses its receipt after a fresh page", async () => {
  let dom = installDom();
  const fallback = baseFetch();
  const writes: Array<Record<string, unknown>> = [];
  const committed = new Map<string, string>();
  let activeTask = structuredClone(task);
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path === `/api/tasks/${task.taskId}`) return json(activeTask);
    if (path.endsWith("/ambiguity-acknowledgement")) return json({ acknowledgement: {
      runId: "run_detail_0002", reason: "Checked external effects earlier.", taskRevisionAfter: 4
    } });
    if (path === "/api/runs/run_detail_0002/retry") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push(body);
      if (!committed.has(String(body.operationId))) committed.set(String(body.operationId), "run_recovered_0003");
      if (writes.length === 1) {
        activeTask = { ...activeTask, taskRevision: 5 };
        throw new Error("Response lost after the retry was committed");
      }
      return json({ runId: committed.get(String(body.operationId)) });
    }
    return fallback(input);
  };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    const first = render(<TaskWorkDetail {...detailProps()} />);
    let page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    await page.findByText(/Acknowledgement recorded:/u);
    fireEvent.click(page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }));
    fireEvent.click(page.getByRole("button", { name: "Start new attempt" }));
    await page.findByText(/The operation is not confirmed/u);
    await waitFor(() => assert.equal((page.getByRole("button", { name: "Check previous new attempt" }) as HTMLButtonElement).disabled, false));
    const saved = Array.from({ length: dom.window.sessionStorage.length }, (_, index) => {
      const key = dom.window.sessionStorage.key(index)!;
      return [key, dom.window.sessionStorage.getItem(key)!] as const;
    });
    assert.equal(saved.length, 1);
    first.unmount();
    dom.window.close();
    dom = installDom();
    for (const [key, value] of saved) dom.window.sessionStorage.setItem(key, value);
    render(<TaskWorkDetail {...detailProps()} />);
    page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    await page.findByText(/Acknowledgement recorded:/u);
    const retry = await page.findByRole("button", { name: "Check previous new attempt" });
    fireEvent.click(page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }));
    fireEvent.click(retry);
    await waitFor(() => assert.equal(writes.length, 2));
    assert.deepEqual(writes[0], writes[1]);
    assert.equal(writes[1]?.expectedTaskRevision, 4, "replay keeps the revision authorized before response loss");
    assert.equal(committed.size, 1, "reopening the page must not create another retry operation");
    await waitFor(() => assert.equal(dom.window.sessionStorage.length, 0));
  } finally { cleanup(); dom.window.close(); }
});

test("recovery mutations fail closed when session storage cannot read or persist receipts", async () => {
  for (const failure of ["read", "write", "silent-write"] as const) {
    const dom = installDom();
    const fallback = baseFetch();
    let writes = 0;
    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") writes += 1;
      const response = await fallback(input);
      if (String(input).endsWith("/runs")) {
        const runs = await response.json() as Array<Record<string, unknown>>;
        return json(runs.map((run) => ({ ...run, state: "failed" })));
      }
      return response;
    };
    const browserStorage = dom.window.sessionStorage;
    Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: {
      getItem: (key: string) => {
        if (failure === "read") throw new Error("Storage unavailable");
        return browserStorage.getItem(key);
      },
      setItem: () => { if (failure === "write") throw new Error("Storage full"); },
      removeItem: (key: string) => browserStorage.removeItem(key)
    } });
    const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
    try {
      render(<TaskWorkDetail {...detailProps()} />);
      const page = within(dom.window.document.body);
      await page.findByRole("heading", { name: task.title });
      fireEvent.click(page.getByRole("tab", { name: "Runs" }));
      await page.findByText("<script>alert('event')</script>");
      fireEvent.click(page.getByRole("checkbox", { name: "I explicitly authorize one new execution attempt." }));
      fireEvent.click(page.getByRole("button", { name: "Start new attempt" }));
      await page.findByText(/The browser cannot safely read or save recovery receipts/u);
      assert.equal((page.getByRole("button", { name: "Start new attempt" }) as HTMLButtonElement).disabled, true);
      assert.equal(writes, 0, `${failure} must block before an external mutation`);
    } finally { cleanup(); dom.window.close(); }
  }
});

test("switching Runs clears previous evidence immediately and blocks recovery on loading or failure", async () => {
  const dom = installDom();
  const fallback = baseFetch();
  const pending: Array<(response: Response) => void> = [];
  let writes = 0;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (init?.method === "POST") writes += 1;
    if (path === `/api/tasks/${task.taskId}/runs`) {
      const runs = await (await fallback(input)).json() as Array<Record<string, unknown>>;
      return json([{ ...runs[0], runId: "run_detail_0001", attemptNumber: 1, state: "failed" }, ...runs]);
    }
    if (path === "/api/runs/run_detail_0001/events?after=0") return json([{ sequence: 1, createdAt: task.updatedAt, event: { type: "reply", content: "Evidence for Run A only" } }]);
    if (path === "/api/runs/run_detail_0001/context-manifest") return json({ ...manifest, runId: "run_detail_0001", goal: "Context for Run A only" });
    if (path === "/api/runs/run_detail_0002/events?after=0") return new Promise<Response>((resolve) => pending.push(resolve));
    return fallback(input);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    fireEvent.click(page.getByRole("button", { name: /Attempt 1/u }));
    await page.findByText("Evidence for Run A only");
    assert.ok(page.getByText("Context for Run A only"));
    fireEvent.click(page.getByRole("button", { name: /Attempt 2/u }));
    assert.ok(page.queryByText("Evidence for Run A only") === null);
    assert.ok(page.queryByText("Context for Run A only") === null);
    await page.findByRole("textbox", { name: "Observed outcome and acknowledgement reason" });
    assert.ok(page.getByText("Loading evidence for this attempt…"));
    assert.equal((page.getByRole("button", { name: "Record acknowledgement" }) as HTMLButtonElement).disabled, true);
    assert.equal((page.getByRole("checkbox", { name: "I have checked the evidence and external effects." }) as HTMLInputElement).disabled, true);
    await act(async () => { for (const resolve of pending.splice(0)) resolve(json({ error: { message: "Run B evidence unavailable" } }, 503)); });
    await page.findByRole("button", { name: "Reload attempt evidence" });
    assert.ok(page.queryByText("Evidence for Run A only") === null);
    assert.equal((page.getByRole("button", { name: "Record acknowledgement" }) as HTMLButtonElement).disabled, true);
    fireEvent.click(page.getByRole("button", { name: "Reload attempt evidence" }));
    await waitFor(() => assert.equal(pending.length, 1));
    fireEvent.click(page.getByRole("button", { name: /Attempt 1/u }));
    await page.findByText("Evidence for Run A only");
    await act(async () => { pending[0]!(json([{ sequence: 1, createdAt: task.updatedAt, event: { type: "reply", content: "Late evidence for Run B" } }])); });
    assert.ok(page.queryByText("Late evidence for Run B") === null);
    assert.ok(page.getByText("Evidence for Run A only"));
    assert.equal(writes, 0);
  } finally { cleanup(); dom.window.close(); }
});

test("recovery distinguishes an absent legacy manifest from an unavailable or mismatched manifest", async () => {
  for (const mode of ["absent", "unavailable", "mismatched"] as const) {
    const dom = installDom();
    const fallback = baseFetch();
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/context-manifest")) {
        return mode === "mismatched" ? json({ ...manifest, runId: "run_other_0001" }) : json({ error: {
          message: mode === "absent" ? "Run Context Manifest was not recorded" : "Manifest request unavailable"
        } }, mode === "absent" ? 400 : 503);
      }
      return fallback(input);
    };
    const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
    try {
      render(<TaskWorkDetail {...detailProps()} />);
      const page = within(dom.window.document.body);
      await page.findByRole("heading", { name: task.title });
      fireEvent.click(page.getByRole("tab", { name: "Runs" }));
      const checkbox = await page.findByRole("checkbox", { name: "I have checked the evidence and external effects." }) as HTMLInputElement;
      if (mode === "absent") {
        await waitFor(() => assert.equal(checkbox.disabled, false));
        assert.ok(page.getByText("No context manifest was recorded for this Run."));
      } else {
        await page.findByRole("button", { name: "Reload attempt evidence" });
        assert.equal(checkbox.disabled, true);
        assert.ok(page.queryByText("<script>alert('event')</script>") === null);
      }
    } finally { cleanup(); dom.window.close(); }
  }
});

test("a new retry is blocked by exhausted budgets and completed attempts cannot be retried", async () => {
  for (const state of ["failed", "completed"]) {
    const dom = installDom();
    const fallback = baseFetch();
    let writes = 0;
    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") writes += 1;
      if (String(input) === `/api/tasks/${task.taskId}`) return json({
        ...task, budgetUsage: { ...task.budgetUsage, runAttempts: task.budgetPolicy.maxRunAttempts }
      });
      const response = await fallback(input);
      if (String(input).endsWith("/runs")) {
        const runs = await response.json() as Array<Record<string, unknown>>;
        return json(runs.map((run) => ({ ...run, state })));
      }
      return response;
    };
    const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
    try {
      render(<TaskWorkDetail {...detailProps()} />);
      const page = within(dom.window.document.body);
      await page.findByRole("heading", { name: task.title });
      fireEvent.click(page.getByRole("tab", { name: "Runs" }));
      if (state === "failed") {
        assert.equal((page.getByRole("button", { name: "Start new attempt" }) as HTMLButtonElement).disabled, true);
        assert.ok(page.getByText(/The execution budget is exhausted/u));
      } else {
        assert.equal(page.queryByRole("button", { name: "Start new attempt" }), null);
      }
      assert.equal(writes, 0);
    } finally {
      cleanup();
      dom.window.close();
    }
  }
});

test("members without Task ownership cannot acknowledge or retry a Run", async () => {
  const dom = installDom();
  globalThis.fetch = baseFetch();
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps({ ...owner, role: "member", memberId: "member_observer_0001" })} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Runs" }));
    await page.findByText(/Only the Task Owner or Team Owner can/u);
    assert.equal(page.queryByRole("button", { name: "Start new attempt" }), null);
    assert.equal(page.queryByRole("button", { name: "Record acknowledgement" }), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Result commit evidence does not request a binary text preview", async () => {
  const dom = installDom(), fallback = baseFetch();
  let previewCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/preview")) previewCalls++;
    const response = await fallback(input);
    if (!String(input).endsWith("/artifacts")) return response;
    const body = await response.json();
    body.artifacts = body.artifacts.map((artifact: Record<string, unknown>) => ({
      ...artifact, type: "commit", contentMediaType: "application/x-git-bundle"
    }));
    return json(body);
  };
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Results" }));
    assert.ok(page.getByText(/Binary Artifact; inspect code/u));
    assert.equal(page.queryByRole("button", { name: "Inspect evidence" }), null);
    fireEvent.click(page.getByRole("tab", { name: "Artifacts" }));
    assert.ok(page.getByText(/Binary Artifact metadata only/u));
    assert.equal(page.queryByRole("button", { name: "Safe preview" }), null);
    assert.equal(previewCalls, 0);
  } finally { cleanup(); dom.window.close(); }
});

test("Result evidence opens the authorized verified Artifact as text and rejects mismatched previews", async () => {
  const dom = installDom();
  const fallback = baseFetch();
  let mismatch = false;
  const paths: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.endsWith("/preview")) {
      paths.push(path);
      return json({
        artifactId: "artifact_detail_0001", artifactRevision: 1,
        taskId: mismatch ? "task_other_0001" : task.taskId,
        type: "test_result", title: "Focused test evidence", summary: "Verified evidence",
        mediaType: "text/markdown", sha256: "a".repeat(64), sizeBytes: 100,
        integrity: "verified", trust: "untrusted", text: "<script>untrusted evidence</script>", truncated: false
      });
    }
    return fallback(input);
  };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<TaskWorkDetail {...detailProps()} />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: task.title });
    fireEvent.click(page.getByRole("tab", { name: "Results" }));
    fireEvent.click(page.getByRole("button", { name: "Inspect evidence" }));
    const preview = await page.findByRole("region", { name: "Artifact content preview" });
    assert.equal(preview.querySelector("pre > code")?.textContent, "<script>untrusted evidence</script>");
    assert.equal(dom.window.document.querySelector("script"), null);
    assert.deepEqual(paths, [`/api/tasks/${task.taskId}/artifacts/artifact_detail_0001/preview`]);
    fireEvent.click(page.getByRole("button", { name: "Close" }));
    mismatch = true;
    fireEvent.click(page.getByRole("button", { name: "Inspect evidence" }));
    await page.findByText(/Artifact identity or integrity does not match/u);
    await waitFor(() => assert.equal(page.queryByRole("region", { name: "Artifact content preview" }), null));
  } finally {
    cleanup();
    dom.window.close();
  }
});
