import type Database from "better-sqlite3";
import type {
  GovernedExecutionManifest as Manifest,
  RepositoryOperationRequest as Operation,
  VerificationReceipt
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";

import type { ArtifactPublicationRecord } from
  "../artifact/artifact-publication-repository.js";
import type { LocalArtifactBlobStore } from
  "../artifact/local-artifact-blob-store.js";
import { ExecutionError } from "../execution/execution-error.js";
import {
  AuthorizationError,
  type DevicePrincipal
} from "../security/auth-service.js";
import type { ArtifactRepository } from
  "../task/artifact-repository.js";
import type { WorkspaceLeaseRecord } from
  "../workspace/workspace-lease-repository.js";

interface VerificationOperationRow {
  admitted_at: string;
  checkpoint_id: string;
  deadline: string;
  device_id: string;
  operation_id: string;
  profile_digest: string;
  profile_id: string;
  profile_revision: number;
  request_digest: string;
  request_json: string;
}

interface VerificationReceiptRow {
  operation_id: string;
  receipt_digest: string;
  receipt_json: string;
  recorded_at: string;
  verification_id: string;
}

interface CandidateRow {
  checkpoint_id: string;
  checkpoint_json: string;
  current_revision: number;
  manifest_json: string;
  plan_state: string;
}

export interface VerificationAdmission {
  admittedAt: string;
  deadline: string;
  operationId: string;
  requestDigest: string;
}

export interface RetainedVerificationReceipt {
  receipt: VerificationReceipt;
  receiptDigest: string;
  recordedAt: string;
}

const fail = (code: string, status: 400 | 404 | 409 = 409): never => {
  throw new ExecutionError(code, status);
};
const equal = (left: unknown, right: unknown): boolean =>
  canonicalExecutionJSON(left) === canonicalExecutionJSON(right);

/** Central admission/receipt authority; it never executes a verifier command. */
export class RepositoryVerificationService {
  public constructor(
    private readonly database: Database.Database,
    private readonly artifacts: ArtifactRepository,
    private readonly blobs: LocalArtifactBlobStore
  ) {}

  public begin(
    principal: DevicePrincipal,
    value: unknown,
    now: string
  ): VerificationAdmission {
    assertExecutionCommand("repositoryOperation", value);
    const request = value as Operation;
    const { requestDigest, ...unsigned } = request;
    if (
      executionOperationDigest(unsigned) !== requestDigest ||
      request.action.kind !== "verify" || !request.action.verify ||
      !request.execution || request.deviceId !== principal.deviceId
    ) return fail("VERIFICATION_REQUEST_INVALID");
    return this.database.transaction(() => {
      const previous = this.operation(request.operationId);
      if (previous) {
        this.requireOwner(principal, previous);
        if (
          previous.request_digest !== requestDigest ||
          !equal(JSON.parse(previous.request_json), request)
        ) return fail("VERIFICATION_OPERATION_CONFLICT");
        return this.admission(previous);
      }
      const candidate = this.candidate(request.execution!.runId);
      const manifest = JSON.parse(candidate.manifest_json) as Manifest;
      this.matchRequest(request, manifest, candidate);
      const nowMs = Date.parse(now);
      const deadlineMs = Date.parse(request.deadline);
      if (
        !Number.isFinite(nowMs) || !Number.isFinite(deadlineMs) ||
        deadlineMs <= nowMs || deadlineMs > Date.parse(manifest.deadline) ||
        deadlineMs > Date.parse(manifest.workspace.expiresAt) ||
        deadlineMs > Date.parse(manifest.grant.expiresAt)
      ) return fail("VERIFICATION_SCOPE_STALE");
      const profile = request.action.verify!.profile;
      if (this.database.prepare(`
        SELECT 1 FROM repository_verification_operations
        WHERE checkpoint_id = ? AND profile_id = ?
          AND profile_revision = ? AND profile_digest = ?
      `).get(
        candidate.checkpoint_id,
        profile.profileId,
        profile.revision,
        profile.digest
      )) return fail("VERIFICATION_PROFILE_ALREADY_CLAIMED");
      this.database.prepare(`
        INSERT INTO repository_verification_operations (
          operation_id, request_digest, request_json, checkpoint_id,
          profile_id, profile_revision, profile_digest, device_id,
          admitted_at, deadline
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.operationId,
        requestDigest,
        canonicalExecutionJSON(request),
        candidate.checkpoint_id,
        profile.profileId,
        profile.revision,
        profile.digest,
        principal.deviceId,
        now,
        request.deadline
      );
      return this.admission(this.operation(request.operationId)!);
    }).immediate();
  }

  public requireActiveLogSource(
    principal: DevicePrincipal,
    lease: WorkspaceLeaseRecord,
    publication: Pick<ArtifactPublicationRecord, "artifactType"> &
      Partial<Pick<ArtifactPublicationRecord, "verificationOperationId">>,
    now: string
  ): void {
    const operationId = publication.verificationOperationId;
    const row = operationId && this.operation(operationId);
    if (
      publication.artifactType !== "test_result" || !row ||
      lease.mode !== "read_capture" || lease.captureOperationId === null
    ) return fail("VERIFICATION_LOG_SOURCE_INVALID");
    this.requireOwner(principal, row);
    const scope = this.database.prepare(`
      SELECT 1 FROM repository_verification_operations verification
      JOIN repository_checkpoints checkpoint
        ON checkpoint.checkpoint_id = verification.checkpoint_id
      JOIN workspace_leases capture_lease
        ON capture_lease.capture_operation_id = checkpoint.operation_id
      WHERE verification.operation_id = ?
        AND capture_lease.lease_id = ?
        AND capture_lease.run_id = ?
        AND capture_lease.agent_id = ?
        AND capture_lease.device_id = ?
        AND capture_lease.workspace_ref = ?
        AND capture_lease.workspace_generation = ?
        AND NOT EXISTS (
          SELECT 1 FROM verification_receipts receipt
          WHERE receipt.operation_id = verification.operation_id
        )
    `).get(
      operationId,
      lease.leaseId,
      lease.runId,
      lease.agentId,
      lease.deviceId,
      lease.workspaceRef,
      lease.workspaceGeneration
    );
    if (
      !scope || lease.state !== "active" ||
      !Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(row.admitted_at) ||
      Date.parse(now) >= Date.parse(lease.expiresAt) ||
      Date.parse(now) >= Date.parse(row.deadline)
    ) return fail("VERIFICATION_LOG_SOURCE_STALE");
  }

  public retain(
    principal: DevicePrincipal,
    value: unknown,
    now: string
  ): RetainedVerificationReceipt {
    assertExecutionCommand("verificationReceipt", value);
    const receipt = value as VerificationReceipt;
    if (
      receipt.authority.kind !== "bridge" ||
      receipt.authority.deviceId !== principal.deviceId ||
      receipt.integrationOperationId !== null
    ) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Verification receipt authority is invalid"
      );
    }
    return this.database.transaction(() => {
      const operation = this.operation(receipt.operationId);
      if (!operation) return fail("VERIFICATION_OPERATION_NOT_FOUND", 404);
      this.requireOwner(principal, operation);
      const existing = this.receiptByOperation(receipt.operationId);
      const digest = executionOperationDigest(receipt);
      if (existing) {
        if (
          existing.receipt_digest !== digest ||
          !equal(JSON.parse(existing.receipt_json), receipt)
        ) return fail("VERIFICATION_RECEIPT_CONFLICT");
        return this.mapReceipt(existing);
      }
      const request = JSON.parse(operation.request_json) as Operation;
      this.matchReceipt(receipt, request, operation, now);
      const log = receipt.logArtifact;
      this.database.prepare(`
        INSERT INTO verification_receipts (
          verification_id, operation_id, receipt_digest, receipt_json,
          outcome, log_artifact_id, log_artifact_revision, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.verificationId,
        receipt.operationId,
        digest,
        canonicalExecutionJSON(receipt),
        receipt.outcome,
        log?.artifactId ?? null,
        log?.artifactRevision ?? null,
        now
      );
      return this.mapReceipt(this.receiptByOperation(receipt.operationId)!);
    }).immediate();
  }

  public getForDevice(
    principal: DevicePrincipal,
    operationId: string
  ): RetainedVerificationReceipt {
    const operation = this.operation(operationId);
    if (!operation) return fail("VERIFICATION_OPERATION_NOT_FOUND", 404);
    this.requireOwner(principal, operation);
    const receipt = this.receiptByOperation(operationId);
    if (!receipt) return fail("VERIFICATION_RECEIPT_NOT_FOUND", 404);
    return this.mapReceipt(receipt);
  }

  private matchRequest(
    request: Operation,
    manifest: Manifest,
    candidate: CandidateRow
  ): void {
    assertExecutionCommand("executionManifest", manifest);
    const checkpoint = JSON.parse(candidate.checkpoint_json) as {
      candidateCommit: string;
      candidateTree: string;
      inputDigest: string;
      scope: unknown;
      repositoryId: string;
      bindingId: string;
    };
    const profile = request.action.verify!?.profile;
    const required = manifest.verificationProfiles.find((entry) =>
      entry.profileId === profile?.profileId &&
      entry.revision === profile.revision &&
      entry.digest === profile.digest && entry.required
    );
    const root = this.database.prepare(
      "SELECT root_task_id FROM execution_plans WHERE plan_id = ?"
    ).get(manifest.scope.planId) as { root_task_id: string } | undefined;
    const expectedPlan = {
      planId: manifest.scope.planId,
      revision: manifest.scope.planRevision,
      digest: manifest.scope.planDigest,
      approvalOperationId: manifest.scope.approvalOperationId,
      roomId: manifest.scope.roomId,
      rootTaskId: root?.root_task_id ?? ""
    };
    if (
      !required || request.action.kind !== "verify" ||
      !equal(request.execution, manifest.scope) || !equal(request.plan, expectedPlan) ||
      !equal(request.grant, manifest.grant) || !equal(checkpoint.scope, manifest.scope) ||
      request.repositoryId !== manifest.repository.repositoryId ||
      request.bindingId !== manifest.repository.bindingId ||
      request.deviceId !== manifest.scope.deviceId ||
      checkpoint.repositoryId !== request.repositoryId ||
      checkpoint.bindingId !== request.bindingId ||
      request.expectedGeneration !== manifest.workspace.workspaceGeneration ||
      request.action.verify!.candidateCommit !== checkpoint.candidateCommit ||
      request.action.verify!.candidateTree !== checkpoint.candidateTree ||
      request.action.verify!.inputDigest !== checkpoint.inputDigest ||
      candidate.current_revision !== manifest.scope.planRevision ||
      !["approved", "running"].includes(candidate.plan_state)
    ) return fail("VERIFICATION_CANDIDATE_CONFLICT");
  }

  private matchReceipt(
    receipt: VerificationReceipt,
    request: Operation,
    operation: VerificationOperationRow,
    now: string
  ): void {
    const action = request.action.verify!;
    const started = Date.parse(receipt.startedAt);
    const finished = Date.parse(receipt.finishedAt);
    const recorded = Date.parse(now);
    const duration = finished - started;
    if (
      receipt.version !== request.version ||
      receipt.operationId !== request.operationId ||
      receipt.requestDigest !== request.requestDigest ||
      !equal(receipt.plan, request.plan) || !equal(receipt.execution, request.execution) ||
      receipt.repositoryId !== request.repositoryId ||
      receipt.bindingId !== request.bindingId ||
      receipt.candidateCommit !== action.candidateCommit ||
      receipt.candidateTree !== action.candidateTree ||
      receipt.inputDigest !== action.inputDigest || !equal(receipt.profile, action.profile) ||
      !Number.isFinite(started) || !Number.isFinite(finished) ||
      !Number.isFinite(recorded) || started < Date.parse(operation.admitted_at) ||
      finished < started || finished > recorded || finished > Date.parse(operation.deadline) ||
      receipt.durationMilliseconds !== duration ||
      (receipt.outcome === "passed" && receipt.exitCode !== 0) ||
      (receipt.outcome === "failed" && receipt.exitCode === 0) ||
      (!["passed", "failed"].includes(receipt.outcome) && receipt.exitCode !== null) ||
      (receipt.outcome !== "outcome_unknown" && receipt.logArtifact === null)
    ) return fail("VERIFICATION_RECEIPT_SCOPE_CONFLICT");
    if (receipt.logArtifact) this.requireLogArtifact(receipt, operation);
  }

  private requireLogArtifact(
    receipt: VerificationReceipt,
    operation: VerificationOperationRow
  ): void {
    const pin = receipt.logArtifact!;
    const artifact = this.artifacts.get(pin.artifactId);
    const row = this.database.prepare(`
      SELECT publication.content_id, content.sha256, content.size_bytes,
        content.storage_key, publication.artifact_id
      FROM artifact_publications publication
      JOIN artifact_contents content ON content.content_id = publication.content_id
      WHERE publication.verification_operation_id = ?
        AND publication.state = 'bound'
        AND publication.artifact_id = ?
        AND publication.artifact_type = 'test_result'
        AND publication.device_id = ?
    `).get(
      receipt.operationId,
      pin.artifactId,
      operation.device_id
    ) as {
      artifact_id: string;
      content_id: string;
      sha256: string;
      size_bytes: number;
      storage_key: string;
    } | undefined;
    if (
      !artifact || !row || artifact.type !== "test_result" ||
      artifact.contentMode !== "snapshot_blob" || artifact.contentId !== row.content_id ||
      artifact.artifactRevision !== pin.artifactRevision ||
      artifact.contentSha256 !== pin.contentDigest || row.sha256 !== pin.contentDigest ||
      artifact.contentSizeBytes !== pin.byteLength || row.size_bytes !== pin.byteLength ||
      pin.kind !== "test_result" ||
      !this.blobs.hasMatchingBlob(row.storage_key, pin.contentDigest, pin.byteLength)
    ) return fail("VERIFICATION_LOG_ARTIFACT_INVALID");
  }

  private candidate(runId: string): CandidateRow {
    const row = this.database.prepare(`
      SELECT checkpoint.checkpoint_id, checkpoint.checkpoint_json,
        run.context_manifest_json AS manifest_json,
        plan.current_revision, plan.state AS plan_state
      FROM repository_checkpoints checkpoint
      JOIN repository_capture_operations capture
        ON capture.operation_id = checkpoint.operation_id
      JOIN isolated_workspace_leases lease
        ON lease.lease_id = capture.isolated_lease_id
      JOIN runs run ON run.run_id = lease.run_id
      JOIN execution_plans plan
        ON plan.plan_id = json_extract(
          run.context_manifest_json, '$.execution.scope.planId'
        )
        AND plan.current_revision = json_extract(
          run.context_manifest_json, '$.execution.scope.planRevision'
        )
      JOIN execution_plan_nodes node ON node.plan_id = plan.plan_id
        AND node.revision = plan.current_revision
        AND node.node_key = json_extract(
          run.context_manifest_json, '$.execution.scope.nodeKey'
        )
        AND node.task_id = run.task_id
      WHERE run.run_id = ? AND run.context_manifest_json IS NOT NULL
    `).get(runId) as CandidateRow | undefined;
    if (!row) return fail("VERIFICATION_CHECKPOINT_REQUIRED");
    const context = JSON.parse(row.manifest_json) as { execution?: unknown };
    if (!context.execution) return fail("VERIFICATION_MANIFEST_REQUIRED");
    return { ...row, manifest_json: canonicalExecutionJSON(context.execution) };
  }

  private requireOwner(
    principal: DevicePrincipal,
    row: VerificationOperationRow
  ): void {
    const owner = this.database.prepare(`
      SELECT 1 FROM repository_verification_operations verification
      JOIN repository_checkpoints checkpoint
        ON checkpoint.checkpoint_id = verification.checkpoint_id
      JOIN repository_capture_operations capture
        ON capture.operation_id = checkpoint.operation_id
      JOIN isolated_workspace_leases lease
        ON lease.lease_id = capture.isolated_lease_id
      JOIN devices device ON device.device_id = lease.device_id
        AND device.status = 'active'
      WHERE verification.operation_id = ?
        AND verification.device_id = ?
        AND lease.device_id = ?
        AND lease.team_id = ?
        AND lease.owner_member_id = ?
        AND device.team_id = lease.team_id
        AND device.owner_member_id = lease.owner_member_id
    `).get(
      row.operation_id,
      row.device_id,
      principal.deviceId,
      principal.teamId,
      principal.ownerMemberId
    );
    if (!owner) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Repository verification access denied"
      );
    }
  }

  private admission(row: VerificationOperationRow): VerificationAdmission {
    return {
      operationId: row.operation_id,
      requestDigest: row.request_digest,
      admittedAt: row.admitted_at,
      deadline: row.deadline
    };
  }

  private operation(operationId: string): VerificationOperationRow | undefined {
    const row = this.database.prepare(`
      SELECT * FROM repository_verification_operations WHERE operation_id = ?
    `).get(operationId) as VerificationOperationRow | undefined;
    if (row) {
      const request = JSON.parse(row.request_json) as Operation;
      assertExecutionCommand("repositoryOperation", request);
      const { requestDigest, ...unsigned } = request;
      if (
        requestDigest !== row.request_digest ||
        executionOperationDigest(unsigned) !== requestDigest ||
        request.action.kind !== "verify" ||
        request.action.verify?.profile.profileId !== row.profile_id ||
        request.action.verify?.profile.revision !== row.profile_revision ||
        request.action.verify?.profile.digest !== row.profile_digest ||
        request.deviceId !== row.device_id || request.deadline !== row.deadline
      ) return fail("VERIFICATION_OPERATION_CORRUPT");
    }
    return row;
  }

  private receiptByOperation(
    operationId: string
  ): VerificationReceiptRow | undefined {
    return this.database.prepare(`
      SELECT * FROM verification_receipts WHERE operation_id = ?
    `).get(operationId) as VerificationReceiptRow | undefined;
  }

  private mapReceipt(row: VerificationReceiptRow): RetainedVerificationReceipt {
    const receipt = JSON.parse(row.receipt_json) as VerificationReceipt;
    assertExecutionCommand("verificationReceipt", receipt);
    if (
      executionOperationDigest(receipt) !== row.receipt_digest ||
      receipt.verificationId !== row.verification_id ||
      receipt.operationId !== row.operation_id
    ) return fail("VERIFICATION_RECEIPT_CORRUPT");
    return {
      receipt,
      receiptDigest: row.receipt_digest,
      recordedAt: row.recorded_at
    };
  }
}
