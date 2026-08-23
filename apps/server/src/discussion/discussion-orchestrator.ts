import type { CoreRepository, MessageRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRecord, RunRepository } from "../run/run-repository.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import { redactSensitiveText } from "../security/redaction.js";
import type { MessageService } from "../team-room/message-service.js";
import {
  grantDiscussionLease,
  recordTurnUsage
} from "./budget-ledger.js";
import { DiscussionRepository } from "./discussion-repository.js";
import {
  decideDiscussion,
  type DiscussionUserIntent,
  type PolicyDecision
} from "./discussion-policy-engine.js";
import {
  defaultDiscussionPolicy,
  emptyBudgetSnapshot,
  emptyProgressSnapshot,
  type DiscussionBudgetEvent,
  type DiscussionDecision,
  type DiscussionMode,
  type DiscussionOutputMode,
  type DiscussionParticipant,
  type DiscussionPolicy,
  type DiscussionRecord,
  type DiscussionTurn,
  type ProgressSnapshot
} from "./discussion-types.js";
import { evaluateProgress } from "./progress-evaluator.js";

const terminalRunStates = new Set([
  "completed", "failed", "canceled", "expired", "outcome_unknown"
]);
const terminalDiscussionStates = new Set(["completed", "canceled", "terminated"]);
const maximumParticipants = 5;
const finalizationDurationMilliseconds = 5 * 60 * 1000;

export interface DiscussionView {
  discussion: DiscussionRecord;
  participants: DiscussionParticipant[];
  turns: DiscussionTurn[];
  decisions: DiscussionDecision[];
}

export interface DiscussionMutationResult extends DiscussionView {
  scheduledRun: RunRecord | null;
  cancelRunId: string | null;
}

function requiredInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function resolvePolicy(overrides?: Partial<DiscussionPolicy>): DiscussionPolicy {
  const policy = { ...defaultDiscussionPolicy, ...overrides };
  if (
    typeof policy.requireReviewer !== "boolean" ||
    typeof policy.allowAutomaticFinish !== "boolean"
  ) {
    throw new Error("Discussion boolean policy fields must be booleans");
  }
  requiredInteger(policy.initialLeaseTurns, "initialLeaseTurns", 1, 12);
  requiredInteger(policy.automaticMaxTurns, "automaticMaxTurns", 1, 30);
  requiredInteger(policy.hardMaxTurns, "hardMaxTurns", 2, 50);
  requiredInteger(policy.maxDurationSeconds, "maxDurationSeconds", 30, 7_200);
  requiredInteger(policy.plateauWindow, "plateauWindow", 1, 6);
  requiredInteger(policy.finalizationReserveTurns, "finalizationReserveTurns", 1, 3);
  if (
    policy.initialLeaseTurns > policy.automaticMaxTurns ||
    policy.automaticMaxTurns >= policy.hardMaxTurns ||
    policy.finalizationReserveTurns >= policy.hardMaxTurns
  ) {
    throw new Error("Discussion turn budget boundaries are inconsistent");
  }
  if (
    !Number.isFinite(policy.minimumCompletionConfidence) ||
    policy.minimumCompletionConfidence < 0.5 ||
    policy.minimumCompletionConfidence > 1
  ) {
    throw new Error("minimumCompletionConfidence must be between 0.5 and 1");
  }
  return policy;
}

export class DiscussionOrchestrator {
  public constructor(
    private readonly core: CoreRepository,
    private readonly messages: MessageService,
    private readonly repository: DiscussionRepository,
    private readonly runs: RunRepository,
    private readonly auth: AuthService,
    private readonly clock: () => string
  ) {}

