import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";
import {
  advanceWebSessionGeneration,
  jsonRequest,
  StaleWebSessionError,
  webSessionExpiredEvent
} from "../src/api-client.js";

const user = { userId: "user_existing_member", displayName: "Bob" };
const team = { teamId: "team_session_test", name: "Existing Team", createdAt: "2026-08-31T00:00:00.000Z" };
const member = {
  memberId: "member_session_test", teamId: team.teamId, userId: user.userId,
  displayName: user.displayName, role: "member", createdAt: team.createdAt
};
const room = {
  roomId: "room_session_test", teamId: team.teamId, name: "general",
  settingsRevision: 1, createdAt: team.createdAt,
  collaborationPolicy: { allowDiscussion: true, allowAll: true, allowAgentMentions: true, maxAgentMentionDepth: 4 }
};

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://team.example.com/" });
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

function failure(status: number) {
  return response({ error: { message: status === 401 ? "Invalid web session" : "Room access denied" } }, status);
}

function authenticatedMock() {
  const requests: Array<{ path: string; method: string; credentials?: RequestCredentials }> = [];
  let workStatus = 200;
  let logoutStatus = 200;
  let resolvePrevious!: (value: Response) => void;
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    const method = init.method ?? "GET";
    requests.push({ path, method, ...(init.credentials ? { credentials: init.credentials } : {}) });
    if (path === "/api/test/previous-session") return new Promise<Response>((resolve) => { resolvePrevious = resolve; });
    if (path === "/api/auth/status") return response({
      mode: "trusted-team", state: "authenticated", user,
      session: { expiresAt: "2099-09-30T00:00:00.000Z" }
    });
    if (path === "/api/auth/session" && method === "DELETE") {
      return logoutStatus === 200 ? response({ status: "signed_out" }) : failure(logoutStatus);
    }
    if (path === "/api/teams") return response([team]);
    if (path === `/api/teams/${team.teamId}/members`) return response([member]);
    if (path === `/api/teams/${team.teamId}/rooms`) return response([room]);
    if (["agents", "devices"].some((suffix) => path === `/api/teams/${team.teamId}/${suffix}`)) return response([]);
    if (path.startsWith(`/api/teams/${team.teamId}/work-items?`)) {
      return workStatus === 200 ? response({ items: [], nextCursor: null }) : failure(workStatus);
    }
    if (path.startsWith(`/api/rooms/${room.roomId}/messages?`)) {
      return response({ items: [], nextCursor: null, olderCursor: null, syncCursor: "cursor_session_test" });
    }
    if (path === `/api/rooms/${room.roomId}/settings`) return response({
      room, participants: { memberIds: [member.memberId], agentIds: [] }
    });
    if (["runs", "discussions", "tasks", "memory-candidates"].some((suffix) => path === `/api/rooms/${room.roomId}/${suffix}`)) return response([]);
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return {
    requests,
    workStatus(value: number) { workStatus = value; },
    logoutStatus(value: number) { logoutStatus = value; },
    resolvePrevious(value: Response) { resolvePrevious(value); }
  };
}

for (const mode of ["trusted-team", "local"] as const) {
  test(`a fast first Team-list 401 after ${mode} status restoration reaches the correct access gate`, async () => {
    const dom = installDom();
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    let expiredEvents = 0;
    dom.window.addEventListener(webSessionExpiredEvent, () => { expiredEvents += 1; });
    globalThis.fetch = async (input) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/auth/status") return response({ mode, state: "authenticated", user });
      // Resolve immediately: the session effect from the loading render still
      // has a null session when this first protected request completes.
      if (path === "/api/teams") return failure(401);
      throw new Error(`Unexpected request: ${path}`);
    };
    const { cleanup, render, within } = await import("@testing-library/react");
    try {
      render(<App />);
      const page = within(dom.window.document.body);
      await page.findByRole("heading", { name: mode === "local" ? "本地模式" : "回到你的 Team" });
      assert.equal(expiredEvents, 1);
      assert.deepEqual(paths, ["/api/auth/status", "/api/teams"]);
      assert.equal(page.queryByRole("heading", { name: "创建你的第一个 Team" }), null);
      assert.equal(page.queryByRole("button", { name: "退出登录", exact: true }), null);
      if (mode === "local") {
        assert.ok(page.getByRole("button", { name: "进入本地工作区" }));
        assert.equal(page.queryByRole("heading", { name: "成员重新登录" }), null);
      } else {
        assert.ok(page.getByRole("heading", { name: "成员重新登录" }));
        assert.equal(page.queryByRole("button", { name: "进入本地工作区" }), null);
      }
    } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
  });
}

