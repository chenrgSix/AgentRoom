import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createServerApp } from "../src/app.js";

const origin = "https://team.example.com";
const ownerRecoveryToken = "long-poll-owner-recovery-test-0123456789abcdef";

function cookie(response: { headers: Record<string, unknown> }): string {
  const match = /^(__Host-agentroom_session=[^;]+)/u.exec(String(response.headers["set-cookie"]));
  assert.ok(match);
  return match[1];
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convenewire-recovery-long-poll-"));
  const app = await createServerApp({
    databasePath: path.join(directory, "server.sqlite"),
    clock: () => "2026-08-31T01:00:00.000Z",
    webAuth: { mode: "trusted-team", ownerRecoveryToken, publicOrigin: origin }
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const setup = await app.inject({
    method: "POST", url: "/api/auth/setup",
    headers: { origin, "x-agent-room-recovery-token": ownerRecoveryToken },
    payload: { displayName: "Owner" }
  });
  assert.equal(setup.statusCode, 200);
  const ownerHeaders = { cookie: cookie(setup), origin };
  const created = await app.inject({
    method: "POST", url: "/api/teams", headers: ownerHeaders,
    payload: { name: "Recovery polling" }
  });
  assert.equal(created.statusCode, 200);
  const teamId = created.json().team.teamId as string;
  const invited = await app.inject({
    method: "POST", url: `/api/teams/${teamId}/member-invitations`,
    headers: ownerHeaders, payload: { displayName: "Member" }
  });
  assert.equal(invited.statusCode, 200);
  const claimed = await app.inject({
    method: "POST", url: "/api/auth/member-invitations/claim", headers: { origin },
    payload: { token: String(invited.json().claimUrl).split("/#/join/")[1] }
  });
  assert.equal(claimed.statusCode, 200);
  const memberId = claimed.json().member.memberId as string;
  const memberHeaders = { cookie: cookie(claimed), origin };
  const room = await app.inject({
    method: "POST", url: `/api/teams/${teamId}/rooms`, headers: ownerHeaders,
    payload: { name: "Events after recovery" }
  });
  assert.equal(room.statusCode, 200);
  const roomId = room.json().roomId as string;
  return {
    app, teamId, roomId, memberId, ownerHeaders, memberHeaders,
    async beginPoll() {
      const checkpoint = await app.inject({
        method: "GET", url: `/api/teams/${teamId}/changes?after=0`, headers: memberHeaders
      });
      assert.equal(checkpoint.statusCode, 200);
      let settled = false;
      const pending = app.inject({
        method: "GET", url: `/api/teams/${teamId}/changes?after=${checkpoint.json().cursor as number}`,
        headers: memberHeaders
      }).then((response) => { settled = true; return response; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false, "the authenticated request must be waiting before authority changes");
      return { pending };
    },
    async publishMessage() {
      const response = await app.inject({
        method: "POST", url: `/api/rooms/${roomId}/messages`, headers: ownerHeaders,
        payload: { content: "Change created after the prior authentication check" }
      });
      assert.equal(response.statusCode, 200);
    }
  };
}

test("member recovery rejects an already waiting poll from the revoked session", async (t) => {
  const f = await fixture(t);
  // Issue before opening the poll so issuance's own Team-change event does not
  // settle the old browser's request before the recovery invalidates it.
  const issued = await f.app.inject({
    method: "POST", url: `/api/teams/${f.teamId}/members/${f.memberId}/recovery`,
    headers: f.ownerHeaders
  });
  assert.equal(issued.statusCode, 200);
  const { pending } = await f.beginPoll();
  const recovered = await f.app.inject({
    method: "POST", url: "/api/auth/recover-member", headers: { origin },
    payload: { token: issued.json().token }
  });
  assert.equal(recovered.statusCode, 200);
  assert.equal((await f.app.inject({
    method: "GET", url: "/api/auth/session", headers: f.memberHeaders
  })).statusCode, 401);
  await f.publishMessage();
  const oldPoll = await pending;
  assert.equal(oldPoll.statusCode, 401);
  assert.equal(oldPoll.json().error.code, "UNAUTHENTICATED");
  assert.equal(oldPoll.headers["cache-control"], "no-store");
  assert.equal(oldPoll.json().roomIds, undefined);
  assert.equal(oldPoll.body.includes(f.roomId), false);
  const newPoll = await f.app.inject({
    method: "GET", url: `/api/teams/${f.teamId}/changes?after=0`,
    headers: { cookie: cookie(recovered), origin }
  });
  assert.equal(newPoll.statusCode, 200);
  assert.ok(newPoll.json().roomIds.includes(f.roomId));
});

test("a waiting poll rechecks Team access even when its session remains valid", async (t) => {
  const f = await fixture(t);
  const { pending } = await f.beginPoll();
  const archived = await f.app.inject({
    method: "PATCH", url: `/api/teams/${f.teamId}`, headers: f.ownerHeaders,
    payload: { archived: true }
  });
  assert.equal(archived.statusCode, 200);
  const oldPoll = await pending;
  assert.equal(oldPoll.statusCode, 403);
  assert.equal(oldPoll.json().error.code, "FORBIDDEN");
  assert.equal(oldPoll.json().roomIds, undefined);
  assert.equal((await f.app.inject({
    method: "GET", url: "/api/auth/session", headers: f.memberHeaders
  })).statusCode, 200, "Team revocation is distinct from an expired Web session");
});

test("a waiting poll still returns changes when session and Team access remain valid", async (t) => {
  const f = await fixture(t);
  const { pending } = await f.beginPoll();
  await f.publishMessage();
  const poll = await pending;
  assert.equal(poll.statusCode, 200);
  assert.ok(poll.json().roomIds.includes(f.roomId));
});
