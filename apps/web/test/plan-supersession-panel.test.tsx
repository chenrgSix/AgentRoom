import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type {
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanSupersessionControlView
} from "@convene-wire/contracts/execution-plan";
import type { TaskProjection } from "@convene-wire/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";

import { PlanSupersessionPanel } from
  "../src/features/work/PlanSupersessionPanel.js";
import type { Member } from "../src/models.js";

const cases = JSON.parse(await readFile(new URL(
  "../../../packages/contracts/fixtures/execution-plan-cases.json",
  import.meta.url
), "utf8"));
const baseDefinition = cases.cases.find(({ name }: { name: string }) =>
  name === "execution: valid full plan").instance as ExecutionPlanDefinition;
const timestamp = "2026-09-03T08:00:00.000Z";
const rootTask = {
  taskId: "task_supersession_surface0001",
  taskDisplayNumber: 65,
  teamId: "team_supersession_surface0001",
  roomId: "room_supersession_surface0001",
  parentTaskId: null,
  title: "Bounded replan",
  goal: "Review exact candidate and authority",
  lifecycleState: "active",
  schedulingState: "enabled",
  priority: "high",
  ownerMemberId: "member_supersession_owner0001",
  createdByMemberId: "member_supersession_owner0001",
  completionPolicy: "accepted_result_required",
  completionResultId: null,
  isDefault: false,
  taskRevision: 7,
  definitionRevision: 2,
  criteriaRevision: 2,
  criteria: [],
  assignments: [{
    agentId: "agent_00000001", role: "primary",
    assignedAt: timestamp, assignedByMemberId: "member_supersession_owner0001"
  }],
  budgetPolicy: { maxRunAttempts: 8, maxExecutionDurationSeconds: 7200 },
  budgetUsage: { usageRevision: 0, runAttempts: 1,
    executionDurationSeconds: 20, providerTokens: null, providerCostUsd: null },
  attentionReasons: [], nextAction: null, dueAt: null,
  createdAt: timestamp, updatedAt: timestamp
} as TaskProjection;
const owner: Member = {
  memberId: rootTask.ownerMemberId,
  teamId: rootTask.teamId,
  userId: "user_supersession_owner0001",
  displayName: "Owner",
  role: "owner",
  createdAt: timestamp
};

const definition = structuredClone(baseDefinition);
definition.rootTaskId = rootTask.taskId;
const compiledTasks = definition.nodes.map((node, index) => ({
  nodeKey: node.nodeKey,
  taskId: `task_compiled_surface000${index + 1}`,
  taskRevision: 2,
  definitionRevision: 1,
  criteriaRevision: 1
}));
const plan: ExecutionPlanProjection = {
  planId: "plan_supersession_surface0001",
  rootTaskId: rootTask.taskId,
  roomId: rootTask.roomId,
  ownerMemberId: owner.memberId,
  state: "running",
  controlRevision: 3,
  current: {
    planId: "plan_supersession_surface0001",
    revision: 1,
    proposalId: "proposal_supersession_surface0001",
    decisionId: "decision_supersession_surface0001",
    definition,
    author: { kind: "member", memberId: owner.memberId },
    digest: "a".repeat(64),
    createdAt: timestamp
  },
  compiledTasks,
  createdAt: timestamp,
  updatedAt: timestamp
};

function control(
  candidate: ExecutionPlanSupersessionControlView["candidate"] = null
): ExecutionPlanSupersessionControlView {
  return {
    planId: plan.planId,
    currentRevision: 1,
    currentDigest: plan.current.digest,
    controlRevision: 3,
    rootTaskRevision: rootTask.taskRevision,
    candidate,
    activationTemplate: candidate ? {
      candidateId: candidate.candidateId,
      expectedCurrentRevision: 1,
      expectedCurrentDigest: plan.current.digest,
      expectedControlRevision: 3,
      expectedRootTaskRevision: rootTask.taskRevision,
      expectedCandidateRevision: 2,
      expectedCandidateDigest: candidate.candidateDigest,
      carryForward: [{
        targetNodeKey: definition.nodes[0]!.nodeKey,
        gate: "accepted_result",
        sourceAdoptionId: "adoption_supersession_surface0001",
        sourceAdoptionDigest: "c".repeat(64),
        sourceReuseContractId: "reuse_supersession_surface0001",
        sourceNodeReuseContractDigest: "d".repeat(64),
        sourceReuseInputEvidenceDigest: "e".repeat(64)
      }]
    } : null,
    activationBlockerCode: null,
    delegations: []
  };
}

