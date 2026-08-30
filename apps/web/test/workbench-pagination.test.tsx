import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import { useWorkbench } from "../src/features/work/useWorkbench.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    window: { configurable: true, value: dom.window },
    navigator: { configurable: true, value: dom.window.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true, writable: true }
  });
  return dom;
}

const initial = {
  teamId: "team_first",
  session: { userId: "user_owner", displayName: "Owner", token: "test-session" },
  scope: "mine" as "mine" | "team",
  lifecycleState: "",
  ownerMemberId: ""
};

function page(ids: string[], nextCursor: string | null = null) {
  return new Response(JSON.stringify({ items: ids.map((taskId) => ({ taskId })), nextCursor }), {
    headers: { "content-type": "application/json" }
  });
}

test("Work cursor appends unique Tasks, refreshes the loaded window and resets filters", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const path = String(input);
    requests.push(path);
    if (path.includes("lifecycleState=review")) return page(["task_review"]);
    return path.includes("cursor=next_page") ? page(["task_b", "task_c"]) : page(["task_a", "task_b"], "next_page");
  };
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook((props) => useWorkbench(props), { initialProps: initial });
    await waitFor(() => assert.equal(hook.result.current.loading, false));
    assert.equal(hook.result.current.hasMore, true);
    await act(async () => { await Promise.all([hook.result.current.loadMore(), hook.result.current.loadMore()]); });
    assert.deepEqual(hook.result.current.items.map(({ taskId }) => taskId), ["task_a", "task_b", "task_c"]);
    assert.equal(requests.filter((path) => path.includes("cursor=")).length, 1);
    assert.equal(hook.result.current.hasMore, false);
    await act(async () => { await hook.result.current.refresh(); });
    assert.equal(requests.filter((path) => path.includes("cursor=")).length, 2);
    assert.equal(hook.result.current.items.length, 3);
    hook.rerender({ ...initial, scope: "team", lifecycleState: "review", ownerMemberId: "member_bob" });
    await waitFor(() => assert.deepEqual(hook.result.current.items.map(({ taskId }) => taskId), ["task_review"]));
    assert.match(requests.at(-1) ?? "", /scope=team&limit=100&lifecycleState=review&ownerMemberId=member_bob/u);
    assert.equal(hook.result.current.pages, 1);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a late old-Team page and old-scope error cannot replace a new Work context", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let finishPage!: (response: Response) => void;
  let rejectScope!: (reason: Error) => void;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.includes("team_second")) return page(["task_other"]);
    if (path.includes("cursor=")) return new Promise<Response>((resolve) => { finishPage = resolve; });
    if (path.includes("scope=team")) return new Promise<Response>((_resolve, reject) => { rejectScope = reject; });
    return page(["task_first"], "next_page");
  };
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook((props) => useWorkbench(props), { initialProps: initial });
    await waitFor(() => assert.equal(hook.result.current.loading, false));
    let loading: Promise<void>;
    act(() => { loading = hook.result.current.loadMore(); });
    hook.rerender({ ...initial, teamId: "team_second" });
    await waitFor(() => assert.equal(hook.result.current.items[0]?.taskId, "task_other"));
    await act(async () => { finishPage(page(["task_old_private"])); await loading!; });
    assert.deepEqual(hook.result.current.items.map(({ taskId }) => taskId), ["task_other"]);
    hook.rerender({ ...initial, scope: "team" });
    await waitFor(() => assert.equal(typeof rejectScope, "function"));
    hook.rerender({ ...initial, teamId: "team_second" });
    await waitFor(() => assert.equal(hook.result.current.loading, false));
    await act(async () => { rejectScope(new Error("old context error")); });
    assert.equal(hook.result.current.error, null);
    assert.deepEqual(hook.result.current.items.map(({ taskId }) => taskId), ["task_other"]);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("failed additional pages retain their cursor and a manual retry does not lose existing work", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let fail = true;
  globalThis.fetch = async (input) => {
    if (!String(input).includes("cursor=")) return page(["task_first"], "page_two");
    if (fail) throw new Error("Connection interrupted");
    return page(["task_second"]);
  };
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook(() => useWorkbench(initial));
    await waitFor(() => assert.equal(hook.result.current.loading, false));
    await act(async () => { await hook.result.current.loadMore(); });
    assert.equal(hook.result.current.items.length, 1);
    assert.equal(hook.result.current.nextCursor, "page_two");
    assert.match(hook.result.current.error ?? "", /interrupted/u);
    fail = false;
    await act(async () => { await hook.result.current.loadMore(); });
    assert.equal(hook.result.current.items.length, 2);
    assert.equal(hook.result.current.error, null);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a live refresh waits for an in-flight page and then refreshes the enlarged window", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let finish!: (value: Response) => void;
  let delayed = false;
  let pageSignal: AbortSignal | null | undefined;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    calls += 1;
    if (!String(input).includes("cursor=")) return page(["task_first"], "page_two");
    if (!delayed) {
      delayed = true;
      pageSignal = init?.signal;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    return page(["task_second"]);
  };
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook(() => useWorkbench(initial));
    await waitFor(() => assert.equal(hook.result.current.loading, false));
    let more!: Promise<void>;
    let refresh!: Promise<void>;
    act(() => { more = hook.result.current.loadMore(); });
    act(() => { refresh = hook.result.current.refresh(); });
    assert.equal(pageSignal?.aborted, false);
    assert.equal(calls, 2);
    await act(async () => {
      finish(page(["task_second"]));
      await more;
      await refresh;
    });
    assert.equal(calls, 4);
    assert.deepEqual(hook.result.current.items.map(({ taskId }) => taskId), ["task_first", "task_second"]);
    assert.equal(hook.result.current.hasMore, false);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});
