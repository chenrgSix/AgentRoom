import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExecutionPlanProjection } from "@convene-wire/contracts/execution-plan";
import { JSDOM } from "jsdom";
import React from "react";
import { fixture } from "../../server/test/helpers/execution-plan-fixture.js";
import { ExecutionPlanPanel } from "../src/features/work/ExecutionPlanPanel.js";
import { commonPlanDefinition } from "../src/features/work/PlanDefinitionEditor.js";
import { advanceWebSessionGeneration } from "../src/api-client.js";

async function panel(t: TestContext, existing = false) {
  const f = await fixture(t);
  const command = f.command();
  if (existing) {
    const node = command.definition.nodes[0]!;
    const task = await f.ok("POST", `/api/rooms/${f.roomId}/tasks`, { title: "Linked work", goal: "Keep independent definition", completionPolicy: "accepted_result_required", criteria: node.task.criteria, assignments: [{ agentId: f.agentId, role: "primary" }] });
    node.task = { mode: "existing", taskId: task.taskId, expectedTaskRevision: task.taskRevision, definitionRevision: task.definitionRevision, criteriaRevision: task.criteriaRevision };
  }
  const original = await f.create(command);
  const otherAgent = (await f.ok("POST", `/api/teams/${f.teamId}/manual-agents`, { name: "Alternate", role: "Builder" })).agent;
  await f.ok("PUT", `/api/rooms/${f.roomId}/participants`, { memberIds: [f.ownerMemberId], agentIds: [f.agentId, otherAgent.agentId] });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  const originalFetch = globalThis.fetch;
  for (const key of ["document", "HTMLElement", "navigator", "window", "sessionStorage"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
  advanceWebSessionGeneration();
  const testing = await import("@testing-library/react"); testing.configure({ asyncUtilTimeout: 10_000 });
  t.after(() => {
    testing.cleanup(); globalThis.fetch = originalFetch; dom.window.close();
    for (const key of ["document", "HTMLElement", "navigator", "window", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]!); else Reflect.deleteProperty(globalThis, key);
    }
  });
  const writes: Array<{ path: string; body: Record<string, any>; status: number }> = [];
  let lose = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const response = await f.request((init.method ?? "GET") as "GET" | "POST", url, body, new Headers(init.headers).get("authorization") ?? "");
    if (init.method === "POST") {
      writes.push({ path: url, body, status: response.statusCode });
      if (lose) { lose = false; throw new TypeError("Lost real committed revision response"); }
    }
    return new Response(response.body, { status: response.statusCode });
  };
  testing.render(<ExecutionPlanPanel agentNames={new Map([[f.agentId, "Builder"], [otherAgent.agentId, "Alternate"]])} currentMember={{ memberId: f.ownerMemberId, teamId: f.teamId, userId: "user_execution_owner0001", displayName: "Owner", role: "owner", createdAt: f.root.createdAt }} locale="en" onChanged={() => {}} task={f.root} token={f.authorization.slice(7)} />);
  const page = testing.within(dom.window.document.body);
  await page.findByRole("button", { name: "Edit current draft" });
  testing.fireEvent.click(page.getByRole("button", { name: "Edit current draft" }));
  return { ...f, ...testing, page, original, otherAgent, writes, loseNext: () => { lose = true; }, current: async () => await f.ok("GET", `/api/execution-plans/${original.planId}`) as ExecutionPlanProjection };
}

test("common goal, Agent and budget edits retain every other full-definition field in real immutable history", async (t) => {
  const f = await panel(t); const before = f.counts();
  const expected = structuredClone(f.original.current.definition);
  const node = expected.nodes[0]!;
  f.fireEvent.change(f.page.getByLabelText("Plan title"), { target: { value: "A reviewed form revision" } }); expected.title = "A reviewed form revision";
  f.fireEvent.change(f.page.getByLabelText(`Task goal · ${node.nodeKey}`), { target: { value: "Clear goal\nwith evidence" } }); node.task.goal = "Clear goal\nwith evidence";
  f.fireEvent.change(f.page.getByLabelText(`Execution Agent · ${node.nodeKey}`), { target: { value: f.otherAgent.agentId } }); node.agentId = f.otherAgent.agentId;
  f.fireEvent.change(f.page.getByLabelText("Plan attempt budget"), { target: { value: "12" } }); expected.policy.budget.maxRunAttempts = 12;
  f.fireEvent.change(f.page.getByLabelText(`Execution budget (seconds) · ${node.nodeKey}`), { target: { value: "1800" } }); node.budget.maxExecutionDurationSeconds = 1800;
  f.fireEvent.click(f.page.getByRole("button", { name: "Submit new revision" }));
  await f.page.findByRole("button", { name: "Edit current draft" });
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0]!.status, 200);
  const current = await f.current(); assert.deepEqual(current.current.definition, expected);
  assert.equal(current.state, "draft"); assert.deepEqual(current.compiledTasks, []);
  const history = await f.ok("GET", `/api/execution-plans/${current.planId}/revisions`);
  assert.deepEqual(history.revisions[0], f.original.current); assert.equal(history.revisions.length, 2);
  assert.equal(f.counts().runs, before.runs); assert.equal(f.counts().agent_tasks, before.agent_tasks);
  assert.equal(f.counts().execution_plan_approvals, 0);
  assert.equal((f.page.getByRole("button", { name: "Approve exact plan" }) as HTMLButtonElement).disabled, true);
});

