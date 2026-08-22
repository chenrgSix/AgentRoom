import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createServerApp } from "../src/app.js";

const now = "2026-08-22T10:00:00.000Z";

test("a Bridge pairing invitation is short-lived and single-use", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-pair-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => now
  });
  try {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Alice" }
    });
    const authorization = `Bearer ${bootstrap.json().session.token}`;
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization },
      payload: { name: "Core Team" }
    });
    const teamId = team.json().team.teamId as string;
    const invitation = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/bridge-invites`,
      headers: { authorization },
      payload: { deviceName: "Alice Mac" }
    });
    assert.equal(invitation.statusCode, 200);
    const code = invitation.json().code as string;

    const wrongName = await app.inject({
      method: "POST",
      url: "/api/bridge/pair",
      payload: { code, deviceName: "Mallory Mac" }
    });
    assert.equal(wrongName.statusCode, 400);
    const paired = await app.inject({
      method: "POST",
      url: "/api/bridge/pair",
      payload: { code, deviceName: "Alice Mac" }
    });
    assert.equal(paired.statusCode, 200);
    assert.match(paired.json().credential.token, /^[A-Za-z0-9_-]{40,}$/u);

    const replay = await app.inject({
      method: "POST",
      url: "/api/bridge/pair",
      payload: { code, deviceName: "Alice Mac" }
    });
    assert.equal(replay.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("a client join request requires Owner approval and claims one stable Device", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-join-"));
  const databasePath = path.join(directory, "server.sqlite");
  const app = await createServerApp({ databasePath, clock: () => now });
  let pollToken = "";
  let userCode = "";
  try {
    const ownerBootstrap = await app.inject({
      method: "POST", url: "/api/bootstrap", payload: { displayName: "Alice" }
    });
    const ownerAuthorization = `Bearer ${ownerBootstrap.json().session.token}`;
    const team = await app.inject({
      method: "POST", url: "/api/teams",
      headers: { authorization: ownerAuthorization }, payload: { name: "Core Team" }
    });
    const teamId = team.json().team.teamId as string;
    const memberBootstrap = await app.inject({
      method: "POST", url: "/api/bootstrap", payload: { displayName: "Bob" }
    });
    const memberAuthorization = `Bearer ${memberBootstrap.json().session.token}`;
    await app.inject({
      method: "POST", url: `/api/teams/${teamId}/members`,
      headers: { authorization: ownerAuthorization },
      payload: {
        userId: memberBootstrap.json().user.userId,
        displayName: "Bob"
      }
    });

    const requested = await app.inject({
      method: "POST", url: "/api/bridge/join-requests",
      payload: {
        deviceName: "Bob Mac",
        agentName: "Local Codex",
        agentRole: "Codex implementer"
      }
    });
    assert.equal(requested.statusCode, 200);
    assert.match(requested.json().userCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/u);
    assert.match(requested.json().pollToken, /^[A-Za-z0-9_-]{40,}$/u);
    const joinRequestId = requested.json().joinRequestId as string;
    pollToken = requested.json().pollToken as string;
    userCode = requested.json().userCode as string;

    const pending = await app.inject({
      method: "POST", url: `/api/bridge/join-requests/${joinRequestId}/claim`,
      payload: { pollToken }
    });
    assert.equal(pending.statusCode, 202);
    assert.equal(pending.json().status, "pending");

    const forgedClaim = await app.inject({
      method: "POST", url: `/api/bridge/join-requests/${joinRequestId}/claim`,
      payload: { pollToken: "x".repeat(43) }
    });
    assert.equal(forgedClaim.statusCode, 400);

    const memberApproval = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/bridge-join-requests/approve`,
      headers: { authorization: memberAuthorization }, payload: { code: userCode }
    });
    assert.equal(memberApproval.statusCode, 403);

    const approved = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/bridge-join-requests/approve`,
      headers: { authorization: ownerAuthorization }, payload: { code: userCode }
    });
    assert.equal(approved.statusCode, 200);
    assert.deepEqual({
      status: approved.json().status,
      deviceName: approved.json().deviceName,
      agentName: approved.json().agentName,
      agentRole: approved.json().agentRole
    }, {
      status: "approved",
      deviceName: "Bob Mac",
      agentName: "Local Codex",
      agentRole: "Codex implementer"
    });

    const replayApproval = await app.inject({
      method: "POST", url: `/api/teams/${teamId}/bridge-join-requests/approve`,
      headers: { authorization: ownerAuthorization }, payload: { code: userCode }
    });
    assert.equal(replayApproval.statusCode, 400);

    const claimed = await app.inject({
      method: "POST", url: `/api/bridge/join-requests/${joinRequestId}/claim`,
      payload: { pollToken }
    });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json().status, "paired");
    assert.equal(claimed.json().credential.token, pollToken);
    assert.equal(claimed.json().device.name, "Bob Mac");

    const retry = await app.inject({
      method: "POST", url: `/api/bridge/join-requests/${joinRequestId}/claim`,
      payload: { pollToken }
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().device.deviceId, claimed.json().device.deviceId);
    assert.equal(retry.json().credential.token, pollToken);
  } finally {
    await app.close();
  }

  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database.prepare(`
      SELECT user_code_hash, poll_token_hash FROM bridge_join_requests
    `).get() as { user_code_hash: string; poll_token_hash: string };
    const credential = database.prepare(`
      SELECT secret_hash FROM device_credentials
      WHERE secret_hash = ?
    `).get(row.poll_token_hash) as { secret_hash: string } | undefined;
    assert.notEqual(row.user_code_hash, userCode.replaceAll("-", ""));
    assert.notEqual(row.poll_token_hash, pollToken);
    assert.equal(credential?.secret_hash, row.poll_token_hash);
  } finally {
    database.close();
  }
});
