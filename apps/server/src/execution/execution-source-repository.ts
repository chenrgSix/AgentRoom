import type Database from "better-sqlite3";
import type { ExecutionPlanDefinition } from "@convene-wire/contracts/execution-plan";
import {
  canonicalExecutionJSON,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";
import { ExecutionError } from "./execution-error.js";
import type { ExecutionSourceSnapshot } from "./execution-plan-repository.js";

type Source = ExecutionPlanDefinition["decision"]["sources"][number];
type SnapshotRow = Record<string, unknown> & { roomId: string; revision: number };

// Read-only source gateway. Snapshots contain domain evidence, never credentials,
// delivery envelopes, filesystem content, or an expanded Artifact read grant.
export class ExecutionSourceRepository {
  public constructor(private readonly database: Database.Database) {}

  public freeze(definition: ExecutionPlanDefinition, roomId: string): ExecutionSourceSnapshot[] {
    const revisions = new Map(definition.decision.sourceRevisions.map((pin) =>
      [pin.evidenceRefId, pin.revision]));
    let bytes = 0;
    return definition.decision.sources.map((source) => {
      const snapshot = this.resolve(source);
      if (!snapshot || snapshot.roomId !== roomId) {
        throw new ExecutionError("EXECUTION_SOURCE_UNAVAILABLE");
      }
      const revision = revisions.get(source.evidenceRefId)!;
      if (snapshot.revision !== revision) {
        throw new ExecutionError("EXECUTION_SOURCE_REVISION_CONFLICT", 409);
      }
      const encoded = canonicalExecutionJSON(snapshot);
      bytes += Buffer.byteLength(encoded);
      if (bytes > 2 * 1024 * 1024) throw new ExecutionError("EXECUTION_SOURCES_TOO_LARGE");
      return { source, revision, snapshotJson: encoded, digest: executionOperationDigest(snapshot) };
    });
  }

  public requireExternalInputs(definition: ExecutionPlanDefinition, roomId: string): void {
    for (const input of definition.externalInputs) {
      const row = this.database.prepare(`
        SELECT 1 FROM task_results result
        JOIN result_evidence_refs evidence ON evidence.result_id = result.result_id
          AND evidence.artifact_id = @artifactId AND evidence.evidence_kind = 'artifact'
        JOIN task_artifact_refs artifact ON artifact.artifact_id = evidence.artifact_id
        WHERE result.result_id = @sourceResultId AND result.task_id = @sourceTaskId
          AND result.room_id = @roomId AND result.state = 'accepted'
          AND artifact.task_id = result.task_id AND artifact.room_id = @roomId
          AND artifact.artifact_revision = @artifactRevision
          AND artifact.artifact_type = @kind AND artifact.content_sha256 = @contentDigest
          AND artifact.content_mode = 'snapshot_blob' AND artifact.content_id IS NOT NULL
      `).get({ ...input, roomId });
      if (!row) throw new ExecutionError("EXECUTION_EXTERNAL_INPUT_UNAVAILABLE");
    }
  }

  private resolve(source: Source): SnapshotRow | undefined {
    // A Message/Event revision is its immutable sequence, not a made-up revision 1.
    // Result version pins immutable proposal content; mutable review is not copied.
    switch (source.kind) {
      case "message":
        return this.database.prepare(`
          SELECT message_id AS messageId, room_id AS roomId, task_id AS taskId,
            sequence AS revision, sender_type AS senderType, sender_id AS senderId,
            content, parent_message_id AS parentMessageId, created_at AS createdAt
          FROM messages WHERE message_id = ?
        `).get(source.messageId) as SnapshotRow | undefined;
      case "run_event":
        return this.database.prepare(`
          SELECT event.run_id AS runId, run.room_id AS roomId, run.task_id AS taskId,
            event.sequence AS revision, event.event_type AS eventType, event.status,
            event.content, event.output_reset AS outputReset, event.error_json AS errorJson,
            event.assessment_json AS assessmentJson, event.activity_json AS activityJson,
            event.created_at AS createdAt
          FROM run_events event JOIN runs run ON run.run_id = event.run_id
          WHERE event.run_id = ? AND event.sequence = ?
        `).get(source.runId, source.sequence) as SnapshotRow | undefined;
      case "artifact":
        return this.database.prepare(`
          SELECT artifact_id AS artifactId, room_id AS roomId, task_id AS taskId,
            artifact_revision AS revision, artifact_type AS type, title, summary,
            commit_sha AS commitSha, content_mode AS contentMode, content_id AS contentId,
            content_sha256 AS contentSha256, content_size_bytes AS contentSizeBytes,
            source_run_id AS sourceRunId, created_at AS createdAt
          FROM task_artifact_refs WHERE artifact_id = ?
        `).get(source.artifactId) as SnapshotRow | undefined;
      case "memory":
        return this.database.prepare(`
          SELECT memory_id AS memoryId, room_id AS roomId, task_id AS taskId,
            revision, scope_kind AS scopeKind, scope_id AS scopeId, entry_type AS type,
            content, state, supersedes_memory_id AS supersedesMemoryId,
            source_message_ids_json AS sourceMessageIdsJson,
            source_artifact_ids_json AS sourceArtifactIdsJson,
            source_run_ids_json AS sourceRunIdsJson,
            source_discussion_ids_json AS sourceDiscussionIdsJson, created_at AS createdAt
          FROM memory_entries WHERE memory_id = ?
        `).get(source.memoryId) as SnapshotRow | undefined;
      case "discussion":
        return this.database.prepare(`
          SELECT discussion_id AS discussionId, room_id AS roomId, task_id AS taskId,
            version AS revision, root_message_id AS rootMessageId, goal, mode, state,
            output_mode AS outputMode, policy_json AS policyJson, progress_json AS progressJson,
            current_turn AS currentTurn, current_wave AS currentWave, created_at AS createdAt
          FROM discussions WHERE discussion_id = ?
        `).get(source.discussionId) as SnapshotRow | undefined;
      case "result": {
        const row = this.database.prepare(`
          SELECT result_id AS resultId, room_id AS roomId, task_id AS taskId,
            result_version AS revision, definition_revision AS definitionRevision,
            criteria_revision AS criteriaRevision, outcome, summary, risks_json AS risksJson,
            open_questions_json AS openQuestionsJson, supersedes_result_id AS supersedesResultId,
            proposed_at AS createdAt
          FROM task_results WHERE result_id = ?
        `).get(source.resultId) as SnapshotRow | undefined;
        if (!row) return undefined;
        row.nextActions = this.database.prepare(`
          SELECT next_action_key AS nextActionKey, description FROM result_next_actions
          WHERE result_id = ? ORDER BY ordinal
        `).all(source.resultId);
        row.sources = this.database.prepare(`
          SELECT evidence_ref_id AS evidenceRefId, evidence_kind AS kind,
            artifact_id AS artifactId, run_id AS runId, run_sequence AS sequence,
            message_id AS messageId, memory_id AS memoryId, discussion_id AS discussionId
          FROM result_evidence_refs WHERE result_id = ? ORDER BY ordinal
        `).all(source.resultId);
        row.criterionClaims = this.database.prepare(`
          SELECT criterion_key AS criterionKey, coverage, explanation
          FROM result_criterion_claims WHERE result_id = ? ORDER BY ordinal
        `).all(source.resultId);
        row.claimEvidence = this.database.prepare(`
          SELECT criterion_key AS criterionKey, evidence_ref_id AS evidenceRefId
          FROM result_claim_evidence WHERE result_id = ? ORDER BY criterion_key, ordinal
        `).all(source.resultId);
        return row;
      }
    }
  }
}
