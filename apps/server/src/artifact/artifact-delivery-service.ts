import type Database from "better-sqlite3";

import { AuthorizationError, type DevicePrincipal } from
  "../security/auth-service.js";
import { ArtifactPublicationRepository } from
  "./artifact-publication-repository.js";
import { LocalArtifactBlobStore } from "./local-artifact-blob-store.js";

export interface PinnedArtifactContent {
  contentId: string;
  logicalAlias: string;
  mediaType: "text/x-diff" | "text/markdown" | "application/json";
  sha256: string;
  sizeBytes: number;
}

export interface AuthorizedArtifactContent {
  artifactId: string;
  bytes: Buffer;
  content: PinnedArtifactContent;
}

interface DeliveryPayloadRow {
  payload_json: string;
}

function deny(): never {
  throw new AuthorizationError(
    "FORBIDDEN",
    "Artifact content is not authorized by this Run delivery"
  );
}

function pinnedDescriptor(
  payloadJson: string,
  artifactId: string,
  contentId: string
): PinnedArtifactContent {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return deny();
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return deny();
  }
  const contextPlan = (payload as Record<string, unknown>).contextPlan;
  if (!contextPlan || typeof contextPlan !== "object" || Array.isArray(contextPlan)) {
    return deny();
  }
  const evidence = (contextPlan as Record<string, unknown>).resultEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return deny();
  }
  const references = (evidence as Record<string, unknown>).artifactRefs;
  if (!Array.isArray(references)) return deny();
  const reference = references.find((candidate) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
    (candidate as Record<string, unknown>).artifactId === artifactId
  ) as Record<string, unknown> | undefined;
  const content = reference?.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return deny();
  }
  const descriptor = content as Record<string, unknown>;
  const logicalAlias = descriptor.logicalAlias;
  const aliasName = typeof logicalAlias === "string"
    ? logicalAlias.slice(`artifact://${artifactId}/`.length)
    : "";
  if (
    descriptor.contentId !== contentId ||
    typeof logicalAlias !== "string" ||
    !logicalAlias.startsWith(`artifact://${artifactId}/`) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(aliasName) ||
    !["text/x-diff", "text/markdown", "application/json"].includes(
      String(descriptor.mediaType)
    ) ||
    typeof descriptor.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(descriptor.sha256) ||
    !Number.isSafeInteger(descriptor.sizeBytes) ||
    (descriptor.sizeBytes as number) < 1 ||
    (descriptor.sizeBytes as number) > (4 << 20)
  ) {
    return deny();
  }
  return descriptor as unknown as PinnedArtifactContent;
}

export class ArtifactDeliveryService {
  public constructor(
    private readonly database: Database.Database,
    private readonly contents: ArtifactPublicationRepository,
    private readonly blobs: LocalArtifactBlobStore
  ) {}

  public readForDelivery(
    principal: DevicePrincipal,
    runId: string,
    artifactId: string,
    contentId: string
  ): AuthorizedArtifactContent {
    if (
      !/^run_[A-Za-z0-9_-]{8,128}$/u.test(runId) ||
      !/^artifact_[A-Za-z0-9_-]{8,128}$/u.test(artifactId) ||
      !/^content_[A-Za-z0-9_-]{8,128}$/u.test(contentId)
    ) return deny();
    const delivery = this.database.prepare(`
      SELECT payload_json FROM run_deliveries
      WHERE run_id = ? AND device_id = ? AND state IN ('pending', 'accepted')
    `).get(runId, principal.deviceId) as DeliveryPayloadRow | undefined;
    if (!delivery) return deny();
    const descriptor = pinnedDescriptor(
      delivery.payload_json,
      artifactId,
      contentId
    );
    const stored = this.contents.getContent(descriptor.contentId);
    if (
      !stored || stored.teamId !== principal.teamId ||
      stored.sizeBytes !== descriptor.sizeBytes ||
      stored.sha256 !== descriptor.sha256
    ) return deny();
    return {
      artifactId,
      content: descriptor,
      bytes: this.blobs.readVerified(
        stored.storageKey,
        descriptor.sha256,
        descriptor.sizeBytes
      )
    };
  }
}
