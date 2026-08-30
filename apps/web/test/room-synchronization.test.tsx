import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";

import { JSDOM } from "jsdom";

import { advanceWebSessionGeneration, captureWebSessionScope, loadRunOutputEvents, StaleWebSessionError, webSessionExpiredEvent } from "../src/api-client.js";
import { useWebSession } from "../src/features/auth/useWebSession.js";
import { RoomSynchronization, type RoomSnapshot, type RoomSynchronizationOptions } from "../src/features/room/room-synchronization.js";
import { useRoomSynchronization } from "../src/features/room/useRoomSynchronization.js";
import type { AgentTask, LocalSession, Message, RoomMessagePage, Run } from "../src/models.js";
import { mergeRoomMessages, type RunEventRecord } from "../src/room-sync.js";

const teamId = "team_room_controller_0001";
const roomId = "room_room_controller_0001";
const session: LocalSession = { userId: "user_room_controller_0001", displayName: "Owner", token: "controller-session" };

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function message(sequence: number): Message {
  return {
    messageId: `msg_controller_${sequence}`, traceId: `trace_controller_${sequence}`,
    roomId, taskId: "task_room_controller_0001", sequence,
    senderType: "member", senderId: "member_room_controller_0001",
    content: `Controller message ${sequence}`, mentions: [], parentMessageId: null,
    createdAt: "2026-08-31T10:00:00.000Z"
  };
}

function page(first: number, last: number): RoomMessagePage {
  return {
    items: Array.from({ length: last - first + 1 }, (_, index) => message(first + index)),
    nextCursor: null, olderCursor: first > 1 ? `older_${first}` : null, syncCursor: `live_${last}`
  };
}

function roomRun(state: Run["state"]): Run {
  return {
    runId: "run_room_controller_0001", taskId: "task_room_controller_0001",
    triggerMessageId: "msg_controller_101", targetAgentId: "agent_room_controller_0001",
    state, updatedAt: "2026-08-31T10:00:00.000Z"
  };
}

const newTask: AgentTask = {
  taskId: "task_room_controller_new_0001", roomId, parentTaskId: null,
  title: "New Task", goal: "Keep the new Task selected", state: "open",
  primaryAgentId: null, isDefault: false, updatedAt: "2026-08-31T10:00:00.000Z"
};

function pending(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

async function environment(t: TestContext, visible = true) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  advanceWebSessionGeneration();
  let visibility = visible ? "visible" : "hidden";
  Object.defineProperty(dom.window.document, "visibilityState", { configurable: true, get: () => visibility });
  const timeouts = new Map<number, { callback: () => void; delay: number }>();
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  dom.window.setTimeout = ((callback: () => void, delay = 0) => {
    const id = ++timerId; timeouts.set(id, { callback, delay }); return id;
  }) as typeof dom.window.setTimeout;
  dom.window.clearTimeout = ((id: number) => { timeouts.delete(id); }) as typeof dom.window.clearTimeout;
  dom.window.setInterval = ((callback: () => void, delay = 0) => {
    const id = ++timerId; intervals.set(id, { callback, delay }); return id;
  }) as typeof dom.window.setInterval;
  dom.window.clearInterval = ((id: number) => { intervals.delete(id); }) as typeof dom.window.clearInterval;
  const originalFetch = globalThis.fetch;
  const controllers: RoomSynchronization[] = [];
  const requests: Array<{ path: string; signal: AbortSignal | null | undefined }> = [];
  const snapshots: RoomSnapshot[] = [];
  const history: Array<{ olderCursor: string | null; loading: boolean; error: string | null }> = [];
  const errors: unknown[] = [];
  let messages: Message[] = [];
  let outputCalls = 0;
  let workbenchCalls = 0;
  let contextCurrent = true;
  let intercept: (path: string, init: RequestInit) => Response | Promise<Response> | undefined = () => undefined;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    requests.push({ path, signal: init.signal });
    const custom = intercept(path, init);
    if (custom !== undefined) return custom;
    if (path.includes("/changes?")) return pending(init.signal);
    if (path.includes("/messages?")) return json(page(101, 200));
    if (path.endsWith("/settings")) return json({
      room: { roomId, teamId, name: "Controller Room", createdAt: "2026-08-31T10:00:00.000Z" },
      participants: { memberIds: [], agentIds: [] }
    });
    return json([]);
  };
  const options: RoomSynchronizationOptions = {
    teamId, roomId, session, isCurrentContext: () => contextCurrent,
    onMessages: (items) => { messages = mergeRoomMessages(messages, items, Infinity); },
    onHistory: (state) => { history.push(state); },
    onSnapshot: (snapshot) => { snapshots.push(snapshot); },
    onEvents: () => undefined,
    loadOutputs: async () => { outputCalls += 1; return new Map(); },
    refreshWorkbench: async () => { workbenchCalls += 1; },
    onError: (reason) => { errors.push(reason); }
  };
  const testing = await import("@testing-library/react");
  t.after(async () => {
    testing.cleanup();
    for (const controller of controllers) controller.stop();
    await setImmediate();
    globalThis.fetch = originalFetch;
    dom.window.close();
  });
  return {
    dom, testing, options, requests, snapshots, history, errors, timeouts, intervals,
    get messages() { return messages; }, get outputCalls() { return outputCalls; },
    get workbenchCalls() { return workbenchCalls; },
    intercept(value: typeof intercept) { intercept = value; },
    setContextCurrent(value: boolean) { contextCurrent = value; },
    create(overrides: Partial<RoomSynchronizationOptions> = {}) {
      const controller = new RoomSynchronization({ ...options, ...overrides });
      controllers.push(controller);
      return controller;
    },
    async settle() { await setImmediate(); },
    async visibility(value: "visible" | "hidden") {
      visibility = value;
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
      await setImmediate();
    },
    async tick(delay: number) {
      for (const [id, timer] of [...timeouts]) {
        if (timer.delay === delay) { timeouts.delete(id); timer.callback(); }
      }
      await setImmediate();
    }
  };
}

