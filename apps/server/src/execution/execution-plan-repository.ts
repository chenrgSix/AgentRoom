import type Database from "better-sqlite3";
import type {
  ExecutionDecisionRecord,
  ExecutionDecisionSourceSnapshot,
  ExecutionPlanDefinition,
  ExecutionPlanPage,
  ExecutionPlanProjection,
  ExecutionPlanRevision,
  ExecutionPlanRevisionPage,
  ExecutionPlanSupersessionCandidate
} from "@convene-wire/contracts/execution-plan";
import {
  assertExecutionCommand,
  canonicalExecutionJSON
} from "@convene-wire/contracts/execution-validation";
import { createOpaqueId } from "../domain/identifiers.js";
import { ExecutionError } from "./execution-error.js";

export type ExecutionSourceSnapshot = ExecutionDecisionSourceSnapshot;

interface PlanRow {
  plan_id: string;
  root_task_id: string;
  room_id: string;
  owner_member_id: string;
  current_revision: number;
  control_revision: number;
  state: ExecutionPlanProjection["state"];
  created_at: string;
  updated_at: string;
}

interface RevisionRow {
  plan_id: string;
  revision: number;
  proposal_id: string;
  decision_id: string;
  definition_json: string;
  author_json: string;
  digest: string;
  created_at: string;
}

function mapRevision(row: RevisionRow): ExecutionPlanRevision {
  return {
    planId: row.plan_id,
    revision: row.revision,
    proposalId: row.proposal_id,
    decisionId: row.decision_id,
    definition: JSON.parse(row.definition_json),
    author: JSON.parse(row.author_json),
    digest: row.digest,
    createdAt: row.created_at
  };
}