test("numeric limits block form submission and malformed advanced JSON stays editable without losing its contents", async (t) => {
  const f = await panel(t);
  f.fireEvent.change(f.page.getByLabelText("Max concurrency"), { target: { value: "9" } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Submit new revision" }));
  assert.equal(f.writes.length, 0);
  f.fireEvent.change(f.page.getByLabelText("Max concurrency"), { target: { value: "2" } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Advanced JSON" }));
  const malformed = '{"title":"Unfinished",';
  f.fireEvent.change(f.page.getByLabelText("Complete plan definition JSON"), { target: { value: malformed } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Common fields" }));
  assert.match(f.page.getByRole("alert").textContent ?? "", /cannot be displayed/u);
  f.fireEvent.click(f.page.getByRole("button", { name: "Advanced JSON" }));
  assert.equal((f.page.getByLabelText("Complete plan definition JSON") as HTMLTextAreaElement).value, malformed);
  f.fireEvent.click(f.page.getByRole("button", { name: "Submit new revision" }));
  assert.equal(f.writes.length, 0);
  const invalid = structuredClone(f.original.current.definition); invalid.policy.maxConcurrency = 9;
  f.fireEvent.change(f.page.getByLabelText("Complete plan definition JSON"), { target: { value: JSON.stringify(invalid) } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Submit new revision" }));
  await f.waitFor(() => assert.equal(f.writes.length, 1));
  assert.equal(f.writes[0]!.status, 400); assert.equal((await f.current()).current.revision, 1);
});

test("refresh during an edit retains the original CAS pins and cannot overwrite a competing revision", async (t) => {
  const f = await panel(t);
  f.fireEvent.change(f.page.getByLabelText("Plan title"), { target: { value: "Old editor content" } });
  const other = f.command(); other.definition.title = "Competing revision";
  await f.ok("POST", `/api/execution-plans/${f.original.planId}/revisions`, { ...other, operationId: "op_competing_form0001", expectedRevision: 1 });
  f.fireEvent.click(f.page.getByRole("button", { name: "Reload authoritative state" }));
  await f.page.findByRole("textbox", { name: "Plan title" });
  f.fireEvent.click(f.page.getByRole("button", { name: "Submit new revision" }));
  await f.waitFor(() => assert.equal(f.writes.length, 1));
  assert.equal(f.writes[0]!.body.expectedRevision, 1); assert.equal(f.writes[0]!.status, 409);
  assert.equal((await f.current()).current.definition.title, "Competing revision");
});

test("a lost committed revision response freezes editing and retries the exact command after refreshing", async (t) => {
  const f = await panel(t); f.loseNext();
  f.fireEvent.change(f.page.getByLabelText("Plan title"), { target: { value: "One retained revision" } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Submit new revision" }));
  await f.page.findByRole("button", { name: "Retry exact revision" });
  assert.equal(f.page.getByLabelText("Plan title").matches(":disabled"), true);
  assert.equal((await f.current()).current.revision, 2);
  f.fireEvent.click(f.page.getByRole("button", { name: "Reload authoritative state" }));
  await f.page.findByRole("button", { name: "Retry exact revision" });
  f.fireEvent.click(f.page.getByRole("button", { name: "Retry exact revision" }));
  await f.page.findByRole("button", { name: "Edit current draft" });
  assert.equal(f.writes.length, 2); assert.deepEqual(f.writes[0]!.body, f.writes[1]!.body);
  assert.equal((await f.current()).current.revision, 2); assert.equal(f.counts().execution_plan_approvals, 0);
});

test("existing Task references retain their revision pins and never acquire replacement goal fields", async (t) => {
  const f = await panel(t, true); const node = f.original.current.definition.nodes[0]!;
  assert.equal(f.page.queryByLabelText(`Task goal · ${node.nodeKey}`), null);
  f.fireEvent.change(f.page.getByLabelText("Plan title"), { target: { value: "Same linked Task" } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Submit new revision" }));
  await f.page.findByRole("button", { name: "Edit current draft" });
  assert.equal(f.writes[0]!.status, 200);
  assert.deepEqual((await f.current()).current.definition.nodes[0]!.task, node.task);
});

test("unexpected advanced form shapes never cause unchecked property access", () => {
  for (const value of [null, [], {}, { title: "x", policy: null }, { title: "x", policy: { budget: {} }, nodes: [null] }]) assert.equal(commonPlanDefinition(JSON.stringify(value)), null);
});