test("stopped initial reads never issue derived output reads or publish callbacks", async (t) => {
  const env = await environment(t);
  const tail = deferred<Response>();
  env.intercept((path) => path.includes("/messages?") ? tail.promise : undefined);
  const controller = env.create();
  const starting = controller.start();
  await env.settle();
  controller.stop();
  assert.ok(env.requests.every(({ signal }) => signal?.aborted));
  tail.resolve(json(page(101, 200)));
  await starting;
  assert.equal(env.outputCalls, 0);
  assert.equal(env.messages.length, 0);
  assert.deepEqual(env.snapshots, []);
  assert.deepEqual(env.history, []);
  assert.deepEqual(env.errors, []);
  assert.equal(env.intervals.size + env.timeouts.size, 0);
  await assert.rejects(controller.refreshAfterAction(), StaleWebSessionError);
  await controller.loadOlder();
  assert.equal(env.requests.length, 6);
});

test("session invalidation during initial output prevents snapshots and change listeners", async (t) => {
  const env = await environment(t);
  const output = deferred<Map<string, RunEventRecord[]>>();
  let outputStarted = false;
  const controller = env.create({ loadOutputs: async () => { outputStarted = true; return output.promise; } });
  const starting = controller.start();
  await env.settle();
  assert.equal(outputStarted, true);
  advanceWebSessionGeneration();
  output.resolve(new Map());
  await starting;
  assert.equal(controller.isCurrent(), false);
  assert.equal(env.messages.length, 0);
  assert.deepEqual(env.snapshots, []);
  assert.equal(env.requests.some(({ path }) => path.includes("/changes?")), false);
  assert.equal(env.intervals.size + env.timeouts.size, 0);
});

for (const status of [200, 401]) {
  test(`late uncancelled Run output ${status} cannot publish or expire a replacement session`, async (t) => {
    const env = await environment(t);
    const output = deferred<Response>();
    const run: Run = {
      runId: "run_room_controller_0001", taskId: "task_room_controller_0001",
      triggerMessageId: "msg_controller_101", targetAgentId: "agent_room_controller_0001",
      state: "working", updatedAt: "2026-08-31T10:00:00.000Z"
    };
    let expired = 0;
    env.dom.window.addEventListener(webSessionExpiredEvent, () => { expired += 1; });
    env.intercept((path) => {
      if (path.endsWith("/runs")) return json([run]);
      if (path.startsWith(`/api/runs/${run.runId}/events?`)) return output.promise;
      return undefined;
    });
    const controller = env.create({ loadOutputs: (runs) => loadRunOutputEvents(runs, new Map(), new Map(), session.token) });
    const starting = controller.start();
    await env.settle();
    const outputRequest = env.requests.find(({ path }) => path.startsWith(`/api/runs/${run.runId}/events?`));
    assert.ok(outputRequest, "the real output batch must be in flight before cleanup");
    assert.equal(outputRequest.signal, undefined, "exercise the existing non-cancellable output helper");
    controller.stop();
    if (status === 401) advanceWebSessionGeneration();
    output.resolve(json(status === 200 ? [] : { error: { message: "Old session expired" } }, status));
    await starting;
    assert.equal(expired, 0);
    assert.equal(env.messages.length, 0);
    assert.deepEqual(env.snapshots, []);
    assert.deepEqual(env.history, []);
    assert.deepEqual(env.errors, []);
    assert.equal(env.requests.some(({ path }) => path.includes("/changes?")), false);
    assert.equal(env.intervals.size + env.timeouts.size, 0);
  });
}

