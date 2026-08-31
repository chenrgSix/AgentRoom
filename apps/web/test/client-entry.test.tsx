import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import Database from "better-sqlite3";
import { createServerApp } from "../../server/src/app.js";
import { CoreRepository } from "../../server/src/data/core-repository.js";
import { App } from "../src/App.js";
import { clientEntryFromFragment } from "../src/features/auth/ClientEntryGate.js";
import { advanceWebSessionGeneration, webSessionExpiredEvent } from "../src/api-client.js";

const secret = () => randomBytes(32).toString("base64url");
const operation = () => `op_${randomBytes(12).toString("hex")}`;
const origin = "https://client-entry.example";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-client-entry-web-"));
  const app = await createServerApp({ databasePath: path.join(directory, "central.sqlite"), webAuth: {
    mode: "trusted-team", publicOrigin: origin, ownerRecoveryToken: "r".repeat(48)
  }});
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup", headers: { origin, "x-agent-room-recovery-token": "r".repeat(48) }, payload: { displayName: "Original Owner" } });
  assert.equal(setup.statusCode, 200, setup.body);
  const ownerCookie = String(setup.headers["set-cookie"]).split(";")[0]!;
  let cookie = ownerCookie;
  const headers = { origin, cookie: ownerCookie };
  const team = (await app.inject({ method: "POST", url: "/api/teams", headers, payload: { name: "Client collaboration" } })).json();
  const teamId = team.team.teamId as string;
  const room = (await app.inject({ method: "POST", url: `/api/teams/${teamId}/rooms`, headers, payload: { name: "Shared room" } })).json();
  const claimSecret = secret(), pollSecret = secret(), clientAccessSecret = secret();
  const created = (await app.inject({ method: "POST", url: `/api/teams/${teamId}/device-pairing-sessions`, headers,
    payload: { operationId: operation(), claimSecret, memberBinding: { displayName: "Actual client owner", roomIds: [room.roomId] } } })).json();
  const pairingSessionId = created.pairingSessionId as string, pairingAttemptId = `pairattempt_${randomBytes(12).toString("hex")}`;
  const claim = await app.inject({ method: "POST", url: `/api/device-pairing-sessions/${pairingSessionId}/claim`, payload: {
    pairingSessionId, pairingAttemptId, operationId: operation(), claimSecret, pollSecret, clientAccessSecret,
    device: { displayName: "Client laptop", platform: "darwin-arm64", bridgeVersion: "0.4.2" }
  }}); assert.equal(claim.statusCode, 200, claim.body);
  const approved = await app.inject({ method: "POST", url: `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}/approve`, headers, payload: { operationId: operation(), expectedState: "claimed" } });
  assert.equal(approved.statusCode, 200, approved.body);
  const consumed = (await app.inject({ method: "POST", url: `/api/device-pairing-sessions/${pairingSessionId}/poll`, payload: { pairingSessionId, pairingAttemptId, pollSecret } })).json();
  const issued = await app.inject({ method: "POST", url: "/api/client-access/tickets", headers: { authorization: `Bearer ${pollSecret}` }, payload: { clientAccessSecret, roomId: room.roomId } });
  assert.equal(issued.statusCode, 200, issued.body);
  const ticket = issued.json().ticket as string;
  const descriptors = Object.getOwnPropertyDescriptors(globalThis), originalFetch = globalThis.fetch;
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `${origin}/#clientEntry=${ticket}` });
  for (const key of ["document", "HTMLElement", "localStorage", "sessionStorage", "navigator", "window"] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });
  advanceWebSessionGeneration();
  const calls: string[] = [];
  const pending = new Set<Promise<Response>>();
  const pollCancels = new Set<() => void>();
  const dispatch: typeof fetch = async (input, init = {}) => {
    const url = String(input); calls.push(url);
    if (url.includes("/changes?")) return new Promise<Response>((_resolve, reject) => {
      if (init.signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      const cancel = () => { pollCancels.delete(cancel); reject(new DOMException("Aborted", "AbortError")); };
      pollCancels.add(cancel);
      init.signal?.addEventListener("abort", cancel, { once: true });
    });
    const response = await app.inject({ method: (init.method ?? "GET") as "GET" | "POST", url,
      headers: { ...Object.fromEntries(new Headers(init.headers).entries()), origin, cookie },
      ...(init.body ? { payload: String(init.body) } : {}) });
    if (response.headers["set-cookie"]) cookie = String(response.headers["set-cookie"]).split(";")[0]!;
    return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = (input, init) => {
    const request = dispatch(input, init); pending.add(request);
    void request.then(() => pending.delete(request), () => pending.delete(request)); return request;
  };
  const { render, cleanup, within, fireEvent, waitFor, act } = await import("@testing-library/react");
  t.after(async () => {
    await act(async () => {
      cleanup();
      while (pending.size) {
        for (const cancel of pollCancels) cancel();
        await Promise.allSettled([...pending]);
      }
    });
    await act(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); });
    await app.close(); globalThis.fetch = originalFetch; dom.window.close();
    for (const key of ["document", "HTMLElement", "localStorage", "sessionStorage", "navigator", "window", "IS_REACT_ACT_ENVIRONMENT"]) {
      const descriptor = descriptors[key]; if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { app, ticket, calls, headers, ownerCookie, cookie: () => cookie, teamId, roomId: room.roomId as string, deviceId: consumed.deviceId as string,
    memberId: consumed.ownerMemberId as string,
    seedUninvitedAgent() {
      const db = new Database(path.join(directory, "central.sqlite"));
      try {
        const repo = new CoreRepository(db), now = new Date().toISOString();
        repo.createAgent({ agentId: "agent_clientbuilder123", teamId, ownerMemberId: consumed.ownerMemberId as string, deviceId: consumed.deviceId as string,
          name: "Client Builder", role: "Builder", integrationMode: "managed", capabilities: { supportsStart: true, supportsResume: false, supportsInterrupt: false, supportsStreaming: false },
          enabled: true, presence: "offline", createdAt: now, updatedAt: now });
        db.prepare("DELETE FROM room_human_participants WHERE room_id = ? AND member_id = ?").run(room.roomId, consumed.ownerMemberId);
        db.prepare("DELETE FROM room_agent_participants WHERE room_id = ? AND agent_id = ?").run(room.roomId, "agent_clientbuilder123");
      } finally { db.close(); }
      window.history.replaceState(null, "", `/?team=${teamId}&room=${room.roomId}&view=room`);
    },
    mount() { return within(render(<React.StrictMode><App /></React.StrictMode>).container); }, fireEvent, waitFor };
}

test("client fragment rejects duplicate or mixed parameters", () => {
  const proof = "t".repeat(43);
  assert.equal(clientEntryFromFragment(`#clientEntry=${proof}`), proof);
  assert.equal(clientEntryFromFragment(`#other=1&clientEntry=${proof}`), "");
  assert.equal(clientEntryFromFragment(`#clientEntry=${proof}&clientEntry=${proof}`), "");
  assert.equal(clientEntryFromFragment("#clientEntry=bad"), "");
  assert.equal(clientEntryFromFragment("#/join/ordinary-invitation"), null);
});

test("real client entry confirms once, replaces identity and opens its authorized Room", async (t) => {
  const f = await fixture(t), screen = f.mount();
  await screen.findByText(/Actual client owner/u);
  assert.equal(window.location.hash, "");
  assert.equal(f.calls.includes("/api/auth/client-entry/claim"), false);
  assert.equal(f.cookie(), f.ownerCookie);
  const button = screen.getByRole("button", { name: "确认并进入" });
  f.fireEvent.click(button); f.fireEvent.click(button);
  await screen.findByRole("textbox", { name: "消息" });
  assert.equal(f.calls.filter((url) => url === "/api/auth/client-entry/claim").length, 1);
  assert.equal(new URLSearchParams(window.location.search).get("team"), f.teamId);
  assert.equal(new URLSearchParams(window.location.search).get("room"), f.roomId);
  assert.equal(f.calls.includes("/api/bootstrap"), false);
  assert.equal(screen.queryByRole("button", { name: /创建 Team|房间设置/u }), null);
  const current = await f.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: f.cookie() } });
  assert.equal(current.json().user.displayName, "Actual client owner");
  assert.equal(current.json().user.clientTeamId, f.teamId);
});

