import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
import { migrateDatabase } from "../src/data/migration-runner.js";
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

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-artifact-"));
  const databasePath = path.join(directory, "server.sqlite");
  const blobRoot = path.join(directory, "blobs");
  await migrateDatabase(databasePath);
  const database = openDatabase(databasePath);
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
    transactions
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

test("publication chunks are idempotent and sealed rename recovers after restart", async () => {
  const fixture = await createFixture();
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

test("sealed bytes deduplicate inside a Team but never bypass upload", async () => {
  const fixture = await createFixture();
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

test("sealed publication binds one canonical Artifact in one transaction", async () => {
  const fixture = await createFixture();
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
    assert.equal(artifacts.getRevision(fixture.run.taskId), 1);
  } finally {
    fixture.database.close();
  }
});

test("digest mismatch, expiry, symlink, and active-upload quota fail closed", async () => {
  const fixture = await createFixture();
  try {
    const source = Buffer.from("unsafe bytes", "utf8");
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
  } finally {
    fixture.database.close();
  }
});
