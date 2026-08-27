import type { ResultProjection, ResultProposal } from
  "@agent-room/contracts/task-result";

import type { CoreRepository } from "../data/core-repository.js";
import type { RunRepository } from "../run/run-repository.js";
import type { McpPrincipal } from "../security/auth-service.js";
import type { ResultRepository } from "../task/result-repository.js";
import type { ResultService } from "../task/result-service.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "../task/task-repository.js";

export class ManualTaskWorkService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly tasks: AgentTaskRepository,
    private readonly runs: RunRepository,
    private readonly results: ResultRepository,
    private readonly resultService: ResultService
  ) {}

  public listAssigned(
    principal: McpPrincipal,
    limit = 50
  ): AgentTaskRecord[] {
    this.requireManualAgent(principal);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Assigned Task limit must be between 1 and 100");
    }
    const runTaskIds = new Set(
      this.runs.listAgentRuns(principal.agentId).map(({ taskId }) => taskId)
    );
    const accessibleRooms = this.core.listRoomsForMember(
      principal.teamId,
      principal.memberId
    ).filter(({ roomId }) => this.core.isRoomAgent(roomId, principal.agentId));
    return accessibleRooms
      .flatMap(({ roomId }) => this.tasks.listForRoom(roomId))
      .filter((task) => this.hasTaskAccess(task, principal.agentId, runTaskIds))
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.taskId.localeCompare(right.taskId)
      )
      .slice(0, limit);
  }

  public get(principal: McpPrincipal, taskId: string): AgentTaskRecord {
    this.requireManualAgent(principal);
    const task = this.tasks.get(taskId);
    if (!task || !this.hasCurrentRoomAccess(principal, task) ||
      !this.hasTaskAccess(task, principal.agentId, new Set(
        this.runs.listAgentRuns(principal.agentId).map(({ taskId: id }) => id)
      ))) {
      throw new Error("Manual Agent Task access denied");
    }
    return task;
  }

  public listResults(
    principal: McpPrincipal,
    taskId: string
  ): ResultProjection[] {
    this.get(principal, taskId);
    return this.results.listForTask(taskId);
  }

  public proposeResult(
    principal: McpPrincipal,
    runId: string,
    proposal: ResultProposal,
    now: string
  ): ResultProjection {
    this.get(principal, proposal.taskId);
    return this.resultService.proposeManualAgent(principal, {
      runId,
      proposal
    }, now);
  }

  private requireManualAgent(principal: McpPrincipal): void {
    const agent = this.core.getAgent(principal.agentId);
    if (!agent || !agent.enabled || agent.integrationMode !== "manual" ||
      agent.teamId !== principal.teamId ||
      agent.ownerMemberId !== principal.memberId) {
      throw new Error("Authenticated manual Agent is unavailable");
    }
  }

  private hasCurrentRoomAccess(
    principal: McpPrincipal,
    task: AgentTaskRecord
  ): boolean {
    return task.teamId === principal.teamId &&
      this.core.isRoomAgent(task.roomId, principal.agentId) &&
      this.core.listRoomsForMember(principal.teamId, principal.memberId)
        .some(({ roomId }) => roomId === task.roomId);
  }

  private hasTaskAccess(
    task: AgentTaskRecord,
    agentId: string,
    runTaskIds: ReadonlySet<string>
  ): boolean {
    return task.isDefault || runTaskIds.has(task.taskId) ||
      task.assignments.some((assignment) => assignment.agentId === agentId);
  }
}
