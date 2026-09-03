import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { createTestResources } from "../../../scripts/test/resources.mjs";

import { ArtifactPublicationRepository } from
  "../src/artifact/artifact-publication-repository.js";
import {
  ArtifactPublicationService,
  type PrepareArtifactPublicationInput
} from "../src/artifact/artifact-publication-service.js";
import { LocalArtifactBlobStore } from
  "../src/artifact/local-artifact-blob-store.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { defaultMigrationsDirectory, migrateDatabase } from "../src/data/migration-runner.js";
import { SqliteTransactionBoundary } from
  "../src/data/sqlite-transaction-boundary.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { ArtifactContentBindingService } from
  "../src/task/artifact-content-binding-service.js";
import { WorkspaceLeaseRepository } from
  "../src/workspace/workspace-lease-repository.js";
import { WorkspaceLeaseService } from
  "../src/workspace/workspace-lease-service.js";

const now = "2026-08-25T10:00:00.000Z";
const workspaceRef = `workspace_${"a".repeat(64)}`;
const workspaceGeneration = "b".repeat(64);

async function createFixture(t: TestContext, maximumMigration?: number) {
  const resources = await createTestResources(t, "convene-wire-artifact-");
  const directory = resources.directory;
  const databasePath = path.join(directory, "server.sqlite");
  const blobRoot = path.join(directory, "blobs");
  if (maximumMigration === undefined) await migrateDatabase(databasePath);
  else {
    const migrationDirectory = path.join(directory, "migrations");
    await mkdir(migrationDirectory);
    for (const name of await readdir(defaultMigrationsDirectory)) {
      if (Number(name.slice(0, 4)) <= maximumMigration) await copyFile(
        path.join(defaultMigrationsDirectory, name), path.join(migrationDirectory, name));
    }
    await migrateDatabase(databasePath, migrationDirectory);
  }
  const database = openDatabase(databasePath);
  resources.defer(() => { if (database.open) database.close(); });
  const transactions = new SqliteTransactionBoundary(database);
  const core = new CoreRepository(database, transactions);
  const auth = new AuthService(database);
  const teams = new TeamRoomService(core, auth);
  const registry = new MemberDeviceService(core, auth);
  const agents = new AgentService(core, auth);
  const messages = new MessageService(core, auth);
  const runRepository = new RunRepository(database);
  const taskRepository = new AgentTaskRepository(database);
  const runs = new RunService(core, runRepository, auth, taskRepository);
  const created = teams.createTeamForUser({
    userId: "user_artifact_12345678",
    userDisplayName: "Alice",
    teamName: "Artifact Team",
    now
  });
  const session = auth.issueWebSession(
    created.owner.userId ?? "",
    now,
    "2026-08-25T11:00:00.000Z"
  );
  const member = auth.authenticateWebSession(session.secret, now);
  const room = teams.createRoom(member, created.team.teamId, "general", now);
  const device = registry.registerOwnDevice(
    member,
    created.team.teamId,
    "Alice Mac",
    now
  );
  const agent = agents.publishAgent(member, {
    teamId: created.team.teamId,
    deviceId: device.deviceId,
    name: "Builder",
    role: "Managed",
    integrationMode: "managed",
    workspaceRef,
    workspaceGeneration,
    capabilities: {
      supportsHandoff: false,
      supportsInterrupt: true,
      supportsResume: true,
      supportsStart: true,
      supportsStreaming: true,
      supportsWorkspaceLeases: true
    },
    now
  });
  const message = messages.createMemberMessage(member, {
    roomId: room.roomId,
    content: "Produce one patch Artifact.",
    mentions: [{
      targetType: "agent",
      targetAgentId: agent.agentId,
      displayLabel: "Builder / Managed"
    }],
    now
  });
  const run = runs.createRunsForMessage(member, message.messageId, now)[0];
  assert.ok(run);
  runRepository.applyEvent(run.runId, {
    type: "status",
    sequence: 1,
    status: "delivered"
  }, now);
  const credential = auth.issueDeviceCredential(device.deviceId, now);
  const principal = auth.authenticateDevice(credential.secret, now);
  const workspaceLeases = new WorkspaceLeaseService(
    new WorkspaceLeaseRepository(database),
    runRepository,
    taskRepository,
    core
  );
  const lease = workspaceLeases.issueReadSource(principal, {
    runId: run.runId,
    agentId: agent.agentId,
    workspaceRef,
    workspaceGeneration,
    idempotencyKey: "idem_artifact_workspace_12345678",
    durationSeconds: 300
  }, now);
  const publications = new ArtifactPublicationRepository(database, transactions);
  const blobs = new LocalArtifactBlobStore(blobRoot);
  const service = new ArtifactPublicationService(
    publications,
    workspaceLeases,
    blobs
  );
  return {
    agent,
    blobRoot,
    blobs,
    database,
    databasePath,
    core,
    lease,
    principal,
    publications,
    run,
    runRepository,
    service,
    taskRepository,
    transactions,
    workspaceLeases
  };
}

