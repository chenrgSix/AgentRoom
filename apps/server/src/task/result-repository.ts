import type Database from "better-sqlite3";

import type {
  ResultProjection,
  ResultProposal,
  ResultReviewCommand
} from "@convene-wire/contracts/task-result";

import { createOpaqueId } from "../domain/identifiers.js";

export type ResultActor =
  | { kind: "member"; memberId: string }
  | {
      kind: "manual_agent" | "managed_agent";
      agentId: string;
      runId: string;
    }
  | { kind: "orchestrator"; discussionId: string };

interface ResultRow {
  result_id: string;
  task_id: string;
  room_id: string;
  result_version: number;
  operation_id: string;
  state: ResultProjection["state"];
  definition_revision: number;
  criteria_revision: number;
  proposed_at_task_revision: number;
  supersedes_result_id: string | null;
  outcome: ResultProposal["outcome"];
  summary: string;
  risks_json: string;
  open_questions_json: string;
  proposed_by_kind: ResultProjection["proposedBy"]["kind"];
  proposed_by_member_id: string | null;
  proposed_by_agent_id: string | null;
  proposed_by_run_id: string | null;
  proposed_by_discussion_id: string | null;
  proposed_at: string;
}

interface EvidenceRow {
  evidence_ref_id: string;
  evidence_kind: ResultProposal["sources"][number]["kind"];
  artifact_id: string | null;
  run_id: string | null;
  run_sequence: number | null;
  message_id: string | null;
  memory_id: string | null;
  discussion_id: string | null;
}

interface ClaimRow {
  criterion_key: string;
  coverage: ResultProposal["criterionClaims"][number]["coverage"];
  explanation: string;
}

interface ReviewRow {
  decision: "accepted" | "rejected";
  review_revision: number;
  reviewed_by_member_id: string;
  reason: string;
  reviewed_at: string;
}

export interface ResultReviewOutcome {
  result: ResultProjection;
  taskRevisionBefore: number;
  taskRevisionAfter: number;
  completedTask: boolean;
}

