import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServerApp } from "../src/app.js";
import { BridgeConnectionRegistry } from
  "../src/bridge/bridge-connection-registry.js";
import { CoreRepository } from "../src/data/core-repository.js";
import { openDatabase } from "../src/data/database.js";
import { AgentService } from "../src/registry/agent-service.js";
import { MemberDeviceService } from "../src/registry/member-device-service.js";
import { RunRepository } from "../src/run/run-repository.js";
import { RunService } from "../src/run/run-service.js";
import { DeliveryService } from "../src/run/delivery-service.js";
import { AuthService } from "../src/security/auth-service.js";
import { MessageService } from "../src/team-room/message-service.js";
import { TeamRoomService } from "../src/team-room/team-room-service.js";
import { ArtifactRepository } from "../src/task/artifact-repository.js";
import { ContextPlanner } from "../src/task/context-planner.js";
import { TaskArtifactService } from "../src/task/task-artifact-service.js";
import { AgentTaskRepository } from "../src/task/task-repository.js";

const now = "2026-08-25T10:00:00.000Z";
const serverToken = "artifact-route-server-token-1234567890";
const workspaceRef = `workspace_${"a".repeat(64)}`;
const workspaceGeneration = "b".repeat(64);

test("Bridge HTTP publication binds bytes without exposing local storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-room-artifact-http-"));
  const databasePath = path.join(directory, "server.sqlite");
  const blobRoot = path.join(directory, "private-artifact-blobs");
  const app = await createServerApp({
    artifactBlobRoot: blobRoot,
    bridgeServerToken: serverToken,
    clock: () => now,
    databasePath,
    logger: false
  });
  const database = openDatabase(databasePath);
  try {
    const core = new CoreRepository(database);
    const auth = new AuthService(database);
    const teams = new TeamRoomService(core, auth);
    const registry = new MemberDeviceService(core, auth);
    const agents = new AgentService(core, auth);
    const messages = new MessageService(core, auth);
    const runRepository = new RunRepository(database);
    const taskRepository = new AgentTaskRepository(database);
    const runs = new RunService(core, runRepository, auth, taskRepository);
    const created = teams.createTeamForUser({
      userId: "user_artifact_http_12345678",
      userDisplayName: "Alice",
      teamName: "Artifact HTTP Team",
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
        supportsWorkspaceLeases: true,
        supportsArtifactPublication: true
      },
      now
    });
    const message = messages.createMemberMessage(member, {
      roomId: room.roomId,
      content: "Publish a verified patch.",
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
    const headers = {
      authorization: `Bearer ${credential.secret}`,
      "x-agentroom-server-token": serverToken
    };
    const refreshedGeneration = "c".repeat(64);
    const snapshotUrl =
      `/api/bridge/workspace-source-snapshots/${run.runId}/${agent.agentId}`;
    const snapshotResponse = await app.inject({
      method: "GET",
      url: snapshotUrl,
      headers
    });
    assert.equal(snapshotResponse.statusCode, 200, snapshotResponse.body);
    assert.equal(snapshotResponse.json().workspaceGeneration, workspaceGeneration);
    const refreshResponse = await app.inject({
      method: "POST",
      url: snapshotUrl,
      headers,
      payload: {
        workspaceRef,
        expectedWorkspaceGeneration: workspaceGeneration,
        workspaceGeneration: refreshedGeneration
      }
    });
    assert.equal(refreshResponse.statusCode, 200, refreshResponse.body);
    assert.equal(
      refreshResponse.json().workspaceGeneration,
      refreshedGeneration
    );
    const conflictingRefresh = await app.inject({
      method: "POST",
      url: snapshotUrl,
      headers,
      payload: {
        workspaceRef,
        expectedWorkspaceGeneration: workspaceGeneration,
        workspaceGeneration: "d".repeat(64)
      }
    });
    assert.equal(conflictingRefresh.statusCode, 400);

    const leasePayload = {
      runId: run.runId,
      agentId: agent.agentId,
      workspaceRef,
      workspaceGeneration: refreshedGeneration,
      idempotencyKey: "idem_artifact_http_lease_123456"
    };
    const unauthorized = await app.inject({
      method: "POST",
      url: "/api/bridge/workspace-leases/read-source",
      headers: { authorization: headers.authorization },
      payload: leasePayload
    });
    assert.equal(unauthorized.statusCode, 401);

    const leaseResponse = await app.inject({
      method: "POST",
      url: "/api/bridge/workspace-leases/read-source",
      headers,
      payload: leasePayload
    });
    assert.equal(leaseResponse.statusCode, 200);
    const leaseId = leaseResponse.json().leaseId as string;
    assert.equal(leaseResponse.json().workspaceRef, workspaceRef);

    const source = Buffer.from("diff --git a/a.ts b/a.ts\n+http verified\n", "utf8");
    const sha256 = createHash("sha256").update(source).digest("hex");
    const publicationResponse = await app.inject({
      method: "POST",
      url: "/api/bridge/artifact-publications",
      headers,
      payload: {
        leaseId,
        runId: run.runId,
        agentId: agent.agentId,
        workspaceRef,
        workspaceGeneration: refreshedGeneration,
        idempotencyKey: "idem_artifact_http_publish_1234",
        artifactType: "patch",
        fileName: "change.patch",
        mediaType: "text/x-diff",
        title: "HTTP verified patch",
        summary: "Published through the Device-authenticated HTTP boundary.",
        sizeBytes: source.length,
        sha256
      }
    });
    assert.equal(publicationResponse.statusCode, 200);
    const publication = publicationResponse.json();
    const publicationId = publication.publicationId as string;
    assert.equal(publication.receivedSize, 0);
    assert.equal("tempStorageKey" in publication, false);
    assert.equal(publicationResponse.body.includes(blobRoot), false);

    const chunkResponse = await app.inject({
      method: "POST",
      url: `/api/bridge/artifact-publications/${publicationId}/chunks`,
      headers,
      payload: {
        offset: 0,
        chunkBase64: source.toString("base64"),
        chunkSha256: sha256
      }
    });
    assert.equal(chunkResponse.statusCode, 200);
    assert.equal(chunkResponse.json().receivedSize, source.length);

    const sealResponse = await app.inject({
      method: "POST",
      url: `/api/bridge/artifact-publications/${publicationId}/seal`,
      headers,
      payload: {}
    });
    assert.equal(sealResponse.statusCode, 200);
    assert.equal(sealResponse.json().publication.state, "sealed");
    assert.equal(sealResponse.json().content.sha256, sha256);
    assert.equal("storageKey" in sealResponse.json().content, false);

    const bindResponse = await app.inject({
      method: "POST",
      url: `/api/bridge/artifact-publications/${publicationId}/bind`,
      headers,
      payload: {}
    });
    assert.equal(bindResponse.statusCode, 200);
    assert.equal(bindResponse.json().revision, 1);
    assert.equal(bindResponse.json().artifact.contentSha256, sha256);
    const artifactId = bindResponse.json().artifact.artifactId as string;
    const contentId = bindResponse.json().artifact.contentId as string;

    const retry = await app.inject({
      method: "POST",
      url: `/api/bridge/artifact-publications/${publicationId}/bind`,
      headers,
      payload: {}
    });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().artifact.artifactId, artifactId);
    assert.equal(new ArtifactRepository(database).getRevision(run.taskId), 1);

    const previewUrl =
      `/api/tasks/${run.taskId}/artifacts/${artifactId}/preview`;
    const preview = await app.inject({
      method: "GET",
      url: previewUrl,
      headers: { authorization: `Bearer ${session.secret}` }
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json(), {
      artifactId,
      artifactRevision: 1,
      taskId: run.taskId,
      type: "patch",
      title: "HTTP verified patch",
      summary: "Published through the Device-authenticated HTTP boundary.",
      mediaType: "text/x-diff",
      sha256,
      sizeBytes: source.length,
      integrity: "verified",
      trust: "untrusted",
      text: source.toString("utf8"),
      truncated: false
    });
    assert.equal(preview.headers["cache-control"], "no-store");
    assert.equal(preview.headers["x-content-type-options"], "nosniff");
    assert.equal(preview.body.includes(blobRoot), false);
    assert.equal(preview.body.includes("storageKey"), false);
    assert.equal(preview.body.includes("workspaceRef"), false);

    const outsider = teams.createTeamForUser({
      userId: "user_artifact_outsider_12345678",
      userDisplayName: "Mallory",
      teamName: "Other Artifact Team",
      now
    });
    const outsiderSession = auth.issueWebSession(
      outsider.owner.userId ?? "",
      now,
      "2026-08-25T11:00:00.000Z"
    );
    const deniedPreview = await app.inject({
      method: "GET",
      url: previewUrl,
      headers: { authorization: `Bearer ${outsiderSession.secret}` }
    });
    assert.equal(deniedPreview.statusCode, 403);
    assert.equal(deniedPreview.body.includes(source.toString("utf8")), false);

    const targetDevice = registry.registerOwnDevice(
      member,
      created.team.teamId,
      "Reviewer Mac",
      now
    );
    const targetAgent = agents.publishAgent(member, {
      teamId: created.team.teamId,
      deviceId: targetDevice.deviceId,
      name: "Reviewer",
      role: "Managed",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: true,
        supportsStart: true,
        supportsStreaming: true,
        supportsArtifactMaterialization: true
      },
      now
    });
    const downstreamMessage = messages.createMemberMessage(member, {
      roomId: room.roomId,
      content: "Review the pinned patch.",
      mentions: [{
        targetType: "agent",
        targetAgentId: targetAgent.agentId,
        displayLabel: "Reviewer / Managed"
      }],
      now
    });
    const downstreamRun = runs.createRunsForMessage(
      member,
      downstreamMessage.messageId,
      now
    )[0];
    assert.ok(downstreamRun);
    const delivery = new DeliveryService(
      database,
      core,
      runRepository,
      new ContextPlanner(database, core, taskRepository),
      new BridgeConnectionRegistry(),
      () => now
    );
    const pinnedDelivery = delivery.dispatch(downstreamRun.runId);
    const pinnedArtifact = pinnedDelivery?.payload.contextPlan.resultEvidence
      ?.artifactRefs.find((candidate) => candidate.artifactId === artifactId);
    assert.deepEqual(pinnedArtifact?.content, {
      contentId,
      logicalAlias: `artifact://${artifactId}/change.patch`,
      mediaType: "text/x-diff",
      sha256,
      sizeBytes: source.length
    });
    const pinnedHash = pinnedDelivery?.payloadHash;
    const artifacts = new TaskArtifactService(
      new ArtifactRepository(database),
      taskRepository,
      runRepository,
      core,
      auth
    );
    const referenceOnly = artifacts.create(member, run.taskId, {
      type: "document",
      workspaceRef,
      path: "later.md",
      title: "Later evidence",
      summary: "Created after the downstream delivery was frozen."
    }, now);
    const referencePreview = await app.inject({
      method: "GET",
      url: `/api/tasks/${run.taskId}/artifacts/` +
        `${referenceOnly.artifact.artifactId}/preview`,
      headers: { authorization: `Bearer ${session.secret}` }
    });
    assert.equal(referencePreview.statusCode, 400);
    const repeatedDelivery = delivery.dispatch(downstreamRun.runId);
    assert.equal(repeatedDelivery?.payloadHash, pinnedHash);
    assert.deepEqual(
      repeatedDelivery?.payload.contextPlan.resultEvidence,
      pinnedDelivery?.payload.contextPlan.resultEvidence
    );
    const reopened = openDatabase(databasePath);
    try {
      const recovered = new DeliveryService(
        reopened,
        new CoreRepository(reopened),
        new RunRepository(reopened),
        new ContextPlanner(
          reopened,
          new CoreRepository(reopened),
          new AgentTaskRepository(reopened)
        ),
        new BridgeConnectionRegistry(),
        () => now
      ).getByRun(downstreamRun.runId);
      assert.equal(recovered?.payloadHash, pinnedHash);
      assert.deepEqual(
        recovered?.payload.contextPlan.resultEvidence,
        pinnedDelivery?.payload.contextPlan.resultEvidence
      );
    } finally {
      reopened.close();
    }

    const targetCredential = auth.issueDeviceCredential(targetDevice.deviceId, now);
    const targetPrincipal = auth.authenticateDevice(targetCredential.secret, now);
    const targetHeaders = {
      authorization: `Bearer ${targetCredential.secret}`,
      "x-agentroom-server-token": serverToken
    };
    const downloadUrl =
      `/api/bridge/runs/${downstreamRun.runId}/artifacts/${artifactId}` +
      `/contents/${contentId}`;
    const pendingRange = await app.inject({
      method: "GET",
      url: downloadUrl,
      headers: { ...targetHeaders, range: "bytes=0-4" }
    });
    assert.equal(pendingRange.statusCode, 206);
    assert.deepEqual(pendingRange.rawPayload, source.subarray(0, 5));
    assert.throws(() => delivery.accept(
      targetPrincipal,
      downstreamRun.runId,
      downstreamRun.traceId,
      targetAgent.agentId,
      1,
      now
    ), /materialization receipts/u);
    assert.throws(() => delivery.accept(
      targetPrincipal,
      downstreamRun.runId,
      downstreamRun.traceId,
      targetAgent.agentId,
      1,
      now,
      [{
        artifactId,
        contentId,
        logicalAlias: `artifact://${artifactId}/change.patch`,
        mediaType: "text/x-diff",
        sha256: "f".repeat(64),
        sizeBytes: source.length,
        materializationState: "verified"
      }]
    ), /materialization receipts/u);
    assert.throws(() => delivery.accept(
      targetPrincipal,
      downstreamRun.runId,
      downstreamRun.traceId,
      targetAgent.agentId,
      1,
      now,
      undefined,
      {
        code: "ARTIFACT_MATERIALIZATION_FAILED",
        message: "retry later",
        retryable: true
      }
    ), /materialization failure/u);
    assert.equal(delivery.accept(
      targetPrincipal,
      downstreamRun.runId,
      downstreamRun.traceId,
      targetAgent.agentId,
      1,
      now,
      [{
        artifactId,
        contentId,
        logicalAlias: `artifact://${artifactId}/change.patch`,
        mediaType: "text/x-diff",
        sha256,
        sizeBytes: source.length,
        materializationState: "verified"
      }]
    ).state, "delivered");
    const download = await app.inject({
      method: "GET",
      url: downloadUrl,
      headers: targetHeaders
    });
    assert.equal(download.statusCode, 200, download.body);
    assert.deepEqual(download.rawPayload, source);
    assert.equal(download.headers["x-agentroom-content-id"], contentId);
    assert.equal(download.headers["x-agentroom-content-sha256"], sha256);
    assert.equal(
      download.headers["x-agentroom-logical-alias"],
      `artifact://${artifactId}/change.patch`
    );
    assert.equal(download.body.includes(blobRoot), false);
    const rangedDownload = await app.inject({
      method: "GET",
      url: downloadUrl,
      headers: { ...targetHeaders, range: "bytes=5-17" }
    });
    assert.equal(rangedDownload.statusCode, 206);
    assert.equal(
      rangedDownload.headers["content-range"],
      `bytes 5-17/${source.length}`
    );
    assert.deepEqual(rangedDownload.rawPayload, source.subarray(5, 18));
    const invalidRange = await app.inject({
      method: "GET",
      url: downloadUrl,
      headers: { ...targetHeaders, range: `bytes=0-${source.length}` }
    });
    assert.equal(invalidRange.statusCode, 416);

    const failureMessage = messages.createMemberMessage(member, {
      roomId: room.roomId,
      content: "Verify materialization failure handling.",
      mentions: [{
        targetType: "agent",
        targetAgentId: targetAgent.agentId,
        displayLabel: "Reviewer / Managed"
      }],
      now
    });
    const failureRun = runs.createRunsForMessage(
      member,
      failureMessage.messageId,
      now
    )[0];
    assert.ok(failureRun);
    assert.ok(delivery.dispatch(failureRun.runId)?.payload.contextPlan
      .resultEvidence?.artifactRefs.some((reference) => reference.content));
    assert.equal(delivery.accept(
      targetPrincipal,
      failureRun.runId,
      failureRun.traceId,
      targetAgent.agentId,
      1,
      now,
      undefined,
      {
        code: "ARTIFACT_MATERIALIZATION_FAILED",
        message: "Pinned Artifact content could not be verified in isolated staging.",
        retryable: false
      }
    ).state, "delivered");

    const wrongDevice = await app.inject({
      method: "GET",
      url: downloadUrl,
      headers
    });
    assert.equal(wrongDevice.statusCode, 403);
    const unpinnedContent = await app.inject({
      method: "GET",
      url: downloadUrl.replace(contentId, "content_unpinned_12345678"),
      headers: targetHeaders
    });
    assert.equal(unpinnedContent.statusCode, 403);

    const legacyAgent = agents.publishAgent(member, {
      teamId: created.team.teamId,
      deviceId: targetDevice.deviceId,
      name: "Legacy Reviewer",
      role: "Managed",
      integrationMode: "managed",
      capabilities: {
        supportsHandoff: false,
        supportsInterrupt: true,
        supportsResume: false,
        supportsStart: true,
        supportsStreaming: true
      },
      now
    });
    const legacyMessage = messages.createMemberMessage(member, {
      roomId: room.roomId,
      content: "Read reference-only evidence.",
      mentions: [{
        targetType: "agent",
        targetAgentId: legacyAgent.agentId,
        displayLabel: "Legacy Reviewer / Managed"
      }],
      now
    });
    const legacyRun = runs.createRunsForMessage(
      member,
      legacyMessage.messageId,
      now
    )[0];
    assert.ok(legacyRun);
    const legacyDelivery = delivery.dispatch(legacyRun.runId);
    const legacyArtifact = legacyDelivery?.payload.contextPlan.resultEvidence
      ?.artifactRefs.find((candidate) => candidate.artifactId === artifactId);
    assert.ok(legacyArtifact);
    assert.equal(legacyArtifact.content, undefined);
    const legacyDownload = await app.inject({
      method: "GET",
      url: downloadUrl.replace(downstreamRun.runId, legacyRun.runId),
      headers: targetHeaders
    });
    assert.equal(legacyDownload.statusCode, 403);

    const status = await app.inject({
      method: "GET",
      url: `/api/bridge/artifact-publications/${publicationId}`,
      headers
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().state, "bound");
    assert.equal(status.json().artifactId, artifactId);
    assert.equal(status.body.includes(blobRoot), false);
    assert.equal(status.body.includes("/Users/"), false);
  } finally {
    database.close();
    await app.close();
  }
});
