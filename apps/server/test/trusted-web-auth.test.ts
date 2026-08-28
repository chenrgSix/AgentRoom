import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createServerApp } from "../src/app.js";

const initialNow = "2026-08-23T01:00:00.000Z";
const publicOrigin = "https://team.example.com";
const recoveryToken = "owner-recovery-token-0123456789abcdef";

function trustedWeb() {
  return {
    mode: "trusted-team" as const,
    ownerRecoveryToken: recoveryToken,
    publicOrigin
  };
}

function responseCookie(response: { headers: Record<string, unknown> }): string {
  const header = String(response.headers["set-cookie"] ?? "");
  const match = /^(__Host-agentroom_session=[^;]+)/u.exec(header);
  assert.ok(match, `missing trusted session cookie: ${header}`);
  return match[1];
}

test("trusted-team setup, invitations, CSRF, recovery, and logout are governed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-trusted-web-"));
  const databasePath = path.join(directory, "server.sqlite");
  let now = initialNow;
  const app = await createServerApp({
    databasePath,
    clock: () => now,
    webAuth: trustedWeb()
  });
  try {
    const initialStatus = await app.inject({ method: "GET", url: "/api/auth/status" });
    assert.deepEqual(initialStatus.json(), {
      mode: "trusted-team",
      state: "setup_required"
    });
    assert.equal((await app.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Mallory", userId: "user_knownidentity" }
    })).statusCode, 404);

    const missingOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: { "x-agent-room-recovery-token": recoveryToken },
      payload: { displayName: "Alice" }
    });
    assert.equal(missingOrigin.statusCode, 403);
    const wrongRecovery = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": "x".repeat(32)
      },
      payload: { displayName: "Alice" }
    });
    assert.equal(wrongRecovery.statusCode, 401);

    const setup = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      },
      payload: { displayName: "Alice" }
    });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().session.token, undefined);
    const setupCookieHeader = String(setup.headers["set-cookie"]);
    assert.match(setupCookieHeader, /; Path=\//u);
    assert.match(setupCookieHeader, /; HttpOnly/u);
    assert.match(setupCookieHeader, /; Secure/u);
    assert.match(setupCookieHeader, /; SameSite=Strict/u);
    const ownerCookie = responseCookie(setup);

    const setupReplay = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      },
      payload: { displayName: "Another Owner" }
    });
    assert.equal(setupReplay.statusCode, 403);
    const authenticatedStatus = await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { cookie: ownerCookie }
    });
    assert.equal(authenticatedStatus.json().state, "authenticated");
    assert.equal(authenticatedStatus.json().user.displayName, "Alice");

    const crossSiteTeam = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { cookie: ownerCookie, origin: "https://attacker.example" },
      payload: { name: "Core Team" }
    });
    assert.equal(crossSiteTeam.statusCode, 403);
    const teamResponse = await app.inject({
      method: "POST",
      url: "/api/teams",
      headers: { cookie: ownerCookie, origin: publicOrigin },
      payload: { name: "Core Team" }
    });
    assert.equal(teamResponse.statusCode, 200);
    const teamId = teamResponse.json().team.teamId as string;
    assert.equal((await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/members`,
      headers: { cookie: ownerCookie, origin: publicOrigin },
      payload: {
        displayName: "Forged Member",
        userId: setup.json().user.userId
      }
    })).statusCode, 404);

    const manualAgent = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/manual-agents`,
      headers: { cookie: ownerCookie, origin: publicOrigin },
      payload: { name: "Owner MCP", role: "Participant" }
    });
    assert.equal(manualAgent.statusCode, 200);
    const mcpToken = manualAgent.json().credential.token as string;
    const mcpInitialize = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcpToken}`
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "trusted-team-test", version: "1" }
        }
      }
    });
    assert.equal(mcpInitialize.statusCode, 200);
    assert.equal(mcpInitialize.json().result.serverInfo.name, "convene-wire");

    const invitation = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/member-invitations`,
      headers: { cookie: ownerCookie, origin: publicOrigin },
      payload: { displayName: "Bob" }
    });
    assert.equal(invitation.statusCode, 200);
    assert.match(
      invitation.json().claimUrl,
      /^https:\/\/team\.example\.com\/#\/join\/[A-Za-z0-9_-]{40,}$/u
    );
    const invitationToken = decodeURIComponent(
      String(invitation.json().claimUrl).split("/#/join/")[1]
    );
    const inspection = new Database(databasePath, { readonly: true });
    try {
      const stored = inspection.prepare(`
        SELECT token_hash FROM web_member_invitations WHERE invitation_id = ?
      `).get(invitation.json().invitationId) as { token_hash: string };
      assert.equal(stored.token_hash.length, 64);
      assert.notEqual(stored.token_hash, invitationToken);
    } finally {
      inspection.close();
    }

    const claimWithoutOrigin = await app.inject({
      method: "POST",
      url: "/api/auth/member-invitations/claim",
      payload: { token: invitationToken }
    });
    assert.equal(claimWithoutOrigin.statusCode, 403);
    const claim = await app.inject({
      method: "POST",
      url: "/api/auth/member-invitations/claim",
      headers: { origin: publicOrigin },
      payload: { token: invitationToken }
    });
    assert.equal(claim.statusCode, 200);
    assert.equal(claim.json().user.displayName, "Bob");
    assert.equal(claim.json().member.teamId, teamId);
    assert.equal(claim.json().session.token, undefined);
    const memberCookie = responseCookie(claim);
    const claimReplay = await app.inject({
      method: "POST",
      url: "/api/auth/member-invitations/claim",
      headers: { origin: publicOrigin },
      payload: { token: invitationToken }
    });
    assert.equal(claimReplay.statusCode, 401);

    const memberTeams = await app.inject({
      method: "GET",
      url: "/api/teams",
      headers: { cookie: memberCookie }
    });
    assert.equal(memberTeams.statusCode, 200);
    assert.equal(memberTeams.json()[0].teamId, teamId);
    const memberCannotInvite = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/member-invitations`,
      headers: { cookie: memberCookie, origin: publicOrigin },
      payload: { displayName: "Mallory" }
    });
    assert.equal(memberCannotInvite.statusCode, 403);

    const expiringInvitation = await app.inject({
      method: "POST",
      url: `/api/teams/${teamId}/member-invitations`,
      headers: { cookie: ownerCookie, origin: publicOrigin },
      payload: { displayName: "Carol" }
    });
    const expiringToken = decodeURIComponent(
      String(expiringInvitation.json().claimUrl).split("/#/join/")[1]
    );
    now = "2026-08-24T02:00:00.000Z";
    const expiredClaim = await app.inject({
      method: "POST",
      url: "/api/auth/member-invitations/claim",
      headers: { origin: publicOrigin },
      payload: { token: expiringToken }
    });
    assert.equal(expiredClaim.statusCode, 401);

    const logout = await app.inject({
      method: "DELETE",
      url: "/api/auth/session",
      headers: { cookie: ownerCookie, origin: publicOrigin }
    });
    assert.equal(logout.statusCode, 200);
    assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/u);
    assert.equal((await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: ownerCookie }
    })).statusCode, 401);

    const recovered = await app.inject({
      method: "POST",
      url: "/api/auth/recover-owner",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      }
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().user.displayName, "Alice");
    const recoveredCookie = responseCookie(recovered);

    const recoveredAgain = await app.inject({
      method: "POST",
      url: "/api/auth/recover-owner",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      }
    });
    const newestOwnerCookie = responseCookie(recoveredAgain);
    assert.equal((await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: recoveredCookie }
    })).statusCode, 401);
    assert.equal((await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: newestOwnerCookie }
    })).statusCode, 200);

    const bridgeJoin = await app.inject({
      method: "POST",
      url: "/api/bridge/join-requests",
      payload: {
        agentName: "Local Codex",
        agentRole: "Implementation",
        deviceName: "Bob Mac"
      }
    });
    assert.equal(bridgeJoin.statusCode, 200);
  } finally {
    await app.close();
  }
});

test("anonymous trusted Web authentication attempts are rate limited", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-rate-limit-"));
  const app = await createServerApp({
    anonymousRateLimit: { maximumAttempts: 2, windowMilliseconds: 60_000 },
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => initialNow,
    webAuth: trustedWeb()
  });
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/setup",
        headers: {
          origin: publicOrigin,
          "x-agent-room-recovery-token": "x".repeat(32)
        },
        payload: { displayName: "Mallory" }
      });
      assert.equal(response.statusCode, 401);
    }
    const limited = await app.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": "x".repeat(32)
      },
      payload: { displayName: "Mallory" }
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().error.code, "RATE_LIMITED");
  } finally {
    await app.close();
  }
});

test("trusted setup adopts one existing local Owner without changing identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-adopt-owner-"));
  const databasePath = path.join(directory, "server.sqlite");
  const local = await createServerApp({ databasePath, clock: () => initialNow });
  let existingUserId = "";
  let existingAuthorization = "";
  let existingMemberAuthorization = "";
  try {
    const bootstrap = await local.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Existing Alice" }
    });
    existingUserId = bootstrap.json().user.userId as string;
    existingAuthorization = `Bearer ${bootstrap.json().session.token as string}`;
    const team = await local.inject({
      method: "POST",
      url: "/api/teams",
      headers: { authorization: existingAuthorization },
      payload: { name: "Existing Team" }
    });
    assert.equal(team.statusCode, 200);
    const memberBootstrap = await local.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Existing Bob" }
    });
    existingMemberAuthorization =
      `Bearer ${memberBootstrap.json().session.token as string}`;
    assert.equal((await local.inject({
      method: "POST",
      url: `/api/teams/${team.json().team.teamId as string}/members`,
      headers: { authorization: existingAuthorization },
      payload: {
        displayName: "Existing Bob",
        userId: memberBootstrap.json().user.userId
      }
    })).statusCode, 200);
  } finally {
    await local.close();
  }

  const trusted = await createServerApp({
    databasePath,
    clock: () => initialNow,
    webAuth: trustedWeb()
  });
  try {
    const adopted = await trusted.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      },
      payload: { displayName: "Ignored replacement" }
    });
    assert.equal(adopted.statusCode, 200);
    assert.equal(adopted.json().user.userId, existingUserId);
    assert.equal(adopted.json().user.displayName, "Existing Alice");
    assert.equal((await trusted.inject({
      method: "GET",
      url: "/api/teams",
      headers: { authorization: existingAuthorization }
    })).statusCode, 401);
    assert.equal((await trusted.inject({
      method: "GET",
      url: "/api/teams",
      headers: { authorization: existingMemberAuthorization }
    })).statusCode, 401);
    assert.equal((await trusted.inject({
      method: "GET",
      url: "/api/teams",
      headers: { cookie: responseCookie(adopted) }
    })).statusCode, 200);
  } finally {
    await trusted.close();
  }
});

test("trusted setup adopts one bootstrap User before any Team exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-adopt-bootstrap-"));
  const databasePath = path.join(directory, "server.sqlite");
  const local = await createServerApp({ databasePath, clock: () => initialNow });
  let existingUserId = "";
  try {
    const bootstrap = await local.inject({
      method: "POST",
      url: "/api/bootstrap",
      payload: { displayName: "Bootstrap Alice" }
    });
    assert.equal(bootstrap.statusCode, 200);
    existingUserId = bootstrap.json().user.userId as string;
  } finally {
    await local.close();
  }

  const trusted = await createServerApp({
    databasePath,
    clock: () => initialNow,
    webAuth: trustedWeb()
  });
  try {
    const adopted = await trusted.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      },
      payload: { displayName: "Ignored replacement" }
    });
    assert.equal(adopted.statusCode, 200);
    assert.equal(adopted.json().user.userId, existingUserId);
    assert.equal(adopted.json().user.displayName, "Bootstrap Alice");
  } finally {
    await trusted.close();
  }
});

test("trusted setup fails closed for anonymous legacy Team ownership", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-ambiguous-owner-"));
  const databasePath = path.join(directory, "server.sqlite");
  const local = await createServerApp({ databasePath, clock: () => initialNow });
  await local.close();

  const database = new Database(databasePath);
  try {
    database.prepare(`
      INSERT INTO teams (team_id, name, created_at) VALUES (?, ?, ?)
    `).run("team_legacyanonymous", "Legacy Team", initialNow);
    database.prepare(`
      INSERT INTO team_members (
        member_id, team_id, user_id, display_name, role, created_at
      ) VALUES (?, ?, NULL, ?, 'owner', ?)
    `).run(
      "member_legacyanonymous",
      "team_legacyanonymous",
      "Legacy Anonymous Owner",
      initialNow
    );
  } finally {
    database.close();
  }

  const trusted = await createServerApp({
    databasePath,
    clock: () => initialNow,
    webAuth: trustedWeb()
  });
  try {
    const setup = await trusted.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": recoveryToken
      },
      payload: { displayName: "Unexpected replacement" }
    });
    assert.equal(setup.statusCode, 400);
    assert.match(setup.json().error.message, /exactly one existing Owner User/u);
    assert.deepEqual((await trusted.inject({
      method: "GET",
      url: "/api/auth/status"
    })).json(), {
      mode: "trusted-team",
      state: "setup_required"
    });
  } finally {
    await trusted.close();
  }
});

test("local Web APIs reject a non-loopback Host", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-local-host-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => initialNow
  });
  try {
    assert.equal((await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { host: "team.example.com" }
    })).statusCode, 403);
    assert.equal((await app.inject({
      method: "GET",
      url: "/api/auth/status",
      headers: { host: "127.0.0.1:3000" }
    })).statusCode, 200);
  } finally {
    await app.close();
  }
});
