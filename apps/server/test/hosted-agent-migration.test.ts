import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { openDatabase } from "../src/data/database.js";
import {
  defaultMigrationsDirectory,
  migrateDatabase
} from "../src/data/migration-runner.js";

const now = "2026-08-30T08:00:00.000Z";

async function temporaryDirectory(name: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), `convene-wire-${name}-`));
}

async function copyMigrationsBefore(
  target: string,
  cutoff: string
): Promise<void> {
  await mkdir(target, { recursive: true });
  const entries = (await readdir(defaultMigrationsDirectory))
    .filter((name) => /^[0-9]{4}_.+\.sql$/u.test(name) && name < cutoff)
    .sort();
  for (const entry of entries) {
    await writeFile(
      path.join(target, entry),
      await readFile(path.join(defaultMigrationsDirectory, entry), "utf8"),
      "utf8"
    );
  }
}

async function writeMigration(
  directory: string,
  filename: string,
  sql: string
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), sql, "utf8");
}

test("Hosted migration preserves version-51 Agent foreign-key graphs", async () => {
  const directory = await temporaryDirectory("hosted-upgrade");
  const databasePath = path.join(directory, "server.sqlite");
  const legacyMigrations = path.join(directory, "legacy-migrations");
  await copyMigrationsBefore(legacyMigrations, "0052_");
  await migrateDatabase(databasePath, legacyMigrations);

  const legacy = openDatabase(databasePath);
  try {
    legacy.exec(`
      INSERT INTO web_users (user_id, display_name, created_at)
      VALUES ('user_hosted_upgrade', 'Owner', '${now}');
      INSERT INTO teams (team_id, name, created_at)
      VALUES ('team_hosted_upgrade', 'Hosted Upgrade', '${now}');
      INSERT INTO team_members (
        member_id, team_id, user_id, display_name, role, created_at
      ) VALUES (
        'member_hosted_upgrade', 'team_hosted_upgrade',
        'user_hosted_upgrade', 'Owner', 'owner', '${now}'
      );
      INSERT INTO rooms (
        room_id, team_id, name, next_message_sequence, created_at
      ) VALUES (
        'room_hosted_upgrade', 'team_hosted_upgrade', 'general', 1, '${now}'
      );
      INSERT INTO devices (
        device_id, team_id, owner_member_id, name, status, created_at
      ) VALUES (
        'device_hosted_upgrade', 'team_hosted_upgrade',
        'member_hosted_upgrade', 'Managed Device', 'active', '${now}'
      );
      INSERT INTO agents (
        agent_id, team_id, owner_member_id, device_id, name, role,
        integration_mode, capabilities_json, enabled, presence, created_at,
        updated_at, runtime_scope_id, workspace_ref, workspace_generation,
        runtime_policy_json, workspace_alias
      ) VALUES
        (
          'agent_hosted_managed', 'team_hosted_upgrade',
          'member_hosted_upgrade', 'device_hosted_upgrade', 'Managed',
          'Builder', 'managed',
          '{"supportsHandoff":true,"supportsInterrupt":true,"supportsResume":false,"supportsStart":true,"supportsStreaming":true}',
          1, 'ready', '${now}', '${now}',
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'workspace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          '{"filesystemAccess":"workspace-write"}', 'source'
        ),
        (
          'agent_hosted_manual', 'team_hosted_upgrade',
          'member_hosted_upgrade', NULL, 'Manual', 'Reviewer', 'manual',
          '{"supportsHandoff":true,"supportsInterrupt":false,"supportsResume":false,"supportsStart":false,"supportsStreaming":false}',
          1, 'manual', '${now}', '${now}', NULL, NULL, NULL, NULL, NULL
        );
      INSERT INTO room_human_participants (room_id, member_id, added_at)
      VALUES ('room_hosted_upgrade', 'member_hosted_upgrade', '${now}');
      INSERT INTO room_agent_participants (room_id, agent_id, added_at)
      VALUES
        ('room_hosted_upgrade', 'agent_hosted_managed', '${now}'),
        ('room_hosted_upgrade', 'agent_hosted_manual', '${now}');
      INSERT INTO mcp_credentials (
        credential_id, agent_id, member_id, token_hash, created_at
      ) VALUES (
        'mcpcred_hosted_upgrade', 'agent_hosted_manual',
        'member_hosted_upgrade',
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        '${now}'
      );
      INSERT INTO task_agent_assignments (
        task_id, agent_id, role, assigned_by_member_id, assigned_at
      ) VALUES (
        'task_default_hosted_upgrade', 'agent_hosted_managed', 'primary',
        'member_hosted_upgrade', '${now}'
      );
      INSERT INTO messages (
        message_id, room_id, sequence, sender_type, sender_id, content,
        parent_message_id, created_at, trace_id, task_id
      ) VALUES (
        'msg_hosted_upgrade', 'room_hosted_upgrade', 1, 'member',
        'member_hosted_upgrade', 'Preserve this Run.', NULL, '${now}',
        'trace_hosted_upgrade', 'task_default_hosted_upgrade'
      );
      INSERT INTO runs (
        run_id, room_id, trigger_message_id, requester_member_id,
        target_agent_id, instruction, state, last_sequence, deadline_at,
        created_at, updated_at, trace_id, task_id, attempt_number
      ) VALUES (
        'run_hosted_upgrade', 'room_hosted_upgrade', 'msg_hosted_upgrade',
        'member_hosted_upgrade', 'agent_hosted_managed', 'Preserve this Run.',
        'queued', 0, '2026-08-30T08:20:00.000Z', '${now}', '${now}',
        'trace_hosted_upgrade', 'task_default_hosted_upgrade', 1
      );
    `);
  } finally {
    legacy.close();
  }

  const migrated = await migrateDatabase(databasePath);
  assert.deepEqual(migrated.appliedVersions, [52, 53]);

  const database = openDatabase(databasePath);
  try {
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(database.prepare(`
      SELECT
        (SELECT count(*) FROM agents WHERE team_id = 'team_hosted_upgrade')
          AS agents,
        (SELECT count(*) FROM room_agent_participants
          WHERE room_id = 'room_hosted_upgrade') AS room_agents,
        (SELECT count(*) FROM mcp_credentials
          WHERE credential_id = 'mcpcred_hosted_upgrade') AS mcp_credentials,
        (SELECT count(*) FROM runs WHERE run_id = 'run_hosted_upgrade') AS runs
    `).get(), {
      agents: 2,
      room_agents: 2,
      mcp_credentials: 1,
      runs: 1
    });
    assert.deepEqual(database.prepare(`
      SELECT runtime_scope_id, workspace_ref, workspace_generation,
             runtime_policy_json, workspace_alias
      FROM agents WHERE agent_id = 'agent_hosted_managed'
    `).get(), {
      runtime_scope_id:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      workspace_ref:
        "workspace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      workspace_generation:
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      runtime_policy_json: '{"filesystemAccess":"workspace-write"}',
      workspace_alias: "source"
    });
    const triggerCount = database.prepare(`
      SELECT count(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'workspace_leases_require_scope_insert',
        'task_results_require_proposer_scope_insert'
      )
    `).get() as { count: number };
    assert.equal(triggerCount.count, 2);

    database.prepare(`
      INSERT INTO agents (
        agent_id, team_id, owner_member_id, device_id, name, role,
        integration_mode, capabilities_json, enabled, presence, created_at,
        updated_at, runtime_scope_id, workspace_ref, workspace_generation,
        runtime_policy_json, workspace_alias
      ) VALUES (?, ?, ?, NULL, ?, ?, 'hosted', ?, 1, 'degraded', ?, ?,
        NULL, NULL, NULL, NULL, NULL)
    `).run(
      "agent_hosted_central",
      "team_hosted_upgrade",
      "member_hosted_upgrade",
      "Central",
      "Assistant",
      '{"supportsHandoff":true,"supportsInterrupt":true,"supportsResume":false,"supportsStart":true,"supportsStreaming":true}',
      now,
      now
    );
    assert.throws(() => database.prepare(`
      INSERT INTO agents (
        agent_id, team_id, owner_member_id, name, role, integration_mode,
        capabilities_json, enabled, presence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'unknown', '{}', 1, 'offline', ?, ?)
    `).run(
      "agent_hosted_unknown",
      "team_hosted_upgrade",
      "member_hosted_upgrade",
      "Unknown",
      "Unknown",
      now,
      now
    ), /CHECK constraint failed/u);

    database.exec(`
      INSERT INTO room_agent_participants (room_id, agent_id, added_at)
      VALUES (
        'room_hosted_upgrade', 'agent_hosted_central', '${now}'
      );
      INSERT INTO task_agent_assignments (
        task_id, agent_id, role, assigned_by_member_id, assigned_at
      ) VALUES (
        'task_default_hosted_upgrade', 'agent_hosted_central', 'contributor',
        'member_hosted_upgrade', '${now}'
      );
      INSERT INTO runs (
        run_id, room_id, trigger_message_id, requester_member_id,
        target_agent_id, instruction, state, last_sequence, deadline_at,
        created_at, updated_at, trace_id, task_id, attempt_number
      ) VALUES (
        'run_hosted_central', 'room_hosted_upgrade', 'msg_hosted_upgrade',
        'member_hosted_upgrade', 'agent_hosted_central', 'Run centrally.',
        'queued', 0, '2026-08-30T08:20:00.000Z', '${now}', '${now}',
        'trace_hosted_central', 'task_default_hosted_upgrade', 2
      );
    `);

    const insertKeyring = database.prepare(`
      INSERT INTO hosted_credential_keyrings (
        key_version, root_mode, key_derivation, wrapping_cipher, kdf_salt,
        local_root_key, wrapped_data_key_ciphertext, wrapped_data_key_nonce,
        wrapped_data_key_auth_tag, created_at, retired_at
      ) VALUES (?, ?, 'hkdf-sha256', 'aes-256-gcm', ?, ?, ?, ?, ?, ?, ?)
    `);
    assert.throws(() => insertKeyring.run(
      1,
      "trusted_recovery",
      Buffer.alloc(32, 1),
      Buffer.alloc(32, 2),
      Buffer.alloc(32, 3),
      Buffer.alloc(12, 4),
      Buffer.alloc(16, 5),
      now,
      now
    ), /CHECK constraint failed/u);
    insertKeyring.run(
      1,
      "local_database",
      Buffer.alloc(32, 1),
      Buffer.alloc(32, 2),
      Buffer.alloc(32, 3),
      Buffer.alloc(12, 4),
      Buffer.alloc(16, 5),
      now,
      null
    );

    const insertCredential = database.prepare(`
      INSERT INTO hosted_provider_credentials (
        agent_id, credential_version, credential_id, team_id, provider,
        key_version, encryption_cipher, ciphertext, nonce, auth_tag,
        created_by_member_id, created_at, revoked_at, replaced_by_version
      ) VALUES (
        'agent_hosted_central', 1, 'hostedcred_migration_v1',
        'team_hosted_upgrade', 'openai_responses', 1, 'aes-256-gcm', ?, ?, ?,
        'member_hosted_upgrade', ?, NULL, NULL
      )
    `);
    assert.throws(() => insertCredential.run(
      Buffer.alloc(15, 6),
      Buffer.alloc(12, 7),
      Buffer.alloc(16, 8),
      now
    ), /CHECK constraint failed/u);
    insertCredential.run(
      Buffer.alloc(16, 6),
      Buffer.alloc(12, 7),
      Buffer.alloc(16, 8),
      now
    );

    const insertProfile = database.prepare(`
      INSERT INTO hosted_runtime_profiles (
        agent_id, profile_revision, team_id, provider, model,
        credential_version, execution_limits_json, created_by_member_id,
        created_at, superseded_at
      ) VALUES (
        'agent_hosted_central', ?, 'team_hosted_upgrade',
        'openai_responses', 'gpt-hosted-test', 1, ?,
        'member_hosted_upgrade', ?, NULL
      )
    `);
    assert.throws(() => insertProfile.run(
      2,
      '{"maxInputCharacters":60000,"maxOutputCharacters":20000,"timeoutSeconds":120}',
      now
    ), /revision is not monotonic/u);
    insertProfile.run(
      1,
      '{"maxInputCharacters":60000,"maxOutputCharacters":20000,"timeoutSeconds":120}',
      now
    );

    database.prepare(`
      INSERT INTO hosted_provider_test_observations (
        observation_id, operation_id, team_id, agent_id, profile_revision,
        provider, model, status, failure_code, observed_by_member_id,
        observed_at
      ) VALUES (
        'hostedtest_migration', 'op_hosted_migration',
        'team_hosted_upgrade', 'agent_hosted_central', 1,
        'openai_responses', 'gpt-hosted-test', 'succeeded', NULL,
        'member_hosted_upgrade', ?
      )
    `).run(now);

    const insertInvocation = database.prepare(`
      INSERT INTO hosted_invocation_intents (
        invocation_id, run_id, team_id, agent_id, profile_revision,
        credential_version, provider, model, deadline_at, prompt_sha256,
        idempotency_key, state, failure_code, prepared_at, dispatched_at,
        streaming_at, cancellation_requested_at,
        cancellation_requested_by_member_id, cancellation_reason, terminal_at,
        updated_at
      ) VALUES (
        'hostedinv_migration', 'run_hosted_central', 'team_hosted_upgrade',
        'agent_hosted_central', 1, 1, 'openai_responses', 'gpt-hosted-test',
        '2026-08-30T08:20:00.000Z',
        'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        'hosted-migration-intent', ?, NULL, ?, ?, NULL, NULL, NULL, NULL,
        NULL, ?
      )
    `);
    assert.throws(() => insertInvocation.run(
      "dispatching",
      now,
      "2026-08-30T08:01:00.000Z",
      "2026-08-30T08:01:00.000Z"
    ), /must begin prepared/u);
    insertInvocation.run("prepared", now, null, now);
    database.prepare(`
      UPDATE hosted_invocation_intents
      SET state = 'dispatching', dispatched_at = ?, updated_at = ?
      WHERE invocation_id = 'hostedinv_migration'
    `).run(
      "2026-08-30T08:01:00.000Z",
      "2026-08-30T08:01:00.000Z"
    );
    database.prepare(`
      UPDATE hosted_invocation_intents
      SET cancellation_requested_at = ?,
          cancellation_requested_by_member_id = 'member_hosted_upgrade',
          cancellation_reason = 'Stop requested', updated_at = ?
      WHERE invocation_id = 'hostedinv_migration'
    `).run(
      "2026-08-30T08:02:00.000Z",
      "2026-08-30T08:02:00.000Z"
    );
    assert.throws(() => database.prepare(`
      UPDATE hosted_invocation_intents
      SET state = 'canceled', failure_code = 'HOSTED_CANCELED',
          terminal_at = ?, updated_at = ?
      WHERE invocation_id = 'hostedinv_migration'
    `).run(
      "2026-08-30T08:03:00.000Z",
      "2026-08-30T08:03:00.000Z"
    ), /state transition is invalid/u);
    database.prepare(`
      UPDATE hosted_invocation_intents
      SET state = 'outcome_unknown', failure_code = 'HOSTED_CANCEL_AMBIGUOUS',
          terminal_at = ?, updated_at = ?
      WHERE invocation_id = 'hostedinv_migration'
    `).run(
      "2026-08-30T08:03:00.000Z",
      "2026-08-30T08:03:00.000Z"
    );
    assert.deepEqual(database.prepare(`
      SELECT state, cancellation_requested_by_member_id
      FROM hosted_invocation_intents
      WHERE invocation_id = 'hostedinv_migration'
    `).get(), {
      state: "outcome_unknown",
      cancellation_requested_by_member_id: "member_hosted_upgrade"
    });
    assert.throws(() => database.prepare(`
      DELETE FROM hosted_invocation_intents
      WHERE invocation_id = 'hostedinv_migration'
    `).run(), /retained evidence/u);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }

  const reopened = openDatabase(databasePath);
  try {
    assert.equal(reopened.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(reopened.pragma("foreign_key_check"), []);
    assert.equal((reopened.prepare(`
      SELECT count(*) AS count FROM schema_migrations WHERE version IN (52, 53)
    `).get() as { count: number }).count, 2);
  } finally {
    reopened.close();
  }
});

test("foreign-key-off migration rolls back when its final graph is invalid", async () => {
  const directory = await temporaryDirectory("migration-fk-rollback");
  const migrations = path.join(directory, "migrations");
  const databasePath = path.join(directory, "server.sqlite");
  await writeMigration(migrations, "0001_parent.sql", `
    CREATE TABLE parents (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO parents VALUES (1);
    INSERT INTO children VALUES (1, 1);
  `);
  await writeMigration(migrations, "0002_invalid_rebuild.sql", `-- convenewire:migration foreign_keys=off
    CREATE TABLE parents_v2 (id INTEGER PRIMARY KEY) STRICT;
    INSERT INTO parents_v2 SELECT * FROM parents;
    DROP TABLE parents;
    ALTER TABLE parents_v2 RENAME TO parents;
    DELETE FROM parents WHERE id = 1;
  `);

  await assert.rejects(
    migrateDatabase(databasePath, migrations),
    /violates foreign key constraints/u
  );

  const database = openDatabase(databasePath);
  try {
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.equal((database.prepare("SELECT count(*) AS count FROM parents")
      .get() as { count: number }).count, 1);
    assert.equal((database.prepare("SELECT count(*) AS count FROM children")
      .get() as { count: number }).count, 1);
    assert.deepEqual(database.prepare(`
      SELECT version FROM schema_migrations ORDER BY version
    `).all(), [{ version: 1 }]);
  } finally {
    database.close();
  }
});

test("foreign-key-off migration restores enforcement before the next migration", async () => {
  const directory = await temporaryDirectory("migration-fk-restore");
  const migrations = path.join(directory, "migrations");
  const databasePath = path.join(directory, "server.sqlite");
  await writeMigration(migrations, "0001_parent.sql", `
    CREATE TABLE parents (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE children (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parents(id) ON DELETE RESTRICT
    ) STRICT;
    INSERT INTO parents VALUES (1);
    INSERT INTO children VALUES (1, 1);
  `);
  await writeMigration(migrations, "0002_rebuild.sql", `-- convenewire:migration foreign_keys=off
    CREATE TABLE parents_v2 (id INTEGER PRIMARY KEY) STRICT;
    INSERT INTO parents_v2 SELECT * FROM parents;
    DROP TABLE parents;
    ALTER TABLE parents_v2 RENAME TO parents;
  `);
  await writeMigration(migrations, "0003_invalid_child.sql", `
    INSERT INTO children VALUES (2, 999);
  `);

  await assert.rejects(
    migrateDatabase(databasePath, migrations),
    /FOREIGN KEY constraint failed/u
  );

  const database = openDatabase(databasePath);
  try {
    assert.deepEqual(database.prepare(`
      SELECT version FROM schema_migrations ORDER BY version
    `).all(), [{ version: 1 }, { version: 2 }]);
    assert.equal((database.prepare("SELECT count(*) AS count FROM children")
      .get() as { count: number }).count, 1);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});

test("migration directives are accepted only as the exact first line", async () => {
  const directory = await temporaryDirectory("migration-directive");
  const invalidSources = [
    `
-- convenewire:migration foreign_keys=off
CREATE TABLE invalid_directive (id INTEGER PRIMARY KEY) STRICT;
    `,
    ` -- convenewire:migration foreign_keys=off
CREATE TABLE invalid_directive (id INTEGER PRIMARY KEY) STRICT;
    `,
    `-- convenewire:migration foreign_keys=on
CREATE TABLE invalid_directive (id INTEGER PRIMARY KEY) STRICT;
    `,
    `-- convenewire:migration foreign_keys=off
-- convenewire:migration foreign_keys=off
CREATE TABLE invalid_directive (id INTEGER PRIMARY KEY) STRICT;
    `
  ];
  for (const [index, source] of invalidSources.entries()) {
    const migrations = path.join(directory, `migrations-${index}`);
    await writeMigration(migrations, "0001_invalid.sql", source);
    await assert.rejects(
      migrateDatabase(path.join(directory, `server-${index}.sqlite`), migrations),
      /Invalid migration directive/u
    );
  }
});
