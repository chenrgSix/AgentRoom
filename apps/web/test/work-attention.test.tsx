import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { useWorkAttention } from "../src/features/work/useWorkAttention.js";
import { WorkspaceSidebar } from "../src/features/navigation/WorkspaceSidebar.js";
import type { WorkbenchItem } from "../src/features/work/WorkWorkspace.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  for (const key of ["document", "HTMLElement", "window", "navigator"] as const) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
  return dom;
}
const session = { userId: "user_attention01", token: "fixture", displayName: "Owner" };
const response = (taskId: string | null, status = 200) => new Response(JSON.stringify({ items: taskId ? [{ taskId }] : [], nextCursor: "there_may_be_more" }), { status });

test("attention is a bounded independent query, refreshes after change/focus and clears on denied access", async () => {
  const dom = installDom(); const original = globalThis.fetch;
  const urls: URL[] = [];
  let current: string | null = "task_needs_review"; let denied = false;
  globalThis.fetch = async (input) => { urls.push(new URL(String(input), "http://localhost")); return response(current, denied ? 403 : 200); };
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook(() => useWorkAttention("team_attention01", session));
    await waitFor(() => assert.equal(hook.result.current.item?.taskId, current));
    const query = urls[0]!.searchParams;
    assert.equal(query.get("limit"), "1"); assert.equal(query.get("scope"), "mine");
    assert.equal(query.get("attention"), "needs_input,needs_approval,outcome_unknown");
    assert.equal(query.has("search"), false); assert.equal(query.has("cursor"), false);
    current = null;
    await act(async () => { await hook.result.current.refresh(); });
    assert.equal(hook.result.current.item, null);
    current = "task_needs_input";
    act(() => { window.dispatchEvent(new dom.window.Event("focus")); });
    await waitFor(() => assert.equal(hook.result.current.item?.taskId, current));
    denied = true;
    await act(async () => { await hook.result.current.refresh(); });
    assert.equal(hook.result.current.item, null); assert.equal(hook.result.current.failed, true);
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});

test("Team switch and logout fence late data, while concurrent refreshes share one request", async () => {
  const dom = installDom(); const original = globalThis.fetch;
  let finish!: (response: Response) => void; let signal: AbortSignal | null | undefined; let count = 0;
  globalThis.fetch = async (input, init) => {
    count += 1;
    if (String(input).includes("team_first")) { signal = init?.signal; return new Promise((resolve) => { finish = resolve; }); }
    return response("task_second");
  };
  const { act, cleanup, renderHook, waitFor } = await import("@testing-library/react");
  try {
    const hook = renderHook((props: { team: string | null; session: typeof session | null }) => useWorkAttention(props.team, props.session), { initialProps: { team: "team_first", session } });
    let refreshed!: Promise<void>;
    act(() => { refreshed = hook.result.current.refresh(); });
    assert.equal(count, 1);
    hook.rerender({ team: "team_second", session });
    assert.equal(signal?.aborted, true); assert.equal(hook.result.current.item, null);
    await waitFor(() => assert.equal(hook.result.current.item?.taskId, "task_second"));
    await act(async () => { finish(response("task_private_first")); await refreshed; });
    assert.equal(hook.result.current.item?.taskId, "task_second");
    hook.rerender({ team: null, session: null });
    assert.equal(hook.result.current.item, null);
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});

test("the accessible sidebar indicator remains visible in management and navigates with its exact item", async () => {
  const dom = installDom();
  const { cleanup, fireEvent, render } = await import("@testing-library/react");
  const item = { taskId: "task_attention01" } as WorkbenchItem;
  const opened: WorkbenchItem[] = [];
  const props = { activeView: "agents" as const, locale: "en" as const, teams: [], teamId: "team_attention01", rooms: [], roomId: null,
    onTeam: () => undefined, onNewTeam: () => undefined, onNewRoom: () => undefined, onRoom: () => undefined, onView: () => undefined,
    onCollaboration: () => undefined, attentionItem: item, onOpenAttention: (value: WorkbenchItem) => opened.push(value) };
  try {
    const view = render(<WorkspaceSidebar {...props} />);
    fireEvent.click(view.getByRole("button", { name: /My work needs attention/u }));
    assert.deepEqual(opened, [item]);
    assert.equal(view.queryByText(/total|99|100/u), null);
    view.rerender(<WorkspaceSidebar {...props} attentionItem={null} attentionFailed />);
    assert.ok(view.getByRole("button", { name: "Check pending work again" }));
    assert.equal(view.queryByRole("button", { name: /My work needs attention/u }), null);
  } finally { cleanup(); dom.window.close(); }
});
