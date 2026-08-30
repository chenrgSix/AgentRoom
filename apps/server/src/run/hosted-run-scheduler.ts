import type { CoreRepository } from "../data/core-repository.js";
import { HostedAgentRepository } from "../data/hosted-agent-repository.js";
import type {
  PreparedRuntimeExecution
} from "../runtime/in-process-run-executor.js";
import { InProcessRunExecutor } from
  "../runtime/in-process-run-executor.js";
import {
  HostedOpenAIResponsesAdapter
} from "../runtime/hosted-openai-responses-adapter.js";
import type { RuntimeAdapter, RuntimeEvent, RuntimeRequest } from
  "../runtime/runtime-adapter.js";
import { truncateUnicodeCodePoints } from "../domain/unicode-length.js";
import type { RunRecord, RunRepository } from "./run-repository.js";
import {
  HostedInvocationRepository,
  type HostedInvocationRecovery
} from "./hosted-invocation-repository.js";

const terminalStates = new Set([
  "completed",
  "failed",
  "canceled",
  "expired",
  "outcome_unknown"
]);

interface ActiveHostedRun {
  agentId: string;
  controller: AbortController;
  promise: Promise<void>;
  terminalNotification: Promise<void> | undefined;
  timer?: ReturnType<typeof setTimeout>;
}

export interface HostedRunSchedulerOptions {
  fetch?: typeof fetch;
  maximumConcurrency?: number;
  onTerminal?: (run: RunRecord) => Promise<void>;
}

