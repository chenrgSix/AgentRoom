import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";
import { advanceWebSessionGeneration, jsonRequest } from "../src/api-client.js";
import type { AgentTask, Member, Message, Room, Run, Team } from "../src/models.js";

const now = "2026-08-31T00:00:00.000Z";
const user = { userId: "user_context_owner", displayName: "Owner" };
const teamA: Team = { teamId: "team_context_alpha", name: "Team Alpha", createdAt: now };
const teamB: Team = { teamId: "team_context_bravo", name: "Team Bravo", createdAt: now };
const roomA: Room = {
  roomId: "room_context_alpha", teamId: teamA.teamId, name: "alpha-room", createdAt: now,
  settingsRevision: 1,
  collaborationPolicy: { allowDiscussion: true, allowAll: true, allowAgentMentions: true, maxAgentMentionDepth: 4 }
};
const roomB: Room = { ...roomA, roomId: "room_context_bravo", teamId: teamB.teamId, name: "bravo-room" };

function member(team: Team): Member {
  return {
    memberId: `member_${team.teamId}`, teamId: team.teamId, userId: user.userId,
    displayName: team.teamId === teamA.teamId ? "Alpha Member" : "Bravo Member", role: "owner"
  };
}

function message(room: Room, sequence: number, content: string): Message {
  return {
    messageId: `msg_${room.roomId}_${sequence}`, traceId: `trace_${sequence}`,
    roomId: room.roomId, taskId: `task_${room.roomId}`, sequence,
    senderType: "member", senderId: member(room.teamId === teamA.teamId ? teamA : teamB).memberId,
    content, mentions: [], parentMessageId: null, createdAt: now
  };
}

