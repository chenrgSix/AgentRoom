import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Database from "better-sqlite3";
import { createServerApp } from "../src/app.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { AuthService } from "../src/security/auth-service.js";

const origin = "https://central.example";
const initialNow = "2026-08-31T12:00:00.000Z";
const secret = () => randomBytes(32).toString("base64url");
const operation = () => `op_${randomBytes(12).toString("hex")}`;
const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers["set-cookie"]).split(";")[0]!;

async function fixture(t: TestContext, origins = {
  publicOrigin: origin,
  browserOrigin: origin
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-client-owner-"));
  const databasePath = path.join(directory, "central.sqlite");
  let now = initialNow;
  const options = { databasePath, clock: () => now, webAuth: {
    mode: "trusted-team" as const, publicOrigin: origins.publicOrigin,
    ...(origins.browserOrigin === origins.publicOrigin ? {} : { browserOrigin: origins.browserOrigin }),
    ownerRecoveryToken: "recovery-" + "r".repeat(43)
  } };
  let app = await createServerApp(options);
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  t.after(async () => { await app.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup",
    headers: { origin: origins.browserOrigin, "x-agent-room-recovery-token": options.webAuth.ownerRecoveryToken }, payload: { displayName: "Alice" } });
  assert.equal(setup.statusCode, 200, setup.body);
  const headers = { cookie: cookie(setup), origin: origins.browserOrigin };
  const team = await app.inject({ method: "POST", url: "/api/teams", headers, payload: { name: "Builders" } });
  assert.equal(team.statusCode, 200, team.body);
  const teamId = team.json().team.teamId as string;
  const ownerMemberId = team.json().owner.memberId as string;
  const rooms: string[] = [];
  for (const name of ["Shared work", "Restricted work"]) {
    const response = await app.inject({ method: "POST", url: `/api/teams/${teamId}/rooms`, headers, payload: { name } });
    assert.equal(response.statusCode, 200, response.body);
    rooms.push(response.json().roomId);
  }
  async function pairing(binding?: { memberId?: string; displayName?: string; roomIds: string[] }) {
    const claimSecret = secret(); const pollSecret = secret(); const clientAccessSecret = secret();
    const createPayload = { operationId: operation(), claimSecret, ...(binding ? { memberBinding: binding } : {}) };
    const created = await app.inject({ method: "POST", url: `/api/teams/${teamId}/device-pairing-sessions`, headers, payload: createPayload });
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().pairingSessionId as string;
    const claimPayload = { pairingSessionId: id, operationId: operation(), pairingAttemptId: `pairattempt_${randomBytes(12).toString("hex")}`,
      claimSecret, pollSecret, ...(binding ? { clientAccessSecret } : {}),
      device: { displayName: "Bob laptop", platform: "darwin-arm64", bridgeVersion: "0.4.2" } };
    const claim = (payload: Record<string, unknown> = claimPayload) => app.inject({
      method: "POST", url: `/api/device-pairing-sessions/${id}/claim`, payload });
    const decision = { operationId: operation(), expectedState: "claimed" };
    const approve = () => app.inject({ method: "POST", url: `/api/teams/${teamId}/device-pairing-sessions/${id}/approve`, headers, payload: decision });
    const poll = () => app.inject({ method: "POST", url: `/api/device-pairing-sessions/${id}/poll`,
      payload: { pairingSessionId: id, pairingAttemptId: claimPayload.pairingAttemptId, pollSecret } });
    return { id, created, createPayload, claimPayload, claim, approve, poll, clientAccessSecret, pollSecret };
  }
  async function pair(binding?: { memberId?: string; displayName?: string; roomIds: string[] }) {
    const flow = await pairing(binding);
    const claimed = await flow.claim(); assert.equal(claimed.statusCode, 200, claimed.body);
    const approved = await flow.approve(); assert.equal(approved.statusCode, 200, approved.body);
    const consumed = await flow.poll(); assert.equal(consumed.statusCode, 200, consumed.body);
    return { ...flow, deviceId: consumed.json().deviceId as string, memberId: consumed.json().ownerMemberId as string,
      deviceHeaders: { authorization: `Bearer ${flow.pollSecret}` } };
  }
  const issue = (deviceHeaders: { authorization: string }, key: string, roomId?: string) => app.inject({
    method: "POST", url: "/api/client-access/tickets", headers: deviceHeaders,
    payload: { clientAccessSecret: key, ...(roomId ? { roomId } : {}) } });
  const consume = (ticket: string) => app.inject({ method: "POST", url: "/api/auth/client-entry/claim", headers: { origin: origins.browserOrigin }, payload: { ticket } });
  return { get app() { return app; }, database, headers, teamId, ownerMemberId, rooms, pairing, pair, issue, consume,
    setNow(value: string) { now = value; }, async restart() { await app.close(); app = await createServerApp(options); } };
}

test("LAN HTTP advertises its browser origin and issues only the LAN Cookie", async (t) => {
  const browserOrigin = "http://central.example:40080";
  const f = await fixture(t, {
    publicOrigin: "https://central.example:40000",
    browserOrigin
  });
  const flow = await f.pair({ displayName: "LAN member", roomIds: [f.rooms[0]!] });
  const issued = await f.issue(flow.deviceHeaders, flow.clientAccessSecret, f.rooms[0]);
  assert.equal(issued.statusCode, 200, issued.body);
  assert.equal(issued.headers["convenewire-browser-origin"], browserOrigin);
  const signedIn = await f.consume(issued.json().ticket);
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  const header = String(signedIn.headers["set-cookie"]);
  assert.match(header, /^agentroom_lan_session=/u);
  assert.match(header, /HttpOnly; SameSite=Strict/u);
  assert.doesNotMatch(header, /; Secure(?:;|$)/u);
});

test("approval atomically connects the actual person, selected Rooms and independent human entry", async (t) => {
  const f = await fixture(t);
  const flow = await f.pairing({ displayName: "Bob", roomIds: [f.rooms[0]!] });
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM team_members").get() &&
    (f.database.prepare("SELECT count(*) AS n FROM team_members").get() as { n: number }).n, 1);
  const claimed = await flow.claim(); assert.equal(claimed.statusCode, 200, claimed.body);
  assert.deepEqual((await flow.claim()).json(), claimed.json());
  const approval = await flow.approve(); assert.equal(approval.statusCode, 200, approval.body);
  assert.deepEqual((await flow.approve()).json(), approval.json());
  const paired = (await flow.poll()).json();
  assert.equal(paired.clientAccessEnabled, true);
  assert.notEqual(paired.ownerMemberId, f.ownerMemberId);
  const member = f.database.prepare("SELECT * FROM team_members WHERE member_id = ?").get(paired.ownerMemberId) as Record<string, unknown>;
  assert.equal(member.display_name, "Bob"); assert.equal(member.role, "member");
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM team_members").get() as { n: number }).n, 2);
  const deviceHeaders = { authorization: `Bearer ${flow.pollSecret}` };
  assert.equal((await f.issue(deviceHeaders, flow.pollSecret)).statusCode, 401);
  assert.equal((await f.issue({ authorization: `Bearer ${flow.clientAccessSecret}` }, flow.clientAccessSecret)).statusCode, 401);
  const listing = await f.app.inject({ method: "POST", url: "/api/client-access/rooms", headers: deviceHeaders,
    payload: { clientAccessSecret: flow.clientAccessSecret } });
  assert.deepEqual(listing.json().rooms.map((r: { roomId: string }) => r.roomId), [f.rooms[0]]);
  assert.equal((await f.issue(deviceHeaders, flow.clientAccessSecret, f.rooms[1])).statusCode, 403);
  const issued = await f.issue(deviceHeaders, flow.clientAccessSecret, f.rooms[0]);
  assert.equal(issued.statusCode, 200, issued.body); assert.equal(issued.headers["cache-control"], "no-store");
  const ticket = issued.json().ticket as string;
  const wrongOrigin = await f.app.inject({ method: "POST", url: "/api/auth/client-entry/claim", headers: { origin: "https://evil.example" }, payload: { ticket } });
  assert.equal(wrongOrigin.statusCode, 403);
  const preview = await f.app.inject({ method: "POST", url: "/api/auth/client-entry/preview", headers: { origin }, payload: { ticket } });
  assert.equal(preview.json().displayName, "Bob");
  const signedIn = await f.consume(ticket); assert.equal(signedIn.statusCode, 200, signedIn.body);
  assert.equal(signedIn.json().session.token, undefined);
  assert.match(String(signedIn.headers["set-cookie"]), /HttpOnly; Secure; SameSite=Strict/);
  const human = { cookie: cookie(signedIn), origin };
  const message = await f.app.inject({ method: "POST", url: `/api/rooms/${f.rooms[0]}/messages`, headers: human,
    payload: { content: "I own this client", mentions: [] } });
  assert.equal(message.statusCode, 200, message.body);
  assert.equal((await f.app.inject({ url: `/api/rooms/${f.rooms[1]}/messages`, headers: human })).statusCode, 403);
  assert.equal((await f.consume(ticket)).statusCode, 401);
  const persisted = JSON.stringify({ grants: f.database.prepare("SELECT * FROM client_access_grants").all(),
    pairing: f.database.prepare("SELECT * FROM device_pairing_sessions").all(), tickets: f.database.prepare("SELECT * FROM client_entry_tickets").all() });
  for (const key of [flow.clientAccessSecret, flow.pollSecret, ticket, flow.claimPayload.claimSecret]) assert.equal(persisted.includes(key), false);
  await f.restart();
  assert.equal((await f.consume(ticket)).statusCode, 401);
  assert.equal((await f.app.inject({ url: "/api/auth/session", headers: human })).statusCode, 200);
});