test("initial failure recovers the history boundary once without rewinding the live cursor", async (t) => {
  const env = await environment(t);
  let runReads = 0;
  const messagePaths: string[] = [];
  env.intercept((path) => {
    if (path.endsWith("/runs") && ++runReads === 1) return json({ error: { message: "Initial runs unavailable" } }, 503);
    if (!path.includes("/messages?")) return undefined;
    messagePaths.push(path);
    if (path.includes("beforeCursor=older_101")) return json(page(1, 100));
    if (path.includes("cursor=live_200")) return json(page(201, 201));
    return json(page(101, 200));
  });
  const controller = env.create();
  await controller.start();
  assert.equal(env.errors.length, 1);
  assert.equal(env.history.length, 0);
  await env.visibility("visible");
  assert.equal(env.messages.length, 100);
  assert.equal(env.history.at(-1)?.olderCursor, "older_101");
  await controller.loadOlder();
  assert.equal(env.messages.length, 200);
  assert.equal(env.history.at(-1)?.olderCursor, null);
  await env.visibility("visible");
  assert.equal(env.messages.length, 201);
  assert.equal(env.history.at(-1)?.olderCursor, null);
  assert.ok(messagePaths.at(-1)?.endsWith("cursor=live_200"));
  assert.equal(messagePaths.filter((path) => path.includes("tail=true")).length, 2);
});

test("action refresh and loaded history survive a late initial snapshot without a cursor rewind", async (t) => {
  const env = await environment(t);
  const initialOutput = deferred<Map<string, RunEventRecord[]>>();
  let outputCalls = 0;
  let tailReads = 0;
  const messagePaths: string[] = [];
  env.intercept((path) => {
    if (!path.includes("/messages?")) return undefined;
    messagePaths.push(path);
    if (path.includes("beforeCursor=older_102")) return json(page(1, 101));
    if (path.includes("cursor=live_201")) return json(page(202, 202));
    return json(++tailReads === 1 ? page(101, 200) : page(102, 201));
  });
  const controller = env.create({ loadOutputs: async () => ++outputCalls === 1 ? initialOutput.promise : new Map() });
  const starting = controller.start();
  await env.settle();
  await controller.refreshAfterAction();
  await controller.loadOlder();
  assert.equal(env.messages.length, 201);
  assert.equal(env.history.at(-1)?.olderCursor, null);
  initialOutput.resolve(new Map());
  await starting;
  assert.equal(env.messages.length, 201);
  assert.equal(env.history.at(-1)?.olderCursor, null);
  await env.visibility("visible");
  assert.equal(env.messages.length, 202);
  assert.ok(messagePaths.at(-1)?.endsWith("cursor=live_201"));
  assert.equal(env.history.at(-1)?.olderCursor, null);
});

test("late initial settings merge with newer Tasks and Runs even when no message sequence changed", async (t) => {
  const env = await environment(t);
  const initialOutputs = deferred<Map<string, RunEventRecord[]>>();
  let taskReads = 0;
  let runReads = 0;
  env.intercept((path) => {
    if (path.endsWith("/tasks")) return json(++taskReads === 1 ? [] : [newTask]);
    if (path.endsWith("/runs")) return json([roomRun(++runReads === 1 ? "working" : "completed")]);
    return undefined;
  });
  const controller = env.create({ loadOutputs: async () => initialOutputs.promise });
  const starting = controller.start();
  await env.settle();
  await controller.refreshAfterAction();
  assert.deepEqual(env.snapshots.at(-1)?.tasks, [newTask]);
  assert.equal(env.snapshots.at(-1)?.runs[0]?.state, "completed");
  assert.equal(env.snapshots.at(-1)?.settings, undefined);
  initialOutputs.resolve(new Map([[roomRun("working").runId, []]]));
  await starting;
  const merged = env.snapshots.at(-1)!;
  assert.deepEqual(merged.tasks, [newTask]);
  assert.equal(merged.runs[0]?.state, "completed");
  assert.equal(merged.outputs, undefined, "stale Run outputs must not accompany a newer Run list");
  assert.equal(merged.settings?.room.roomId, roomId);
});

