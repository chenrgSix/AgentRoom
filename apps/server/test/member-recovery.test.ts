import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";
import type { FastifyBaseLogger } from "fastify";

import { createServerApp } from "../src/app.js";
import { AuthService } from "../src/security/auth-service.js";

const initialNow = "2026-08-31T01:00:00.000Z";
const origin = "https://team.example.com";
const ownerRecoveryToken = "owner-recovery-test-0123456789abcdef";

function cookie(response: { headers: Record<string, unknown> }): string {
  const match = /^(__Host-agentroom_session=[^;]+)/u.exec(String(response.headers["set-cookie"]));
  assert.ok(match);
  return match[1];
}

function captureLogger(entries: unknown[]): FastifyBaseLogger {
  const capture = (...values: unknown[]) => { entries.push(values); };
  const logger = {
    level: "trace", fatal: capture, error: capture, warn: capture,
    info: capture, debug: capture, trace: capture, silent: capture,
    child: () => logger
  };
  return logger as unknown as FastifyBaseLogger;
}

async function fixture(t: TestContext, maximumAttempts = 100) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-member-recovery-"));
  const databasePath = path.join(directory, "server.sqlite");
  let now = initialNow;
  const logs: unknown[] = [];
  const options = {
    databasePath,
    clock: () => now,
    webAuth: { mode: "trusted-team" as const, ownerRecoveryToken, publicOrigin: origin },
    anonymousRateLimit: { maximumAttempts, windowMilliseconds: 60_000 },
    loggerInstance: captureLogger(logs)
  };
  let app = await createServerApp(options);
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const setup = await app.inject({
    method: "POST", url: "/api/auth/setup", payload: { displayName: "Alice" },
    headers: { origin, "x-agent-room-recovery-token": ownerRecoveryToken }
  });
  assert.equal(setup.statusCode, 200);
  const ownerCookie = cookie(setup);
  const ownerHeaders = { cookie: ownerCookie, origin };
  const team = await app.inject({
    method: "POST", url: "/api/teams", headers: ownerHeaders, payload: { name: "Core" }
  });
  assert.equal(team.statusCode, 200);
  const teamId = team.json().team.teamId as string;
  const ownerMemberId = team.json().owner.memberId as string;
  const invitation = await app.inject({
    method: "POST", url: `/api/teams/${teamId}/member-invitations`,
    headers: ownerHeaders, payload: { displayName: "Bob" }
  });
  const invitationToken = String(invitation.json().claimUrl).split("/#/join/")[1];
  const claim = await app.inject({
    method: "POST", url: "/api/auth/member-invitations/claim",
    headers: { origin }, payload: { token: invitationToken }
  });
  assert.equal(claim.statusCode, 200);
  const member = claim.json().member as { memberId: string; userId: string };
  const memberCookie = cookie(claim);
  const memberHeaders = { cookie: memberCookie, origin };
  const recoveryUrl = `/api/teams/${teamId}/members/${member.memberId}/recovery`;
  return {
    get app() { return app; }, databasePath, logs, ownerCookie, ownerHeaders,
    ownerMemberId, teamId, member, memberCookie, memberHeaders, recoveryUrl,
    setNow(value: string) { now = value; },
    async restart() { await app.close(); app = await createServerApp(options); },
    issue: () => app.inject({ method: "POST", url: recoveryUrl, headers: ownerHeaders }),
    claim: (token: string) => app.inject({
      method: "POST", url: "/api/auth/recover-member", headers: { origin }, payload: { token }
    })
  };
}

