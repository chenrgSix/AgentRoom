import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";

const publicOrigin = "https://central.local:40000";
const browserOrigin = "http://central.local:40080";
const recoveryToken = "lan-owner-recovery-" + "r".repeat(32);

test("LAN HTTP uses its exact Origin and a transport-distinct session Cookie", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-lan-http-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "central.sqlite"),
    webAuth: { mode: "trusted-team", publicOrigin, browserOrigin, ownerRecoveryToken: recoveryToken }
  });
  try {
    const wrongOrigin = await app.inject({ method: "POST", url: "/api/auth/setup",
      headers: { origin: publicOrigin, "x-agent-room-recovery-token": recoveryToken },
      payload: { displayName: "Wrong" } });
    assert.equal(wrongOrigin.statusCode, 403);

    const setup = await app.inject({ method: "POST", url: "/api/auth/setup",
      headers: { origin: browserOrigin, "x-agent-room-recovery-token": recoveryToken },
      payload: { displayName: "LAN Owner" } });
    assert.equal(setup.statusCode, 200, setup.body);
    const header = String(setup.headers["set-cookie"]);
    assert.match(header, /^agentroom_lan_session=/u);
    assert.match(header, /; HttpOnly; SameSite=Strict;/u);
    assert.doesNotMatch(header, /; Secure(?:;|$)/u);
    assert.doesNotMatch(header, /__Host-agentroom_session/u);
    const cookie = header.split(";", 1)[0]!;

    assert.equal((await app.inject({ url: "/api/auth/session",
      headers: { cookie: `__Host-agentroom_session=${randomBytes(32).toString("base64url")}` } })).statusCode, 401);
    assert.equal((await app.inject({ url: "/api/auth/session", headers: { cookie } })).statusCode, 200);

    const team = await app.inject({ method: "POST", url: "/api/teams",
      headers: { cookie, origin: browserOrigin }, payload: { name: "LAN Team" } });
    assert.equal(team.statusCode, 200, team.body);
    assert.equal((await app.inject({ method: "POST", url: "/api/teams",
      headers: { cookie, origin: publicOrigin }, payload: { name: "Wrong Origin" } })).statusCode, 403);

    const logout = await app.inject({ method: "DELETE", url: "/api/auth/session",
      headers: { cookie, origin: browserOrigin } });
    assert.equal(logout.statusCode, 200);
    const cleared = String(logout.headers["set-cookie"]);
    assert.match(cleared, /^agentroom_lan_session=/u);
    assert.doesNotMatch(cleared, /; Secure(?:;|$)/u);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("client entry ticket advertises only the configured browser origin", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-lan-ticket-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "central.sqlite"),
    webAuth: { mode: "trusted-team", publicOrigin, browserOrigin, ownerRecoveryToken: recoveryToken }
  });
  try {
    const now = new Date().toISOString();
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup",
      headers: { origin: browserOrigin, "x-agent-room-recovery-token": recoveryToken },
      payload: { displayName: "LAN Owner" } });
    const ownerCookie = String(setup.headers["set-cookie"]).split(";", 1)[0]!;
    const ownerHeaders = { cookie: ownerCookie, origin: browserOrigin };
    const team = (await app.inject({ method: "POST", url: "/api/teams", headers: ownerHeaders,
      payload: { name: `LAN ${now}` } })).json();
    assert.ok(team.team.teamId);
    // The full pairing authority is covered by client-owner-access tests. This
    // regression asserts that anonymous or Web authority cannot obtain the
    // authenticated Device-only header.
    const denied = await app.inject({ method: "POST", url: "/api/client-access/tickets",
      headers: ownerHeaders, payload: { clientAccessSecret: randomBytes(32).toString("base64url") } });
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers["convenewire-browser-origin"], undefined);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