  public create(
    principal: WebPrincipal,
    input: {
      roomId: string;
      goal: string;
      participantAgentIds: string[];
      mode?: DiscussionMode;
      outputMode?: DiscussionOutputMode;
      policy?: Partial<DiscussionPolicy>;
    }
  ): DiscussionMutationResult {
    const now = this.clock();
    const member = this.auth.requireRoomMember(principal, input.roomId);
    const goal = input.goal.trim();
    if (goal.length === 0 || input.goal.length > 20_000) {
      throw new Error("Discussion goal must contain 1 to 20000 characters");
    }
    if (
      !Array.isArray(input.participantAgentIds) ||
      input.participantAgentIds.length < 2 ||
      input.participantAgentIds.length > maximumParticipants
    ) {
      throw new Error("Discussion requires 2 to 5 participants");
    }
    const uniqueAgentIds = [...new Set(input.participantAgentIds)];
    if (uniqueAgentIds.length !== input.participantAgentIds.length) {
      throw new Error("Discussion participants must be unique");
    }
    const room = this.core.getRoom(input.roomId);
    if (!room) {
      throw new Error(`Room not found: ${input.roomId}`);
    }
    const openDiscussion = this.repository.listForRoom(input.roomId).find(
      ({ state }) => !terminalDiscussionStates.has(state)
    );
    if (openDiscussion) {
      throw new Error(`Room already has an active Discussion: ${openDiscussion.discussionId}`);
    }
    const participantAgents = uniqueAgentIds.map((agentId) => {
      const agent = this.core.getAgent(agentId);
      if (!agent || !agent.enabled || agent.teamId !== room.teamId) {
        throw new Error(`Discussion participant is unavailable: ${agentId}`);
      }
      return agent;
    });
    const policy = resolvePolicy(input.policy);
    const mode = input.mode ?? "round_robin";
    const outputMode = input.outputMode ?? "final_answer";
    if (mode !== "round_robin" && mode !== "review") {
      throw new Error("Discussion mode must be round_robin or review");
    }
    if (!new Set([
      "none", "summary", "final_answer", "artifact", "decision_record",
      "unresolved_issues"
    ]).has(outputMode)) {
      throw new Error("Unsupported Discussion output mode");
    }
    const rootMessage = this.messages.createMemberMessage(principal, {
      roomId: input.roomId,
      content: goal,
      mentions: participantAgents.map((agent) => ({
        targetType: "agent" as const,
        targetAgentId: agent.agentId,
        displayLabel: `${agent.name} / ${agent.role}`
      })),
      now
    });
    const discussionId = createOpaqueId("discussion");
    const deadlineAt = new Date(
      Date.parse(now) + policy.maxDurationSeconds * 1_000
    ).toISOString();
    const discussion: DiscussionRecord = {
      discussionId,
      roomId: input.roomId,
      rootMessageId: rootMessage.messageId,
      requesterMemberId: member.memberId,
      goal,
      mode,
      state: "active",
      stateReason: null,
      outputMode,
      policy,
      progress: emptyProgressSnapshot(),
      budget: emptyBudgetSnapshot(policy.initialLeaseTurns),
      currentTurn: 0,
      nextSpeakerIndex: 0,
      requestedAction: null,
      version: 1,
      deadlineAt,
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    };
    const participants = uniqueAgentIds.map((agentId, ordinal) => ({
      discussionId,
      ordinal,
      agentId,
      role: mode === "review" && ordinal === uniqueAgentIds.length - 1
        ? "reviewer" as const
        : "participant" as const
    }));
    this.repository.create(discussion, participants, {
      budgetEventId: createOpaqueId("budget"),
      discussionId,
      ordinal: 1,
      eventType: "lease_granted",
      turns: policy.initialLeaseTurns,
      tokens: null,
      durationSeconds: 0,
      estimatedCostMicros: null,
      metadata: { source: "initial" },
      createdAt: now
    });
    this.planTurn(
      discussion,
      participants,
      rootMessage.messageId,
      "discussion",
      {
        action: "continue",
        state: "active",
        reason: null,
        outputMode: "none",
        grantAutomaticLease: false
      },
      discussion.progress,
      discussion.budget,
      []
    );
    const scheduledRun = this.reconcileDiscussion(discussionId).at(0) ?? null;
    return { ...this.view(discussionId), scheduledRun, cancelRunId: null };
  }

  public list(principal: WebPrincipal, roomId: string): DiscussionView[] {
    this.auth.requireRoomMember(principal, roomId);
    return this.repository.listForRoom(roomId).map(({ discussionId }) =>
      this.view(discussionId)
    );
  }

  public get(principal: WebPrincipal, discussionId: string): DiscussionView {
    const discussion = this.requireDiscussion(discussionId);
    this.auth.requireRoomMember(principal, discussion.roomId);
    return this.view(discussionId);
  }

