import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import React from "react";

import { App } from "../src/App.js";
import { advanceWebSessionGeneration } from "../src/api-client.js";
import { OwnerRecoverySettings } from "../src/features/auth/OwnerRecoverySettings.js";
import { createServerApp } from "../../server/src/app.js";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://owner.example.test/" });
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

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Owner saves a generated key before activation, copies explicitly and clears plaintext after success", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  let copied = "";
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text; } } });
  globalThis.fetch = async (_url, init = {}) => {
    requests.push(init);
    return response({ revision: init.method === "PUT" ? 1 : 0, updatedAt: null });
  };
  const { cleanup, fireEvent, render, within, waitFor } = await import("@testing-library/react");
  try {
    render(<OwnerRecoverySettings locale="zh-CN" />);
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "恢复密钥" }));
    fireEvent.click(await page.findByRole("button", { name: "生成新恢复密钥" }));
    const input = page.getByLabelText("新恢复密钥（尚未确认生效）") as HTMLInputElement;
    const key = input.value;
    assert.match(key, /^[0-9a-f]{64}$/u);
    assert.equal(input.type, "password");
    const confirm = page.getByRole("button", { name: "确认重置" }) as HTMLButtonElement;
    assert.equal(confirm.disabled, true);
    fireEvent.click(confirm);
    assert.equal(requests.filter((request) => request.method === "PUT").length, 0);
    fireEvent.click(page.getByRole("button", { name: "复制密钥" }));
    await page.findByRole("button", { name: "已复制" });
    assert.equal(copied, key);
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(confirm);
    await waitFor(() => assert.match(page.getByRole("status").textContent ?? "", /新恢复密钥已生效/u));
    const request = requests.find((item) => item.method === "PUT")!;
    assert.equal(new Headers(request.headers).get("x-agent-room-recovery-token"), key);
    assert.deepEqual(JSON.parse(String(request.body)), { expectedRevision: 0 });
    assert.equal(request.credentials, "same-origin");
    assert.equal(page.queryByLabelText("新恢复密钥（尚未确认生效）"), null);
    assert.equal(dom.window.document.body.innerHTML.includes(key), false);
    assert.equal(dom.window.localStorage.length, 0);
    assert.equal(dom.window.sessionStorage.length, 0);
    assert.equal(dom.window.location.href, "https://owner.example.test/");
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});

test("uncertain activation retries the same key and revision, never server error details", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  const writes: RequestInit[] = [];
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method !== "PUT") return response({ revision: 3, updatedAt: null });
    writes.push(init);
    if (writes.length === 1) throw new Error("private-provider-secret");
    return response({ revision: 4, updatedAt: null });
  };
  const { cleanup, fireEvent, render, within, waitFor } = await import("@testing-library/react");
  try {
    render(<OwnerRecoverySettings locale="en" />);
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "Recovery key" }));
    fireEvent.click(await page.findByRole("button", { name: "Generate a new recovery key" }));
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Confirm reset" }));
    await page.findByRole("button", { name: "Retry this same key" });
    assert.equal(dom.window.document.body.innerHTML.includes("private-provider-secret"), false);
    assert.equal(page.queryByRole("button", { name: "Generate a new recovery key" }), null);
    fireEvent.click(page.getByRole("button", { name: "Retry this same key" }));
    await waitFor(() => assert.match(page.getByRole("status").textContent ?? "", /new recovery key is active/u));
    assert.deepEqual(writes[0], writes[1]);
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});

test("conflict cannot be bypassed by a failed clipboard copy", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  let writes = 0;
  Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async () => { throw new Error("denied"); } } });
  globalThis.fetch = async (_url, init = {}) => {
    if (init.method !== "PUT") return response({ revision: 0, updatedAt: null });
    writes += 1;
    return response({ error: { message: "private-conflict-details" } }, 409);
  };
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<OwnerRecoverySettings locale="en" />);
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "Recovery key" }));
    fireEvent.click(await page.findByRole("button", { name: "Generate a new recovery key" }));
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Confirm reset" }));
    assert.match((await page.findByRole("alert")).textContent ?? "", /Another operation changed/u);
    fireEvent.click(page.getByRole("button", { name: "Copy key" }));
    await page.findByText(/Clipboard unavailable/u);
    const submit = page.getByRole("button", { name: "Confirm reset" }) as HTMLButtonElement;
    assert.equal(submit.disabled, true);
    fireEvent.click(submit);
    assert.equal(writes, 1);
    assert.equal(dom.window.document.body.textContent?.includes("private-conflict-details"), false);
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});

