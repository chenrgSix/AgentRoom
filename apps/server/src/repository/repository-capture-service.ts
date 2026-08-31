import type Database from "better-sqlite3";
import type { GovernedExecutionManifest as Manifest, RepositoryOperationRequest as Operation,
  RepositoryCheckpoint as Checkpoint } from "@convene-wire/contracts/execution-plan";
import { assertExecutionCommand, canonicalExecutionJSON, executionOperationDigest } from "@convene-wire/contracts/execution-validation";
import type { ArtifactPublicationRecord, ArtifactPublicationRepository } from "../artifact/artifact-publication-repository.js";
import type { LocalArtifactBlobStore } from "../artifact/local-artifact-blob-store.js";
import { inspectCommitBundleEnvelope } from "../artifact/commit-bundle-envelope.js";
import { ExecutionError } from "../execution/execution-error.js";
import { AuthorizationError, type DevicePrincipal } from "../security/auth-service.js";
import type { ArtifactRepository } from "../task/artifact-repository.js";
import type { IsolatedWorkspaceLeaseService } from "../workspace/isolated-workspace-lease-service.js";
import { WorkspaceLeaseRepository, type WorkspaceLeaseRecord } from "../workspace/workspace-lease-repository.js";

interface CaptureRow {
  operation_id: string; isolated_lease_id: string; request_json: string;
  request_digest: string; manifest_digest: string; expected_generation: string; issued_at: string;
}
const fail = (code: string): never => { throw new ExecutionError(code, 409); };
const equal = (left: unknown, right: unknown) => canonicalExecutionJSON(left) === canonicalExecutionJSON(right);

/** Captured content authority, not local Git execution, verification or Run settlement. */
export class RepositoryCaptureService {
  private readonly leases: WorkspaceLeaseRepository;
  public constructor(private readonly database: Database.Database,
    private readonly isolated: IsolatedWorkspaceLeaseService,
    private readonly artifacts: ArtifactRepository,
    private readonly publications: ArtifactPublicationRepository,
    private readonly blobs: LocalArtifactBlobStore) {
    this.leases = new WorkspaceLeaseRepository(database);
  }