  public control(
    principal: WebPrincipal,
    discussionId: string,
    input: {
      action: "finish" | "stop_after_turn" | "pause" | "cancel" | "continue" | "adjust_goal";
      goal?: string;
      extensionTurns?: number;
    }
  ): DiscussionMutationResult {
    let discussion = this.requireDiscussion(discussionId);
    const member = this.auth.requireRoomMember(principal, discussion.roomId);
    if (member.memberId !== discussion.requesterMemberId && member.role !== "owner") {
      throw new Error("Discussion control is limited to its requester or Team Owner");
    }
    if (terminalDiscussionStates.has(discussion.state)) {
      return { ...this.view(discussionId), scheduledRun: null, cancelRunId: null };
    }
    const activeTurn = this.latestActiveTurn(discussionId);
    if (input.action === "cancel") {
      const cancelRunId = activeTurn?.runId ?? null;
      const decision = decideDiscussion({
        progress: discussion.progress,
        budget: discussion.budget,
        policy: discussion.policy,
        requestedOutputMode: discussion.outputMode,
        userIntent: "cancel"
      });
      this.persistDecision(discussion, decision, [], null);
      return { ...this.view(discussionId), scheduledRun: null, cancelRunId };
    }
    if (input.action === "adjust_goal") {
      const goal = input.goal?.trim() ?? "";
      if (goal.length === 0 || goal.length > 20_000) {
        throw new Error("Adjusted goal must contain 1 to 20000 characters");
      }
      discussion = this.repository.updateGoal({
        discussionId,
        expectedVersion: discussion.version,
        goal,
        now: this.clock()
      });
      if (!activeTurn) {
        const run = this.planContinuation(discussion, null);
        return { ...this.view(discussionId), scheduledRun: run, cancelRunId: null };
      }
      return { ...this.view(discussionId), scheduledRun: null, cancelRunId: null };
    }
    if (input.action === "continue") {
      if (!new Set(["awaiting_extension", "waiting_human", "paused"]).has(discussion.state)) {
        throw new Error(`Discussion cannot continue from ${discussion.state}`);
      }
      let budget = discussion.budget;
      let budgetEvent: DiscussionBudgetEvent | null = null;
      if (discussion.state === "awaiting_extension") {
        budget = grantDiscussionLease({
          previous: discussion.budget,
          policy: discussion.policy,
          ...(input.extensionTurns === undefined
            ? {}
            : { requestedTurns: input.extensionTurns }),
          source: "user"
        });
        budgetEvent = this.newBudgetEvent(discussion, "extension_granted", {
          turns: budget.leaseEndTurn - discussion.budget.leaseEndTurn,
          metadata: { source: "user" }
        });
      }
      const run = this.planContinuation({
        ...discussion,
        state: "active",
        stateReason: null,
        requestedAction: null,
        budget
      }, budgetEvent);
      return { ...this.view(discussionId), scheduledRun: run, cancelRunId: null };
    }

    const intent = input.action as Exclude<DiscussionUserIntent, "cancel" | null>;
    if (activeTurn) {
      this.repository.requestAction({
        discussionId,
        expectedVersion: discussion.version,
        action: input.action,
        state: "stop_requested",
        stateReason: input.action === "pause" ? "user_paused" : "user_requested_finish",
        now: this.clock()
      });
      return { ...this.view(discussionId), scheduledRun: null, cancelRunId: null };
    }
    const decision = decideDiscussion({
      progress: discussion.progress,
      budget: discussion.budget,
      policy: discussion.policy,
      requestedOutputMode: discussion.outputMode,
      userIntent: intent
    });
    const run = decision.action === "finalize"
      ? this.planFinalization(discussion, decision, [])
      : (this.persistDecision(discussion, decision, [], null), null);
    return { ...this.view(discussionId), scheduledRun: run, cancelRunId: null };
  }

