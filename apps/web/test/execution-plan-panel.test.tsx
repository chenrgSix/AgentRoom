import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanRevision
} from "@convene-wire/contracts/execution-plan";
import type { TaskProjection } from "@convene-wire/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";

import { ExecutionPlanPanel } from "../src/features/work/ExecutionPlanPanel.js";
import type { Member } from "../src/models.js";

const cases = JSON.parse(await readFile(new URL(
  "../../../packages/contracts/fixtures/execution-plan-cases.json",
  import.meta.url
), "utf8"));
const baseDefinition = cases.cases.find(({ name }: { name: string }) =>
  name === "execution: valid full plan").instance as ExecutionPlanDefinition;

const task: TaskProjection = {
  taskId: "task_plan_surface0001",
  taskDisplayNumber: 63,
  teamId: "team_plan_surface0001",
  roomId: "room_plan_surface0001",
  parentTaskId: null,
  title: "Approve a governed plan",
  goal: "Inspect exact proof before execution.",
  lifecycleState: "ready",
  schedulingState: "enabled",
  priority: "high",
  ownerMemberId: "member_plan_owner0001",
  createdByMemberId: "member_plan_owner0001",
  completionPolicy: "accepted_result_required",
  completionResultId: null,
  isDefault: false,
  taskRevision: 7,
  definitionRevision: 2,
  criteriaRevision: 2,
  criteria: [],
  assignments: [],
  budgetPolicy: { maxRunAttempts: 8, maxExecutionDurationSeconds: 7200 },
  budgetUsage: {
    usageRevision: 0,
    runAttempts: 0,
    executionDurationSeconds: 0,
    providerTokens: null,
    providerCostUsd: null
  },
  attentionReasons: [],
  nextAction: null,
  dueAt: null,
  createdAt: "2026-09-02T09:00:00.000Z",
  updatedAt: "2026-09-02T09:00:00.000Z"
};
const owner: Member = {
  memberId: task.ownerMemberId,
  teamId: task.teamId,
  userId: "user_plan_owner0001",
  displayName: "Owner",
  role: "owner",
  createdAt: task.createdAt
};

function definition(title = "Current <script>unsafe()</script>"): ExecutionPlanDefinition {
  const value = structuredClone(baseDefinition);
  value.rootTaskId = task.taskId;
  value.title = title;
  value.decision.summary = "Inspect <img src=x onerror=unsafe()> as text.";
  return value;
}

function projection(
  revision = 2,
  state: ExecutionPlanProjection["state"] = "draft",
  title?: string
): ExecutionPlanProjection {
  return {
    planId: "plan_surface_control0001",
    rootTaskId: task.taskId,
    roomId: task.roomId,
    ownerMemberId: owner.memberId,
    state,
    controlRevision: state === "draft" ? 1 : 2,
    current: {
      planId: "plan_surface_control0001",
      revision,
      proposalId: `proposal_surface_000${revision}`,
      decisionId: `decision_surface_000${revision}`,
      definition: definition(title ?? (revision === 1 ? "Previous" : undefined)),
      author: { kind: "member", memberId: owner.memberId },
      digest: (revision === 1 ? "b" : "a").repeat(64),
      createdAt: `2026-09-02T09:0${revision}:00.000Z`
    },
    compiledTasks: state === "draft" ? [] : [{
      nodeKey: "build",
      taskId: "task_compiled_build0001",
      taskRevision: 1,
      definitionRevision: 1,
      criteriaRevision: 1
    }],
    createdAt: "2026-09-02T09:01:00.000Z",
    updatedAt: `2026-09-02T09:0${revision}:00.000Z`
  };
}

function revisionOf(plan: ExecutionPlanProjection): ExecutionPlanRevision {
  return plan.current as ExecutionPlanRevision;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example.com/"
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    sessionStorage: { configurable: true, value: dom.window.sessionStorage },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  return dom;
}

interface ServerOptions {
  networkCutOnce?: boolean;
}

