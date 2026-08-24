import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { McpPrincipal } from "../security/auth-service.js";
import type { RunRecord, RunRepository } from "./run-repository.js";

const maximumHandoffDepth = 4;
const maximumUniqueAgents = 5;

export class HandoffService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository
  ) {}

  public create(
    principal: McpPrincipal,
    input: { parentRunId: string; targetAgentId: string; instruction: string },
    now: string
  ): RunRecord {
    const instruction = input.instruction.trim();
    if (instruction.length === 0 || instruction.length > 20_000) {
      throw new Error("Handoff instruction must contain 1 to 20000 characters");
    }
    const parent = this.runs.getRun(input.parentRunId);
    const target = this.core.getAgent(input.targetAgentId);
    const room = parent && this.core.getRoom(parent.roomId);
    if (
      !parent ||
      !target ||
      !room ||
      parent.targetAgentId !== principal.agentId ||
      room.teamId !== principal.teamId ||
      target.teamId !== principal.teamId ||
      !target.enabled ||
      !this.core.isRoomAgent(parent.roomId, target.agentId)
    ) {
      throw new Error("Handoff identity or target mismatch");
    }

    const lineageAgents = new Set<string>();
    let current: RunRecord | undefined = parent;
    let depth = 0;
    while (current) {
      lineageAgents.add(current.targetAgentId);
      if (!current.parentRunId) break;
      depth++;
      current = this.runs.getRun(current.parentRunId);
      if (!current) {
        throw new Error("Handoff lineage is incomplete");
      }
    }
    if (depth >= maximumHandoffDepth) {
      throw new Error(`Handoff depth cannot exceed ${maximumHandoffDepth}`);
    }
    if (lineageAgents.has(target.agentId)) {
      throw new Error("Handoff cannot revisit an Agent in its lineage");
    }
    lineageAgents.add(target.agentId);
    if (lineageAgents.size > maximumUniqueAgents) {
      throw new Error(`Handoff cannot exceed ${maximumUniqueAgents} unique Agents`);
    }
    const deadlineAt = Date.parse(parent.deadlineAt) <= Date.parse(now)
      ? now
      : parent.deadlineAt;
    return this.runs.createRuns([{
      runId: createOpaqueId("run"),
      traceId: parent.traceId,
      roomId: parent.roomId,
      triggerMessageId: parent.triggerMessageId,
      requesterMemberId: parent.requesterMemberId,
      targetAgentId: target.agentId,
      parentRunId: parent.runId,
      instruction,
      state: "queued",
      lastSequence: 0,
      deadlineAt,
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    }])[0] as RunRecord;
  }
}
