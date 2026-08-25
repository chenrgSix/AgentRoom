import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRepository } from "../run/run-repository.js";
import type {
  AuthService,
  McpPrincipal,
  WebPrincipal
} from "../security/auth-service.js";
import { redactSensitiveText } from "../security/redaction.js";
import {
  type ArtifactRepository,
  type ArtifactType,
  type TaskArtifactRecord
} from "./artifact-repository.js";
import type { AgentTaskRepository } from "./task-repository.js";

const artifactTypes = new Set<ArtifactType>([
  "commit", "branch", "file", "patch", "test_result", "document"
]);

export interface CreateArtifactInput {
  type: ArtifactType;
  workspaceRef?: string | null;
  repository?: string | null;
  path?: string | null;
  commitSha?: string | null;
  branch?: string | null;
  title: string;
  summary: string;
  sourceRunId?: string | null;
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || value.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function optionalReference(
  value: string | null | undefined,
  label: string,
  maximum: number
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = boundedText(value, label, maximum);
  if (/\p{Cc}/u.test(normalized)) {
    throw new Error(`${label} contains control characters`);
  }
  return normalized;
}

function safeWorkspaceReference(value: string | null): string | null {
  if (
    value && (
      value.startsWith("/") || value.startsWith("~") ||
      /^[A-Za-z]:[\\/]/u.test(value) || value.includes("://") ||
      !/^[A-Za-z0-9._/-]+$/u.test(value) ||
      value.split("/").includes("..")
    )
  ) {
    throw new Error("Artifact workspace reference must be an opaque identifier");
  }
  return value;
}

function safeRelativePath(value: string | null): string | null {
  if (!value) return null;
  if (
    value.startsWith("/") || value.startsWith("~") ||
    /^[A-Za-z]:[\\/]/u.test(value) || value.includes("://") ||
    value.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("Artifact path must be workspace-relative");
  }
  return value;
}

function safeRepositoryReference(value: string | null): string | null {
  if (value && !/^[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error("Artifact repository must be a credential-free identifier");
  }
  return value;
}

function safeBranch(value: string | null): string | null {
  if (
    value && (
      /\s|\.\.|@\{|[~^:?*[\\]/u.test(value) ||
      value === "@" || value.startsWith("/") || value.endsWith("/") ||
      value.endsWith(".") || value.includes("//") ||
      value.split("/").some((component) =>
        component.startsWith(".") || component.endsWith(".lock")
      )
    )
  ) {
    throw new Error("Artifact branch reference is invalid");
  }
  return value;
}

export class TaskArtifactService {
  public constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly runs: RunRepository,
    private readonly core: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public list(
    principal: WebPrincipal | McpPrincipal,
    taskId: string,
    limit = 100
  ): { revision: number; artifacts: TaskArtifactRecord[] } {
    const task = this.requireTaskAccess(principal, taskId);
    return {
      revision: task.artifactRevision,
      artifacts: this.artifacts.listForTask(taskId, Math.min(Math.max(limit, 1), 100))
    };
  }

  public create(
    principal: WebPrincipal | McpPrincipal,
    taskId: string,
    input: CreateArtifactInput,
    now: string
  ): { artifact: TaskArtifactRecord; revision: number } {
    const task = this.requireTaskAccess(principal, taskId);
    if (!artifactTypes.has(input.type)) {
      throw new Error("Unsupported Artifact type");
    }
    const sourceRunId = input.sourceRunId ?? null;
    if (sourceRunId) {
      const run = this.runs.getRun(sourceRunId);
      if (!run || run.taskId !== task.taskId || run.roomId !== task.roomId) {
        throw new Error("Artifact source Run must belong to its Task");
      }
      if ("agentId" in principal && run.targetAgentId !== principal.agentId) {
        throw new Error("Agent may reference only its own assigned Run");
      }
    }
    const workspaceRef = safeWorkspaceReference(optionalReference(
      input.workspaceRef,
      "Artifact workspace reference",
      512
    ));
    const repository = safeRepositoryReference(optionalReference(
      input.repository,
      "Artifact repository",
      512
    ));
    const artifactPath = safeRelativePath(optionalReference(
      input.path,
      "Artifact path",
      1024
    ));
    const commitSha = optionalReference(input.commitSha, "Artifact commit SHA", 64)
      ?.toLowerCase() ?? null;
    if (commitSha && !/^[0-9a-f]{7,64}$/u.test(commitSha)) {
      throw new Error("Artifact commit SHA is invalid");
    }
    const branch = safeBranch(optionalReference(input.branch, "Artifact branch", 255));
    if (input.type === "commit" && !commitSha) {
      throw new Error("Commit Artifact requires a commit SHA");
    }
    if (input.type === "branch" && !branch) {
      throw new Error("Branch Artifact requires a branch reference");
    }
    if (["file", "patch", "document"].includes(input.type) && !artifactPath) {
      throw new Error(`${input.type} Artifact requires a workspace-relative path`);
    }
    if (
      !workspaceRef && !repository && !artifactPath && !commitSha && !branch &&
      !sourceRunId
    ) {
      throw new Error("Artifact requires a verifiable workspace or source reference");
    }
    const member = this.auth.requireRoomMember(principal, task.roomId);
    const agentId = "agentId" in principal ? principal.agentId : null;
    const record: TaskArtifactRecord = {
      artifactId: createOpaqueId("artifact"),
      artifactRevision: 0,
      taskId: task.taskId,
      roomId: task.roomId,
      type: input.type,
      workspaceRef,
      repository,
      path: artifactPath,
      commitSha,
      branch,
      contentMode: "reference_only",
      contentId: null,
      contentPublicationId: null,
      contentSizeBytes: null,
      contentMediaType: null,
      contentSha256: null,
      title: redactSensitiveText(boundedText(input.title, "Artifact title", 160)),
      summary: redactSensitiveText(
        boundedText(input.summary, "Artifact summary", 4_000)
      ),
      sourceRunId,
      createdByMemberId: agentId ? null : member.memberId,
      createdByAgentId: agentId,
      createdAt: now
    };
    return this.artifacts.create(record);
  }

  private requireTaskAccess(
    principal: WebPrincipal | McpPrincipal,
    taskId: string
  ) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    this.auth.requireRoomMember(principal, task.roomId);
    if (
      "agentId" in principal &&
      !this.core.isRoomAgent(task.roomId, principal.agentId)
    ) {
      throw new Error("Agent is not assigned to the Artifact Room");
    }
    return task;
  }
}
