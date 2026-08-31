import { createHash } from "node:crypto";

import { createOpaqueId } from "../domain/identifiers.js";
import { redactSensitiveText } from "../security/redaction.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import type { WorkspaceLeaseService } from
  "../workspace/workspace-lease-service.js";
import {
  type ArtifactRelationInput,
  normalizeArtifactRelations
} from "../task/artifact-lineage.js";
import {
  type ArtifactContentRecord,
  type ArtifactPublicationRecord,
  ArtifactPublicationRepository
} from "./artifact-publication-repository.js";
import { LocalArtifactBlobStore } from "./local-artifact-blob-store.js";

const maximumArtifactBytes = 4 << 20;
const maximumChunkBytes = 256 << 10;
const maximumTeamBytes = 64 << 20;
const maximumActiveUploads = 16;
const publicationLifetimeMilliseconds = 15 * 60 * 1_000;
const idempotencyKeyPattern = /^idem_[A-Za-z0-9_-]{8,128}$/u;

export interface PrepareArtifactPublicationInput {
  leaseId: string;
  runId: string;
  agentId: string;
  workspaceRef: string;
  workspaceGeneration: string;
  idempotencyKey: string;
  artifactType: ArtifactPublicationRecord["artifactType"];
  fileName: string;
  mediaType: ArtifactPublicationRecord["mediaType"];
  title: string;
  summary: string;
  sizeBytes: number;
  sha256: string;
  relations?: ArtifactRelationInput[];
}

function boundedText(
  value: string,
  label: string,
  maximum: number
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return redactSensitiveText(normalized);
}

function requestFingerprint(input: PrepareArtifactPublicationInput): string {
  return createHash("sha256").update(JSON.stringify([
    input.leaseId,
    input.runId,
    input.agentId,
    input.workspaceRef,
    input.workspaceGeneration,
    input.idempotencyKey,
    input.artifactType,
    input.fileName,
    input.mediaType,
    input.title,
    input.summary,
    input.sizeBytes,
    input.sha256,
    input.relations ?? []
  ])).digest("hex");
}

function expectedMediaType(
  artifactType: ArtifactPublicationRecord["artifactType"]
): ArtifactPublicationRecord["mediaType"] {
  switch (artifactType) {
    case "patch": return "text/x-diff";
    case "document": return "text/markdown";
    case "test_result": return "application/json";
  }
}

function validFileName(
  artifactType: ArtifactPublicationRecord["artifactType"],
  fileName: string
): boolean {
  if (
    fileName.length === 0 || fileName.length > 255 ||
    fileName === "." || fileName === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(fileName)
  ) return false;
  const lower = fileName.toLowerCase();
  if (artifactType === "patch") return lower.endsWith(".patch") || lower.endsWith(".diff");
  if (artifactType === "document") return lower.endsWith(".md") || lower.endsWith(".markdown");
  return lower.endsWith(".json");
}

export class ArtifactPublicationService {
  public constructor(
    private readonly publications: ArtifactPublicationRepository,
    private readonly workspaceLeases: WorkspaceLeaseService,
    private readonly blobs: LocalArtifactBlobStore
  ) {}

  public prepare(
    principal: DevicePrincipal,
    input: PrepareArtifactPublicationInput,
    now: string
  ): ArtifactPublicationRecord {
    return this.publications.withCaptureWrite(input.leaseId, () => this.prepareContent(principal, input, now));
  }