function installDom(visible = false) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://team.example.com/", pretendToBeVisual: visible
  });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    localStorage: { configurable: true, value: dom.window.localStorage },
    sessionStorage: { configurable: true, value: dom.window.sessionStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window }
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
  advanceWebSessionGeneration();
  return dom;
}

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pendingChange(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

function commonResponse(path: string, teams: Team[], rooms: Room[]): Response | null {
  if (path === "/api/auth/status") return response({
    mode: "trusted-team", state: "authenticated", user,
    session: { expiresAt: "2099-09-30T00:00:00.000Z" }
  });
  if (path === "/api/teams") return response(teams);
  for (const team of teams) {
    if (path.startsWith(`/api/teams/${team.teamId}/work-items?`)) return response({ items: [], nextCursor: null });
    if (path === `/api/teams/${team.teamId}/rooms`) return response(rooms.filter((room) => room.teamId === team.teamId));
    if (path === `/api/teams/${team.teamId}/members`) return response([member(team)]);
    if (["agents", "devices"].some((suffix) => path === `/api/teams/${team.teamId}/${suffix}`)) return response([]);
  }
  for (const room of rooms) {
    if (path === `/api/rooms/${room.roomId}/settings`) return response({
      room, participants: { memberIds: [member(teams.find((team) => team.teamId === room.teamId)!).memberId], agentIds: [] }
    });
    if (["runs", "discussions", "tasks", "memory-candidates"].some((suffix) => path === `/api/rooms/${room.roomId}/${suffix}`)) return response([]);
    if (path.startsWith(`/api/rooms/${room.roomId}/messages?`)) return response({
      items: [], nextCursor: null, olderCursor: null, syncCursor: `cursor_${room.roomId}_0`
    });
  }
  return null;
}

test("a previous user's late Team list cannot replace the recovered member's Teams", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const previousTeams = deferred<Response>();
  const nextUser = { userId: "user_recovered_bravo", displayName: "Recovered Bravo" };
  let teamCalls = 0;
  let recovered = false;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path === "/api/teams") {
      teamCalls += 1;
      return teamCalls === 1 ? previousTeams.promise : response([teamB]);
    }
    if (path === "/api/test/expire") return response({ error: { message: "Expired Cookie" } }, 401);
    if (path === "/api/auth/recover-member") {
      recovered = true;
      return response({ user: nextUser });
    }
    if (path === `/api/teams/${teamB.teamId}/members`) return response([{ ...member(teamB), ...nextUser, role: "member" }]);
    if (path.includes("/changes?")) return pendingChange(init.signal);
    const result = commonResponse(path, recovered ? [teamB] : [teamA], recovered ? [roomB] : [roomA]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await waitFor(() => assert.equal(teamCalls, 1));
    await act(async () => { await jsonRequest("/api/test/expire").catch(() => undefined); });
    await page.findByRole("heading", { name: "回到你的 Team" });
    fireEvent.change(page.getByLabelText("一次性成员恢复码"), { target: { value: "new-bravo-member-code" } });
    fireEvent.click(page.getByRole("button", { name: "恢复原成员身份" }));
    await page.findByTitle("Team Bravo");
    await waitFor(() => assert.equal((page.getByLabelText("选择房间") as HTMLSelectElement).value, roomB.roomId));
    await act(async () => { previousTeams.resolve(response([teamA])); await previousTeams.promise; });
    assert.ok(page.getByTitle("Team Bravo"));
    assert.equal(page.queryByTitle("Team Alpha"), null);
    assert.equal((page.getByLabelText("选择房间") as HTMLSelectElement).value, roomB.roomId);
    assert.equal(page.queryByRole("alert"), null);
    assert.equal(dom.window.document.body.textContent?.includes("previous Web session"), false);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a previous Owner's credential response cannot refill the next member's UI or release a new login", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const credential = deferred<Response>();
  const recovery = deferred<Response>();
  const nextUser = { userId: "user_recovered_credential", displayName: "Recovered Member" };
  const oldSecret = "private-old-owner-mcp-token-never-show";
  let credentialCalls = 0;
  let recoveryCalls = 0;
  let recovered = false;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path === `/api/teams/${teamA.teamId}/manual-agents`) { credentialCalls += 1; return credential.promise; }
    if (path === "/api/test/expire") return response({ error: { message: "Revoked Cookie" } }, 401);
    if (path === "/api/auth/recover-member") { recoveryCalls += 1; return recovery.promise; }
    if (path === `/api/teams/${teamB.teamId}/members`) return response([{ ...member(teamB), ...nextUser, role: "member" }]);
    if (path.endsWith("/hosted-agents") || path.endsWith("/agent-provision-requests")) return response([]);
    if (path.includes("/changes?")) return pendingChange(init.signal);
    const result = commonResponse(path, recovered ? [teamB] : [teamA], recovered ? [roomB] : [roomA]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await page.findByTitle("Team Alpha");
    fireEvent.click(page.getAllByRole("button", { name: "智能体管理", exact: true })[0]!);
    fireEvent.click(await page.findByRole("tab", { name: "MCP 客户端" }));
    fireEvent.change(page.getByLabelText("MCP 智能体名称"), { target: { value: "Old Owner Private Agent" } });
    fireEvent.click(page.getByRole("button", { name: "创建 MCP 凭据" }));
    await waitFor(() => assert.equal(credentialCalls, 1));
    await act(async () => { await jsonRequest("/api/test/expire").catch(() => undefined); });
    await page.findByRole("heading", { name: "回到你的 Team" });
    fireEvent.change(page.getByLabelText("一次性成员恢复码"), { target: { value: "new-member-login-in-progress" } });
    assert.equal((page.getByRole("button", { name: "恢复原成员身份" }) as HTMLButtonElement).disabled, false);
    fireEvent.click(page.getByRole("button", { name: "恢复原成员身份" }));
    await waitFor(() => assert.equal(recoveryCalls, 1));
    await act(async () => {
      credential.resolve(response({
        agent: { agentId: "agent_old_owner_secret", teamId: teamA.teamId, name: "Old Owner Private Agent", role: "MCP participant", integrationMode: "manual", presence: "manual" },
        credential: { token: oldSecret }
      }));
      await credential.promise;
    });
    // The old request's finally must not enable recovery while the new request is pending.
    assert.equal((within(page.getByRole("form", { name: "成员重新登录" })).getByRole("button", { name: "正在验证…" }) as HTMLButtonElement).disabled, true);
    assert.equal(page.queryByRole("alert"), null);
    await act(async () => { recovered = true; recovery.resolve(response({ user: nextUser })); await recovery.promise; });
    await page.findByTitle("Team Bravo");
    await waitFor(() => assert.equal((page.getByLabelText("选择房间") as HTMLSelectElement).value, roomB.roomId));
    // The saved Agents URL belonged to Team Alpha. Reauthentication must
    // authorize that intent before restoring it, then fall back to current Work.
    assert.ok(await page.findByRole("region", { name: "工作台" }));
    assert.equal(page.queryByRole("region", { name: "智能体管理" }), null);
    assert.equal(page.getByRole("alert").textContent, "操作失败：链接中的团队不可用或你没有访问权限。");
    const restoredLocation = new URLSearchParams(dom.window.location.search);
    assert.equal(restoredLocation.get("team"), teamB.teamId);
    assert.equal(restoredLocation.get("view"), "work");
    assert.equal(restoredLocation.has("room"), false);
    assert.equal(page.queryByTitle("Team Alpha"), null);
    assert.equal(page.queryByText("Old Owner Private Agent"), null);
    assert.equal(dom.window.document.body.textContent?.includes(oldSecret), false);
    assert.equal(JSON.stringify(dom.window.localStorage).includes(oldSecret), false);
    assert.equal(JSON.stringify(dom.window.sessionStorage).includes(oldSecret), false);
    assert.equal(dom.window.document.body.textContent?.includes("previous Web session"), false);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a late Team registry batch cannot overwrite a newly selected Team", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const pending = new Map(["rooms", "agents", "members", "devices"].map((suffix) => [suffix, deferred<Response>()]));
  const paths: string[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    paths.push(path);
    for (const [suffix, wait] of pending) {
      if (path === `/api/teams/${teamA.teamId}/${suffix}`) return wait.promise;
    }
    if (path.includes("/changes?")) return pendingChange(init.signal);
    const result = commonResponse(path, [teamA, teamB], [roomA, roomB]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    const bravo = await page.findByTitle("Team Bravo");
    await waitFor(() => assert.ok(paths.includes(`/api/teams/${teamA.teamId}/devices`)));
    fireEvent.click(bravo);
    await waitFor(() => assert.equal((page.getByLabelText("选择房间") as HTMLSelectElement).value, roomB.roomId));
    fireEvent.click(page.getAllByRole("button", { name: "Team 成员", exact: true })[0]!);
    await page.findAllByText("Bravo Member");
    await act(async () => {
      for (const [suffix, wait] of pending) {
        wait.resolve(commonResponse(`/api/teams/${teamA.teamId}/${suffix}`, [teamA, teamB], [roomA, roomB])!);
      }
      await Promise.all([...pending.values()].map((wait) => wait.promise));
    });
    assert.equal((page.getByLabelText("选择房间") as HTMLSelectElement).value, roomB.roomId);
    assert.match(page.getByTitle("Team Bravo").className, /active/u);
    assert.equal(page.queryByText("Alpha Member"), null);
    assert.ok(page.getAllByText("Bravo Member").length > 0);
    assert.equal(paths.some((path) => path.startsWith(`/api/rooms/${roomA.roomId}/`)), false);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("Room change listening waits for initial Run output and then advances the initial snapshot", async () => {
  const dom = installDom(true);
  const originalFetch = globalThis.fetch;
  const output = deferred<Response>();
  const change = deferred<Response>();
  const paths: string[] = [];
  let outputCalls = 0;
  let changeCalls = 0;
  const initialMessage = message(roomA, 1, "Initial snapshot message");
  const newMessage = message(roomA, 2, "New live message after initialization");
  const run: Run = {
    runId: "run_initial_context", taskId: initialMessage.taskId,
    triggerMessageId: initialMessage.messageId, targetAgentId: "agent_context_test",
    state: "working", updatedAt: now
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    paths.push(path);
    if (path.startsWith(`/api/runs/${run.runId}/events?`)) {
      outputCalls += 1;
      return outputCalls === 1 ? output.promise : response([]);
    }
    if (path.startsWith(`/api/teams/${teamA.teamId}/changes?`)) {
      changeCalls += 1;
      return changeCalls === 1 ? change.promise : pendingChange(init.signal);
    }
    if (path === `/api/rooms/${roomA.roomId}/runs`) return response([run]);
    if (path.startsWith(`/api/rooms/${roomA.roomId}/messages?`)) {
      const query = new URL(path, "https://team.example.com").searchParams;
      if (query.has("cursor")) {
        assert.equal(query.get("cursor"), "cursor_initial_1");
        return response({ items: [newMessage], nextCursor: null, olderCursor: null, syncCursor: "cursor_live_2" });
      }
      return response({ items: [initialMessage], nextCursor: null, olderCursor: null, syncCursor: "cursor_initial_1" });
    }
    const result = commonResponse(path, [teamA], [roomA]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await waitFor(() => assert.equal(outputCalls, 1));
    assert.equal(changeCalls, 0);
    fireEvent.click(page.getByRole("button", { name: "⌁ 对话", exact: true }));
    assert.equal(page.queryByText("New live message after initialization"), null);
    await act(async () => { output.resolve(response([])); await output.promise; });
    await page.findByText("Initial snapshot message");
    await waitFor(() => assert.equal(changeCalls, 1));
    await act(async () => {
      change.resolve(response({ cursor: 1, changed: true, reset: false, team: false, roomIds: [roomA.roomId], runRoomIds: [] }));
      await change.promise;
    });
    await page.findByText("New live message after initialization");
    assert.ok(page.getByText("Initial snapshot message"));
    assert.equal(page.getAllByText("New live message after initialization").length, 1);
    assert.ok(paths.includes(`/api/rooms/${roomA.roomId}/messages?limit=100&cursor=cursor_initial_1`));
    assert.equal(paths.filter((path) => path.includes("messages?") && path.includes("tail=true")).length, 1);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a late history page from the previous Room never enters the new Room", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const secondRoom = { ...roomB, teamId: teamA.teamId };
  const history = deferred<Response>();
  let historyCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path.includes("/changes?")) return pendingChange(init.signal);
    if (path.startsWith(`/api/rooms/${roomA.roomId}/messages?`)) {
      if (new URL(path, "https://team.example.com").searchParams.has("beforeCursor")) {
        historyCalls += 1;
        return history.promise;
      }
      return response({ items: [message(roomA, 100, "Current Alpha message")], nextCursor: null, olderCursor: "older_alpha", syncCursor: "sync_alpha_100" });
    }
    if (path.startsWith(`/api/rooms/${secondRoom.roomId}/messages?`)) {
      return response({ items: [message(secondRoom, 1, "Current Bravo message")], nextCursor: null, olderCursor: null, syncCursor: "sync_bravo_1" });
    }
    const result = commonResponse(path, [teamA], [roomA, secondRoom]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    fireEvent.click(await page.findByRole("button", { name: "⌁ 对话", exact: true }));
    await page.findByText("Current Alpha message");
    fireEvent.click(page.getByRole("button", { name: "加载更早的消息" }));
    await waitFor(() => assert.equal(historyCalls, 1));
    fireEvent.change(page.getByLabelText("选择房间"), { target: { value: secondRoom.roomId } });
    await page.findByText("Current Bravo message");
    await act(async () => {
      history.resolve(response({ items: [message(roomA, 99, "Late private Alpha history")], nextCursor: null, olderCursor: "older_alpha_again", syncCursor: "sync_alpha_99" }));
      await history.promise;
    });
    assert.ok(page.getByText("Current Bravo message"));
    assert.equal(page.queryByText("Late private Alpha history"), null);
    assert.equal(page.queryByText("Current Alpha message"), null);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("six bounded history pages remain intact after a live message without skipping older cursors", async () => {
  const dom = installDom(true);
  const originalFetch = globalThis.fetch;
  const change = deferred<Response>();
  const beforeBoundaries: number[] = [];
  const forwardCursors: string[] = [];
  let changes = 0;
  let tailReads = 0;
  const historyPage = (first: number) => ({
    items: Array.from({ length: 100 }, (_, index) => {
      const sequence = first + index;
      return message(roomA, sequence, `History message ${sequence}`);
    }),
    nextCursor: null,
    olderCursor: first > 1 ? `opaque-history-boundary-${first}` : null,
    syncCursor: `opaque-live-sequence-${first + 99}`
  });
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path.startsWith(`/api/teams/${teamA.teamId}/changes?`)) {
      changes += 1;
      return changes === 1 ? change.promise : pendingChange(init.signal);
    }
    if (path.startsWith(`/api/rooms/${roomA.roomId}/messages?`)) {
      const query = new URL(path, "https://team.example.com").searchParams;
      assert.equal(query.get("limit"), "100", "history must remain bounded per request");
      const before = query.get("beforeCursor");
      if (before) {
        const match = /^opaque-history-boundary-(\d+)$/u.exec(before);
        assert.ok(match);
        const boundary = Number(match[1]);
        beforeBoundaries.push(boundary);
        assert.ok(boundary >= 101 && boundary <= 501);
        return response(historyPage(boundary - 100));
      }
      const cursor = query.get("cursor");
      if (cursor) {
        forwardCursors.push(cursor);
        assert.equal(cursor, "opaque-live-sequence-600", "backward reads must not rewind live synchronization");
        return response({
          items: [message(roomA, 601, "Live message 601")],
          nextCursor: null, olderCursor: null, syncCursor: "opaque-live-sequence-601"
        });
      }
      assert.equal(query.get("tail"), "true");
      tailReads += 1;
      return response(historyPage(501));
    }
    const result = commonResponse(path, [teamA], [roomA]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    fireEvent.click(await page.findByRole("button", { name: "⌁ 对话", exact: true }));
    await page.findByText("History message 501");
    await waitFor(() => assert.equal(changes, 1));
    for (const first of [401, 301, 201, 101, 1]) {
      fireEvent.click(page.getByRole("button", { name: "加载更早的消息" }));
      await page.findByText(`History message ${first}`, {}, { timeout: 5_000 });
    }
    assert.deepEqual(beforeBoundaries, [501, 401, 301, 201, 101]);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 600);
    await act(async () => {
      change.resolve(response({ cursor: 1, changed: true, reset: false, team: false, roomIds: [roomA.roomId], runRoomIds: [] }));
      await change.promise;
    });
    await page.findByText("Live message 601", {}, { timeout: 5_000 });
    assert.ok(page.getByText("History message 1"));
    assert.ok(page.getByText("History message 100"));
    assert.ok(page.getByText("History message 600"));
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 601);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    assert.deepEqual(forwardCursors, ["opaque-live-sequence-600"]);
    assert.equal(tailReads, 1);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("reconciliation restores the older cursor after a failed first Room snapshot and preserves loaded history", async () => {
  const dom = installDom(true);
  const originalFetch = globalThis.fetch;
  const change = deferred<Response>();
  const beforeCursors: string[] = [];
  const forwardCursors: string[] = [];
  let changes = 0;
  let runReads = 0;
  let tailReads = 0;
  const historyItems = (first: number) => Array.from({ length: 100 }, (_, index) => {
    const sequence = first + index;
    return message(roomA, sequence, `Recovered history ${sequence}`);
  });
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path.startsWith(`/api/teams/${teamA.teamId}/changes?`)) {
      changes += 1;
      if (changes === 1) return response({ cursor: 1, changed: true, reset: true, team: true, roomIds: [], runRoomIds: [] });
      return changes === 2 ? change.promise : pendingChange(init.signal);
    }
    if (path === `/api/rooms/${roomA.roomId}/runs`) {
      runReads += 1;
      return runReads === 1
        ? response({ error: { message: "Temporary initial Run read failure" } }, 503)
        : response([]);
    }
    if (path.startsWith(`/api/rooms/${roomA.roomId}/messages?`)) {
      const query = new URL(path, "https://team.example.com").searchParams;
      assert.equal(query.get("limit"), "100");
      const before = query.get("beforeCursor");
      if (before) {
        beforeCursors.push(before);
        assert.equal(before, "opaque-recovered-history-101");
        return response({
          items: historyItems(1), nextCursor: null, olderCursor: null,
          syncCursor: "opaque-history-through-100"
        });
      }
      const cursor = query.get("cursor");
      if (cursor) {
        forwardCursors.push(cursor);
        assert.equal(cursor, "opaque-recovered-live-200", "history must not rewind live synchronization");
        return response({
          items: [message(roomA, 201, "Live message after recovered history")],
          nextCursor: null, olderCursor: null, syncCursor: "opaque-recovered-live-201"
        });
      }
      assert.equal(query.get("tail"), "true");
      tailReads += 1;
      return response({
        items: historyItems(101), nextCursor: null,
        olderCursor: "opaque-recovered-history-101", syncCursor: "opaque-recovered-live-200"
      });
    }
    const result = commonResponse(path, [teamA], [roomA]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    fireEvent.click(await page.findByRole("button", { name: "⌁ 对话", exact: true }));
    await page.findByText("Recovered history 101");
    await waitFor(() => assert.equal(changes, 2));
    assert.equal(tailReads, 2, "a new tail snapshot must recover the failed initial batch");
    fireEvent.click(await page.findByRole("button", { name: "加载更早的消息" }));
    await page.findByText("Recovered history 1");
    assert.deepEqual(beforeCursors, ["opaque-recovered-history-101"]);
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 200);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    await act(async () => {
      change.resolve(response({ cursor: 2, changed: true, reset: false, team: true, roomIds: [], runRoomIds: [] }));
      await change.promise;
    });
    await page.findByText("Live message after recovered history");
    assert.ok(page.getByText("Recovered history 1"));
    assert.ok(page.getByText("Recovered history 100"));
    assert.ok(page.getByText("Recovered history 200"));
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 201);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    assert.deepEqual(forwardCursors, ["opaque-recovered-live-200"]);
    assert.equal(tailReads, 2);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a concurrent late tail cannot replace the recovery cursor while an older page is pending", async () => {
  const dom = installDom(true);
  const originalFetch = globalThis.fetch;
  const lateTail = deferred<Response>();
  const firstHistory = deferred<Response>();
  const beforeCursors: string[] = [];
  const forwardCursors: string[] = [];
  let changes = 0;
  let runReads = 0;
  let tailReads = 0;
  const historyPage = (first: number) => ({
    items: Array.from({ length: 100 }, (_, index) => {
      const sequence = first + index;
      return message(roomA, sequence, `Concurrent recovery history ${sequence}`);
    }),
    nextCursor: null,
    olderCursor: first > 1 ? `opaque-concurrent-history-${first}` : null,
    syncCursor: `opaque-concurrent-live-${first + 99}`
  });
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path.startsWith(`/api/teams/${teamA.teamId}/changes?`)) {
      changes += 1;
      return changes === 1
        ? response({ cursor: 1, changed: true, reset: false, team: false, roomIds: [roomA.roomId], runRoomIds: [] })
        : pendingChange(init.signal);
    }
    if (path === `/api/rooms/${roomA.roomId}/runs`) {
      runReads += 1;
      return runReads === 1
        ? response({ error: { message: "Temporary initial Run read failure" } }, 503)
        : response([]);
    }
    if (path.startsWith(`/api/rooms/${roomA.roomId}/messages?`)) {
      const query = new URL(path, "https://team.example.com").searchParams;
      assert.equal(query.get("limit"), "100");
      const before = query.get("beforeCursor");
      if (before) {
        beforeCursors.push(before);
        if (beforeCursors.length === 1) return firstHistory.promise;
        assert.equal(before, beforeCursors.length === 2
          ? "opaque-concurrent-history-201"
          : "opaque-concurrent-history-101");
        return response(historyPage(beforeCursors.length === 2 ? 101 : 1));
      }
      const cursor = query.get("cursor");
      if (cursor) {
        forwardCursors.push(cursor);
        assert.equal(cursor, "opaque-concurrent-live-300", "the late tail and older pages must not rewind live synchronization");
        return response({
          items: [message(roomA, 301, "Live after concurrent history recovery")],
          nextCursor: null, olderCursor: null, syncCursor: "opaque-concurrent-live-301"
        });
      }
      assert.equal(query.get("tail"), "true");
      tailReads += 1;
      return tailReads === 2 ? lateTail.promise : response(historyPage(201));
    }
    const result = commonResponse(path, [teamA], [roomA]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    fireEvent.click(await page.findByRole("button", { name: "⌁ 对话", exact: true }));
    await waitFor(() => assert.equal(tailReads, 2));
    // Room and full refreshes have separate single-flight scopes. Let a
    // visibility refresh restore history before the slower Room read commits.
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    await page.findByText("Concurrent recovery history 201");
    assert.equal(tailReads, 3);
    fireEvent.click(page.getByRole("button", { name: "加载更早的消息" }));
    await waitFor(() => assert.deepEqual(beforeCursors, ["opaque-concurrent-history-201"]));
    await act(async () => {
      lateTail.resolve(response(historyPage(151)));
      await lateTail.promise;
    });
    await waitFor(() => assert.equal(changes, 2));
    assert.equal((page.getByRole("button", { name: "正在加载历史消息…" }) as HTMLButtonElement).disabled, true);
    await act(async () => {
      firstHistory.resolve(response({ error: { message: "Temporary older read failure" } }, 503));
      await firstHistory.promise;
    });
    await page.findByText(/Temporary older read failure/u);
    fireEvent.click(page.getByRole("button", { name: "加载更早的消息" }));
    await page.findByText("Concurrent recovery history 101");
    fireEvent.click(page.getByRole("button", { name: "加载更早的消息" }));
    await page.findByText("Concurrent recovery history 1");
    assert.deepEqual(beforeCursors, [
      "opaque-concurrent-history-201", "opaque-concurrent-history-201", "opaque-concurrent-history-101"
    ]);
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 300);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    await page.findByText("Live after concurrent history recovery");
    assert.deepEqual(forwardCursors, ["opaque-concurrent-live-300"]);
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 301);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    assert.equal(tailReads, 3);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a late successful initial snapshot preserves history loaded after sending a message and does not rewind live sync", async () => {
  const dom = installDom(true);
  const originalFetch = globalThis.fetch;
  const initialOutput = deferred<Response>();
  const change = deferred<Response>();
  const beforeCursors: string[] = [];
  const forwardCursors: string[] = [];
  let taskCreated = false;
  let messageSent = false;
  let outputReads = 0;
  let runReads = 0;
  let tailReads = 0;
  let changes = 0;
  const task: AgentTask = {
    taskId: "task_during_initial_snapshot", roomId: roomA.roomId, parentTaskId: null,
    title: "Work during initial snapshot", goal: "Keep delivered history intact.",
    state: "open", primaryAgentId: null, isDefault: false, updatedAt: now
  };
  const sentMessage = {
    ...message(roomA, 201, "Sent while initial output is pending"), taskId: task.taskId
  };
  const historyMessage = (sequence: number) => sequence === 201
    ? sentMessage
    : message(roomA, sequence, `Initial snapshot history ${sequence}`);
  const initialRun: Run = {
    runId: "run_delayed_initial_snapshot", taskId: historyMessage(200).taskId,
    triggerMessageId: historyMessage(200).messageId, targetAgentId: "agent_delayed_initial_snapshot",
    state: "working", updatedAt: now
  };
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    if (path.startsWith(`/api/runs/${initialRun.runId}/events?`)) {
      outputReads += 1;
      return initialOutput.promise;
    }
    if (path.startsWith(`/api/teams/${teamA.teamId}/changes?`)) {
      changes += 1;
      return changes === 1 ? change.promise : pendingChange(init.signal);
    }
    if (path === `/api/rooms/${roomA.roomId}/runs`) {
      runReads += 1;
      return response(runReads === 1 ? [initialRun] : []);
    }
    if (path === `/api/rooms/${roomA.roomId}/tasks`) {
      if (init.method === "POST") {
        taskCreated = true;
        return response(task);
      }
      return response(taskCreated ? [task] : []);
    }
    if (path === `/api/tasks/${task.taskId}/clarifications`) return response([]);
    if (path === `/api/tasks/${task.taskId}/artifacts`) return response({ artifacts: [], nextCursor: null });
    if (path === `/api/rooms/${roomA.roomId}/messages` && init.method === "POST") {
      messageSent = true;
      return response({ message: sentMessage, runs: [] });
    }
    if (path.startsWith(`/api/rooms/${roomA.roomId}/messages?`)) {
      const query = new URL(path, "https://team.example.com").searchParams;
      assert.equal(query.get("limit"), "100");
      const before = query.get("beforeCursor");
      if (before) {
        beforeCursors.push(before);
        assert.equal(before, "opaque-delayed-history-101",
          "sending must preserve the history boundary initialized by Task creation");
        return response({
          items: Array.from({ length: 100 }, (_, index) => historyMessage(index + 1)),
          nextCursor: null, olderCursor: null, syncCursor: "opaque-delayed-live-100"
        });
      }
      const cursor = query.get("cursor");
      if (cursor) {
        forwardCursors.push(cursor);
        assert.equal(cursor, "opaque-delayed-live-201", "the earlier initial snapshot must not rewind the committed tail");
        return response({
          items: [message(roomA, 202, "Live after delayed initial snapshot")],
          nextCursor: null, olderCursor: null, syncCursor: "opaque-delayed-live-202"
        });
      }
      assert.equal(query.get("tail"), "true");
      tailReads += 1;
      const first = messageSent ? 102 : 101;
      return response({
        items: Array.from({ length: 100 }, (_, index) => historyMessage(first + index)),
        nextCursor: null, olderCursor: `opaque-delayed-history-${first}`,
        syncCursor: `opaque-delayed-live-${first + 99}`
      });
    }
    const result = commonResponse(path, [teamA], [roomA]);
    if (result) return result;
    throw new Error(`Unexpected request: ${path}`);
  };
  const { act, cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await waitFor(() => assert.equal(outputReads, 1));
    fireEvent.click(page.getByRole("button", { name: "⌁ 对话", exact: true }));
    fireEvent.click(page.getByRole("button", { name: "+ 新任务" }));
    const dialog = within(await page.findByRole("dialog", { name: "创建长期任务" }));
    fireEvent.change(dialog.getByLabelText("任务名称"), { target: { value: task.title } });
    fireEvent.change(dialog.getByLabelText("任务目标"), { target: { value: task.goal } });
    fireEvent.click(dialog.getByRole("button", { name: "创建并切换" }));
    await waitFor(() => assert.equal((page.getByLabelText("当前任务") as HTMLSelectElement).value, task.taskId));
    await page.findByText("Initial snapshot history 101");
    assert.equal(tailReads, 2, "Task creation initializes history through its authoritative Room refresh");
    fireEvent.change(page.getByLabelText("消息"), { target: { value: sentMessage.content } });
    fireEvent.click(page.getByRole("button", { name: "发送", exact: true }));
    await page.findByText(sentMessage.content);
    await waitFor(() => assert.equal(tailReads, 3, "sending refreshes the tail while the initial output read remains pending"));
    assert.ok(page.getByText("Initial snapshot history 101"));
    assert.equal(changes, 0);
    fireEvent.click(page.getByRole("button", { name: "加载更早的消息" }));
    await page.findByText("Initial snapshot history 1");
    assert.deepEqual(beforeCursors, ["opaque-delayed-history-101"]);
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 201);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    await act(async () => {
      initialOutput.resolve(response([]));
      await initialOutput.promise;
    });
    await waitFor(() => assert.equal(changes, 1));
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 201,
      "the late initial snapshot must not discard history or the already delivered message");
    assert.ok(page.getByText("Initial snapshot history 1"));
    assert.ok(page.getByText(sentMessage.content));
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    await act(async () => {
      change.resolve(response({ cursor: 1, changed: true, reset: false, team: true, roomIds: [], runRoomIds: [] }));
      await change.promise;
    });
    await page.findByText("Live after delayed initial snapshot");
    assert.deepEqual(forwardCursors, ["opaque-delayed-live-201"]);
    assert.equal(dom.window.document.querySelectorAll(".timeline [data-message-id]").length, 202);
    assert.equal(page.queryByRole("button", { name: "加载更早的消息" }), null);
    assert.equal(tailReads, 3);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});
