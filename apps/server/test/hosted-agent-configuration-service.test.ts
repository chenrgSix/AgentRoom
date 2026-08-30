import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import {
  HostedAgentRepository,
  hostedProvider
} from "../src/data/hosted-agent-repository.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { SqliteTransactionBoundary } from
  "../src/data/sqlite-transaction-boundary.js";
import {
  HostedAgentConfigurationService,
  type HostedProviderProbe
} from "../src/hosted/hosted-agent-configuration-service.js";
import { AgentService } from "../src/registry/agent-service.js";
import { AuthService, AuthorizationError } from
  "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-30T03:00:00.000Z";

async function fixture(options: {
  probe?: HostedProviderProbe;
  root?: ConstructorParameters<typeof HostedAgentRepository>[1];
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-config-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  const transactions = new SqliteTransactionBoundary(database);
  const core = new CoreRepository(database, transactions);
  const auth = new AuthService(database);
  const teamRooms = new TeamRoomService(core, auth);
  const agents = new AgentService(core, auth);
  const created = teamRooms.createTeamForUser({
    userId: "user_hostedowner12345678",
    userDisplayName: "Alice",
    teamName: "Hosted Team",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-31T03:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teamRooms.createRoom(principal, created.team.teamId, "general", now);
  const repository = new HostedAgentRepository(
    database,
    options.root ?? { mode: "local_database" },
    transactions
  );
  const calls: Array<{ model: string; apiKey: string }> = [];
  const probe = options.probe ?? {
    async test(input) {
      calls.push({ model: input.model, apiKey: input.apiKey });
      return { status: "ready" as const };
    }
  };
  const service = new HostedAgentConfigurationService(
    repository,
    core,
    agents,
    auth,
    transactions,
    probe
  );
  return {
    agents,
    auth,
    calls,
    core,
    created,
    database,
    databasePath,
    principal,
    repository,
    room,
    service,
    teamRooms
  };
}

test("Hosted Agent configuration is explicit, encrypted, revisioned, and recoverable", async () => {
  const context = await fixture();
  const firstKey = "sk-first-hosted-secret";
  const secondKey = "sk-second-hosted-secret";
  try {
    const created = await context.service.create(context.principal, {
      teamId: context.created.team.teamId,
      name: "Central Writer",
      role: "Remote model",
      provider: hostedProvider,
      model: "gpt-5.4-mini",
      apiKey: firstKey,
      roomIds: [context.room.roomId],
      now
    });
    assert.equal(created.presence, "ready");
    assert.deepEqual(created.roomIds, [context.room.roomId]);
    assert.equal(created.credentialConfigured, true);
    assert.equal(created.credentialRevoked, false);
    assert.equal(created.latestTest?.status, "succeeded");
    assert.equal(JSON.stringify(created).includes(firstKey), false);
    assert.equal(context.repository.resolveExecutionProfile(created.agentId).apiKey, firstKey);

    const keyring = context.database.prepare(`
      SELECT root_mode, local_root_key, kdf_salt FROM hosted_credential_keyrings
    `).get() as {
      root_mode: string;
      local_root_key: Buffer;
      kdf_salt: Buffer;
    };
    assert.equal(keyring.root_mode, "local_database");
    assert.equal(keyring.local_root_key.byteLength, 32);
    assert.equal(keyring.kdf_salt.byteLength, 32);
    const stored = context.database.prepare(`
      SELECT ciphertext, nonce, auth_tag FROM hosted_provider_credentials
      WHERE agent_id = ?
    `).all(created.agentId) as Array<Record<string, Buffer>>;
    assert.equal(stored.length, 1);
    assert.equal(
      stored.some((row) => Object.values(row).some((value) =>
        value.includes(Buffer.from(firstKey, "utf8"))
      )),
      false
    );

    const updated = await context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 1,
      model: "gpt-5.4",
      apiKey: secondKey,
      now: "2026-08-30T03:01:00.000Z"
    });
    assert.equal(updated.profileRevision, 2);
    assert.equal(updated.model, "gpt-5.4");
    assert.equal(
      context.repository.resolveExecutionProfile(created.agentId).apiKey,
      secondKey
    );
    const versions = context.database.prepare(`
      SELECT credential_version, revoked_at, replaced_by_version
      FROM hosted_provider_credentials WHERE agent_id = ?
      ORDER BY credential_version
    `).all(created.agentId) as Array<{
      credential_version: number;
      revoked_at: string | null;
      replaced_by_version: number | null;
    }>;
    assert.deepEqual(versions.map((row) => ({
      version: row.credential_version,
      revoked: row.revoked_at !== null,
      replacedBy: row.replaced_by_version
    })), [
      { version: 1, revoked: true, replacedBy: 2 },
      { version: 2, revoked: false, replacedBy: null }
    ]);
    assert.equal(context.calls.length, 2);

    const revoked = context.service.revokeCredential(
      context.principal,
      created.agentId,
      2,
      "2026-08-30T03:02:00.000Z"
    );
    assert.equal(revoked.credentialRevoked, true);
    assert.equal(revoked.presence, "degraded");
    assert.throws(
      () => context.repository.resolveExecutionProfile(created.agentId),
      /credential is unavailable/u
    );

    const restored = await context.service.updateProfile(context.principal, {
      agentId: created.agentId,
      expectedProfileRevision: 2,
      model: "gpt-5.4-mini",
      apiKey: "sk-restored-hosted-secret",
      now: "2026-08-30T03:03:00.000Z"
    });
    assert.equal(restored.profileRevision, 3);
    assert.equal(restored.credentialRevoked, false);
    assert.equal(restored.presence, "ready");
    assert.equal(
      context.repository.resolveExecutionProfile(created.agentId).apiKey,
      "sk-restored-hosted-secret"
    );
    assert.equal(context.calls.length, 3);
  } finally {
    context.database.close();
  }
});

test("Hosted configuration fails closed before persistence and enforces Owner scope", async () => {
  const context = await fixture({
    probe: {
      async test() {
        return {
          status: "failed",
          failureCode: "HOSTED_PROVIDER_AUTH_REJECTED"
        };
      }
    }
  });
  try {
    await assert.rejects(
      context.service.create(context.principal, {
        teamId: context.created.team.teamId,
        name: "Rejected",
        role: "Remote model",
        provider: hostedProvider,
        model: "gpt-5.4-mini",
        apiKey: "sk-rejected-secret",
        roomIds: [context.room.roomId],
        now
      }),
      /connection test failed/u
    );
    assert.equal(
      (context.database.prepare(`SELECT count(*) AS count FROM agents`)
        .get() as { count: number }).count,
      0
    );

    const memberUserId = "user_hostedmember1234567";
    context.core.createUser({
      userId: memberUserId,
      displayName: "Bob",
      createdAt: now
    });
    context.core.createMember({
      memberId: "member_hostedmember12345",
      teamId: context.created.team.teamId,
      userId: memberUserId,
      displayName: "Bob",
      role: "member",
      createdAt: now
    });
    const memberSession = context.auth.issueWebSession(
      memberUserId,
      now,
      "2026-08-31T03:00:00.000Z"
    );
    const memberPrincipal = context.auth.authenticateWebSession(
      memberSession.secret,
      now
    );
    await assert.rejects(
      context.service.testConnection(memberPrincipal, {
        teamId: context.created.team.teamId,
        provider: hostedProvider,
        model: "gpt-5.4-mini",
        apiKey: "sk-member-secret",
        now
      }),
      (error: unknown) => error instanceof AuthorizationError &&
        error.code === "FORBIDDEN"
    );
  } finally {
    context.database.close();
  }
});

test("trusted Hosted credential envelopes require the original recovery authority", async () => {
  const root = {
    mode: "trusted_recovery" as const,
    secret: "owner-recovery-token-0123456789abcdef"
  };
  const context = await fixture({ root });
  try {
    const created = await context.service.create(context.principal, {
      teamId: context.created.team.teamId,
      name: "Trusted Hosted",
      role: "Remote model",
      provider: hostedProvider,
      model: "gpt-5.4-mini",
      apiKey: "sk-trusted-secret",
      roomIds: [context.room.roomId],
      now
    });
    const keyring = context.database.prepare(`
      SELECT root_mode, local_root_key FROM hosted_credential_keyrings
    `).get() as { root_mode: string; local_root_key: Buffer | null };
    assert.equal(keyring.root_mode, "trusted_recovery");
    assert.equal(keyring.local_root_key, null);
    const wrong = new HostedAgentRepository(context.database, {
      mode: "trusted_recovery",
      secret: "wrong-recovery-token-abcdef0123456789"
    });
    assert.throws(
      () => wrong.resolveExecutionProfile(created.agentId),
      /could not be decrypted/u
    );
  } finally {
    context.database.close();
  }
});
