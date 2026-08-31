import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";

interface RequestRecord {
  body?: string;
  credentials?: RequestCredentials;
  headers?: HeadersInit;
  method: string;
  path: string;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function installDom(url: string): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: dom.window.document },
    HTMLElement: { configurable: true, value: dom.window.HTMLElement },
    localStorage: { configurable: true, value: dom.window.localStorage },
    navigator: { configurable: true, value: dom.window.navigator },
    window: { configurable: true, value: dom.window }
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true
  });
  return dom;
}

function recordRequest(
  requests: RequestRecord[],
  input: RequestInfo | URL,
  init: RequestInit
): RequestRecord {
  const record: RequestRecord = {
    ...(typeof init.body === "string" ? { body: init.body } : {}),
    ...(init.credentials ? { credentials: init.credentials } : {}),
    ...(init.headers ? { headers: init.headers } : {}),
    method: init.method ?? "GET",
    path: typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  };
  requests.push(record);
  return record;
}

test("trusted-team first setup keeps recovery material component-local", async () => {
  const dom = installDom("https://team.example.com/");
  const requests: RequestRecord[] = [];
  let resolveSetup!: (response: Response) => void;
  const pendingSetup = new Promise<Response>((resolve) => {
    resolveSetup = resolve;
  });

  globalThis.fetch = async (input, init = {}) => {
    const request = recordRequest(requests, input, init);
    if (request.path === "/api/auth/status") {
      return jsonResponse({ mode: "trusted-team", state: "setup_required" });
    }
    if (request.path === "/api/auth/setup") return pendingSetup;
    if (request.path === "/api/teams") return jsonResponse([]);
    throw new Error(`Unexpected request: ${request.method} ${request.path}`);
  };

  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: "设置 Team Owner" });
    fireEvent.click(page.getByRole("button", { name: "界面语言" }));
    await page.findByRole("heading", { name: "Set up the Team Owner" });
    fireEvent.click(page.getByRole("button", { name: "Interface language" }));
    await page.findByRole("heading", { name: "设置 Team Owner" });
    const name = page.getByLabelText("Owner 显示名称");
    const recovery = page.getByLabelText("恢复密钥") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Alice" } });
    fireEvent.change(recovery, { target: { value: "recovery-secret-1234567890" } });
    fireEvent.click(page.getByRole("button", { name: "完成首次设置" }));

    await waitFor(() => {
      assert.ok(requests.some(({ path }) => path === "/api/auth/setup"));
    });
    assert.equal(recovery.value, "");
    const setupRequest = requests.find(({ path }) => path === "/api/auth/setup");
    assert.deepEqual(JSON.parse(setupRequest?.body ?? "{}"), { displayName: "Alice" });
    assert.equal(
      new Headers(setupRequest?.headers).get("x-agent-room-recovery-token"),
      "recovery-secret-1234567890"
    );
    assert.equal(setupRequest?.credentials, "same-origin");

    resolveSetup(jsonResponse({
      user: { userId: "user_owner12345678", displayName: "Alice" },
      session: { expiresAt: "2026-09-22T00:00:00.000Z" }
    }));
    await page.findByRole("heading", { name: "创建你的第一个 Team" });
    const teamsRequest = requests.find(({ path }) => path === "/api/teams");
    assert.equal(new Headers(teamsRequest?.headers).has("authorization"), false);
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("member invitation fragment is cleared before explicit claim", async () => {
  const invitationToken = "InviteToken_1234567890abcdef";
  const dom = installDom(`https://team.example.com/#/join/${invitationToken}`);
  const requests: RequestRecord[] = [];
  const team = {
    teamId: "team_trusted_auth",
    name: "Trusted Team",
    createdAt: "2026-08-23T00:00:00.000Z"
  };
  const member = {
    memberId: "member_trusted_bob",
    teamId: team.teamId,
    userId: "user_member12345678",
    displayName: "Bob",
    role: "member",
    createdAt: "2026-08-23T00:00:00.000Z"
  };

  globalThis.fetch = async (input, init = {}) => {
    const request = recordRequest(requests, input, init);
    if (request.path === "/api/auth/status") {
      return jsonResponse({ mode: "trusted-team", state: "sign_in_required" });
    }
    if (request.path === "/api/auth/member-invitations/claim") {
      return jsonResponse({
        user: { userId: member.userId, displayName: member.displayName },
        member,
        session: { expiresAt: "2026-09-22T00:00:00.000Z" }
      });
    }
    if (request.path === "/api/teams") return jsonResponse([team]);
    if (request.path === `/api/teams/${team.teamId}/members`) return jsonResponse([member]);
    if (request.path === `/api/teams/${team.teamId}/rooms`) return jsonResponse([]);
    if (request.path === `/api/teams/${team.teamId}/agents`) return jsonResponse([]);
    if (request.path === `/api/teams/${team.teamId}/devices`) return jsonResponse([]);
    throw new Error(`Unexpected request: ${request.method} ${request.path}`);
  };

  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    assert.equal(dom.window.location.hash, "");
    await page.findByRole("heading", { name: "你收到了一份 Team 邀请" });
    assert.equal(
      requests.some(({ path }) => path === "/api/auth/member-invitations/claim"),
      false
    );

    fireEvent.click(page.getByRole("button", { name: "加入 Team" }));
    await page.findByRole("heading", { name: "创建一个对话房间" });
    const claimRequest = requests.find(({ path }) =>
      path === "/api/auth/member-invitations/claim"
    );
    assert.deepEqual(JSON.parse(claimRequest?.body ?? "{}"), { token: invitationToken });
    assert.equal(claimRequest?.credentials, "same-origin");
    assert.equal(new Headers(claimRequest?.headers).has("authorization"), false);
    await waitFor(() => assert.equal(dom.window.location.href, "https://team.example.com/"));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("Owner creates and copies a member invite, then signs out and recovers", async () => {
  const dom = installDom("https://team.example.com/");
  const requests: RequestRecord[] = [];
  let copiedText = "";
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        copiedText = value;
      }
    }
  });
  const owner = { userId: "user_owner12345678", displayName: "Alice" };
  const team = {
    teamId: "team_trusted_auth",
    name: "Trusted Team",
    createdAt: "2026-08-23T00:00:00.000Z"
  };
  const ownerMember = {
    memberId: "member_trusted_owner",
    teamId: team.teamId,
    userId: owner.userId,
    displayName: owner.displayName,
    role: "owner",
    createdAt: "2026-08-23T00:00:00.000Z"
  };
  const claimUrl = "https://team.example.com/#/join/MemberToken_1234567890abcdef";

  globalThis.fetch = async (input, init = {}) => {
    const request = recordRequest(requests, input, init);
    if (request.path === "/api/auth/status") {
      return jsonResponse({
        mode: "trusted-team",
        state: "authenticated",
        user: owner,
        session: { expiresAt: "2026-09-22T00:00:00.000Z" }
      });
    }
    if (request.path === "/api/auth/recover-owner") {
      return jsonResponse({
        user: owner,
        session: { expiresAt: "2026-09-22T00:00:00.000Z" }
      });
    }
    if (request.path === "/api/auth/session" && request.method === "DELETE") {
      return jsonResponse({ status: "signed_out" });
    }
    if (
      request.path === `/api/teams/${team.teamId}/member-invitations` &&
      request.method === "POST"
    ) {
      return jsonResponse({
        invitationId: "invite_test",
        teamId: team.teamId,
        displayName: "Bob",
        expiresAt: "2026-08-24T00:00:00.000Z",
        claimUrl
      });
    }
    if (request.path === "/api/teams") return jsonResponse([team]);
    if (request.path === `/api/teams/${team.teamId}/members`) return jsonResponse([ownerMember]);
    if (request.path === `/api/teams/${team.teamId}/rooms`) return jsonResponse([]);
    if (request.path === `/api/teams/${team.teamId}/agents`) return jsonResponse([]);
    if (request.path === `/api/teams/${team.teamId}/devices`) return jsonResponse([]);
    throw new Error(`Unexpected request: ${request.method} ${request.path}`);
  };

  const { cleanup, fireEvent, render, waitFor, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: "创建一个对话房间" });
    fireEvent.click(page.getByRole("button", { name: "管理", exact: true }));
    fireEvent.click(page.getByRole("button", { name: "团队与成员" }));
    fireEvent.click(page.getByRole("button", { name: "邀请 Team 成员" }));
    fireEvent.change(page.getByLabelText("成员显示名称"), { target: { value: "Bob" } });
    fireEvent.click(page.getByRole("button", { name: "创建 24 小时邀请" }));
    const link = await page.findByLabelText("成员邀请链接") as HTMLInputElement;
    assert.equal(link.value, claimUrl);
    const invitationRequest = requests.find(({ path, method }) =>
      path === `/api/teams/${team.teamId}/member-invitations` && method === "POST"
    );
    assert.deepEqual(JSON.parse(invitationRequest?.body ?? "{}"), { displayName: "Bob" });
    assert.equal(invitationRequest?.credentials, "same-origin");
    assert.equal(new Headers(invitationRequest?.headers).has("authorization"), false);

    fireEvent.click(page.getByRole("button", { name: "复制链接" }));
    await page.findByRole("button", { name: "已复制" });
    assert.equal(copiedText, claimUrl);

    fireEvent.click(page.getByRole("button", { name: "关闭", exact: true }));
    fireEvent.click(page.getAllByRole("button", { name: "退出登录" })[0]!);
    await page.findByRole("heading", { name: "恢复 Owner 会话" });
    const logoutRequest = requests.find(({ path, method }) =>
      path === "/api/auth/session" && method === "DELETE"
    );
    assert.equal(logoutRequest?.credentials, "same-origin");
    assert.equal(new Headers(logoutRequest?.headers).has("authorization"), false);

    const recovery = page.getByLabelText("恢复密钥") as HTMLInputElement;
    fireEvent.change(recovery, { target: { value: "owner-recovery-secret" } });
    fireEvent.click(page.getByRole("button", { name: "恢复访问" }));
    await waitFor(() => {
      const request = requests.find(({ path }) => path === "/api/auth/recover-owner");
      assert.equal(
        new Headers(request?.headers).get("x-agent-room-recovery-token"),
        "owner-recovery-secret"
      );
    });
    assert.equal(recovery.value, "");
    await page.findByRole("heading", { name: "团队与成员" });
  } finally {
    cleanup();
    dom.window.close();
  }
});
