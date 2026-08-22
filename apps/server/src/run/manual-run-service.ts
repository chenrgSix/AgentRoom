import type { CoreRepository } from "../data/core-repository.js";
import type { McpPrincipal } from "../security/auth-service.js";
import type { MessageService } from "../team-room/message-service.js";
import type { RunRecord, RunRepository } from "./run-repository.js";

const terminalStates = new Set([
  "completed", "failed", "canceled", "expired", "outcome_unknown"
]);

export class ManualRunService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly messages: MessageService
  ) {}

  public listMentions(principal: McpPrincipal): Array<{
    run: RunRecord;
    triggerMessage: ReturnType<CoreRepository["getMessage"]>;
  }> {
    return this.runs.listAgentRuns(principal.agentId)
      .filter((run) => !terminalStates.has(run.state))
      .map((run) => ({ run, triggerMessage: this.core.getMessage(run.triggerMessageId) }));
  }

  public get(principal: McpPrincipal, runId: string): RunRecord {
    const run = this.runs.getRun(runId);
    if (!run || run.targetAgentId !== principal.agentId) {
      throw new Error("Manual Run access denied");
    }
    return run;
  }

  public claim(principal: McpPrincipal, runId: string, now: string): RunRecord {
    const run = this.get(principal, runId);
    if (terminalStates.has(run.state) || run.state === "working" || run.state === "input_required") {
      return run;
    }
    if (run.state !== "queued") {
      throw new Error(`Manual Run cannot be claimed from ${run.state}`);
    }
    return this.runs.applyEvent(run.runId, {
      type: "status", sequence: run.lastSequence + 1, status: "working"
    }, now).run;
  }

  public complete(
    principal: McpPrincipal,
    runId: string,
    content: string,
    now: string
  ): RunRecord {
    const normalized = content.trim();
    if (normalized.length === 0 || content.length > 20_000) {
      throw new Error("Run reply must contain 1 to 20000 characters");
    }
    let run = this.claim(principal, runId, now);
    if (terminalStates.has(run.state)) {
      return run;
    }
    const reply = this.runs.applyEvent(run.runId, {
      type: "reply", sequence: run.lastSequence + 1, content
    }, now);
    if (reply.applied) {
      this.messages.createAgentMessage(principal, {
        roomId: run.roomId,
        parentMessageId: run.triggerMessageId,
        content,
        now
      });
    }
    run = reply.run;
    return this.runs.applyEvent(run.runId, {
      type: "status", sequence: run.lastSequence + 1, status: "completed"
    }, now).run;
  }

  public fail(
    principal: McpPrincipal,
    runId: string,
    message: string,
    now: string
  ): RunRecord {
    const normalized = message.trim();
    if (normalized.length === 0 || message.length > 2_000) {
      throw new Error("Failure message must contain 1 to 2000 characters");
    }
    const run = this.claim(principal, runId, now);
    if (terminalStates.has(run.state)) {
      return run;
    }
    return this.runs.applyEvent(run.runId, {
      type: "status",
      sequence: run.lastSequence + 1,
      status: "failed",
      error: {
        code: "MANUAL_AGENT_FAILED",
        message,
        retryable: false
      }
    }, now).run;
  }
}
