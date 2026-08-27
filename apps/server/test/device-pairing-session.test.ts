import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createServerApp } from "../src/app.js";
import { AuthService } from "../src/security/auth-service.js";

const initialNow = "2026-08-28T10:00:00.000Z";
const claimSecret = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const pollSecret = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";

function secretHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function bootstrapOwner(
  app: Awaited<ReturnType<typeof createServerApp>>,
  displayName: string,
  teamName: string
): Promise<{ authorization: string; teamId: string; userId: string }> {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/api/bootstrap",
    payload: { displayName }
  });
  assert.equal(bootstrap.statusCode, 200);
  const authorization = `Bearer ${bootstrap.json().session.token}`;
  const team = await app.inject({
    method: "POST",
    url: "/api/teams",
    headers: { authorization },
    payload: { name: teamName }
  });
  assert.equal(team.statusCode, 200);
  return {
    authorization,
    teamId: team.json().team.teamId as string,
    userId: bootstrap.json().user.userId as string
  };
}

function claimPayload(
  pairingSessionId: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    operationId: "op_claim0000000000000000000000000001",
    pairingSessionId,
    claimSecret,
    pairingAttemptId: "pairattempt_000000000000000000000001",
    pollSecret,
    device: {
      displayName: "Bob MacBook",
      platform: "darwin-arm64",
      bridgeVersion: "0.3.0-rc.6"
    },
    ...overrides
  };
}

