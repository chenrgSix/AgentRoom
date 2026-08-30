import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";

import { JSDOM } from "jsdom";
import { useState } from "react";

import { advanceWebSessionGeneration } from "../src/api-client.js";
import { useWorkspaceNavigation } from "../src/features/navigation/useWorkspaceNavigation.js";
import type { WorkspaceNavigation } from "../src/features/navigation/workspace-navigation.js";
import type { LocalSession, Room, Team } from "../src/models.js";

const now = "2026-08-31T10:00:00.000Z";
const teamA: Team = { teamId: "team_navigation_0001", name: "Team A", createdAt: now };
const teamB: Team = { teamId: "team_navigation_0002", name: "Team B", createdAt: now };
const roomA: Room = { roomId: "room_navigation_0001", teamId: teamA.teamId, name: "Room A", settingsRevision: 1, createdAt: now };
const roomA2: Room = { ...roomA, roomId: "room_navigation_0003", name: "Room A2" };
const roomB: Room = { ...roomA, roomId: "room_navigation_0002", teamId: teamB.teamId, name: "Room B" };
const taskA = { taskId: "task_navigation_0001", teamId: teamA.teamId, roomId: roomA.roomId, title: "Task A" };
const taskA2 = { ...taskA, taskId: "task_navigation_0003", roomId: roomA2.roomId, title: "Task A2" };
const taskB = { ...taskA, taskId: "task_navigation_0002", teamId: teamB.teamId, roomId: roomB.roomId, title: "Task B" };
const session: LocalSession = { userId: "user_navigation_0001", displayName: "Navigator", token: "DO_NOT_SHARE_SESSION_TOKEN" };
const fallback: WorkspaceNavigation = { teamId: teamA.teamId, view: "work" };
type Options = Parameters<typeof useWorkspaceNavigation>[0];

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function environment(t: TestContext, query = "") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `https://team.example.com/workspace/${query}` });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  advanceWebSessionGeneration();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; signal: AbortSignal | null | undefined }> = [];
  const restored: WorkspaceNavigation[] = [];
  const errors: string[] = [];
  const copied: string[] = [];
  let intercept: (path: string, init: RequestInit) => Response | Promise<Response> | undefined = () => undefined;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    assert.equal(init.method ?? "GET", "GET", "navigation must never issue a domain command");
    requests.push({ path, signal: init.signal });
    const custom = intercept(path, init);
    if (custom !== undefined) return custom;
    const task = [taskA, taskA2, taskB].find(({ taskId }) => path === `/api/tasks/${taskId}`);
    if (task) return json(task);
    if (path === `/api/teams/${teamA.teamId}/rooms`) return json([roomA, roomA2]);
    if (path === `/api/teams/${teamB.teamId}/rooms`) return json([roomB]);
    throw new Error(`Unexpected navigation read: ${path}`);
  };
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (value: string) => { copied.push(value); } }
  });
  const testing = await import("@testing-library/react");
  t.after(async () => {
    testing.cleanup();
    await setImmediate();
    globalThis.fetch = originalFetch;
    dom.window.close();
  });
  const defaults: Options = {
    session, ready: true, teams: [teamA, teamB], snapshot: { ...fallback, roomId: roomA.roomId },
    onRestore: () => undefined, onError: (message) => { errors.push(message); }
  };
  return {
    dom, testing, requests, restored, errors, copied,
    intercept(value: typeof intercept) { intercept = value; },
    render(overrides: Partial<Options> = {}) {
      const initial = { ...defaults, ...overrides };
      return testing.renderHook((props: Options) => {
        const [snapshot, setSnapshot] = useState(props.snapshot);
        return useWorkspaceNavigation({ ...props, snapshot, onRestore: (navigation) => {
          restored.push(navigation);
          setSnapshot(navigation);
        } });
      }, { initialProps: initial });
    },
    async settle() { await testing.act(async () => { await setImmediate(); }); },
    async pop(query: string) {
      await testing.act(async () => {
        dom.window.history.replaceState(null, "", `/workspace/${query}`);
        dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
        await setImmediate();
      });
    },
    defaults
  };
}

