import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import Database from "better-sqlite3";

import { createServerApp } from "../src/app.js";
import { backupDatabase } from "../src/data/backup.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import {
  HostedAgentRepository,
  type HostedCredentialRoot,
  hostedProvider
} from "../src/data/hosted-agent-repository.js";
import { migrateDatabase } from "../src/data/migration-runner.js";
import { AgentService } from "../src/registry/agent-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { createHostedCredentialKeyring } from
  "../src/security/hosted-credential-cipher.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

const now = "2026-08-30T09:00:00.000Z";
const apiKey = "sk-hosted-root-upgrade-secret";
const trustedRoot = {
  mode: "trusted_recovery" as const,
  secret: "owner-recovery-token-0123456789abcdef"
};
const wrongRoot = {
  mode: "trusted_recovery" as const,
  secret: "different-recovery-token-abcdef0123456789"
};
const cleanupMetadataKey = "hosted_credential_root_upgrade_cleanup";

async function fixture(
  context: TestContext,
  root: HostedCredentialRoot = { mode: "local_database" }
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "convene-wire-hosted-root-"));
  const databasePath = path.join(directory, "server.sqlite");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
  context.after(async () => {
    if (database.open) database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(core, auth);
  const created = teams.createTeamForUser({
    userId: "user_hosted_root_owner",
    userDisplayName: "Existing Owner",
    teamName: "Existing Local Team",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-31T09:00:00.000Z"
  );
  const principal = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(principal, created.team.teamId, "general", now);
  const agent = new AgentService(core, auth).publishAgent(principal, {
    teamId: created.team.teamId,
    deviceId: null,
    name: "Hosted Root Test",
    role: "Assistant",
    integrationMode: "hosted",
    capabilities: {
      supportsHandoff: true,
      supportsInterrupt: true,
      supportsResume: false,
      supportsStart: true,
      supportsStreaming: true
    },
    roomIds: [room.roomId],
    now
  });
  const repository = new HostedAgentRepository(database, root);
  const credential = repository.createCredential({
    agentId: agent.agentId,
    teamId: created.team.teamId,
    createdByMemberId: created.owner.memberId,
    apiKey,
    now
  });
  repository.createProfile({
    agentId: agent.agentId,
    teamId: created.team.teamId,
    provider: hostedProvider,
    model: "gpt-5.4-mini",
    credentialVersion: credential.credentialVersion,
    createdByMemberId: created.owner.memberId,
    now
  });
  repository.recordTestObservation({
    agentId: agent.agentId,
    teamId: created.team.teamId,
    profileRevision: 1,
    provider: hostedProvider,
    model: "gpt-5.4-mini",
    observedByMemberId: created.owner.memberId,
    status: "succeeded",
    now
  });
  return { agent, created, database, databasePath, directory, repository };
}

async function assertRootBytesRemoved(databasePath: string, localRoot: Buffer) {
  assert.equal((await readFile(databasePath)).includes(localRoot), false);
  try {
    assert.equal((await readFile(`${databasePath}-wal`)).includes(localRoot), false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

test("local Hosted keyrings adopt trusted authority across restart and online backup", async (t) => {
  const context = await fixture(t);
  const localKeyring = context.database.prepare(`
    SELECT local_root_key FROM hosted_credential_keyrings WHERE key_version = 1
  `).get() as { local_root_key: Buffer };
  // Retiring an old row before secure_delete is enabled can leave a previous
  // copy in a free block. Both the historical and active keyrings must move.
  context.database.prepare(`
    UPDATE hosted_credential_keyrings SET retired_at = ? WHERE key_version = 1
  `).run(now);
  const nextLocalRoot = Buffer.alloc(32, 71);
  const nextKeyring = createHostedCredentialKeyring(nextLocalRoot, 2);
  context.database.prepare(`
    INSERT INTO hosted_credential_keyrings (
      key_version, root_mode, key_derivation, wrapping_cipher, kdf_salt,
      local_root_key, wrapped_data_key_ciphertext, wrapped_data_key_nonce,
      wrapped_data_key_auth_tag, created_at, retired_at
    ) VALUES (2, 'local_database', ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    nextKeyring.wrapped.kdf,
    nextKeyring.wrapped.cipher,
    nextKeyring.wrapped.kdfSalt,
    nextLocalRoot,
    nextKeyring.wrapped.ciphertext,
    nextKeyring.wrapped.nonce,
    nextKeyring.wrapped.tag,
    now
  );
  nextKeyring.dataKey.fill(0);
  const envelopes = context.database.prepare(`
    SELECT key_version, ciphertext, nonce, auth_tag FROM hosted_provider_credentials
  `).all();
  const trusted = new HostedAgentRepository(context.database, trustedRoot);
  assert.equal(trusted.isCredentialAuthorityAvailable(), true);
  assert.equal(trusted.resolveExecutionProfile(context.agent.agentId).apiKey, apiKey);
  assert.deepEqual(context.database.prepare(`
    SELECT root_mode, local_root_key, retired_at FROM hosted_credential_keyrings
    ORDER BY key_version
  `).all(), [
    { root_mode: "trusted_recovery", local_root_key: null, retired_at: now },
    { root_mode: "trusted_recovery", local_root_key: null, retired_at: null }
  ]);
  assert.deepEqual(context.database.prepare(`
    SELECT key_version, ciphertext, nonce, auth_tag FROM hosted_provider_credentials
  `).all(), envelopes);
  assert.equal(context.database.prepare(`
    SELECT 1 FROM system_metadata WHERE key = ?
  `).get(cleanupMetadataKey), undefined);
  assert.throws(() => context.database.prepare(`
    UPDATE hosted_credential_keyrings
    SET root_mode = 'local_database', local_root_key = ? WHERE key_version = 1
  `).run(localKeyring.local_root_key), /keyring update is invalid/u);
  await assertRootBytesRemoved(context.databasePath, localKeyring.local_root_key);
  await assertRootBytesRemoved(context.databasePath, nextLocalRoot);

  const restartedDatabase = openDatabase(context.databasePath);
  try {
    const restarted = new HostedAgentRepository(restartedDatabase, trustedRoot);
    assert.equal(restarted.resolveExecutionProfile(context.agent.agentId).apiKey, apiKey);
    const unavailable = new HostedAgentRepository(restartedDatabase, wrongRoot);
    assert.equal(unavailable.isCredentialAuthorityAvailable(), false);
    assert.equal(unavailable.getAvailability(context.agent.agentId), "degraded");
    assert.throws(
      () => unavailable.resolveExecutionProfile(context.agent.agentId),
      /could not be decrypted/u
    );
    assert.throws(() => unavailable.createCredential({
      agentId: context.agent.agentId,
      teamId: context.created.team.teamId,
      createdByMemberId: context.created.owner.memberId,
      apiKey: "sk-must-not-be-persisted",
      now
    }), /could not be decrypted/u);
    const local = new HostedAgentRepository(restartedDatabase, { mode: "local_database" });
    assert.equal(local.isCredentialAuthorityAvailable(), false);
    assert.throws(
      () => local.resolveExecutionProfile(context.agent.agentId),
      /recovery authority is unavailable/u
    );
  } finally {
    restartedDatabase.close();
  }

  const backupPath = path.join(context.directory, "backups", "trusted.sqlite");
  await backupDatabase(context.databasePath, backupPath);
  await assertRootBytesRemoved(backupPath, localKeyring.local_root_key);
  await assertRootBytesRemoved(backupPath, nextLocalRoot);
  const restoredDatabase = openDatabase(backupPath);
  try {
    const restored = new HostedAgentRepository(restoredDatabase, trustedRoot);
    assert.equal(restored.resolveExecutionProfile(context.agent.agentId).apiKey, apiKey);
    const unavailable = new HostedAgentRepository(restoredDatabase, wrongRoot);
    assert.equal(unavailable.isCredentialAuthorityAvailable(), false);
    assert.throws(
      () => unavailable.resolveExecutionProfile(context.agent.agentId),
      /could not be decrypted/u
    );
  } finally {
    restoredDatabase.close();
  }
});

test("a mismatched trusted keyring rolls back every local root adoption", async (t) => {
  const context = await fixture(t);
  context.database.prepare(`
    UPDATE hosted_credential_keyrings SET retired_at = ? WHERE key_version = 1
  `).run(now);
  const before = context.database.prepare(`
    SELECT * FROM hosted_credential_keyrings WHERE key_version = 1
  `).get();
  const other = createHostedCredentialKeyring(wrongRoot.secret, 2);
  context.database.prepare(`
    INSERT INTO hosted_credential_keyrings (
      key_version, root_mode, key_derivation, wrapping_cipher, kdf_salt,
      local_root_key, wrapped_data_key_ciphertext, wrapped_data_key_nonce,
      wrapped_data_key_auth_tag, created_at, retired_at
    ) VALUES (2, 'trusted_recovery', ?, ?, ?, NULL, ?, ?, ?, ?, NULL)
  `).run(
    other.wrapped.kdf,
    other.wrapped.cipher,
    other.wrapped.kdfSalt,
    other.wrapped.ciphertext,
    other.wrapped.nonce,
    other.wrapped.tag,
    now
  );
  other.dataKey.fill(0);

  const unavailable = new HostedAgentRepository(context.database, trustedRoot);
  assert.equal(unavailable.isCredentialAuthorityAvailable(), false);
  assert.equal(unavailable.getAvailability(context.agent.agentId), "degraded");
  assert.deepEqual(context.database.prepare(`
    SELECT * FROM hosted_credential_keyrings WHERE key_version = 1
  `).get(), before);
  assert.equal(context.database.prepare(`
    SELECT 1 FROM system_metadata WHERE key = ?
  `).get(cleanupMetadataKey), undefined);
  assert.throws(
    () => unavailable.resolveExecutionProfile(context.agent.agentId),
    /could not be decrypted/u
  );
  assert.doesNotThrow(() => context.database.prepare(`
    INSERT INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)
  `).run("ordinary-central-write", "still-available", now));
});

test("interrupted root-page cleanup fails closed and resumes on the next startup", async (t) => {
  const context = await fixture(t);
  const localKeyring = context.database.prepare(`
    SELECT local_root_key FROM hosted_credential_keyrings WHERE key_version = 1
  `).get() as { local_root_key: Buffer };
  const reader = openDatabase(context.databasePath);
  reader.exec("BEGIN");
  reader.prepare("SELECT * FROM hosted_credential_keyrings").all();
  context.database.pragma("busy_timeout = 1");
  try {
    assert.throws(
      () => new HostedAgentRepository(context.database, trustedRoot),
      /root upgrade cleanup is incomplete/u
    );
    assert.deepEqual(context.database.prepare(`
      SELECT root_mode, local_root_key FROM hosted_credential_keyrings
    `).all(), [{ root_mode: "trusted_recovery", local_root_key: null }]);
    assert.ok(context.database.prepare(`
      SELECT 1 FROM system_metadata WHERE key = ?
    `).get(cleanupMetadataKey));
  } finally {
    reader.exec("ROLLBACK");
    reader.close();
  }
  const resumed = new HostedAgentRepository(context.database, trustedRoot);
  assert.equal(resumed.resolveExecutionProfile(context.agent.agentId).apiKey, apiKey);
  assert.equal(context.database.prepare(`
    SELECT 1 FROM system_metadata WHERE key = ?
  `).get(cleanupMetadataKey), undefined);
  await assertRootBytesRemoved(context.databasePath, localKeyring.local_root_key);
});

test("Central closes its database when Hosted root cleanup interrupts startup", async (t) => {
  const context = await fixture(t);
  context.database.close();
  let failedDatabase: Database.Database | undefined;
  const originalExec = Database.prototype.exec;
  const failure = t.mock.method(
    Database.prototype,
    "exec",
    function (this: Database.Database, source: string) {
      if (source === "VACUUM") {
        failedDatabase = this;
        throw new Error("injected root cleanup failure");
      }
      return originalExec.call(this, source);
    }
  );
  const options = {
    databasePath: context.databasePath,
    clock: () => now,
    webAuth: {
      mode: "trusted-team" as const,
      ownerRecoveryToken: trustedRoot.secret,
      publicOrigin: "https://team.example.com"
    }
  };
  try {
    await assert.rejects(createServerApp(options), /root upgrade cleanup is incomplete/u);
    assert.ok(failedDatabase);
    assert.equal(failedDatabase.open, false);
  } finally {
    failure.mock.restore();
  }
  const resumed = await createServerApp(options);
  try {
    assert.equal((await resumed.inject({
      method: "GET",
      url: "/api/health/ready"
    })).statusCode, 200);
  } finally {
    await resumed.close();
  }
});

test("Owner adoption upgrades Hosted roots while a later wrong root leaves Central usable", async (t) => {
  const context = await fixture(t);
  context.database.close();
  const publicOrigin = "https://team.example.com";
  const trusted = await createServerApp({
    databasePath: context.databasePath,
    clock: () => now,
    webAuth: {
      mode: "trusted-team",
      ownerRecoveryToken: trustedRoot.secret,
      publicOrigin
    }
  });
  try {
    const adopted = await trusted.inject({
      method: "POST",
      url: "/api/auth/setup",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": trustedRoot.secret
      },
      payload: { displayName: "Ignored replacement" }
    });
    assert.equal(adopted.statusCode, 200, adopted.body);
    assert.equal(adopted.json().user.userId, context.created.owner.userId);
    assert.equal(adopted.json().user.displayName, "Existing Owner");
  } finally {
    await trusted.close();
  }

  const restarted = await createServerApp({
    databasePath: context.databasePath,
    clock: () => now,
    webAuth: {
      mode: "trusted-team",
      ownerRecoveryToken: wrongRoot.secret,
      publicOrigin
    }
  });
  try {
    assert.equal((await restarted.inject({
      method: "GET",
      url: "/api/health/ready"
    })).statusCode, 200);
    const recovered = await restarted.inject({
      method: "POST",
      url: "/api/auth/recover-owner",
      headers: {
        origin: publicOrigin,
        "x-agent-room-recovery-token": wrongRoot.secret
      },
      payload: {}
    });
    assert.equal(recovered.statusCode, 200, recovered.body);
    const cookie = String(recovered.headers["set-cookie"]).split(";")[0] ?? "";
    assert.equal((await restarted.inject({
      method: "GET",
      url: "/api/teams",
      headers: { cookie }
    })).statusCode, 200);
    const agents = await restarted.inject({
      method: "GET",
      url: `/api/teams/${context.created.team.teamId}/agents`,
      headers: { cookie }
    });
    assert.equal(agents.statusCode, 200, agents.body);
    assert.equal(agents.json().find((agent: { agentId: string }) =>
      agent.agentId === context.agent.agentId
    ).presence, "degraded");
  } finally {
    await restarted.close();
  }
});