  public onRunTerminal(runId: string): DiscussionMutationResult | null {
    const run = this.runs.getRun(runId);
    const turn = this.repository.findTurnByRun(runId);
    if (!run || !turn || !terminalRunStates.has(run.state)) {
      return null;
    }
    let discussion = this.requireDiscussion(turn.discussionId);
    if (terminalDiscussionStates.has(discussion.state)) {
      return { ...this.view(turn.discussionId), scheduledRun: null, cancelRunId: null };
    }
    if (discussion.currentTurn > turn.ordinal) {
      return { ...this.view(turn.discussionId), scheduledRun: null, cancelRunId: null };
    }
    const output = this.core.findAgentReply(turn.inputMessageId, turn.speakerAgentId);
    const replyEvent = this.runs.listEvents(runId)
      .filter(({ event }) => event.type === "reply")
      .at(-1)?.event as { assessment?: unknown } | undefined;
    const successful = run.state === "completed" && output !== undefined;
    const assessment = turn.assessment ?? replyEvent?.assessment ?? null;
    const evaluation = successful
      ? evaluateProgress({
          previous: discussion.progress,
          reply: output.content,
          assessment,
          policy: discussion.policy,
          speakerIsReviewer: this.repository.listParticipants(discussion.discussionId)
            .some(({ agentId, role }) =>
              agentId === turn.speakerAgentId && role === "reviewer"
            )
        })
      : null;
    this.repository.completeTurn({
      turnId: turn.turnId,
      outputMessageId: output?.messageId ?? null,
      state: successful ? "completed" : run.state === "canceled" ? "canceled" : "failed",
      assessment: evaluation?.assessment ?? null,
      replyHash: evaluation?.replyHash ?? null,
      now: this.clock()
    });
    if (turn.kind === "finalization") {
      if (!successful) {
        this.appendFallbackConclusion(discussion, turn.inputMessageId);
      }
      const terminalState = discussion.stateReason === "hard_budget_exhausted"
        ? "terminated" as const
        : "completed" as const;
      this.repository.finishFinalization({
        discussionId: discussion.discussionId,
        expectedVersion: discussion.version,
        state: terminalState,
        now: this.clock()
      });
      return { ...this.view(discussion.discussionId), scheduledRun: null, cancelRunId: null };
    }
    const progress = evaluation?.snapshot ?? {
      ...discussion.progress,
      version: discussion.progress.version + 1,
      plateauCount: discussion.progress.plateauCount + 1,
      lastTurnAddedInformation: false
    };
    const budget = recordTurnUsage({
      previous: discussion.budget,
      discussionStartedAt: discussion.createdAt,
      now: this.clock()
    });
    const budgetEvent = this.newBudgetEvent(discussion, "turn_recorded", {
      turns: 1,
      durationSeconds: budget.durationSeconds,
      metadata: {
        runId,
        tokenTelemetryKnown: budget.tokenTelemetryKnown,
        costTelemetryKnown: budget.costTelemetryKnown
      }
    });
    discussion = { ...discussion, progress, budget };
    return this.advanceCompletedTurn(discussion, {
      ...turn,
      state: successful ? "completed" : run.state === "canceled" ? "canceled" : "failed",
      outputMessageId: output?.messageId ?? null
    }, budgetEvent, !successful);
  }

  public recover(): RunRecord[] {
    const scheduled: RunRecord[] = [];
    for (const turn of this.repository.listPlannedTurns()) {
      const run = this.ensureRun(turn);
      if (run) scheduled.push(run);
    }
    for (const discussion of this.repository.listOpen()) {
      const turn = this.repository.listTurns(discussion.discussionId).at(-1);
      if (!turn?.runId) continue;
      const run = this.runs.getRun(turn.runId);
      if (run && terminalRunStates.has(run.state)) {
        const result = this.onRunTerminal(run.runId);
        if (result?.scheduledRun) scheduled.push(result.scheduledRun);
      }
    }
    return scheduled;
  }

  public reconcileDiscussion(discussionId: string): RunRecord[] {
    return this.repository.listTurns(discussionId)
      .filter(({ state }) => state === "planned")
      .map((turn) => this.ensureRun(turn))
      .filter((run): run is RunRecord => run !== null);
  }

