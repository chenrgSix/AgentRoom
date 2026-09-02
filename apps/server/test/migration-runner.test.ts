import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createTestResources } from "../../../scripts/test/resources.mjs";

import Database from "better-sqlite3";

import { openDatabase } from "../src/data/database.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { prepareDatabaseDirectory } from "../src/data/database-location.js";
import {
  defaultMigrationsDirectory,
  migrateDatabase
} from "../src/data/migration-runner.js";
import { DiscussionRepository } from "../src/discussion/discussion-repository.js";
import { RunRepository } from "../src/run/run-repository.js";
import { AuthService } from "../src/security/auth-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";

async function temporaryDirectory(t: TestContext, name: string): Promise<string> {
  return (await createTestResources(t, `convene-wire-${name}-`)).directory;
}

test("an empty database migrates from zero and reruns idempotently", async (t) => {
  const directory = await temporaryDirectory(t, "migration");
  const databasePath = path.join(directory, "nested", "server.sqlite");
  await prepareDatabaseDirectory(databasePath);

  const first = await migrateDatabase(databasePath);
  assert.deepEqual(
    first.appliedVersions,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]
  );
  assert.deepEqual(first.skippedVersions, []);
  assert.equal(first.currentVersion, 71);

  const second = await migrateDatabase(databasePath);
  assert.deepEqual(second.appliedVersions, []);
  assert.deepEqual(
    second.skippedVersions,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]
  );

  const database = new Database(databasePath, { readonly: true });
  try {
    const migrationCount = database
      .prepare("SELECT count(*) AS count FROM schema_migrations")
      .get() as { count: number };
    const metadataTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'system_metadata'"
      )
      .get() as { count: number };
    const trustedInvitationTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'web_member_invitations'"
      )
      .get() as { count: number };
    const memberRecoveryTable = database
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'web_member_recoveries'")
      .get() as { count: number };
    const clarificationTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'task_clarifications'"
      )
      .get() as { count: number };

    const workspaceLeaseTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'workspace_leases'"
      )
      .get() as { count: number };
    const artifactPublicationTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'artifact_publications'"
      )
      .get() as { count: number };
    const artifactRelationTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'task_artifact_relations'"
      )
      .get() as { count: number };
    const devicePairingSessionTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'device_pairing_sessions'"
      )
      .get() as { count: number };
    const deviceBridgeObservationTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'device_bridge_observations'"
      )
      .get() as { count: number };
    const taskCriteriaTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'task_criteria_entries'"
      )
      .get() as { count: number };
    const taskAssignmentTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'task_agent_assignments'"
      )
      .get() as { count: number };
    const ambiguityAcknowledgementTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'run_ambiguity_acknowledgements'"
      )
      .get() as { count: number };
    const replyProjectionTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'run_reply_message_projections'"
      )
      .get() as { count: number };
    const replyProjectionFailureTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'run_reply_projection_failures'"
      )
      .get() as { count: number };
    const resultTable = database
      .prepare(
        "SELECT count(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'task_results'"
      )
      .get() as { count: number };
    const hostedTableCount = database
      .prepare(`
        SELECT count(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'hosted_credential_keyrings', 'hosted_provider_credentials',
          'hosted_runtime_profiles', 'hosted_provider_test_observations',
          'hosted_invocation_intents'
        )
      `)
      .get() as { count: number };
    const agentDefinition = database
      .prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'
      `)
      .get() as { sql: string };
    const pairingColumns = database
      .prepare("PRAGMA table_info(device_pairing_sessions)")
      .all() as Array<{ name: string }>;
    const runColumns = database
      .prepare("PRAGMA table_info(runs)")
      .all() as Array<{ name: string }>;
    const agentColumns = database
      .prepare("PRAGMA table_info(agents)")
      .all() as Array<{ name: string }>;

    assert.equal(migrationCount.count, 71);
    assert.equal(metadataTable.count, 1);
    assert.equal(trustedInvitationTable.count, 1);
    assert.equal(memberRecoveryTable.count, 1);
    assert.equal(clarificationTable.count, 1);
    assert.equal(workspaceLeaseTable.count, 1);
    assert.equal(artifactPublicationTable.count, 1);
    assert.equal(artifactRelationTable.count, 1);
    assert.equal(devicePairingSessionTable.count, 1);
    assert.equal(deviceBridgeObservationTable.count, 1);
    assert.equal(pairingColumns.some(({ name }) =>
      name === "trust_installation_id"
    ), true);
    assert.equal(pairingColumns.some(({ name }) =>
      name === "device_supports_scoped_private_trust"
    ), true);
    assert.equal(taskCriteriaTable.count, 1);
    assert.equal(taskAssignmentTable.count, 1);
    assert.equal(ambiguityAcknowledgementTable.count, 1);
    assert.equal(replyProjectionTable.count, 1);
    assert.equal(replyProjectionFailureTable.count, 1);
    assert.equal(resultTable.count, 1);
    assert.equal(hostedTableCount.count, 5);
    assert.match(agentDefinition.sql, /'hosted'/u);
    assert.equal(runColumns.some(({ name }) => name === "attempt_number"), true);
    assert.equal(runColumns.some(({ name }) =>
      name === "context_manifest_json"
    ), true);
    assert.equal(agentColumns.some((column) =>
      column.name === "runtime_policy_json"
    ), true);
    assert.equal(agentColumns.some((column) =>
      column.name === "workspace_alias"
    ), true);
  } finally {
    database.close();
  }
});

test("scheduler wire migration drops only pending legacy projections", async () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE run_deliveries (
        delivery_attempt_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        state TEXT NOT NULL CHECK (state IN ('pending', 'accepted'))
      ) STRICT;
    `);
    const insert = database.prepare(`
      INSERT INTO run_deliveries (
        delivery_attempt_id, payload_json, state
      ) VALUES (?, ?, ?)
    `);
    insert.run("delivery_pending_context", JSON.stringify({
      contextMessages: [{ senderId: "execution-scheduler" }]
    }), "pending");
    insert.run("delivery_pending_bundle", JSON.stringify({
      roomContextBundle: {
        rawTail: { messages: [{ senderId: "execution-scheduler" }] }
      }
    }), "pending");
    insert.run("delivery_accepted_legacy", JSON.stringify({
      contextMessages: [{ senderId: "execution-scheduler" }]
    }), "accepted");
    insert.run("delivery_pending_current", JSON.stringify({
      contextMessages: [{ senderId: "execution_scheduler" }]
    }), "pending");

    database.exec(await readFile(path.join(
      defaultMigrationsDirectory,
      "0071_scheduler_wire_sender_identity.sql"
    ), "utf8"));

    assert.deepEqual(database.prepare(`
      SELECT delivery_attempt_id FROM run_deliveries
      ORDER BY delivery_attempt_id
    `).all(), [
      { delivery_attempt_id: "delivery_accepted_legacy" },
      { delivery_attempt_id: "delivery_pending_current" }
    ]);
  } finally {
    database.close();
  }
});