test("closing clears generated key, traps keyboard focus and restores the trigger", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  globalThis.fetch = async () => response({ revision: 0, updatedAt: null });
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    render(<OwnerRecoverySettings locale="en" />);
    const page = within(dom.window.document.body);
    const trigger = page.getByRole("button", { name: "Recovery key" });
    fireEvent.click(trigger);
    const generate = await page.findByRole("button", { name: "Generate a new recovery key" });
    const close = page.getByRole("button", { name: "Close" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    assert.equal(dom.window.document.activeElement, generate);
    fireEvent.click(generate);
    const key = (page.getByLabelText("New recovery key (activation unconfirmed)") as HTMLInputElement).value;
    fireEvent.keyDown(page.getByRole("dialog"), { key: "Escape" });
    assert.equal(page.queryByRole("dialog"), null);
    assert.equal(dom.window.document.activeElement, trigger);
    assert.equal(dom.window.document.body.innerHTML.includes(key), false);
    fireEvent.click(trigger);
    await page.findByRole("button", { name: "Generate a new recovery key" });
    assert.equal(page.queryByLabelText("New recovery key (activation unconfirmed)"), null);
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});

test("late replacement results cannot restore the key after session disposal", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  let finish!: (response: Response) => void;
  globalThis.fetch = async (_url, init = {}) => init.method === "PUT"
    ? new Promise<Response>((resolve) => { finish = resolve; })
    : response({ revision: 0, updatedAt: null });
  const { act, cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    const rendered = render(<OwnerRecoverySettings locale="en" />);
    const page = within(dom.window.document.body);
    fireEvent.click(page.getByRole("button", { name: "Recovery key" }));
    fireEvent.click(await page.findByRole("button", { name: "Generate a new recovery key" }));
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "Confirm reset" }));
    assert.equal((page.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled, true);
    rendered.unmount();
    advanceWebSessionGeneration();
    await act(async () => { finish(response({ revision: 1, updatedAt: null })); });
    assert.equal(page.queryByRole("dialog"), null);
    assert.equal(dom.window.localStorage.length, 0);
    assert.equal(dom.window.sessionStorage.length, 0);
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});

test("App shows recovery settings only for the authenticated installation Owner, without a Team", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  const { cleanup, fireEvent, render, within } = await import("@testing-library/react");
  try {
    for (const allowed of [false, true]) {
      dom.window.history.replaceState(null, "", "/");
      globalThis.fetch = async (url) => String(url) === "/api/auth/status"
        ? response({ mode: "trusted-team", state: "authenticated",
          user: { userId: "user_install_owner", displayName: "Owner", canManageOwnerRecovery: allowed } })
        : response([]);
      render(<App />);
      const page = within(dom.window.document.body);
      await page.findByRole("heading", { name: "创建你的第一个 Team" });
      assert.equal(page.queryByRole("button", { name: "恢复密钥" }), null);
      fireEvent.click(page.getByRole("button", { name: "打开账户与安全" }));
      assert.equal(Boolean(page.queryByRole("button", { name: "恢复密钥" })), allowed);
      cleanup();
    }
  } finally { cleanup(); globalThis.fetch = original; dom.window.close(); }
});

test("real App and Central replace a key, preserve the Cookie and restore the same Owner after logout", async () => {
  const dom = installDom();
  const original = globalThis.fetch;
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-owner-app-"));
  const origin = dom.window.location.origin;
  const oldKey = "synthetic-owner-app-deployment-root-0123456789";
  const app = await createServerApp({ databasePath: path.join(directory, "server.sqlite"),
    webAuth: { mode: "trusted-team", publicOrigin: origin, ownerRecoveryToken: oldKey } });
  const { cleanup, fireEvent, render, within, waitFor } = await import("@testing-library/react");
  try {
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup",
      headers: { origin, "x-agent-room-recovery-token": oldKey }, payload: { displayName: "Owner" } });
    assert.equal(setup.statusCode, 200);
    const ownerId = setup.json().user.userId;
    let cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const initialCookie = cookie;
    globalThis.fetch = async (url, init = {}) => {
      const result = await app.inject({ method: (init.method ?? "GET") as "GET" | "POST" | "PUT" | "DELETE", url: String(url),
        headers: { ...Object.fromEntries(new Headers(init.headers)), origin, cookie },
        ...(typeof init.body === "string" ? { payload: init.body } : {}) });
      if (result.headers["set-cookie"]) cookie = String(result.headers["set-cookie"]).split(";")[0];
      return new Response(result.body, { status: result.statusCode, headers: { "content-type": "application/json" } });
    };
    render(<App />);
    const page = within(dom.window.document.body);
    fireEvent.click(await page.findByRole("button", { name: "打开账户与安全" }));
    fireEvent.click(await page.findByRole("button", { name: "恢复密钥", exact: true }));
    fireEvent.click(await page.findByRole("button", { name: "生成新恢复密钥" }));
    const key = (page.getByLabelText("新恢复密钥（尚未确认生效）") as HTMLInputElement).value;
    fireEvent.click(page.getByRole("checkbox"));
    fireEvent.click(page.getByRole("button", { name: "确认重置" }));
    await waitFor(() => assert.match(page.getByRole("dialog").textContent ?? "", /新恢复密钥已生效/u));
    assert.equal(cookie, initialCookie);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/recover-owner",
      headers: { origin, "x-agent-room-recovery-token": oldKey } })).statusCode, 401);
    fireEvent.click(page.getByRole("button", { name: "关闭", exact: true }));
    fireEvent.click(page.getAllByRole("button", { name: "退出登录", exact: true })[0]);
    const input = await page.findByLabelText("恢复密钥", { exact: true });
    fireEvent.change(input, { target: { value: key } });
    fireEvent.click(page.getByRole("button", { name: "恢复访问", exact: true }));
    await page.findByRole("button", { name: "恢复密钥", exact: true });
    const status = await app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie } });
    assert.equal(status.json().user.userId, ownerId);
    assert.equal(status.json().user.canManageOwnerRecovery, true);
    assert.equal(dom.window.document.body.innerHTML.includes(key), false);
    assert.equal(JSON.stringify(dom.window.localStorage).includes(key), false);
    assert.equal(JSON.stringify(dom.window.sessionStorage).includes(key), false);
  } finally { cleanup(); globalThis.fetch = original; await app.close(); await rm(directory, { recursive: true, force: true }); dom.window.close(); }
});