test("existing members reuse identity across Devices; own-Owner entry is capped to one Team", async (t) => {
  const f = await fixture(t);
  const bob = await f.pair({ displayName: "Bob", roomIds: [] });
  const second = await f.pair({ memberId: bob.memberId, roomIds: [f.rooms[0]!] });
  assert.equal(second.memberId, bob.memberId);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM team_members").get() as { n: number }).n, 2);
  await f.app.inject({ method: "POST", url: "/api/teams", headers: f.headers, payload: { name: "Other Team" } });
  const own = await f.pair({ memberId: f.ownerMemberId, roomIds: [f.rooms[0]!] });
  const ticket = (await f.issue(own.deviceHeaders, own.clientAccessSecret)).json().ticket;
  const signedIn = await f.consume(ticket); assert.equal(signedIn.statusCode, 200, signedIn.body);
  const headers = { cookie: cookie(signedIn), origin };
  assert.equal(signedIn.json().user.canManageOwnerRecovery, false);
  const teams = await f.app.inject({ url: "/api/teams", headers });
  assert.deepEqual(teams.json().map((team: { teamId: string }) => team.teamId), [f.teamId]);
  const members = await f.app.inject({ url: `/api/teams/${f.teamId}/members`, headers });
  assert.equal(members.json().find((m: { memberId: string }) => m.memberId === f.ownerMemberId).role, "member");
  const deniedCommands = [
    { method: "POST" as const, url: "/api/teams", payload: { name: "Escalation" } },
    { method: "GET" as const, url: "/api/auth/owner-recovery" },
    { method: "POST" as const, url: `/api/teams/${f.teamId}/device-pairing-sessions`, payload: { operationId: operation(), claimSecret: secret() } },
    { method: "PATCH" as const, url: `/api/teams/${f.teamId}`, payload: { name: "Escalation" } }
  ];
  for (const command of deniedCommands) assert.equal((await f.app.inject({ ...command, headers })).statusCode, command.method === "PATCH" ? 400 : 403, command.url);
  const fullTeams = (await f.app.inject({ url: "/api/teams", headers: f.headers })).json();
  const other = fullTeams.find((team: { teamId: string }) => team.teamId !== f.teamId);
  assert.equal((await f.app.inject({ url: `/api/teams/${other.teamId}/rooms`, headers })).statusCode, 403);
  const auth = new AuthService(f.database);
  const actor = auth.authenticateWebSession(cookie(signedIn).split("=")[1]!, initialNow);
  assert.throws(() => auth.issueMcpCredential(actor, "agent_missing", initialNow), /full Web login/);
});