  private prepareContent(
    principal: DevicePrincipal,
    input: PrepareArtifactPublicationInput,
    now: string
  ): ArtifactPublicationRecord {
    const normalized = this.validatePrepareInput(input);
    const nowMilliseconds = Date.parse(now);
    if (!Number.isFinite(nowMilliseconds)) {
      throw new Error("Artifact publication time is invalid");
    }
    for (const expired of this.publications.expireDueUploads(
      principal.teamId,
      now
    )) {
      this.blobs.discardExpiredUpload(expired.tempStorageKey);
    }
    const fingerprint = requestFingerprint(normalized);
    const retry = this.publications.getByIdempotency(
      principal.deviceId,
      normalized.idempotencyKey
    );
    if (retry) {
      if (retry.requestFingerprint !== fingerprint) {
        throw new Error("Artifact publication idempotency key conflicts");
      }
      if (retry.state === "prepared" || retry.state === "receiving") {
        this.workspaceLeases.requireCurrentCapturePublication(principal, retry, now);
        this.blobs.ensureUpload(retry.tempStorageKey);
      }
      return retry;
    }
    const lease = this.workspaceLeases.requireActivePublicationSource(
      principal,
      normalized.leaseId,
      normalized,
      now
    );
    if (
      this.publications.activeUploadCount(principal.teamId) >=
        maximumActiveUploads ||
      this.publications.reservedBytes(principal.teamId) + normalized.sizeBytes >
        maximumTeamBytes
    ) {
      throw new Error("Artifact publication quota exceeded");
    }
    const publicationId = createOpaqueId("publication");
    const tempStorageKey = `tmp/${publicationId}.upload`;
    this.blobs.ensureUpload(tempStorageKey);
    const record: ArtifactPublicationRecord = {
      publicationId,
      requestFingerprint: fingerprint,
      idempotencyKey: normalized.idempotencyKey,
      teamId: principal.teamId,
      deviceId: principal.deviceId,
      leaseId: lease.leaseId,
      roomId: lease.roomId,
      taskId: lease.taskId,
      runId: lease.runId,
      agentId: lease.agentId,
      workspaceRef: lease.workspaceRef,
      workspaceGeneration: lease.workspaceGeneration,
      artifactType: normalized.artifactType,
      fileName: normalized.fileName,
      mediaType: normalized.mediaType,
      title: normalized.title,
      summary: normalized.summary,
      declaredSize: normalized.sizeBytes,
      declaredSha256: normalized.sha256,
      receivedSize: 0,
      state: "prepared",
      tempStorageKey,
      contentId: null,
      artifactId: null,
      failureCode: null,
      expiresAt: new Date(
        nowMilliseconds + publicationLifetimeMilliseconds
      ).toISOString(),
      createdAt: now,
      updatedAt: now,
      relations: normalized.relations ?? []
    };
    try {
      const created = this.publications.create(record);
      if (created.publicationId !== publicationId) {
        this.blobs.discardUpload(tempStorageKey);
        if (created.requestFingerprint !== fingerprint) {
          throw new Error("Artifact publication idempotency key conflicts");
        }
        if (created.state === "prepared" || created.state === "receiving") {
          this.blobs.ensureUpload(created.tempStorageKey);
        }
      }
      return created;
    } catch (error) {
      this.blobs.discardUpload(tempStorageKey);
      throw error;
    }
  }

  public getForDevice(
    principal: DevicePrincipal,
    publicationId: string
  ): ArtifactPublicationRecord {
    const publication = this.publications.get(publicationId);
    if (!publication || publication.deviceId !== principal.deviceId) {
      throw new Error("Artifact publication access denied");
    }
    return publication;
  }

  public appendChunk(
    principal: DevicePrincipal, publicationId: string, expectedOffset: number,
    chunk: Buffer, chunkSha256: string, now: string
  ): ArtifactPublicationRecord {
    const publication = this.getForDevice(principal, publicationId);
    return this.publications.withCaptureWrite(publication.leaseId, () =>
      this.appendContent(principal, publicationId, expectedOffset, chunk, chunkSha256, now));
  }

  private appendContent(
    principal: DevicePrincipal,
    publicationId: string,
    expectedOffset: number,
    chunk: Buffer,
    chunkSha256: string,
    now: string
  ): ArtifactPublicationRecord {
    let publication = this.getForDevice(principal, publicationId);
    this.workspaceLeases.requireCurrentCapturePublication(principal, publication, now);
    this.requireWritable(publication, now);
    if (
      !Number.isSafeInteger(expectedOffset) || expectedOffset < 0 ||
      chunk.length === 0 || chunk.length > maximumChunkBytes ||
      !/^[0-9a-f]{64}$/u.test(chunkSha256) ||
      createHash("sha256").update(chunk).digest("hex") !== chunkSha256
    ) {
      throw new Error("Artifact publication chunk is invalid");
    }
    this.reconcileTemporarySize(publication, now);
    publication = this.getForDevice(principal, publicationId);
    if (expectedOffset < publication.receivedSize) {
      if (
        expectedOffset + chunk.length <= publication.receivedSize &&
        this.blobs.matches(publication.tempStorageKey, expectedOffset, chunk)
      ) return publication;
      throw new Error("Artifact publication chunk conflicts with stored bytes");
    }
    if (
      expectedOffset !== publication.receivedSize ||
      expectedOffset + chunk.length > publication.declaredSize
    ) {
      throw new Error("Artifact publication chunk offset is invalid");
    }
    this.blobs.append(publication.tempStorageKey, expectedOffset, chunk);
    return this.publications.advanceReceived(
      publicationId,
      expectedOffset,
      expectedOffset + chunk.length,
      now
    );
  }

  public seal(
    principal: DevicePrincipal, publicationId: string, now: string
  ): { publication: ArtifactPublicationRecord; content: ArtifactContentRecord } {
    const publication = this.getForDevice(principal, publicationId);
    return this.publications.withCaptureWrite(publication.leaseId, () => this.sealContent(principal, publicationId, now));
  }

