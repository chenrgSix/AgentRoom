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
import { advanceWebSessionGeneration, jsonRequest } from "../src/api-client.js";
import { composerStoragePrefix, loadComposerState } from "../src/features/room/composer-storage.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-continuous-work-test-"));
  let app: Awaited<ReturnType<typeof createServerApp>> | undefined;
  let dom: JSDOM | undefined;
  let cleanup: (() => void) | undefined;
  const originalFetch = globalThis.fetch;
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  t.after(async () => {
    cleanup?.();
    globalThis.fetch = originalFetch;
    dom?.window.close();
    for (const key of ["document", "HTMLElement", "localStorage", "sessionStorage", "navigator", "window", "IS_REACT_ACT_ENVIRONMENT"]) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    try { await app?.close(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  app = await createServerApp({ databasePath: path.join(directory, "server.sqlite"), logger: false });
  const server = app;
  async function seed(method: "GET" | "POST", url: string, payload?: object, authorization?: string) {
    const response = await server.inject({ method, url, ...(payload ? { payload } : {}),
      headers: authorization ? { authorization } : {} });
    assert.equal(response.statusCode, 200, `${method} ${url} returned ${response.statusCode}`);
    return response.json();
  }
  const bootstrap = await seed("POST", "/api/bootstrap", { userId: "user_continuous_work_0001", displayName: "Continuous Owner" });
  const seedAuthorization = `Bearer ${bootstrap.session.token as string}`;
  const team = await seed("POST", "/api/teams", { name: "Continuous Work Team" }, seedAuthorization);
  const teamId = team.team.teamId as string;
  const firstRoom = await seed("POST", `/api/teams/${teamId}/rooms`, { name: "continuous-work" }, seedAuthorization);
  const otherRoom = await seed("POST", `/api/teams/${teamId}/rooms`, { name: "unrelated-room" }, seedAuthorization);
  const roomId = firstRoom.roomId as string;
  const firstTask = await seed("POST", `/api/rooms/${roomId}/tasks`, {
    title: "First continuous task", goal: "Preserve the first draft without invoking an Agent"
  }, seedAuthorization) as TaskProjection;
  const secondTask = await seed("POST", `/api/rooms/${roomId}/tasks`, {
    title: "Second continuous task", goal: "Preserve the second draft without invoking an Agent"
  }, seedAuthorization) as TaskProjection;

  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
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
  let authorization = "";
  let failMessages = false;
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    requests.push({ method, url, ...(init.body ? { body: String(init.body) } : {}) });
    if (url.includes("/changes?")) return new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    if (failMessages && method === "POST" && url.endsWith("/messages")) return new Response(JSON.stringify({
      error: { message: "Synthetic unavailable transport; nothing was submitted" }
    }), { status: 503, headers: { "content-type": "application/json" } });
    const response = await server.inject({
      method: method as "GET" | "POST" | "DELETE", url,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(init.body ? { payload: String(init.body) } : {})
    });
    if (url === "/api/bootstrap" && response.statusCode === 200) {
      authorization = `Bearer ${response.json().session.token as string}`;
    }
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  const testing = await import("@testing-library/react");
  cleanup = testing.cleanup;
  const page = testing.within(dom.window.document.body);
  const scopeFor = (taskId: string) => ({ userId: bootstrap.user.userId as string, teamId, roomId, taskId });
  async function openRoomTask(task: TaskProjection) {
    // Enter through the real Work detail's Room action, not a synthetic URL.
    const work = page.getAllByRole("button", { name: "Work", exact: true })
      .find((button) => button.className.includes("rail-manage"))!;
    testing.fireEvent.click(work);
    testing.fireEvent.click(await page.findByRole("button", { name: `Open TASK-${task.taskDisplayNumber}` }));
    await page.findByRole("heading", { name: task.title });
    testing.fireEvent.click(page.getByRole("button", { name: "Open this Task in Room" }));
    const selector = await page.findByRole("combobox", { name: "Current Task" });
    await testing.waitFor(() => assert.equal((selector as HTMLSelectElement).value, task.taskId));
    return page.getByRole("textbox", { name: "Message", exact: true }) as HTMLTextAreaElement;
  }
  return {
    ...testing, dom, page, firstTask, secondTask, roomId, otherRoomId: otherRoom.roomId as string,
    teamId, scopeFor, requests, server, openRoomTask,
    setFailMessages(value: boolean) { failMessages = value; },
    currentAuthorization: () => authorization
  };
}

test("Room drafts survive Task switches and a remounted App without sending", async (t) => {
  const f = await fixture(t);
  const view = f.render(<App />);
  await f.page.findByRole("button", { name: `Open TASK-${f.firstTask.taskDisplayNumber}` });
  let editor = await f.openRoomTask(f.firstTask);
  f.fireEvent.change(editor, { target: { value: "First Task's unsent draft" } });
  await f.page.findByText(/Saved in this tab/u);
  f.fireEvent.change(f.page.getByRole("combobox", { name: "Current Task" }), { target: { value: f.secondTask.taskId } });
  await f.waitFor(() => assert.equal(editor.value, ""));
  f.fireEvent.change(editor, { target: { value: "Second Task's unsent draft" } });
  f.fireEvent.change(f.page.getByRole("combobox", { name: "Current Task" }), { target: { value: f.firstTask.taskId } });
  await f.waitFor(() => assert.equal(editor.value, "First Task's unsent draft"));
  assert.equal(loadComposerState(f.scopeFor(f.firstTask.taskId)).state.content, "First Task's unsent draft");
  assert.equal(loadComposerState(f.scopeFor(f.secondTask.taskId)).state.content, "Second Task's unsent draft");
  view.unmount();
  f.render(<App />);
  editor = await f.page.findByRole("textbox", { name: "Message", exact: true }) as HTMLTextAreaElement;
  await f.waitFor(() => assert.equal(editor.value, "First Task's unsent draft"));
  f.fireEvent.change(f.page.getByRole("combobox", { name: "Current Task" }), { target: { value: f.secondTask.taskId } });
  await f.waitFor(() => assert.equal(editor.value, "Second Task's unsent draft"));
  assert.equal(f.requests.some(({ method, url }) => method === "POST" && /\/(?:messages|discussions)$/u.test(url)), false);
  f.fireEvent.click(f.page.getByRole("button", { name: "Clear draft", exact: true }));
  await f.waitFor(() => assert.equal(editor.value, ""));
  assert.equal(loadComposerState(f.scopeFor(f.secondTask.taskId)).state.content, "");
  assert.equal(loadComposerState(f.scopeFor(f.firstTask.taskId)).state.content, "First Task's unsent draft");
});

for (const exit of ["logout", "session expiry"] as const) {
  test(`${exit} clears App drafts and failed messages before local reauthentication`, async (t) => {
    const f = await fixture(t);
    f.render(<App />);
    await f.page.findByRole("button", { name: `Open TASK-${f.firstTask.taskDisplayNumber}` });
    let editor = await f.openRoomTask(f.firstTask);
    f.setFailMessages(true);
    f.fireEvent.change(editor, { target: { value: "Failed ordinary message" } });
    f.fireEvent.click(f.page.getByRole("button", { name: "Send", exact: true }));
    await f.waitFor(() => assert.equal(loadComposerState(f.scopeFor(f.firstTask.taskId)).state.pendingMessages[0]?.status, "failed"));
    f.fireEvent.change(editor, { target: { value: "Draft to clear on exit" } });
    const key = `${composerStoragePrefix}${f.scopeFor(f.firstTask.taskId).userId}`;
    assert.ok(sessionStorage.getItem(key));
    if (exit === "logout") {
      f.fireEvent.click(f.page.getAllByRole("button", { name: "Sign out", exact: true })
        .find((button) => button.className.includes("header"))!);
    } else {
      const token = f.currentAuthorization().replace(/^Bearer /u, "");
      const revoked = await f.server.inject({ method: "DELETE", url: "/api/auth/session", headers: { authorization: f.currentAuthorization() } });
      assert.equal(revoked.statusCode, 200);
      await f.act(async () => { await assert.rejects(jsonRequest("/api/teams", {}, token), /session/u); });
    }
    const reenter = await f.page.findByRole("button", { name: "Enter local workspace" });
    assert.equal(sessionStorage.getItem(key), null);
    const messageWrites = f.requests.filter(({ method, url }) => method === "POST" && url.endsWith("/messages")).length;
    f.fireEvent.click(reenter);
    await f.page.findByRole("combobox", { name: "Select Room" });
    editor = await f.openRoomTask(f.firstTask);
    assert.equal(editor.value, "");
    assert.equal(loadComposerState(f.scopeFor(f.firstTask.taskId)).state.pendingMessages.length, 0);
    assert.equal(f.requests.filter(({ method, url }) => method === "POST" && url.endsWith("/messages")).length, messageWrites);
  });
}

test("Work creates a Task in the selected Room and opens its details without switching to Chat", async (t) => {
  const f = await fixture(t);
  f.render(<App />);
  await f.page.findByRole("button", { name: `Open TASK-${f.firstTask.taskDisplayNumber}` });
  const roomSelector = f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement;
  const originalRoom = roomSelector.value;
  f.fireEvent.click(await f.page.findByRole("button", { name: "New Task", exact: true }));
  const dialog = f.within(await f.page.findByRole("dialog", { name: "Create long-lived Task" }));
  f.fireEvent.change(dialog.getByRole("textbox", { name: "Task title" }), { target: { value: "Created directly from Work" } });
  f.fireEvent.change(dialog.getByRole("textbox", { name: "Task goal" }), { target: { value: "Navigate only; no Agent execution" } });
  f.fireEvent.click(dialog.getByRole("button", { name: "Create and switch" }));
  await f.page.findByRole("heading", { name: "Created directly from Work" });
  assert.ok(f.page.getByRole("tablist", { name: "Task detail navigation" }));
  assert.equal(f.page.queryByRole("textbox", { name: "Message", exact: true }), null);
  assert.equal(roomSelector.value, originalRoom);
  const writes = f.requests.filter(({ method, url }) => method === "POST" && url !== "/api/bootstrap");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.url, `/api/rooms/${originalRoom}/tasks`);
  assert.equal(JSON.parse(writes[0]!.body!).title, "Created directly from Work");
});

test("Work next-step action navigates to the exact Room Task without creating messages or Runs", async (t) => {
  const f = await fixture(t);
  f.render(<App />);
  const next = await f.page.findByRole("button", { name: `Open next step for TASK-${f.secondTask.taskDisplayNumber}: start work` });
  const writesBefore = f.requests.filter(({ method }) => method !== "GET").length;
  f.fireEvent.click(next);
  const selector = await f.page.findByRole("combobox", { name: "Current Task" });
  await f.waitFor(() => assert.equal((selector as HTMLSelectElement).value, f.secondTask.taskId));
  assert.equal((f.page.getByRole("combobox", { name: "Select Room" }) as HTMLSelectElement).value, f.roomId);
  assert.equal((f.page.getByRole("textbox", { name: "Message", exact: true }) as HTMLTextAreaElement).value, "");
  assert.equal(f.requests.filter(({ method }) => method !== "GET").length, writesBefore);
});
