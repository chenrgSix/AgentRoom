import { type ArtifactPublicationRecord } from
  "../artifact/artifact-publication-repository.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import {
  bearerToken,
  bodyObject,
  noStore,
  requiredPositiveInteger,
  requiredString
} from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

function publicationView(publication: ArtifactPublicationRecord) {
  return {
    publicationId: publication.publicationId,
    leaseId: publication.leaseId,
    roomId: publication.roomId,
    taskId: publication.taskId,
    runId: publication.runId,
    agentId: publication.agentId,
    workspaceRef: publication.workspaceRef,
    workspaceGeneration: publication.workspaceGeneration,
    artifactType: publication.artifactType,
    fileName: publication.fileName,
    mediaType: publication.mediaType,
    title: publication.title,
    summary: publication.summary,
    declaredSize: publication.declaredSize,
    declaredSha256: publication.declaredSha256,
    receivedSize: publication.receivedSize,
    state: publication.state,
    contentId: publication.contentId,
    artifactId: publication.artifactId,
    failureCode: publication.failureCode,
    expiresAt: publication.expiresAt,
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt
  };
}

function exactBase64(value: string): Buffer {
  if (value.length === 0 || value.length > 350_000) {
    throw new Error("chunkBase64 is invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("chunkBase64 is invalid");
  }
  return decoded;
}

export function registerArtifactRoutes({
  app,
  artifactContentBinding,
  artifactPublications,
  auth,
  clock,
  requireBridgeServerToken,
  teamChanges,
  workspaceLeases
}: ServerRouteContext): void {
  const devicePrincipal = (request: Parameters<typeof bearerToken>[0]) => {
    requireBridgeServerToken(request);
    return auth.authenticateDevice(bearerToken(request), clock());
  };

  app.post("/api/bridge/workspace-leases/read-source", async (request, reply) => {
    const principal = devicePrincipal(request);
    const body = bodyObject(request);
    const duration = body.durationSeconds === undefined
      ? undefined
      : requiredPositiveInteger(body.durationSeconds, "durationSeconds");
    const lease = workspaceLeases.issueReadSource(principal, {
      runId: requiredString(body.runId, "runId", 140),
      agentId: requiredString(body.agentId, "agentId", 140),
      workspaceRef: requiredString(body.workspaceRef, "workspaceRef", 100),
      workspaceGeneration: requiredString(
        body.workspaceGeneration,
        "workspaceGeneration",
        64
      ),
      idempotencyKey: requiredString(
        body.idempotencyKey,
        "idempotencyKey",
        133
      ),
      ...(duration === undefined ? {} : { durationSeconds: duration })
    }, clock());
    noStore(reply);
    return lease;
  });

  app.get<{ Params: { leaseId: string } }>(
    "/api/bridge/workspace-leases/:leaseId",
    async (request, reply) => {
      const principal = devicePrincipal(request);
      noStore(reply);
      return workspaceLeases.getForDevice(
        principal,
        request.params.leaseId,
        clock()
      );
    }
  );

  app.post("/api/bridge/artifact-publications", async (request, reply) => {
    const principal = devicePrincipal(request);
    const body = bodyObject(request);
    const publication = artifactPublications.prepare(principal, {
      leaseId: requiredString(body.leaseId, "leaseId", 140),
      runId: requiredString(body.runId, "runId", 140),
      agentId: requiredString(body.agentId, "agentId", 140),
      workspaceRef: requiredString(body.workspaceRef, "workspaceRef", 100),
      workspaceGeneration: requiredString(
        body.workspaceGeneration,
        "workspaceGeneration",
        64
      ),
      idempotencyKey: requiredString(
        body.idempotencyKey,
        "idempotencyKey",
        133
      ),
      artifactType: requiredString(body.artifactType, "artifactType") as
        ArtifactPublicationRecord["artifactType"],
      fileName: requiredString(body.fileName, "fileName", 255),
      mediaType: requiredString(body.mediaType, "mediaType") as
        ArtifactPublicationRecord["mediaType"],
      title: requiredString(body.title, "title", 160),
      summary: requiredString(body.summary, "summary", 4_000),
      sizeBytes: requiredPositiveInteger(body.sizeBytes, "sizeBytes"),
      sha256: requiredString(body.sha256, "sha256", 64)
    }, clock());
    noStore(reply);
    return publicationView(publication);
  });

  app.get<{ Params: { publicationId: string } }>(
    "/api/bridge/artifact-publications/:publicationId",
    async (request, reply) => {
      const principal = devicePrincipal(request);
      noStore(reply);
      return publicationView(artifactPublications.getForDevice(
        principal,
        request.params.publicationId
      ));
    }
  );

  app.post<{ Params: { publicationId: string } }>(
    "/api/bridge/artifact-publications/:publicationId/chunks",
    async (request, reply) => {
      const principal = devicePrincipal(request);
      const body = bodyObject(request);
      const offset = body.offset;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
        throw new Error("offset must be a non-negative integer");
      }
      const publication = artifactPublications.appendChunk(
        principal,
        request.params.publicationId,
        offset as number,
        exactBase64(requiredString(body.chunkBase64, "chunkBase64", 350_000)),
        requiredString(body.chunkSha256, "chunkSha256", 64),
        clock()
      );
      noStore(reply);
      return publicationView(publication);
    }
  );

  app.post<{ Params: { publicationId: string } }>(
    "/api/bridge/artifact-publications/:publicationId/seal",
    async (request, reply) => {
      const principal = devicePrincipal(request);
      const sealed = artifactPublications.seal(
        principal,
        request.params.publicationId,
        clock()
      );
      noStore(reply);
      return {
        publication: publicationView(sealed.publication),
        content: {
          contentId: sealed.content.contentId,
          sha256: sealed.content.sha256,
          sizeBytes: sealed.content.sizeBytes,
          sealedAt: sealed.content.sealedAt
        }
      };
    }
  );

  app.post<{ Params: { publicationId: string } }>(
    "/api/bridge/artifact-publications/:publicationId/bind",
    async (request, reply) => {
      const principal: DevicePrincipal = devicePrincipal(request);
      const result = artifactContentBinding.bind(
        principal,
        request.params.publicationId,
        clock()
      );
      teamChanges.notify(principal.teamId, {
        kind: "room",
        roomId: result.artifact.roomId
      });
      noStore(reply);
      return result;
    }
  );
}
