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
    assert.ok(page.getByText(result.proposal.summary));
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
