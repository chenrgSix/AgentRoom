import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { McpPrincipal } from "../security/auth-service.js";
import { resolveExactAgentMentions } from "../team-room/exact-agent-mentions.js";
import type { RunRecord, RunRepository } from "./run-repository.js";

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
    if (!room.collaborationPolicy.allowAgentMentions) {
      throw new Error("Room policy does not allow Agent handoffs");
    }

    return this.createChild(parent, target.agentId, instruction, now);
  }

  public createFromReply(
    parentRunId: string,
    content: string,
    now: string
  ): RunRecord[] {
    const parent = this.runs.getRun(parentRunId);
    const room = parent && this.core.getRoom(parent.roomId);
    if (!parent || !room || !room.collaborationPolicy.allowAgentMentions) {
      return [];
    }
    const agents = this.core.listAgents(room.teamId).filter((agent) =>
      agent.enabled &&
      agent.agentId !== parent.targetAgentId &&
      this.core.isRoomAgent(room.roomId, agent.agentId)
    );
    const resolution = resolveExactAgentMentions(content, agents);
    const created: RunRecord[] = [];
    for (const targetAgentId of resolution.agentIds.slice(0, maximumUniqueAgents)) {
      try {
        created.push(this.createChild(parent, targetAgentId, content, now));
      } catch {
        // Exact Agent commands are best-effort at the bounded handoff boundary.
        // Invalid lineage, depth, or availability leaves the reply as plain text.
      }
    }
    return created;
  }

  private createChild(
    parent: RunRecord,
    targetAgentId: string,
    instruction: string,
    now: string
  ): RunRecord {
    const room = this.core.getRoom(parent.roomId);
    const target = this.core.getAgent(targetAgentId);
    if (
      !room ||
      !target ||
      !target.enabled ||
      target.teamId !== room.teamId ||
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
    if (depth >= room.collaborationPolicy.maxAgentMentionDepth) {
      throw new Error(
        `Handoff depth cannot exceed ${room.collaborationPolicy.maxAgentMentionDepth}`
      );
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
