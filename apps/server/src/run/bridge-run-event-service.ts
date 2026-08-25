import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { DevicePrincipal } from "../security/auth-service.js";
import { redactSensitiveText } from "../security/redaction.js";
import type {
  RuntimeStatus,
  RuntimeTaskClarification
} from "../runtime/runtime-adapter.js";
import { parseAgentAssessment } from "../discussion/progress-evaluator.js";
import type {
  AppliedRunEvent,
  RunRecord,
  RunRepository
} from "./run-repository.js";
import type {
  ResultEvidenceConsumptionRepository
} from "../task/result-evidence-consumption-repository.js";

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

const sessionDispositions = new Set(["started", "resumed", "recreated"]);

const runtimeFailureCategories = new Set([
  "start",
  "authentication",
  "rate_limit",
  "network",
  "model",
  "configuration",
  "unknown"
]);

function safeRuntimeFailureDetails(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const details: Record<string, unknown> = {};
  if (typeof source.category === "string") {
    details.category = runtimeFailureCategories.has(source.category)
      ? source.category
      : "unknown";
  }
  if (typeof source.exitCode === "number" && Number.isSafeInteger(source.exitCode)) {
    details.exitCode = source.exitCode;
  }
  if (typeof source.stderrCaptured === "boolean") {
    details.stderrCaptured = source.stderrCaptured;
  }
  return Object.keys(details).length > 0 ? details : null;
}

