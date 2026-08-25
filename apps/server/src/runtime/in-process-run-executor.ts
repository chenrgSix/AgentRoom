import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import { redactSensitiveText } from "../security/redaction.js";
import type {
  RunRecord,
  RunRepository
} from "../run/run-repository.js";
import type {
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeRequest
} from "./runtime-adapter.js";

const terminalStates = new Set([
  "completed",
  "failed",
  "canceled",
  "expired",
  "outcome_unknown"
]);

export class InProcessRunExecutor {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly clock: () => string
  ) {}

  public async execute(
    runId: string,
    adapter: RuntimeAdapter
  ): Promise<RunRecord> {
    const initial = this.runs.getRun(runId);
    if (!initial) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (terminalStates.has(initial.state)) {
      return initial;
    }
    if (initial.state !== "queued" && initial.state !== "delivered") {
      throw new Error(`Run cannot be started from state: ${initial.state}`);
    }
    const agent = this.core.getAgent(initial.targetAgentId);
    const trigger = this.core.getMessage(initial.triggerMessageId);
    if (!agent || !agent.enabled || !trigger) {
      return this.finishUnknown(initial, "RUN_TARGET_UNAVAILABLE");
    }

    this.core.updateAgentPresence(agent.agentId, "busy", this.clock());
    const request: RuntimeRequest = {
      runId: initial.runId,
      agentId: agent.agentId,
      instruction: initial.instruction,
      contextMessages: this.core
        .listMessagesThrough(initial.roomId, trigger.sequence, 50)
        .map((message) => ({
          messageId: message.messageId,
          senderId: message.senderId,
          content: message.content
        }))
    };

    try {
      for await (const event of adapter.execute(request)) {
        const safeEvent = event.type === "reply" || event.type === "output"
          ? { ...event, content: redactSensitiveText(event.content) }
          : event;
        if (
          safeEvent.type === "output" &&
          (safeEvent.content.length === 0 || safeEvent.content.length > 20_000)
        ) {
          throw new Error("Runtime output delta must contain 1 to 20000 characters");
        }
        const applied = this.runs.applyEvent(runId, safeEvent, this.clock());
        if (applied.applied && safeEvent.type === "reply") {
          this.appendReply(applied.run, safeEvent);
        }
      }
      const completed = this.runs.getRun(runId);
      if (!completed || !terminalStates.has(completed.state)) {
        return this.finishUnknown(completed ?? initial, "RUNTIME_ENDED_EARLY");
      }
      this.core.updateAgentPresence(agent.agentId, "ready", this.clock());
      return completed;
    } catch (error) {
      const latest = this.runs.getRun(runId) ?? initial;
      if (terminalStates.has(latest.state)) {
        this.core.updateAgentPresence(agent.agentId, "ready", this.clock());
        return latest;
      }
      const code = error instanceof Error && error.message.includes("sequence")
        ? "RUNTIME_SEQUENCE_INVALID"
        : "RUNTIME_EXECUTION_FAILED";
      return this.finishUnknown(latest, code);
    }
  }

  private appendReply(run: RunRecord, event: Extract<RuntimeEvent, { type: "reply" }>): void {
    if (event.content.trim().length === 0 || event.content.length > 20_000) {
      throw new Error("Runtime reply must contain 1 to 20000 characters");
    }
    this.core.appendMessage({
      messageId: createOpaqueId("msg"),
      roomId: run.roomId,
      taskId: run.taskId,
      senderType: "agent",
      senderId: run.targetAgentId,
      content: event.content,
      mentions: [],
      parentMessageId: run.triggerMessageId,
      traceId: run.traceId,
      createdAt: this.clock()
    });
  }

  private finishUnknown(run: RunRecord, code: string): RunRecord {
    const result = this.runs.applyEvent(run.runId, {
      type: "status",
      sequence: run.lastSequence + 1,
      status: "outcome_unknown",
      error: {
        code,
        message: "The in-process Runtime did not produce a known terminal outcome.",
        retryable: false
      }
    }, this.clock()).run;
    this.core.updateAgentPresence(run.targetAgentId, "ready", this.clock());
    return result;
  }
}
