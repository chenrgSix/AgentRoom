import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ProviderCIObservation,
  ProviderCommitObservation,
  RemoteCIObservationReceipt,
  RemoteCommitObservation,
  SourceEvidence
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest,
  remoteCIObservationReceiptDigest,
  remoteCommitObservationDigest,
  sourceEvidenceDigest
} from "@convene-wire/contracts/execution-validation";
import type { LocalArtifactBlobStore } from
  "../artifact/local-artifact-blob-store.js";
import type { ArtifactContentRecord } from
  "../artifact/artifact-publication-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import { ExecutionError } from "../execution/execution-error.js";
import type { ExecutionPlanRepository } from
  "../execution/execution-plan-repository.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import type { TaskArtifactRecord } from "../task/artifact-repository.js";
import { validateRemoteGitBundle } from "./remote-git-bundle-importer.js";
import type { RemoteProviderBindingRepository } from
  "./remote-provider-binding-repository.js";
import {
  RemoteProviderClient,
  RemoteProviderClientError
} from "./remote-provider-client.js";
import {
  RemoteEvidenceRepository,
  type RemoteEvidenceOperation
} from "./remote-evidence-repository.js";

interface ObserveCommitCommand {
  operationId: string;
  providerBindingId: string;
  planRevision: number;
  nodeKey: string;
  expectedPlanDigest: string;
  expectedControlRevision: number;
  expectedBaseCommit: string;
  candidateCommit: string;
  patchOutputSlot: string;
}

interface ObserveCICommand {
  operationId: string;
  providerBindingId: string;
  planRevision: number;
  nodeKey: string;
  expectedPlanDigest: string;
  expectedControlRevision: number;
  sourceEvidenceId: string;
  checkKey: string;
  attempt: number;
}

interface SourceContextRow {
  plan_id: string;
  plan_revision: number;
  node_key: string;
  provider_binding_id: string;
}

const fail = (code: string, statusCode: 400 | 404 | 409 = 409): never => {
  throw new ExecutionError(code, statusCode);
};

function exactKeys(value: unknown, keys: readonly string[], code: string):
asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) fail(code, 400);
}