  private sealContent(
    principal: DevicePrincipal,
    publicationId: string,
    now: string
  ): { publication: ArtifactPublicationRecord; content: ArtifactContentRecord } {
    const publication = this.getForDevice(principal, publicationId);
    if (publication.state === "sealed" || publication.state === "bound") {
      const content = publication.contentId
        ? this.publications.getContent(publication.contentId)
        : undefined;
      if (!content) throw new Error("Sealed Artifact content metadata is missing");
      return { publication, content };
    }
    this.workspaceLeases.requireCurrentCapturePublication(principal, publication, now);
    this.requireWritable(publication, now);
    const storageKey = this.sealedStorageKey(publication);
    const temporaryExists = this.blobs.existsRegular(
      publication.tempStorageKey
    );
    const sealedAlready = this.blobs.hasMatchingBlob(
      storageKey,
      publication.declaredSha256,
      publication.declaredSize
    );
    if (
      temporaryExists || !sealedAlready ||
      publication.receivedSize !== publication.declaredSize
    ) {
      this.reconcileTemporarySize(publication, now);
    }
    const refreshed = this.getForDevice(principal, publicationId);
    if (refreshed.receivedSize !== refreshed.declaredSize) {
      throw new Error("Artifact publication is incomplete");
    }
    if (this.blobs.existsRegular(refreshed.tempStorageKey)) {
      const actual = this.blobs.digest(refreshed.tempStorageKey);
      if (
        actual.sha256 !== refreshed.declaredSha256 ||
        actual.size !== refreshed.declaredSize
      ) {
        this.publications.markFailed(publicationId, "digest_mismatch", now);
        this.blobs.discardUpload(refreshed.tempStorageKey);
        throw new Error("Artifact publication digest does not match");
      }
    }
    this.blobs.seal(
      refreshed.tempStorageKey,
      storageKey,
      refreshed.declaredSha256,
      refreshed.declaredSize
    );
    const content: ArtifactContentRecord = {
      contentId: createOpaqueId("content"),
      teamId: refreshed.teamId,
      sha256: refreshed.declaredSha256,
      sizeBytes: refreshed.declaredSize,
      storageKey,
      sealedAt: now
    };
    return this.publications.seal(publicationId, content, now);
  }

  private requireWritable(
    publication: ArtifactPublicationRecord,
    now: string
  ): void {
    if (Date.parse(publication.expiresAt) <= Date.parse(now)) {
      if (publication.state === "prepared" || publication.state === "receiving") {
        this.publications.markExpired(publication.publicationId, now);
        this.blobs.discardUpload(publication.tempStorageKey);
      }
      throw new Error("Artifact publication expired");
    }
    if (publication.state !== "prepared" && publication.state !== "receiving") {
      throw new Error("Artifact publication is not writable");
    }
  }

  private reconcileTemporarySize(
    publication: ArtifactPublicationRecord,
    now: string
  ): void {
    this.blobs.ensureUpload(publication.tempStorageKey);
    const size = this.blobs.size(publication.tempStorageKey);
    if (size < publication.receivedSize) {
      this.publications.markFailed(
        publication.publicationId,
        "stored_bytes_missing",
        now
      );
      throw new Error("Artifact publication stored bytes are incomplete");
    }
    if (size > publication.receivedSize) {
      this.blobs.truncate(publication.tempStorageKey, publication.receivedSize);
    }
  }

  private sealedStorageKey(publication: ArtifactPublicationRecord): string {
    return [
      "sealed",
      publication.teamId,
      publication.declaredSha256.slice(0, 2),
      publication.declaredSha256
    ].join("/");
  }

  private validatePrepareInput(
    input: PrepareArtifactPublicationInput
  ): PrepareArtifactPublicationInput {
    if (!idempotencyKeyPattern.test(input.idempotencyKey)) {
      throw new Error("Artifact publication idempotency key is invalid");
    }
    if (
      !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 ||
      input.sizeBytes > maximumArtifactBytes ||
      !/^[0-9a-f]{64}$/u.test(input.sha256)
    ) {
      throw new Error("Artifact publication size or digest is invalid");
    }
    if (
      input.mediaType !== expectedMediaType(input.artifactType) ||
      !validFileName(input.artifactType, input.fileName)
    ) {
      throw new Error("Artifact publication type, name, or media type is invalid");
    }
    return {
      ...input,
      title: boundedText(input.title, "Artifact title", 160),
      summary: boundedText(input.summary, "Artifact summary", 4_000),
      relations: normalizeArtifactRelations(input.relations)
    };
  }
}