  public begin(principal: DevicePrincipal, value: unknown, now: string): WorkspaceLeaseRecord {
    assertExecutionCommand("repositoryOperation", value);
    const request = value as Operation;
    const { requestDigest, ...unsigned } = request;
    if (executionOperationDigest(unsigned) !== requestDigest || request.action.kind !== "capture" || !request.execution) {
      return fail("REPOSITORY_CAPTURE_REQUEST_INVALID");
    }
    return this.database.transaction(() => {
      const previous = this.row(request.operationId);
      if (previous) {
        this.requireOwner(principal, previous);
        if (previous.request_digest !== requestDigest || !equal(JSON.parse(previous.request_json), request)) {
          return fail("REPOSITORY_CAPTURE_OPERATION_CONFLICT");
        }
        // An exact begin retry only reads a retained authorization receipt. Any
        // subsequent upload, seal or bind must still pass the current gate.
        return this.captureLease(previous);
      }
      const manifest = this.manifest(request.execution!.runId);
      this.matchRequest(request, manifest);
      const state = this.isolated.requireActiveForDevice(principal, manifest.workspace.leaseId, now);
      if (state.generation !== request.expectedGeneration || !Number.isFinite(Date.parse(now)) ||
        Date.parse(request.deadline) <= Date.parse(now) || Date.parse(request.deadline) > Date.parse(manifest.deadline) ||
        Date.parse(request.deadline) > Date.parse(manifest.workspace.expiresAt) ||
        Date.parse(request.deadline) > Date.parse(manifest.grant.expiresAt)) return fail("REPOSITORY_CAPTURE_SCOPE_STALE");
      if (this.database.prepare(`SELECT 1 FROM repository_capture_operations
        WHERE isolated_lease_id = ? AND expected_generation = ?`).get(state.lease.leaseId, state.generation)) {
        return fail("REPOSITORY_CAPTURE_GENERATION_CLAIMED");
      }
      this.database.prepare(`INSERT INTO repository_capture_operations
        (operation_id, isolated_lease_id, request_digest, request_json, manifest_digest, expected_generation, issued_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(request.operationId, state.lease.leaseId, requestDigest,
          canonicalExecutionJSON(request), manifest.manifestDigest, state.generation, now);
      const identity = executionOperationDigest({ kind: "capture_source", operationId: request.operationId, requestDigest });
      return this.leases.create({ leaseId: `lease_${identity}`, idempotencyKey: `idem_${identity}`,
        teamId: principal.teamId, deviceId: principal.deviceId, roomId: manifest.scope.roomId,
        taskId: manifest.scope.taskId, runId: manifest.scope.runId, agentId: manifest.scope.agentId,
        workspaceRef: state.lease.workspaceRef, workspaceGeneration: state.generation,
        mode: "read_capture", captureOperationId: request.operationId, state: "active",
        issuedAt: now, expiresAt: request.deadline, releasedAt: null });
    }).immediate();
  }

  /** Called for every new content mutation, never from an Agent role claim. */
  public requireActiveSource(principal: DevicePrincipal, lease: WorkspaceLeaseRecord,
    kind: ArtifactPublicationRecord["artifactType"], now: string): void {
    const row = lease.captureOperationId && this.row(lease.captureOperationId);
    if (!row || lease.mode !== "read_capture" || !equal(this.captureLease(row), lease)) {
      return fail("REPOSITORY_CAPTURE_LEASE_CONFLICT");
    }
    const manifest = this.requireActive(principal, row, now);
    if (!manifest.outputs.some((slot) => slot.kind === kind)) return fail("REPOSITORY_CAPTURE_OUTPUT_UNAPPROVED");
  }

  public seal(principal: DevicePrincipal, value: unknown, now: string): Checkpoint {
    assertExecutionCommand("executionCheckpoint", value);
    const checkpoint = value as Checkpoint;
    const { digest, ...unsigned } = checkpoint;
    if (executionOperationDigest(unsigned) !== digest) return fail("REPOSITORY_CHECKPOINT_DIGEST_INVALID");
    return this.database.transaction(() => {
      const row = this.row(checkpoint.operationId);
      if (!row) return fail("REPOSITORY_CAPTURE_NOT_FOUND");
      this.requireOwner(principal, row);
      const existing = this.checkpoint(row.operation_id);
      if (existing) {
        if (!equal(existing, checkpoint)) return fail("REPOSITORY_CHECKPOINT_CONFLICT");
        return existing;
      }
      const manifest = this.requireActive(principal, row, now);
      const request = JSON.parse(row.request_json) as Operation;
      if (!equal(checkpoint.scope, manifest.scope) || checkpoint.repositoryId !== manifest.repository.repositoryId ||
        checkpoint.bindingId !== manifest.repository.bindingId || checkpoint.baseCommit !== manifest.repository.baseCommit ||
        checkpoint.inputDigest !== manifest.inputDigest || checkpoint.workspaceRef !== manifest.workspace.workspaceRef ||
        checkpoint.workspaceGeneration !== row.expected_generation ||
        checkpoint.candidateCommit.length !== checkpoint.baseCommit.length || checkpoint.candidateTree.length !== checkpoint.baseCommit.length ||
        Date.parse(checkpoint.capturedAt) < Date.parse(manifest.workspace.issuedAt) ||
        Date.parse(checkpoint.capturedAt) > Date.parse(request.deadline) || Date.parse(checkpoint.capturedAt) > Date.parse(now)) {
        return fail("REPOSITORY_CHECKPOINT_SCOPE_CONFLICT");
      }
      this.requireOutputs(checkpoint, manifest, this.captureLease(row));
      if (this.database.prepare("SELECT 1 FROM repository_checkpoints WHERE checkpoint_id = ?").get(checkpoint.checkpointId)) {
        return fail("REPOSITORY_CHECKPOINT_CONFLICT");
      }
      this.database.prepare(`INSERT INTO repository_checkpoints
        (checkpoint_id, operation_id, digest, checkpoint_json, recorded_at) VALUES (?, ?, ?, ?, ?)`)
        .run(checkpoint.checkpointId, checkpoint.operationId, digest, canonicalExecutionJSON(checkpoint), now);
      for (const output of checkpoint.outputs) this.database.prepare(`INSERT INTO repository_checkpoint_outputs
        (checkpoint_id, slot_key, artifact_id, artifact_revision) VALUES (?, ?, ?, ?)`)
        .run(checkpoint.checkpointId, output.slotKey, output.artifact.artifactId, output.artifact.artifactRevision);
      return checkpoint;
    }).immediate();
  }

  public getForDevice(principal: DevicePrincipal, operationId: string): Checkpoint {
    const row = this.row(operationId);
    if (!row) throw new ExecutionError("REPOSITORY_CAPTURE_NOT_FOUND", 404);
    this.requireOwner(principal, row);
    const checkpoint = this.checkpoint(operationId);
    if (!checkpoint) throw new ExecutionError("REPOSITORY_CHECKPOINT_NOT_FOUND", 404);
    return checkpoint;
  }

  private requireOutputs(checkpoint: Checkpoint, manifest: Manifest, lease: WorkspaceLeaseRecord): void {
    const slots = new Set<string>(), artifacts = new Set<string>();
    for (const output of checkpoint.outputs) {
      const pin = output.artifact, slot = manifest.outputs.find((entry) => entry.slotKey === output.slotKey);
      if (!slot || slot.kind !== pin.kind || slots.has(slot.slotKey) || artifacts.has(pin.artifactId)) {
        return fail("REPOSITORY_CHECKPOINT_OUTPUT_INVALID");
      }
      slots.add(slot.slotKey); artifacts.add(pin.artifactId);
      const artifact = this.artifacts.get(pin.artifactId);
      const publication = artifact?.contentPublicationId ? this.publications.get(artifact.contentPublicationId) : undefined;
      const content = publication?.contentId ? this.publications.getContent(publication.contentId) : undefined;
      if (!artifact || !publication || !content || artifact.contentMode !== "snapshot_blob" ||
        artifact.artifactRevision !== pin.artifactRevision || artifact.type !== pin.kind ||
        artifact.sourceRunId !== lease.runId || artifact.taskId !== lease.taskId || artifact.roomId !== lease.roomId ||
        artifact.createdByAgentId !== lease.agentId || artifact.workspaceRef !== lease.workspaceRef ||
        artifact.contentSha256 !== pin.contentDigest || artifact.contentSizeBytes !== pin.byteLength ||
        artifact.contentId !== content.contentId || publication.state !== "bound" ||
        publication.artifactId !== artifact.artifactId || publication.leaseId !== lease.leaseId ||
        publication.declaredSha256 !== pin.contentDigest || publication.declaredSize !== pin.byteLength ||
        content.teamId !== lease.teamId || content.sha256 !== pin.contentDigest || content.sizeBytes !== pin.byteLength ||
        !this.blobs.hasMatchingBlob(content.storageKey, pin.contentDigest, pin.byteLength)) {
        return fail("REPOSITORY_CHECKPOINT_OUTPUT_NOT_CANONICAL");
      }
      if (pin.kind === "commit") {
        const bundle = inspectCommitBundleEnvelope(this.blobs.readVerified(content.storageKey, pin.contentDigest, pin.byteLength));
        if (artifact.commitSha !== checkpoint.candidateCommit || bundle.candidateCommit !== checkpoint.candidateCommit ||
          bundle.prerequisiteCommit.length !== checkpoint.baseCommit.length ||
          (!manifest.inputs.some((input) => input.artifact.kind === "patch" || input.artifact.kind === "commit") &&
            bundle.prerequisiteCommit !== checkpoint.baseCommit)) {
          return fail("REPOSITORY_CHECKPOINT_COMMIT_MISMATCH");
        }
      }
    }
    if (manifest.outputs.some((slot) => slot.required && !slots.has(slot.slotKey))) {
      return fail("REPOSITORY_CHECKPOINT_OUTPUT_REQUIRED");
    }
  }

  private requireActive(principal: DevicePrincipal, row: CaptureRow, now: string): Manifest {
    this.requireOwner(principal, row);
    if (this.checkpoint(row.operation_id)) return fail("REPOSITORY_CAPTURE_ALREADY_SEALED");
    const request = JSON.parse(row.request_json) as Operation;
    const manifest = this.manifest(request.execution!.runId);
    this.matchRequest(request, manifest);
    const state = this.isolated.requireActiveForDevice(principal, row.isolated_lease_id, now);
    const lease = this.captureLease(row);
    if (state.generation !== row.expected_generation || manifest.manifestDigest !== row.manifest_digest ||
      lease.state !== "active" || !Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(row.issued_at) ||
      Date.parse(now) >= Date.parse(request.deadline)) return fail("REPOSITORY_CAPTURE_SCOPE_STALE");
    return manifest;
  }

  private matchRequest(request: Operation, manifest: Manifest): void {
    const root = this.database.prepare("SELECT root_task_id FROM execution_plans WHERE plan_id = ?")
      .get(manifest.scope.planId) as { root_task_id: string } | undefined;
    const expectedPlan = { planId: manifest.scope.planId, revision: manifest.scope.planRevision,
      digest: manifest.scope.planDigest, approvalOperationId: manifest.scope.approvalOperationId,
      roomId: manifest.scope.roomId, rootTaskId: root?.root_task_id ?? "" };
    if (request.action.kind !== "capture" || request.action.capture?.manifestDigest !== manifest.manifestDigest ||
      !equal(request.execution, manifest.scope) || !equal(request.plan, expectedPlan) || !equal(request.grant, manifest.grant) ||
      request.repositoryId !== manifest.repository.repositoryId || request.bindingId !== manifest.repository.bindingId ||
      request.deviceId !== manifest.scope.deviceId) return fail("REPOSITORY_CAPTURE_MANIFEST_CONFLICT");
  }

  private manifest(runId: string): Manifest {
    const row = this.database.prepare("SELECT context_manifest_json FROM runs WHERE run_id = ?")
      .get(runId) as { context_manifest_json: string | null } | undefined;
    const manifest = row?.context_manifest_json ? JSON.parse(row.context_manifest_json).execution : undefined;
    if (!manifest) return fail("REPOSITORY_CAPTURE_MANIFEST_REQUIRED");
    assertExecutionCommand("executionManifest", manifest);
    const { manifestDigest, ...unsigned } = manifest;
    if (executionOperationDigest(unsigned) !== manifestDigest) return fail("REPOSITORY_CAPTURE_MANIFEST_CONFLICT");
    return manifest;
  }

  private requireOwner(principal: DevicePrincipal, row: CaptureRow): void {
    const owner = this.database.prepare(`SELECT 1 FROM isolated_workspace_leases lease
      JOIN devices device ON device.device_id = lease.device_id AND device.status = 'active'
      JOIN rooms room ON room.room_id = lease.room_id AND room.archived_at IS NULL
      JOIN teams team ON team.team_id = room.team_id AND team.archived_at IS NULL
      JOIN room_human_participants human ON human.room_id = room.room_id AND human.member_id = device.owner_member_id
      JOIN room_agent_participants agent ON agent.room_id = room.room_id AND agent.agent_id = lease.agent_id
      WHERE lease.lease_id = ? AND lease.device_id = ? AND lease.team_id = ? AND lease.owner_member_id = ?
        AND device.owner_member_id = lease.owner_member_id AND device.team_id = lease.team_id`)
      .get(row.isolated_lease_id, principal.deviceId, principal.teamId, principal.ownerMemberId);
    if (!owner) throw new AuthorizationError("FORBIDDEN", "Repository capture access denied");
  }

  private captureLease(row: CaptureRow): WorkspaceLeaseRecord {
    const id = this.database.prepare("SELECT lease_id FROM workspace_leases WHERE capture_operation_id = ?")
      .get(row.operation_id) as { lease_id: string } | undefined;
    return (id && this.leases.get(id.lease_id)) || fail("REPOSITORY_CAPTURE_LEASE_MISSING");
  }
  private row(operationId: string): CaptureRow | undefined {
    const row = this.database.prepare("SELECT * FROM repository_capture_operations WHERE operation_id = ?")
      .get(operationId) as CaptureRow | undefined;
    if (row) {
      const request = JSON.parse(row.request_json) as Operation;
      assertExecutionCommand("repositoryOperation", request);
      const { requestDigest, ...unsigned } = request;
      if (requestDigest !== row.request_digest || executionOperationDigest(unsigned) !== requestDigest ||
        request.action.kind !== "capture" || !request.execution) return fail("REPOSITORY_CAPTURE_RECORD_CORRUPT");
    }
    return row;
  }
  private checkpoint(operationId: string): Checkpoint | undefined {
    const row = this.database.prepare("SELECT checkpoint_json, digest FROM repository_checkpoints WHERE operation_id = ?")
      .get(operationId) as { checkpoint_json: string; digest: string } | undefined;
    if (!row) return undefined;
    const checkpoint = JSON.parse(row.checkpoint_json) as Checkpoint;
    assertExecutionCommand("executionCheckpoint", checkpoint);
    const { digest, ...unsigned } = checkpoint;
    if (digest !== row.digest || executionOperationDigest(unsigned) !== digest) return fail("REPOSITORY_CHECKPOINT_CORRUPT");
    return checkpoint;
  }
}