function prepareInput(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  source: Buffer,
  idempotencyKey: string,
  sha256 = createHash("sha256").update(source).digest("hex")
): PrepareArtifactPublicationInput {
  return {
    leaseId: fixture.lease.leaseId,
    runId: fixture.run.runId,
    agentId: fixture.agent.agentId,
    workspaceRef,
    workspaceGeneration,
    idempotencyKey,
    artifactType: "patch",
    fileName: "change.patch",
    mediaType: "text/x-diff",
    title: "Verified patch",
    summary: "Patch captured from the leased Workspace snapshot.",
    sizeBytes: source.length,
    sha256
  };
}

function chunkSha256(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

test("capture lease migration preserves populated legacy publications, blobs and foreign keys", async (t) => {
  const f = await createFixture(t, 61);
  let database = f.database;
  try {
    const source = Buffer.from("diff --git a/legacy b/legacy\n+retained\n");
    const input = prepareInput(f, source, "idem_legacy_migration0001");
    const publication = f.service.prepare(f.principal, input, now);
    f.service.appendChunk(f.principal, publication.publicationId, 0, source, chunkSha256(source), now);
    f.service.seal(f.principal, publication.publicationId, now);
    const binding = new ArtifactContentBindingService(f.transactions, new ArtifactRepository(database),
      f.publications, f.taskRepository, f.runRepository, f.core);
    binding.bind(f.principal, publication.publicationId, now);
    const tables = ["artifact_publications", "artifact_contents", "task_artifact_refs"];
    const before = tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
    const oldLease = database.prepare("SELECT * FROM workspace_leases").get();
    database.close();
    const migrated = await migrateDatabase(f.databasePath);
    assert.deepEqual(migrated.appliedVersions,
      [62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84]);
    database = openDatabase(f.databasePath);
    const expected = structuredClone(before);
    expected[0] = expected[0]!.map((row) => ({
      ...row,
      verification_operation_id: null
    }));
    assert.deepEqual(
      tables.map((table) => database.prepare(`SELECT * FROM ${table}`).all()),
      expected
    );
    assert.deepEqual(database.prepare("SELECT * FROM workspace_leases").get(), { ...oldLease!, capture_operation_id: null });
    const content = new ArtifactPublicationRepository(database).getContent(
      (before[0]![0] as { content_id: string }).content_id)!;
    assert.equal(f.blobs.hasMatchingBlob(content.storageKey, chunkSha256(source), source.length), true);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.throws(() => database.exec("UPDATE workspace_leases SET workspace_generation = 'bad'"), /invalid/u);
    assert.throws(() => database.exec("DELETE FROM workspace_leases"), /retained/u);
  } finally {
    if (database.open) database.close();
    await rm(path.dirname(f.databasePath), { recursive: true, force: true });
  }
});

test("commit migration preserves populated canonical lineage and rolls back a failed rebuild", async (t) => {
  const f = await createFixture(t, 62);
  let database = f.database;
  try {
    const binder = new ArtifactContentBindingService(f.transactions, new ArtifactRepository(database),
      f.publications, f.taskRepository, f.runRepository, f.core);
    let previous: string | undefined;
    for (const [kind, media, name] of [
      ["patch", "text/x-diff", "old.patch"], ["document", "text/markdown", "old.md"],
      ["test_result", "application/json", "old.json"]
    ] as const) {
      const source = Buffer.from(kind === "test_result" ? "{}" : "Retained legacy bytes\n");
      const input = { ...prepareInput(f, source, `idem_commit_migration_${kind}`),
        artifactType: kind, mediaType: media, fileName: name,
        relations: previous ? [{ type: "derives_from" as const, targetArtifactId: previous }] : [] };
      const publication = f.service.prepare(f.principal, input, now);
      f.service.appendChunk(f.principal, publication.publicationId, 0, source, chunkSha256(source), now);
      f.service.seal(f.principal, publication.publicationId, now);
      previous = binder.bind(f.principal, publication.publicationId, now).artifact.artifactId;
    }
    const pendingSource = Buffer.from("Pending upload\n");
    f.service.prepare(f.principal, prepareInput(f, pendingSource, "idem_commit_migration_pending"), now);
    const tables = ["artifact_publications", "artifact_contents", "task_artifact_refs", "task_artifact_relations", "agent_tasks", "runs"];
    const snapshot = () => tables.map((table) => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    const objects = () => database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name").all() as
      Array<{ type: string; name: string; tbl_name: string; sql: string }>;
    const beforeObjects = objects();
    database.close();
    const migrationDir = path.join(path.dirname(f.databasePath), "migrations");
    const migrationName = "0063_commit_artifact_bundles.sql";
    const migration = await readFile(path.join(defaultMigrationsDirectory, migrationName), "utf8");
    await writeFile(path.join(migrationDir, migrationName), migration + "\nSELECT deliberately_missing_commit_migration_function();\n");
    await assert.rejects(migrateDatabase(f.databasePath, migrationDir), /deliberately_missing/u);
    database = openDatabase(f.databasePath);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(objects(), beforeObjects, "failed migration changed schema or retained triggers");
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    database.close();
    const result = await migrateDatabase(f.databasePath);
    assert.deepEqual(result.appliedVersions,
      [63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84]);
    database = openDatabase(f.databasePath);
    const expected = structuredClone(before);
    expected[0] = expected[0]!.map((row) => ({
      ...row,
      verification_operation_id: null
    }));
    assert.deepEqual(snapshot(), expected);
    const admissionObjects = new Set([
      "execution_run_admissions",
      "execution_run_admissions_immutable_delete",
      "execution_run_admissions_require_exact_scope_insert",
      "execution_run_admissions_seal_manifest_update",
      "execution_run_deliveries_require_sealed_admission_insert",
      "execution_runs_require_admitted_manifest_update",
      "execution_dispatch_intents",
      "execution_dispatch_intents_immutable_delete",
      "execution_dispatch_intents_immutable_update",
      "execution_dispatch_intents_require_exact_scope_insert",
      "execution_node_states",
      "execution_node_states_state_idx",
      "execution_node_materializations",
      "execution_node_materializations_source_idx",
      "execution_node_materializations_immutable_delete",
      "execution_node_materializations_immutable_update",
      "execution_node_materializations_require_exact_scope_insert",
      "execution_results_require_verified_review_insert",
      "execution_results_require_materializable_review_insert",
      "repository_verification_operations",
      "repository_verification_operations_immutable_update",
      "repository_verification_operations_immutable_delete",
      "artifact_publications_verification_log_idx",
      "artifact_publications_verification_log_scope_insert",
      "artifact_publications_verification_operation_immutable",
      "verification_receipts",
      "verification_receipts_immutable_update",
      "verification_receipts_immutable_delete",
      "execution_verified_node_materializations",
      "execution_verified_materializations_require_scope_insert",
      "execution_verified_materializations_immutable_update",
      "execution_verified_materializations_immutable_delete",
      "execution_integration_approvals",
      "repository_integration_operations",
      "repository_integration_locks",
      "integration_receipts",
      "execution_integration_approvals_operation_unique_insert",
      "repository_integration_operations_operation_unique_insert",
      "repository_integration_locks_exact_scope_insert",
      "repository_integration_locks_receipt_release_delete",
      "execution_integration_approvals_immutable_update",
      "execution_integration_approvals_immutable_delete",
      "repository_integration_operations_immutable_update",
      "repository_integration_operations_immutable_delete",
      "repository_integration_locks_immutable_update",
      "integration_receipts_immutable_update",
      "integration_receipts_immutable_delete",
      "execution_integrated_node_materializations",
      "execution_integrated_materializations_require_scope_insert",
      "execution_integrated_materializations_immutable_update",
      "execution_integrated_materializations_immutable_delete",
      "execution_dependency_materializations",
      "execution_node_retry_authorizations",
      "execution_dispatch_intents_require_retry_authorization_insert",
      "execution_node_retry_authorizations_require_scope_insert",
      "execution_node_retry_authorizations_immutable_update",
      "execution_node_retry_authorizations_immutable_delete",
      "execution_source_evidence",
      "execution_source_evidence_result_idx",
      "execution_source_evidence_local_commit_idx",
      "execution_source_evidence_require_scope_insert",
      "execution_source_evidence_immutable_update",
      "execution_source_evidence_immutable_delete",
      "execution_gate_proof_refs",
      "execution_gate_proof_refs_require_scope_insert",
      "execution_gate_proof_refs_immutable_update",
      "execution_gate_proof_refs_immutable_delete",
      "execution_evidence_adoptions",
      "execution_evidence_adoptions_require_scope_insert",
      "execution_evidence_adoptions_immutable_update",
      "execution_evidence_adoptions_immutable_delete",
      "execution_legacy_node_materializations",
      "execution_adopted_node_materializations",
      "execution_evidence_reuse_contracts",
      "execution_evidence_reuse_contracts_reuse_idx",
      "execution_evidence_reuse_contracts_require_scope_insert",
      "execution_evidence_reuse_contracts_immutable_update",
      "execution_evidence_reuse_contracts_immutable_delete",
      "remote_provider_bindings",
      "remote_provider_bindings_require_owner_insert",
      "remote_provider_bindings_immutable_update",
      "remote_provider_bindings_immutable_delete",
      "remote_provider_binding_revocations",
      "remote_provider_revocations_require_owner_insert",
      "remote_provider_revocations_immutable_update",
      "remote_provider_revocations_immutable_delete",
      "remote_evidence_operations",
      "remote_evidence_operations_require_scope_insert",
      "remote_evidence_operations_preserve_identity",
      "remote_evidence_operations_state_transition",
      "remote_evidence_operations_immutable_delete",
      "remote_artifact_imports",
      "remote_artifact_imports_require_scope_insert",
      "remote_artifact_imports_immutable_update",
      "remote_artifact_imports_immutable_delete",
      "remote_commit_observations",
      "remote_commit_observations_require_scope_insert",
      "remote_commit_observations_immutable_update",
      "remote_commit_observations_immutable_delete",
      "execution_remote_source_evidence",
      "execution_remote_source_evidence_require_scope_insert",
      "execution_remote_source_evidence_immutable_update",
      "execution_remote_source_evidence_immutable_delete",
      "remote_ci_observation_receipts",
      "remote_ci_receipts_require_scope_insert",
      "remote_ci_receipts_immutable_update",
      "remote_ci_receipts_immutable_delete",
      "execution_remote_gate_proof_refs",
      "execution_remote_gate_proof_require_scope_insert",
      "execution_remote_gate_proof_immutable_update",
      "execution_remote_gate_proof_immutable_delete",
      "execution_remote_evidence_adoptions",
      "execution_remote_adoptions_require_scope_insert",
      "execution_remote_adoptions_immutable_update",
      "execution_remote_adoptions_immutable_delete",
      "execution_all_adopted_node_materializations",
      "execution_input_source_authority_insert",
      "execution_scheduler_controls",
      "execution_plan_create_scheduler_control",
      "execution_scheduler_operations",
      "execution_scheduler_receipts",
      "execution_scheduler_operations_require_scope_insert",
      "execution_scheduler_operations_immutable_update",
      "execution_scheduler_operations_immutable_delete",
      "execution_scheduler_receipts_require_operation_insert",
      "execution_scheduler_receipts_immutable_update",
      "execution_scheduler_receipts_immutable_delete",
      "execution_scheduler_controls_transition_guard",
      "execution_scheduler_controls_immutable_delete",
      "execution_dispatch_intents_require_scheduler_mode_insert",
      "execution_scheduler_fairness_history",
      "execution_scheduler_fairness_cursors",
      "execution_scheduler_fairness_history_require_admission_insert",
      "execution_scheduler_fairness_history_immutable_update",
      "execution_scheduler_fairness_history_immutable_delete",
      "execution_scheduler_fairness_cursor_insert_guard",
      "execution_scheduler_fairness_cursor_update_guard",
      "execution_scheduler_fairness_cursor_immutable_delete",
      "remote_input_attestation_operations",
      "remote_input_attestation_operations_require_scope_insert",
      "remote_input_attestation_operations_preserve_identity",
      "remote_input_attestation_operations_state_transition",
      "remote_input_attestation_operations_immutable_delete",
      "remote_input_attestations",
      "remote_input_attestations_require_scope_insert",
      "remote_input_attestations_immutable_update",
      "remote_input_attestations_immutable_delete",
      "execution_remote_evidence_reuse_contracts",
      "execution_remote_reuse_contracts_require_scope_insert",
      "execution_remote_reuse_contracts_immutable_update",
      "execution_remote_reuse_contracts_immutable_delete",
      "execution_claim_immutable_update",
      "execution_plan_supersession_candidates",
      "execution_replan_delegations",
      "execution_replan_delegation_revocations",
      "execution_plan_supersession_activations",
      "execution_replan_delegation_consumptions",
      "execution_plan_supersession_receipts",
      "execution_carried_evidence_adoptions",
      "execution_carried_evidence_reuse_contracts",
      "execution_supersession_candidates_require_scope_insert",
      "execution_claim_supersession_update",
      "execution_plan_supersession_current_update",
      "execution_carried_adoptions_require_scope_insert",
      "execution_carried_reuse_require_scope_insert",
      "execution_supersession_candidates_immutable_update",
      "execution_supersession_candidates_immutable_delete",
      "execution_replan_delegations_immutable_update",
      "execution_replan_delegations_immutable_delete",
      "execution_replan_revocations_immutable_update",
      "execution_replan_revocations_immutable_delete",
      "execution_supersession_activations_immutable_update",
      "execution_supersession_activations_immutable_delete",
      "execution_replan_consumptions_immutable_update",
      "execution_replan_consumptions_immutable_delete",
      "execution_supersession_receipts_immutable_update",
      "execution_supersession_receipts_immutable_delete",
      "execution_carried_adoptions_immutable_update",
      "execution_carried_adoptions_immutable_delete",
      "execution_carried_reuse_immutable_update",
      "execution_carried_reuse_immutable_delete",
      "discussion_wave_selection_required_insert",
      "discussion_wave_selection_immutable_update"
    ]);
    assert.deepEqual(objects()
      .filter(({ name }) => !admissionObjects.has(name))
      .map(({ type, name, tbl_name }) => ({ type, name, tbl_name })),
      beforeObjects
        .filter(({ name }) => !admissionObjects.has(name))
        .map(({ type, name, tbl_name }) => ({ type, name, tbl_name })));
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    for (const [table, reason] of [["task_artifact_refs", /immutable/u], ["artifact_publications", /retained evidence/u]] as const) {
      assert.throws(() => database.exec(`DELETE FROM ${table}`), reason);
    }
    assert.throws(() => database.exec("UPDATE task_artifact_refs SET title = 'changed'"), /immutable/u);
    for (const row of before[1] as Array<{ storage_key: string; sha256: string; size_bytes: number }>) {
      assert.equal(f.blobs.hasMatchingBlob(row.storage_key, row.sha256, row.size_bytes), true);
    }
    const repeated = await migrateDatabase(f.databasePath);
    assert.deepEqual(repeated.appliedVersions, []);
  } finally {
    if (database.open) database.close();
    await rm(path.dirname(f.databasePath), { recursive: true, force: true });
  }
});

test("ordinary source leases cannot publish commit bundles through service or SQL", async (t) => {
  const f = await createFixture(t);
  try {
    const source = Buffer.from("not a commit bundle");
    const input = { ...prepareInput(f, source, "idem_commit_read_source0001"),
      artifactType: "commit" as const, fileName: "candidate.bundle", mediaType: "application/x-git-bundle" as const };
    assert.throws(() => f.service.prepare(f.principal, input, now), /capture lease/u);
    const ordinary = f.service.prepare(f.principal, prepareInput(f, source, "idem_commit_sql_base0001"), now);
    assert.throws(() => f.publications.create({ ...ordinary, publicationId: "publication_commit_bypass0001",
      idempotencyKey: "idem_commit_sql_bypass0001", artifactType: "commit", mediaType: "application/x-git-bundle",
      fileName: "candidate.bundle" }), /lease scope/u);
    assert.equal(f.publications.get("publication_commit_bypass0001"), undefined);
  } finally {
    f.database.close();
    await rm(path.dirname(f.databasePath), { recursive: true, force: true });
  }
});

test("publication chunks are idempotent and sealed rename recovers after restart", async (t) => {
  const fixture = await createFixture(t);
  let database = fixture.database;
  try {
    const source = Buffer.from("diff --git a/a.ts b/a.ts\n+verified\n", "utf8");
    const input = prepareInput(
      fixture,
      source,
      "idem_artifact_publish_12345678"
    );
    const prepared = fixture.service.prepare(fixture.principal, input, now);
    assert.equal(
      fixture.service.prepare(fixture.principal, input, now).publicationId,
      prepared.publicationId
    );
    assert.throws(
      () => fixture.service.prepare(fixture.principal, {
        ...input,
        title: "Conflicting retry"
      }, now),
      /idempotency key conflicts/u
    );

    const first = source.subarray(0, 12);
    const second = source.subarray(12);
    fixture.service.appendChunk(
      fixture.principal,
      prepared.publicationId,
      0,
      first,
      chunkSha256(first),
      now
    );
    assert.equal(
      fixture.service.appendChunk(
        fixture.principal,
        prepared.publicationId,
        0,
        first,
        chunkSha256(first),
        now
      ).receivedSize,
      first.length
    );
    assert.throws(
      () => fixture.service.appendChunk(
        fixture.principal,
        prepared.publicationId,
        0,
        Buffer.from("conflict"),
        chunkSha256(Buffer.from("conflict")),
        now
      ),
      /conflicts with stored bytes/u
    );
    assert.throws(
      () => fixture.service.appendChunk(
        fixture.principal,
        prepared.publicationId,
        first.length + 1,
        second,
        chunkSha256(second),
        now
      ),
      /offset is invalid/u
    );
    fixture.service.appendChunk(
      fixture.principal,
      prepared.publicationId,
      first.length,
      second,
      chunkSha256(second),
      now
    );

    const storageKey = [
      "sealed",
      prepared.teamId,
      input.sha256.slice(0, 2),
      input.sha256
    ].join("/");
    fixture.blobs.seal(
      prepared.tempStorageKey,
      storageKey,
      input.sha256,
      source.length
    );
    const sealed = fixture.service.seal(
      fixture.principal,
      prepared.publicationId,
      now
    );
    assert.equal(sealed.publication.state, "sealed");
    assert.equal(sealed.content.storageKey, storageKey);
    assert.equal(
      fixture.service.seal(fixture.principal, prepared.publicationId, now)
        .content.contentId,
      sealed.content.contentId
    );
    assert.equal(
      database.prepare("SELECT count(*) AS count FROM task_artifact_refs")
        .get().count,
      0
    );

    database.close();
    database = openDatabase(fixture.databasePath);
    const recovered = new ArtifactPublicationRepository(database)
      .get(prepared.publicationId);
    assert.equal(recovered?.state, "sealed");
    assert.equal(recovered?.contentId, sealed.content.contentId);
  } finally {
    if (database.open) database.close();
  }
});

test("sealed bytes deduplicate inside a Team but never bypass upload", async (t) => {
  const fixture = await createFixture(t);
  try {
    const source = Buffer.from("shared artifact bytes", "utf8");
    const first = fixture.service.prepare(
      fixture.principal,
      prepareInput(fixture, source, "idem_artifact_dedupe_first_1234"),
      now
    );
    fixture.service.appendChunk(
      fixture.principal,
      first.publicationId,
      0,
      source,
      chunkSha256(source),
      now
    );
    const firstSeal = fixture.service.seal(
      fixture.principal,
      first.publicationId,
      now
    );

    const second = fixture.service.prepare(
      fixture.principal,
      prepareInput(fixture, source, "idem_artifact_dedupe_second_123"),
      now
    );
    assert.throws(
      () => fixture.service.seal(fixture.principal, second.publicationId, now),
      /incomplete/u
    );
    fixture.service.appendChunk(
      fixture.principal,
      second.publicationId,
      0,
      source,
      chunkSha256(source),
      now
    );
    const secondSeal = fixture.service.seal(
      fixture.principal,
      second.publicationId,
      now
    );
    assert.equal(secondSeal.content.contentId, firstSeal.content.contentId);
    assert.equal(
      fixture.database.prepare("SELECT count(*) AS count FROM artifact_contents")
        .get().count,
      1
    );
    assert.throws(
      () => fixture.database.prepare(
        "UPDATE artifact_contents SET size_bytes = size_bytes + 1"
      ).run(),
      /immutable/u
    );
  } finally {
    fixture.database.close();
  }
});

test("sealed publication binds one canonical Artifact in one transaction", async (t) => {
  const fixture = await createFixture(t);
  try {
    const artifacts = new ArtifactRepository(
      fixture.database,
      fixture.transactions
    );
    const unsealedSource = Buffer.from("unsealed", "utf8");
    const unsealed = fixture.service.prepare(
      fixture.principal,
      prepareInput(
        fixture,
        unsealedSource,
        "idem_artifact_bind_unsealed_123"
      ),
      now
    );
    const binder = new ArtifactContentBindingService(
      fixture.transactions,
      artifacts,
      fixture.publications,
      fixture.taskRepository,
      fixture.runRepository,
      fixture.core
    );
    assert.throws(
      () => binder.bind(fixture.principal, unsealed.publicationId, now),
      /must be sealed/u
    );
    assert.equal(artifacts.getRevision(fixture.run.taskId), 0);

    const source = Buffer.from("diff --git a/b.ts b/b.ts\n+bound\n", "utf8");
    const prepared = fixture.service.prepare(
      fixture.principal,
      prepareInput(fixture, source, "idem_artifact_bind_ready_123456"),
      now
    );
    fixture.service.appendChunk(
      fixture.principal,
      prepared.publicationId,
      0,
      source,
      chunkSha256(source),
      now
    );
    const sealed = fixture.service.seal(
      fixture.principal,
      prepared.publicationId,
      now
    );
    assert.throws(
      () => binder.bind({
        ...fixture.principal,
        deviceId: "device_foreign_12345678"
      }, prepared.publicationId, now),
      /access denied/u
    );
    assert.throws(
      () => binder.bind({
        ...fixture.principal,
        teamId: "team_foreign_12345678"
      }, prepared.publicationId, now),
      /access denied/u
    );

    const failingPublications = new ArtifactPublicationRepository(
      fixture.database,
      fixture.transactions
    );
    failingPublications.bind = () => {
      throw new Error("simulated bind cut");
    };
    const cutBinder = new ArtifactContentBindingService(
      fixture.transactions,
      artifacts,
      failingPublications,
      fixture.taskRepository,
      fixture.runRepository,
      fixture.core
    );
    assert.throws(
      () => cutBinder.bind(fixture.principal, prepared.publicationId, now),
      /simulated bind cut/u
    );
    assert.equal(artifacts.getRevision(fixture.run.taskId), 0);
    assert.equal(artifacts.listForTask(fixture.run.taskId, 10).length, 0);
    assert.equal(
      fixture.publications.get(prepared.publicationId)?.state,
      "sealed"
    );

    const bound = binder.bind(fixture.principal, prepared.publicationId, now);
    assert.equal(bound.revision, 1);
    assert.equal(bound.artifact.contentMode, "snapshot_blob");
    assert.equal(bound.artifact.contentId, sealed.content.contentId);
    assert.equal(
      bound.artifact.contentPublicationId,
      prepared.publicationId
    );
    assert.equal(bound.artifact.contentSizeBytes, source.length);
    assert.equal(bound.artifact.contentMediaType, "text/x-diff");
    assert.equal(bound.artifact.contentSha256, sealed.content.sha256);
    assert.equal(bound.artifact.path, "change.patch");
    assert.equal(bound.artifact.workspaceRef, workspaceRef);
    assert.equal(bound.artifact.sourceRunId, fixture.run.runId);
    assert.equal(bound.artifact.createdByAgentId, fixture.agent.agentId);
    assert.equal(
      binder.bind(fixture.principal, prepared.publicationId, now)
        .artifact.artifactId,
      bound.artifact.artifactId
    );
    assert.equal(artifacts.getRevision(fixture.run.taskId), 1);
    assert.equal(
      fixture.publications.get(prepared.publicationId)?.state,
      "bound"
    );
    assert.throws(
      () => fixture.publications.bind(
        prepared.publicationId,
        sealed.content.contentId,
        "artifact_conflicting_12345678",
        now
      ),
      /bind conflicts/u
    );

    const derivedSource = Buffer.from(
      "diff --git a/b.test.ts b/b.test.ts\n+verified\n",
      "utf8"
    );
    const derivedInput: PrepareArtifactPublicationInput = {
      ...prepareInput(
        fixture,
        derivedSource,
        "idem_artifact_bind_lineage_1234"
      ),
      fileName: "verification.patch",
      title: "Verified derived patch",
      relations: [{
        type: "verifies",
        targetArtifactId: bound.artifact.artifactId
      }]
    };
    const derivedPrepared = fixture.service.prepare(
      fixture.principal,
      derivedInput,
      now
    );
    assert.throws(
      () => fixture.service.prepare(fixture.principal, {
        ...derivedInput,
        relations: [{
          type: "reviews",
          targetArtifactId: bound.artifact.artifactId
        }]
      }, now),
      /idempotency key conflicts/u
    );
    fixture.service.appendChunk(
      fixture.principal,
      derivedPrepared.publicationId,
      0,
      derivedSource,
      chunkSha256(derivedSource),
      now
    );
    fixture.service.seal(
      fixture.principal,
      derivedPrepared.publicationId,
      now
    );
    const derived = binder.bind(
      fixture.principal,
      derivedPrepared.publicationId,
      now
    );
    assert.equal(derived.revision, 2);
    assert.deepEqual(
      derived.artifact.relations.map(({ type, targetArtifactId }) => ({
        type,
        targetArtifactId
      })),
      [{ type: "verifies", targetArtifactId: bound.artifact.artifactId }]
    );
    assert.equal(
      binder.bind(fixture.principal, derivedPrepared.publicationId, now)
        .artifact.relations[0]?.relationId,
      derived.artifact.relations[0]?.relationId
    );

    fixture.database.prepare(`
      INSERT INTO teams (team_id, name, created_at)
      VALUES ('team_foreign_content', 'Foreign Content', ?)
    `).run(now);
    fixture.database.prepare(`
      INSERT INTO artifact_contents (
        content_id, team_id, sha256, size_bytes, storage_key, sealed_at
      ) VALUES (
        'content_foreign_scope', 'team_foreign_content', ?, 1,
        'sealed/team_foreign_content/cc/foreign', ?
      )
    `).run("c".repeat(64), now);
    assert.throws(
      () => artifacts.create({
        ...bound.artifact,
        artifactId: "artifact_foreign_content",
        artifactRevision: 0,
        contentId: "content_foreign_scope",
        contentSizeBytes: 1,
        contentSha256: "c".repeat(64)
      }),
      /content binding is invalid/u
    );
    assert.equal(artifacts.getRevision(fixture.run.taskId), 2);
  } finally {
    fixture.database.close();
  }
});

test("digest mismatch, expiry, symlink, and active-upload quota fail closed", async (t) => {
  const fixture = await createFixture(t);
  try {
    const source = Buffer.from("unsafe bytes", "utf8");
    assert.throws(
      () => fixture.service.prepare(fixture.principal, {
        ...prepareInput(
          fixture,
          source,
          "idem_artifact_hidden_name_1234"
        ),
        fileName: ".hidden.patch"
      }, now),
      /type, name, or media type/u
    );
    const mismatch = fixture.service.prepare(
      fixture.principal,
      prepareInput(
        fixture,
        source,
        "idem_artifact_digest_bad_1234",
        "c".repeat(64)
      ),
      now
    );
    fixture.service.appendChunk(
      fixture.principal,
      mismatch.publicationId,
      0,
      source,
      chunkSha256(source),
      now
    );
    assert.throws(
      () => fixture.service.seal(fixture.principal, mismatch.publicationId, now),
      /digest does not match/u
    );
    assert.equal(fixture.publications.get(mismatch.publicationId)?.state, "failed");

    const expired = fixture.service.prepare(
      fixture.principal,
      prepareInput(fixture, source, "idem_artifact_expired_1234567"),
      now
    );
    assert.throws(
      () => fixture.service.appendChunk(
        fixture.principal,
        expired.publicationId,
        0,
        source,
        chunkSha256(source),
        "2026-08-25T10:16:00.000Z"
      ),
      /expired/u
    );
    assert.equal(fixture.publications.get(expired.publicationId)?.state, "expired");

    const linked = fixture.service.prepare(
      fixture.principal,
      prepareInput(fixture, source, "idem_artifact_symlink_123456"),
      now
    );
    const temporaryPath = path.join(fixture.blobRoot, linked.tempStorageKey);
    const outsidePath = path.join(path.dirname(fixture.blobRoot), "outside.txt");
    await writeFile(outsidePath, "do not read", "utf8");
    await rm(temporaryPath);
    await symlink(outsidePath, temporaryPath);
    assert.throws(
      () => fixture.service.appendChunk(
        fixture.principal,
        linked.publicationId,
        0,
        source,
        chunkSha256(source),
        now
      ),
      /not a regular file/u
    );

    for (let index = 0; index < 15; index += 1) {
      fixture.service.prepare(
        fixture.principal,
        prepareInput(
          fixture,
          Buffer.from([index]),
          `idem_artifact_quota_${index.toString().padStart(8, "0")}`
        ),
        now
      );
    }
    assert.equal(fixture.publications.activeUploadCount(linked.teamId), 16);
    assert.throws(
      () => fixture.service.prepare(
        fixture.principal,
        prepareInput(
          fixture,
          Buffer.from("q"),
          "idem_artifact_quota_overflow_12"
        ),
        now
      ),
      /quota exceeded/u
    );

    const afterExpiry = "2026-08-25T10:16:00.000Z";
    const renewedLease = fixture.workspaceLeases.issueReadSource(
      fixture.principal,
      {
        runId: fixture.run.runId,
        agentId: fixture.agent.agentId,
        workspaceRef,
        workspaceGeneration,
        idempotencyKey: "idem_artifact_workspace_renewed_1234",
        durationSeconds: 300
      },
      afterExpiry
    );
    const reclaimed = fixture.service.prepare(
      fixture.principal,
      {
        ...prepareInput(
          fixture,
          Buffer.from("fresh"),
          "idem_artifact_quota_reclaimed_12"
        ),
        leaseId: renewedLease.leaseId
      },
      afterExpiry
    );
    assert.equal(reclaimed.state, "prepared");
    assert.equal(fixture.publications.activeUploadCount(linked.teamId), 1);
    assert.equal(fixture.publications.reservedBytes(linked.teamId), 5);
    assert.equal(fixture.publications.get(linked.publicationId)?.state, "expired");
    await assert.rejects(lstat(temporaryPath), /ENOENT/u);
  } finally {
    fixture.database.close();
  }
});
