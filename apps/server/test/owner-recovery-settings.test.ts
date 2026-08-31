import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";

import { createServerApp } from "../src/app.js";
import { backupDatabase } from "../src/data/backup.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { HostedAgentRepository, hostedProvider } from "../src/data/hosted-agent-repository.js";
import { AgentService } from "../src/registry/agent-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-31T09:00:00.000Z";
const origin = "https://owner.example.test";
const deploymentKey = "deployment-root-unchanged-0123456789abcdef";
const webAuth = { mode: "trusted-team" as const, publicOrigin: origin, ownerRecoveryToken: deploymentKey };
const endpoint = "/api/auth/owner-recovery";
const cookieFor = (secret: string) => `__Host-agentroom_session=${secret}`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-owner-recovery-"));
  const databasePath = path.join(directory, "server.sqlite");
  const app = await createServerApp({ databasePath, clock: () => now, webAuth });
  const db = new Database(databasePath);
  t.after(async () => { db.close(); await app.close(); await rm(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup",
    headers: { origin, "x-agent-room-recovery-token": deploymentKey }, payload: { displayName: "Owner" } });
  assert.equal(setup.statusCode, 200);
  assert.equal(setup.json().user.canManageOwnerRecovery, true);
  const ownerId = setup.json().user.userId as string;
  const cookie = String(setup.headers["set-cookie"]).split(";")[0];
  const auth = new AuthService(db);
  const core = new CoreRepository(db);
  const session = (userId = ownerId) => auth.issueWebSession(userId, now, "2026-09-15T00:00:00.000Z");
  const replace = (key: string, revision = 0, headers: Record<string, string> = {}) => app.inject({
    method: "PUT", url: endpoint, headers: { cookie, origin, "x-agent-room-recovery-token": key, ...headers },
    payload: { expectedRevision: revision }
  });
  const recover = (key: string) => app.inject({ method: "POST", url: "/api/auth/recover-owner",
    headers: { origin, "x-agent-room-recovery-token": key } });
  return { app, db, directory, databasePath, ownerId, cookie, auth, core, session, replace, recover };
}

test("Owner replacement hashes the key, retains this session, revokes only other Owner sessions and retires old login", async (t) => {
  const f = await fixture(t);
  const other = f.session();
  f.core.ensureUser({ userId: "user_ordinarymember", displayName: "Member", createdAt: now });
  const member = f.session("user_ordinarymember");
  const key = randomBytes(32).toString("hex");
  const settings = await f.app.inject({ method: "GET", url: endpoint, headers: { cookie: f.cookie } });
  assert.deepEqual(settings.json(), { revision: 0, updatedAt: null });
  assert.match(String(settings.headers["cache-control"]), /no-store/u);
  const result = await f.replace(key);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json(), { revision: 1, updatedAt: now });
  assert.equal(result.headers["set-cookie"], undefined);
  assert.match(String(result.headers["cache-control"]), /no-store/u);
  assert.equal(result.body.includes(key), false);
  const row = f.db.prepare("SELECT * FROM web_owner_recovery_credentials").get();
  assert.deepEqual(row, { singleton: 1, token_hash: createHash("sha256").update(key).digest("hex"), revision: 1, updated_at: now });
  assert.equal(f.auth.getWebSessionExpiresAt(other.id), undefined);
  assert.ok(f.auth.getWebSessionExpiresAt(member.id));
  assert.equal((await f.app.inject({ method: "GET", url: endpoint, headers: { cookie: f.cookie } })).statusCode, 200);
  // Exact retry after a lost response cannot sign out a newly issued session.
  const later = f.session();
  assert.equal((await f.replace(key)).statusCode, 200);
  assert.ok(f.auth.getWebSessionExpiresAt(later.id));
  assert.equal((await f.recover(deploymentKey)).statusCode, 401);
  const recovered = await f.recover(key);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().user.userId, f.ownerId);
});

test("Owner replacement denies anonymous, Bearer, foreign Origin and other Team Owners", async (t) => {
  const f = await fixture(t);
  const key = randomBytes(32).toString("hex");
  assert.equal((await f.replace(key, 0, { cookie: "" })).statusCode, 401);
  const bearer = f.session();
  assert.equal((await f.replace(key, 0, { cookie: "", authorization: `Bearer ${bearer.secret}` })).statusCode, 401);
  for (const badOrigin of ["", "https://attacker.example.test"]) {
    assert.equal((await f.replace(key, 0, { origin: badOrigin })).statusCode, 403);
  }
  const teams = new TeamRoomService(f.core, f.auth);
  const other = teams.createTeamForUser({ userId: "user_otherteamowner", userDisplayName: "Other Owner", teamName: "Other", now });
  const otherSession = f.session(other.owner.userId!);
  const otherCookie = cookieFor(otherSession.secret);
  assert.equal((await f.replace(key, 0, { cookie: otherCookie })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "GET", url: endpoint, headers: { cookie: otherCookie } })).statusCode, 403);
  const status = await f.app.inject({ method: "GET", url: "/api/auth/status", headers: { cookie: otherCookie } });
  assert.equal(status.json().user.canManageOwnerRecovery, false);
  assert.deepEqual(f.db.prepare("SELECT * FROM web_owner_recovery_credentials").all(), []);
});

