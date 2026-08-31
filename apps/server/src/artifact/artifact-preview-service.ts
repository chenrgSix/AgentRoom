import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";
import type {
  ArtifactRepository,
  ArtifactType
} from "../task/artifact-repository.js";
import type { ArtifactPublicationRepository } from
  "./artifact-publication-repository.js";
import type { LocalArtifactBlobStore } from "./local-artifact-blob-store.js";

const maximumPreviewCharacters = 200_000;
const taskIdPattern = /^task_[A-Za-z0-9_-]{8,128}$/u;
const artifactIdPattern = /^artifact_[A-Za-z0-9_-]{8,128}$/u;

export interface ArtifactPreview {
  artifactId: string;
  artifactRevision: number;
  taskId: string;
  type: Extract<ArtifactType, "patch" | "document" | "test_result">;
  title: string;
  summary: string;
  mediaType: "text/x-diff" | "text/markdown" | "application/json";
  sha256: string;
  sizeBytes: number;
  integrity: "verified";
  trust: "untrusted";
  text: string;
  truncated: boolean;
}

function deny(): never {
  throw new AuthorizationError("FORBIDDEN", "Artifact preview access denied");
}

export function boundedUtf8ArtifactPreview(bytes: Buffer): {
  text: string;
  truncated: boolean;
} {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Artifact snapshot is not valid UTF-8 text");
  }
  return {
    text: source.slice(0, maximumPreviewCharacters),
    truncated: source.length > maximumPreviewCharacters
  };
}

export class ArtifactPreviewService {
  public constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly contents: ArtifactPublicationRepository,
    private readonly blobs: LocalArtifactBlobStore,
    private readonly auth: AuthService
  ) {}

  public read(
    principal: WebPrincipal,
    taskId: string,
    artifactId: string
  ): ArtifactPreview {
    if (
      !taskIdPattern.test(taskId) ||
      !artifactIdPattern.test(artifactId)
    ) return deny();
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.taskId !== taskId) return deny();
    const member = this.auth.requireRoomMember(principal, artifact.roomId);
    if (
      artifact.contentMode !== "snapshot_blob" ||
      !artifact.contentId ||
      artifact.contentSizeBytes === null ||
      !artifact.contentMediaType ||
      artifact.contentMediaType === "application/x-git-bundle" ||
      !artifact.contentSha256 ||
      !["patch", "document", "test_result"].includes(artifact.type)
    ) {
      throw new Error("Artifact has no previewable snapshot");
    }
    const content = this.contents.getContent(artifact.contentId);
    if (
      !content ||
      content.teamId !== member.teamId ||
      content.sizeBytes !== artifact.contentSizeBytes ||
      content.sha256 !== artifact.contentSha256
    ) {
      throw new Error("Artifact snapshot metadata is inconsistent");
    }
    const bytes = this.blobs.readVerified(
      content.storageKey,
      artifact.contentSha256,
      artifact.contentSizeBytes
    );
    const bounded = boundedUtf8ArtifactPreview(bytes);
    return {
      artifactId: artifact.artifactId,
      artifactRevision: artifact.artifactRevision,
      taskId: artifact.taskId,
      type: artifact.type as ArtifactPreview["type"],
      title: artifact.title,
      summary: artifact.summary,
      mediaType: artifact.contentMediaType,
      sha256: artifact.contentSha256,
      sizeBytes: artifact.contentSizeBytes,
      integrity: "verified",
      trust: "untrusted",
      text: bounded.text,
      truncated: bounded.truncated
    };
  }
}
