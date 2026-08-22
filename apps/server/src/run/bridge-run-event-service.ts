import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import type { RuntimeStatus } from "../runtime/runtime-adapter.js";
import type {
  AppliedRunEvent,
  RunRecord,
  RunRepository
} from "./run-repository.js";

const bridgeStatuses = new Set<RuntimeStatus>([
  "working",
  "input_required",
  "completed",
  "failed",
  "canceled",
  "outcome_unknown"
]);

const terminalStatuses = new Set<RuntimeStatus>([
  "completed",
  "failed",
  "canceled",
  "outcome_unknown"
]);

export class BridgeRunEventService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository
  ) {}

  public applyStatus(
    principal: DevicePrincipal,
    input: {
      runId: string;
      agentId: string;
      sequence: number;
      status: RuntimeStatus;
      error?: { code: string; message: string; retryable: boolean };
    },
    now: string
  ): AppliedRunEvent {
    const run = this.requireOwnedRun(principal, input.runId, input.agentId);
    this.validateSequence(input.sequence);
    if (!bridgeStatuses.has(input.status)) {
      throw new Error(`Bridge cannot emit Run status: ${input.status}`);
    }
    if (input.error) {
      if (
        input.error.code.trim().length === 0 ||
        input.error.code.length > 120 ||
        input.error.message.trim().length === 0 ||
        input.error.message.length > 2_000 ||
        typeof input.error.retryable !== "boolean"
      ) {
        throw new Error("Invalid Runtime error");
      }
    }
    const applied = this.runs.applyEvent(run.runId, {
      type: "status",
      sequence: input.sequence,
      status: input.status,
      ...(input.error ? { error: input.error } : {})
    }, now);
    if (applied.applied) {
      this.core.updateAgentPresence(
        run.targetAgentId,
        terminalStatuses.has(input.status) ? "ready" : "busy",
        now
      );
    }
    return applied;
  }

  public applyReply(
    principal: DevicePrincipal,
    input: {
      runId: string;
      agentId: string;
      sequence: number;
      content: string;
    },
    now: string
  ): AppliedRunEvent {
    const run = this.requireOwnedRun(principal, input.runId, input.agentId);
    this.validateSequence(input.sequence);
    if (input.content.trim().length === 0 || input.content.length > 20_000) {
      throw new Error("Runtime reply must contain 1 to 20000 characters");
    }
    const applied = this.runs.applyEvent(run.runId, {
      type: "reply",
      sequence: input.sequence,
      content: input.content
    }, now);
    if (applied.applied) {
      this.core.appendMessage({
        messageId: createOpaqueId("msg"),
        roomId: run.roomId,
        senderType: "agent",
        senderId: run.targetAgentId,
        content: input.content,
        mentions: [],
        parentMessageId: run.triggerMessageId,
        createdAt: now
      });
    }
    return applied;
  }

  private requireOwnedRun(
    principal: DevicePrincipal,
    runId: string,
    agentId: string
  ): RunRecord {
    const run = this.runs.getRun(runId);
    const agent = this.core.getAgent(agentId);
    if (
      !run ||
      !agent ||
      run.targetAgentId !== agentId ||
      agent.deviceId !== principal.deviceId ||
      agent.ownerMemberId !== principal.ownerMemberId ||
      agent.teamId !== principal.teamId
    ) {
      throw new Error("Run event identity mismatch");
    }
    return run;
  }

  private validateSequence(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 2) {
      throw new Error("Run event sequence must be an integer greater than 1");
    }
  }
}
