import type { AgentRecord, CoreRepository } from "../data/core-repository.js";
import {
  exceedsUnicodeCodePointLimit,
  truncateUnicodeCodePoints
} from "../domain/unicode-length.js";
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
import type { ContextPlanner } from "../task/context-planner.js";

const terminalStates = new Set([
  "completed",
  "failed",
  "canceled",
  "expired",
  "outcome_unknown"
]);

export interface PreparedRuntimeExecution {
  agent: AgentRecord;
  request: RuntimeRequest;
  run: RunRecord;
}

interface RuntimeExecutionFailure {
  code: string;
  disposition: "failed" | "canceled" | "outcome_unknown";
  message: string;
  retryable: boolean;
}

function runtimeExecutionFailure(error: unknown): RuntimeExecutionFailure | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Partial<RuntimeExecutionFailure>;
  if (
    typeof candidate.code !== "string" ||
    typeof candidate.message !== "string" ||
    typeof candidate.retryable !== "boolean" ||
    !["failed", "canceled", "outcome_unknown"].includes(
      candidate.disposition ?? ""
    )
  ) {
    return undefined;
  }
  return candidate as RuntimeExecutionFailure;
}

export class InProcessRunExecutor {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly contextPlanner: ContextPlanner,
    private readonly clock: () => string
  ) {}

  public async execute(
    runId: string,
    adapter: RuntimeAdapter
  ): Promise<RunRecord> {
    let prepared: PreparedRuntimeExecution;
    try {
      prepared = this.prepare(runId);
    } catch {
      const initial = this.runs.getRun(runId);
      if (!initial) throw new Error(`Run not found: ${runId}`);
      if (terminalStates.has(initial.state)) return initial;
      return this.finishUnknown(initial, "RUN_TARGET_UNAVAILABLE");
    }
    return this.executePrepared(prepared, adapter);
  }

  public prepare(runId: string): PreparedRuntimeExecution {
    const initial = this.runs.getRun(runId);
    if (!initial) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (terminalStates.has(initial.state)) {
      throw new Error(`Run is already terminal: ${initial.state}`);
    }
    if (initial.state !== "queued" && initial.state !== "delivered") {
      throw new Error(`Run cannot be started from state: ${initial.state}`);
    }
    const agent = this.core.getAgent(initial.targetAgentId);
    const trigger = this.core.getMessage(initial.triggerMessageId);
    if (!agent || !agent.enabled || !trigger) {
      throw new Error("Run target is unavailable");
    }

    const contextFence = this.runs.getContextFence(initial.runId);
    const plannedContext = this.contextPlanner.plan({
      roomId: initial.roomId,
      taskId: initial.taskId,
      throughSequence: trigger.sequence,
      triggerMessageId: trigger.messageId,
      ...(contextFence ? { contextFence } : {})
    }, this.clock());
    return {
      agent,
      run: initial,
      request: {
      runId: initial.runId,
      taskId: initial.taskId,
      agentId: agent.agentId,
      instruction: initial.instruction,
      contextCursor: trigger.sequence,
      contextPlan: plannedContext.contextPlan,
        contextMessages: plannedContext.contextMessages
        .map((message) => ({
          messageId: message.messageId,
          sequence: message.sequence,
          senderId: message.senderId,
          content: message.content
        }))
      }
    };
  }

  public async executePrepared(
    prepared: PreparedRuntimeExecution,
    adapter: RuntimeAdapter
  ): Promise<RunRecord> {
    const { agent, request } = prepared;
    const current = this.runs.getRun(prepared.run.runId);
    if (!current) throw new Error(`Run not found: ${prepared.run.runId}`);
    if (terminalStates.has(current.state)) return current;
    if (
      current.targetAgentId !== agent.agentId ||
      (current.state !== "queued" && current.state !== "delivered")
    ) {
      throw new Error(`Run cannot be started from state: ${current.state}`);
    }

    this.core.updateAgentPresence(agent.agentId, "busy", this.clock());
    let provisionalOutput = "";
    let pendingReply: Extract<RuntimeEvent, { type: "reply" }> | undefined;

    try {
      for await (const event of adapter.execute(request)) {
        const safeEvent = event.type === "reply" || event.type === "output"
          ? { ...event, content: redactSensitiveText(event.content) }
          : event;
        if (
          safeEvent.type === "output" &&
          (safeEvent.content.length === 0 ||
            exceedsUnicodeCodePointLimit(safeEvent.content, 20_000))
        ) {
          throw new Error("Runtime output delta must contain 1 to 20000 characters");
        }
        if (safeEvent.type === "output") {
          provisionalOutput = safeEvent.reset
            ? safeEvent.content
            : provisionalOutput + safeEvent.content;
          if (exceedsUnicodeCodePointLimit(provisionalOutput, 20_000)) {
            throw new Error("Runtime provisional output exceeds 20000 characters");
          }
        }
        if (
          safeEvent.type === "reply" &&
          (safeEvent.content.trim().length === 0 ||
            exceedsUnicodeCodePointLimit(safeEvent.content, 20_000))
        ) {
          throw new Error("Runtime reply must contain 1 to 20000 characters");
        }
        if (pendingReply) {
          if (safeEvent.type !== "status" || safeEvent.status !== "completed") {
            throw new Error("Runtime reply must be followed by completed status");
          }
          this.runs.applyReplyAndTerminal(
            current.runId,
            pendingReply,
            {
              type: "status",
              sequence: safeEvent.sequence,
              status: "completed"
            },
            this.clock()
          );
          pendingReply = undefined;
        } else if (safeEvent.type === "reply") {
          pendingReply = safeEvent;
        } else {
          this.runs.applyEvent(current.runId, safeEvent, this.clock());
        }
      }
      const completed = this.runs.getRun(current.runId);
      if (pendingReply || !completed || !terminalStates.has(completed.state)) {
        return this.finishUnknown(completed ?? current, "RUNTIME_ENDED_EARLY");
      }
      this.core.updateAgentPresence(agent.agentId, "ready", this.clock());
      return completed;
    } catch (error) {
      const latest = this.runs.getRun(current.runId) ?? current;
      if (terminalStates.has(latest.state)) {
        this.core.updateAgentPresence(agent.agentId, "ready", this.clock());
        return latest;
      }
      const runtimeFailure = runtimeExecutionFailure(error);
      if (runtimeFailure) {
        return this.finish(
          latest,
          runtimeFailure.disposition,
          runtimeFailure.code,
          truncateUnicodeCodePoints(runtimeFailure.message, 512),
          runtimeFailure.retryable
        );
      }
      const code = error instanceof Error && error.message.includes("sequence")
        ? "RUNTIME_SEQUENCE_INVALID"
        : "RUNTIME_EXECUTION_FAILED";
      return this.finishUnknown(latest, code);
    }
  }

  private finishUnknown(run: RunRecord, code: string): RunRecord {
    return this.finish(
      run,
      "outcome_unknown",
      code,
      "The in-process Runtime did not produce a known terminal outcome.",
      false
    );
  }

  private finish(
    run: RunRecord,
    status: RuntimeExecutionFailure["disposition"],
    code: string,
    message: string,
    retryable: boolean
  ): RunRecord {
    const result = this.runs.applyEvent(run.runId, {
      type: "status",
      sequence: run.lastSequence + 1,
      status,
      error: {
        code,
        message,
        retryable
      }
    }, this.clock()).run;
    this.core.updateAgentPresence(run.targetAgentId, "ready", this.clock());
    return result;
  }
}