test("zero-copy pairing promotes the poll proof exactly once and survives response loss", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-zero-copy-"));
  const databasePath = path.join(directory, "server.sqlite");
  let app = await createServerApp({
    databasePath,
    bridgeServerToken: "server-token-that-new-pairing-never-receives",
    clock: () => initialNow
  });
  let pairingSessionId = "";
  let teamId = "";
  try {
    const owner = await bootstrapOwner(app, "Alice", "Core Team");
    teamId = owner.teamId;
    const created = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_create000000000000000000000000001",
        claimSecret
      }
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.headers["cache-control"], "no-store");
    assert.equal(created.json().state, "issued");
    assert.match(created.json().shortCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/u);
    assert.equal(JSON.stringify(created.json()).includes(claimSecret), false);
    pairingSessionId = created.json().pairingSessionId as string;

    const createRetry = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_create000000000000000000000000001",
        claimSecret
      }
    });
    assert.deepEqual(createRetry.json(), created.json());

    const changedCreate = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_create000000000000000000000000001",
        claimSecret: "z".repeat(43)
      }
    });
    assert.equal(changedCreate.statusCode, 409);

    const claimed = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: claimPayload(pairingSessionId)
    });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.headers["cache-control"], "no-store");
    assert.equal(claimed.json().state, "claimed");
    assert.match(claimed.json().verificationPhrase, /^[A-Z]+-[A-Z]+-[0-9]{2}$/u);
    assert.equal(JSON.stringify(claimed.json()).includes(pollSecret), false);

    const claimRetry = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: claimPayload(pairingSessionId)
    });
    assert.deepEqual(claimRetry.json(), claimed.json());

    const competingClaim = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: claimPayload(pairingSessionId, {
        operationId: "op_compete00000000000000000000000001",
        pairingAttemptId: "pairattempt_000000000000000000000002",
        pollSecret: "y".repeat(43)
      })
    });
    assert.equal(competingClaim.statusCode, 400);
    assert.equal(
      competingClaim.json().error.message,
      "Invalid or expired Device pairing session"
    );

    const ownerView = await app.inject({
      method: "GET",
      url: `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}`,
      headers: { authorization: owner.authorization }
    });
    assert.equal(ownerView.statusCode, 200);
    assert.equal(
      ownerView.json().verificationPhrase,
      claimed.json().verificationPhrase
    );
    assert.deepEqual(ownerView.json().device, {
      displayName: "Bob MacBook",
      platform: "darwin-arm64",
      bridgeVersion: "0.3.0-rc.6"
    });
    assert.equal(JSON.stringify(ownerView.json()).includes("Secret"), false);

    const pending = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/poll`,
      payload: {
        pairingSessionId,
        pairingAttemptId: claimPayload(pairingSessionId).pairingAttemptId,
        pollSecret
      }
    });
    assert.equal(pending.statusCode, 202);
    assert.equal(pending.json().state, "claimed");

    const approved = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}/approve`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_approve0000000000000000000000001",
        expectedState: "claimed"
      }
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().state, "approved");
    const deviceId = approved.json().deviceId as string;

    await app.close();
    app = await createServerApp({
      databasePath,
      bridgeServerToken: "server-token-that-new-pairing-never-receives",
      clock: () => initialNow
    });

    const approveRetry = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/device-pairing-sessions/${pairingSessionId}/approve`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_approve0000000000000000000000001",
        expectedState: "claimed"
      }
    });
    assert.equal(approveRetry.statusCode, 200);
    assert.equal(approveRetry.json().deviceId, deviceId);

    const consumed = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/poll`,
      payload: {
        pairingSessionId,
        pairingAttemptId: claimPayload(pairingSessionId).pairingAttemptId,
        pollSecret
      }
    });
    assert.equal(consumed.statusCode, 200);
    assert.deepEqual(consumed.json(), {
      pairingSessionId,
      pairingAttemptId: claimPayload(pairingSessionId).pairingAttemptId,
      state: "consumed",
      deviceId,
      teamId,
      ownerMemberId: created.json().ownerMemberId,
      credentialSource: "poll_secret"
    });
    assert.equal(JSON.stringify(consumed.json()).includes(pollSecret), false);

    const pollRetry = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/poll`,
      payload: {
        pairingSessionId,
        pairingAttemptId: claimPayload(pairingSessionId).pairingAttemptId,
        pollSecret
      }
    });
    assert.deepEqual(pollRetry.json(), consumed.json());

    const socket = await app.injectWS("/ws/bridge", {
      headers: {
        authorization: `Bearer ${pollSecret}`,
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

  const database = new Database(databasePath);
  try {
    const row = database.prepare(`
      SELECT claim_secret_hash, poll_secret_hash, short_code_hash,
             credential_id, device_id, state
      FROM device_pairing_sessions WHERE pairing_session_id = ?
    `).get(pairingSessionId) as {
      claim_secret_hash: string;
      poll_secret_hash: string;
      short_code_hash: string;
      credential_id: string;
      device_id: string;
      state: string;
    };
    assert.equal(row.claim_secret_hash, secretHash(claimSecret));
    assert.equal(row.poll_secret_hash, secretHash(pollSecret));
    assert.equal(row.state, "consumed");
    assert.equal(row.short_code_hash.length, 64);
    assert.equal(JSON.stringify(row).includes(claimSecret), false);
    assert.equal(JSON.stringify(row).includes(pollSecret), false);
    const credential = database.prepare(`
      SELECT secret_hash FROM device_credentials WHERE credential_id = ?
    `).get(row.credential_id) as { secret_hash: string };
    assert.equal(credential.secret_hash, row.poll_secret_hash);
    assert.equal(
      new AuthService(database).authenticateDevice(pollSecret, initialNow).deviceId,
      row.device_id
    );
  } finally {
    database.close();
  }
});

test("manual pairing is Owner-scoped, non-enumerating, and terminal decisions are idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-manual-pair-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => initialNow
  });
  try {
    const owner = await bootstrapOwner(app, "Alice", "Core Team");
    const otherOwner = await bootstrapOwner(app, "Mallory", "Other Team");
    const memberBootstrap = await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Bob" }
    });
    const memberAuthorization = `Bearer ${memberBootstrap.json().session.token}`;
    await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/members`,
      headers: { authorization: owner.authorization },
      payload: {
        userId: memberBootstrap.json().user.userId,
        displayName: "Bob"
      }
    });

    const created = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_manualcreate000000000000000000001",
        claimSecret
      }
    });
    const pairingSessionId = created.json().pairingSessionId as string;
    const manualBody = claimPayload(pairingSessionId, {
      shortCode: created.json().shortCode
    }) as Record<string, unknown>;
    delete manualBody.pairingSessionId;
    delete manualBody.claimSecret;
    const claimed = await app.inject({
      method: "POST",
      url: "/api/device-pairing-session-claims",
      payload: manualBody
    });
    assert.equal(claimed.statusCode, 200);

    const memberApproval = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions/${pairingSessionId}/approve`,
      headers: { authorization: memberAuthorization },
      payload: {
        operationId: "op_memberapprove00000000000000000001",
        expectedState: "claimed"
      }
    });
    assert.equal(memberApproval.statusCode, 403);

    const crossTeamApproval = await app.inject({
      method: "POST",
      url: `/api/teams/${otherOwner.teamId}/device-pairing-sessions/${pairingSessionId}/approve`,
      headers: { authorization: otherOwner.authorization },
      payload: {
        operationId: "op_crossapprove000000000000000000001",
        expectedState: "claimed"
      }
    });
    assert.equal(crossTeamApproval.statusCode, 400);
    assert.equal(
      crossTeamApproval.json().error.message,
      "Invalid or expired Device pairing session"
    );

    const rejected = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions/${pairingSessionId}/reject`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_reject00000000000000000000000001",
        expectedState: "claimed",
        reason: "Unknown Device"
      }
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(rejected.json().state, "rejected");

    const rejectRetry = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions/${pairingSessionId}/reject`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_reject00000000000000000000000001",
        expectedState: "claimed",
        reason: "Unknown Device"
      }
    });
    assert.deepEqual(rejectRetry.json(), rejected.json());

    const reusedDecision = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions/${pairingSessionId}/approve`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_reject00000000000000000000000001",
        expectedState: "claimed"
      }
    });
    assert.equal(reusedDecision.statusCode, 409);

    const terminal = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/poll`,
      payload: {
        pairingSessionId,
        pairingAttemptId: claimPayload(pairingSessionId).pairingAttemptId,
        pollSecret
      }
    });
    assert.equal(terminal.statusCode, 200);
    assert.equal(terminal.json().state, "rejected");

    const replayedShortCode = await app.inject({
      method: "POST",
      url: "/api/device-pairing-session-claims",
      payload: {
        ...manualBody,
        operationId: "op_replay000000000000000000000000001",
        pairingAttemptId: "pairattempt_000000000000000000000099",
        pollSecret: "r".repeat(43)
      }
    });
    const unknownShortCode = await app.inject({
      method: "POST",
      url: "/api/device-pairing-session-claims",
      payload: {
        ...manualBody,
        shortCode: "WAVE-LAKE-73",
        operationId: "op_unknown00000000000000000000000001",
        pairingAttemptId: "pairattempt_000000000000000000000098",
        pollSecret: "u".repeat(43)
      }
    });
    assert.equal(replayedShortCode.statusCode, 400);
    assert.equal(unknownShortCode.statusCode, 400);
    assert.deepEqual(replayedShortCode.json(), unknownShortCode.json());

    const cancelCreated = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_cancelcreate000000000000000000001",
        claimSecret: "c".repeat(43)
      }
    });
    const canceled = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions/${
        cancelCreated.json().pairingSessionId
      }/cancel`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_cancel000000000000000000000000001",
        expectedState: "issued",
        reason: "No longer needed"
      }
    });
    assert.equal(canceled.statusCode, 200);
    assert.equal(canceled.json().state, "canceled");
  } finally {
    await app.close();
  }
});