function installServer(options: ServerOptions = {}) {
  let active = projection();
  const previous = projection(1);
  const approvals: Array<Record<string, unknown>> = [];
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  let cut = options.networkCutOnce ?? false;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path === `/api/tasks/${task.taskId}/execution-plans?limit=50`) {
      return json({ plans: [active], nextAfterPlanId: null });
    }
    if (path.startsWith(`/api/execution-plans/${active.planId}/revisions?`)) {
      return json({ revisions: active.current.revision === 1
        ? [revisionOf(active)]
        : [revisionOf(previous), revisionOf(active)], nextAfterRevision: null });
    }
    if (path === `/api/execution-plans/${active.planId}/approvals?limit=50`) {
      return json({ approvals, nextAfterRevision: null });
    }
    if (path === `/api/execution-plans/${active.planId}/revisions` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push({ path, body });
      active = {
        ...active,
        current: {
          ...active.current,
          revision: 3,
          proposalId: "proposal_surface_0003",
          decisionId: "decision_surface_0003",
          definition: body.definition as ExecutionPlanDefinition,
          digest: "c".repeat(64),
          createdAt: "2026-09-02T09:03:00.000Z"
        },
        updatedAt: "2026-09-02T09:03:00.000Z"
      };
      return json(active);
    }
    if (path === `/api/execution-plans/${active.planId}/approvals` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push({ path, body });
      if (cut) {
        cut = false;
        throw new TypeError("simulated response loss");
      }
      const approval = {
        ...body,
        planId: active.planId,
        digest: body.expectedDigest,
        revision: body.expectedRevision,
        reviewedByMemberId: owner.memberId,
        reviewedAt: "2026-09-02T09:04:00.000Z",
        rootTaskRevisionBefore: body.expectedRootTaskRevision,
        rootTaskRevisionAfter: Number(body.expectedRootTaskRevision) +
          (body.decision === "approved" ? 1 : 0),
        compiledTasks: body.decision === "approved" ? [{
          nodeKey: "build", taskId: "task_compiled_build0001",
          taskRevision: 1, definitionRevision: 1, criteriaRevision: 1
        }] : []
      };
      approvals.push(approval);
      active = projection(2, body.decision === "approved" ? "approved" : "draft");
      return json({ approval, plan: active });
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  return { bodies, get active() { return active; } };
}

type Render = typeof import("@testing-library/react")["render"];

function renderPanel(render: Render, member: Member | null = owner) {
  return render(<ExecutionPlanPanel
    agentNames={new Map([[baseDefinition.nodes[0]!.agentId, "Builder"]])}
    currentMember={member}
    locale="en"
    onChanged={() => undefined}
    task={task}
    token="web-session"
  />);
}