test("Discussion Wave migration preserves legacy singleton Turns", async (t) => {
  const directory = await temporaryDirectory(t, "wave-migration");
  const databasePath = path.join(directory, "server.sqlite");
  const legacyMigrations = path.join(directory, "legacy-migrations");
  await mkdir(legacyMigrations, { recursive: true });
  const entries = (await readdir(defaultMigrationsDirectory))
    .filter((name) => /^[0-9]{4}_.+\.sql$/u.test(name) && name < "0015_")
    .sort();
  for (const entry of entries) {
    await writeFile(
      path.join(legacyMigrations, entry),
      await readFile(path.join(defaultMigrationsDirectory, entry), "utf8"),
      "utf8"
    );
  }
  await migrateDatabase(databasePath, legacyMigrations);

  const legacy = new Database(databasePath);
  legacy.pragma("foreign_keys = ON");
  try {
    legacy.exec(`
      INSERT INTO web_users VALUES ('user_legacy', 'Legacy', '2026-08-23T00:00:00.000Z');
      INSERT INTO teams VALUES ('team_legacy', 'Legacy', '2026-08-23T00:00:00.000Z');
      INSERT INTO team_members VALUES (
        'member_legacy', 'team_legacy', 'user_legacy', 'Legacy', 'owner',
        '2026-08-23T00:00:00.000Z'
      );
      INSERT INTO rooms VALUES (
        'room_legacy', 'team_legacy', 'general', 1,
        '2026-08-23T00:00:00.000Z'
      );
      INSERT INTO agents VALUES (
        'agent_legacy', 'team_legacy', 'member_legacy', NULL, 'Legacy Agent',
        'Reviewer', 'manual', '{}', 1, 'manual',
        '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z'
      );
      INSERT INTO messages (
        message_id, room_id, sequence, sender_type, sender_id, content,
        parent_message_id, created_at, trace_id
      ) VALUES (
        'msg_legacy', 'room_legacy', 1, 'member', 'member_legacy',
        'Preserve this turn.', NULL, '2026-08-23T00:00:00.000Z', 'trace_legacy'
      );
      INSERT INTO discussions (
        discussion_id, room_id, root_message_id, requester_member_id, goal,
        mode, state, state_reason, output_mode, policy_json, progress_json,
        budget_json, current_turn, next_speaker_index, requested_action,
        version, deadline_at, created_at, updated_at, terminal_at
      ) VALUES (
        'discussion_legacy', 'room_legacy', 'msg_legacy', 'member_legacy',
        'Preserve this turn.', 'round_robin', 'active', NULL, 'final_answer',
        '{"initialLeaseTurns":4,"automaticMaxTurns":12,"hardMaxTurns":50,"maxDurationSeconds":1200,"plateauWindow":2,"minimumCompletionConfidence":0.8,"finalizationReserveTurns":1,"requireReviewer":false,"allowAutomaticFinish":true}',
        '{"version":0,"goalSatisfied":false,"confidence":null,"openQuestions":[],"evidenceRefs":[],"disagreementRemaining":"unknown","reviewerApproved":false,"plateauCount":0,"replyHashes":[],"lastTurnAddedInformation":true}',
        '{"turnsUsed":1,"tokensUsed":null,"durationSeconds":0,"estimatedCostMicros":null,"leaseEndTurn":4,"extensions":0,"tokenTelemetryKnown":false,"costTelemetryKnown":false}',
        1, 0, NULL, 2, '2026-08-23T00:20:00.000Z',
        '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z', NULL
      );
      INSERT INTO discussion_turns (
        turn_id, discussion_id, ordinal, kind, speaker_agent_id,
        input_message_id, run_id, output_message_id, state, assessment_json,
        reply_hash, created_at, updated_at, completed_at
      ) VALUES (
        'turn_legacy', 'discussion_legacy', 1, 'discussion', 'agent_legacy',
        'msg_legacy', NULL, NULL, 'planned', NULL, NULL,
        '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z', NULL
      );
    `);
  } finally {
    legacy.close();
  }

  const migrated = await migrateDatabase(databasePath);
  assert.deepEqual(
    migrated.appliedVersions,
    [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]
  );
  const database = new Database(databasePath, { readonly: true });
  try {
    const discussion = database.prepare(`
      SELECT execution_model, current_wave FROM discussions
      WHERE discussion_id = 'discussion_legacy'
    `).get() as { execution_model: string; current_wave: number };
    const turn = database.prepare(`
      SELECT wave_id, wave_member_ordinal, state FROM discussion_turns
      WHERE turn_id = 'turn_legacy'
    `).get() as { wave_id: string; wave_member_ordinal: number; state: string };
    const wave = database.prepare(`
      SELECT state, expected_members, input_message_id FROM discussion_waves
      WHERE wave_id = ?
    `).get(turn.wave_id) as {
      state: string;
      expected_members: number;
      input_message_id: string;
    };
    const roomParticipants = database.prepare(`
      SELECT
        (SELECT count(*) FROM room_human_participants
          WHERE room_id = 'room_legacy') AS human_count,
        (SELECT count(*) FROM room_agent_participants
          WHERE room_id = 'room_legacy') AS agent_count
    `).get() as { human_count: number; agent_count: number };
    const roomPolicy = database.prepare(`
      SELECT collaboration_policy_json FROM rooms WHERE room_id = 'room_legacy'
    `).get() as { collaboration_policy_json: string };
    assert.deepEqual(discussion, {
      execution_model: "parallel_wave",
      current_wave: 1
    });
    assert.deepEqual(roomParticipants, { human_count: 1, agent_count: 1 });
    assert.deepEqual(JSON.parse(roomPolicy.collaboration_policy_json), {
      allowDiscussion: true,
      allowAll: true,
      allowAgentMentions: true,
      maxAgentMentionDepth: 4
    });
    assert.equal(turn.wave_member_ordinal, 0);
    assert.equal(turn.state, "planned");
    assert.deepEqual(wave, {
      state: "open",
      expected_members: 1,
      input_message_id: "msg_legacy"
    });
    const mapped = new DiscussionRepository(database).get("discussion_legacy");
    assert.equal(mapped?.policy.waveTimeoutSeconds, 300);
    assert.equal(mapped?.budget.agentRunsUsed, 1);
  } finally {
    database.close();
  }
});