test("pairing expiry and anonymous rate limits fail closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-pair-expiry-"));
  let currentNow = initialNow;
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => currentNow,
    anonymousRateLimit: { maximumAttempts: 2, windowMilliseconds: 60_000 }
  });
  try {
    const owner = await bootstrapOwner(app, "Alice", "Core Team");
    const created = await app.inject({
      method: "POST",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions`,
      headers: { authorization: owner.authorization },
      payload: {
        operationId: "op_expirycreate000000000000000000001",
        claimSecret
      }
    });
    const pairingSessionId = created.json().pairingSessionId as string;
    currentNow = "2026-08-28T10:11:00.000Z";
    const expiredClaim = await app.inject({
      method: "POST",
      url: `/api/device-pairing-sessions/${pairingSessionId}/claim`,
      payload: claimPayload(pairingSessionId)
    });
    assert.equal(expiredClaim.statusCode, 400);
    const ownerView = await app.inject({
      method: "GET",
      url: `/api/teams/${owner.teamId}/device-pairing-sessions/${pairingSessionId}`,
      headers: { authorization: owner.authorization }
    });
    assert.equal(ownerView.json().state, "expired");

    currentNow = "2026-08-28T10:11:01.000Z";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/device-pairing-session-claims",
        payload: {
          operationId: `op_rate000000000000000000000000000${attempt}`,
          shortCode: "WAVE-LAKE-73",
          pairingAttemptId: `pairattempt_00000000000000000000010${attempt}`,
          pollSecret: `rate${attempt}ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh`,
          device: {
            displayName: "Rate Limited Device",
            platform: "linux-amd64",
            bridgeVersion: "0.3.0"
          }
        }
      });
      assert.equal(response.statusCode, attempt === 2 ? 429 : 400);
    }
  } finally {
    await app.close();
  }
});