test("initial URL waits for session readiness and restores only Server-authorized resources", async (t) => {
  const query = `?team=${teamB.teamId}&room=${roomB.roomId}&workTask=${taskB.taskId}&view=work&tab=results&scope=team&state=review&search=+Ship+`;
  const env = await environment(t, query);
  const hook = env.render({ ready: false });
  await env.settle();
  assert.deepEqual(env.requests, []);
  assert.deepEqual(env.restored, []);
  await env.testing.act(async () => { hook.rerender({ ...env.defaults, ready: true }); await setImmediate(); });
  assert.deepEqual(env.requests.map(({ path }) => path), [`/api/tasks/${taskB.taskId}`, `/api/teams/${teamB.teamId}/rooms`]);
  assert.deepEqual(env.restored, [{
    teamId: teamB.teamId, roomId: roomB.roomId, workTaskId: taskB.taskId,
    view: "work", tab: "results", scope: "team", lifecycleState: "review", search: "Ship"
  }]);
  assert.equal(hook.result.current.restoring, false);
  assert.deepEqual(env.errors, []);
  assert.equal(new URL(env.dom.window.location.href).searchParams.get("search"), "Ship");
});

for (const [key, task, view] of [["workTask", taskB, "work"], ["task", taskA2, "room"]] as const) {
  test(`legacy ${key}-only links infer Team and Room from the authorized Task`, async (t) => {
    const env = await environment(t, `?${key}=${task.taskId}`);
    env.render();
    await env.settle();
    const restored = env.restored.at(-1)!;
    assert.equal(restored.teamId, task.teamId);
    assert.equal(restored.roomId, task.roomId);
    assert.equal(restored[key === "workTask" ? "workTaskId" : "taskId"], task.taskId);
    assert.equal(restored.view ?? (restored.workTaskId ? "work" : "room"), view);
    assert.deepEqual(env.errors, []);
  });
}

for (const [name, query] of [
  ["Task and explicit Team mismatch", `?team=${teamA.teamId}&workTask=${taskB.taskId}`],
  ["Task and explicit Room mismatch", `?team=${teamA.teamId}&room=${roomA.roomId}&task=${taskA2.taskId}`],
  ["Room and explicit Team mismatch", `?team=${teamA.teamId}&room=${roomB.roomId}&view=room`],
  ["inaccessible Team", "?team=team_unavailable_0001&view=work"]
] as const) {
  test(`${name} gives feedback and falls back without applying the target`, async (t) => {
    const env = await environment(t, query);
    const hook = env.render();
    await env.settle();
    assert.deepEqual(env.restored, [fallback]);
    assert.equal(env.errors.length, 1);
    assert.match(env.errors[0]!, /不可用|访问权限|不属于/u);
    assert.equal(hook.result.current.restoring, false);
    assert.equal(new URL(env.dom.window.location.href).searchParams.has("task"), false);
    assert.equal(new URL(env.dom.window.location.href).searchParams.has("workTask"), false);
  });
}

test("an inaccessible Task gives friendly fallback feedback instead of applying its identifier", async (t) => {
  const env = await environment(t, "?workTask=task_unavailable_0001");
  env.intercept((path) => path === "/api/tasks/task_unavailable_0001"
    ? json({ error: { message: "Task not found" } }, 404) : undefined);
  const hook = env.render();
  await env.settle();
  assert.deepEqual(env.restored, [fallback]);
  assert.equal(env.requests.length, 1, "a rejected Task must not trigger a derived Room read");
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0]!, /链接|访问权限/u);
  assert.equal(hook.result.current.restoring, false);
});

test("mixed Task parameters cannot preserve an unvalidated Task or trigger a resource read", async (t) => {
  const env = await environment(t, `?view=room&task=task_unavailable_0001&workTask=${taskB.taskId}`);
  env.render();
  await env.settle();
  assert.deepEqual(env.requests, []);
  assert.deepEqual(env.restored, [fallback]);
  assert.equal(env.errors.length, 1);
});

