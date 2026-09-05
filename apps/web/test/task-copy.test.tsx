import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TaskProjection } from "@convene-wire/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";
import { createServerApp } from "../../server/src/app.js";
import { TaskCopyControl, copyTaskDefinition } from "../src/features/task/TaskCopyControl.js";
import { advanceWebSessionGeneration } from "../src/api-client.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-task-copy-"));
  const server = await createServerApp({ databasePath: path.join(directory, "server.sqlite"), logger: false });
  const originalFetch = globalThis.fetch;
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const key of ["document", "HTMLElement", "navigator", "window", "sessionStorage"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
  advanceWebSessionGeneration();
  const testing = await import("@testing-library/react");
  testing.configure({ asyncUtilTimeout: 10_000 });
  t.after(async () => {
    testing.cleanup(); globalThis.fetch = originalFetch;
    await server.close(); dom.window.close();
    for (const key of ["document", "HTMLElement", "navigator", "window", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (descriptors[key]) Object.defineProperty(globalThis, key, descriptors[key]!); else Reflect.deleteProperty(globalThis, key);
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function seed(url: string, payload?: object, token?: string) {
    const response = await server.inject({ method: payload ? "POST" : "GET", url, ...(payload ? { payload } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`); return response.json();
  }
  const bootstrap = await seed("/api/bootstrap", { userId: "user_task_copy0001", displayName: "Copy Owner" });
  const token = bootstrap.session.token as string;
  await seed("/api/teams", { name: "Copy Team" }, token);
  const [team] = await seed("/api/teams", undefined, token);
  const room = await seed(`/api/teams/${team.teamId}/rooms`, { name: "Copy Room" }, token);
  const source = await seed(`/api/rooms/${room.roomId}/tasks`, {
    title: "A reusable task", goal: "Goal\nwith a second line", completionPolicy: "accepted_result_required", priority: "urgent",
    criteria: [{ criterionKey: "criterion_required", description: "Required\nmultiline", required: true, ordinal: 1 }, { criterionKey: "criterion_optional", description: "Optional check", required: false, ordinal: 2 }]
  }, token) as TaskProjection;
  const writes: Array<Record<string, unknown>> = [];
  let mode: "normal" | "denied" | "drift" | "lost" = "normal";
  const dispatch: typeof fetch = async (input, init = {}) => {
    if (mode === "denied") return new Response(JSON.stringify({ message: "Denied" }), { status: 403 });
    if (mode === "drift" && String(input) === `/api/tasks/${source.taskId}`) return new Response(JSON.stringify({ ...source, definitionRevision: source.definitionRevision + 1 }));
    if (init.method === "POST") writes.push(JSON.parse(String(init.body)));
    const response = await server.inject({ method: (init.method ?? "GET") as "GET" | "POST", url: String(input), headers: Object.fromEntries(new Headers(init.headers).entries()), ...(init.body ? { payload: String(init.body) } : {}) });
    if (mode === "lost" && init.method === "POST") throw new TypeError("Response lost after real commit");
    return new Response(response.body, { status: response.statusCode });
  };
  globalThis.fetch = dispatch;
  let created: TaskProjection | undefined;
  const props = { task: source, locale: "en" as const, token, roomName: room.name as string, onCreated: (value: TaskProjection) => { created = value; } };
  const mounted = testing.render(<TaskCopyControl {...props} />);
  const page = testing.within(dom.window.document.body);
  return { ...testing, page, mounted, props, source, writes, dispatch, seed, token, room, setMode: (value: typeof mode) => { mode = value; }, getCreated: () => created };
}

test("explicit copy creates an independent server draft while preserving multiline and optional criterion semantics", async (t) => {
  const f = await fixture(t);
  f.fireEvent.click(f.page.getByRole("button", { name: "Copy as draft" }));
  assert.equal(f.writes.length, 0);
  assert.equal((f.page.getByLabelText("Criterion 1") as HTMLTextAreaElement).value, "Required\nmultiline");
  assert.equal((f.page.getByLabelText("Criterion 2 required") as HTMLInputElement).checked, false);
  f.fireEvent.change(f.page.getByLabelText("Task title"), { target: { value: "Reviewed copy" } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Create new draft" }));
  await f.waitFor(() => assert.ok(f.getCreated()));
  const created = f.getCreated()!;
  assert.notEqual(created.taskId, f.source.taskId);
  assert.equal(created.title, "Reviewed copy");
  assert.equal(created.lifecycleState, "draft");
  assert.equal(created.completionPolicy, "accepted_result_required");
  assert.equal(created.goal, f.source.goal);
  assert.deepEqual(created.criteria.map(({ description, required }) => ({ description, required })), f.source.criteria.map(({ description, required }) => ({ description, required })));
  assert.deepEqual(created.assignments, []);
  assert.equal(created.parentTaskId, null);
  assert.equal(created.completionResultId, null);
  assert.equal(created.budgetUsage.runAttempts, 0);
  assert.deepEqual(Object.keys(f.writes[0]!).sort(), ["completionPolicy", "criteria", "goal", "lifecycleState", "title"]);
  assert.equal(f.page.queryByRole("dialog"), null);
  const untouched = await f.seed(`/api/tasks/${f.source.taskId}`, undefined, f.token) as TaskProjection;
  assert.deepEqual(untouched, f.source);
});

test("copied criteria can be removed and added on LAN HTTP without crypto, and empty criteria cannot submit", async (t) => {
  const f = await fixture(t);
  f.fireEvent.click(f.page.getByRole("button", { name: "Copy as draft" }));
  f.fireEvent.click(f.page.getByRole("button", { name: "Remove criterion 1" }));
  f.fireEvent.click(f.page.getByRole("button", { name: "Add criterion" }));
  assert.equal((f.page.getByRole("button", { name: "Create new draft" }) as HTMLButtonElement).disabled, true);
  f.fireEvent.change(f.page.getByLabelText("Criterion 2"), { target: { value: "New check" } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Create new draft" }));
  await f.waitFor(() => assert.ok(f.getCreated()));
  const criteria = f.getCreated()!.criteria;
  assert.deepEqual(criteria.map((criterion) => criterion.required), [false, true]);
  assert.equal(new Set(criteria.map((criterion) => criterion.criterionKey)).size, 2);
});

for (const mode of ["denied", "drift"] as const) test(`${mode} source blocks Task creation`, async (t) => {
  const f = await fixture(t); f.setMode(mode);
  f.fireEvent.click(f.page.getByRole("button", { name: "Copy as draft" }));
  f.fireEvent.click(f.page.getByRole("button", { name: "Create new draft" }));
  await f.page.findByRole("alert");
  assert.equal(f.writes.length, 0); assert.equal(f.getCreated(), undefined);
});

test("response loss after a real creation blocks blind retry and leaves one new draft to inspect", async (t) => {
  const f = await fixture(t); f.setMode("lost");
  f.fireEvent.click(f.page.getByRole("button", { name: "Copy as draft" }));
  f.fireEvent.click(f.page.getByRole("button", { name: "Create new draft" }));
  await f.waitFor(() => assert.match(f.page.getByRole("alert").textContent ?? "", /Creation is unconfirmed/u));
  assert.equal((f.page.getByRole("button", { name: "Create new draft" }) as HTMLButtonElement).disabled, true);
  f.fireEvent.click(f.page.getByRole("button", { name: "Create new draft" }));
  assert.equal(f.writes.length, 1);
  const tasks = await f.seed(`/api/rooms/${f.room.roomId}/tasks`, undefined, f.token) as TaskProjection[];
  assert.equal(tasks.filter((task) => task.title === "A reusable task (copy)" && task.lifecycleState === "draft").length, 1);
});

test("late source read after a session switch cannot create or navigate", async (t) => {
  const f = await fixture(t);
  let finish!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>((resolve) => { finish = resolve; });
  f.fireEvent.click(f.page.getByRole("button", { name: "Copy as draft" }));
  f.fireEvent.click(f.page.getByRole("button", { name: "Create new draft" }));
  await f.waitFor(() => assert.equal(typeof finish, "function"));
  f.mounted.unmount(); advanceWebSessionGeneration();
  await f.act(async () => { finish(new Response(JSON.stringify(f.source))); });
  assert.equal(f.writes.length, 0); assert.equal(f.getCreated(), undefined);
});

test("copy definition is a bounded allowlist even when the source has completed execution state", () => {
  const copied = copyTaskDefinition({ title: "Long ".repeat(100), goal: "Goal", completionPolicy: "owner_confirmed", lifecycleState: "completed", completionResultId: "result_old", assignments: [{ agentId: "agent_old" }], criteria: [] } as unknown as TaskProjection, "en");
  assert.equal(copied.title.length, 160); assert.equal(copied.lifecycleState, "draft");
  assert.deepEqual(Object.keys(copied).sort(), ["completionPolicy", "criteria", "goal", "lifecycleState", "title"]);
});