for (const earlier of ["events", "full"] as const) {
  test(`an older ${earlier} refresh cannot rewind Runs committed by the newer ${earlier === "events" ? "full" : "events"} refresh`, async (t) => {
    const env = await environment(t);
    const change = deferred<Response>();
    const olderOutputs = deferred<Map<string, RunEventRecord[]>>();
    const events: Run[][] = [];
    let changes = 0;
    let runReads = 0;
    let outputReads = 0;
    let displayedRuns: Run[] = [];
    env.intercept((path, init) => {
      if (path.endsWith("/runs")) return json([roomRun(++runReads === 1 ? "queued" : runReads === 2 ? "working" : "completed")]);
      if (path.includes("/changes?")) return ++changes === 1 ? change.promise : pending(init.signal);
      return undefined;
    });
    const controller = env.create({
      loadOutputs: async () => ++outputReads === 2 ? olderOutputs.promise : new Map(),
      onSnapshot: (snapshot) => { env.snapshots.push(snapshot); displayedRuns = snapshot.runs; },
      onEvents: (runs) => { events.push(runs); displayedRuns = runs; }
    });
    await controller.start();
    const releaseEvent = async () => {
      change.resolve(json({ cursor: 1, changed: true, reset: false, team: false, roomIds: [], runRoomIds: [roomId] }));
      await env.settle();
    };
    if (earlier === "events") await releaseEvent();
    else await env.visibility("visible");
    assert.equal(outputReads, 2, "the older refresh must be waiting on its outputs");
    if (earlier === "events") await env.visibility("visible");
    else await releaseEvent();
    assert.equal(outputReads, 3);
    assert.equal(displayedRuns[0]?.state, "completed");
    olderOutputs.resolve(new Map([[roomRun("working").runId, []]]));
    await env.settle();
    assert.equal(displayedRuns[0]?.state, "completed");
    if (earlier === "events") assert.deepEqual(events, [], "superseded event-only callbacks must be suppressed");
    else {
      assert.equal(env.snapshots.at(-1)?.runs[0]?.state, "completed");
      assert.equal(env.snapshots.at(-1)?.outputs, undefined);
      assert.equal(env.snapshots.at(-1)?.settings?.room.roomId, roomId);
    }
  });
}

test("a failed newer refresh never suppresses an older successful snapshot", async (t) => {
  const env = await environment(t);
  const initialOutputs = deferred<Map<string, RunEventRecord[]>>();
  let runReads = 0;
  env.intercept((path) => path.endsWith("/runs") && ++runReads === 2
    ? json({ error: { message: "Newer read unavailable" } }, 503) : undefined);
  const controller = env.create({ loadOutputs: async () => initialOutputs.promise });
  const starting = controller.start();
  await env.settle();
  await assert.rejects(controller.refreshAfterAction(), /Newer read unavailable/u);
  initialOutputs.resolve(new Map());
  await starting;
  assert.equal(env.snapshots.length, 1);
  assert.equal(env.snapshots[0]?.settings?.room.roomId, roomId);
  assert.equal(env.messages.length, 100);
});

test("a superseded Room read never starts derived Run outputs but still initializes settings", async (t) => {
  const env = await environment(t);
  const initialRuns = deferred<Response>();
  let runReads = 0;
  let taskReads = 0;
  env.intercept((path) => {
    if (path.endsWith("/runs")) return ++runReads === 1 ? initialRuns.promise : json([roomRun("completed")]);
    if (path.endsWith("/tasks")) return json(++taskReads === 1 ? [] : [newTask]);
    return undefined;
  });
  const controller = env.create();
  const starting = controller.start();
  await env.settle();
  await controller.refreshAfterAction();
  initialRuns.resolve(json([roomRun("working")]));
  await starting;
  assert.equal(env.outputCalls, 0);
  assert.deepEqual(env.snapshots.at(-1)?.tasks, [newTask]);
  assert.equal(env.snapshots.at(-1)?.runs[0]?.state, "completed");
  assert.equal(env.snapshots.at(-1)?.settings?.room.roomId, roomId);
});

test("hidden Room waits resume while visible and stop removes waits, polling and visibility listeners", async (t) => {
  const env = await environment(t, false);
  const controller = env.create();
  await controller.start();
  assert.equal(env.requests.some(({ path }) => path.includes("/changes?")), false);
  assert.equal(env.timeouts.size, 1);
  assert.equal(env.intervals.size, 1);
  await env.visibility("visible");
  await env.tick(1000);
  const polling = env.requests.find(({ path }) => path.includes("/changes?"));
  assert.ok(polling);
  controller.stop();
  await env.settle();
  assert.equal(polling.signal?.aborted, true);
  assert.equal(env.timeouts.size + env.intervals.size, 0);
  const count = env.requests.length;
  await env.visibility("visible");
  assert.equal(env.requests.length, count);
});