function sha256(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function objectFormat(value: string): "sha1" | "sha256" {
  if (/^[0-9a-f]{40}$/u.test(value)) return "sha1";
  if (/^[0-9a-f]{64}$/u.test(value)) return "sha256";
  return fail("REMOTE_EVIDENCE_GIT_OBJECT_INVALID", 400);
}

function sourceWithDigest(
  source: Omit<SourceEvidence, "sourceEvidenceId" | "sourceDigest">
): SourceEvidence {
  const pending = {
    ...source,
    sourceEvidenceId: "source_pending0001",
    sourceDigest: "0".repeat(64)
  } satisfies SourceEvidence;
  const digest = sourceEvidenceDigest(pending);
  const retained = {
    ...pending,
    sourceEvidenceId: `source_${digest}`,
    sourceDigest: digest
  } satisfies SourceEvidence;
  assertExecutionCommand("sourceEvidence", retained);
  return retained;
}

/** Owns remote observation admission. Provider facts alone never adopt a graph gate. */
export class RemoteEvidenceService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public constructor(
    private readonly database: Database.Database,
    private readonly repository: RemoteEvidenceRepository,
    private readonly bindings: RemoteProviderBindingRepository,
    private readonly plans: ExecutionPlanRepository,
    private readonly auth: AuthService,
    private readonly provider: RemoteProviderClient,
    private readonly blobs: LocalArtifactBlobStore,
    private readonly gitOptions: { gitExecutable?: string; temporaryBase?: string } = {}
  ) {}

  public async observeCommit(
    principal: WebPrincipal,
    planId: string,
    input: unknown,
    now: string
  ): Promise<{ observation: RemoteCommitObservation; source: SourceEvidence }> {
    exactKeys(input, [
      "operationId", "providerBindingId", "planRevision", "nodeKey",
      "expectedPlanDigest", "expectedControlRevision", "expectedBaseCommit",
      "candidateCommit", "patchOutputSlot"
    ], "REMOTE_COMMIT_OBSERVATION_INVALID");
    canonicalExecutionJSON(input);
    const command = input as unknown as ObserveCommitCommand;
    const key = executionOperationDigest({
      sessionId: principal.sessionId,
      planId,
      command
    });
    return this.serialize(key, () =>
      this.observeCommitCommand(principal, planId, command, now));
  }

  private async observeCommitCommand(
    principal: WebPrincipal,
    planId: string,
    command: ObserveCommitCommand,
    now: string
  ): Promise<{ observation: RemoteCommitObservation; source: SourceEvidence }> {
    const context = this.requireContext(principal, planId, command);
    if (context.node.kind !== "implementation" ||
      context.node.repository.baseCommit !== command.expectedBaseCommit ||
      context.node.inputs.length !== 0 ||
      context.plan.current.definition.externalInputs.some((entry) =>
        entry.nodeKey === command.nodeKey) ||
      context.plan.current.definition.edges.some((edge) =>
        edge.toNodeKey === command.nodeKey) ||
      !context.node.outputs.some((output) => output.required &&
        output.kind === "patch" && output.slotKey === command.patchOutputSlot) ||
      this.database.prepare(`
        SELECT 1 FROM execution_dispatch_intents
        WHERE plan_id = ? AND plan_revision = ? AND node_key = ? LIMIT 1
      `).get(planId, command.planRevision, command.nodeKey)) {
      return fail("REMOTE_EVIDENCE_NODE_NOT_ADMISSIBLE");
    }
    const request = {
      ...command,
      planId,
      roomId: context.plan.roomId,
      taskId: context.task.taskId,
      actorMemberId: context.actor.memberId
    };
    const operation = this.planOperation(
      "commit_observation", request, context.actor.memberId, now
    );
    const replay = this.replayCommit(operation);
    if (replay) return replay;

    let providerResult: {
      observation: ProviderCommitObservation;
      bundle: Buffer;
    };
    try {
      providerResult = await this.provider.observeCommit(context.binding.binding, {
        operationId: command.operationId,
        providerRepositoryId: context.binding.binding.providerRepositoryId,
        baseCommit: command.expectedBaseCommit,
        commit: command.candidateCommit
      });
    } catch (error) {
      return this.providerFailure(operation, error, now);
    }
    const observed = providerResult.observation;
    if (observed.operationId !== command.operationId ||
      observed.providerRepositoryId !== context.binding.binding.providerRepositoryId ||
      observed.baseCommit !== command.expectedBaseCommit ||
      observed.commit !== command.candidateCommit ||
      observed.objectFormat !== objectFormat(command.candidateCommit) ||
      observed.objectFormat !== objectFormat(command.expectedBaseCommit)) {
      this.repository.markFailed(operation.operationId,
        "REMOTE_PROVIDER_IDENTITY_MISMATCH", now);
      return fail("REMOTE_PROVIDER_IDENTITY_MISMATCH");
    }
    let validated: Awaited<ReturnType<typeof validateRemoteGitBundle>>;
    try {
      validated = await validateRemoteGitBundle(providerResult.bundle, {
        objectFormat: observed.objectFormat,
        baseCommit: observed.baseCommit,
        candidateCommit: observed.commit,
        candidateTree: observed.tree,
        bundleDigest: observed.bundleDigest,
        bundleByteLength: observed.bundleByteLength
      }, this.gitOptions);
    } catch (error) {
      const code = error instanceof RemoteProviderClientError
        ? error.code : "REMOTE_PROVIDER_GIT_VALIDATION_FAILED";
      this.repository.markFailed(operation.operationId, code, now);
      return fail(code);
    }
    const bundleDigest = sha256(providerResult.bundle);
    const patchDigest = validated.patchDigest;
    const bundleArtifactId = `artifact_${executionOperationDigest({
      operationId: command.operationId, kind: "commit_bundle"
    })}`;
    const patchArtifactId = `artifact_${executionOperationDigest({
      operationId: command.operationId, kind: "patch"
    })}`;
    const bundleContent = this.content(
      context.actor.teamId, bundleDigest, providerResult.bundle.length, now
    );
    const patchContent = this.content(
      context.actor.teamId, patchDigest, validated.patch.length, now
    );
    const bundleTemporary = `tmp/${createOpaqueId("remote")}.upload`;
    const patchTemporary = `tmp/${createOpaqueId("remote")}.upload`;
    this.blobs.importBytes(bundleTemporary, bundleContent.storageKey,
      providerResult.bundle, bundleDigest);
    this.blobs.importBytes(patchTemporary, patchContent.storageKey,
      validated.patch, patchDigest);
    const baseArtifact = (artifactId: string, type: "commit" | "patch",
      content: ArtifactContentRecord, title: string): TaskArtifactRecord => ({
      artifactId,
      artifactRevision: 0,
      taskId: context.task.taskId,
      roomId: context.plan.roomId,
      type,
      workspaceRef: null,
      repository: context.binding.binding.repositoryId,
      path: null,
      commitSha: observed.commit,
      branch: null,
      contentMode: "snapshot_blob",
      contentId: content.contentId,
      contentPublicationId: null,
      contentSizeBytes: content.sizeBytes,
      contentMediaType: type === "commit"
        ? "application/x-git-bundle" : "text/x-diff",
      contentSha256: content.sha256,
      title,
      summary: `Authenticated remote evidence ${observed.observationId}`,
      sourceRunId: null,
      createdByMemberId: context.actor.memberId,
      createdByAgentId: null,
      createdAt: now,
      relations: []
    });
    try {
      return this.repository.retainCommit(
        command.operationId,
        [
          {
            importId: `import_${executionOperationDigest({
              operationId: command.operationId, kind: "commit_bundle"
            })}`,
            operationId: command.operationId,
            providerBindingId: command.providerBindingId,
            artifact: baseArtifact(bundleArtifactId, "commit", bundleContent,
              "Remote candidate commit bundle"),
            content: bundleContent,
            kind: "commit_bundle",
            mediaType: "application/x-git-bundle"
          },
          {
            importId: `import_${executionOperationDigest({
              operationId: command.operationId, kind: "patch"
            })}`,
            operationId: command.operationId,
            providerBindingId: command.providerBindingId,
            artifact: baseArtifact(patchArtifactId, "patch", patchContent,
              "Remote candidate binary patch"),
            content: patchContent,
            kind: "patch",
            mediaType: "text/x-diff"
          }
        ],
        ([bundleArtifact, patchArtifact]) => {
          const pending: RemoteCommitObservation = {
            version: 1,
            operationId: command.operationId,
            providerBindingId: command.providerBindingId,
            repositoryId: context.binding.binding.repositoryId,
            providerRepositoryId: context.binding.binding.providerRepositoryId,
            taskId: context.task.taskId,
            observationId: observed.observationId,
            objectFormat: observed.objectFormat,
            baseCommit: observed.baseCommit,
            commit: observed.commit,
            tree: observed.tree,
            inputDigest: executionOperationDigest([]),
            bundleArtifactId: bundleArtifact.artifactId,
            bundleDigest,
            bundleByteLength: providerResult.bundle.length,
            patchArtifactId: patchArtifact.artifactId,
            patchArtifactRevision: patchArtifact.artifactRevision,
            patchOutputSlot: command.patchOutputSlot,
            patchDigest,
            patchByteLength: validated.patch.length,
            pullRequest: observed.pullRequest,
            providerObservationDigest: observed.providerObservationDigest,
            observationDigest: "0".repeat(64),
            observedAt: observed.observedAt
          };
          pending.observationDigest = remoteCommitObservationDigest(pending);
          assertExecutionCommand("remoteCommitObservation", pending);
          const source = sourceWithDigest({
            version: 1,
            kind: "repository_commit",
            repositoryId: pending.repositoryId,
            objectFormat: pending.objectFormat,
            commit: pending.commit,
            tree: pending.tree,
            inputDigest: pending.inputDigest,
            artifactPins: [{
              outputSlot: command.patchOutputSlot,
              artifactId: patchArtifact.artifactId,
              artifactRevision: patchArtifact.artifactRevision,
              contentDigest: patchDigest,
              byteLength: validated.patch.length,
              kind: "patch"
            }],
            origin: {
              kind: "remote_observation",
              providerBindingId: command.providerBindingId,
              providerRepositoryId: pending.providerRepositoryId,
              observationId: pending.observationId,
              observationDigest: pending.observationDigest,
              commitBundleArtifactId: bundleArtifact.artifactId
            },
            createdAt: now
          });
          return { observation: pending, source };
        },
        now
      );
    } catch (error) {
      this.repository.markFailed(operation.operationId,
        "REMOTE_EVIDENCE_PERSISTENCE_FAILED", now);
      throw error;
    }
  }

  public async observeCI(
    principal: WebPrincipal,
    planId: string,
    input: unknown,
    now: string
  ): Promise<RemoteCIObservationReceipt> {
    exactKeys(input, [
      "operationId", "providerBindingId", "planRevision", "nodeKey",
      "expectedPlanDigest", "expectedControlRevision", "sourceEvidenceId",
      "checkKey", "attempt"
    ], "REMOTE_CI_OBSERVATION_INVALID");
    canonicalExecutionJSON(input);
    const command = input as unknown as ObserveCICommand;
    const key = executionOperationDigest({
      sessionId: principal.sessionId,
      planId,
      command
    });
    return this.serialize(key, () =>
      this.observeCICommand(principal, planId, command, now));
  }

  private async observeCICommand(
    principal: WebPrincipal,
    planId: string,
    command: ObserveCICommand,
    now: string
  ): Promise<RemoteCIObservationReceipt> {
    const context = this.requireContext(principal, planId, command);
    const source = this.repository.getSource(command.sourceEvidenceId);
    const sourceContext = this.database.prepare(`
      SELECT operation.plan_id, operation.plan_revision, operation.node_key,
        operation.provider_binding_id
      FROM execution_remote_source_evidence source
      JOIN remote_commit_observations observation
        ON observation.observation_id = source.observation_id
      JOIN remote_evidence_operations operation
        ON operation.operation_id = observation.operation_id
      WHERE source.source_evidence_id = ?
    `).get(command.sourceEvidenceId) as SourceContextRow | undefined;
    if (!source || !sourceContext || sourceContext.plan_id !== planId ||
      sourceContext.plan_revision !== command.planRevision ||
      sourceContext.node_key !== command.nodeKey ||
      sourceContext.provider_binding_id !== command.providerBindingId) {
      return fail("REMOTE_SOURCE_EVIDENCE_NOT_FOUND", 404);
    }
    const mapping = context.binding.binding.ciChecks.find((entry) =>
      entry.checkKey === command.checkKey);
    if (!mapping || !context.node.verificationProfiles.some((profile) =>
      profile.required && profile.profileId === mapping.profileId &&
      profile.revision === mapping.profileRevision &&
      profile.digest === mapping.profileDigest)) {
      return fail("REMOTE_CI_PROFILE_NOT_AUTHORIZED");
    }
    const request = {
      ...command,
      planId,
      roomId: context.plan.roomId,
      taskId: context.task.taskId,
      actorMemberId: context.actor.memberId,
      commit: source.commit,
      tree: source.tree
    };
    const operation = this.planOperation(
      "ci_observation", request, context.actor.memberId, now
    );
    const replay = this.replayCI(operation);
    if (replay) return replay;
    let observed: ProviderCIObservation;
    try {
      observed = await this.provider.observeCI(context.binding.binding, {
        operationId: command.operationId,
        providerRepositoryId: context.binding.binding.providerRepositoryId,
        checkKey: command.checkKey,
        attempt: command.attempt,
        commit: source.commit!,
        tree: source.tree!
      });
    } catch (error) {
      return this.providerFailure(operation, error, now);
    }
    if (observed.operationId !== command.operationId ||
      observed.providerRepositoryId !== context.binding.binding.providerRepositoryId ||
      observed.checkKey !== command.checkKey ||
      observed.attempt !== command.attempt || observed.commit !== source.commit ||
      observed.tree !== source.tree) {
      this.repository.markFailed(operation.operationId,
        "REMOTE_PROVIDER_IDENTITY_MISMATCH", now);
      return fail("REMOTE_PROVIDER_IDENTITY_MISMATCH");
    }
    const receipt: RemoteCIObservationReceipt = {
      version: 1,
      operationId: command.operationId,
      providerBindingId: command.providerBindingId,
      repositoryId: context.binding.binding.repositoryId,
      providerRepositoryId: context.binding.binding.providerRepositoryId,
      sourceEvidenceId: command.sourceEvidenceId,
      observationId: observed.observationId,
      checkKey: command.checkKey,
      attempt: command.attempt,
      commit: observed.commit,
      tree: observed.tree,
      profileId: mapping.profileId,
      profileRevision: mapping.profileRevision,
      profileDigest: mapping.profileDigest,
      outcome: observed.outcome,
      providerObservationDigest: observed.providerObservationDigest,
      receiptDigest: "0".repeat(64),
      observedAt: observed.observedAt
    };
    receipt.receiptDigest = remoteCIObservationReceiptDigest(receipt);
    assertExecutionCommand("remoteCIObservationReceipt", receipt);
    return this.repository.retainCI(receipt, now);
  }

  private requireContext(
    principal: WebPrincipal,
    planId: string,
    command: Pick<ObserveCommitCommand, "providerBindingId" | "planRevision" |
      "nodeKey" | "expectedPlanDigest" | "expectedControlRevision">
  ) {
    this.auth.requireFullWebSession(principal);
    const plan = this.plans.get(planId);
    if (!plan) return fail("EXECUTION_PLAN_NOT_FOUND", 404);
    const actor = this.auth.requireRoomMember(principal, plan.roomId);
    if (actor.role !== "owner") return fail("REMOTE_EVIDENCE_OWNER_REQUIRED");
    if ((plan.state !== "approved" && plan.state !== "running") ||
      plan.current.revision !== command.planRevision ||
      plan.current.digest !== command.expectedPlanDigest ||
      plan.controlRevision !== command.expectedControlRevision) {
      return fail("REMOTE_EVIDENCE_PLAN_STALE");
    }
    const node = plan.current.definition.nodes.find((entry) =>
      entry.nodeKey === command.nodeKey);
    const task = plan.compiledTasks.find((entry) =>
      entry.nodeKey === command.nodeKey);
    if (!node || !task) return fail("REMOTE_EVIDENCE_NODE_NOT_FOUND", 404);
    const binding = this.bindings.get(command.providerBindingId);
    if (!binding || binding.revocation || binding.binding.teamId !== actor.teamId ||
      binding.binding.repositoryId !== node.repository.repositoryId) {
      return fail("REMOTE_PROVIDER_BINDING_UNAVAILABLE");
    }
    return { plan, actor, node, task, binding };
  }

  private planOperation(
    kind: RemoteEvidenceOperation["kind"],
    request: Record<string, unknown>,
    actorMemberId: string,
    now: string
  ): RemoteEvidenceOperation {
    const requestDigest = executionOperationDigest(request);
    const planned = this.repository.plan({
      operationId: request.operationId as string,
      kind,
      providerBindingId: request.providerBindingId as string,
      planId: request.planId as string,
      planRevision: request.planRevision as number,
      nodeKey: request.nodeKey as string,
      expectedPlanDigest: request.expectedPlanDigest as string,
      expectedControlRevision: request.expectedControlRevision as number,
      actorMemberId,
      requestDigest,
      request,
      state: "planned",
      observationId: null,
      errorCode: null,
      createdAt: now,
      updatedAt: now
    });
    if (planned.kind !== kind || planned.requestDigest !== requestDigest) {
      return fail("REMOTE_EVIDENCE_OPERATION_CONFLICT");
    }
    return planned;
  }

  private replayCommit(operation: RemoteEvidenceOperation) {
    if (operation.state === "succeeded") {
      const observation = this.repository.getCommit(operation.operationId);
      if (!observation) return fail("REMOTE_EVIDENCE_HISTORY_INCONSISTENT");
      const source = this.database.prepare(`
        SELECT source_json FROM execution_remote_source_evidence
        WHERE observation_id = ?
      `).pluck().get(observation.observationId) as string | undefined;
      if (!source) return fail("REMOTE_EVIDENCE_HISTORY_INCONSISTENT");
      return { observation, source: JSON.parse(source) as SourceEvidence };
    }
    if (operation.state === "failed") return fail(operation.errorCode ??
      "REMOTE_EVIDENCE_OPERATION_FAILED");
    return undefined;
  }

  private replayCI(operation: RemoteEvidenceOperation) {
    if (operation.state === "succeeded") {
      return this.repository.getCI(operation.operationId) ??
        fail("REMOTE_EVIDENCE_HISTORY_INCONSISTENT");
    }
    if (operation.state === "failed") return fail(operation.errorCode ??
      "REMOTE_EVIDENCE_OPERATION_FAILED");
    return undefined;
  }

  private providerFailure(operation: RemoteEvidenceOperation, error: unknown,
    now: string): never {
    const code = error instanceof RemoteProviderClientError
      ? error.code : "REMOTE_PROVIDER_UNAVAILABLE";
    this.repository.markOutcomeUnknown(operation.operationId, code, now);
    return fail(code);
  }

  private content(
    teamId: string,
    digest: string,
    sizeBytes: number,
    now: string
  ): ArtifactContentRecord {
    return {
      contentId: `content_${executionOperationDigest({ teamId, digest, sizeBytes })}`,
      teamId,
      sha256: digest,
      sizeBytes,
      storageKey: ["sealed", teamId, digest.slice(0, 2), digest].join("/"),
      sealedAt: now
    };
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const pending = operation();
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }
}