// This repository participates in the composition-owned immediate transaction.
// It has no Task mutation, Runtime delivery, filesystem or provider port.
export class ExecutionPlanRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(planId: string): ExecutionPlanProjection | undefined {
    const row = this.database.prepare(
      "SELECT * FROM execution_plans WHERE plan_id = ?"
    ).get(planId) as PlanRow | undefined;
    if (!row) return undefined;
    const current = this.revision(planId, row.current_revision);
    if (!current) throw new ExecutionError("EXECUTION_HISTORY_INCONSISTENT");
    return {
      planId,
      rootTaskId: row.root_task_id,
      roomId: row.room_id,
      ownerMemberId: row.owner_member_id,
      current,
      controlRevision: row.control_revision,
      state: row.state,
      compiledTasks: (this.database.prepare(`
        SELECT node_key AS nodeKey, task_id AS taskId, task_revision AS taskRevision,
          definition_revision AS definitionRevision, criteria_revision AS criteriaRevision
        FROM execution_plan_nodes WHERE plan_id = ? AND revision = ? ORDER BY node_key
      `).all(planId, row.current_revision)) as ExecutionPlanProjection["compiledTasks"],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  public list(roomId: string, afterPlanId: string, limit: number): ExecutionPlanPage {
    const rows = this.database.prepare(`
      SELECT plan_id FROM execution_plans WHERE room_id = ? AND plan_id > ?
      ORDER BY plan_id LIMIT ?
    `).all(roomId, afterPlanId, limit + 1) as Array<{ plan_id: string }>;
    const page = rows.slice(0, limit);
    return {
      plans: page.map(({ plan_id }) => this.get(plan_id)!),
      nextAfterPlanId: rows.length > limit ? page.at(-1)!.plan_id : null
    };
  }

  public listForRootTask(
    rootTaskId: string,
    afterPlanId: string,
    limit: number
  ): ExecutionPlanPage {
    const rows = this.database.prepare(`
      SELECT plan_id FROM execution_plans
      WHERE root_task_id = ? AND plan_id > ?
      ORDER BY plan_id LIMIT ?
    `).all(rootTaskId, afterPlanId, limit + 1) as Array<{ plan_id: string }>;
    const page = rows.slice(0, limit);
    return {
      plans: page.map(({ plan_id }) => this.get(plan_id)!),
      nextAfterPlanId: rows.length > limit ? page.at(-1)!.plan_id : null
    };
  }

  public revision(planId: string, revision: number): ExecutionPlanRevision | undefined {
    const row = this.database.prepare(`
      SELECT proposal.* FROM execution_plan_revisions revision
      JOIN execution_plan_proposals proposal ON proposal.proposal_id = revision.proposal_id
      WHERE revision.plan_id = ? AND revision.revision = ?
    `).get(planId, revision) as RevisionRow | undefined;
    return row && mapRevision(row);
  }

  public history(planId: string, afterRevision: number, limit: number): ExecutionPlanRevisionPage {
    const rows = this.database.prepare(`
      SELECT proposal.* FROM execution_plan_revisions revision
      JOIN execution_plan_proposals proposal ON proposal.proposal_id = revision.proposal_id
      WHERE revision.plan_id = ? AND revision.revision > ?
      ORDER BY revision.revision LIMIT ?
    `).all(planId, afterRevision, limit + 1) as RevisionRow[];
    const page = rows.slice(0, limit);
    return {
      revisions: page.map(mapRevision),
      nextAfterRevision: rows.length > limit ? page.at(-1)!.revision : null
    };
  }

  public decision(decisionId: string): ExecutionDecisionRecord | undefined {
    const row = this.database.prepare(
      "SELECT * FROM execution_decisions WHERE decision_id = ?"
    ).get(decisionId) as {
      root_task_id: string; room_id: string; content_json: string;
      author_json: string; supersedes_decision_id: string | null; created_at: string;
    } | undefined;
    return row && {
      decisionId,
      rootTaskId: row.root_task_id,
      roomId: row.room_id,
      content: JSON.parse(row.content_json),
      author: JSON.parse(row.author_json),
      supersedesDecisionId: row.supersedes_decision_id,
      createdAt: row.created_at
    };
  }

  public sources(decisionId: string): ExecutionSourceSnapshot[] {
    const rows = this.database.prepare(`
      SELECT * FROM execution_decision_sources WHERE decision_id = ?
      ORDER BY evidence_ref_id
    `).all(decisionId) as Array<{
      source_json: string; source_revision: number;
      snapshot_json: string; snapshot_digest: string;
    }>;
    return rows.map((row) => ({
      source: JSON.parse(row.source_json),
      revision: row.source_revision,
      digest: row.snapshot_digest,
      snapshotJson: row.snapshot_json
    }));
  }

  public replay(operationId: string, digest: string): ExecutionPlanProjection | undefined {
    if (this.database.prepare(`
      SELECT 1 FROM execution_plan_approvals WHERE operation_id = ?
      UNION ALL SELECT 1 FROM execution_plan_supersession_candidates
        WHERE operation_id = ?
      UNION ALL SELECT 1 FROM execution_plan_supersession_activations
        WHERE operation_id = ?
      LIMIT 1
    `).get(operationId, operationId, operationId)) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    const row = this.database.prepare(`
      SELECT request_digest, response_json FROM execution_plan_operations WHERE operation_id = ?
    `).get(operationId) as { request_digest: string; response_json: string } | undefined;
    if (!row) return undefined;
    if (row.request_digest !== digest) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    return JSON.parse(row.response_json) as ExecutionPlanProjection;
  }

  public append(input: {
    plan?: ExecutionPlanProjection;
    rootTaskId: string;
    rootTaskRevision: number;
    roomId: string;
    ownerMemberId: string;
    definition: ExecutionPlanDefinition;
    definitionDigest: string;
    author: ExecutionPlanRevision["author"];
    snapshots: ExecutionSourceSnapshot[];
    operationId: string;
    operationDigest: string;
    now: string;
  }): ExecutionPlanProjection {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const planId = input.plan?.planId ?? createOpaqueId("plan");
    const revision = (input.plan?.current.revision ?? 0) + 1;
    const decisionId = createOpaqueId("decision");
    const proposalId = createOpaqueId("proposal");
    const authorJson = canonicalExecutionJSON(input.author);
    if (!input.plan) {
      this.database.prepare(`
        INSERT INTO execution_plans (
          plan_id, root_task_id, room_id, owner_member_id, current_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run(planId, input.rootTaskId, input.roomId, input.ownerMemberId, input.now, input.now);
    }
    this.database.prepare(`
      INSERT INTO execution_decisions (
        decision_id, root_task_id, room_id, content_json, author_json,
        supersedes_decision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(decisionId, input.rootTaskId, input.roomId,
      canonicalExecutionJSON(input.definition.decision), authorJson,
      input.plan?.current.decisionId ?? null, input.now);
    for (const source of input.snapshots) {
      this.database.prepare(`
        INSERT INTO execution_decision_sources (
          decision_id, evidence_ref_id, source_json, source_revision, snapshot_json, snapshot_digest
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(decisionId, source.source.evidenceRefId, canonicalExecutionJSON(source.source),
        source.revision, source.snapshotJson, source.digest);
    }
    this.database.prepare(`
      INSERT INTO execution_plan_proposals (
        proposal_id, plan_id, revision, root_task_id, room_id, root_task_revision,
        decision_id, definition_json, digest, author_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(proposalId, planId, revision, input.rootTaskId, input.roomId, input.rootTaskRevision,
      decisionId, canonicalExecutionJSON(input.definition), input.definitionDigest, authorJson, input.now);
    this.database.prepare(`
      INSERT INTO execution_plan_revisions (plan_id, revision, proposal_id) VALUES (?, ?, ?)
    `).run(planId, revision, proposalId);
    if (input.plan) {
      const changed = this.database.prepare(`
        UPDATE execution_plans SET current_revision = ?, updated_at = ?
        WHERE plan_id = ? AND current_revision = ? AND state = 'draft'
      `).run(revision, input.now, planId, revision - 1);
      if (changed.changes !== 1) throw new ExecutionError("EXECUTION_REVISION_CONFLICT", 409);
    }
    const result = this.get(planId)!;
    this.database.prepare(`
      INSERT INTO execution_plan_operations (
        operation_id, action, actor_key, root_task_id, plan_id,
        request_digest, response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.operationId, input.plan ? "revise" : "create", authorJson,
      input.rootTaskId, planId, input.operationDigest, canonicalExecutionJSON(result), input.now);
    return result;
  }

  public supersessionCandidate(
    planId: string
  ): ExecutionPlanSupersessionCandidate | undefined {
    const row = this.database.prepare(`
      SELECT response_json FROM execution_plan_supersession_candidates
      WHERE plan_id = ? AND candidate_revision = (
        SELECT current_revision + 1 FROM execution_plans WHERE plan_id = ?
      )
    `).get(planId, planId) as { response_json: string } | undefined;
    if (!row) return undefined;
    const candidate = JSON.parse(row.response_json) as
      ExecutionPlanSupersessionCandidate;
    assertExecutionCommand("supersessionCandidateRecord", candidate);
    return candidate;
  }

  public supersessionCandidateById(
    candidateId: string
  ): ExecutionPlanSupersessionCandidate | undefined {
    const row = this.database.prepare(`
      SELECT response_json FROM execution_plan_supersession_candidates
      WHERE candidate_id = ?
    `).get(candidateId) as { response_json: string } | undefined;
    if (!row) return undefined;
    const candidate = JSON.parse(row.response_json) as
      ExecutionPlanSupersessionCandidate;
    assertExecutionCommand("supersessionCandidateRecord", candidate);
    return candidate;
  }

  public replaySupersessionCandidate(
    operationId: string,
    requestDigest: string
  ): ExecutionPlanSupersessionCandidate | undefined {
    if (this.database.prepare(`
      SELECT 1 FROM execution_plan_operations WHERE operation_id = ?
      UNION ALL SELECT 1 FROM execution_plan_approvals WHERE operation_id = ?
      UNION ALL SELECT 1 FROM execution_plan_supersession_activations
        WHERE operation_id = ?
      UNION ALL SELECT 1 FROM execution_replan_delegations WHERE operation_id = ?
      UNION ALL SELECT 1 FROM execution_replan_delegation_revocations
        WHERE operation_id = ? LIMIT 1
    `).get(operationId, operationId, operationId, operationId, operationId)) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    const row = this.database.prepare(`
      SELECT request_digest, response_json
      FROM execution_plan_supersession_candidates WHERE operation_id = ?
    `).get(operationId) as {
      request_digest: string;
      response_json: string;
    } | undefined;
    if (!row) return undefined;
    if (row.request_digest !== requestDigest) {
      throw new ExecutionError("EXECUTION_OPERATION_CONFLICT", 409);
    }
    const candidate = JSON.parse(row.response_json) as
      ExecutionPlanSupersessionCandidate;
    assertExecutionCommand("supersessionCandidateRecord", candidate);
    return candidate;
  }

  public appendSupersessionCandidate(input: {
    plan: ExecutionPlanProjection;
    rootTaskRevision: number;
    definition: ExecutionPlanDefinition;
    definitionDigest: string;
    author: ExecutionPlanRevision["author"];
    snapshots: ExecutionSourceSnapshot[];
    operationId: string;
    requestDigest: string;
    reason: string;
    now: string;
  }): ExecutionPlanSupersessionCandidate {
    if (!this.database.inTransaction) {
      throw new ExecutionError("EXECUTION_TRANSACTION_REQUIRED");
    }
    const candidateRevision = input.plan.current.revision + 1;
    const decisionId = createOpaqueId("decision");
    const proposalId = createOpaqueId("proposal");
    const candidateId = createOpaqueId("supersession");
    const authorJson = canonicalExecutionJSON(input.author);
    this.database.prepare(`
      INSERT INTO execution_decisions (
        decision_id, root_task_id, room_id, content_json, author_json,
        supersedes_decision_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      input.plan.rootTaskId,
      input.plan.roomId,
      canonicalExecutionJSON(input.definition.decision),
      authorJson,
      input.plan.current.decisionId,
      input.now
    );
    for (const source of input.snapshots) {
      this.database.prepare(`
        INSERT INTO execution_decision_sources (
          decision_id, evidence_ref_id, source_json, source_revision,
          snapshot_json, snapshot_digest
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        decisionId,
        source.source.evidenceRefId,
        canonicalExecutionJSON(source.source),
        source.revision,
        source.snapshotJson,
        source.digest
      );
    }
    this.database.prepare(`
      INSERT INTO execution_plan_proposals (
        proposal_id, plan_id, revision, root_task_id, room_id,
        root_task_revision, decision_id, definition_json, digest,
        author_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposalId,
      input.plan.planId,
      candidateRevision,
      input.plan.rootTaskId,
      input.plan.roomId,
      input.rootTaskRevision,
      decisionId,
      canonicalExecutionJSON(input.definition),
      input.definitionDigest,
      authorJson,
      input.now
    );
    this.database.prepare(`
      INSERT INTO execution_plan_revisions (plan_id, revision, proposal_id)
      VALUES (?, ?, ?)
    `).run(input.plan.planId, candidateRevision, proposalId);
    const candidate: ExecutionPlanSupersessionCandidate = {
      candidateId,
      operationId: input.operationId,
      planId: input.plan.planId,
      baseRevision: input.plan.current.revision,
      baseDigest: input.plan.current.digest,
      baseControlRevision: input.plan.controlRevision,
      rootTaskRevision: input.rootTaskRevision,
      candidateRevision,
      candidateDigest: input.definitionDigest,
      definition: structuredClone(input.definition),
      author: structuredClone(input.author),
      reason: input.reason,
      requestDigest: input.requestDigest,
      createdAt: input.now
    } as ExecutionPlanSupersessionCandidate;
    assertExecutionCommand("supersessionCandidateRecord", candidate);
    this.database.prepare(`
      INSERT INTO execution_plan_supersession_candidates (
        candidate_id, operation_id, plan_id, base_revision, base_digest,
        base_control_revision, root_task_revision, candidate_revision,
        candidate_digest, proposal_id, author_json, reason, request_digest,
        response_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      candidate.candidateId,
      candidate.operationId,
      candidate.planId,
      candidate.baseRevision,
      candidate.baseDigest,
      candidate.baseControlRevision,
      candidate.rootTaskRevision,
      candidate.candidateRevision,
      candidate.candidateDigest,
      proposalId,
      authorJson,
      candidate.reason,
      candidate.requestDigest,
      canonicalExecutionJSON(candidate),
      candidate.createdAt
    );
    return candidate;
  }
}