export class BridgeRunEventService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly evidenceConsumption?: ResultEvidenceConsumptionRepository
  ) {}

  public applyStatus(
    principal: DevicePrincipal,
    input: {
      runId: string;
      traceId: string;
      agentId: string;
      sequence: number;
      status: RuntimeStatus;
      error?: {
        code: string;
        message: string;
        retryable: boolean;
        details?: unknown;
      };
      session?: {
        disposition: "started" | "resumed" | "recreated";
        contextCursor: number;
        runtimeScopeId?: string;
        resultEvidenceRevision?: number;
      };
      clarification?: RuntimeTaskClarification;
    },
    now: string
  ): AppliedRunEvent {
    const run = this.requireOwnedRun(
      principal, input.runId, input.traceId, input.agentId
    );
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
    if (input.session) {
      const trigger = this.core.getMessage(run.triggerMessageId);
      const agent = this.core.getAgent(run.targetAgentId);
      const hasEvidenceCursor =
        input.session.runtimeScopeId !== undefined ||
        input.session.resultEvidenceRevision !== undefined;
      if (
        !sessionDispositions.has(input.session.disposition) ||
        !Number.isSafeInteger(input.session.contextCursor) ||
        input.session.contextCursor < 0 ||
        !trigger || input.session.contextCursor > trigger.sequence ||
        (hasEvidenceCursor && (
          typeof input.session.runtimeScopeId !== "string" ||
          !/^[0-9a-f]{64}$/u.test(input.session.runtimeScopeId) ||
          !Number.isSafeInteger(input.session.resultEvidenceRevision) ||
          (input.session.resultEvidenceRevision ?? -1) < 0 ||
          !agent || agent.runtimeScopeId !== input.session.runtimeScopeId
        ))
      ) {
        throw new Error("Invalid logical Runtime session status");
      }
    }
    if (input.clarification) {
      const choices = input.clarification.choices ?? [];
      if (
        Object.keys(input.clarification).some((key) =>
          !new Set(["kind", "question", "choices"]).has(key)
        ) ||
        input.status !== "input_required" ||
        input.clarification.kind !== "task" ||
        typeof input.clarification.question !== "string" ||
        input.clarification.question.trim().length === 0 ||
        input.clarification.question.length > 2_000 ||
        (input.clarification.choices !== undefined && choices.length < 2) ||
        choices.length > 8 ||
        choices.some((choice) =>
          typeof choice !== "string" ||
          choice.trim().length === 0 || choice.length > 240
        ) ||
        new Set(choices).size !== choices.length ||
        input.error !== undefined ||
        run.orchestrationKey !== undefined
      ) {
        throw new Error("Invalid Task clarification status");
      }
    }
    const safeDetails = safeRuntimeFailureDetails(input.error?.details);
    if (
      input.session?.runtimeScopeId !== undefined &&
      input.session.resultEvidenceRevision !== undefined
    ) {
      this.evidenceConsumption?.validateAcknowledgement({
        runId: run.runId,
        taskId: run.taskId,
        agentId: run.targetAgentId,
        runtimeScopeId: input.session.runtimeScopeId,
        throughRevision: input.session.resultEvidenceRevision
      });
    }
    const applied = this.runs.applyEvent(run.runId, {
      type: "status",
      sequence: input.sequence,
      status: input.status,
      ...(input.error
        ? {
            error: {
              code: input.error.code,
              message: input.error.message,
              retryable: input.error.retryable,
              ...(safeDetails ? { details: safeDetails } : {})
            }
          }
        : {}),
      ...(input.session ? { session: input.session } : {}),
      ...(input.clarification
        ? {
            clarification: {
              kind: "task" as const,
              question: redactSensitiveText(input.clarification.question.trim()),
              ...(input.clarification.choices
                ? {
                    choices: input.clarification.choices.map((choice) =>
                      redactSensitiveText(choice.trim())
                    )
                  }
                : {})
            }
          }
        : {})
    }, now);
    if (applied.applied) {
      this.core.updateAgentPresence(
        run.targetAgentId,
        terminalStatuses.has(input.status) || input.status === "input_required"
          ? "ready"
          : "busy",
        now
      );
    }
    if (
      input.session?.runtimeScopeId !== undefined &&
      input.session.resultEvidenceRevision !== undefined
    ) {
      this.evidenceConsumption?.acknowledge({
        runId: run.runId,
        taskId: run.taskId,
        agentId: run.targetAgentId,
        runtimeScopeId: input.session.runtimeScopeId,
        throughRevision: input.session.resultEvidenceRevision,
        now
      });
    }
    return applied;
  }

  public applyReply(
    principal: DevicePrincipal,
    input: {
      runId: string;
      traceId: string;
      agentId: string;
      sequence: number;
      content: string;
      assessment?: unknown;
    },
    now: string
  ): AppliedRunEvent {
    const run = this.requireOwnedRun(
      principal, input.runId, input.traceId, input.agentId
    );
    this.validateSequence(input.sequence);
    if (input.content.trim().length === 0 || input.content.length > 20_000) {
      throw new Error("Runtime reply must contain 1 to 20000 characters");
    }
    const safeContent = redactSensitiveText(input.content);
    const parsedAssessment = parseAgentAssessment(input.assessment);
    const assessment = parsedAssessment
      ? {
          ...parsedAssessment,
          ...(parsedAssessment.openQuestions
            ? {
                openQuestions: parsedAssessment.openQuestions.map((question) => ({
                  ...question,
                  question: redactSensitiveText(question.question)
                }))
              }
            : {}),
          ...(parsedAssessment.newEvidenceRefs
            ? {
                newEvidenceRefs: parsedAssessment.newEvidenceRefs.map((reference) =>
                  redactSensitiveText(reference)
                )
              }
            : {})
        }
      : null;
    const applied = this.runs.applyEvent(run.runId, {
      type: "reply",
      sequence: input.sequence,
      content: safeContent,
      ...(assessment ? { assessment: { ...assessment } } : {})
    }, now);
    if (applied.applied) {
      this.core.appendMessage({
        messageId: createOpaqueId("msg"),
        roomId: run.roomId,
        taskId: run.taskId,
        senderType: "agent",
        senderId: run.targetAgentId,
        content: safeContent,
        mentions: [],
        parentMessageId: run.triggerMessageId,
        traceId: run.traceId,
        createdAt: now
      });
    }
    return applied;
  }

  public applyActivity(
    principal: DevicePrincipal,
    input: {
      runId: string;
      traceId: string;
      agentId: string;
      sequence: number;
      activityId: string;
      kind: "reasoning" | "tool";
      phase: "started" | "updated" | "completed" | "failed";
      label?: string;
      content?: string;
      reset?: boolean;
    },
    now: string
  ): AppliedRunEvent {
    const run = this.requireOwnedRun(
      principal, input.runId, input.traceId, input.agentId
    );
    this.validateSequence(input.sequence);
    if (
      input.activityId.trim().length === 0 ||
      input.activityId.length > 160 ||
      !new Set(["reasoning", "tool"]).has(input.kind) ||
      !new Set(["started", "updated", "completed", "failed"]).has(input.phase) ||
      (input.label !== undefined && (
        input.label.trim().length === 0 || input.label.length > 120
      )) ||
      (input.content !== undefined && (
        input.content.trim().length === 0 || input.content.length > 4_000
      )) ||
      (input.reset !== undefined && typeof input.reset !== "boolean")
    ) {
      throw new Error("Invalid Runtime activity");
    }
    return this.runs.applyEvent(run.runId, {
      type: "activity",
      sequence: input.sequence,
      activityId: input.activityId,
      kind: input.kind,
      phase: input.phase,
      ...(input.label ? { label: redactSensitiveText(input.label) } : {}),
      ...(input.content ? { content: redactSensitiveText(input.content) } : {}),
      ...(input.reset ? { reset: true } : {})
    }, now);
  }

  public applyOutput(
    principal: DevicePrincipal,
    input: {
      runId: string;
      traceId: string;
      agentId: string;
      sequence: number;
      content: string;
      reset?: boolean;
    },
    now: string
  ): AppliedRunEvent {
    const run = this.requireOwnedRun(
      principal, input.runId, input.traceId, input.agentId
    );
    this.validateSequence(input.sequence);
    if (
      input.content.length === 0 ||
      input.content.length > 20_000 ||
      (input.reset !== undefined && typeof input.reset !== "boolean")
    ) {
      throw new Error("Runtime output delta must contain 1 to 20000 characters");
    }
    const currentOutput = this.runs.listEvents(run.runId).reduce(
      (content, record) => {
        if (record.event.type === "reply") return "";
        if (record.event.type !== "output") return content;
        return record.event.reset
          ? record.event.content
          : content + record.event.content;
      },
      ""
    );
    const safeContent = redactSensitiveText(input.content);
    const outputEvent = {
      type: "output" as const,
      sequence: input.sequence,
      content: safeContent,
      ...(input.reset ? { reset: true } : {})
    };
    if (
      input.sequence <= run.lastSequence ||
      new Set(["completed", "failed", "canceled", "expired", "outcome_unknown"])
        .has(run.state)
    ) {
      return this.runs.applyEvent(run.runId, outputEvent, now);
    }
    const nextOutput = input.reset ? safeContent : currentOutput + safeContent;
    if (nextOutput.length > 20_000) {
      throw new Error("Runtime provisional output exceeds 20000 characters");
    }
    return this.runs.applyEvent(run.runId, outputEvent, now);
  }

  private requireOwnedRun(
    principal: DevicePrincipal,
    runId: string,
    traceId: string,
    agentId: string
  ): RunRecord {
    const run = this.runs.getRun(runId);
    const agent = this.core.getAgent(agentId);
    if (
      !run ||
      !agent ||
      run.traceId !== traceId ||
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