  private advanceCompletedTurn(
    discussion: DiscussionRecord,
    turn: DiscussionTurn,
    budgetEvent: DiscussionBudgetEvent | null = null,
    runtimeFailed = false
  ): DiscussionMutationResult {
    const decision = decideDiscussion({
      progress: discussion.progress,
      budget: discussion.budget,
      policy: discussion.policy,
      requestedOutputMode: discussion.outputMode,
      userIntent: discussion.requestedAction,
      runtimeFailed
    });
    let budget = discussion.budget;
    const budgetEvents = budgetEvent ? [budgetEvent] : [];
    if (decision.grantAutomaticLease) {
      budget = grantDiscussionLease({
        previous: budget,
        policy: discussion.policy,
        source: "automatic"
      });
      budgetEvents.push(this.newBudgetEvent(discussion, "extension_granted", {
        turns: budget.leaseEndTurn - discussion.budget.leaseEndTurn,
        durationSeconds: budget.durationSeconds,
        metadata: { source: "automatic" }
      }, budgetEvents.length));
    }
    const current = { ...discussion, budget };
    let scheduledRun: RunRecord | null = null;
    if (decision.action === "continue") {
      const inputMessageId = turn.outputMessageId ?? turn.inputMessageId;
      this.planTurn(
        current,
        this.repository.listParticipants(current.discussionId),
        inputMessageId,
        "discussion",
        decision,
        current.progress,
        budget,
        budgetEvents
      );
      scheduledRun = this.reconcileDiscussion(current.discussionId).at(0) ?? null;
    } else if (decision.action === "finalize") {
      scheduledRun = this.planFinalization(current, decision, budgetEvents);
    } else {
      this.persistDecision(current, decision, budgetEvents, null);
    }
    return { ...this.view(current.discussionId), scheduledRun, cancelRunId: null };
  }

  private planContinuation(
    discussion: DiscussionRecord,
    budgetEvent: DiscussionBudgetEvent | null
  ): RunRecord | null {
    const turns = this.repository.listTurns(discussion.discussionId);
    const inputMessageId = turns.at(-1)?.outputMessageId ?? discussion.rootMessageId;
    const decision: PolicyDecision = {
      action: "continue",
      state: "active",
      reason: null,
      outputMode: "none",
      grantAutomaticLease: false
    };
    this.planTurn(
      discussion,
      this.repository.listParticipants(discussion.discussionId),
      inputMessageId,
      "discussion",
      decision,
      discussion.progress,
      discussion.budget,
      budgetEvent ? [budgetEvent] : []
    );
    return this.reconcileDiscussion(discussion.discussionId).at(0) ?? null;
  }

  private planFinalization(
    discussion: DiscussionRecord,
    decision: PolicyDecision,
    usageEvents: DiscussionBudgetEvent[]
  ): RunRecord | null {
    const participants = this.repository.listParticipants(discussion.discussionId);
    const finalizer = participants.find(({ role }) => role === "reviewer") ?? participants[0];
    if (!finalizer) {
      throw new Error("Discussion has no finalizer");
    }
    const turns = this.repository.listTurns(discussion.discussionId);
    const inputMessageId = turns.at(-1)?.outputMessageId ?? discussion.rootMessageId;
    const budgetEvent = this.newBudgetEvent(discussion, "finalization_reserved", {
      turns: 1,
      durationSeconds: discussion.budget.durationSeconds,
      metadata: {}
    }, usageEvents.length);
    this.planTurn(
      discussion,
      participants,
      inputMessageId,
      "finalization",
      decision,
      discussion.progress,
      discussion.budget,
      [...usageEvents, budgetEvent],
      finalizer.agentId
    );
    return this.reconcileDiscussion(discussion.discussionId).at(0) ?? null;
  }

  private planTurn(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[],
    inputMessageId: string,
    kind: DiscussionTurn["kind"],
    decision: PolicyDecision,
    progress: ProgressSnapshot,
    budget: DiscussionRecord["budget"],
    budgetEvents: DiscussionBudgetEvent[],
    forcedAgentId?: string
  ): DiscussionTurn {
    const participant = forcedAgentId
      ? participants.find(({ agentId }) => agentId === forcedAgentId)
      : participants[discussion.nextSpeakerIndex % participants.length];
    if (!participant) {
      throw new Error("Discussion has no eligible next participant");
    }
    const now = this.clock();
    const turn: DiscussionTurn = {
      turnId: createOpaqueId("turn"),
      discussionId: discussion.discussionId,
      ordinal: discussion.currentTurn + 1,
      kind,
      speakerAgentId: participant.agentId,
      inputMessageId,
      runId: null,
      outputMessageId: null,
      state: "planned",
      assessment: null,
      replyHash: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    };
    const nextSpeakerIndex = kind === "discussion"
      ? (participant.ordinal + 1) % participants.length
      : discussion.nextSpeakerIndex;
    this.repository.recordDecisionAndPlanTurn({
      decision: {
        decisionId: createOpaqueId("decision"),
        discussionId: discussion.discussionId,
        aggregateVersion: discussion.version,
        progressVersion: progress.version,
        action: decision.action,
        reason: decision.reason ?? "discussion_active",
        nextAgentId: participant.agentId,
        outputMode: decision.outputMode,
        createdAt: now
      },
      turn,
      expectedVersion: discussion.version,
      state: decision.state,
      stateReason: decision.reason,
      outputMode: decision.action === "finalize"
        ? decision.outputMode
        : discussion.outputMode,
      progress,
      budget,
      nextSpeakerIndex,
      requestedAction: null,
      ...(budgetEvents.length > 0 ? { budgetEvents } : {})
    });
    return turn;
  }