test("member-aware pairing rejects old clients, reused secrets, altered retries and invalid targets", async (t) => {
  const f = await fixture(t);
  const flow = await f.pairing({ displayName: "Bob", roomIds: [] });
  const { clientAccessSecret: _key, ...oldClaim } = flow.claimPayload;
  assert.equal((await flow.claim(oldClaim)).statusCode, 400);
  assert.equal((await flow.claim({ ...flow.claimPayload, clientAccessSecret: flow.pollSecret })).statusCode, 400);
  assert.equal((await flow.claim({ ...flow.claimPayload, clientAccessSecret: flow.claimPayload.claimSecret })).statusCode, 400);
  assert.equal((await flow.claim()).statusCode, 200);
  assert.equal((await flow.claim({ ...flow.claimPayload, clientAccessSecret: secret() })).statusCode, 400);
  const changed = await f.app.inject({ method: "POST", url: `/api/teams/${f.teamId}/device-pairing-sessions`, headers: f.headers,
    payload: { ...flow.createPayload, memberBinding: { displayName: "Mallory", roomIds: [] } } });
  assert.equal(changed.statusCode, 409);
  for (const memberBinding of [{ memberId: "member_missing123", roomIds: [] }, { displayName: "Bob", roomIds: ["room_missing123"] },
    { displayName: "Bob", memberId: f.ownerMemberId, roomIds: [] }]) {
    const bad = await f.app.inject({ method: "POST", url: `/api/teams/${f.teamId}/device-pairing-sessions`, headers: f.headers,
      payload: { operationId: operation(), claimSecret: secret(), memberBinding } });
    assert.ok([400, 403].includes(bad.statusCode), bad.body);
  }
  const legacy = await f.pair();
  assert.equal(legacy.memberId, f.ownerMemberId);
  assert.equal((await f.issue(legacy.deviceHeaders, legacy.pollSecret)).statusCode, 401);
  assert.equal((f.database.prepare("SELECT count(*) AS n FROM client_access_grants").get() as { n: number }).n, 0);
});

