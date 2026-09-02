import assert from "node:assert/strict";
import test from "node:test";

import { fixture } from "./helpers/execution-plan-fixture.js";

const digest = (character: string) => character.repeat(64);

function command(operationId = "op_provider_binding0001") {
  return {
    operationId,
    repositoryId: "repo_00000001",
    providerOrigin: "https://provider.example",
    providerRepositoryId: "owner/repository",
    ciChecks: [{
      checkKey: "unit",
      profileId: "profile_00000001",
      profileRevision: 1,
      profileDigest: digest("a")
    }]
  };
}

test("owner retains and revokes one metadata-only provider binding with exact replay", async (t) => {
  const f = await fixture(t);
  const created = await f.ok(
    "POST", `/api/teams/${f.teamId}/remote-provider-bindings`, command()
  );
  assert.match(created.binding.providerBindingId, /^provider_/u);
  assert.equal(created.binding.teamId, f.teamId);
  assert.equal(created.binding.createdByMemberId, f.ownerMemberId);
  assert.equal(created.revocation, undefined);
  assert.equal(JSON.stringify(created).includes("credential"), false);
  const replay = await f.ok(
    "POST", `/api/teams/${f.teamId}/remote-provider-bindings`, command()
  );
  assert.deepEqual(replay, created);
  const changed = await f.request(
    "POST", `/api/teams/${f.teamId}/remote-provider-bindings`, {
      ...command(), providerRepositoryId: "owner/other"
    }
  );
  assert.equal(changed.statusCode, 409);
  assert.equal(changed.json().error.code, "REMOTE_PROVIDER_OPERATION_CONFLICT");

  const listed = await f.ok(
    "GET", `/api/teams/${f.teamId}/remote-provider-bindings`
  );
  assert.deepEqual(listed.bindings, [created]);
  const bindingId = created.binding.providerBindingId as string;
  const revoked = await f.ok(
    "POST", `/api/remote-provider-bindings/${bindingId}/revocations`, {
      operationId: "op_provider_revoke0001",
      expectedBindingDigest: created.binding.bindingDigest,
      reason: "Owner withdrew remote observation authority"
    }
  );
  assert.equal(revoked.revocation.providerBindingId, bindingId);
  await f.restart();
  const afterRestart = await f.ok(
    "GET", `/api/teams/${f.teamId}/remote-provider-bindings`
  );
  assert.deepEqual(afterRestart.bindings, [revoked]);
  const replayAfterRestart = await f.ok(
    "POST", `/api/remote-provider-bindings/${bindingId}/revocations`, {
      operationId: "op_provider_revoke0001",
      expectedBindingDigest: created.binding.bindingDigest,
      reason: "Owner withdrew remote observation authority"
    }
  );
  assert.deepEqual(replayAfterRestart, revoked);

  assert.throws(() => f.database.prepare(`
    UPDATE remote_provider_bindings SET provider_repository_id = 'other'
    WHERE provider_binding_id = ?
  `).run(bindingId), /immutable/u);
  assert.throws(() => f.database.prepare(`
    DELETE FROM remote_provider_binding_revocations WHERE operation_id = ?
  `).run("op_provider_revoke0001"), /retained/u);
});

test("provider binding rejects foreign authority, secret fields and unsafe origins", async (t) => {
  const f = await fixture(t);
  const participant = await f.participant();
  const forbidden = await f.request(
    "POST", `/api/teams/${f.teamId}/remote-provider-bindings`,
    command("op_provider_binding0002"), participant.authorization
  );
  assert.equal(forbidden.statusCode, 403);
  for (const candidate of [
    { ...command("op_provider_binding0003"), credential: "secret" },
    { ...command("op_provider_binding0004"), providerOrigin: "http://provider.example" },
    { ...command("op_provider_binding0005"), providerOrigin: "https://token@provider.example" },
    { ...command("op_provider_binding0006"), providerOrigin: "https://provider.example/path" }
  ]) {
    const response = await f.request(
      "POST", `/api/teams/${f.teamId}/remote-provider-bindings`, candidate
    );
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal((f.database.prepare(`
    SELECT count(*) AS count FROM remote_provider_bindings
  `).get() as { count: number }).count, 0);
});