test("member recovery preserves identity, private Room, Task and Device across restart", async (t) => {
  const f = await fixture(t);
  const room = await f.app.inject({
    method: "POST", url: `/api/teams/${f.teamId}/rooms`,
    headers: f.memberHeaders, payload: { name: "Bob's private work" }
  });
  assert.equal(room.statusCode, 200);
  const roomId = room.json().roomId as string;
  const task = await f.app.inject({
    method: "POST", url: `/api/rooms/${roomId}/tasks`, headers: f.memberHeaders,
    payload: { title: "Continue my task", goal: "Keep the original identity" }
  });
  assert.equal(task.statusCode, 200);
  const db = new Database(f.databasePath);
  const auth = new AuthService(db);
  let deviceSecret = "";
  try {
    db.prepare(`INSERT INTO devices (device_id, team_id, owner_member_id, name, status, created_at)
      VALUES ('device_recoverytest', ?, ?, 'Existing laptop', 'active', ?)`)
      .run(f.teamId, f.member.memberId, initialNow);
    deviceSecret = auth.issueDeviceCredential("device_recoverytest", initialNow).secret;
  } finally { db.close(); }
  const issued = await f.issue();
  assert.equal(issued.statusCode, 200);
  assert.equal(issued.headers["cache-control"], "no-store");
  const grant = issued.json() as { token: string; recoveryId: string; expiresAt: string };
  assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(grant.expiresAt, "2026-08-31T01:15:00.000Z");
  assert.equal(issued.json().claimUrl, undefined);
  const inspection = new Database(f.databasePath, { readonly: true });
  try {
    const row = inspection.prepare("SELECT * FROM web_member_recoveries WHERE recovery_id = ?")
      .get(grant.recoveryId) as { token_hash: string };
    assert.equal(row.token_hash, createHash("sha256").update(grant.token).digest("hex"));
    assert.equal(JSON.stringify(row).includes(grant.token), false);
  } finally { inspection.close(); }
  await f.restart();
  const recovered = await f.claim(grant.token);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.headers["cache-control"], "no-store");
  assert.equal(recovered.json().member.memberId, f.member.memberId);
  assert.equal(recovered.json().user.userId, f.member.userId);
  assert.equal(recovered.json().session.token, undefined);
  assert.equal(recovered.body.includes(grant.token), false);
  const recoveredHeaders = { cookie: cookie(recovered), origin };
  assert.match(String(recovered.headers["set-cookie"]), /; HttpOnly; Secure; SameSite=Strict/u);
  assert.equal((await f.app.inject({
    method: "GET", url: "/api/auth/session", headers: f.memberHeaders
  })).statusCode, 401);
  assert.equal((await f.app.inject({
    method: "GET", url: "/api/auth/session", headers: f.ownerHeaders
  })).statusCode, 200);
  const rooms = await f.app.inject({
    method: "GET", url: `/api/teams/${f.teamId}/rooms`, headers: recoveredHeaders
  });
  assert.ok(rooms.json().some((value: { roomId: string }) => value.roomId === roomId));
  const restoredTasks = await f.app.inject({
    method: "GET", url: `/api/rooms/${roomId}/tasks`, headers: recoveredHeaders
  });
  assert.ok(restoredTasks.json().some((value: { taskId: string }) => value.taskId === task.json().taskId));
  const after = new Database(f.databasePath);
  try {
    assert.equal((after.prepare("SELECT count(*) AS count FROM web_users").get() as { count: number }).count, 2);
    assert.equal((after.prepare("SELECT count(*) AS count FROM team_members").get() as { count: number }).count, 2);
    assert.equal(new AuthService(after).authenticateDevice(deviceSecret, initialNow).ownerMemberId, f.member.memberId);
  } finally { after.close(); }
  // A lost successful response does not cause the one-time credential to replay.
  const replay = await f.claim(grant.token);
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.headers["set-cookie"], undefined);
  const replacement = await f.issue();
  const recoveredAgain = await f.claim(replacement.json().token);
  assert.equal(recoveredAgain.statusCode, 200);
  assert.equal(recoveredAgain.json().user.userId, f.member.userId);
  assert.equal((await f.app.inject({
    method: "GET", url: "/api/auth/session", headers: recoveredHeaders
  })).statusCode, 401);
  assert.equal(JSON.stringify(f.logs).includes(grant.token), false);
  assert.equal(JSON.stringify(f.logs).includes(deviceSecret), false);
  const databaseBytes = await readFile(f.databasePath);
  assert.equal(databaseBytes.includes(Buffer.from(grant.token)), false);
});

test("member recovery rejects missing Origin, unauthorized owners, wrong Team and Owner targets", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ method: "POST", url: f.recoveryUrl })).statusCode, 401);
  assert.equal((await f.app.inject({
    method: "POST", url: f.recoveryUrl, headers: { cookie: f.ownerCookie }
  })).statusCode, 403);
  assert.equal((await f.app.inject({
    method: "POST", url: f.recoveryUrl, headers: f.memberHeaders
  })).statusCode, 403);
  assert.equal((await f.app.inject({
    method: "POST", url: `/api/teams/${f.teamId}/members/${f.ownerMemberId}/recovery`,
    headers: f.ownerHeaders
  })).statusCode, 403);
  const otherTeam = await f.app.inject({
    method: "POST", url: "/api/teams", headers: f.ownerHeaders, payload: { name: "Other" }
  });
  const otherTeamId = otherTeam.json().team.teamId as string;
  assert.equal((await f.app.inject({
    method: "POST", url: `/api/teams/${otherTeamId}/members/${f.member.memberId}/recovery`,
    headers: f.ownerHeaders
  })).statusCode, 403);
  const issued = await f.issue();
  const token = issued.json().token as string;
  for (const headers of [{}, { origin: "https://attacker.example" }]) {
    assert.equal((await f.app.inject({
      method: "POST", url: "/api/auth/recover-member", headers, payload: { token }
    })).statusCode, 403);
  }
  assert.equal((await f.app.inject({
    method: "POST", url: "/api/auth/recover-member", headers: { origin },
    payload: { token: "wrong-code" }
  })).statusCode, 401);
  const revokeUrl = `${f.recoveryUrl}/${issued.json().recoveryId as string}`;
  assert.equal((await f.app.inject({ method: "DELETE", url: revokeUrl, headers: f.memberHeaders })).statusCode, 403);
  // A mismatched URL must not revoke the original Team's capability.
  assert.equal((await f.app.inject({
    method: "DELETE", url: `/api/teams/${otherTeamId}/members/${f.member.memberId}/recovery/${issued.json().recoveryId as string}`,
    headers: f.ownerHeaders
  })).statusCode, 200);
  assert.equal((await f.claim(token)).statusCode, 200);
});

