import type Database from "better-sqlite3";
import type {
  GateProofRef,
  RemoteCIObservationReceipt,
  RemoteCommitObservation,
  SourceEvidence
} from "@convene-wire/contracts/execution-plan";
import { canonicalExecutionJSON, executionOperationDigest } from
  "@convene-wire/contracts/execution-validation";
import type { ArtifactContentRecord } from
  "../artifact/artifact-publication-repository.js";
import { ArtifactPublicationRepository } from
  "../artifact/artifact-publication-repository.js";
import { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import { ArtifactRepository, type TaskArtifactRecord } from
  "../task/artifact-repository.js";

export type RemoteEvidenceOperationState =
  "planned" | "outcome_unknown" | "succeeded" | "failed";

export interface RemoteEvidenceOperation {
  operationId: string;
  kind: "commit_observation" | "ci_observation";
  providerBindingId: string;
  planId: string;
  planRevision: number;
  nodeKey: string;
  expectedPlanDigest: string;
  expectedControlRevision: number;
  actorMemberId: string;
  requestDigest: string;
  request: Record<string, unknown>;
  state: RemoteEvidenceOperationState;
  observationId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OperationRow {
  operation_id: string;
  kind: RemoteEvidenceOperation["kind"];
  provider_binding_id: string;
  plan_id: string;
  plan_revision: number;
  node_key: string;
  expected_plan_digest: string;
  expected_control_revision: number;
  actor_member_id: string;
  request_digest: string;
  request_json: string;
  state: RemoteEvidenceOperationState;
  observation_id: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

interface RemoteArtifactImport {
  importId: string;
  operationId: string;
  providerBindingId: string;
  artifact: TaskArtifactRecord;
  content: ArtifactContentRecord;
  kind: "commit_bundle" | "patch";
  mediaType: "application/x-git-bundle" | "text/x-diff";
}

function mapOperation(row: OperationRow): RemoteEvidenceOperation {
  return {
    operationId: row.operation_id,
    kind: row.kind,
    providerBindingId: row.provider_binding_id,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    nodeKey: row.node_key,
    expectedPlanDigest: row.expected_plan_digest,
    expectedControlRevision: row.expected_control_revision,
    actorMemberId: row.actor_member_id,
    requestDigest: row.request_digest,
    request: JSON.parse(row.request_json) as Record<string, unknown>,
    state: row.state,
    observationId: row.observation_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class RemoteEvidenceRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly artifacts = new ArtifactRepository(database),
    private readonly contents = new ArtifactPublicationRepository(database),
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public getOperation(operationId: string): RemoteEvidenceOperation | undefined {
    const row = this.database.prepare(`
      SELECT * FROM remote_evidence_operations WHERE operation_id = ?
    `).get(operationId) as OperationRow | undefined;
    return row && mapOperation(row);
  }

  public plan(operation: RemoteEvidenceOperation): RemoteEvidenceOperation {
    return this.transactions.immediate(() => {
      const existing = this.getOperation(operation.operationId);
      if (existing) return existing;
      this.database.prepare(`
        INSERT INTO remote_evidence_operations (
          operation_id, kind, provider_binding_id, plan_id, plan_revision,
          node_key, expected_plan_digest, expected_control_revision,
          actor_member_id, request_digest, request_json, state,
          observation_id, error_code, created_at, updated_at
        ) VALUES (
          @operationId, @kind, @providerBindingId, @planId, @planRevision,
          @nodeKey, @expectedPlanDigest, @expectedControlRevision,
          @actorMemberId, @requestDigest, @requestJson, 'planned',
          NULL, NULL, @createdAt, @updatedAt
        )
      `).run({
        ...operation,
        requestJson: canonicalExecutionJSON(operation.request)
      });
      return this.getOperation(operation.operationId)!;
    });
  }

  public markOutcomeUnknown(operationId: string, code: string, now: string): void {
    this.database.prepare(`
      UPDATE remote_evidence_operations
      SET state = 'outcome_unknown', error_code = ?, updated_at = ?
      WHERE operation_id = ? AND state IN ('planned', 'outcome_unknown')
    `).run(code, now, operationId);
  }

  public markFailed(operationId: string, code: string, now: string): void {
    this.database.prepare(`
      UPDATE remote_evidence_operations
      SET state = 'failed', error_code = ?, updated_at = ?
      WHERE operation_id = ? AND state IN ('planned', 'outcome_unknown')
    `).run(code, now, operationId);
  }

  public getCommit(operationId: string): RemoteCommitObservation | undefined {
    const row = this.database.prepare(`
      SELECT observation_json FROM remote_commit_observations
      WHERE operation_id = ?
    `).get(operationId) as { observation_json: string } | undefined;
    return row && JSON.parse(row.observation_json) as RemoteCommitObservation;
  }

  public getSource(sourceEvidenceId: string): SourceEvidence | undefined {
    const row = this.database.prepare(`
      SELECT source_json FROM execution_remote_source_evidence
      WHERE source_evidence_id = ?
    `).get(sourceEvidenceId) as { source_json: string } | undefined;
    return row && JSON.parse(row.source_json) as SourceEvidence;
  }

  public retainCommit(
    operationId: string,
    imports: [RemoteArtifactImport, RemoteArtifactImport],
    buildRecords: (artifacts: [TaskArtifactRecord, TaskArtifactRecord]) => {
      observation: RemoteCommitObservation;
      source: SourceEvidence;
    },
    now: string
  ): { observation: RemoteCommitObservation; source: SourceEvidence } {
    return this.transactions.immediate(() => {
      const replay = this.getCommit(operationId);
      if (replay) {
        const sourceJson = this.database.prepare(`
          SELECT source_json FROM execution_remote_source_evidence
          WHERE observation_id = ?
        `).pluck().get(replay.observationId) as string | undefined;
        if (!sourceJson) throw new Error("Remote SourceEvidence is missing");
        return { observation: replay, source: JSON.parse(sourceJson) as SourceEvidence };
      }
      const retained = imports.map((item) => {
        const content = this.contents.retainContent(item.content);
        this.database.prepare(`
          INSERT INTO remote_artifact_imports (
            import_id, operation_id, provider_binding_id, artifact_id,
            content_id, kind, content_digest, byte_length, media_type, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.importId, item.operationId, item.providerBindingId,
          item.artifact.artifactId, content.contentId, item.kind,
          content.sha256, content.sizeBytes, item.mediaType, now
        );
        const existing = this.artifacts.get(item.artifact.artifactId);
        return existing ?? this.artifacts.create({
          ...item.artifact,
          contentId: content.contentId
        }).artifact;
      }) as [TaskArtifactRecord, TaskArtifactRecord];
      const records = buildRecords(retained);
      this.database.prepare(`
        INSERT INTO remote_commit_observations (
          operation_id, provider_binding_id, repository_id,
          provider_repository_id, task_id, observation_id, object_format,
          base_commit, candidate_commit, candidate_tree, input_digest,
          bundle_artifact_id, patch_artifact_id, provider_observation_digest,
          observation_digest, observation_json, observed_at
        ) VALUES (
          @operationId, @providerBindingId, @repositoryId,
          @providerRepositoryId, @taskId, @observationId, @objectFormat,
          @baseCommit, @commit, @tree, @inputDigest,
          @bundleArtifactId, @patchArtifactId, @providerObservationDigest,
          @observationDigest, @observationJson, @observedAt
        )
      `).run({ ...records.observation,
        observationJson: canonicalExecutionJSON(records.observation) });
      this.database.prepare(`
        INSERT INTO execution_remote_source_evidence (
          source_evidence_id, source_digest, repository_id, observation_id,
          candidate_commit, candidate_tree, artifact_pins_json,
          source_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        records.source.sourceEvidenceId, records.source.sourceDigest,
        records.source.repositoryId, records.observation.observationId,
        records.source.commit, records.source.tree,
        canonicalExecutionJSON(records.source.artifactPins),
        canonicalExecutionJSON(records.source), records.source.createdAt
      );
      this.database.prepare(`
        UPDATE remote_evidence_operations SET state = 'succeeded',
          observation_id = ?, error_code = NULL, updated_at = ?
        WHERE operation_id = ? AND state IN ('planned', 'outcome_unknown')
      `).run(records.observation.observationId, now, operationId);
      return records;
    });
  }

  public getCI(operationId: string): RemoteCIObservationReceipt | undefined {
    const row = this.database.prepare(`
      SELECT receipt_json FROM remote_ci_observation_receipts WHERE operation_id = ?
    `).get(operationId) as { receipt_json: string } | undefined;
    return row && JSON.parse(row.receipt_json) as RemoteCIObservationReceipt;
  }

  public retainCI(receipt: RemoteCIObservationReceipt, now: string): RemoteCIObservationReceipt {
    return this.transactions.immediate(() => {
      const replay = this.getCI(receipt.operationId);
      if (replay) return replay;
      this.database.prepare(`
        INSERT INTO remote_ci_observation_receipts (
          operation_id, provider_binding_id, repository_id, source_evidence_id,
          observation_id, check_key, attempt, outcome, candidate_commit,
          candidate_tree, profile_id, profile_revision, profile_digest,
          provider_observation_digest, receipt_digest, receipt_json, observed_at
        ) VALUES (
          @operationId, @providerBindingId, @repositoryId, @sourceEvidenceId,
          @observationId, @checkKey, @attempt, @outcome, @commit,
          @tree, @profileId, @profileRevision, @profileDigest,
          @providerObservationDigest, @receiptDigest, @receiptJson, @observedAt
        )
      `).run({ ...receipt, receiptJson: canonicalExecutionJSON(receipt) });
      if (receipt.outcome === "passed") {
        const proof: GateProofRef = {
          kind: "ci_observation_receipt",
          operationId: receipt.operationId,
          providerBindingId: receipt.providerBindingId,
          observationId: receipt.observationId,
          checkKey: receipt.checkKey,
          attempt: receipt.attempt,
          proofDigest: receipt.receiptDigest
        };
        this.database.prepare(`
          INSERT INTO execution_remote_gate_proof_refs (
            proof_ref_id, operation_id, proof_digest, proof_json, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          `proof_${executionOperationDigest(proof)}`,
          receipt.operationId,
          receipt.receiptDigest,
          canonicalExecutionJSON(proof),
          now
        );
      }
      this.database.prepare(`
        UPDATE remote_evidence_operations SET state = 'succeeded',
          observation_id = ?, error_code = NULL, updated_at = ?
        WHERE operation_id = ? AND state IN ('planned', 'outcome_unknown')
      `).run(receipt.observationId, now, receipt.operationId);
      return receipt;
    });
  }
}
