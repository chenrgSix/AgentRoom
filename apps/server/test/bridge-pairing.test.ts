import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