test("plan surface renders exact graph blockers diff and untrusted text safely", async () => {
  const dom = installDom();
  const { cleanup, render, within } = await import("@testing-library/react");
  installServer();
  try {
    renderPanel(render);
    const page = within(dom.window.document.body);
    await page.findByText("Exact identity");
    assert.ok(page.getByText("Dependency edges"));
    assert.ok(page.getByText("Diff from previous revision"));
    assert.ok(page.getByText("changed"));
    assert.ok(page.getByText("$plan.title"));
    assert.ok(page.getByText("Current <script>unsafe()</script>"));
    assert.equal(dom.window.document.querySelector("script"), null);
    assert.match(page.getByLabelText("Approval blockers").textContent ?? "", /Server still rechecks/u);
    assert.match(page.getByText("Exact identity").parentElement?.textContent ?? "", /a{64}/u);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("owner revision and approval bind exact current Server pins", async () => {
  const dom = installDom();
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  const server = installServer();
  try {
    renderPanel(render);
    const page = within(dom.window.document.body);
    await page.findByRole("button", { name: "Edit current draft" });
    fireEvent.click(page.getByRole("button", { name: "Edit current draft" }));
    const editor = page.getByRole("textbox", { name: "Complete plan definition JSON" });
    const edited = JSON.parse((editor as HTMLTextAreaElement).value);
    edited.title = "Human revised exact plan";
    fireEvent.input(editor, { target: { value: JSON.stringify(edited) } });
    fireEvent.click(page.getByRole("button", { name: "Submit new revision" }));
    await page.findByText("Human revised exact plan");
    const revision = server.bodies[0]!.body;
    assert.equal(revision.expectedRevision, 2);
    assert.equal(revision.expectedRootTaskRevision, task.taskRevision);
    assert.equal((revision.definition as { title: string }).title, "Human revised exact plan");
    assert.match(String(revision.operationId), /^op_/u);

    fireEvent.input(page.getByRole("textbox", { name: "Review reason" }), {
      target: { value: "Approve the exact graph and authority boundaries." }
    });
    fireEvent.click(page.getByRole("checkbox", {
      name: /I confirm approval of exact revision r3/u
    }));
    const approve = page.getByRole("button", { name: "Approve exact plan" }) as HTMLButtonElement;
    await waitFor(() => assert.equal(approve.disabled, false));
    fireEvent.click(approve);
    await page.findByText("Confirmed now");
    const review = server.bodies[1]!.body;
    assert.equal(review.expectedRevision, 3);
    assert.equal(review.expectedDigest, "c".repeat(64));
    assert.equal(review.expectedRootTaskRevision, task.taskRevision);
    assert.equal(review.decision, "approved");
    assert.equal(dom.window.sessionStorage.length, 0);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("response loss keeps only the exact review command and retries it unchanged", async () => {
  const dom = installDom();
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  const server = installServer({ networkCutOnce: true });
  try {
    renderPanel(render);
    const page = within(dom.window.document.body);
    await page.findByRole("textbox", { name: "Review reason" });
    fireEvent.input(page.getByRole("textbox", { name: "Review reason" }), {
      target: { value: "Approve after exact inspection." }
    });
    fireEvent.click(page.getByRole("checkbox", {
      name: /I confirm approval of exact revision r2/u
    }));
    const approve = page.getByRole("button", { name: "Approve exact plan" }) as HTMLButtonElement;
    await waitFor(() => assert.equal(approve.disabled, false));
    fireEvent.click(approve);
    await page.findByRole("button", { name: "Retry the exact same command" });
    const raw = dom.window.sessionStorage.getItem(dom.window.sessionStorage.key(0)!)!;
    assert.doesNotMatch(raw, /Current|definition|sourceBytes|web-session/u);
    fireEvent.click(page.getByRole("button", { name: "Retry the exact same command" }));
    await page.findByText("Confirmed now");
    assert.deepEqual(server.bodies[0]!.body, server.bodies[1]!.body);
    assert.equal(dom.window.sessionStorage.length, 0);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("non-owner can inspect but has no revision or human review controls", async () => {
  const dom = installDom();
  const { cleanup, render, within } = await import("@testing-library/react");
  installServer();
  try {
    renderPanel(render, {
      ...owner,
      memberId: "member_plan_observer0001",
      role: "member"
    });
    const page = within(dom.window.document.body);
    await page.findByText("Exact identity");
    assert.equal(page.queryByRole("button", { name: "Edit current draft" }), null);
    assert.equal(page.queryByRole("button", { name: "Approve exact plan" }), null);
    assert.equal(page.queryByRole("textbox", { name: "Review reason" }), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("late plan facts cannot replace the newly selected proposal", async () => {
  const dom = installDom();
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  const first = projection();
  const second: ExecutionPlanProjection = {
    ...projection(1),
    planId: "plan_surface_second0001",
    current: {
      ...projection(1).current,
      planId: "plan_surface_second0001",
      definition: definition("Second selected plan")
    },
    updatedAt: "2026-09-02T10:00:00.000Z"
  };
  let releaseFirst: (() => void) | undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input);
    if (path.includes(`/api/tasks/${task.taskId}/execution-plans`)) {
      return json({ plans: [first, second], nextAfterPlanId: null });
    }
    if (path.includes(`/${second.planId}/revisions`)) {
      return json({ revisions: [second.current], nextAfterRevision: null });
    }
    if (path.includes(`/${second.planId}/approvals`)) {
      return json({ approvals: [], nextAfterRevision: null });
    }
    if (path.includes(`/${first.planId}/`)) {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return path.includes("revisions")
        ? json({ revisions: [projection(1).current, first.current], nextAfterRevision: null })
        : json({ approvals: [], nextAfterRevision: null });
    }
    throw new Error(path);
  }) as typeof fetch;
  try {
    renderPanel(render);
    const page = within(dom.window.document.body);
    await page.findByText("Second selected plan");
    fireEvent.change(page.getByRole("combobox", { name: "Plan proposal" }), {
      target: { value: first.planId }
    });
    fireEvent.change(page.getByRole("combobox", { name: "Plan proposal" }), {
      target: { value: second.planId }
    });
    releaseFirst?.();
    await waitFor(() => assert.ok(page.getByText("Second selected plan")));
    assert.equal(page.queryByText("Current <script>unsafe()</script>"), null);
  } finally {
    releaseFirst?.();
    cleanup();
    dom.window.close();
  }
});