  private persistDecision(
    discussion: DiscussionRecord,
    decision: PolicyDecision,
    budgetEvents: DiscussionBudgetEvent[],
    terminalAt: string | null
  ): DiscussionRecord {
    const now = this.clock();
    return this.repository.recordDecisionAndUpdate({
      decision: {
        decisionId: createOpaqueId("decision"),
        discussionId: discussion.discussionId,
        aggregateVersion: discussion.version,
        progressVersion: discussion.progress.version,
        action: decision.action,
        reason: decision.reason ?? "discussion_active",
        nextAgentId: null,
        outputMode: decision.outputMode,
        createdAt: now
      },
      expectedVersion: discussion.version,
      state: decision.state,
      stateReason: decision.reason,
      outputMode: decision.action === "finalize"
        ? decision.outputMode
        : discussion.outputMode,
      progress: discussion.progress,
      budget: discussion.budget,
      nextSpeakerIndex: discussion.nextSpeakerIndex,
      requestedAction: null,
      terminalAt,
      ...(budgetEvents.length > 0 ? { budgetEvents } : {})
    });
  }

  private ensureRun(turn: DiscussionTurn): RunRecord | null {
    if (turn.runId) {
      return this.runs.getRun(turn.runId) ?? null;
    }
    const discussion = this.requireDiscussion(turn.discussionId);
    const existing = this.runs.findByTrigger(turn.inputMessageId)
      .find(({ targetAgentId }) => targetAgentId === turn.speakerAgentId);
    if (existing) {
      this.repository.bindTurnRun(turn.turnId, existing.runId,
        existing.state === "working" ? "working" : "queued", this.clock());
      return existing;
    }
    const previousRun = this.repository.listTurns(turn.discussionId)
      .filter(({ ordinal }) => ordinal < turn.ordinal)
      .at(-1)?.runId ?? null;
    const inputMessage = this.core.getMessage(turn.inputMessageId);
    if (!inputMessage) {
      throw new Error(`Discussion input Message not found: ${turn.inputMessageId}`);
    }
    const now = this.clock();
    const run: RunRecord = {
      runId: createOpaqueId("run"),
      traceId: inputMessage.traceId,
      roomId: discussion.roomId,
      triggerMessageId: turn.inputMessageId,
      requesterMemberId: discussion.requesterMemberId,
      targetAgentId: turn.speakerAgentId,
      parentRunId: previousRun,
      instruction: this.buildInstruction(discussion, turn),
      state: "queued",
      lastSequence: 0,
      deadlineAt: turn.kind === "finalization"
        ? new Date(Date.parse(now) + finalizationDurationMilliseconds).toISOString()
        : discussion.deadlineAt,
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    };
    this.runs.createRuns([run]);
    this.repository.bindTurnRun(turn.turnId, run.runId, "queued", now);
    return run;
  }

