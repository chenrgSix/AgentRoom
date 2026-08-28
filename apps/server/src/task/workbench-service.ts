import { createHash } from "node:crypto";

import type {
  AttentionElement,
  Item as WorkbenchItem,
  WorkbenchPage,
  WorkbenchQuery
} from "@convene-wire/contracts/task-result";

import type { CoreRepository } from "../data/core-repository.js";
import type { RunRecord, RunRepository } from "../run/run-repository.js";
import type {
  AuthService,
  WebPrincipal
} from "../security/auth-service.js";
import type { ResultRepository } from "./result-repository.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "./task-repository.js";

interface WorkbenchCursor {
  teamId: string;
  filterFingerprint: string;
  updatedAt: string;
  taskId: string;
}

const attentionValues = new Set<AttentionElement>([
  "needs_input",
  "outcome_unknown",
  "needs_approval",
  "result_stale",
  "blocked",
  "overdue",
  "paused",
  "budget_exhausted",
  "runtime_unavailable",
  "result_rejected"
]);
const lifecycleValues = new Set([
  "draft", "ready", "active", "review", "completed", "canceled"
] as const);
const priorityValues = new Set(["low", "normal", "high", "urgent"] as const);
const utcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function validateTimestamp(value: string | null | undefined, label: string): void {
  if (value === undefined || value === null) return;
  if (!utcTimestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a UTC timestamp`);
  }
}

function maximumTimestamp(values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1)!;
}

function latestRun(runs: RunRecord[]): RunRecord | undefined {
  return runs.toSorted((left, right) =>
    right.createdAt.localeCompare(left.createdAt) ||
    right.runId.localeCompare(left.runId)
  )[0];
}

function filterFingerprint(query: WorkbenchQuery): string {
  const normalized = {
    scope: query.scope,
    attention: query.attention.toSorted(),
    lifecycleState: query.lifecycleState.toSorted(),
    priority: (query.priority ?? []).toSorted(),
    ownerMemberId: query.ownerMemberId ?? null,
    roomId: query.roomId ?? null,
    agentId: query.agentId ?? null,
    updatedAfter: query.updatedAfter ?? null,
    updatedBefore: query.updatedBefore ?? null
  };
  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("base64url")
    .slice(0, 24);
}

function encodeCursor(cursor: WorkbenchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string): WorkbenchCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Partial<WorkbenchCursor>;
    if (
      typeof parsed.teamId !== "string" ||
      typeof parsed.filterFingerprint !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.taskId !== "string"
    ) {
      throw new Error("invalid shape");
    }
    validateTimestamp(parsed.updatedAt, "Workbench cursor timestamp");
    return parsed as WorkbenchCursor;
  } catch {
    throw new Error("Workbench cursor is invalid");
  }
}

export class WorkbenchService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly runs: RunRepository,
    private readonly results: ResultRepository,
    private readonly auth: AuthService
  ) {}

  public list(
    principal: WebPrincipal,
    teamId: string,
    query: WorkbenchQuery
  ): WorkbenchPage {
    const member = this.auth.requireTeamMember(principal, teamId);
    this.validateQuery(query);
    const fingerprint = filterFingerprint(query);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (cursor && (
      cursor.teamId !== teamId || cursor.filterFingerprint !== fingerprint
    )) {
      throw new Error("Workbench cursor does not match this Team and filter");
    }

    const accessibleRooms = this.core.listRoomsForMember(teamId, member.memberId);
    const roomIds = new Set(accessibleRooms.map(({ roomId }) => roomId));
    if (query.roomId && !roomIds.has(query.roomId)) return {
      items: [],
      nextCursor: null
    };
    const ownedAgentIds = new Set(
      this.core.listAgents(teamId)
        .filter(({ ownerMemberId }) => ownerMemberId === member.memberId)
        .map(({ agentId }) => agentId)
    );

    const items = accessibleRooms.flatMap(({ roomId }) => {
      const roomRuns = this.runs.listRoomRuns(roomId);
      const runsByTask = new Map<string, RunRecord[]>();
      for (const run of roomRuns) {
        const taskRuns = runsByTask.get(run.taskId) ?? [];
        taskRuns.push(run);
        runsByTask.set(run.taskId, taskRuns);
      }
      return this.tasks.listForRoom(roomId).map((task) =>
        this.project(task, runsByTask.get(task.taskId) ?? [])
      );
    }).filter((item) => {
      const task = this.tasks.get(item.taskId)!;
      if (query.scope === "mine" &&
        task.ownerMemberId !== member.memberId &&
        !task.assignments.some(({ agentId }) => ownedAgentIds.has(agentId))) {
        return false;
      }
      if (query.attention.length > 0 && !query.attention.some((reason) =>
        item.attentionReasons.some((attention) => attention.reason === reason)
      )) return false;
      if (query.lifecycleState.length > 0 &&
        !query.lifecycleState.includes(item.lifecycleState)) return false;
      if ((query.priority?.length ?? 0) > 0 &&
        !query.priority!.includes(item.priority)) return false;
      if (query.ownerMemberId && item.ownerMemberId !== query.ownerMemberId) {
        return false;
      }
      if (query.roomId && item.roomId !== query.roomId) return false;
      if (query.agentId &&
        !task.assignments.some(({ agentId }) => agentId === query.agentId)) {
        return false;
      }
      if (query.updatedAfter && item.updatedAt < query.updatedAfter) return false;
      if (query.updatedBefore && item.updatedAt > query.updatedBefore) return false;
      if (cursor && !(
        item.updatedAt < cursor.updatedAt ||
        (item.updatedAt === cursor.updatedAt && item.taskId > cursor.taskId)
      )) return false;
      return true;
    }).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.taskId.localeCompare(right.taskId)
    );

    const page = items.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: items.length > query.limit && last
        ? encodeCursor({
            teamId,
            filterFingerprint: fingerprint,
            updatedAt: last.updatedAt,
            taskId: last.taskId
          })
        : null
    };
  }

  private validateQuery(query: WorkbenchQuery): void {
    if (query.scope !== "mine" && query.scope !== "team") {
      throw new Error("Workbench scope is invalid");
    }
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new Error("Workbench limit must be between 1 and 100");
    }
    if (query.attention.length > 10 ||
      query.attention.some((value) => !attentionValues.has(value))) {
      throw new Error("Workbench attention filter is invalid");
    }
    if (query.lifecycleState.length > 6 ||
      query.lifecycleState.some((value) => !lifecycleValues.has(value))) {
      throw new Error("Workbench lifecycle filter is invalid");
    }
    if ((query.priority?.length ?? 0) > 4 ||
      query.priority?.some((value) => !priorityValues.has(value))) {
      throw new Error("Workbench priority filter is invalid");
    }
    validateTimestamp(query.updatedAfter, "updatedAfter");
    validateTimestamp(query.updatedBefore, "updatedBefore");
    if (query.updatedAfter && query.updatedBefore &&
      query.updatedAfter > query.updatedBefore) {
      throw new Error("updatedAfter must not be later than updatedBefore");
    }
  }

  private project(task: AgentTaskRecord, taskRuns: RunRecord[]): WorkbenchItem {
    const run = latestRun(taskRuns);
    const result = this.results.listForTask(task.taskId)[0];
    const current = result
      ? result.proposal.definitionRevision === task.definitionRevision &&
        result.proposal.criteriaRevision === task.criteriaRevision
      : null;
    const artifactEvidence = new Set(
      result?.proposal.sources
        .filter(({ kind }) => kind === "artifact")
        .map(({ evidenceRefId }) => evidenceRefId) ?? []
    );
    const satisfiedCriteria = current
      ? new Set(result!.proposal.criterionClaims.filter((claim) =>
          claim.coverage === "satisfied" &&
          claim.evidenceRefIds.some((evidenceRefId) =>
            artifactEvidence.has(evidenceRefId)
          )
        ).map(({ criterionKey }) => criterionKey))
      : new Set<string>();
    const requiredCriteria = task.criteria.filter(({ required }) => required);
    return {
      taskId: task.taskId,
      taskDisplayNumber: task.taskDisplayNumber,
      roomId: task.roomId,
      title: task.title,
      ownerMemberId: task.ownerMemberId,
      lifecycleState: task.lifecycleState,
      schedulingState: task.schedulingState,
      priority: task.priority,
      attentionReasons: task.attentionReasons,
      primaryAttention: task.attentionReasons[0]?.reason ?? null,
      latestRun: run ? {
        runId: run.runId,
        taskId: run.taskId,
        agentId: run.targetAgentId,
        state: run.state,
        phase: "unknown",
        attemptNumber: run.attemptNumber ?? 1,
        retryOfRunId: run.retryOfRunId ?? null,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      } : null,
      latestResultId: result?.resultId ?? null,
      latestResultCurrent: current,
      requiredCriteriaSatisfied: requiredCriteria.filter(({ criterionKey }) =>
        satisfiedCriteria.has(criterionKey)
      ).length,
      requiredCriteriaTotal: requiredCriteria.length,
      budgetUsage: task.budgetUsage,
      nextAction: task.nextAction,
      updatedAt: maximumTimestamp([
        task.updatedAt,
        run?.updatedAt,
        result?.proposedAt,
        result?.review?.reviewedAt
      ])
    };
  }
}
