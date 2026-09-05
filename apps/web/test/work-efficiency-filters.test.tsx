import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { WorkSearchInput } from "../src/features/work/WorkSearchInput.js";
import { useWorkbench } from "../src/features/work/useWorkbench.js";
import { parseWorkspaceNavigation, workspaceNavigationUrl } from "../src/features/navigation/workspace-navigation.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const key of ["document", "HTMLElement", "window", "navigator"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
  return dom;
}

test("filter navigation round-trips separately from the selected Room and rejects invalid values", () => {
  const intent = { roomId: "room_selected01", filterRoomId: "room_filtered01", filterAgentId: "agent_filtered01", attention: "needs_input" as const, priority: "urgent" as const };
  assert.deepEqual(parseWorkspaceNavigation(workspaceNavigationUrl(intent)), { navigation: intent, error: null });
  for (const query of ["attention=made_up", "attention=blocked&attention=needs_input", "priority=constructor", "workRoom=agent_filtered01", "workAgent=room_filtered01"]) {
    assert.ok(parseWorkspaceNavigation(query).error);
    assert.equal(parseWorkspaceNavigation(query).navigation, null);
  }
});

test("search coalesces typing, waits for IME completion and cancels when the context unmounts", async () => {
  const dom = installDom();
  const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
  const changes: string[] = [];
  const props = { value: "", locale: "zh-CN" as const, onChange: (value: string) => changes.push(value) };
  try {
    const view = render(<WorkSearchInput {...props} />);
    const input = view.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ab" } });
    assert.deepEqual(changes, []);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    assert.deepEqual(changes, ["ab"]);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "zhong" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    assert.deepEqual(changes, ["ab"]);
    fireEvent.compositionEnd(input, { target: { value: "中文" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    assert.deepEqual(changes, ["ab", "中文"]);
    fireEvent.change(input, { target: { value: "pending private search" } });
    view.rerender(<WorkSearchInput {...props} key="other-team" value="restored" />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    assert.deepEqual(changes, ["ab", "中文"]);
    assert.equal((view.getByRole("searchbox") as HTMLInputElement).value, "restored");
  } finally { cleanup(); dom.window.close(); }
});

test("quick filters go to the Server and invalidate old pagination without locally filtering rows", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  const calls: URL[] = [];
  let finish!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  const page = (taskId: string, nextCursor: string | null = null) => new Response(JSON.stringify({ items: [{ taskId }], nextCursor }));
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost"); calls.push(url);
    if (url.searchParams.has("cursor")) { signal = init?.signal; return new Promise((resolve) => { finish = resolve; }); }
    return page(url.searchParams.get("attention") ?? "initial", "cursor_next");
  };
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  const props = { teamId: "team_filter01", session: { userId: "user_filter01", displayName: "Owner", token: "fixture" }, scope: "mine" as const, lifecycleState: "", ownerMemberId: "", attention: "" as "" | "needs_input", filterRoomId: "", filterAgentId: "", priority: "" as "" | "urgent" };
  try {
    const hook = renderHook((input) => useWorkbench(input), { initialProps: props });
    await waitFor(() => assert.equal(hook.result.current.loading, false));
    let more!: Promise<void>;
    act(() => { more = hook.result.current.loadMore(); });
    hook.rerender({ ...props, attention: "needs_input", filterRoomId: "room_filter01", filterAgentId: "agent_filter01", priority: "urgent" });
    assert.equal(signal?.aborted, true);
    await waitFor(() => assert.equal(hook.result.current.items[0]?.taskId, "needs_input"));
    const query = calls.at(-1)!.searchParams;
    for (const [key, value] of Object.entries({ attention: "needs_input", roomId: "room_filter01", agentId: "agent_filter01", priority: "urgent" })) assert.equal(query.get(key), value);
    assert.equal(query.has("cursor"), false);
    await act(async () => { finish(page("private_old_page")); await more; });
    assert.equal(hook.result.current.items[0]?.taskId, "needs_input");
    hook.rerender(props);
    await waitFor(() => assert.equal(hook.result.current.items[0]?.taskId, "initial"));
    assert.equal(calls.at(-1)!.searchParams.has("attention"), false);
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});