test("Runtime activity migration preserves pending reply routing intents", async (t) => {
  const directory = await temporaryDirectory(t, "activity-migration");
  const databasePath = path.join(directory, "server.sqlite");
  const legacyMigrations = path.join(directory, "legacy-migrations");
  await mkdir(legacyMigrations, { recursive: true });
  const entries = (await readdir(defaultMigrationsDirectory))
    .filter((name) => /^[0-9]{4}_.+\.sql$/u.test(name) && name < "0023_")
    .sort();
  for (const entry of entries) {
    await writeFile(
      path.join(legacyMigrations, entry),
      await readFile(path.join(defaultMigrationsDirectory, entry), "utf8"),
      "utf8"
    );
  }
  await migrateDatabase(databasePath, legacyMigrations);

  const now = "2026-08-25T01:00:00.000Z";
  const legacy = openDatabase(databasePath);
  const runId = "run_activity_migration";
  try {
    legacy.exec(`
      INSERT INTO web_users (user_id, display_name, created_at)
      VALUES ('user_activity_migration', 'Alice', '${now}');
      INSERT INTO teams (team_id, name, created_at)
      VALUES ('team_activity_migration', 'Migration Team', '${now}');
      INSERT INTO team_members (
        member_id, team_id, user_id, display_name, role, created_at
      ) VALUES (
        'member_activity_migration', 'team_activity_migration',
        'user_activity_migration', 'Alice', 'owner', '${now}'
      );
      INSERT INTO rooms (
        room_id, team_id, name, next_message_sequence, created_at
      ) VALUES (
        'room_activity_migration', 'team_activity_migration', 'general', 1,
        '${now}'
      );
      INSERT INTO devices (
        device_id, team_id, owner_member_id, name, status, created_at
      ) VALUES (
        'device_activity_migration', 'team_activity_migration',
        'member_activity_migration', 'Migration Bridge', 'active', '${now}'
      );
      INSERT INTO agents (
        agent_id, team_id, owner_member_id, device_id, name, role,
        integration_mode, capabilities_json, enabled, presence, created_at,
        updated_at
      ) VALUES (
        'agent_activity_migration', 'team_activity_migration',
        'member_activity_migration', 'device_activity_migration', 'Builder',
        'Managed', 'managed',
        '{"supportsHandoff":false,"supportsInterrupt":true,"supportsResume":false,"supportsStart":true,"supportsStreaming":true}',
        1, 'ready', '${now}', '${now}'
      );
      INSERT INTO room_human_participants (room_id, member_id, added_at)
      VALUES ('room_activity_migration', 'member_activity_migration', '${now}');
      INSERT INTO room_agent_participants (room_id, agent_id, added_at)
      VALUES ('room_activity_migration', 'agent_activity_migration', '${now}');
      INSERT INTO messages (
        message_id, trace_id, room_id, sequence, sender_type, sender_id,
        content, parent_message_id, created_at
      ) VALUES (
        'msg_activity_migration', 'trace_activity_migration',
        'room_activity_migration', 1, 'member', 'member_activity_migration',
        'Preserve pending routing.', NULL, '${now}'
      );
      INSERT INTO runs (
        run_id, trace_id, room_id, trigger_message_id, requester_member_id,
        target_agent_id, parent_run_id, instruction, state, last_sequence,
        deadline_at, created_at, updated_at, terminal_at
      ) VALUES (
        '${runId}', 'trace_activity_migration', 'room_activity_migration',
        'msg_activity_migration', 'member_activity_migration',
        'agent_activity_migration', NULL, 'Preserve pending routing.',
        'delivered', 2, '2026-08-25T01:20:00.000Z', '${now}', '${now}', NULL
      );
      INSERT INTO run_events (
        run_id, trace_id, sequence, event_type, status, content, output_reset,
        error_json, assessment_json, created_at
      ) VALUES
        ('${runId}', 'trace_activity_migration', 1, 'status', 'delivered', NULL, 0,
          NULL, NULL, '${now}'),
        ('${runId}', 'trace_activity_migration', 2, 'reply', NULL,
          'Route this reply after restart.', 0, NULL, NULL, '${now}');
      INSERT INTO run_reply_routing_intents (
        parent_run_id, reply_sequence, content, state, created_at, completed_at
      ) VALUES (
        '${runId}', 2, 'Route this reply after restart.', 'pending', '${now}', NULL
      );
    `);
    assert.equal((legacy.prepare(`
      SELECT count(*) AS count FROM run_reply_routing_intents
      WHERE parent_run_id = ?
    `).get(runId) as { count: number }).count, 1);
  } finally {
    legacy.close();
  }

  const migrated = await migrateDatabase(databasePath);
  assert.deepEqual(
    migrated.appliedVersions,
    [23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]
  );
  const database = openDatabase(databasePath);
  try {
    const runs = new RunRepository(database);
    assert.equal(runs.listPendingReplyRoutingIntents(runId).length, 1);
    assert.equal(runs.listEvents(runId).at(-1)?.event.type, "reply");
    assert.equal(runs.getContextFence(runId)?.fenceKind, "legacy");
    assert.equal(runs.getRun(runId)?.attemptNumber, 1);
    assert.equal(runs.getContextManifest(runId), undefined);
    assert.deepEqual(database.prepare(`
      SELECT mode, latest_through_sequence, desired_through_sequence
      FROM rolling_room_state
      WHERE room_id = 'room_activity_migration'
    `).get(), {
      mode: "disabled",
      latest_through_sequence: 0,
      desired_through_sequence: 1
    });
    assert.equal((database.prepare(`
      SELECT count(*) AS count
      FROM rolling_room_checkpoints
      WHERE room_id = 'room_activity_migration'
    `).get() as { count: number }).count, 0);
    assert.equal(runs.applyEvent(runId, {
      type: "activity",
      sequence: 3,
      activityId: "reasoning-1",
      kind: "reasoning",
      phase: "completed"
    }, now).applied, true);
  } finally {
    database.close();
  }
});