for (const recovery of ["member", "owner"] as const) {
  test(`a fast first Team-list 401 after ${recovery} recovery does not leave a false authenticated workspace`, async () => {
    const dom = installDom();
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    let expiredEvents = 0;
    dom.window.addEventListener(webSessionExpiredEvent, () => { expiredEvents += 1; });
    globalThis.fetch = async (input) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/auth/status") return response({ mode: "trusted-team", state: "sign_in_required" });
      if (path === `/api/auth/recover-${recovery}`) return response({ user });
      if (path === "/api/teams") return failure(401);
      throw new Error(`Unexpected request: ${path}`);
    };
    const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
    try {
      render(<App />);
      const page = within(dom.window.document.body);
      await page.findByRole("heading", { name: "回到你的 Team" });
      fireEvent.change(page.getByLabelText(recovery === "member" ? "一次性成员恢复码" : "恢复密钥"), {
        target: { value: "synthetic-recovery-code" }
      });
      await act(async () => {
        fireEvent.click(page.getByRole("button", {
          name: recovery === "member" ? "恢复原成员身份" : "恢复访问", exact: true
        }));
      });
      await page.findByRole("heading", { name: "回到你的 Team" });
      assert.equal(expiredEvents, 1);
      assert.deepEqual(paths, ["/api/auth/status", `/api/auth/recover-${recovery}`, "/api/teams"]);
      assert.equal(page.queryByRole("heading", { name: "创建你的第一个 Team" }), null);
      assert.equal(page.queryByRole("button", { name: "退出登录", exact: true }), null);
      assert.equal((page.getByLabelText("一次性成员恢复码") as HTMLInputElement).value, "");
      assert.equal((page.getByLabelText("恢复密钥") as HTMLInputElement).value, "");
    } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
  });
}

