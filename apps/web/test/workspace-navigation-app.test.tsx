import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { TaskProjection } from "@convene-wire/contracts/task-result";
import { JSDOM } from "jsdom";
import React from "react";

import { createServerApp } from "../../server/src/app.js";
import { App } from "../src/App.js";
import { advanceWebSessionGeneration } from "../src/api-client.js";
import { workspaceNavigationUrl, type WorkspaceNavigation } from "../src/features/navigation/workspace-navigation.js";

interface HeldRead {
  url: string;
  captured: boolean;
  signal: AbortSignal | null | undefined;
  release: () => void;
  gate: Promise<void>;
  delivered: Promise<void>;
  finish: () => void;
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-navigation-app-test-"));
  let app: Awaited<ReturnType<typeof createServerApp>> | undefined;
  let dom: JSDOM | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const originalFetch = globalThis.fetch;
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  const holds: HeldRead[] = [];
  const pendingRequests = new Set<Promise<Response>>();
  t.after(async () => {
    try {
      try { await cleanup?.(); }
      finally {
        for (const hold of holds) hold.release();
        await app?.close();
      }
    } finally {
      globalThis.fetch = originalFetch;
      dom?.window.close();
      for (const key of ["document", "HTMLElement", "localStorage", "sessionStorage", "navigator", "window", "IS_REACT_ACT_ENVIRONMENT"]) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  app = await createServerApp({ databasePath: path.join(directory, "server.sqlite"), logger: false });
  const server = app;
  async function seed(method: "GET" | "POST", url: string, payload?: object, authorization?: string) {
    const response = await server.inject({ method, url, ...(payload ? { payload } : {}), headers: authorization ? { authorization } : {} });
    assert.equal(response.statusCode, 200, `${method} ${url} returned ${response.statusCode}`);
    return response.json();
  }
  const bootstrap = await seed("POST", "/api/bootstrap", { userId: "user_navigation_app_0001", displayName: "Navigation Owner" });
  const authorization = `Bearer ${bootstrap.session.token as string}`;
  await seed("POST", "/api/teams", { name: "Navigation Alpha" }, authorization);
  await seed("POST", "/api/teams", { name: "Navigation Bravo" }, authorization);
  // Resolve actual API order: equal creation timestamps need not preserve seed order.
  const [team, otherTeam] = await seed("GET", "/api/teams", undefined, authorization);
  await seed("POST", `/api/teams/${team.teamId}/rooms`, { name: "first-navigation-room" }, authorization);
  await seed("POST", `/api/teams/${team.teamId}/rooms`, { name: "target-navigation-room" }, authorization);
  await seed("POST", `/api/teams/${team.teamId}/rooms`, { name: "third-navigation-room" }, authorization);
  const [firstRoom, targetRoom, thirdRoom] = await seed("GET", `/api/teams/${team.teamId}/rooms`, undefined, authorization);
  const otherTeamRoom = await seed("POST", `/api/teams/${otherTeam.teamId}/rooms`, { name: "bravo-navigation-room" }, authorization);
  const firstTask = await seed("POST", `/api/rooms/${targetRoom.roomId}/tasks`, {
    title: "Navigation first target", goal: "Restore this exact authorized Task without executing an Agent"
  }, authorization) as TaskProjection;
  const secondTask = await seed("POST", `/api/rooms/${targetRoom.roomId}/tasks`, {
    title: "Navigation second target", goal: "Remain selected after Room snapshot initialization"
  }, authorization) as TaskProjection;
  const targetTasks = await seed("GET", `/api/rooms/${targetRoom.roomId}/tasks`, undefined, authorization) as Array<{ taskId: string }>;
  assert.notEqual(targetTasks[0]?.taskId, secondTask.taskId, "the target must not be the default snapshot selection");

  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/workspace/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    localStorage: { configurable: true, value: dom.window.localStorage },
    sessionStorage: { configurable: true, value: dom.window.sessionStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  advanceWebSessionGeneration();
  localStorage.setItem("agent-room.locale", "en");
  localStorage.setItem("agent-room.local-user", JSON.stringify(bootstrap.user));
  const requests: Array<{ method: string; url: string }> = [];
  const dispatchFetch: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    requests.push({ method, url });
    if (url.includes("/changes?")) return new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const hold = method === "GET" ? holds.find((item) => item.url === url && !item.captured) : undefined;
    if (hold) { hold.captured = true; hold.signal = init.signal; }
    const response = await server.inject({ method: method as "GET" | "POST" | "DELETE", url,
      headers: Object.fromEntries(new Headers(init.headers).entries()), ...(init.body ? { payload: String(init.body) } : {}) });
    // Deliberately deliver a real response even if its consumer aborted the read.
    if (hold) await hold.gate;
    hold?.finish();
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = (input, init) => {
    const request = dispatchFetch(input, init);
    pendingRequests.add(request);
    void request.then(() => pendingRequests.delete(request), () => pendingRequests.delete(request));
    return request;
  };
  const testing = await import("@testing-library/react");
  cleanup = async () => {
    await testing.act(async () => {
      testing.cleanup();
      for (const hold of holds) hold.release();
      // All deliveries, including intentionally late responses, must finish
      // while DOM globals still exist. Abort cleanup settles the change polls.
      while (pendingRequests.size) await Promise.allSettled([...pendingRequests]);
    });
    // Flush React's host callback after its final network continuation, not
    // merely one tick after unmount while Server requests are still in flight.
    await testing.act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    assert.equal(pendingRequests.size, 0);
  };
  const currentDom = dom;
  const page = testing.within(currentDom.window.document.body);
  const navigation = (patch: WorkspaceNavigation = {}): WorkspaceNavigation => ({
    teamId: team.teamId as string, roomId: targetRoom.roomId as string, view: "work", ...patch
  });
  function setUrl(value: WorkspaceNavigation) {
    currentDom.window.history.replaceState(null, "", `/workspace/${workspaceNavigationUrl(value)}`);
  }
  function holdNext(url: string): HeldRead {
    let release!: () => void;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delivered = new Promise<void>((resolve) => { finish = resolve; });
    const hold: HeldRead = { url, captured: false, signal: undefined, release, gate, delivered, finish };
    holds.push(hold);
    return hold;
  }
  async function traverse(direction: "back" | "forward") {
    await testing.act(async () => {
      const changed = new Promise<void>((resolve) => currentDom.window.addEventListener("popstate", () => resolve(), { once: true }));
      currentDom.window.history[direction]();
      await changed;
    });
  }
  async function expectTab(task: TaskProjection, tab: string) {
    await page.findByRole("heading", { name: task.title });
    await testing.waitFor(() => assert.equal(page.getByRole("tab", { name: tab, exact: true }).getAttribute("aria-selected"), "true"));
  }
  function query() { return new URLSearchParams(currentDom.window.location.search); }
  function assertNoCommands() {
    assert.deepEqual(requests.filter(({ method, url }) => method !== "GET" && url !== "/api/bootstrap"), []);
  }
  return { ...testing, dom: currentDom, page, firstTask, secondTask, team, otherTeam, firstRoom, targetRoom,
    thirdRoom, otherTeamRoom, requests, navigation, setUrl, holdNext, traverse, expectTab, query, assertNoCommands };
}

test("App authorizes a non-default Room Work deep link, keeps its tab and restores it on remount", async (t) => {
  const f = await fixture(t);
  f.setUrl(f.navigation({ workTaskId: f.secondTask.taskId, tab: "results", scope: "team", search: "Navigation" }));
  const mounted = f.render(<App />);
  await f.expectTab(f.secondTask, "Results");
  assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, f.targetRoom.roomId);
  assert.equal(f.query().get("workTask"), f.secondTask.taskId);
  assert.equal(f.dom.window.location.pathname, "/workspace/");
  mounted.unmount();
  f.render(<App />);
  await f.expectTab(f.secondTask, "Results");
  assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, f.targetRoom.roomId);
  assert.equal(f.query().get("search"), "Navigation");
  assert.equal(f.query().get("scope"), "team");
  f.assertNoCommands();
});

test("App resolves a legacy workTask-only link through the authorized Task", async (t) => {
  const f = await fixture(t);
  f.setUrl({ workTaskId: f.firstTask.taskId, tab: "artifacts" });
  f.render(<App />);
  await f.expectTab(f.firstTask, "Artifacts");
  assert.equal(f.query().get("team"), f.team.teamId);
  assert.equal(f.query().get("room"), f.targetRoom.roomId);
  f.assertNoCommands();
});

test("browser back and forward restore Task, tab, scope, lifecycle filter and search in App", async (t) => {
  const f = await fixture(t);
  f.setUrl(f.navigation());
  f.render(<App />);
  const search = await f.page.findByRole("searchbox", { name: "Search work" });
  f.fireEvent.change(search, { target: { value: "Navigation" } });
  f.fireEvent.change(f.page.getByRole("combobox", { name: "Task state" }), { target: { value: f.firstTask.lifecycleState } });
  f.fireEvent.click(f.page.getByRole("button", { name: "Team", exact: true }));
  f.fireEvent.click(await f.page.findByRole("button", { name: `Open TASK-${f.firstTask.taskDisplayNumber}` }));
  await f.expectTab(f.firstTask, "Overview");
  f.fireEvent.click(f.page.getByRole("tab", { name: "Results", exact: true }));
  await f.expectTab(f.firstTask, "Results");
  await f.traverse("back");
  await f.expectTab(f.firstTask, "Overview");
  await f.traverse("back");
  await f.page.findByRole("searchbox", { name: "Search work" });
  assert.equal((f.page.getByRole("searchbox", { name: "Search work" }) as HTMLInputElement).value, "Navigation");
  assert.equal((f.page.getByRole("combobox", { name: "Task state" }) as HTMLSelectElement).value, f.firstTask.lifecycleState);
  assert.equal(f.page.getByRole("button", { name: "Team", exact: true }).getAttribute("aria-pressed"), "true");
  await f.traverse("back");
  await f.waitFor(() => assert.equal(f.page.getByRole("button", { name: "Mine", exact: true }).getAttribute("aria-pressed"), "true"));
  assert.equal((f.page.getByRole("combobox", { name: "Task state" }) as HTMLSelectElement).value, f.firstTask.lifecycleState);
  await f.traverse("back");
  await f.waitFor(() => assert.equal((f.page.getByRole("combobox", { name: "Task state" }) as HTMLSelectElement).value, ""));
  assert.equal((f.page.getByRole("searchbox", { name: "Search work" }) as HTMLInputElement).value, "Navigation");
  await f.traverse("forward");
  await f.waitFor(() => assert.equal((f.page.getByRole("combobox", { name: "Task state" }) as HTMLSelectElement).value, f.firstTask.lifecycleState));
  await f.traverse("forward");
  await f.waitFor(() => assert.equal(f.page.getByRole("button", { name: "Team", exact: true }).getAttribute("aria-pressed"), "true"));
  await f.traverse("forward");
  await f.expectTab(f.firstTask, "Overview");
  await f.traverse("forward");
  await f.expectTab(f.firstTask, "Results");
  assert.equal(f.query().get("tab"), "results");
  assert.equal(f.query().get("search"), "Navigation");
  f.fireEvent.click(f.page.getByRole("button", { name: "← Work", exact: true }));
  f.fireEvent.click(await f.page.findByRole("button", { name: `Open TASK-${f.secondTask.taskDisplayNumber}` }));
  await f.expectTab(f.secondTask, "Overview");
  f.fireEvent.click(f.page.getByRole("tab", { name: "Runs", exact: true }));
  await f.expectTab(f.secondTask, "Runs");
  await f.traverse("back");
  await f.expectTab(f.secondTask, "Overview");
  await f.traverse("back");
  await f.page.findByRole("searchbox", { name: "Search work" });
  await f.traverse("back");
  await f.expectTab(f.firstTask, "Results");
  await f.traverse("forward");
  await f.page.findByRole("searchbox", { name: "Search work" });
  await f.traverse("forward");
  await f.expectTab(f.secondTask, "Overview");
  await f.traverse("forward");
  await f.expectTab(f.secondTask, "Runs");
  assert.equal(f.query().get("workTask"), f.secondTask.taskId);
  f.assertNoCommands();
});

test("Room deep link keeps the requested non-default Task after the initial Room snapshot arrives", async (t) => {
  const f = await fixture(t);
  const held = f.holdNext(`/api/rooms/${f.targetRoom.roomId}/tasks`);
  f.setUrl(f.navigation({ view: "room", taskId: f.secondTask.taskId }));
  f.render(<App />);
  await f.waitFor(() => assert.equal(held.captured, true));
  await f.waitFor(() => assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, f.targetRoom.roomId));
  assert.equal(f.query().get("task"), f.secondTask.taskId);
  await f.act(async () => { held.release(); await held.delivered; });
  const selector = await f.page.findByRole("combobox", { name: "Current Task" });
  await f.waitFor(() => assert.equal((selector as HTMLSelectElement).value, f.secondTask.taskId));
  assert.ok(f.page.getByRole("textbox", { name: "Message", exact: true }));
  assert.equal(f.page.queryByRole("tablist", { name: "Task detail navigation" }), null);
  assert.equal(f.query().get("task"), f.secondTask.taskId);
  f.assertNoCommands();
});

for (const destination of ["Team", "Room"] as const) {
  test(`a late authorized URL Task read cannot restore an old location after a ${destination} switch`, async (t) => {
    const f = await fixture(t);
    const held = f.holdNext(`/api/tasks/${f.firstTask.taskId}`);
    f.setUrl(f.navigation({ workTaskId: f.firstTask.taskId, tab: "results" }));
    f.render(<App />);
    await f.waitFor(() => assert.equal(held.captured, true));
    const selector = await f.page.findByRole("combobox", { name: "Select Room" });
    const roomId = destination === "Team" ? f.otherTeamRoom.roomId : f.thirdRoom.roomId;
    if (destination === "Team") f.fireEvent.click(f.page.getByTitle(f.otherTeam.name));
    else f.fireEvent.change(selector, { target: { value: roomId } });
    await f.waitFor(() => assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, roomId));
    const currentUrl = f.dom.window.location.href;
    await f.act(async () => { held.release(); await held.delivered; });
    assert.equal(held.signal?.aborted, true);
    assert.equal(f.dom.window.location.href, currentUrl);
    assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, roomId);
    assert.equal(f.page.queryByRole("heading", { name: f.firstTask.title }), null);
    assert.equal(f.query().has("workTask"), false);
    f.assertNoCommands();
  });

  test(`a late initial Room snapshot cannot restore its Task or location after a ${destination} switch`, async (t) => {
    const f = await fixture(t);
    const held = f.holdNext(`/api/rooms/${f.targetRoom.roomId}/tasks`);
    f.setUrl(f.navigation({ view: "room", taskId: f.secondTask.taskId }));
    f.render(<App />);
    await f.waitFor(() => assert.equal(held.captured, true));
    await f.waitFor(() => assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, f.targetRoom.roomId));
    const roomId = destination === "Team" ? f.otherTeamRoom.roomId : f.thirdRoom.roomId;
    if (destination === "Team") f.fireEvent.click(f.page.getByTitle(f.otherTeam.name));
    else f.fireEvent.change(f.page.getByRole("combobox", { name: "Select Room" }), { target: { value: roomId } });
    await f.waitFor(() => assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, roomId));
    const currentUrl = f.dom.window.location.href;
    await f.act(async () => { held.release(); await held.delivered; });
    assert.equal(f.dom.window.location.href, currentUrl);
    assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, roomId);
    const currentTask = f.page.queryByRole("combobox", { name: "Current Task" }) as HTMLSelectElement | null;
    assert.notEqual(currentTask?.value, f.secondTask.taskId);
    assert.equal(f.page.queryByRole("option", { name: new RegExp(f.secondTask.title, "u") }), null);
    f.assertNoCommands();
  });
}