test("Task work migration maps legacy state and replaces a terminal default", async (t) => {
  const directory = await temporaryDirectory(t, "task-work-migration");
  const databasePath = path.join(directory, "server.sqlite");
  const legacyMigrations = path.join(directory, "legacy-migrations");
  await mkdir(legacyMigrations, { recursive: true });
  const entries = (await readdir(defaultMigrationsDirectory))
    .filter((name) => /^[0-9]{4}_.+\.sql$/u.test(name) && name < "0043_")
    .sort();
  for (const entry of entries) {
    await writeFile(
      path.join(legacyMigrations, entry),
      await readFile(path.join(defaultMigrationsDirectory, entry), "utf8"),
      "utf8"
    );
  }
  await migrateDatabase(databasePath, legacyMigrations);

  const legacy = openDatabase(databasePath);
  let roomId = "";
  let oldDefaultTaskId = "";
  try {
    const core = new CoreRepository(legacy);
    const auth = new AuthService(legacy);
    const teams = new TeamRoomService(core, auth);
    const created = teams.createTeamForUser({
      userId: "user_task_migration_0001",
      userDisplayName: "Migration Owner",
      teamName: "Migration Team",
      now: "2026-08-27T10:00:00.000Z"
    });
    const session = auth.issueWebSession(
      created.owner.userId!,
      "2026-08-27T10:00:00.000Z",
      "2026-08-27T11:00:00.000Z"
    );
    // Seed the historical schema without invoking today's session-lineage query.
    const principal = { userId: created.owner.userId!, sessionId: session.id };
    const room = teams.createRoom(
      principal,
      created.team.teamId,
      "migration",
      "2026-08-27T10:00:00.000Z"
    );
    roomId = room.roomId;
    oldDefaultTaskId = (legacy.prepare(`
      SELECT task_id FROM agent_tasks WHERE room_id = ? AND is_default = 1
    `).get(roomId) as { task_id: string }).task_id;
    legacy.prepare(`
      UPDATE agent_tasks SET state = 'completed' WHERE task_id = ?
    `).run(oldDefaultTaskId);
    const insert = legacy.prepare(`
      INSERT INTO agent_tasks (
        task_id, room_id, title, goal, state, created_by_member_id,
        is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    for (const [suffix, state] of [
      ["ready", "open"],
      ["active", "working"],
      ["blocked", "blocked"]
    ] as const) {
      insert.run(
        `task_legacy_${suffix}_0001`,
        roomId,
        `Legacy ${suffix}`,
        `Map legacy ${state}.`,
        state,
        created.owner.memberId,
        "2026-08-27T10:01:00.000Z",
        "2026-08-27T10:01:00.000Z"
      );
    }
  } finally {
    legacy.close();
  }

  const migrated = await migrateDatabase(databasePath);
  assert.deepEqual(
    migrated.appliedVersions,
    [43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]
  );
  const database = openDatabase(databasePath);
  try {
    const rows = database.prepare(`
      SELECT task_id, lifecycle_state, is_default, task_display_number
      FROM agent_tasks WHERE room_id = ? ORDER BY task_id
    `).all(roomId) as Array<{
      task_id: string;
      lifecycle_state: string;
      is_default: number;
      task_display_number: number;
    }>;
    assert.equal(
      rows.find(({ task_id }) => task_id === oldDefaultTaskId)?.lifecycle_state,
      "completed"
    );
    assert.equal(
      rows.find(({ task_id }) => task_id === oldDefaultTaskId)?.is_default,
      0
    );
    assert.equal(
      rows.find(({ task_id }) => task_id === "task_legacy_ready_0001")
        ?.lifecycle_state,
      "ready"
    );
    assert.equal(
      rows.find(({ task_id }) => task_id === "task_legacy_active_0001")
        ?.lifecycle_state,
      "active"
    );
    assert.equal(
      rows.find(({ task_id }) => task_id === "task_legacy_blocked_0001")
        ?.lifecycle_state,
      "active"
    );
    assert.equal(new Set(rows.map(({ task_display_number }) =>
      task_display_number)).size, rows.length);
    const replacement = rows.find(({ is_default }) => is_default === 1);
    assert.equal(replacement?.lifecycle_state, "active");
    assert.match(replacement?.task_id ?? "", /^task_default_active_/u);
    const block = database.prepare(`
      SELECT state FROM task_blocks WHERE task_id = 'task_legacy_blocked_0001'
    `).get() as { state: string };
    assert.equal(block.state, "open");
    assert.throws(() => database.prepare(`
      UPDATE agent_tasks SET lifecycle_state = 'canceled'
      WHERE task_id = ?
    `).run(replacement!.task_id), /permanently active/u);
    const taskCount = (database.prepare(`
      SELECT count(*) AS count FROM agent_tasks WHERE room_id = ?
    `).get(roomId) as { count: number }).count;
    const definitionCount = (database.prepare(`
      SELECT count(*) AS count FROM task_definition_revisions
      WHERE task_id IN (SELECT task_id FROM agent_tasks WHERE room_id = ?)
    `).get(roomId) as { count: number }).count;
    assert.equal(definitionCount, taskCount);
  } finally {
    database.close();
  }
});

test("an applied migration cannot be changed", async (t) => {
  const directory = await temporaryDirectory(t, "checksum");
  const databasePath = path.join(directory, "server.sqlite");
  const migrationsDirectory = path.join(directory, "migrations");
  await prepareDatabaseDirectory(databasePath);
  await mkdir(migrationsDirectory, { recursive: true });

  const sourcePath = path.join(defaultMigrationsDirectory, "0001_initialize.sql");
  const migrationPath = path.join(migrationsDirectory, "0001_initialize.sql");
  const source = await readFile(sourcePath, "utf8");
  await writeFile(migrationPath, source, "utf8");
  await migrateDatabase(databasePath, migrationsDirectory);

  await writeFile(migrationPath, `${source}\n-- changed\n`, "utf8");
  await assert.rejects(
    migrateDatabase(databasePath, migrationsDirectory),
    /differs from the already applied source/
  );
});

test("a failed migration rolls back its own schema changes", async (t) => {
  const directory = await temporaryDirectory(t, "rollback");
  const databasePath = path.join(directory, "server.sqlite");
  const migrationsDirectory = path.join(directory, "migrations");
  await prepareDatabaseDirectory(databasePath);
  await mkdir(migrationsDirectory, { recursive: true });
  await writeFile(
    path.join(migrationsDirectory, "0001_first.sql"),
    "CREATE TABLE first_table (id INTEGER PRIMARY KEY) STRICT;\n",
    "utf8"
  );
  await writeFile(
    path.join(migrationsDirectory, "0002_broken.sql"),
    "CREATE TABLE partial_table (id INTEGER PRIMARY KEY) STRICT;\nINVALID SQL;\n",
    "utf8"
  );

  await assert.rejects(
    migrateDatabase(databasePath, migrationsDirectory),
    /near "INVALID": syntax error/
  );

  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master " +
        "WHERE type = 'table' AND name IN ('first_table', 'partial_table') " +
        "ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const migrations = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;

    assert.deepEqual(tables, [{ name: "first_table" }]);
    assert.deepEqual(migrations, [{ version: 1 }]);
  } finally {
    database.close();
  }
});