test("a fast first Team-list 401 after local bootstrap returns to local entry without starting another bootstrap", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  let expiredEvents = 0;
  dom.window.addEventListener(webSessionExpiredEvent, () => { expiredEvents += 1; });
  globalThis.fetch = async (input, init = {}) => {
    const path = String(input);
    paths.push(path);
    if (path === "/api/auth/status") return response({ mode: "local", state: "local_bootstrap" });
    if (path === "/api/bootstrap") return response({ user, session: { token: "synthetic-local-session" } });
    if (path === "/api/teams") {
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-local-session");
      return failure(401);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const { cleanup, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await waitFor(() => assert.equal(expiredEvents, 1));
    await page.findByRole("heading", { name: "本地模式" });
    assert.ok(page.getByRole("button", { name: "进入本地工作区" }));
    assert.equal(page.queryByRole("heading", { name: "成员重新登录" }), null);
    assert.equal(page.queryByRole("button", { name: "退出登录", exact: true }), null);
    assert.deepEqual(paths, ["/api/auth/status", "/api/bootstrap", "/api/teams"]);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("an expired Cookie on a protected GET returns App to existing-member recovery", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const mock = authenticatedMock();
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    const refresh = await page.findByRole("button", { name: "刷新", exact: true });
    mock.workStatus(401);
    fireEvent.click(refresh);
    await page.findByRole("heading", { name: "回到你的 Team" });
    assert.ok(page.getByRole("heading", { name: "成员重新登录" }));
    assert.ok(page.getByLabelText("一次性成员恢复码"));
    assert.equal(page.queryByRole("heading", { name: "从工作开始，而不是从聊天记录开始" }), null);
    const calls = mock.requests.filter((request) => request.path.includes("/work-items?"));
    assert.ok(calls.length >= 2);
    assert.equal(calls.at(-1)?.credentials, "same-origin");
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("signing out with an already-revoked Cookie still reaches member recovery", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const mock = authenticatedMock();
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await page.findByRole("button", { name: "刷新", exact: true });
    mock.logoutStatus(401);
    fireEvent.click(page.getAllByRole("button", { name: "退出登录", exact: true })[0]!);
    await page.findByRole("heading", { name: "回到你的 Team" });
    assert.ok(page.getByRole("heading", { name: "成员重新登录" }));
    assert.ok(mock.requests.some((request) => request.path === "/api/auth/session" && request.method === "DELETE"));
    assert.equal((page.getByRole("button", { name: "恢复原成员身份" }) as HTMLButtonElement).disabled, true);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a protected 403 reports denied access without signing out the current member", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const mock = authenticatedMock();
  let expiredEvents = 0;
  dom.window.addEventListener(webSessionExpiredEvent, () => { expiredEvents += 1; });
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    const refresh = await page.findByRole("button", { name: "刷新", exact: true });
    mock.workStatus(403);
    fireEvent.click(refresh);
    assert.match((await page.findByRole("alert")).textContent ?? "", /Room access denied/u);
    assert.ok(page.getByRole("heading", { name: "从工作开始，而不是从聊天记录开始" }));
    assert.equal(page.queryByRole("heading", { name: "回到你的 Team" }), null);
    assert.equal(expiredEvents, 0);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("wrong Owner and member recovery codes do not emit global session-expiry events", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  let expiredEvents = 0;
  dom.window.addEventListener(webSessionExpiredEvent, () => { expiredEvents += 1; });
  globalThis.fetch = async (input) => {
    const path = String(input);
    paths.push(path);
    if (path === "/api/auth/status") return response({ mode: "trusted-team", state: "sign_in_required" });
    if (path === "/api/auth/recover-owner" || path === "/api/auth/recover-member") {
      return response({ error: { message: "Invalid recovery code" } }, 401);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: "回到你的 Team" });
    const memberCode = page.getByLabelText("一次性成员恢复码") as HTMLInputElement;
    fireEvent.change(memberCode, { target: { value: "wrong-member-code" } });
    fireEvent.click(page.getByRole("button", { name: "恢复原成员身份" }));
    await page.findByRole("alert");
    assert.equal(memberCode.value, "");
    const ownerCode = page.getByLabelText("恢复密钥") as HTMLInputElement;
    fireEvent.change(ownerCode, { target: { value: "wrong-owner-code" } });
    fireEvent.click(page.getByRole("button", { name: "恢复访问", exact: true }));
    await waitFor(() => assert.ok(paths.includes("/api/auth/recover-owner")));
    await page.findByRole("alert");
    assert.equal(ownerCode.value, "");
    assert.ok(paths.includes("/api/auth/recover-member"));
    assert.equal(expiredEvents, 0);
    assert.ok(page.getByRole("heading", { name: "成员重新登录" }));
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("a late 401 from an older session generation cannot sign out the new session", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const mock = authenticatedMock();
  let expiredEvents = 0;
  dom.window.addEventListener(webSessionExpiredEvent, () => { expiredEvents += 1; });
  const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await page.findByRole("button", { name: "刷新", exact: true });
    const previousRequest = jsonRequest("/api/test/previous-session").catch((reason: unknown) => reason);
    // Successful activation advances this generation before loading new Team data.
    advanceWebSessionGeneration();
    let error: unknown;
    await act(async () => {
      mock.resolvePrevious(failure(401));
      error = await previousRequest;
    });
    assert.ok(error instanceof StaleWebSessionError);
    assert.equal(error.name, "AbortError");
    assert.equal(expiredEvents, 0);
    assert.equal(page.queryByRole("heading", { name: "回到你的 Team" }), null);
    assert.ok(page.getByRole("heading", { name: "从工作开始，而不是从聊天记录开始" }));
    // Current-generation failures still invalidate the session normally.
    mock.workStatus(401);
    fireEvent.click(page.getByRole("button", { name: "刷新", exact: true }));
    await page.findByRole("heading", { name: "回到你的 Team" });
    assert.equal(expiredEvents, 1);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("protected stale HTTP results and failures never expose previous-session data", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let expiredEvents = 0;
  dom.window.addEventListener(webSessionExpiredEvent, () => { expiredEvents += 1; });
  try {
    for (const kind of ["success", "unauthorized", "forbidden", "network", "invalid-json"] as const) {
      let resolve!: (value: Response) => void;
      let reject!: (reason: unknown) => void;
      globalThis.fetch = () => new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
      const pending = jsonRequest("/api/teams/previous-session/manual-agents").catch((reason: unknown) => reason);
      advanceWebSessionGeneration();
      const secret = `previous-session-secret-${kind}`;
      if (kind === "network") reject(new Error(secret));
      else if (kind === "invalid-json") resolve(new Response(secret));
      else resolve(response({ credential: { token: secret }, error: { message: secret } },
        kind === "unauthorized" ? 401 : kind === "forbidden" ? 403 : 200));
      const result: unknown = await pending;
      assert.ok(result instanceof StaleWebSessionError, kind);
      assert.equal(result.name, "AbortError");
      assert.equal(String(result).includes(secret), false);
      assert.equal(result.stack?.includes(secret), false);
    }
    assert.equal(expiredEvents, 0);
  } finally { globalThis.fetch = originalFetch; dom.window.close(); }
});

test("generation isolation is rechecked after a delayed JSON body resolves or rejects", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let expiredEvents = 0;
  dom.window.addEventListener(webSessionExpiredEvent, () => { expiredEvents += 1; });
  try {
    for (const kind of ["success", "unauthorized", "forbidden", "parse-error"] as const) {
      let resolve!: (value: unknown) => void;
      let reject!: (reason: unknown) => void;
      let parsing!: () => void;
      const started = new Promise<void>((done) => { parsing = done; });
      const body = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
      const delayed = response({}, kind === "unauthorized" ? 401 : kind === "forbidden" ? 403 : 200);
      Object.defineProperty(delayed, "json", { value: () => { parsing(); return body; } });
      globalThis.fetch = async () => delayed;
      const pending = jsonRequest("/api/teams/previous-session/manual-agents").catch((reason: unknown) => reason);
      await started;
      advanceWebSessionGeneration();
      const secret = `previous-body-secret-${kind}`;
      if (kind === "parse-error") reject(new SyntaxError(secret));
      else resolve({ credential: { token: secret }, error: { message: secret } });
      const result: unknown = await pending;
      assert.ok(result instanceof StaleWebSessionError, kind);
      assert.equal(result.name, "AbortError");
      assert.equal(String(result).includes(secret), false);
      assert.equal(result.stack?.includes(secret), false);
    }
    assert.equal(expiredEvents, 0);
    // Current-session parse and network errors are not swallowed or relabeled.
    globalThis.fetch = async () => new Response("invalid-current-json");
    await assert.rejects(jsonRequest("/api/teams"), SyntaxError);
    const networkError = new Error("current network failed");
    globalThis.fetch = async () => { throw networkError; };
    await assert.rejects(jsonRequest("/api/teams"), (reason: unknown) => reason === networkError);
  } finally { globalThis.fetch = originalFetch; dom.window.close(); }
});