export class HostedRunScheduler {
  private readonly active = new Map<string, ActiveHostedRun>();
  private readonly activeAgents = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly maximumConcurrency: number;
  private accepting = true;
  private draining = false;
  private drainRequested = false;

  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly hostedAgents: HostedAgentRepository,
    private readonly invocations: HostedInvocationRepository,
    private readonly executor: InProcessRunExecutor,
    private readonly clock: () => string,
    private readonly options: HostedRunSchedulerOptions = {}
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("Hosted Agent HTTP transport is unavailable");
    }
    this.maximumConcurrency = options.maximumConcurrency ?? 4;
    if (
      !Number.isSafeInteger(this.maximumConcurrency) ||
      this.maximumConcurrency < 1 ||
      this.maximumConcurrency > 32
    ) {
      throw new Error("Hosted Agent concurrency must be between 1 and 32");
    }
  }

  public enqueue(runId: string): RunRecord {
    const run = this.requireHostedRun(runId);
    if (!this.accepting || terminalStates.has(run.state)) return run;
    this.requestDrain();
    return run;
  }

  public recover(): HostedInvocationRecovery {
    const recovery = this.invocations.recover(this.clock());
    const degradedAgents = new Set<string>();
    for (const runId of recovery.outcomeUnknownRunIds) {
      const run = this.runs.getRun(runId);
      if (!run) continue;
      degradedAgents.add(run.targetAgentId);
      this.core.updateAgentPresence(run.targetAgentId, "degraded", this.clock());
    }
    for (const runId of recovery.reconciledRunIds) {
      const run = this.runs.getRun(runId);
      if (!run || degradedAgents.has(run.targetAgentId)) continue;
      this.projectHostedPresence(run);
    }
    if (recovery.runnableRunIds.length > 0) this.requestDrain();
    return recovery;
  }

  public cancel(
    runId: string,
    memberId: string,
    reason: string
  ): RunRecord {
    const run = this.requireHostedRun(runId);
    if (terminalStates.has(run.state)) return run;
    const now = this.clock();
    const normalizedReason = truncateUnicodeCodePoints(reason.trim(), 512) ||
      "Canceled by requester";
    const invocation = this.invocations.getByRun(runId);
    if (!invocation) {
      const canceled = this.runs.applyEvent(runId, {
        type: "status",
        sequence: run.lastSequence + 1,
        status: "canceled",
        error: {
          code: "HOSTED_RUN_CANCELED_PRE_DISPATCH",
          message: "Hosted Run was canceled before provider dispatch.",
          retryable: false
        }
      }, now).run;
      void this.notifyTerminal(canceled).catch(() => {});
      return canceled;
    }
    if (invocation.state === "prepared") {
      const canceled = this.invocations.cancelPrepared({
        runId,
        memberId,
        reason: normalizedReason,
        now
      });
      void this.notifyTerminal(canceled, this.active.get(runId)).catch(() => {});
      return canceled;
    }

    this.invocations.requestCancellation({
      runId,
      memberId,
      reason: normalizedReason,
      now
    });
    const unknown = this.finishUnknown(
      run,
      "HOSTED_CANCEL_OUTCOME_UNKNOWN",
      "Provider cancellation could not prove the remote outcome.",
      now
    );
    this.invocations.settleFromRun(
      runId,
      "HOSTED_CANCEL_OUTCOME_UNKNOWN",
      now
    );
    void this.notifyTerminal(unknown, this.active.get(runId)).catch(() => {});
    this.abort(runId, "Hosted Run canceled after dispatch");
    return unknown;
  }

  public revokeAgent(agentId: string): void {
    const now = this.clock();
    for (const [runId, active] of this.active) {
      if (active.agentId !== agentId) continue;
      const run = this.runs.getRun(runId);
      if (run && !terminalStates.has(run.state)) {
        this.finishUnknown(
          run,
          "HOSTED_CREDENTIAL_REVOKED_UNKNOWN",
          "Hosted credential was revoked after provider dispatch.",
          now
        );
        this.invocations.settleFromRun(
          runId,
          "HOSTED_CREDENTIAL_REVOKED_UNKNOWN",
          now
        );
      }
      active.controller.abort(new Error("Hosted credential revoked"));
    }
  }

  public async shutdown(): Promise<void> {
    this.accepting = false;
    const now = this.clock();
    for (const [runId, active] of this.active) {
      if (active.timer) clearTimeout(active.timer);
      const run = this.runs.getRun(runId);
      if (run && !terminalStates.has(run.state)) {
        this.finishUnknown(
          run,
          "HOSTED_SERVER_SHUTDOWN_UNKNOWN",
          "Central shut down after provider dispatch.",
          now
        );
        this.invocations.settleFromRun(
          runId,
          "HOSTED_SERVER_SHUTDOWN_UNKNOWN",
          now
        );
      }
      active.controller.abort(new Error("Central Server shutdown"));
    }
    await Promise.allSettled([...this.active.values()].map(({ promise }) => promise));
  }

  public activeCount(): number {
    return this.active.size;
  }

  private requestDrain(): void {
    this.drainRequested = true;
    queueMicrotask(() => {
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining || !this.accepting) return;
    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        for (const runId of this.invocations.listRunnableQueuedRunIds()) {
          if (this.active.size >= this.maximumConcurrency) break;
          if (this.active.has(runId)) continue;
          const run = this.runs.getRun(runId);
          if (!run || this.activeAgents.has(run.targetAgentId)) continue;
          this.start(run);
        }
      } while (
        this.drainRequested &&
        this.active.size < this.maximumConcurrency &&
        this.accepting
      );
    } finally {
      this.draining = false;
    }
  }

  private start(run: RunRecord): void {
    const controller = new AbortController();
    const active: ActiveHostedRun = {
      agentId: run.targetAgentId,
      controller,
      promise: Promise.resolve(),
      terminalNotification: undefined
    };
    this.active.set(run.runId, active);
    this.activeAgents.add(run.targetAgentId);
    active.promise = Promise.resolve()
      .then(() => this.executeOne(run.runId, controller, active))
      .catch(() => {
        // executeOne persists a closed safe outcome before rejecting.
      })
      .finally(() => {
        if (active.timer) clearTimeout(active.timer);
        this.active.delete(run.runId);
        this.activeAgents.delete(run.targetAgentId);
        this.requestDrain();
      });
  }

  private async executeOne(
    runId: string,
    controller: AbortController,
    active: ActiveHostedRun
  ): Promise<void> {
    let prepared: PreparedRuntimeExecution | undefined;
    let crossedDispatchFence = false;
    try {
      const queued = this.runs.getRun(runId);
      const beforePreparation = queued &&
        queued.state === "queued" &&
        Date.parse(queued.deadlineAt) <= Date.parse(this.clock())
        ? this.runs.applyEvent(runId, {
            type: "status",
            sequence: queued.lastSequence + 1,
            status: "expired",
            error: {
              code: "RUN_EXPIRED",
              message: "Run expired before its target Agent accepted delivery.",
              retryable: false
            }
          }, this.clock()).run
        : undefined;
      if (beforePreparation) {
        await this.notifyTerminal(beforePreparation, active);
        return;
      }
      prepared = this.executor.prepare(runId);
      const execution = this.hostedAgents.resolveExecutionProfile(
        prepared.agent.agentId
      );
      let adapter: HostedOpenAIResponsesAdapter;
      try {
        adapter = HostedOpenAIResponsesAdapter.prepare({
          profile: {
            model: execution.model,
            maxOutputTokens: Math.min(32_768, execution.executionLimits.maxOutputCharacters)
          },
          apiKey: execution.apiKey,
          request: prepared.request,
          firstSequence: prepared.run.lastSequence + 2,
          signal: controller.signal,
          fetch: this.fetchImpl
        });
      } finally {
        execution.apiKey = "";
      }
      const room = this.core.getRoom(prepared.run.roomId);
      if (!room || room.teamId !== execution.teamId) {
        throw new Error("Hosted Run Team scope is unavailable");
      }
      this.invocations.prepare({
        runId,
        teamId: execution.teamId,
        agentId: execution.agentId,
        profileRevision: execution.profileRevision,
        credentialVersion: execution.credentialVersion,
        provider: execution.provider,
        model: execution.model,
        deadlineAt: prepared.run.deadlineAt,
        promptSha256: adapter.requestSha256,
        now: this.clock()
      });
      const dispatching = this.invocations.markDispatching(runId, this.clock());
      if (dispatching.state !== "dispatching") {
        const terminal = this.runs.getRun(runId);
        if (terminal && terminalStates.has(terminal.state)) {
          await this.notifyTerminal(terminal, active);
        }
        return;
      }
      crossedDispatchFence = true;
      active.timer = this.deadlineTimer(
        prepared.run,
        execution.executionLimits.timeoutSeconds,
        controller
      );
      const tracked = this.trackedAdapter(runId, adapter);
      const terminal = await this.executor.executePrepared(prepared, tracked);
      const failureCode = this.terminalFailureCode(terminal);
      this.invocations.settleFromRun(runId, failureCode, this.clock());
      this.projectHostedPresence(terminal);
      await this.notifyTerminal(terminal, active);
    } catch (error) {
      const latest = this.runs.getRun(runId);
      if (!latest) return;
      let terminal = latest;
      if (!terminalStates.has(latest.state)) {
        if (crossedDispatchFence) {
          terminal = this.finishUnknown(
            latest,
            "HOSTED_PROVIDER_OUTCOME_UNKNOWN",
            "Hosted provider execution ended without a known outcome.",
            this.clock()
          );
        } else {
          terminal = this.runs.applyEvent(runId, {
            type: "status",
            sequence: latest.lastSequence + 1,
            status: "failed",
            error: {
              code: "HOSTED_CONFIGURATION_UNAVAILABLE",
              message: "Hosted Agent configuration is unavailable.",
              retryable: false
            }
          }, this.clock()).run;
        }
      }
      if (this.invocations.getByRun(runId)) {
        this.invocations.settleFromRun(
          runId,
          crossedDispatchFence
            ? "HOSTED_PROVIDER_OUTCOME_UNKNOWN"
            : "HOSTED_CONFIGURATION_UNAVAILABLE",
          this.clock()
        );
      }
      this.core.updateAgentPresence(
        terminal.targetAgentId,
        "degraded",
        this.clock()
      );
      await this.notifyTerminal(terminal, active);
      if (error instanceof Error && error.name === "AbortError") return;
    }
  }

  private trackedAdapter(runId: string, adapter: RuntimeAdapter): RuntimeAdapter {
    const invocations = this.invocations;
    const clock = this.clock;
    return {
      async *execute(request: RuntimeRequest) {
        let streamingRecorded = false;
        for await (const event of adapter.execute(request)) {
          if (
            !streamingRecorded &&
            event.type === "status" &&
            event.status === "working"
          ) {
            streamingRecorded = true;
            invocations.markStreaming(runId, clock());
          }
          yield event;
        }
      }
    };
  }

  private deadlineTimer(
    run: RunRecord,
    timeoutSeconds: number,
    controller: AbortController
  ): ReturnType<typeof setTimeout> {
    const nowMilliseconds = Date.parse(this.clock());
    const delay = Math.min(
      2_147_483_647,
      Math.max(1, Math.min(
        Date.parse(run.deadlineAt) - nowMilliseconds,
        timeoutSeconds * 1_000
      ))
    );
    const timer = setTimeout(() => {
      const latest = this.runs.getRun(run.runId);
      if (latest && !terminalStates.has(latest.state)) {
        const now = this.clock();
        this.finishUnknown(
          latest,
          "HOSTED_RUN_DEADLINE_UNKNOWN",
          "Hosted provider outcome was unknown at the Run deadline.",
          now
        );
        this.invocations.settleFromRun(
          run.runId,
          "HOSTED_RUN_DEADLINE_UNKNOWN",
          now
        );
      }
      controller.abort(new Error("Hosted Run deadline reached"));
    }, delay);
    timer.unref();
    return timer;
  }

  private abort(runId: string, reason: string): void {
    this.active.get(runId)?.controller.abort(new Error(reason));
  }

  private async notifyTerminal(
    run: RunRecord,
    active = this.active.get(run.runId)
  ): Promise<void> {
    if (active?.terminalNotification) {
      await active.terminalNotification;
      return;
    }
    const notification = Promise.resolve().then(async () => {
      await this.options.onTerminal?.(run);
    });
    if (active) active.terminalNotification = notification;
    try {
      await notification;
    } catch (error) {
      if (active?.terminalNotification === notification) {
        active.terminalNotification = undefined;
      }
      throw error;
    }
  }

  private finishUnknown(
    run: RunRecord,
    code: string,
    message: string,
    now: string
  ): RunRecord {
    const latest = this.runs.getRun(run.runId) ?? run;
    if (terminalStates.has(latest.state)) return latest;
    return this.runs.applyEvent(run.runId, {
      type: "status",
      sequence: latest.lastSequence + 1,
      status: "outcome_unknown",
      error: { code, message, retryable: false }
    }, now).run;
  }

  private terminalFailureCode(run: RunRecord): string {
    const last = this.runs.listEvents(run.runId, Math.max(0, run.lastSequence - 1))
      .at(-1)?.event;
    return last?.type === "status" && last.error?.code
      ? last.error.code
      : `HOSTED_RUN_${run.state.toUpperCase()}`;
  }

  private projectHostedPresence(run: RunRecord): void {
    const presence = ["completed", "canceled", "expired"].includes(run.state) &&
      this.hostedAgents.getAvailability(run.targetAgentId) === "ready"
      ? "ready"
      : "degraded";
    this.core.updateAgentPresence(run.targetAgentId, presence, this.clock());
  }

  private requireHostedRun(runId: string): RunRecord {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const agent = this.core.getAgent(run.targetAgentId);
    if (!agent || agent.integrationMode !== "hosted") {
      throw new Error("Run target is not a Hosted Agent");
    }
    return run;
  }
}
