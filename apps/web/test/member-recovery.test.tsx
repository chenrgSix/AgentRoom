import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";
import { AccessGate } from "../src/features/auth/AccessGate.js";
import { TeamMembersWorkspace } from "../src/features/team/TeamMembersWorkspace.js";
import type { Member } from "../src/models.js";

const team = { teamId: "team_recovery", name: "Core", createdAt: "2026-08-31T00:00:00.000Z" };
const owner: Member = {
  memberId: "member_owner", teamId: team.teamId, userId: "user_owner",
  displayName: "Alice", role: "owner", createdAt: team.createdAt
};
const bob: Member = { ...owner, memberId: "member_bob", userId: "user_bob", displayName: "Bob", role: "member" };
const carol: Member = { ...bob, memberId: "member_carol", userId: "user_carol", displayName: "Carol" };
const members = [owner, bob, carol];

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
  return dom;
}

function grant(token: string, member = bob) {
  return {
    recoveryId: "memberrecovery_test", teamId: team.teamId,
    memberId: member.memberId, displayName: member.displayName, token,
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function workspace(currentMember = owner, authMode: "local" | "trusted-team" = "trusted-team") {
  return <TeamMembersWorkspace
    authMode={authMode} currentMember={currentMember} invitationCopied={false}
    locale="zh-CN" memberInvitation={null} memberInviteName="" members={members}
    onCopyInvitation={() => {}} onCreateInvitation={() => {}} onMemberInviteNameChange={() => {}}
    selectedTeam={team} sessionUserId={currentMember.userId} teamBusy={false}
  />;
}

test("member sign-in clears a pasted recovery code before submitting and never stores it", async () => {
  const dom = installDom();
  const code = "member-recovery-only-in-memory";
  let submitted = "";
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<AccessGate
      busy={false} error={null} locale="zh-CN" onClaimInvitation={async () => {}}
      onEnterLocal={async () => {}} onRecoverOwner={async () => {}}
      onRecoverMember={async (value) => { submitted = value; await pending; }}
      onSetupOwner={async () => {}} onToggleLocale={() => {}} onToggleTheme={() => {}}
      state="sign_in_required" theme="dark"
    />);
    const page = within(dom.window.document.body);
    assert.ok(page.getByRole("heading", { name: "回到你的 Team", level: 1 }));
    assert.ok(page.getByRole("heading", { name: "成员重新登录" }));
    assert.match(page.getByRole("form", { name: "成员重新登录" }).textContent ?? "", /不要用新邀请替代原身份/u);
    const input = page.getByLabelText("一次性成员恢复码") as HTMLInputElement;
    assert.equal(input.type, "password");
    fireEvent.change(input, { target: { value: ` ${code} ` } });
    fireEvent.click(page.getByRole("button", { name: "恢复原成员身份" }));
    assert.equal(submitted, code);
    assert.equal(input.value, "");
    assert.equal(dom.window.localStorage.length, 0);
    assert.equal(dom.window.sessionStorage.length, 0);
    assert.equal(dom.window.location.href, "https://team.example.com/");
    await act(async () => { finish(); await pending; });
  } finally { cleanup(); dom.window.close(); }
});

