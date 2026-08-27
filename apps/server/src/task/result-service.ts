import type Database from "better-sqlite3";

import type {
  ResultProjection,
  ResultProposal,
  ResultReviewCommand
} from "@agent-room/contracts/task-result";

import type { CoreRepository } from "../data/core-repository.js";
import type { RunRepository } from "../run/run-repository.js";
import type {
  AuthService,
  WebPrincipal
} from "../security/auth-service.js";
import type { AgentTaskService } from "./agent-task-service.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "./task-repository.js";
import {
  type ResultActor,
  type ResultReviewOutcome,
  ResultRepository
} from "./result-repository.js";

const operationPattern = /^op_[A-Za-z0-9_-]{8,128}$/u;
const resultPattern = /^result_[A-Za-z0-9_-]{8,128}$/u;
const criterionPattern = /^criterion_[A-Za-z0-9_-]{8,64}$/u;
const evidencePattern = /^evidence_[A-Za-z0-9_-]{8,64}$/u;
const nextActionPattern = /^next_[A-Za-z0-9_-]{8,64}$/u;
const outcomeValues = new Set<ResultProposal["outcome"]>([
  "satisfied", "partial", "not_satisfied", "informational"
]);
const coverageValues = new Set<
  ResultProposal["criterionClaims"][number]["coverage"]
>(["satisfied", "unresolved", "not_satisfied", "not_applicable"]);
const sourceKinds = new Set<ResultProposal["sources"][number]["kind"]>([
  "artifact", "run_event", "message", "memory", "discussion"
]);

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || value.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
}

function positiveRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${extras.join(", ")}`);
  }
}

function boundedList(
  values: string[],
  label: string,
  maximumItems: number,
  maximumLength: number
): string[] {
  if (!Array.isArray(values) || values.length > maximumItems) {
    throw new Error(`${label} must contain at most ${maximumItems} entries`);
  }
  return values.map((value, index) =>
    boundedText(value, `${label}[${index}]`, maximumLength)
  );
}

export class ResultService {
  public constructor(
    private readonly database: Database.Database,
    private readonly results: ResultRepository,
    private readonly tasks: AgentTaskService,
    private readonly taskRepository: AgentTaskRepository,
    private readonly runs: RunRepository,
    private readonly core: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public get(principal: WebPrincipal, resultId: string): ResultProjection {
    const result = this.requireResult(resultId);
    this.auth.requireRoomMember(principal, result.roomId);
    return result;
  }

  public list(
    principal: WebPrincipal,
    taskId: string
  ): ResultProjection[] {
    const task = this.requireTask(taskId);
    this.auth.requireRoomMember(principal, task.roomId);
    return this.results.listForTask(taskId);
  }

  public proposeMember(
    principal: WebPrincipal,
    proposal: ResultProposal,
    now: string
  ): ResultProjection {
    const task = this.requireTask(proposal.taskId);
    const member = this.auth.requireRoomMember(principal, task.roomId);
    if (member.role !== "owner" && member.memberId !== task.ownerMemberId) {
      throw new Error("Only the Task Owner or Team Owner may propose a Result");
    }
    return this.create(task, this.validateProposal(proposal), {
      kind: "member",
      memberId: member.memberId
    }, now);
  }

  public proposeAgent(
    input: {
      teamId: string;
      agentId: string;
      runId: string;
      actorKind: "manual_agent" | "managed_agent";
      proposal: ResultProposal;
    },
    now: string
  ): ResultProjection {
    const proposal = this.validateProposal(input.proposal);
    const task = this.requireTask(proposal.taskId);
    const agent = this.core.getAgent(input.agentId);
    const run = this.runs.getRun(input.runId);
    const expectedMode = input.actorKind === "manual_agent" ? "manual" : "managed";
    if (!agent || !agent.enabled || agent.teamId !== input.teamId ||
      agent.integrationMode !== expectedMode || task.teamId !== input.teamId) {
      throw new Error("Result Agent identity is unavailable");
    }
    if (!run || run.taskId !== task.taskId || run.roomId !== task.roomId ||
      run.targetAgentId !== input.agentId) {
      throw new Error("Result Agent Run is outside the Task scope");
    }
    const assigned = task.isDefault
      ? this.core.isRoomAgent(task.roomId, input.agentId)
      : task.assignments.some(({ agentId }) => agentId === input.agentId);
    if (!assigned) throw new Error("Result Agent is not assigned to the Task");
    const runEvents = proposal.sources.filter((source) =>
      source.kind === "run_event"
    );
    if (runEvents.length === 0 || runEvents.some((source) =>
      source.runId !== input.runId
    )) {
      throw new Error("Agent Result must cite its own persisted Run event");
    }
    return this.create(task, proposal, {
      kind: input.actorKind,
      agentId: input.agentId,
      runId: input.runId
    }, now);
  }

  public proposeOrchestrator(
    discussionId: string,
    proposal: ResultProposal,
    now: string
  ): ResultProjection {
    const normalized = this.validateProposal(proposal);
    const task = this.requireTask(normalized.taskId);
    const discussion = this.database.prepare(`
      SELECT task_id, room_id FROM discussions WHERE discussion_id = ?
    `).get(discussionId) as
      | { task_id: string; room_id: string }
      | undefined;
    if (!discussion || discussion.task_id !== task.taskId ||
      discussion.room_id !== task.roomId || !normalized.sources.some((source) =>
        source.kind === "discussion" && source.discussionId === discussionId
      )) {
      throw new Error("Orchestrator Result must cite its own Task Discussion");
    }
    return this.create(task, normalized, {
      kind: "orchestrator",
      discussionId
    }, now);
  }

  public review(
    principal: WebPrincipal,
    resultId: string,
    command: ResultReviewCommand,
    now: string
  ): ResultReviewOutcome {
    const result = this.requireResult(resultId);
    const task = this.requireTask(result.taskId);
    const member = this.auth.requireRoomMember(principal, task.roomId);
    if (member.role !== "owner" && member.memberId !== task.ownerMemberId) {
      throw new Error("Only the Task Owner or Team Owner may review a Result");
    }
    const normalized = this.validateReview(command);
    return this.results.review({
      resultId,
      memberId: member.memberId,
      command: normalized,
      now
    });
  }

  public createChildTask(
    principal: WebPrincipal,
    resultId: string,
    input: {
      operationId: string;
      nextActionKey: string;
      title: string;
      ownerMemberId: string;
    },
    now: string
  ): AgentTaskRecord {
    const result = this.requireResult(resultId);
    const task = this.requireTask(result.taskId);
    const member = this.auth.requireRoomMember(principal, task.roomId);
    if (member.role !== "owner" && member.memberId !== task.ownerMemberId) {
      throw new Error("Only the Task Owner or Team Owner may create follow-up work");
    }
    const operationId = boundedText(input.operationId, "Operation ID", 140);
    if (!operationPattern.test(operationId)) throw new Error("Operation ID is invalid");
    const nextActionKey = boundedText(input.nextActionKey, "Next action key", 80);
    if (!nextActionPattern.test(nextActionKey)) {
      throw new Error("Next action key is invalid");
    }
    const title = boundedText(input.title, "Task title", 160);
    const childTaskId = this.results.createChildSource({
      resultId,
      nextActionKey,
      operationId,
      memberId: member.memberId,
      now,
      createChild: (description, parentTaskId) => this.tasks.create(principal, {
        roomId: task.roomId,
        parentTaskId,
        title,
        goal: description,
        ownerMemberId: input.ownerMemberId,
        lifecycleState: "draft"
      }, now).taskId
    });
    return this.tasks.get(principal, childTaskId);
  }

  private create(
    task: AgentTaskRecord,
    proposal: ResultProposal,
    actor: ResultActor,
    now: string
  ): ResultProjection {
    return this.results.create({
      roomId: task.roomId,
      proposal,
      actor,
      now
    });
  }

  private validateProposal(proposal: ResultProposal): ResultProposal {
    assertKeys(proposal as unknown as Record<string, unknown>, [
      "operationId", "taskId", "definitionRevision", "criteriaRevision",
      "proposedAtTaskRevision", "supersedesResultId", "outcome", "summary",
      "risks", "openQuestions", "nextActions", "sources", "criterionClaims"
    ], "Result proposal");
    const operationId = boundedText(proposal.operationId, "Operation ID", 140);
    if (!operationPattern.test(operationId)) throw new Error("Operation ID is invalid");
    if (!outcomeValues.has(proposal.outcome)) throw new Error("Result outcome is invalid");
    const supersedesResultId = proposal.supersedesResultId === null
      ? null
      : boundedText(proposal.supersedesResultId, "Superseded Result ID", 140);
    if (supersedesResultId && !resultPattern.test(supersedesResultId)) {
      throw new Error("Superseded Result ID is invalid");
    }
    if (!Array.isArray(proposal.sources) || proposal.sources.length < 1 ||
      proposal.sources.length > 100) {
      throw new Error("Result sources must contain 1 to 100 entries");
    }
    const evidenceIds = new Set<string>();
    const sources = proposal.sources.map((source, index) => {
      if (!source || typeof source !== "object") {
        throw new Error(`Result source ${index} is invalid`);
      }
      if (!sourceKinds.has(source.kind)) throw new Error("Evidence kind is invalid");
      const allowed = source.kind === "artifact"
        ? ["evidenceRefId", "kind", "artifactId"]
        : source.kind === "run_event"
          ? ["evidenceRefId", "kind", "runId", "sequence"]
          : source.kind === "message"
            ? ["evidenceRefId", "kind", "messageId"]
            : source.kind === "memory"
              ? ["evidenceRefId", "kind", "memoryId"]
              : ["evidenceRefId", "kind", "discussionId"];
      assertKeys(source as unknown as Record<string, unknown>, allowed, `source[${index}]`);
      const evidenceRefId = boundedText(
        source.evidenceRefId,
        `source[${index}].evidenceRefId`,
        80
      );
      if (!evidencePattern.test(evidenceRefId) || evidenceIds.has(evidenceRefId)) {
        throw new Error("Evidence reference IDs must be valid and unique");
      }
      evidenceIds.add(evidenceRefId);
      if (source.kind === "run_event" &&
        (!Number.isSafeInteger(source.sequence) || (source.sequence ?? 0) < 1)) {
        throw new Error("Run event evidence sequence must be positive");
      }
      return { ...source, evidenceRefId };
    }) as ResultProposal["sources"];
    if (!Array.isArray(proposal.nextActions) || proposal.nextActions.length > 50) {
      throw new Error("Result next actions must contain at most 50 entries");
    }
    const nextActionKeys = new Set<string>();
    const nextActions = proposal.nextActions.map((action, index) => {
      assertKeys(action as unknown as Record<string, unknown>, [
        "nextActionKey", "description"
      ], `nextActions[${index}]`);
      const key = boundedText(action.nextActionKey, "Next action key", 80);
      if (!nextActionPattern.test(key) || nextActionKeys.has(key)) {
        throw new Error("Next action keys must be valid and unique");
      }
      nextActionKeys.add(key);
      return {
        nextActionKey: key,
        description: boundedText(action.description, "Next action", 2_000)
      };
    });
    if (!Array.isArray(proposal.criterionClaims) ||
      proposal.criterionClaims.length > 100) {
      throw new Error("Criterion claims must contain at most 100 entries");
    }
    const criterionKeys = new Set<string>();
    const criterionClaims = proposal.criterionClaims.map((claim, index) => {
      assertKeys(claim as unknown as Record<string, unknown>, [
        "criterionKey", "coverage", "explanation", "evidenceRefIds"
      ], `criterionClaims[${index}]`);
      const criterionKey = boundedText(claim.criterionKey, "Criterion key", 80);
      if (!criterionPattern.test(criterionKey) || criterionKeys.has(criterionKey)) {
        throw new Error("Criterion claim keys must be valid and unique");
      }
      criterionKeys.add(criterionKey);
      if (!coverageValues.has(claim.coverage)) {
        throw new Error("Criterion coverage is invalid");
      }
      if (!Array.isArray(claim.evidenceRefIds) ||
        claim.evidenceRefIds.length > 100 ||
        new Set(claim.evidenceRefIds).size !== claim.evidenceRefIds.length ||
        claim.evidenceRefIds.some((id) => !evidenceIds.has(id))) {
        throw new Error("Criterion claim evidence must reference proposal sources");
      }
      return {
        criterionKey,
        coverage: claim.coverage,
        explanation: boundedText(claim.explanation, "Claim explanation", 4_000),
        evidenceRefIds: [...claim.evidenceRefIds]
      };
    });
    return {
      operationId,
      taskId: boundedText(proposal.taskId, "Task ID", 140),
      definitionRevision: positiveRevision(
        proposal.definitionRevision,
        "Definition revision"
      ),
      criteriaRevision: positiveRevision(
        proposal.criteriaRevision,
        "Criteria revision"
      ),
      proposedAtTaskRevision: positiveRevision(
        proposal.proposedAtTaskRevision,
        "Proposed-at Task revision"
      ),
      supersedesResultId,
      outcome: proposal.outcome,
      summary: boundedText(proposal.summary, "Result summary", 20_000),
      risks: boundedList(proposal.risks, "risks", 50, 2_000),
      openQuestions: boundedList(
        proposal.openQuestions,
        "openQuestions",
        50,
        2_000
      ),
      nextActions,
      sources,
      criterionClaims
    };
  }

  private validateReview(command: ResultReviewCommand): ResultReviewCommand {
    assertKeys(command as unknown as Record<string, unknown>, [
      "operationId", "decision", "expectedTaskRevision",
      "expectedReviewRevision", "reason", "completeTask"
    ], "Result review");
    const operationId = boundedText(command.operationId, "Operation ID", 140);
    if (!operationPattern.test(operationId)) throw new Error("Operation ID is invalid");
    if (command.decision !== "accepted" && command.decision !== "rejected") {
      throw new Error("Review decision is invalid");
    }
    if (command.expectedReviewRevision !== 0) {
      throw new Error("Initial review revision must be zero");
    }
    if (typeof command.completeTask !== "boolean") {
      throw new Error("completeTask must be boolean");
    }
    return {
      operationId,
      decision: command.decision,
      expectedTaskRevision: positiveRevision(
        command.expectedTaskRevision,
        "Expected Task revision"
      ),
      expectedReviewRevision: 0,
      reason: boundedText(command.reason, "Review reason", 4_000),
      completeTask: command.completeTask
    };
  }

  private requireTask(taskId: string): AgentTaskRecord {
    const task = this.taskRepository.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  private requireResult(resultId: string): ResultProjection {
    const result = this.results.get(resultId);
    if (!result) throw new Error(`Result not found: ${resultId}`);
    return result;
  }
}
