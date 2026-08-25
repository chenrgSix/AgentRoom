import type {
  ArtifactPublicationRepository,
  ArtifactPublicationRecord
} from "../artifact/artifact-publication-repository.js";
import type { CoreRepository } from "../data/core-repository.js";
import { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRepository } from "../run/run-repository.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import type {
  ArtifactRepository,
  TaskArtifactRecord
} from "./artifact-repository.js";
import type { AgentTaskRepository } from "./task-repository.js";

export class ArtifactContentBindingService {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly artifacts: ArtifactRepository,
    private readonly publications: ArtifactPublicationRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly runs: RunRepository,
    private readonly core: CoreRepository
  ) {}

  public bind(
    principal: DevicePrincipal,
    publicationId: string,
    now: string
  ): { artifact: TaskArtifactRecord; revision: number } {
    return this.transactions.immediate(() => {
      const publication = this.publications.get(publicationId);
      if (
        !publication || publication.deviceId !== principal.deviceId ||
        publication.teamId !== principal.teamId
      ) {
        throw new Error("Artifact publication access denied");
      }
      if (publication.state === "bound") {
        return this.boundResult(publication);
      }
      if (publication.state !== "sealed" || !publication.contentId) {
        throw new Error("Artifact publication must be sealed before bind");
      }
      const task = this.tasks.get(publication.taskId);
      const run = this.runs.getRun(publication.runId);
      const room = this.core.getRoom(publication.roomId);
      const agent = this.core.getAgent(publication.agentId);
      const content = this.publications.getContent(publication.contentId);
      if (
        principal.teamId !== publication.teamId ||
        !task || task.roomId !== publication.roomId ||
        !room || room.teamId !== publication.teamId ||
        !run || run.taskId !== publication.taskId ||
        run.roomId !== publication.roomId ||
        run.targetAgentId !== publication.agentId ||
        !agent || agent.teamId !== publication.teamId ||
        agent.deviceId !== publication.deviceId ||
        agent.ownerMemberId !== principal.ownerMemberId ||
        !content || content.teamId !== publication.teamId ||
        content.sha256 !== publication.declaredSha256 ||
        content.sizeBytes !== publication.declaredSize
      ) {
        throw new Error("Artifact publication scope conflicts with canonical state");
      }
      const record: TaskArtifactRecord = {
        artifactId: createOpaqueId("artifact"),
        artifactRevision: 0,
        taskId: publication.taskId,
        roomId: publication.roomId,
        type: publication.artifactType,
        workspaceRef: publication.workspaceRef,
        repository: null,
        path: publication.fileName,
        commitSha: null,
        branch: null,
        contentMode: "snapshot_blob",
        contentId: content.contentId,
        contentPublicationId: publication.publicationId,
        contentSizeBytes: content.sizeBytes,
        contentMediaType: publication.mediaType,
        contentSha256: content.sha256,
        title: publication.title,
        summary: publication.summary,
        sourceRunId: publication.runId,
        createdByMemberId: null,
        createdByAgentId: publication.agentId,
        createdAt: now
      };
      const created = this.artifacts.create(record);
      this.publications.bind(
        publication.publicationId,
        content.contentId,
        created.artifact.artifactId,
        now
      );
      return created;
    });
  }

  private boundResult(
    publication: ArtifactPublicationRecord
  ): { artifact: TaskArtifactRecord; revision: number } {
    const artifact = publication.artifactId
      ? this.artifacts.get(publication.artifactId)
      : undefined;
    if (
      !artifact || artifact.contentMode !== "snapshot_blob" ||
      artifact.contentId !== publication.contentId ||
      artifact.contentPublicationId !== publication.publicationId ||
      artifact.taskId !== publication.taskId ||
      artifact.roomId !== publication.roomId ||
      artifact.type !== publication.artifactType ||
      artifact.workspaceRef !== publication.workspaceRef ||
      artifact.path !== publication.fileName ||
      artifact.contentSizeBytes !== publication.declaredSize ||
      artifact.contentMediaType !== publication.mediaType ||
      artifact.contentSha256 !== publication.declaredSha256 ||
      artifact.sourceRunId !== publication.runId ||
      artifact.createdByAgentId !== publication.agentId
    ) {
      throw new Error("Bound Artifact publication is inconsistent");
    }
    return { artifact, revision: artifact.artifactRevision };
  }
}