test("only a trusted Owner can explicitly issue, privately copy and revoke a member recovery code", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const code = "single-use-member-secret";
  const requests: Array<{ path: string; init: RequestInit }> = [];
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true, value: { writeText: async (value: string) => { copied = value; } }
  });
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ path: String(input), init });
    return response(init.method === "DELETE" ? { status: "revoked" } : grant(code));
  };
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    const view = render(workspace());
    const page = within(dom.window.document.body);
    assert.equal(page.queryByRole("heading", { name: "帮助成员重新登录" }), null);
    fireEvent.click(page.getByRole("button", { name: "恢复成员访问" }));
    assert.ok(page.getByRole("heading", { name: "帮助成员重新登录" }));
    const select = page.getByLabelText("需要恢复的成员");
    assert.equal(within(select).queryByRole("option", { name: "Alice" }), null);
    fireEvent.change(select, { target: { value: bob.memberId } });
    const create = page.getByRole("button", { name: "生成 15 分钟恢复码" }) as HTMLButtonElement;
    assert.equal(create.disabled, true);
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(create);
    const secret = await page.findByLabelText("一次性成员恢复码") as HTMLInputElement;
    assert.equal(secret.value, code);
    assert.equal(secret.type, "password");
    assert.equal(requests[0]?.path, `/api/teams/${team.teamId}/members/${bob.memberId}/recovery`);
    assert.equal(requests[0]?.init.credentials, "same-origin");
    assert.equal(new Headers(requests[0]?.init.headers).has("authorization"), false);
    fireEvent.click(page.getByRole("button", { name: "复制恢复码" }));
    await page.findByRole("button", { name: "已复制" });
    assert.equal(copied, code);
    assert.equal(dom.window.localStorage.length, 0);
    assert.equal(dom.window.sessionStorage.length, 0);
    assert.equal(dom.window.location.hash, "");
    assert.equal(JSON.stringify(requests).includes(code), false);
    fireEvent.click(page.getByRole("button", { name: "撤销这个恢复码" }));
    await page.findByRole("status");
    assert.equal(page.queryByLabelText("一次性成员恢复码"), null);
    assert.equal(requests[1]?.init.method, "DELETE");
    assert.equal(requests[1]?.path.endsWith("/recovery/memberrecovery_test"), true);
    view.rerender(workspace(bob));
    assert.equal(page.queryByRole("heading", { name: "帮助成员重新登录" }), null);
    view.rerender(workspace(owner, "local"));
    assert.equal(page.queryByRole("heading", { name: "帮助成员重新登录" }), null);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("member recovery drops late issue responses after changing target or Team", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  let resolve!: (value: Response) => void;
  globalThis.fetch = async () => new Promise<Response>((done) => { resolve = done; });
  const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    const view = render(workspace());
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "恢复成员访问" }));
    fireEvent.change(page.getByLabelText("需要恢复的成员"), { target: { value: bob.memberId } });
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "生成 15 分钟恢复码" }));
    fireEvent.change(page.getByLabelText("需要恢复的成员"), { target: { value: carol.memberId } });
    await act(async () => { resolve(response(grant("stale-secret"))); });
    assert.equal(page.queryByLabelText("一次性成员恢复码"), null);
    assert.equal((page.getByRole("checkbox") as HTMLInputElement).checked, false);
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "生成 15 分钟恢复码" }));
    view.rerender(<TeamMembersWorkspace
      authMode="trusted-team" currentMember={{ ...owner, teamId: "team_other" }} invitationCopied={false}
      locale="en" memberInvitation={null} memberInviteName="" members={[]}
      onCopyInvitation={() => {}} onCreateInvitation={() => {}} onMemberInviteNameChange={() => {}}
      selectedTeam={{ ...team, teamId: "team_other" }} sessionUserId={owner.userId} teamBusy={false}
    />);
    await act(async () => { resolve(response(grant("previous-team-secret", carol))); });
    assert.ok(page.getByRole("heading", { name: "Help a member sign in again" }));
    assert.equal(page.queryByLabelText("One-time member recovery code"), null);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("member recovery explains issuance failures without rendering server payloads", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({ error: { message: "raw-secret-provider-detail" } }, 403);
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(workspace());
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "恢复成员访问" }));
    fireEvent.change(page.getByLabelText("需要恢复的成员"), { target: { value: bob.memberId } });
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "生成 15 分钟恢复码" }));
    assert.match((await page.findByRole("alert")).textContent ?? "", /该成员只属于当前 Team/u);
    assert.equal(dom.window.document.body.textContent?.includes("raw-secret-provider-detail"), false);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("App recovers an existing member with Cookie authentication and returns to their Team", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  const code = "existing-bob-recovery-code";
  const requests: Array<{ path: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init = {}) => {
    const route = String(input);
    requests.push({ path: route, init });
    if (route === "/api/auth/status") return response({ mode: "trusted-team", state: "sign_in_required" });
    if (route === "/api/auth/recover-member") return response({
      user: { userId: bob.userId, displayName: bob.displayName }, member: bob,
      session: { expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }
    });
    if (route === "/api/teams") return response([team]);
    if (route === `/api/teams/${team.teamId}/members`) return response(members);
    if (["rooms", "agents", "devices"].some((suffix) => route === `/api/teams/${team.teamId}/${suffix}`)) return response([]);
    throw new Error(`Unexpected request: ${route}`);
  };
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<App />);
    const page = within(dom.window.document.body);
    await page.findByRole("heading", { name: "回到你的 Team" });
    fireEvent.change(page.getByLabelText("一次性成员恢复码"), { target: { value: code } });
    fireEvent.click(page.getByRole("button", { name: "恢复原成员身份" }));
    await page.findByRole("heading", { name: "创建一个对话房间" });
    const claim = requests.find((request) => request.path === "/api/auth/recover-member");
    assert.equal(claim?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(claim?.init.body)), { token: code });
    assert.equal(claim?.init.credentials, "same-origin");
    assert.equal(new Headers(claim?.init.headers).has("authorization"), false);
    assert.equal(requests.some((request) => request.path.includes("member-invitations")), false);
    assert.equal(dom.window.location.href, "https://team.example.com/");
    assert.equal(JSON.stringify(dom.window.localStorage).includes(code), false);
    assert.equal(JSON.stringify(dom.window.sessionStorage).includes(code), false);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});

test("expired recovery codes disappear from the member management page", async () => {
  const dom = installDom();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({ ...grant("expired-secret"), expiresAt: "2020-01-01T00:00:00.000Z" });
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(workspace());
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "恢复成员访问" }));
    fireEvent.change(page.getByLabelText("需要恢复的成员"), { target: { value: bob.memberId } });
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "生成 15 分钟恢复码" }));
    assert.match((await page.findByRole("status")).textContent ?? "", /恢复码已过期/u);
    assert.equal(page.queryByLabelText("一次性成员恢复码"), null);
  } finally { cleanup(); globalThis.fetch = originalFetch; dom.window.close(); }
});