test("stopping a failed poll's reconciliation cannot create a new backoff timer after cleanup", async (t) => {
  const env = await environment(t);
  const lateTail = deferred<Response>();
  let tailReads = 0;
  env.intercept((path) => {
    if (path.includes("/changes?")) return json({ error: { message: "Poll unavailable" } }, 503);
    if (path.includes("/messages?") && ++tailReads === 2) return lateTail.promise;
    return undefined;
  });
  const controller = env.create();
  await controller.start();
  await env.settle();
  assert.equal(tailReads, 2);
  controller.stop();
  lateTail.resolve(json(page(201, 201)));
  await env.settle();
  assert.equal(env.timeouts.size + env.intervals.size, 0,
    "an obsolete poll continuation must not register a new 2-second backoff after stop");
});

test("callbacks from a replaced same-Room controller never target its replacement", async (t) => {
  const env = await environment(t);
  const { act, renderHook } = env.testing;
  const hook = renderHook(({ activeSession }: { activeSession: LocalSession }) => useRoomSynchronization({
    ...env.options, session: activeSession, onReset: () => undefined
  }), { initialProps: { activeSession: session } });
  await act(async () => { await env.settle(); });
  const previous = hook.result.current;
  await act(async () => {
    advanceWebSessionGeneration();
    hook.rerender({ activeSession: { ...session } });
    await env.settle();
  });
  const requestCount = env.requests.length;
  await act(async () => { await previous.refresh(); await previous.loadOlder(); });
  assert.equal(env.requests.length, requestCount,
    "an old callback must not issue new-generation reads even when Room and token text are unchanged");
});

test("returning to the same Room never revives old callbacks, and unmount retires current callbacks", async (t) => {
  const env = await environment(t);
  const { act, renderHook } = env.testing;
  const hook = renderHook(({ activeRoom }: { activeRoom: string }) => useRoomSynchronization({
    ...env.options, roomId: activeRoom, onReset: () => undefined
  }), { initialProps: { activeRoom: roomId } });
  await act(async () => { await env.settle(); });
  const previous = hook.result.current;
  for (const activeRoom of ["room_room_controller_0002", roomId]) {
    await act(async () => { hook.rerender({ activeRoom }); await env.settle(); });
  }
  const requestCount = env.requests.length;
  await act(async () => { await previous.refresh(); await previous.loadOlder(); });
  assert.equal(env.requests.length, requestCount,
    "Room A to B to A must create a new authority even without a session generation change");
  const current = hook.result.current;
  hook.unmount();
  await act(async () => { await current.refresh(); await current.loadOlder(); });
  assert.equal(env.requests.length, requestCount);
  assert.equal(env.timeouts.size + env.intervals.size, 0);
});

test("Web session authority catches immediate expiry, invalidates once, and removes its listener", async (t) => {
  const env = await environment(t);
  const { act, renderHook } = env.testing;
  const invalidated: LocalSession[] = [];
  const hook = renderHook(() => useWebSession((previous) => { invalidated.push(previous); }));
  act(() => {
    hook.result.current.activate({ userId: session.userId, displayName: session.displayName }, "trusted-team");
    env.dom.window.dispatchEvent(new env.dom.window.Event(webSessionExpiredEvent));
  });
  assert.equal(hook.result.current.session, null);
  assert.equal(hook.result.current.authState, "sign_in_required");
  assert.equal(invalidated.length, 1);
  const current = captureWebSessionScope();
  act(() => hook.result.current.clear());
  assert.equal(current(), true, "repeated clear must not advance the generation");
  act(() => {
    hook.result.current.activate({ userId: session.userId, displayName: session.displayName }, "local", session.token);
    env.dom.window.dispatchEvent(new env.dom.window.Event(webSessionExpiredEvent));
  });
  assert.equal(hook.result.current.authState, "local_bootstrap");
  assert.equal(invalidated.length, 2);
  act(() => { hook.result.current.activate({ userId: session.userId, displayName: session.displayName }, "local", session.token); });
  hook.unmount();
  const afterUnmount = captureWebSessionScope();
  env.dom.window.dispatchEvent(new env.dom.window.Event(webSessionExpiredEvent));
  assert.equal(afterUnmount(), true);
  assert.equal(invalidated.length, 2);
});