test("popstate resolves the new target and the clean entry point resets to safe Work", async (t) => {
  const env = await environment(t, `?workTask=${taskA.taskId}`);
  env.render();
  await env.settle();
  await env.pop(`?workTask=${taskB.taskId}&tab=runs&run=run_navigation_0001`);
  assert.equal(env.restored.at(-1)?.workTaskId, taskB.taskId);
  assert.equal(env.restored.at(-1)?.teamId, teamB.teamId);
  assert.equal(env.restored.at(-1)?.tab, "runs");
  const requests = env.requests.length;
  await env.pop("");
  assert.deepEqual(env.restored.at(-1), fallback);
  assert.equal(env.requests.length, requests);
});

test("late Task resolution cannot overwrite a subsequent in-app navigation or issue derived reads", async (t) => {
  const env = await environment(t, `?workTask=${taskA.taskId}`);
  const late = deferred<Response>();
  env.intercept((path) => path === `/api/tasks/${taskA.taskId}` ? late.promise : undefined);
  const hook = env.render();
  await env.settle();
  assert.equal(hook.result.current.restoring, true);
  env.testing.act(() => hook.result.current.navigate({ view: "agents", workTaskId: undefined, taskId: undefined }));
  assert.equal(env.requests[0]?.signal?.aborted, true);
  late.resolve(json(taskA));
  await env.settle();
  assert.equal(env.requests.length, 1);
  assert.equal(env.restored.length, 1);
  assert.equal(env.restored[0]?.view, "agents");
  assert.equal(hook.result.current.restoring, false);
  assert.equal(new URL(env.dom.window.location.href).searchParams.get("view"), "agents");
});

test("a session replacement retires the pending Task resolution before any derived Room read", async (t) => {
  const env = await environment(t, `?workTask=${taskA.taskId}`);
  const late = deferred<Response>();
  let taskReads = 0;
  env.intercept((path) => path === `/api/tasks/${taskA.taskId}` && ++taskReads === 1 ? late.promise : undefined);
  const hook = env.render();
  await env.settle();
  await env.testing.act(async () => {
    advanceWebSessionGeneration();
    hook.rerender({ ...env.defaults, session: { ...session, token: "new-session-token" } });
    await setImmediate();
  });
  assert.equal(env.requests[0]?.signal?.aborted, true);
  assert.equal(env.restored.length, 1);
  const requestCount = env.requests.length;
  late.resolve(json(taskA));
  await env.settle();
  assert.equal(env.requests.length, requestCount);
  assert.equal(env.restored.length, 1);
  assert.deepEqual(env.errors, []);
  assert.equal(hook.result.current.restoring, false);
});

test("unmount aborts pending restoration, removes popstate, and ignores a late Task", async (t) => {
  const env = await environment(t, `?workTask=${taskA.taskId}`);
  const late = deferred<Response>();
  env.intercept((path) => path === `/api/tasks/${taskA.taskId}` ? late.promise : undefined);
  const hook = env.render();
  await env.settle();
  hook.unmount();
  assert.equal(env.requests[0]?.signal?.aborted, true);
  late.resolve(json(taskA));
  await env.settle();
  await env.pop(`?workTask=${taskB.taskId}`);
  assert.equal(env.requests.length, 1);
  assert.deepEqual(env.restored, []);
  assert.deepEqual(env.errors, []);
});

test("copied canonical links exclude tokens, unknown fields and fragments while retaining the current intent", async (t) => {
  const env = await environment(t, `?workTask=${taskB.taskId}&token=${session.token}&draft=SECRET_DRAFT#join-secret`);
  const hook = env.render();
  await env.settle();
  await env.testing.act(async () => { await hook.result.current.copyLink(); });
  assert.equal(env.copied.length, 1);
  const copied = new URL(env.copied[0]!);
  assert.equal(copied.origin, "https://team.example.com");
  assert.equal(copied.pathname, "/workspace/");
  assert.equal(copied.searchParams.get("team"), teamB.teamId);
  assert.equal(copied.searchParams.get("workTask"), taskB.taskId);
  assert.equal(copied.searchParams.has("token"), false);
  assert.equal(copied.searchParams.has("draft"), false);
  assert.equal(copied.hash, "");
  assert.equal(env.copied[0]!.includes(session.token!), false);
  assert.equal(env.copied[0]!.includes("SECRET_DRAFT"), false);
  assert.match(hook.result.current.copyStatus ?? "", /访问者仍需拥有/u);
  assert.equal(env.dom.window.location.search.includes("token="), false);
});
