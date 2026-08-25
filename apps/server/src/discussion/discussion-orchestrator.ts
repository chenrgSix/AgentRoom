import type { CoreRepository, MessageRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRecord, RunRepository } from "../run/run-repository.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import { redactSensitiveText } from "../security/redaction.js";
import type { MessageService } from "../team-room/message-service.js";
import type { AgentTaskRepository } from "../task/task-repository.js";
import {
  grantDiscussionLease,
  inspectBudget,
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
  type DiscussionWave,
  type ProgressSnapshot
} from "./discussion-types.js";
import {
  terminalDiscussionStates,
  terminalRunStates,
  terminalTurnStates,
  waveCloseState
} from "./discussion-state.js";
import {
  buildWavePlan,
  selectFinalizer,
  type WavePlan
} from "./discussion-wave-planner.js";
import {
  evaluateWaveProgress,
  hashDiscussionReply,
  parseAgentAssessment
} from "./progress-evaluator.js";

const maximumParticipants = 5;

export interface DiscussionView {
  discussion: DiscussionRecord;
  participants: DiscussionParticipant[];
  waves: DiscussionWave[];
  turns: DiscussionTurn[];
  decisions: DiscussionDecision[];
}

export interface DiscussionMutationResult extends DiscussionView {
  scheduledRuns: RunRecord[];
  cancelRunIds: string[];
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
  requiredInteger(policy.waveTimeoutSeconds, "waveTimeoutSeconds", 30, 7_200);
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
    private readonly tasks: AgentTaskRepository,
    private readonly clock: () => string
  ) {}

  public create(
    principal: WebPrincipal,
    input: {
      roomId: string;
      taskId?: string;
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
    if (!room.collaborationPolicy.allowDiscussion) {
      throw new Error("Room policy does not allow Agent Discussions");
    }
    const task = input.taskId
      ? this.tasks.get(input.taskId)
      : this.tasks.getDefaultForRoom(input.roomId);
    if (
      !task || task.roomId !== input.roomId ||
      task.state === "completed" || task.state === "canceled"
    ) {
      throw new Error("Discussion Task must be runnable in the target Room");
    }
    const openDiscussion = this.repository.listForRoom(input.roomId).find(
      ({ state, taskId }) => taskId === task.taskId &&
        !terminalDiscussionStates.has(state)
    );
    if (openDiscussion) {
      throw new Error(
        `Task already has an active Discussion: ${openDiscussion.discussionId}`
      );
    }
    const participantAgents = uniqueAgentIds.map((agentId) => {
      const agent = this.core.getAgent(agentId);
      if (
        !agent ||
        !agent.enabled ||
        agent.teamId !== room.teamId ||
        !this.core.isRoomAgent(room.roomId, agentId)
      ) {
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
      taskId: task.taskId,
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
      taskId: task.taskId,
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
      executionModel: "parallel_wave",
      currentTurn: 0,
      currentWave: 0,
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
      metadata: { source: "initial", unit: "wave" },
      createdAt: now
    });
    this.persistWavePlan({
      discussion,
      participants,
      inputMessageId: rootMessage.messageId,
      kind: "discussion",
      decision: {
        action: "continue",
        state: "active",
        reason: null,
        outputMode: "none",
        grantAutomaticLease: false
      },
      progress: discussion.progress,
      budget: discussion.budget,
      budgetEvents: []
    });
    return this.mutationResult(discussionId, this.reconcileDiscussion(discussionId));
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
      return this.mutationResult(discussionId);
    }
    const activeWave = this.latestOpenWave(discussionId);
    if (input.action === "cancel") {
      const cancelRunIds = activeWave
        ? this.repository.listTurnsForWave(activeWave.waveId)
          .filter(({ state, runId }) => !terminalTurnStates.has(state) && runId)
          .map(({ runId }) => runId!)
        : [];
      const decision = decideDiscussion({
        progress: discussion.progress,
        budget: discussion.budget,
        policy: discussion.policy,
        requestedOutputMode: discussion.outputMode,
        userIntent: "cancel"
      });
      this.persistDecision(discussion, decision, [], this.clock());
      return this.mutationResult(discussionId, [], cancelRunIds);
    }
    if (discussion.state === "finalizing") {
      if (input.action === "finish" || input.action === "stop_after_turn") {
        return this.mutationResult(discussionId);
      }
      throw new Error(`Discussion cannot ${input.action} while finalizing`);
    }
    if (input.action === "adjust_goal") {
      if (
        activeWave ||
        !new Set(["awaiting_extension", "waiting_human", "paused"]).has(discussion.state)
      ) {
        throw new Error(`Discussion cannot adjust its goal from ${discussion.state}`);
      }
      const goal = input.goal?.trim() ?? "";
      if (goal.length === 0 || goal.length > 20_000) {
        throw new Error("Adjusted goal must contain 1 to 20000 characters");
      }
      const resume = this.prepareResumeBudget(discussion, input.extensionTurns);
      discussion = this.repository.updateGoal({
        discussionId,
        expectedVersion: discussion.version,
        goal,
        now: this.clock()
      });
      discussion = { ...discussion, budget: resume.budget };
      if (inspectBudget(discussion.budget, discussion.policy).hardBoundaryReached) {
        const boundaryDecision = decideDiscussion({
          progress: discussion.progress,
          budget: discussion.budget,
          policy: discussion.policy,
          requestedOutputMode: discussion.outputMode
        });
        return this.mutationResult(
          discussionId,
          this.planFinalization(
            discussion,
            boundaryDecision,
            resume.budgetEvent ? [resume.budgetEvent] : []
          )
        );
      }
      return this.mutationResult(
        discussionId,
        this.planContinuation(discussion, resume.budgetEvent)
      );
    }
    if (input.action === "continue") {
      if (!new Set(["awaiting_extension", "waiting_human", "paused"]).has(discussion.state)) {
        throw new Error(`Discussion cannot continue from ${discussion.state}`);
      }
      if (activeWave) {
        throw new Error("Discussion cannot continue while a Wave is still open");
      }
      const resume = this.prepareResumeBudget(discussion, input.extensionTurns);
      if (inspectBudget(resume.budget, discussion.policy).hardBoundaryReached) {
        const boundaryDecision = decideDiscussion({
          progress: discussion.progress,
          budget: resume.budget,
          policy: discussion.policy,
          requestedOutputMode: discussion.outputMode
        });
        return this.mutationResult(
          discussionId,
          this.planFinalization(
            { ...discussion, budget: resume.budget },
            boundaryDecision,
            resume.budgetEvent ? [resume.budgetEvent] : []
          )
        );
      }
      const active = {
        ...discussion,
        state: "active" as const,
        stateReason: null,
        requestedAction: null,
        budget: resume.budget
      };
      return this.mutationResult(
        discussionId,
        this.planContinuation(active, resume.budgetEvent)
      );
    }

    const intent = input.action as Exclude<DiscussionUserIntent, "cancel" | null>;
    if (activeWave) {
      this.repository.requestAction({
        discussionId,
        expectedVersion: discussion.version,
        action: input.action,
        state: "stop_requested",
        stateReason: input.action === "pause" ? "user_paused" : "user_requested_finish",
        now: this.clock()
      });
      return this.mutationResult(discussionId);
    }
    const decision = decideDiscussion({
      progress: discussion.progress,
      budget: discussion.budget,
      policy: discussion.policy,
      requestedOutputMode: discussion.outputMode,
      userIntent: intent
    });
    if (decision.action === "finalize") {
      return this.mutationResult(
        discussionId,
        this.planFinalization(discussion, decision, [])
      );
    }
    this.persistDecision(discussion, decision, [], null);
    return this.mutationResult(discussionId);
  }

  public onRunTerminal(runId: string): DiscussionMutationResult | null {
    const run = this.runs.getRun(runId);
    const existingTurn = this.repository.findTurnByRun(runId);
    if (!run || !existingTurn || !terminalRunStates.has(run.state)) {
      return null;
    }
    if (!existingTurn.waveId) {
      throw new Error(`Discussion Turn has no Wave: ${existingTurn.turnId}`);
    }
    const output = this.core.findAgentReply(
      existingTurn.inputMessageId,
      existingTurn.speakerAgentId
    );
    const replyEvent = this.runs.listEvents(runId)
      .filter(({ event }) => event.type === "reply")
      .at(-1)?.event as { assessment?: unknown } | undefined;
    const successful = run.state === "completed" && output !== undefined;
    this.repository.settleTurn({
      turnId: existingTurn.turnId,
      outputMessageId: successful ? output.messageId : null,
      state: successful ? "completed" : run.state === "canceled" ? "canceled" : "failed",
      assessment: successful ? parseAgentAssessment(replyEvent?.assessment) : null,
      replyHash: successful ? hashDiscussionReply(output.content) : null,
      terminalReason: successful ? null : this.terminalReason(run, output !== undefined),
      now: this.clock()
    });

    const discussion = this.requireDiscussion(existingTurn.discussionId);
    const wave = this.repository.getWave(existingTurn.waveId);
    if (!wave || wave.state !== "open") {
      return this.mutationResult(discussion.discussionId);
    }
    const turns = this.repository.listTurnsForWave(wave.waveId);
    if (turns.some(({ state }) => !terminalTurnStates.has(state))) {
      return this.mutationResult(existingTurn.discussionId);
    }
    return this.advanceReadyWave(discussion, wave, turns);
  }

  private advanceReadyWave(
    discussion: DiscussionRecord,
    wave: DiscussionWave,
    turns: DiscussionTurn[]
  ): DiscussionMutationResult {
    const closeState = waveCloseState(turns);
    if (terminalDiscussionStates.has(discussion.state)) {
      this.repository.closeWave({
        waveId: wave.waveId,
        expectedVersion: wave.version,
        state: closeState,
        now: this.clock()
      });
      return this.mutationResult(discussion.discussionId);
    }
    if (wave.phase === "finalization") {
      const finalizationSucceeded = turns.some(({ state }) => state === "completed");
      const terminalState = discussion.stateReason === "hard_budget_exhausted"
        ? "terminated" as const
        : "completed" as const;
      if (!finalizationSucceeded) {
        this.appendFallbackConclusion(discussion, wave.inputMessageId);
      }
      this.repository.closeFinalizationAndFinish({
        discussionId: discussion.discussionId,
        expectedDiscussionVersion: discussion.version,
        state: terminalState,
        waveId: wave.waveId,
        expectedWaveVersion: wave.version,
        waveState: closeState,
        now: this.clock()
      });
      return this.mutationResult(discussion.discussionId);
    }
    return this.advanceSettledWave(discussion, wave, turns);
  }

  public onRunInputRequired(runId: string): DiscussionMutationResult | null {
    const run = this.runs.getRun(runId);
    if (!run || run.state !== "input_required" || !this.repository.findTurnByRun(runId)) {
      return null;
    }
    const terminal = this.runs.applyEvent(runId, {
      type: "status",
      sequence: run.lastSequence + 1,
      status: "outcome_unknown",
      error: {
        code: "DISCUSSION_INPUT_REQUIRED",
        message: "This Discussion Runtime requires human input that the Wave cannot resume.",
        retryable: false
      }
    }, this.clock()).run;
    return this.onRunTerminal(terminal.runId);
  }

  public recover(): RunRecord[] {
    const scheduled = new Map<string, RunRecord>();
    this.recoverCanceledWaves();
    for (const run of this.expireDueWaves()) {
      scheduled.set(run.runId, run);
    }
    for (const discussion of this.repository.listOpen()) {
      const waves = this.repository.listWaves(discussion.discussionId);
      if (
        discussion.state !== "active" ||
        waves.some(({ state }) => state === "open")
      ) {
        continue;
      }
      for (const run of this.recoverActiveWithoutWave(discussion)) {
        scheduled.set(run.runId, run);
      }
    }
    for (const discussion of this.repository.listOpen()) {
      for (const run of this.reconcileDiscussion(discussion.discussionId)) {
        scheduled.set(run.runId, run);
      }
    }
    for (const wave of this.repository.listOpenWaves()) {
      for (const turn of this.repository.listTurnsForWave(wave.waveId)) {
        if (!turn.runId) continue;
        const run = this.runs.getRun(turn.runId);
        if (!run || !terminalRunStates.has(run.state)) continue;
        const result = this.onRunTerminal(run.runId);
        for (const next of result?.scheduledRuns ?? []) {
          scheduled.set(next.runId, next);
        }
      }
    }
    const now = Date.parse(this.clock());
    return [...scheduled.values()].filter((run) => {
      if (run.state !== "queued") return false;
      const turn = this.repository.findTurnByRun(run.runId);
      const wave = turn?.waveId ? this.repository.getWave(turn.waveId) : undefined;
      return Boolean(
        wave?.state === "open" &&
        Date.parse(wave.deadlineAt) > now &&
        !terminalDiscussionStates.has(
          this.repository.get(turn!.discussionId)?.state ?? "terminated"
        )
      );
    });
  }

  private recoverActiveWithoutWave(discussion: DiscussionRecord): RunRecord[] {
    const budget = this.refreshElapsedBudget(discussion);
    const current = { ...discussion, budget };
    let decision = decideDiscussion({
      progress: current.progress,
      budget: current.budget,
      policy: current.policy,
      requestedOutputMode: current.outputMode
    });
    const budgetEvents: DiscussionBudgetEvent[] = [];
    if (decision.grantAutomaticLease) {
      const previous = current.budget;
      current.budget = grantDiscussionLease({
        previous,
        policy: current.policy,
        source: "automatic"
      });
      budgetEvents.push(this.newBudgetEvent(current, "extension_granted", {
        turns: current.budget.leaseEndTurn - previous.leaseEndTurn,
        durationSeconds: current.budget.durationSeconds,
        metadata: { source: "automatic", unit: "wave" }
      }));
      decision = { ...decision, grantAutomaticLease: false };
    }
    if (decision.action === "continue") {
      return this.planContinuation(current, budgetEvents[0] ?? null);
    }
    if (decision.action === "finalize") {
      if (
        decision.reason === "hard_budget_exhausted" &&
        (current.currentWave ?? 0) === 0 &&
        this.repository.listWaves(current.discussionId).length === 0
      ) {
        this.appendFallbackConclusion(current, current.rootMessageId);
        this.persistDecision(
          current,
          { ...decision, state: "terminated" },
          budgetEvents,
          this.clock()
        );
        return [];
      }
      return this.planFinalization(current, decision, budgetEvents);
    }
    this.persistDecision(
      current,
      decision,
      budgetEvents,
      decision.action === "cancel" || decision.action === "terminate"
        ? this.clock()
        : null
    );
    return [];
  }

  private recoverCanceledWaves(): void {
    const now = this.clock();
    for (const wave of this.repository.listOpenWaves()) {
      const discussion = this.repository.get(wave.discussionId);
      if (discussion?.state !== "canceled") continue;
      for (const turn of this.repository.listTurnsForWave(wave.waveId)) {
        if (terminalTurnStates.has(turn.state)) continue;
        if (!turn.runId) {
          this.repository.settleTurn({
            turnId: turn.turnId,
            outputMessageId: null,
            state: "canceled",
            assessment: null,
            replyHash: null,
            terminalReason: "discussion_canceled_before_dispatch",
            now
          });
          continue;
        }
        let run = this.runs.getRun(turn.runId);
        if (!run) continue;
        if (!terminalRunStates.has(run.state)) {
          const neverAccepted = run.state === "queued";
          run = this.runs.applyEvent(run.runId, {
            type: "status",
            sequence: run.lastSequence + 1,
            status: neverAccepted ? "canceled" : "outcome_unknown",
            error: {
              code: neverAccepted
                ? "DISCUSSION_CANCELED"
                : "DISCUSSION_CANCEL_RECOVERY_UNKNOWN",
              message: neverAccepted
                ? "The Discussion was canceled before this Run was accepted."
                : "The server restarted before cancellation reached a known Runtime outcome.",
              retryable: false
            }
          }, now).run;
        }
        this.onRunTerminal(run.runId);
      }
      const currentWave = this.repository.getWave(wave.waveId);
      const members = this.repository.listTurnsForWave(wave.waveId);
      if (
        currentWave?.state === "open" &&
        members.every(({ state }) => terminalTurnStates.has(state))
      ) {
        this.repository.closeWave({
          waveId: wave.waveId,
          expectedVersion: currentWave.version,
          state: waveCloseState(members),
          now
        });
      }
    }
  }

  public expireDueWaves(): RunRecord[] {
    const now = this.clock();
    const scheduled = new Map<string, RunRecord>();
    const dueWaves = this.repository.listOpenWaves()
      .filter(({ deadlineAt }) => Date.parse(deadlineAt) <= Date.parse(now));
    for (const wave of dueWaves) {
      for (const currentTurn of this.repository.listTurnsForWave(wave.waveId)) {
        let run = currentTurn.runId
          ? this.runs.getRun(currentTurn.runId)
          : this.ensureRun(currentTurn);
        if (!run) continue;
        if (!terminalRunStates.has(run.state)) {
          const accepted = run.state !== "queued";
          run = this.runs.applyEvent(run.runId, {
            type: "status",
            sequence: run.lastSequence + 1,
            status: accepted ? "outcome_unknown" : "expired",
            error: {
              code: accepted ? "DISCUSSION_WAVE_DEADLINE_UNKNOWN" : "RUN_EXPIRED",
              message: accepted
                ? "The Discussion Wave deadline passed before a terminal Runtime outcome."
                : "The Run expired before its Discussion Wave deadline.",
              retryable: false
            }
          }, now).run;
        }
        const result = this.onRunTerminal(run.runId);
        for (const next of result?.scheduledRuns ?? []) {
          if (next.state === "queued") scheduled.set(next.runId, next);
        }
      }
    }
    return [...scheduled.values()];
  }

  public reconcileDiscussion(discussionId: string): RunRecord[] {
    const discussion = this.requireDiscussion(discussionId);
    const eligibleAgentIds = new Set(
      this.eligibleParticipants(
        discussion,
        this.repository.listParticipants(discussionId)
      ).map(({ agentId }) => agentId)
    );
    const affectedWaves = new Set<string>();
    for (const turn of this.repository.listTurns(discussionId)) {
      if (turn.state !== "planned" || eligibleAgentIds.has(turn.speakerAgentId)) {
        continue;
      }
      this.repository.settleTurn({
        turnId: turn.turnId,
        outputMessageId: null,
        state: "failed",
        assessment: null,
        replyHash: null,
        terminalReason: "agent_unavailable",
        now: this.clock()
      });
      if (turn.waveId) affectedWaves.add(turn.waveId);
    }
    const planned = this.repository.listTurns(discussionId)
      .filter(({ state }) => state === "planned");
    for (const waveId of new Set(
      planned.map(({ waveId }) => waveId).filter((value): value is string => Boolean(value))
    )) {
      this.preparePlannedWaveAnchor(waveId);
    }
    const scheduled = this.repository.listTurns(discussionId)
      .filter(({ state }) => state === "planned" || state === "queued")
      .map((turn) => this.ensureRun(turn))
      .filter((run): run is RunRecord => run?.state === "queued");
    for (const waveId of affectedWaves) {
      const wave = this.repository.getWave(waveId);
      const turns = this.repository.listTurnsForWave(waveId);
      if (
        wave?.state !== "open" ||
        turns.some(({ state }) => !terminalTurnStates.has(state))
      ) {
        continue;
      }
      const result = this.advanceReadyWave(
        this.requireDiscussion(discussionId),
        wave,
        turns
      );
      scheduled.push(...result.scheduledRuns);
    }
    return [...new Map(scheduled.map((run) => [run.runId, run])).values()];
  }

  private advanceSettledWave(
    discussion: DiscussionRecord,
    wave: DiscussionWave,
    turns: DiscussionTurn[]
  ): DiscussionMutationResult {
    const participants = this.repository.listParticipants(discussion.discussionId);
    const eligibleParticipants = this.eligibleParticipants(discussion, participants);
    const participantByAgent = new Map(
      participants.map((participant) => [participant.agentId, participant])
    );
    const successfulResults = turns.flatMap((turn) => {
      if (turn.state !== "completed" || !turn.outputMessageId) return [];
      const output = this.core.getMessage(turn.outputMessageId);
      if (!output) return [];
      return [{
        participantOrdinal: turn.waveMemberOrdinal ?? 0,
        reply: output.content,
        assessment: turn.assessment,
        speakerIsReviewer: participantByAgent.get(turn.speakerAgentId)?.role === "reviewer"
      }];
    });
    const evaluation = evaluateWaveProgress({
      previous: discussion.progress,
      successfulResults,
      policy: discussion.policy
    });
    const nextInputMessageId = this.ensureWaveResultAnchor(
      discussion,
      wave,
      turns,
      this.clock()
    );
    let budget = recordTurnUsage({
      previous: discussion.budget,
      agentRuns: wave.expectedMembers,
      discussionStartedAt: discussion.createdAt,
      now: this.clock()
    });
    const closeState = waveCloseState(turns);
    const outcomeCounts = {
      completed: turns.filter(({ state }) => state === "completed").length,
      failed: turns.filter(({ state }) => state === "failed").length,
      canceled: turns.filter(({ state }) => state === "canceled").length
    };
    const budgetEvents = [this.newBudgetEvent(discussion, "turn_recorded", {
      turns: 1,
      durationSeconds: budget.durationSeconds,
      metadata: {
        unit: "wave",
        waveId: wave.waveId,
        waveOrdinal: wave.ordinal,
        agentRuns: wave.expectedMembers,
        outcomes: outcomeCounts,
        tokenTelemetryKnown: budget.tokenTelemetryKnown,
        costTelemetryKnown: budget.costTelemetryKnown
      }
    })];
    let decision = decideDiscussion({
      progress: evaluation.snapshot,
      budget,
      policy: discussion.policy,
      requestedOutputMode: discussion.outputMode,
      userIntent: discussion.requestedAction,
      runtimeInputRequired: turns.some(
        ({ terminalReason }) => terminalReason === "input_required"
      ),
      runtimeFailed: successfulResults.length === 0
    });
    if (eligibleParticipants.length === 0 && decision.action === "continue") {
      decision = {
        action: "wait_human",
        state: "waiting_human",
        reason: "runtime_failure",
        outputMode: "none",
        grantAutomaticLease: false
      };
    } else if (
      eligibleParticipants.length === 0 && decision.action === "finalize"
    ) {
      this.appendFallbackConclusion(discussion, nextInputMessageId);
      decision = decision.reason === "hard_budget_exhausted"
        ? {
            ...decision,
            state: "terminated",
            reason: "hard_budget_exhausted"
          }
        : {
            ...decision,
            state: "completed",
            reason: "runtime_failure"
          };
    }
    if (decision.grantAutomaticLease) {
      const previousBudget = budget;
      budget = grantDiscussionLease({
        previous: budget,
        policy: discussion.policy,
        source: "automatic"
      });
      budgetEvents.push(this.newBudgetEvent(discussion, "extension_granted", {
        turns: budget.leaseEndTurn - previousBudget.leaseEndTurn,
        durationSeconds: budget.durationSeconds,
        metadata: { source: "automatic", unit: "wave" }
      }, budgetEvents.length));
    }
    const now = this.clock();
    let nextWave: WavePlan | undefined;
    if (decision.action === "continue") {
      nextWave = buildWavePlan({
        discussion,
        participants: eligibleParticipants,
        inputMessageId: nextInputMessageId,
        kind: "discussion",
        now
      });
    } else if (
      decision.action === "finalize" && eligibleParticipants.length > 0
    ) {
      const finalizer = selectFinalizer(eligibleParticipants);
      nextWave = buildWavePlan({
        discussion,
        participants: [finalizer],
        inputMessageId: nextInputMessageId,
        kind: "finalization",
        now
      });
      budget = { ...budget, agentRunsUsed: budget.agentRunsUsed + 1 };
      budgetEvents.push(this.newBudgetEvent(discussion, "finalization_reserved", {
        turns: 1,
        durationSeconds: budget.durationSeconds,
        metadata: { waveId: nextWave.wave.waveId, unit: "wave", agentRuns: 1 }
      }, budgetEvents.length));
    }
    const persisted = this.repository.closeReadyWaveAndApply({
      waveId: wave.waveId,
      expectedWaveVersion: wave.version,
      closeState,
      closedAt: now,
      decision: this.newDecision(
        discussion,
        decision,
        evaluation.snapshot,
        decision.action === "finalize"
          ? nextWave?.turns[0]?.speakerAgentId ?? null
          : null,
        now
      ),
      expectedDiscussionVersion: discussion.version,
      state: decision.state,
      stateReason: decision.reason,
      outputMode: decision.action === "finalize"
        ? decision.outputMode
        : discussion.outputMode,
      progress: evaluation.snapshot,
      budget,
      nextSpeakerIndex: discussion.nextSpeakerIndex,
      requestedAction: null,
      terminalAt: terminalDiscussionStates.has(decision.state)
        ? now
        : null,
      budgetEvents,
      ...(nextWave ? { nextWave } : {})
    });
    if (!persisted.applied) {
      return this.mutationResult(discussion.discussionId);
    }
    return this.mutationResult(
      discussion.discussionId,
      nextWave ? this.reconcileDiscussion(discussion.discussionId) : []
    );
  }

  private planContinuation(
    discussion: DiscussionRecord,
    budgetEvent: DiscussionBudgetEvent | null
  ): RunRecord[] {
    const participants = this.eligibleParticipants(
      discussion,
      this.repository.listParticipants(discussion.discussionId)
    );
    if (participants.length === 0) {
      const decision: PolicyDecision = {
        action: "wait_human",
        state: "waiting_human",
        reason: "runtime_failure",
        outputMode: "none",
        grantAutomaticLease: false
      };
      this.persistDecision(
        discussion,
        decision,
        budgetEvent ? [budgetEvent] : [],
        null
      );
      return [];
    }
    this.persistWavePlan({
      discussion,
      participants,
      inputMessageId: this.latestOutputMessageId(discussion),
      kind: "discussion",
      decision: {
        action: "continue",
        state: "active",
        reason: null,
        outputMode: "none",
        grantAutomaticLease: false
      },
      progress: discussion.progress,
      budget: discussion.budget,
      budgetEvents: budgetEvent ? [budgetEvent] : []
    });
    return this.reconcileDiscussion(discussion.discussionId);
  }

  private planFinalization(
    discussion: DiscussionRecord,
    decision: PolicyDecision,
    usageEvents: DiscussionBudgetEvent[]
  ): RunRecord[] {
    const participants = this.eligibleParticipants(
      discussion,
      this.repository.listParticipants(discussion.discussionId)
    );
    if (participants.length === 0) {
      this.appendFallbackConclusion(
        discussion,
        this.latestOutputMessageId(discussion)
      );
      const hardBudgetExhausted = decision.reason === "hard_budget_exhausted";
      this.persistDecision(
        discussion,
        hardBudgetExhausted
          ? {
              ...decision,
              state: "terminated",
              reason: "hard_budget_exhausted"
            }
          : { ...decision, state: "completed", reason: "runtime_failure" },
        usageEvents,
        this.clock()
      );
      return [];
    }
    const finalizer = selectFinalizer(participants);
    const budget = {
      ...discussion.budget,
      agentRunsUsed: discussion.budget.agentRunsUsed + 1
    };
    const budgetEvent = this.newBudgetEvent(discussion, "finalization_reserved", {
      turns: 1,
      durationSeconds: discussion.budget.durationSeconds,
      metadata: { unit: "wave", agentRuns: 1 }
    }, usageEvents.length);
    this.persistWavePlan({
      discussion,
      participants: [finalizer],
      inputMessageId: this.latestOutputMessageId(discussion),
      kind: "finalization",
      decision,
      progress: discussion.progress,
      budget,
      budgetEvents: [...usageEvents, budgetEvent]
    });
    return this.reconcileDiscussion(discussion.discussionId);
  }

  private persistWavePlan(input: {
    discussion: DiscussionRecord;
    participants: DiscussionParticipant[];
    inputMessageId: string;
    kind: DiscussionTurn["kind"];
    decision: PolicyDecision;
    progress: ProgressSnapshot;
    budget: DiscussionRecord["budget"];
    budgetEvents: DiscussionBudgetEvent[];
  }): WavePlan {
    const now = this.clock();
    const inputMessageId = this.uniqueWaveAnchor(
      input.discussion,
      input.participants,
      input.inputMessageId,
      now
    );
    const plan = buildWavePlan({
      discussion: input.discussion,
      participants: input.participants,
      inputMessageId,
      kind: input.kind,
      now
    });
    this.repository.recordDecisionAndPlanWave({
      decision: this.newDecision(
        input.discussion,
        input.decision,
        input.progress,
        input.kind === "finalization" ? input.participants[0]?.agentId ?? null : null,
        now
      ),
      wave: plan.wave,
      turns: plan.turns,
      expectedVersion: input.discussion.version,
      state: input.decision.state,
      stateReason: input.decision.reason,
      outputMode: input.decision.action === "finalize"
        ? input.decision.outputMode
        : input.discussion.outputMode,
      progress: input.progress,
      budget: input.budget,
      nextSpeakerIndex: input.discussion.nextSpeakerIndex,
      requestedAction: null,
      ...(input.budgetEvents.length > 0 ? { budgetEvents: input.budgetEvents } : {})
    });
    return plan;
  }

  private persistDecision(
    discussion: DiscussionRecord,
    decision: PolicyDecision,
    budgetEvents: DiscussionBudgetEvent[],
    terminalAt: string | null
  ): DiscussionRecord {
    const now = this.clock();
    return this.repository.recordDecisionAndUpdate({
      decision: this.newDecision(discussion, decision, discussion.progress, null, now),
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

  private newDecision(
    discussion: DiscussionRecord,
    decision: PolicyDecision,
    progress: ProgressSnapshot,
    nextAgentId: string | null,
    now: string
  ): DiscussionDecision {
    return {
      decisionId: createOpaqueId("decision"),
      discussionId: discussion.discussionId,
      aggregateVersion: discussion.version,
      progressVersion: progress.version,
      action: decision.action,
      reason: decision.reason ?? "discussion_active",
      nextAgentId,
      outputMode: decision.outputMode,
      createdAt: now
    };
  }

  private ensureRun(turn: DiscussionTurn): RunRecord | null {
    if (turn.runId) {
      return this.runs.getRun(turn.runId) ?? null;
    }
    const byKey = this.runs.findByOrchestrationKey(turn.turnId);
    if (byKey) {
      this.repository.bindTurnRun(
        turn.turnId,
        byKey.runId,
        byKey.state === "working" ? "working" : "queued",
        this.clock()
      );
      return byKey;
    }
    const discussion = this.requireDiscussion(turn.discussionId);
    const collision = this.runs.findByTrigger(turn.inputMessageId)
      .find(({ targetAgentId }) => targetAgentId === turn.speakerAgentId);
    if (collision) {
      const latestAnchor = this.latestOutputMessageId(discussion);
      if (turn.waveId && latestAnchor !== turn.inputMessageId) {
        this.repository.reanchorPlannedWave(turn.waveId, latestAnchor, this.clock());
        const reanchored = this.repository.getTurn(turn.turnId);
        return reanchored ? this.ensureRun(reanchored) : null;
      }
      throw new Error(
        `Discussion Run anchor conflicts with existing Run: ${collision.runId}`
      );
    }
    const previousRun = this.repository.listTurns(turn.discussionId)
      .filter((candidate) =>
        candidate.ordinal < turn.ordinal && candidate.waveId !== turn.waveId
      )
      .at(-1)?.runId ?? null;
    const inputMessage = this.core.getMessage(turn.inputMessageId);
    const wave = turn.waveId ? this.repository.getWave(turn.waveId) : undefined;
    if (!inputMessage) {
      throw new Error(`Discussion input Message not found: ${turn.inputMessageId}`);
    }
    if (!wave) {
      throw new Error(`Discussion Wave not found for Turn: ${turn.turnId}`);
    }
    const now = this.clock();
    const run: RunRecord = {
      runId: createOpaqueId("run"),
      traceId: inputMessage.traceId,
      roomId: discussion.roomId,
      taskId: discussion.taskId,
      triggerMessageId: turn.inputMessageId,
      requesterMemberId: discussion.requesterMemberId,
      targetAgentId: turn.speakerAgentId,
      parentRunId: previousRun,
      instruction: this.buildInstruction(discussion, wave, turn),
      state: "queued",
      lastSequence: 0,
      deadlineAt: wave.deadlineAt,
      createdAt: now,
      updatedAt: now,
      terminalAt: null,
      orchestrationKey: turn.turnId
    };
    this.runs.createRuns([run]);
    this.repository.bindTurnRun(turn.turnId, run.runId, "queued", now);
    return run;
  }

  private preparePlannedWaveAnchor(waveId: string): void {
    const wave = this.repository.getWave(waveId);
    if (!wave || wave.state !== "open") return;
    const turns = this.repository.listTurnsForWave(waveId);
    if (turns.some(({ runId, state }) => runId !== null || state !== "planned")) {
      return;
    }
    const hasCollision = turns.some((turn) =>
      this.runs.findByTrigger(turn.inputMessageId).some((run) =>
        run.targetAgentId === turn.speakerAgentId &&
        run.orchestrationKey !== turn.turnId
      )
    );
    if (!hasCollision) return;
    const discussion = this.requireDiscussion(wave.discussionId);
    const latestAnchor = this.latestOutputMessageId(discussion);
    const plannedAgents = new Set(turns.map(({ speakerAgentId }) => speakerAgentId));
    const replacement = this.uniqueWaveAnchor(
      discussion,
      this.repository.listParticipants(discussion.discussionId)
        .filter(({ agentId }) => plannedAgents.has(agentId)),
      latestAnchor,
      this.clock()
    );
    this.repository.reanchorPlannedWave(waveId, replacement, this.clock());
  }

  private uniqueWaveAnchor(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[],
    candidateMessageId: string,
    now: string
  ): string {
    const existingAgents = new Set(
      this.runs.findByTrigger(candidateMessageId).map(({ targetAgentId }) => targetAgentId)
    );
    if (!participants.some(({ agentId }) => existingAgents.has(agentId))) {
      return candidateMessageId;
    }
    const parent = this.core.getMessage(candidateMessageId);
    if (!parent) {
      throw new Error(`Discussion continuation Message not found: ${candidateMessageId}`);
    }
    const messageId = createOpaqueId("msg");
    this.core.appendMessage({
      messageId,
      roomId: discussion.roomId,
      taskId: discussion.taskId,
      senderType: "system",
      senderId: discussion.discussionId,
      content: "继续讨论：上一轮没有产生可复用的新输入，已创建新的执行锚点。",
      mentions: [],
      parentMessageId: candidateMessageId,
      traceId: parent.traceId,
      createdAt: now
    });
    return messageId;
  }

  private buildInstruction(
    discussion: DiscussionRecord,
    wave: DiscussionWave,
    turn: DiscussionTurn
  ): string {
    const participants = this.repository.listParticipants(discussion.discussionId)
      .map((participant) => {
        const agent = this.core.getAgent(participant.agentId);
        return `${agent?.name ?? participant.agentId} (${participant.role})`;
      });
    const trigger = this.core.getMessage(turn.inputMessageId);
    const transcript = this.discussionTranscript(discussion, wave, trigger);
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
      : "Make an independent, useful contribution for this Wave. Resolve a question, add evidence, " +
        "or challenge the current conclusion; do not merely repeat agreement.";
    return [
      "# Agent Room Discussion Context",
      `Discussion ID: ${discussion.discussionId}`,
      `Wave: ${wave.ordinal}`,
      `Wave member: ${(turn.waveMemberOrdinal ?? 0) + 1}/${wave.expectedMembers}`,
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
      `${remainingLease} ordinary waves; token and cost telemetry may be unknown.`,
      "",
      "## Recent Room Transcript",
      transcriptText,
      "",
      "## Your Task",
      task,
      "Other participants in this Wave run concurrently and cannot see this reply until the next Wave.",
      "The Orchestrator, not you, decides whether the Discussion continues. " +
        "A plain-text reply is always valid when structured assessment is unsupported.",
      "When supported, append one final line exactly in this form: " +
        "<agentroom-assessment>{\"goalSatisfied\":false," +
        "\"confidence\":0.7,\"newInformationAdded\":true," +
        "\"recommendation\":\"continue\"}</agentroom-assessment>. " +
        "This is evidence only; it does not control the next action."
    ].join("\n").slice(0, 20_000);
  }

  private latestOutputMessageId(discussion: DiscussionRecord): string {
    const latestWave = this.repository.listWaves(discussion.discussionId)
      .filter(({ state }) => state !== "open")
      .at(-1);
    if (latestWave) {
      const anchorId = this.waveResultMessageId(latestWave.waveId);
      if (this.core.getMessage(anchorId)) return anchorId;
    }
    const outputs = this.repository.listTurns(discussion.discussionId)
      .flatMap(({ outputMessageId }) => {
        if (!outputMessageId) return [];
        const message = this.core.getMessage(outputMessageId);
        return message ? [message] : [];
      })
      .sort((left, right) => left.sequence - right.sequence);
    return outputs.at(-1)?.messageId ?? discussion.rootMessageId;
  }

  private discussionTranscript(
    discussion: DiscussionRecord,
    currentWave: DiscussionWave,
    trigger: MessageRecord | undefined
  ): MessageRecord[] {
    const waves = new Map(
      this.repository.listWaves(discussion.discussionId)
        .map((wave) => [wave.waveId, wave.ordinal])
    );
    const messages: MessageRecord[] = [];
    const root = this.core.getMessage(discussion.rootMessageId);
    if (root) messages.push(root);
    for (const turn of this.repository.listTurns(discussion.discussionId)) {
      const waveOrdinal = turn.waveId ? waves.get(turn.waveId) : undefined;
      if (
        waveOrdinal === undefined || waveOrdinal >= currentWave.ordinal ||
        !turn.outputMessageId
      ) {
        continue;
      }
      const output = this.core.getMessage(turn.outputMessageId);
      if (output) messages.push(output);
    }
    if (
      trigger && trigger.messageId !== discussion.rootMessageId &&
      !messages.some(({ messageId }) => messageId === trigger.messageId)
    ) {
      messages.push(trigger);
    }
    return messages.slice(-24);
  }

  private ensureWaveResultAnchor(
    discussion: DiscussionRecord,
    wave: DiscussionWave,
    turns: DiscussionTurn[],
    now: string
  ): string {
    const messageId = this.waveResultMessageId(wave.waveId);
    if (this.core.getMessage(messageId)) return messageId;
    const parent = this.core.getMessage(wave.inputMessageId);
    const lines = [...turns]
      .sort((left, right) =>
        (left.waveMemberOrdinal ?? 0) - (right.waveMemberOrdinal ?? 0)
      )
      .map((turn) => {
        const agentName = this.core.getAgent(turn.speakerAgentId)?.name ?? turn.speakerAgentId;
        return `- ${agentName}: ${turn.state}`;
      });
    this.core.appendMessage({
      messageId,
      roomId: discussion.roomId,
      taskId: discussion.taskId,
      senderType: "system",
      senderId: discussion.discussionId,
      content: [`第 ${wave.ordinal} 轮已收敛。`, ...lines].join("\n"),
      mentions: [],
      parentMessageId: wave.inputMessageId,
      ...(parent ? { traceId: parent.traceId } : {}),
      createdAt: now
    });
    return messageId;
  }

  private waveResultMessageId(waveId: string): string {
    return `msg_wave_${waveId.slice(5)}`;
  }

  private eligibleParticipants(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[]
  ): DiscussionParticipant[] {
    const room = this.core.getRoom(discussion.roomId);
    if (!room) return [];
    return participants.filter(({ agentId }) => {
      const agent = this.core.getAgent(agentId);
      return Boolean(
        agent?.enabled &&
        agent.teamId === room.teamId &&
        this.core.isRoomAgent(room.roomId, agentId)
      );
    });
  }

  private terminalReason(run: RunRecord, hasOutput: boolean): string {
    if (this.runs.listEvents(run.runId).some(({ event }) =>
      event.type === "status" && event.status === "input_required"
    )) {
      return "input_required";
    }
    if (run.state === "completed" && !hasOutput) return "completed_without_reply";
    return `run_${run.state}`.slice(0, 160);
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
    const fallbackMessageId = `msg_fallback_${discussion.discussionId.slice(11)}`;
    if (this.core.getMessage(fallbackMessageId)) return;
    const parent = this.core.getMessage(parentMessageId);
    const unresolved = discussion.progress.openQuestions.length === 0
      ? "暂无记录的未决问题。"
      : discussion.progress.openQuestions
        .map(({ question, importance }) => `- [${importance}] ${question}`)
        .join("\n");
    this.core.appendMessage({
      messageId: fallbackMessageId,
      roomId: discussion.roomId,
      taskId: discussion.taskId,
      senderType: "system",
      senderId: discussion.discussionId,
      content: `讨论已停止，最终生成器未能完成。\n\n未决问题：\n${unresolved}`,
      mentions: [],
      parentMessageId,
      ...(parent ? { traceId: parent.traceId } : {}),
      createdAt: this.clock()
    });
  }

  private refreshElapsedBudget(
    discussion: DiscussionRecord
  ): DiscussionRecord["budget"] {
    const elapsed = Math.max(0, Math.floor(
      (Date.parse(this.clock()) - Date.parse(discussion.createdAt)) / 1_000
    ));
    return {
      ...discussion.budget,
      durationSeconds: Math.max(discussion.budget.durationSeconds, elapsed)
    };
  }

  private prepareResumeBudget(
    discussion: DiscussionRecord,
    requestedTurns: number | undefined
  ): {
    budget: DiscussionRecord["budget"];
    budgetEvent: DiscussionBudgetEvent | null;
  } {
    const status = inspectBudget(discussion.budget, discussion.policy);
    if (!status.leaseBoundaryReached || status.hardBoundaryReached) {
      return { budget: discussion.budget, budgetEvent: null };
    }
    const budget = grantDiscussionLease({
      previous: discussion.budget,
      policy: discussion.policy,
      ...(requestedTurns === undefined ? {} : { requestedTurns }),
      source: "user"
    });
    return {
      budget,
      budgetEvent: this.newBudgetEvent(discussion, "extension_granted", {
        turns: budget.leaseEndTurn - discussion.budget.leaseEndTurn,
        metadata: { source: "user", unit: "wave" }
      })
    };
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

  private latestOpenWave(discussionId: string): DiscussionWave | null {
    return this.repository.listWaves(discussionId)
      .filter(({ state }) => state === "open")
      .at(-1) ?? null;
  }

  private view(discussionId: string): DiscussionView {
    return {
      discussion: this.requireDiscussion(discussionId),
      participants: this.repository.listParticipants(discussionId),
      waves: this.repository.listWaves(discussionId),
      turns: this.repository.listTurns(discussionId),
      decisions: this.repository.listDecisions(discussionId)
    };
  }

  private mutationResult(
    discussionId: string,
    scheduledRuns: RunRecord[] = [],
    cancelRunIds: string[] = []
  ): DiscussionMutationResult {
    return { ...this.view(discussionId), scheduledRuns, cancelRunIds };
  }

  private requireDiscussion(discussionId: string): DiscussionRecord {
    const discussion = this.repository.get(discussionId);
    if (!discussion) {
      throw new Error(`Discussion not found: ${discussionId}`);
    }
    return discussion;
  }
}