test("cancel preserves the existing login and leaves the one-use ticket unconsumed", async (t) => {
  const f = await fixture(t), screen = f.mount();
  await screen.findByText(/Actual client owner/u);
  f.fireEvent.click(screen.getByRole("button", { name: "取消，保留原登录" }));
  await f.waitFor(() => assert.ok(f.calls.includes("/api/auth/status")));
  assert.equal(f.cookie(), f.ownerCookie);
  assert.equal(f.calls.includes("/api/auth/client-entry/claim"), false);
  const response = await f.app.inject({ method: "POST", url: "/api/auth/client-entry/preview", headers: { origin }, payload: { ticket: f.ticket } });
  assert.equal(response.statusCode, 200);
});

test("revoked entry fails without expiring the existing browser login or replaying", async (t) => {
  const f = await fixture(t);
  await f.app.inject({ method: "DELETE", url: `/api/teams/${f.teamId}/devices/${f.deviceId}/client-access`, headers: f.headers });
  let expiredEvents = 0; window.addEventListener(webSessionExpiredEvent, () => expiredEvents++);
  const screen = f.mount();
  await screen.findByRole("alert");
  assert.equal((screen.getByRole("button", { name: "确认并进入" }) as HTMLButtonElement).disabled, true);
  assert.equal(f.cookie(), f.ownerCookie);
  assert.equal(expiredEvents, 0);
  assert.equal(f.calls.includes("/api/auth/client-entry/claim"), false);
});

test("inviting an Agent selects its real owner by default while explicit Agent-only access is preserved", async (t) => {
  const f = await fixture(t); f.seedUninvitedAgent();
  const screen = f.mount();
  await screen.findByRole("textbox", { name: "消息" });
  const { within } = await import("@testing-library/react");
  f.fireEvent.click(within(screen.getByRole("region", { name: "房间成员" })).getByRole("button", { name: "房间设置" }));
  await screen.findByRole("dialog", { name: "房间设置" });
  const human = screen.getByRole("checkbox", { name: /Actual client owner/u }) as HTMLInputElement;
  const agent = screen.getByRole("checkbox", { name: /Client Builder/u }) as HTMLInputElement;
  assert.equal(human.checked, false); assert.equal(agent.checked, false);
  f.fireEvent.click(agent); assert.equal(human.checked, true);
  f.fireEvent.click(agent); assert.equal(human.checked, true);
  f.fireEvent.click(agent); f.fireEvent.click(human);
  assert.equal(agent.checked, true); assert.equal(human.checked, false);
  f.fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await f.waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "房间设置" }) === null, true));
  const result = await f.app.inject({ method: "GET", url: `/api/rooms/${f.roomId}/participants`, headers: f.headers });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().memberIds.includes(f.memberId), false);
  assert.deepEqual(result.json().agentIds, ["agent_clientbuilder123"]);
});