test("invalid input and competing revisions cannot replace the key; failed session revocation rolls back the verifier", async (t) => {
  const f = await fixture(t);
  const key = randomBytes(32).toString("hex");
  for (const candidate of ["short", "G".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    assert.equal((await f.replace(candidate)).statusCode, 400);
  }
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await f.replace(key, revision)).statusCode, 400);
  }
  const other = f.session();
  f.db.exec(`CREATE TRIGGER reject_owner_revoke BEFORE UPDATE OF revoked_at ON web_sessions
    BEGIN SELECT RAISE(ABORT, 'injected revoke failure'); END`);
  assert.equal((await f.replace(key)).statusCode, 400);
  assert.equal((f.db.prepare("SELECT COUNT(*) AS n FROM web_owner_recovery_credentials").get() as { n: number }).n, 0);
  assert.ok(f.auth.getWebSessionExpiresAt(other.id));
  f.db.exec("DROP TRIGGER reject_owner_revoke");
  const competing = randomBytes(32).toString("hex");
  const results = await Promise.all([f.replace(key), f.replace(competing)]);
  assert.deepEqual(results.map((response) => response.statusCode).sort(), [200, 409]);
  const winning = results[0].statusCode === 200 ? key : competing;
  assert.equal((await f.replace(winning, 1)).statusCode, 400);
  const second = randomBytes(32).toString("hex");
  assert.equal((await f.replace(second, 1)).statusCode, 200);
  assert.equal((await f.replace(winning, 0)).statusCode, 409);
  assert.equal((await f.recover(winning)).statusCode, 401);
  assert.equal((await f.recover(second)).statusCode, 200);
});

test("restart and online backup preserve new login authority and unchanged Hosted encryption", async (t) => {
  const f = await fixture(t);
  const teams = new TeamRoomService(f.core, f.auth);
  const created = teams.createTeamForUser({ userId: f.ownerId, userDisplayName: "Owner", teamName: "Hosted", now });
  const principal = f.auth.authenticateWebSession(f.session().secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "general", now);
  const agent = new AgentService(f.core, f.auth).publishAgent(principal, {
    teamId: created.team.teamId, deviceId: null, name: "Hosted", role: "Assistant", integrationMode: "hosted",
    capabilities: { supportsHandoff: true, supportsInterrupt: true, supportsResume: false, supportsStart: true, supportsStreaming: true },
    roomIds: [room.roomId], now
  });
  const root = { mode: "trusted_recovery" as const, secret: deploymentKey };
  const hosted = new HostedAgentRepository(f.db, root);
  const apiKey = "sk-synthetic-owner-recovery-preservation";
  const credential = hosted.createCredential({ agentId: agent.agentId, teamId: created.team.teamId,
    createdByMemberId: created.owner.memberId, apiKey, now });
  hosted.createProfile({ agentId: agent.agentId, teamId: created.team.teamId, provider: hostedProvider,
    model: "test-model", credentialVersion: credential.credentialVersion, createdByMemberId: created.owner.memberId, now });
  const encryptedBefore = f.db.prepare("SELECT * FROM hosted_credential_keyrings").all();
  const key = randomBytes(32).toString("hex");
  assert.equal((await f.replace(key)).statusCode, 200);
  assert.equal(hosted.resolveExecutionProfile(agent.agentId).apiKey, apiKey);
  assert.deepEqual(f.db.prepare("SELECT * FROM hosted_credential_keyrings").all(), encryptedBefore);
  const backupPath = path.join(f.directory, "backup.sqlite");
  await backupDatabase(f.databasePath, backupPath);
  assert.equal((await readFile(backupPath)).includes(Buffer.from(key)), false);
  assert.equal((await readFile(backupPath)).includes(Buffer.from(apiKey)), false);
  await f.app.close();
  for (const databasePath of [f.databasePath, backupPath]) {
    const restarted = await createServerApp({ databasePath, clock: () => now, webAuth });
    const db = new Database(databasePath);
    try {
      assert.equal(new HostedAgentRepository(db, root).resolveExecutionProfile(agent.agentId).apiKey, apiKey);
      for (const [token, code] of [[deploymentKey, 401], [key, 200]] as const) {
        assert.equal((await restarted.inject({ method: "POST", url: "/api/auth/recover-owner",
          headers: { origin, "x-agent-room-recovery-token": token } })).statusCode, code);
      }
    } finally { db.close(); await restarted.close(); }
  }
});

test("local mode does not expose Owner recovery settings", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-owner-local-"));
  const app = await createServerApp({ databasePath: path.join(directory, "server.sqlite") });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  for (const method of ["GET", "PUT"] as const) {
    assert.equal((await app.inject({ method, url: endpoint })).statusCode, 404);
  }
});

test("documented offline recovery clears only the login override and revokes Owner sessions", async (t) => {
  const f = await fixture(t);
  const key = randomBytes(32).toString("hex");
  assert.equal((await f.replace(key)).statusCode, 200);
  await f.app.close();
  // Extract the actual operator SQL so the runbook itself remains executable.
  const runbook = await readFile(new URL("../../../docs/deployment.md", import.meta.url), "utf8");
  const sql = /```sql\n([\s\S]*?)\n\s*```/u.exec(runbook)?.[1];
  assert.ok(sql);
  f.db.exec(sql);
  const restarted = await createServerApp({ databasePath: f.databasePath, clock: () => now, webAuth });
  try {
    assert.equal((await restarted.inject({ method: "GET", url: endpoint, headers: { cookie: f.cookie } })).statusCode, 401);
    assert.equal((await restarted.inject({ method: "POST", url: "/api/auth/recover-owner",
      headers: { origin, "x-agent-room-recovery-token": key } })).statusCode, 401);
    const recovered = await restarted.inject({ method: "POST", url: "/api/auth/recover-owner",
      headers: { origin, "x-agent-room-recovery-token": deploymentKey } });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().user.userId, f.ownerId);
  } finally { await restarted.close(); }
});