function childTask(index: number): TaskProjection {
  return {
    ...rootTask,
    taskId: compiledTasks[index]!.taskId,
    taskDisplayNumber: 66 + index,
    parentTaskId: rootTask.taskId,
    taskRevision: 10 + index,
    definitionRevision: 4 + index,
    criteriaRevision: 3 + index,
    assignments: [{
      agentId: definition.nodes[index]!.agentId,
      role: "primary",
      assignedAt: timestamp,
      assignedByMemberId: owner.memberId
    }]
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
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

test("Owner prepares fixed-Task candidate and activates only Server carry pins", async () => {
  const dom = installDom();
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  let view = control();
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  let changed = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/supersession-control")) return json(view);
    const childIndex = compiledTasks.findIndex(({ taskId }) => path === `/api/tasks/${taskId}`);
    if (childIndex >= 0) return json(childTask(childIndex));
    if (path.endsWith("/supersession-candidates") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ path, body });
      const candidateDefinition = body.definition as ExecutionPlanDefinition;
      view = control({
        planId: plan.planId,
        candidateId: "candidate_supersession_surface0001",
        candidateRevision: 2,
        candidateDigest: "b".repeat(64),
        baseRevision: 1,
        baseDigest: plan.current.digest,
        baseControlRevision: 3,
        rootTaskRevision: rootTask.taskRevision,
        definition: candidateDefinition,
        author: { kind: "member", memberId: owner.memberId },
        operationId: body.operationId as string,
        requestDigest: "f".repeat(64),
        reason: body.reason as string,
        createdAt: timestamp
      });
      return json(view.candidate);
    }
    if (path.endsWith("/supersession-activations") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push({ path, body });
      return json({
        operationId: body.operationId,
        operationDigest: "1".repeat(64),
        delegationId: null,
        activatedBy: { kind: "member", memberId: owner.memberId },
        candidate: view.candidate,
        carryForward: [],
        plan: {
          ...plan,
          current: {
            ...plan.current,
            revision: 2,
            digest: view.candidate!.candidateDigest,
            definition: view.candidate!.definition
          }
        },
        activatedAt: timestamp
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    render(<PlanSupersessionPanel
      agentNames={new Map([["agent_00000001", "Lead"]])}
      currentMember={owner}
      locale="en"
      onChanged={() => { changed += 1; }}
      plan={plan}
      task={rootTask}
      token="web-session"
    />);
    const page = within(dom.window.document.body);
    await page.findByText("Prepare editable candidate");
    fireEvent.click(page.getByText("Prepare editable candidate"));
    const editor = await page.findByRole("textbox", { name: "Complete candidate plan JSON" });
    const prepared = JSON.parse((editor as HTMLTextAreaElement).value) as ExecutionPlanDefinition;
    assert.deepEqual(prepared.nodes.map(({ task }) => task), compiledTasks.map((compiled, index) => ({
      mode: "existing",
      taskId: compiled.taskId,
      expectedTaskRevision: 10 + index,
      definitionRevision: 4 + index,
      criteriaRevision: 3 + index
    })));
    fireEvent.input(page.getByLabelText("Replanning reason"), {
      target: { value: "Reality changed; retain bounded work." }
    });
    fireEvent.click(page.getByText("Retain candidate"));
    await page.findByText("Candidate awaiting activation");
    assert.equal((posted[0]!.body as { expectedControlRevision: number }).expectedControlRevision, 3);
    assert.ok(page.getByText(/adoption_supersession_surface0001/u));
    fireEvent.input(page.getByLabelText("Activation reason"), {
      target: { value: "Reviewed exact diff and carry proof." }
    });
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByText("Activate exact candidate"));
    await waitFor(() => assert.equal(changed, 1));
    const activation = posted[1]!.body as { carryForward: unknown[]; expectedCandidateDigest: string };
    assert.deepEqual(activation.carryForward, view.activationTemplate!.carryForward);
    assert.equal(activation.expectedCandidateDigest, "b".repeat(64));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("unknown candidate response locks mutations until authoritative reload", async () => {
  const dom = installDom();
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  let view = control();
  let candidatePosts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/supersession-control")) return json(view);
    const childIndex = compiledTasks.findIndex(({ taskId }) => path === `/api/tasks/${taskId}`);
    if (childIndex >= 0) return json(childTask(childIndex));
    if (path.endsWith("/supersession-candidates") && init?.method === "POST") {
      candidatePosts += 1;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      view = control({
        planId: plan.planId,
        candidateId: "candidate_supersession_unknown0001",
        candidateRevision: 2,
        candidateDigest: "7".repeat(64),
        baseRevision: 1,
        baseDigest: plan.current.digest,
        baseControlRevision: 3,
        rootTaskRevision: rootTask.taskRevision,
        definition: body.definition as ExecutionPlanDefinition,
        author: { kind: "member", memberId: owner.memberId },
        operationId: body.operationId as string,
        requestDigest: "6".repeat(64),
        reason: body.reason as string,
        createdAt: timestamp
      });
      throw new TypeError("simulated response loss");
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    render(<PlanSupersessionPanel
      agentNames={new Map([["agent_00000001", "Lead"]])}
      currentMember={owner}
      locale="en"
      onChanged={() => undefined}
      plan={plan}
      task={rootTask}
      token="web-session"
    />);
    const page = within(dom.window.document.body);
    fireEvent.click(await page.findByText("Prepare editable candidate"));
    fireEvent.input(await page.findByLabelText("Replanning reason"), {
      target: { value: "Retain once across response loss." }
    });
    fireEvent.click(page.getByText("Retain candidate"));
    await page.findByText(/New mutations are locked/u);
    assert.equal((page.getByText("Retain candidate") as HTMLButtonElement).disabled, true);
    assert.equal((page.getByLabelText("Complete candidate plan JSON") as HTMLTextAreaElement).disabled, true);
    assert.equal(candidatePosts, 1);

    fireEvent.click(page.getByText("Reload replanning state"));
    await page.findByText("Candidate awaiting activation");
    await waitFor(() => assert.equal(page.queryByText(/New mutations are locked/u), null));
    assert.equal(candidatePosts, 1, "authoritative recovery must not replay the mutation");
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Owner issues and revokes exact primary-Agent delegation", async () => {
  const dom = installDom();
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  let view = control();
  const posted: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/supersession-control")) return json(view);
    if (path.endsWith("/replan-delegations") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      const delegation = {
        delegationId: "replan_supersession_surface0001",
        delegationDigest: "9".repeat(64),
        operationId: body.operationId as string,
        planId: plan.planId,
        planRevision: 1,
        planDigest: plan.current.digest,
        planControlRevision: 3,
        rootTaskRevision: rootTask.taskRevision,
        agentId: "agent_00000001",
        issuedByMemberId: owner.memberId,
        taskIds: compiledTasks.map(({ taskId }) => taskId) as [string, ...string[]],
        expiresAt: body.expiresAt as string,
        reason: body.reason as string,
        revision: 1,
        issuedAt: timestamp
      };
      view = { ...view, delegations: [{ delegation, state: "active" }] };
      return json(delegation);
    }
    if (path.includes("/revocations") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posted.push(body);
      view = { ...view, delegations: view.delegations.map((entry) => ({ ...entry, state: "revoked" })) };
      return json({
        operationId: body.operationId,
        delegationId: view.delegations[0]!.delegation.delegationId,
        delegationRevision: 1,
        delegationDigest: "9".repeat(64),
        revokedByMemberId: owner.memberId,
        reason: body.reason,
        revokedAt: timestamp,
        revocationDigest: "8".repeat(64)
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;
  try {
    render(<PlanSupersessionPanel
      agentNames={new Map([["agent_00000001", "Lead"]])}
      currentMember={owner}
      locale="en"
      onChanged={() => undefined}
      plan={plan}
      task={rootTask}
      token="web-session"
    />);
    const page = within(dom.window.document.body);
    await page.findByText("Tech Lead replanning delegations");
    fireEvent.change(page.getByLabelText("Primary Agent"), { target: { value: "agent_00000001" } });
    fireEvent.input(page.getByLabelText("Delegation reason"), { target: { value: "Bounded lead authority" } });
    fireEvent.click(page.getByText("Issue exact delegation"));
    await page.findByText("active · revision 1");
    assert.equal(posted[0]!.expectedPlanDigest, plan.current.digest);
    const expiresAt = Date.parse(posted[0]!.expiresAt as string);
    assert.ok(expiresAt > Date.now(), "the default local expiry must remain in the future");
    assert.ok(expiresAt <= Date.now() + 61 * 60 * 1000,
      "the default local expiry must stay inside the one-hour window");
    fireEvent.input(page.getByLabelText("Revocation reason"), { target: { value: "Authority no longer needed" } });
    fireEvent.click(page.getByText("Revoke delegation"));
    await page.findByText("revoked · revision 1");
    assert.equal(posted[1]!.expectedDigest, "9".repeat(64));
  } finally {
    cleanup();
    dom.window.close();
  }
});
