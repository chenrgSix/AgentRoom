import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import type { ChangeEvent, FormEvent } from "react";

import { advanceWebSessionGeneration } from "../src/api-client.js";
import {
  clearComposerUserState, composerStoragePrefix, composerStorageTtlMs,
  emptyComposerState, loadComposerState, saveComposerState
} from "../src/features/room/composer-storage.js";
import { useRoomComposer } from "../src/features/room/useRoomComposer.js";
import type { Agent } from "../src/models.js";

const builder: Agent = {
  agentId: "agent_builder", name: "Builder", role: "Builder", integrationMode: "managed",
  presence: "ready", enabled: true
};
const reviewer: Agent = { ...builder, agentId: "agent_reviewer", name: "Reviewer", role: "Reviewer" };
const scope = { userId: "user_drafts", teamId: "team_one", roomId: "room_one", taskId: "task_one" };
const event = { preventDefault() {} } as FormEvent;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" }
});
const success = () => json({ message: { messageId: "msg_delivered" }, runs: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("scoped composer drafts and explicit message recovery", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    localStorage: { configurable: true, value: dom.window.localStorage },
    sessionStorage: { configurable: true, value: dom.window.sessionStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  const { act, cleanup, renderHook } = await import("@testing-library/react");
  const requests: Array<{ path: string; body: string | undefined; headers: HeadersInit | undefined }> = [];
  const errors: Array<string | null> = [];
  const delivered: string[] = [];
  const originalFetch = globalThis.fetch;
  let post: () => Response | Promise<Response>;
  let settings: () => Response | Promise<Response>;
  let currentAgents: Agent[];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    requests.push({ path, body: init?.body ? String(init.body) : undefined, headers: init?.headers });
    if (path.endsWith("/settings")) return settings();
    if (path.endsWith("/agents")) return json(currentAgents);
    return post();
  };
  function mount(overrides: Partial<Parameters<typeof useRoomComposer>[0]> = {}) {
    const input: Parameters<typeof useRoomComposer>[0] = {
      activeDiscussion: null, agentRoleLabel: ({ role }) => role,
      agents: [builder, reviewer], roomAgents: [builder, reviewer], locale: "en",
      onDelivered: async ({ messageId }) => { delivered.push(messageId); },
      onError: (error) => errors.push(error), onRoomStateChanged: async () => {},
      roomPolicy: { allowAll: true, allowDiscussion: false, allowAgentMentions: true, maxAgentMentionDepth: 4 },
      selectedTeamId: scope.teamId, selectedRoomId: scope.roomId, selectedTaskId: scope.taskId,
      session: { userId: scope.userId, displayName: "Owner", token: "not-persisted-token" },
      ...overrides
    };
    const hook = renderHook(useRoomComposer, { initialProps: input });
    const type = (content: string) => act(() => hook.result.current.handleChange({
      currentTarget: { value: content, selectionStart: content.length }
    } as ChangeEvent<HTMLTextAreaElement>));
    const submit = () => act(async () => { await hook.result.current.submit(event); });
    return { ...hook, input, type, submit };
  }
  t.beforeEach(() => {
    cleanup();
    advanceWebSessionGeneration();
    dom.window.sessionStorage.clear();
    dom.window.localStorage.clear();
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: dom.window.sessionStorage });
    requests.length = 0; errors.length = 0; delivered.length = 0;
    currentAgents = [builder, reviewer];
    post = success;
    settings = () => json({ room: { roomId: scope.roomId, teamId: scope.teamId }, participants: { agentIds: [builder.agentId, reviewer.agentId] } });
  });
  try {
    await t.test("User, Team, Room and Task switches restore only their own drafts and reload never sends", () => {
      const h = mount();
      h.type("original room draft");
      assert.equal(h.result.current.persistenceStatus.state, "saved");
      const changes: Partial<typeof h.input>[] = [
        { selectedTeamId: "team_other" }, { selectedRoomId: "room_other" },
        { selectedTaskId: "task_other" }, { session: { userId: "user_other", displayName: "Other" } }
      ];
      changes.forEach((change, index) => {
        h.rerender({ ...h.input, ...change });
        assert.equal(h.result.current.messageContent, "");
        h.type(`scope-${index}`);
        h.rerender(h.input);
        assert.equal(h.result.current.messageContent, "original room draft");
        h.rerender({ ...h.input, ...change });
        assert.equal(h.result.current.messageContent, `scope-${index}`);
      });
      h.unmount();
      assert.equal(mount().result.current.messageContent, "original room draft");
      assert.equal(requests.length, 0);
      assert.equal(dom.window.sessionStorage.getItem(`${composerStoragePrefix}${scope.userId}`)?.includes("not-persisted-token"), false);
    });

    await t.test("failed reload retains exact multi-target payload and retries explicitly without changing a newer draft", async () => {
      post = () => json({ error: { message: "offline" } }, 503);
      const h = mount();
      h.type("  @Reviewer @Builder inspect this\n");
      await h.submit();
      const initialBody = requests[0]!.body;
      const initialPending = h.result.current.pendingMessages[0]!;
      assert.equal(initialPending.status, "failed");
      assert.equal(h.result.current.messageContent, "");
      h.type("new draft must survive");
      h.unmount();
      const restored = mount();
      assert.equal(requests.length, 1);
      assert.deepEqual(restored.result.current.pendingMessages, [initialPending]);
      assert.equal(restored.result.current.messageContent, "new draft must survive");
      post = success;
      await act(async () => { await restored.result.current.deliver(restored.result.current.pendingMessages[0]!); });
      assert.deepEqual(requests.slice(1).map(({ path }) => path), [
        "/api/rooms/room_one/settings", "/api/teams/team_one/agents", "/api/rooms/room_one/messages"
      ]);
      assert.equal(requests.at(-1)?.body, initialBody);
      assert.deepEqual(JSON.parse(initialBody!).mentionAgentIds, [reviewer.agentId, builder.agentId]);
      assert.equal(restored.result.current.messageContent, "new draft must survive");
      assert.deepEqual(restored.result.current.pendingMessages, []);
      assert.deepEqual(delivered, ["msg_delivered"]);
      assert.equal(loadComposerState(scope).state.content, "new draft must survive");
    });

    await t.test("refreshing an in-flight ordinary message makes it failed, with no automatic replay", async () => {
      const delayed = deferred<Response>();
      post = () => delayed.promise;
      const h = mount();
      h.type("uncertain delivery");
      let sending!: Promise<void>;
      act(() => { sending = h.result.current.submit(event); });
      assert.equal(h.result.current.pendingMessages[0]?.status, "pending");
      const original = h.result.current.pendingMessages[0]!;
      h.unmount();
      const restored = mount();
      assert.deepEqual(restored.result.current.pendingMessages, [{ ...original, status: "failed" }]);
      assert.equal(restored.result.current.busy, false);
      assert.equal(requests.length, 1);
      await act(async () => { delayed.resolve(success()); await sending; });
      assert.equal(restored.result.current.pendingMessages.length, 1);
      assert.equal(delivered.length, 0);
    });

    await t.test("late old-context response cannot erase a new draft or clear a new request's busy state", async () => {
      const first = deferred<Response>();
      const second = deferred<Response>();
      post = () => first.promise;
      const h = mount();
      h.type("old request");
      let firstSending!: Promise<void>;
      act(() => { firstSending = h.result.current.submit(event); });
      h.rerender({ ...h.input, selectedTaskId: "task_other" });
      h.type("new request");
      post = () => second.promise;
      let secondSending!: Promise<void>;
      act(() => { secondSending = h.result.current.submit(event); });
      h.type("newer draft while waiting");
      await act(async () => { first.resolve(success()); await firstSending; });
      assert.equal(h.result.current.busy, true);
      assert.equal(h.result.current.messageContent, "newer draft while waiting");
      assert.equal(h.result.current.pendingMessages[0]?.content, "new request");
      assert.equal(delivered.length, 0);
      await act(async () => { second.resolve(success()); await secondSending; });
      assert.equal(h.result.current.busy, false);
      assert.equal(h.result.current.messageContent, "newer draft while waiting");
      h.rerender(h.input);
      assert.equal(h.result.current.pendingMessages[0]?.content, "old request");
      assert.equal(h.result.current.pendingMessages[0]?.status, "failed");
    });

    await t.test("Room roundtrip does not let the first request remove recovered uncertain work", async () => {
      const delayed = deferred<Response>();
      post = () => delayed.promise;
      const h = mount();
      h.type("first roundtrip request");
      let sending!: Promise<void>;
      act(() => { sending = h.result.current.submit(event); });
      h.rerender({ ...h.input, selectedRoomId: "room_other" });
      h.rerender(h.input);
      h.type("new original-room draft");
      await act(async () => { delayed.resolve(success()); await sending; });
      assert.equal(h.result.current.messageContent, "new original-room draft");
      assert.equal(h.result.current.pendingMessages[0]?.status, "failed");
      assert.equal(delivered.length, 0);
    });

    await t.test("retry waits for current Room authority and rejects changed scope, payload or revoked recipients", async () => {
      post = () => json({ error: { message: "offline" } }, 503);
      const h = mount();
      h.type("@Builder keep this payload");
      await h.submit();
      const pending = h.result.current.pendingMessages[0]!;
      h.rerender({ ...h.input, roomAgentsReady: false });
      await act(async () => { await h.result.current.deliver(pending); });
      assert.equal(requests.length, 1);
      assert.match(errors.at(-1)!, /load before retrying/u);
      h.rerender({ ...h.input, selectedTaskId: "task_other" });
      await act(async () => { await h.result.current.deliver(pending); });
      assert.equal(requests.length, 1);
      h.rerender(h.input);
      await act(async () => { await h.result.current.deliver({ ...pending, content: "changed" }); });
      assert.equal(requests.length, 1);
      currentAgents = [{ ...builder, enabled: false }, { ...reviewer, name: "Builder" }];
      await act(async () => { await h.result.current.deliver(pending); });
      assert.equal(requests.filter(({ body }) => body).length, 1);
      assert.deepEqual(h.result.current.pendingMessages, [pending]);
      assert.match(errors.at(-1)!, /recipients cannot be replaced/u);
    });

    await t.test("403 retry authorization failure preserves work, and logout erases only the current User", async () => {
      post = () => json({ error: { message: "offline" } }, 503);
      const h = mount();
      h.type("failed message");
      await h.submit();
      h.type("unsent draft");
      settings = () => json({ error: { message: "Room forbidden" } }, 403);
      await act(async () => { await h.result.current.deliver(h.result.current.pendingMessages[0]!); });
      assert.equal(requests.filter(({ body }) => body).length, 1);
      assert.equal(h.result.current.pendingMessages[0]?.status, "failed");
      assert.equal(h.result.current.messageContent, "unsent draft");
      saveComposerState({ ...scope, userId: "user_keep" }, { ...emptyComposerState(), content: "other user draft" });
      act(() => { assert.equal(clearComposerUserState(scope.userId), true); });
      assert.equal(h.result.current.messageContent, "");
      assert.deepEqual(h.result.current.pendingMessages, []);
      assert.equal(dom.window.sessionStorage.getItem(`${composerStoragePrefix}${scope.userId}`), null);
      assert.equal(loadComposerState({ ...scope, userId: "user_keep" }).state.content, "other user draft");
    });

    await t.test("session invalidation fences a pending retry before it can POST or repersist erased work", async () => {
      post = () => json({ error: { message: "offline" } }, 503);
      const h = mount();
      h.type("do not resurrect");
      await h.submit();
      const delayed = deferred<Response>();
      settings = () => delayed.promise;
      let retrying!: Promise<void>;
      act(() => { retrying = h.result.current.deliver(h.result.current.pendingMessages[0]!); });
      act(() => { advanceWebSessionGeneration(); clearComposerUserState(scope.userId); });
      await act(async () => {
        delayed.resolve(json({ room: { roomId: scope.roomId, teamId: scope.teamId }, participants: { agentIds: [builder.agentId] } }));
        await retrying;
      });
      assert.equal(requests.filter(({ body }) => body).length, 1);
      assert.equal(h.result.current.busy, false);
      assert.deepEqual(h.result.current.pendingMessages, []);
      assert.equal(dom.window.sessionStorage.getItem(`${composerStoragePrefix}${scope.userId}`), null);
    });

    await t.test("restored retained mentions wait for the authoritative roster and then remove invalid targets", async () => {
      const h = mount();
      act(() => h.result.current.changeKeepMentions(true));
      h.type("@Builder start");
      await h.submit();
      h.type("@Builder follow up");
      h.unmount();
      const restored = mount({ roomAgents: [], roomAgentsReady: false });
      assert.equal(restored.result.current.messageContent, "@Builder follow up");
      restored.rerender({ ...restored.input, roomAgents: [reviewer], roomAgentsReady: true });
      assert.equal(restored.result.current.messageContent, "follow up");
      assert.deepEqual(restored.result.current.selectedMentionAgents, []);
    });

    await t.test("invalid and expired records show a warning; blocked/quota storage still permits editing", () => {
      const key = `${composerStoragePrefix}${scope.userId}`;
      dom.window.sessionStorage.setItem(key, "corrupt");
      const invalid = mount();
      assert.match(invalid.result.current.persistenceStatus.warning!, /Invalid saved drafts/u);
      invalid.type("recovered editor");
      assert.equal(invalid.result.current.persistenceStatus.state, "saved");
      invalid.unmount();
      saveComposerState(scope, { ...emptyComposerState(), content: "expired" }, { now: Date.now() - composerStorageTtlMs });
      const expired = mount();
      assert.equal(expired.result.current.messageContent, "");
      assert.match(expired.result.current.persistenceStatus.warning!, /24 hours/u);
      expired.unmount();
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
      const blocked = mount();
      blocked.type("still editable");
      assert.equal(blocked.result.current.messageContent, "still editable");
      assert.equal(blocked.result.current.persistenceStatus.state, "not_saved");
      assert.match(blocked.result.current.persistenceStatus.warning!, /not saved/u);
      blocked.unmount();
      Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
        getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error("quota"); }
      } });
      const quota = mount();
      quota.type("quota draft");
      assert.equal(quota.result.current.messageContent, "quota draft");
      assert.equal(quota.result.current.persistenceStatus.state, "not_saved");
      act(() => quota.result.current.clearDraft());
      assert.equal(quota.result.current.messageContent, "");
    });

    await t.test("Discussion failure stays a draft and recovery never creates or replays an ordinary message", async () => {
      post = () => json({ error: { message: "Discussion rejected" } }, 503);
      const h = mount();
      h.rerender({ ...h.input, roomPolicy: { ...h.input.roomPolicy, allowDiscussion: true } });
      h.type("@Builder @Reviewer discuss this");
      await h.submit();
      assert.equal(requests[0]?.path, "/api/rooms/room_one/discussions");
      assert.equal(h.result.current.messageContent, "@Builder @Reviewer discuss this");
      assert.deepEqual(h.result.current.pendingMessages, []);
      h.unmount();
      const restored = mount({ roomPolicy: { ...h.input.roomPolicy, allowDiscussion: true } });
      assert.equal(restored.result.current.messageContent, "@Builder @Reviewer discuss this");
      assert.deepEqual(restored.result.current.pendingMessages, []);
      assert.equal(requests.length, 1);
      act(() => restored.result.current.clearDraft());
      restored.unmount();
      assert.equal(mount().result.current.messageContent, "");
    });
  } finally {
    cleanup();
    globalThis.fetch = originalFetch;
    for (const key of ["document", "HTMLElement", "localStorage", "sessionStorage", "navigator", "window", "IS_REACT_ACT_ENVIRONMENT"]) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});
