import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";
import {
  bridgeServerTokenHeader,
  normalizeBridgeServerToken
} from "../src/security/bridge-server-token.js";

const now = "2026-08-24T16:00:00.000Z";
const serverToken = `central-${"t".repeat(40)}`;

test("central Server Token validation is optional, bounded, and normalized", () => {
  assert.equal(normalizeBridgeServerToken(undefined), undefined);
  assert.equal(normalizeBridgeServerToken("  "), undefined);
  assert.equal(normalizeBridgeServerToken(`  ${serverToken}  `), serverToken);
  assert.throws(
    () => normalizeBridgeServerToken("short"),
    /32 to 512 bytes/u
  );
  assert.throws(
    () => normalizeBridgeServerToken(`${"x".repeat(32)}\nforged`),
    /32 to 512 bytes/u
  );
});

test("configured central Server Token gates Bridge bootstrap and WebSocket traffic", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-server-token-"));
  const app = await createServerApp({
    bridgeServerToken: serverToken,
    clock: () => now,
    databasePath: path.join(directory, "server.sqlite")
  });
  await app.ready();
  try {
    const joinPayload = {
      deviceName: "Token Bridge",
      agentName: "Token Agent",
      agentRole: "Implementation"
    };
    for (const headers of [undefined, { [bridgeServerTokenHeader]: "wrong" }]) {
      const denied = await app.inject({
        method: "POST",
        url: "/api/bridge/join-requests",
        ...(headers ? { headers } : {}),
        payload: joinPayload
      });
      assert.equal(denied.statusCode, 401);
      assert.equal(denied.json().error.code, "UNAUTHENTICATED");
      assert.doesNotMatch(denied.body, new RegExp(serverToken, "u"));
    }
    const joined = await app.inject({
      method: "POST",
      url: "/api/bridge/join-requests",
      headers: { [bridgeServerTokenHeader]: serverToken },
      payload: joinPayload
    });
    assert.equal(joined.statusCode, 200);
    const deniedClaim = await app.inject({
      method: "POST",
      url: `/api/bridge/join-requests/${joined.json().joinRequestId as string}/claim`,
      payload: { pollToken: joined.json().pollToken as string }
    });
    assert.equal(deniedClaim.statusCode, 401);
    const pendingClaim = await app.inject({
      method: "POST",
      url: `/api/bridge/join-requests/${joined.json().joinRequestId as string}/claim`,
      headers: { [bridgeServerTokenHeader]: serverToken },
      payload: { pollToken: joined.json().pollToken as string }
    });
    assert.equal(pendingClaim.statusCode, 202);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Alice" }
    });
    const authorization = `Bearer ${bootstrap.json().session.token as string}`;
    const team = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization },
      payload: { name: "Token Team" }
    });
    const invite = await app.inject({
      method: "POST",
      url: `/api/teams/${team.json().team.teamId as string}/bridge-invites`,
      headers: { authorization },
      payload: { deviceName: "Token Bridge" }
    });
    const deniedPair = await app.inject({
      method: "POST",
      url: "/api/bridge/pair",
      payload: { code: invite.json().code, deviceName: "Token Bridge" }
    });
    assert.equal(deniedPair.statusCode, 401);
    const paired = await app.inject({
      method: "POST",
      url: "/api/bridge/pair",
      headers: { [bridgeServerTokenHeader]: serverToken },
      payload: { code: invite.json().code, deviceName: "Token Bridge" }
    });
    assert.equal(paired.statusCode, 200);
    const deviceBearer = paired.json().credential.token as string;

    await assert.rejects(
      app.injectWS("/ws/bridge", {
        headers: { authorization: `Bearer ${deviceBearer}`, host: "127.0.0.1" }
      })
    );
    await assert.rejects(
      app.injectWS("/ws/bridge", {
        headers: {
          authorization: `Bearer ${deviceBearer}`,
          [bridgeServerTokenHeader]: "wrong",
          host: "127.0.0.1"
        }
      })
    );
    const socket = await app.injectWS("/ws/bridge", {
      headers: {
        authorization: `Bearer ${deviceBearer}`,
        [bridgeServerTokenHeader]: serverToken,
        host: "127.0.0.1"
      }
    });
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
    });
  } finally {
    await app.close();
  }
});