test("member recovery replacement, expiry and explicit revocation never affect existing sessions", async (t) => {
  const f = await fixture(t);
  const first = await f.issue();
  const second = await f.issue();
  assert.notEqual(first.json().token, second.json().token);
  assert.equal((await f.claim(first.json().token)).statusCode, 401);
  const revokeUrl = `${f.recoveryUrl}/${second.json().recoveryId as string}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await f.app.inject({ method: "DELETE", url: revokeUrl, headers: f.ownerHeaders })).statusCode, 200);
  }
  assert.equal((await f.claim(second.json().token)).statusCode, 401);
  const expiring = await f.issue();
  f.setNow("2026-08-31T01:15:00.000Z");
  assert.equal((await f.claim(expiring.json().token)).statusCode, 401);
  assert.equal((await f.app.inject({
    method: "GET", url: "/api/auth/session", headers: f.memberHeaders
  })).statusCode, 200);
});

test("recovery rechecks issuer, target role, multi-Team identity and archived Team at claim", async (t) => {
  const f = await fixture(t);
  const db = new Database(f.databasePath);
  try {
    const cases = [
      {
        change: () => db.prepare("UPDATE team_members SET role = 'member' WHERE member_id = ?").run(f.ownerMemberId),
        restore: () => db.prepare("UPDATE team_members SET role = 'owner' WHERE member_id = ?").run(f.ownerMemberId)
      },
      {
        change: () => db.prepare("UPDATE team_members SET role = 'owner' WHERE member_id = ?").run(f.member.memberId),
        restore: () => db.prepare("UPDATE team_members SET role = 'member' WHERE member_id = ?").run(f.member.memberId)
      },
      {
        change: () => db.prepare("UPDATE teams SET archived_at = ? WHERE team_id = ?").run(initialNow, f.teamId),
        restore: () => db.prepare("UPDATE teams SET archived_at = NULL WHERE team_id = ?").run(f.teamId)
      }
    ];
    for (const scenario of cases) {
      const issued = await f.issue();
      assert.equal(issued.statusCode, 200);
      scenario.change();
      assert.equal((await f.claim(issued.json().token)).statusCode, 401);
      scenario.restore();
    }
    const issued = await f.issue();
    const ownTeam = await f.app.inject({
      method: "POST", url: "/api/teams", headers: f.memberHeaders, payload: { name: "Bob's Team" }
    });
    assert.equal(ownTeam.statusCode, 200);
    assert.equal((await f.claim(issued.json().token)).statusCode, 401);
    assert.equal((await f.issue()).statusCode, 403);
    db.prepare("UPDATE team_members SET role = 'member' WHERE member_id = ?")
      .run(ownTeam.json().owner.memberId);
    db.prepare("UPDATE teams SET archived_at = ? WHERE team_id = ?")
      .run(initialNow, ownTeam.json().team.teamId);
    assert.equal((await f.issue()).statusCode, 403, "archived foreign memberships still carry identity authority");
    assert.equal((await f.app.inject({
      method: "GET", url: "/api/auth/session", headers: f.memberHeaders
    })).statusCode, 200);
  } finally { db.close(); }
});

test("anonymous member recovery claims are rate limited without disclosing tokens", async (t) => {
  const f = await fixture(t, 2);
  const code = "untrusted-input-should-not-be-logged";
  assert.equal((await f.claim(code)).statusCode, 401);
  assert.equal((await f.claim(code)).statusCode, 401);
  assert.equal((await f.claim(code)).statusCode, 429);
  assert.equal(JSON.stringify(f.logs).includes(code), false);
});

test("member recovery rolls back consumption and revocation if a replacement session cannot commit", async (t) => {
  const f = await fixture(t);
  const issued = await f.issue();
  const db = new Database(f.databasePath);
  try {
    db.exec(`CREATE TRIGGER reject_recovery_session BEFORE INSERT ON web_sessions
      BEGIN SELECT RAISE(ABORT, 'session unavailable'); END`);
    const rejected = await f.claim(issued.json().token);
    assert.ok(rejected.statusCode >= 400);
    assert.equal(rejected.headers["set-cookie"], undefined);
    const grantState = db.prepare("SELECT consumed_at FROM web_member_recoveries WHERE recovery_id = ?")
      .get(issued.json().recoveryId) as { consumed_at: string | null };
    assert.equal(grantState.consumed_at, null);
    assert.equal((await f.app.inject({
      method: "GET", url: "/api/auth/session", headers: f.memberHeaders
    })).statusCode, 200);
    db.exec("DROP TRIGGER reject_recovery_session");
    const results = await Promise.all([f.claim(issued.json().token), f.claim(issued.json().token)]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 401]);
  } finally { db.close(); }
});