  private buildInstruction(
    discussion: DiscussionRecord,
    turn: DiscussionTurn
  ): string {
    const participants = this.repository.listParticipants(discussion.discussionId)
      .map((participant) => {
        const agent = this.core.getAgent(participant.agentId);
        return `${agent?.name ?? participant.agentId} (${participant.role})`;
      });
    const trigger = this.core.getMessage(turn.inputMessageId);
    const transcript = trigger
      ? this.core.listMessagesThrough(discussion.roomId, trigger.sequence, 12)
      : [];
    const remainingLease = Math.max(
      0,
      discussion.budget.leaseEndTurn - discussion.budget.turnsUsed
    );
    const unresolved = discussion.progress.openQuestions.length === 0
      ? "None recorded"
      : discussion.progress.openQuestions
        .map(({ question, importance }) => `- [${importance}] ${question}`)
        .join("\n");
    const transcriptText = transcript.map((message) =>
      `[${this.senderName(message)}] ${redactSensitiveText(message.content)}`
    ).join("\n");
    const task = turn.kind === "finalization"
      ? `Produce the final ${discussion.outputMode.replaceAll("_", " ")} now. ` +
        "Synthesize the best supported conclusion, important unresolved issues, and next actions."
      : "Reply to the other Team participants with the next useful contribution. " +
        "Do not repeat agreement without adding evidence, resolving a question, or changing the conclusion.";
    return [
      "# Agent Room Discussion Context",
      `Discussion ID: ${discussion.discussionId}`,
      `Turn: ${turn.ordinal}`,
      `Mode: ${discussion.mode}`,
      `Participants: ${participants.join(", ")}`,
      "",
      "## Goal",
      discussion.goal,
      "",
      "## Progress",
      `Confidence: ${discussion.progress.confidence ?? "unknown"}`,
      `Disagreement: ${discussion.progress.disagreementRemaining}`,
      `Plateau count: ${discussion.progress.plateauCount}`,
      "Important unresolved questions:",
      unresolved,
      "",
      "## Remaining Lease",
      `${remainingLease} ordinary turns; token and cost telemetry may be unknown.`,
      "",
      "## Recent Room Transcript",
      transcriptText,
      "",
      "## Your Task",
      task,
      "The Orchestrator, not you, decides whether the Discussion continues. " +
        "A plain-text reply is always valid when structured assessment is unsupported.",
      "When supported, append one final line exactly in this form: " +
        "<agentroom-assessment>{\"goalSatisfied\":false," +
        "\"confidence\":0.7,\"newInformationAdded\":true," +
        "\"recommendation\":\"continue\"}</agentroom-assessment>. " +
        "This is evidence only; it does not control the next action."
    ].join("\n").slice(0, 20_000);
  }

  private senderName(message: MessageRecord): string {
    if (message.senderType === "agent") {
      return this.core.getAgent(message.senderId)?.name ?? message.senderId;
    }
    if (message.senderType === "member") {
      return this.core.getMember(message.senderId)?.displayName ?? message.senderId;
    }
    return "System";
  }

  private appendFallbackConclusion(
    discussion: DiscussionRecord,
    parentMessageId: string
  ): void {
    const parent = this.core.getMessage(parentMessageId);
    const unresolved = discussion.progress.openQuestions.length === 0
      ? "暂无记录的未决问题。"
      : discussion.progress.openQuestions
        .map(({ question, importance }) => `- [${importance}] ${question}`)
        .join("\n");
    this.core.appendMessage({
      messageId: createOpaqueId("msg"),
      roomId: discussion.roomId,
      senderType: "system",
      senderId: discussion.discussionId,
      content: `讨论已停止，最终生成器未能完成。\n\n未决问题：\n${unresolved}`,
      mentions: [],
      parentMessageId,
      ...(parent ? { traceId: parent.traceId } : {}),
      createdAt: this.clock()
    });
  }

  private newBudgetEvent(
    discussion: DiscussionRecord,
    eventType: DiscussionBudgetEvent["eventType"],
    input: {
      turns: number;
      durationSeconds?: number;
      metadata: Record<string, unknown>;
    },
    ordinalOffset = 0
  ): DiscussionBudgetEvent {
    return {
      budgetEventId: createOpaqueId("budget"),
      discussionId: discussion.discussionId,
      ordinal: this.repository.listBudgetEvents(discussion.discussionId).length +
        ordinalOffset + 1,
      eventType,
      turns: input.turns,
      tokens: null,
      durationSeconds: input.durationSeconds ?? discussion.budget.durationSeconds,
      estimatedCostMicros: null,
      metadata: input.metadata,
      createdAt: this.clock()
    };
  }

  private latestActiveTurn(discussionId: string): DiscussionTurn | null {
    const turn = this.repository.listTurns(discussionId).at(-1);
    return turn && !new Set(["completed", "failed", "canceled"]).has(turn.state)
      ? turn
      : null;
  }

  private view(discussionId: string): DiscussionView {
    return {
      discussion: this.requireDiscussion(discussionId),
      participants: this.repository.listParticipants(discussionId),
      turns: this.repository.listTurns(discussionId),
      decisions: this.repository.listDecisions(discussionId)
    };
  }

  private requireDiscussion(discussionId: string): DiscussionRecord {
    const discussion = this.repository.get(discussionId);
    if (!discussion) {
      throw new Error(`Discussion not found: ${discussionId}`);
    }
    return discussion;
  }
}