test("expiry and changed Room membership invalidate tickets without restoring removed humans", async (t) => {
  const f = await fixture(t);
  const bob = await f.pair({ displayName: "Bob", roomIds: [f.rooms[0]!] });
  const expired = (await f.issue(bob.deviceHeaders, bob.clientAccessSecret, f.rooms[0])).json().ticket;
  f.setNow("2026-08-31T12:01:00.000Z");
  assert.equal((await f.consume(expired)).statusCode, 401);
  const ticket = (await f.issue(bob.deviceHeaders, bob.clientAccessSecret, f.rooms[0])).json().ticket;
  f.database.prepare("DELETE FROM room_human_participants WHERE room_id = ? AND member_id = ?").run(f.rooms[0], bob.memberId);
  assert.equal((await f.consume(ticket)).statusCode, 403);
  assert.equal((await f.issue(bob.deviceHeaders, bob.clientAccessSecret, f.rooms[0])).statusCode, 403);
  const repo = new CoreRepository(f.database);
  const agent = { agentId: "agent_memberaware001", teamId: f.teamId, ownerMemberId: bob.memberId, deviceId: bob.deviceId,
    name: "Builder", role: "Builder", integrationMode: "managed" as const,
    capabilities: { supportsStart: true, supportsResume: false, supportsInterrupt: false, supportsStreaming: false },
    enabled: true, presence: "offline" as const, createdAt: initialNow, updatedAt: initialNow };
  repo.createAgent(agent);
  assert.deepEqual(repo.getRoomParticipants(f.rooms[0]!).agentIds, [agent.agentId]);
  assert.deepEqual(repo.getRoomParticipants(f.rooms[1]!).agentIds, []);
  repo.updateAgentPublication(agent);
  assert.equal(repo.getRoomParticipants(f.rooms[0]!).memberIds.includes(bob.memberId), false);
});

test("a waiting browser request reauthenticates after client access is revoked", async (t) => {
  const f = await fixture(t);
  const bob = await f.pair({ displayName: "Bob", roomIds: [f.rooms[0]!] });
  const signedIn = await f.consume((await f.issue(bob.deviceHeaders, bob.clientAccessSecret)).json().ticket);
  const headers = { cookie: cookie(signedIn), origin };
  const snapshot = await f.app.inject({ url: `/api/teams/${f.teamId}/changes?after=9999999`, headers });
  let settled = false;
  const pending = f.app.inject({ url: `/api/teams/${f.teamId}/changes?after=${snapshot.json().cursor}`, headers })
    .then((response) => { settled = true; return response; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  await f.app.inject({ method: "DELETE", url: `/api/teams/${f.teamId}/devices/${bob.deviceId}/client-access`, headers: f.headers });
  const wake = await f.app.inject({ method: "POST", url: `/api/rooms/${f.rooms[0]}/messages`, headers: f.headers,
    payload: { content: "Wake the pending request", mentions: [] } });
  assert.equal(wake.statusCode, 200, wake.body);
  assert.equal((await pending).statusCode, 401);
});

for (const mutation of ["device", "credential", "grant", "lineage", "ownership", "archive"] as const) {
  test(`${mutation} revocation invalidates already-issued tickets and derived Web sessions`, async (t) => {
    const f = await fixture(t);
    const bob = await f.pair({ displayName: "Bob", roomIds: [f.rooms[0]!] });
    const issued = await f.issue(bob.deviceHeaders, bob.clientAccessSecret);
    const signedIn = await f.consume(issued.json().ticket);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const pending = (await f.issue(bob.deviceHeaders, bob.clientAccessSecret)).json().ticket;
    if (mutation === "device") f.database.prepare("UPDATE devices SET status = 'revoked' WHERE device_id = ?").run(bob.deviceId);
    if (mutation === "credential") f.database.prepare("UPDATE device_credentials SET revoked_at = ? WHERE device_id = ?").run(initialNow, bob.deviceId);
    if (mutation === "grant") {
      const revoke = await f.app.inject({ method: "DELETE", url: `/api/teams/${f.teamId}/devices/${bob.deviceId}/client-access`, headers: f.headers });
      assert.equal(revoke.statusCode, 200, revoke.body);
    }
    if (mutation === "lineage") f.database.prepare("DELETE FROM client_access_grants WHERE device_id = ?").run(bob.deviceId);
    if (mutation === "ownership") f.database.prepare("UPDATE devices SET owner_member_id = ? WHERE device_id = ?").run(f.ownerMemberId, bob.deviceId);
    if (mutation === "archive") f.database.prepare("UPDATE teams SET archived_at = ? WHERE team_id = ?").run(initialNow, f.teamId);
    assert.equal((await f.consume(pending)).statusCode, 401);
    assert.equal((await f.app.inject({ url: "/api/auth/session", headers: { cookie: cookie(signedIn) } })).statusCode, 401);
  });
}