export class ResultRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(resultId: string): ResultProjection | undefined {
    const row = this.database.prepare(`
      SELECT * FROM task_results WHERE result_id = ?
    `).get(resultId) as ResultRow | undefined;
    return row && this.map(row);
  }

  public listForTask(taskId: string): ResultProjection[] {
    return (this.database.prepare(`
      SELECT * FROM task_results WHERE task_id = ?
      ORDER BY result_version DESC, result_id DESC
    `).all(taskId) as ResultRow[]).map((row) => this.map(row));
  }

  public create(input: {
    roomId: string;
    proposal: ResultProposal;
    actor: ResultActor;
    now: string;
  }): ResultProjection {
    let resultId: string | undefined;
    this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT result_id, task_id FROM task_results WHERE operation_id = ?
      `).get(input.proposal.operationId) as
        | { result_id: string; task_id: string }
        | undefined;
      if (replay) {
        if (replay.task_id !== input.proposal.taskId) {
          throw new Error("Result operation is bound to another Task");
        }
        resultId = replay.result_id;
        return;
      }
      const task = this.database.prepare(`
        SELECT task_revision, definition_revision, criteria_revision,
          lifecycle_state
        FROM agent_tasks WHERE task_id = ? AND room_id = ?
      `).get(input.proposal.taskId, input.roomId) as {
        task_revision: number;
        definition_revision: number;
        criteria_revision: number;
        lifecycle_state: string;
      } | undefined;
      if (!task) throw new Error("Result Task is unavailable");
      if (!["active", "review"].includes(task.lifecycle_state)) {
        throw new Error("Only an active or review Task may receive a Result proposal");
      }
      if (task.task_revision !== input.proposal.proposedAtTaskRevision) {
        throw new Error("Task revision conflict");
      }
      if (task.definition_revision !== input.proposal.definitionRevision ||
        task.criteria_revision !== input.proposal.criteriaRevision) {
        throw new Error("Result proposal revisions are stale");
      }
      const resultVersion = (this.database.prepare(`
        SELECT COALESCE(MAX(result_version), 0) + 1 AS next
        FROM task_results WHERE task_id = ?
      `).get(input.proposal.taskId) as { next: number }).next;
      resultId = createOpaqueId("result");
      this.database.prepare(`
        INSERT INTO task_results (
          result_id, task_id, room_id, result_version, operation_id, state,
          definition_revision, criteria_revision, proposed_at_task_revision,
          supersedes_result_id, outcome, summary, risks_json,
          open_questions_json, proposed_by_kind, proposed_by_member_id,
          proposed_by_agent_id, proposed_by_run_id,
          proposed_by_discussion_id, proposed_at
        ) VALUES (
          @resultId, @taskId, @roomId, @resultVersion, @operationId, 'proposed',
          @definitionRevision, @criteriaRevision, @proposedAtTaskRevision,
          @supersedesResultId, @outcome, @summary, @risksJson,
          @openQuestionsJson, @actorKind, @memberId, @agentId, @runId,
          @discussionId, @now
        )
      `).run({
        resultId,
        taskId: input.proposal.taskId,
        roomId: input.roomId,
        resultVersion,
        operationId: input.proposal.operationId,
        definitionRevision: input.proposal.definitionRevision,
        criteriaRevision: input.proposal.criteriaRevision,
        proposedAtTaskRevision: input.proposal.proposedAtTaskRevision,
        supersedesResultId: input.proposal.supersedesResultId,
        outcome: input.proposal.outcome,
        summary: input.proposal.summary,
        risksJson: JSON.stringify(input.proposal.risks),
        openQuestionsJson: JSON.stringify(input.proposal.openQuestions),
        actorKind: input.actor.kind,
        memberId: input.actor.kind === "member" ? input.actor.memberId : null,
        agentId: input.actor.kind === "manual_agent" ||
            input.actor.kind === "managed_agent"
          ? input.actor.agentId
          : null,
        runId: input.actor.kind === "manual_agent" ||
            input.actor.kind === "managed_agent"
          ? input.actor.runId
          : null,
        discussionId: input.actor.kind === "orchestrator"
          ? input.actor.discussionId
          : null,
        now: input.now
      });
      this.insertNextActions(resultId, input.proposal.nextActions);
      this.insertEvidence(resultId, input.proposal.sources);
      this.insertClaims(
        resultId,
        input.proposal.taskId,
        input.proposal.criteriaRevision,
        input.proposal.criterionClaims
      );
      if (input.proposal.supersedesResultId) {
        const superseded = this.database.prepare(`
          UPDATE task_results SET state = 'superseded'
          WHERE result_id = ? AND state IN ('proposed', 'rejected')
        `).run(input.proposal.supersedesResultId);
        if (superseded.changes !== 1) {
          throw new Error("Result supersession conflict");
        }
      }
      const advanced = this.database.prepare(`
        UPDATE agent_tasks SET task_revision = task_revision + 1, updated_at = ?
        WHERE task_id = ? AND task_revision = ?
      `).run(
        input.now,
        input.proposal.taskId,
        input.proposal.proposedAtTaskRevision
      );
      if (advanced.changes !== 1) throw new Error("Task revision conflict");
    }).immediate();
    return this.get(resultId!)!;
  }

  public review(input: {
    resultId: string;
    memberId: string;
    command: ResultReviewCommand;
    now: string;
  }): ResultReviewOutcome {
    let outcome: ResultReviewOutcome | undefined;
    this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT review.result_id, review.task_revision_before,
          review.task_revision_after, review.completed_task
        FROM result_reviews review WHERE review.operation_id = ?
      `).get(input.command.operationId) as {
        result_id: string;
        task_revision_before: number;
        task_revision_after: number;
        completed_task: number;
      } | undefined;
      if (replay) {
        if (replay.result_id !== input.resultId) {
          throw new Error("Review operation is bound to another Result");
        }
        outcome = {
          result: this.get(input.resultId)!,
          taskRevisionBefore: replay.task_revision_before,
          taskRevisionAfter: replay.task_revision_after,
          completedTask: replay.completed_task === 1
        };
        return;
      }
      if (input.command.expectedReviewRevision !== 0) {
        throw new Error("Result review revision conflict");
      }
      const result = this.database.prepare(`
        SELECT * FROM task_results WHERE result_id = ?
      `).get(input.resultId) as ResultRow | undefined;
      if (!result || result.state !== "proposed") {
        throw new Error("Only a proposed Result may be reviewed");
      }
      const task = this.database.prepare(`
        SELECT task_revision, definition_revision, criteria_revision,
          lifecycle_state, is_default
        FROM agent_tasks WHERE task_id = ?
      `).get(result.task_id) as {
        task_revision: number;
        definition_revision: number;
        criteria_revision: number;
        lifecycle_state: string;
        is_default: number;
      };
      if (task.task_revision !== input.command.expectedTaskRevision) {
        throw new Error("Task revision conflict");
      }
      if (input.command.completeTask && input.command.decision !== "accepted") {
        throw new Error("Only an accepted Result may complete a Task");
      }
      if (input.command.decision === "accepted" &&
        (result.definition_revision !== task.definition_revision ||
          result.criteria_revision !== task.criteria_revision)) {
        throw new Error("Stale Result cannot be accepted");
      }
      if (input.command.completeTask) {
        this.requireCompletable(result, task);
      }
      this.database.prepare(`
        INSERT INTO result_reviews (
          result_id, operation_id, decision, review_revision,
          reviewed_by_member_id, reason, task_revision_before,
          task_revision_after, completed_task, reviewed_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        input.resultId,
        input.command.operationId,
        input.command.decision,
        input.memberId,
        input.command.reason,
        input.command.expectedTaskRevision,
        input.command.expectedTaskRevision + 1,
        input.command.completeTask ? 1 : 0,
        input.now
      );
      this.database.prepare(`
        UPDATE task_results SET state = ? WHERE result_id = ?
      `).run(input.command.decision, input.resultId);
      const updated = input.command.completeTask
        ? this.database.prepare(`
            UPDATE agent_tasks
            SET lifecycle_state = 'completed', state = 'completed',
              completion_result_id = ?, task_revision = task_revision + 1,
              updated_at = ?
            WHERE task_id = ? AND task_revision = ?
          `).run(
            input.resultId,
            input.now,
            result.task_id,
            input.command.expectedTaskRevision
          )
        : this.database.prepare(`
            UPDATE agent_tasks SET task_revision = task_revision + 1,
              updated_at = ? WHERE task_id = ? AND task_revision = ?
          `).run(
            input.now,
            result.task_id,
            input.command.expectedTaskRevision
          );
      if (updated.changes !== 1) throw new Error("Task revision conflict");
      outcome = {
        result: this.get(input.resultId)!,
        taskRevisionBefore: input.command.expectedTaskRevision,
        taskRevisionAfter: input.command.expectedTaskRevision + 1,
        completedTask: input.command.completeTask
      };
    }).immediate();
    return outcome!;
  }

  public createChildSource(input: {
    resultId: string;
    nextActionKey: string;
    operationId: string;
    memberId: string;
    now: string;
    createChild: (description: string, parentTaskId: string) => string;
  }): string {
    let childTaskId: string | undefined;
    this.database.transaction(() => {
      const replay = this.database.prepare(`
        SELECT child_task_id, source_result_id, next_action_key
        FROM task_result_sources WHERE operation_id = ?
      `).get(input.operationId) as {
        child_task_id: string;
        source_result_id: string;
        next_action_key: string;
      } | undefined;
      if (replay) {
        if (replay.source_result_id !== input.resultId ||
          replay.next_action_key !== input.nextActionKey) {
          throw new Error("Child Task operation is bound to another Result action");
        }
        childTaskId = replay.child_task_id;
        return;
      }
      const action = this.database.prepare(`
        SELECT action.description, result.task_id
        FROM result_next_actions action
        JOIN task_results result ON result.result_id = action.result_id
        WHERE action.result_id = ? AND action.next_action_key = ?
          AND result.state = 'accepted'
      `).get(input.resultId, input.nextActionKey) as
        | { description: string; task_id: string }
        | undefined;
      if (!action) {
        throw new Error("Accepted Result next action not found");
      }
      childTaskId = input.createChild(action.description, action.task_id);
      this.database.prepare(`
        INSERT INTO task_result_sources (
          child_task_id, source_result_id, next_action_key, operation_id,
          created_by_member_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        childTaskId,
        input.resultId,
        input.nextActionKey,
        input.operationId,
        input.memberId,
        input.now
      );
    }).immediate();
    return childTaskId!;
  }

  private insertNextActions(
    resultId: string,
    actions: ResultProposal["nextActions"]
  ): void {
    const insert = this.database.prepare(`
      INSERT INTO result_next_actions (
        result_id, next_action_key, ordinal, description
      ) VALUES (?, ?, ?, ?)
    `);
    actions.forEach((action, index) => insert.run(
      resultId,
      action.nextActionKey,
      index + 1,
      action.description
    ));
  }

  private insertEvidence(
    resultId: string,
    sources: ResultProposal["sources"]
  ): void {
    const insert = this.database.prepare(`
      INSERT INTO result_evidence_refs (
        result_id, evidence_ref_id, ordinal, evidence_kind, artifact_id,
        run_id, run_sequence, message_id, memory_id, discussion_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    sources.forEach((source, index) => insert.run(
      resultId,
      source.evidenceRefId,
      index + 1,
      source.kind,
      source.kind === "artifact" ? source.artifactId : null,
      source.kind === "run_event" ? source.runId : null,
      source.kind === "run_event" ? source.sequence : null,
      source.kind === "message" ? source.messageId : null,
      source.kind === "memory" ? source.memoryId : null,
      source.kind === "discussion" ? source.discussionId : null
    ));
  }

  private insertClaims(
    resultId: string,
    taskId: string,
    criteriaRevision: number,
    claims: ResultProposal["criterionClaims"]
  ): void {
    const insertClaim = this.database.prepare(`
      INSERT INTO result_criterion_claims (
        result_id, task_id, criteria_revision, criterion_key, coverage,
        explanation, ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEvidence = this.database.prepare(`
      INSERT INTO result_claim_evidence (
        result_id, criterion_key, evidence_ref_id, ordinal
      ) VALUES (?, ?, ?, ?)
    `);
    claims.forEach((claim, index) => {
      insertClaim.run(
        resultId,
        taskId,
        criteriaRevision,
        claim.criterionKey,
        claim.coverage,
        claim.explanation,
        index + 1
      );
      claim.evidenceRefIds.forEach((evidenceRefId, evidenceIndex) =>
        insertEvidence.run(
          resultId,
          claim.criterionKey,
          evidenceRefId,
          evidenceIndex + 1
        )
      );
    });
  }

  private requireCompletable(
    result: ResultRow,
    task: { lifecycle_state: string; is_default: number }
  ): void {
    if (result.outcome !== "satisfied" && result.outcome !== "partial") {
      throw new Error("Result outcome cannot complete the Task");
    }
    if (task.is_default === 1) {
      throw new Error("Default Task is permanently active");
    }
    if (!["active", "review"].includes(task.lifecycle_state)) {
      throw new Error("Task is not in a completable lifecycle state");
    }
    const activeWork = this.database.prepare(`
      SELECT 1 WHERE EXISTS (
        SELECT 1 FROM runs WHERE task_id = ? AND state NOT IN (
          'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
        )
      ) OR EXISTS (
        SELECT 1 FROM discussions WHERE task_id = ? AND state NOT IN (
          'completed', 'canceled', 'terminated'
        )
      ) OR EXISTS (
        SELECT 1 FROM task_clarifications WHERE task_id = ? AND state = 'waiting'
      )
    `).get(result.task_id, result.task_id, result.task_id);
    if (activeWork) throw new Error("Task has active work");
    const ambiguity = this.database.prepare(`
      SELECT 1 FROM runs run
      LEFT JOIN run_ambiguity_acknowledgements acknowledgement
        ON acknowledgement.run_id = run.run_id
      WHERE run.task_id = ? AND run.state = 'outcome_unknown'
        AND acknowledgement.run_id IS NULL LIMIT 1
    `).get(result.task_id);
    if (ambiguity) throw new Error("Task has an unacknowledged ambiguous outcome");
    if (this.database.prepare(`
      SELECT 1 FROM task_blocks WHERE task_id = ? AND state = 'open' LIMIT 1
    `).get(result.task_id)) {
      throw new Error("Task has an unresolved block");
    }
    const missingRequired = this.database.prepare(`
      SELECT criterion.criterion_key
      FROM task_criteria_entries criterion
      WHERE criterion.task_id = ? AND criterion.criteria_revision = ?
        AND criterion.required = 1 AND NOT EXISTS (
          SELECT 1 FROM result_criterion_claims claim
          WHERE claim.result_id = ?
            AND claim.criterion_key = criterion.criterion_key
            AND claim.coverage = 'satisfied'
            AND EXISTS (
              SELECT 1 FROM result_claim_evidence link
              JOIN result_evidence_refs evidence
                ON evidence.result_id = link.result_id
               AND evidence.evidence_ref_id = link.evidence_ref_id
              WHERE link.result_id = claim.result_id
                AND link.criterion_key = claim.criterion_key
                AND evidence.evidence_kind = 'artifact'
            )
        )
      LIMIT 1
    `).get(result.task_id, result.criteria_revision, result.result_id);
    if (missingRequired) {
      throw new Error(
        "Every required criterion needs a satisfied claim with Artifact evidence"
      );
    }
  }

  private map(row: ResultRow): ResultProjection {
    const sources = (this.database.prepare(`
      SELECT * FROM result_evidence_refs WHERE result_id = ?
      ORDER BY ordinal
    `).all(row.result_id) as EvidenceRow[]).map((source) => ({
      evidenceRefId: source.evidence_ref_id,
      kind: source.evidence_kind,
      ...(source.artifact_id ? { artifactId: source.artifact_id } : {}),
      ...(source.run_id ? { runId: source.run_id } : {}),
      ...(source.run_sequence !== null ? { sequence: source.run_sequence } : {}),
      ...(source.message_id ? { messageId: source.message_id } : {}),
      ...(source.memory_id ? { memoryId: source.memory_id } : {}),
      ...(source.discussion_id ? { discussionId: source.discussion_id } : {})
    })) as unknown as ResultProposal["sources"];
    const claims = (this.database.prepare(`
      SELECT criterion_key, coverage, explanation
      FROM result_criterion_claims WHERE result_id = ? ORDER BY ordinal
    `).all(row.result_id) as ClaimRow[]).map((claim) => ({
      criterionKey: claim.criterion_key,
      coverage: claim.coverage,
      explanation: claim.explanation,
      evidenceRefIds: (this.database.prepare(`
        SELECT evidence_ref_id FROM result_claim_evidence
        WHERE result_id = ? AND criterion_key = ? ORDER BY ordinal
      `).all(row.result_id, claim.criterion_key) as Array<{
        evidence_ref_id: string;
      }>).map(({ evidence_ref_id }) => evidence_ref_id)
    }));
    const nextActions = (this.database.prepare(`
      SELECT next_action_key, description FROM result_next_actions
      WHERE result_id = ? ORDER BY ordinal
    `).all(row.result_id) as Array<{
      next_action_key: string;
      description: string;
    }>).map((action) => ({
      nextActionKey: action.next_action_key,
      description: action.description
    }));
    const review = this.database.prepare(`
      SELECT decision, review_revision, reviewed_by_member_id, reason,
        reviewed_at FROM result_reviews WHERE result_id = ?
    `).get(row.result_id) as ReviewRow | undefined;
    const proposedBy: ResultProjection["proposedBy"] =
      row.proposed_by_kind === "member"
        ? { kind: "member", memberId: row.proposed_by_member_id! }
        : row.proposed_by_kind === "orchestrator"
          ? {
              kind: "orchestrator",
              discussionId: row.proposed_by_discussion_id!
            }
          : {
              kind: row.proposed_by_kind,
              agentId: row.proposed_by_agent_id!,
              runId: row.proposed_by_run_id!
            };
    return {
      resultId: row.result_id,
      resultVersion: row.result_version,
      taskId: row.task_id,
      roomId: row.room_id,
      state: row.state,
      proposal: {
        operationId: row.operation_id,
        taskId: row.task_id,
        definitionRevision: row.definition_revision,
        criteriaRevision: row.criteria_revision,
        proposedAtTaskRevision: row.proposed_at_task_revision,
        supersedesResultId: row.supersedes_result_id,
        outcome: row.outcome,
        summary: row.summary,
        risks: JSON.parse(row.risks_json) as string[],
        openQuestions: JSON.parse(row.open_questions_json) as string[],
        nextActions,
        sources,
        criterionClaims: claims
      },
      review: review
        ? {
            decision: review.decision,
            reviewRevision: review.review_revision,
            reviewedByMemberId: review.reviewed_by_member_id,
            reason: review.reason,
            reviewedAt: review.reviewed_at
          }
        : null,
      proposedBy,
      proposedAt: row.proposed_at
    };
  }
}
