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
  teamId: "team_search_0001", session: { userId: "user_search_0001", displayName: "Owner", token: "search-session" },
  scope: "mine" as const, lifecycleState: "", ownerMemberId: "", search: "  first  "
};

function page(taskIds: string[], nextCursor: string | null = null) {
  return new Response(JSON.stringify({ items: taskIds.map((taskId) => ({ taskId })), nextCursor }), { headers: { "content-type": "application/json" } });
}

test("search changes abort old pagination, reset the page window and fence late search results", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const urls: URL[] = [];
  let oldPage!: (response: Response) => void;
  let oldSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url);
    const search = url.searchParams.get("search");
    if (search === "first" && url.searchParams.has("cursor")) {
      oldSignal = init?.signal;
      return new Promise<Response>((resolve) => { oldPage = resolve; });
    }
    if (search === "second") return url.searchParams.has("cursor")
      ? page(["task_second_page2"])
      : page(["task_second_page1"], "second_cursor");
    return page(["task_first_page1"], "first_cursor");
  };
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook((props) => useWorkbench(props), { initialProps: initial });
    await waitFor(() => assert.equal(hook.result.current.loading, false));
    assert.equal(urls[0]?.searchParams.get("search"), "first");
    let more!: Promise<void>;
    act(() => { more = hook.result.current.loadMore(); });
    await waitFor(() => assert.equal(typeof oldPage, "function"));
    hook.rerender({ ...initial, search: "second" });
    assert.equal(oldSignal?.aborted, true);
    await waitFor(() => assert.equal(hook.result.current.items[0]?.taskId, "task_second_page1"));
    assert.equal(hook.result.current.pages, 1);
    assert.equal(hook.result.current.nextCursor, "second_cursor");
    await act(async () => { oldPage(page(["task_old_private_page"])); await more; });
    assert.deepEqual(hook.result.current.items.map(({ taskId }) => taskId), ["task_second_page1"]);
    await act(async () => { await hook.result.current.loadMore(); });
    assert.equal(hook.result.current.pages, 2);
    await act(async () => { await hook.result.current.refresh(); });
    assert.deepEqual(hook.result.current.items.map(({ taskId }) => taskId), ["task_second_page1", "task_second_page2"]);
    assert.equal(urls.at(-1)?.searchParams.get("cursor"), "second_cursor");
    const requestsBeforeWhitespace = urls.length;
    hook.rerender({ ...initial, search: " second " });
    assert.equal(urls.length, requestsBeforeWhitespace, "equivalent trimmed searches preserve the loaded window");
    assert.equal(hook.result.current.pages, 2);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("empty search remains compatible and oversized search fails closed before a request", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => { requests.push(String(input)); return page(["task_visible"]); };
  const { cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook((props) => useWorkbench(props), { initialProps: { ...initial, search: "  " } });
    await waitFor(() => assert.equal(hook.result.current.loading, false));
    assert.equal(new URL(requests[0]!, "http://localhost").searchParams.has("search"), false);
    hook.rerender({ ...initial, search: "x".repeat(101) });
    await waitFor(() => assert.match(hook.result.current.error ?? "", /at most 100/u));
    assert.equal(requests.length, 1);
    assert.deepEqual(hook.result.current.items, []);
    assert.equal(hook.result.current.hasMore, false);
    hook.rerender({ ...initial, search: "😀".repeat(100) });
    await waitFor(() => assert.equal(hook.result.current.error, null));
    assert.equal(new URL(requests.at(-1)!, "http://localhost").searchParams.get("search"), "😀".repeat(100));
    hook.rerender({ ...initial, search: "😀".repeat(101) });
    await waitFor(() => assert.match(hook.result.current.error ?? "", /at most 100/u));
    assert.equal(requests.length, 2);
    hook.rerender({ ...initial, search: "TASK-17" });
    await waitFor(() => assert.equal(hook.result.current.error, null));
    assert.equal(new URL(requests.at(-1)!, "http://localhost").searchParams.get("search"), "TASK-17");
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a late failure from an old search cannot replace the new search state", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let rejectOld!: (reason: Error) => void;
  globalThis.fetch = async (input) => String(input).includes("search=first")
    ? new Promise<Response>((_resolve, reject) => { rejectOld = reject; })
    : page(["task_new_search"]);
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook((props) => useWorkbench(props), { initialProps: initial });
    await waitFor(() => assert.equal(typeof rejectOld, "function"));
    hook.rerender({ ...initial, search: "new" });
    await waitFor(() => assert.equal(hook.result.current.items[0]?.taskId, "task_new_search"));
    await act(async () => { rejectOld(new Error("old search failure")); });
    assert.equal(hook.result.current.error, null);
    assert.deepEqual(hook.result.current.items.map(({ taskId }) => taskId), ["task_new_search"]);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});
