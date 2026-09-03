import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRecord, RunRepository } from "../run/run-repository.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import { agentMentionDisplayLabel } from
  "../team-room/agent-mention-label.js";
import type { MessageService } from "../team-room/message-service.js";
import type { AgentTaskRepository } from "../task/task-repository.js";
import {
  grantDiscussionLease,
  inspectBudget,
  recordTurnUsage
} from "./budget-ledger.js";
import { DiscussionRepository } from "./discussion-repository.js";
import {
  assertDiscussionWaveSelection,
  selectDiscussionParticipants,
  type DiscussionParticipantCandidate,
  type DiscussionParticipantSelection
} from "./discussion-participant-selector.js";
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
  type DiscussionSupplementalEvidence,
  type DiscussionTurn,
  type DiscussionWave,
  type DiscussionWaveSeal,
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
  type WavePlan
} from "./discussion-wave-planner.js";
import {
  evaluateWaveProgress
} from "./progress-evaluator.js";
import { DiscussionRecoveryService } from "./discussion-recovery-service.js";
import { DiscussionEvidenceService } from "./discussion-evidence-service.js";
import type { DiscussionPlanProposalService } from
  "./discussion-plan-proposal-service.js";
import { WaveSettlementService } from "./wave-settlement-service.js";
import {
  createDiscussionWaveSeal,
  quorumSoftDeadline
} from "./discussion-quorum.js";

const maximumParticipants = 5;

export interface DiscussionView {
  discussion: DiscussionRecord;
  participants: DiscussionParticipant[];
  waves: DiscussionWave[];
  turns: DiscussionTurn[];
  decisions: DiscussionDecision[];
  seals: DiscussionWaveSeal[];
  supplementalEvidence: DiscussionSupplementalEvidence[];
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
    typeof policy.allowAutomaticFinish !== "boolean" ||
    !new Set(["all_settled", "read_only_quorum"])
      .has(policy.waveCompletionMode) ||
    !new Set(["all_eligible", "question_focused"])
      .has(policy.participantSelectionMode)
  ) {
    throw new Error("Discussion policy fields are invalid");
  }
  requiredInteger(policy.initialLeaseTurns, "initialLeaseTurns", 1, 12);
  requiredInteger(policy.automaticMaxTurns, "automaticMaxTurns", 1, 30);
  requiredInteger(policy.hardMaxTurns, "hardMaxTurns", 2, 50);
  requiredInteger(policy.maxDurationSeconds, "maxDurationSeconds", 30, 7_200);
  requiredInteger(policy.waveTimeoutSeconds, "waveTimeoutSeconds", 30, 7_200);
  requiredInteger(policy.plateauWindow, "plateauWindow", 1, 6);
  requiredInteger(policy.finalizationReserveTurns, "finalizationReserveTurns", 1, 3);
  requiredInteger(
    policy.focusedParticipantLimit,
    "focusedParticipantLimit",
    2,
    maximumParticipants
  );
  if (policy.waveCompletionMode === "all_settled") {
    policy.quorumMinimumCompleted = defaultDiscussionPolicy.quorumMinimumCompleted;
    policy.quorumSoftDeadlineSeconds =
      defaultDiscussionPolicy.quorumSoftDeadlineSeconds;
  } else {
    requiredInteger(
      policy.quorumMinimumCompleted,
      "quorumMinimumCompleted",
      2,
      maximumParticipants
    );
    requiredInteger(
      policy.quorumSoftDeadlineSeconds,
      "quorumSoftDeadlineSeconds",
      1,
      7_199
    );
    if (policy.quorumSoftDeadlineSeconds >= policy.waveTimeoutSeconds) {
      throw new Error("Quorum soft deadline must precede the Wave timeout");
    }
  }
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
  private readonly recovery: DiscussionRecoveryService;
  private readonly evidence: DiscussionEvidenceService;
  private readonly settlement: WaveSettlementService;

  public constructor(
    private readonly core: CoreRepository,
    private readonly messages: MessageService,
    private readonly repository: DiscussionRepository,
    private readonly runs: RunRepository,
    private readonly auth: AuthService,
    private readonly tasks: AgentTaskRepository,
    private readonly clock: () => string,
    private readonly planProposals?: DiscussionPlanProposalService
  ) {
    this.recovery = new DiscussionRecoveryService(repository, runs, clock);
    this.evidence = new DiscussionEvidenceService(core, repository, runs, clock);
    this.settlement = new WaveSettlementService(core, repository, runs);
  }

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
    return this.repository.atomic(() => this.createWithinTransaction(principal, input));
  }

  private createWithinTransaction(
    principal: WebPrincipal,
    input: Parameters<DiscussionOrchestrator["create"]>[1]
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
      task.state === "completed" || task.state === "canceled" ||
      task.lifecycleState === "completed" || task.lifecycleState === "canceled"
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
      if (!task.isDefault && !task.assignments.some((assignment) =>
        assignment.agentId === agentId
      )) {
        throw new Error(`Discussion participant is not assigned: ${agentId}`);
      }
      return agent;
    });
    const policy = resolvePolicy(input.policy);
    const mode = input.mode ?? "round_robin";
    const outputMode = input.outputMode ?? "final_answer";
    if (mode !== "round_robin" && mode !== "review") {
      throw new Error("Discussion mode must be round_robin or review");
    }
    if (policy.requireReviewer && mode !== "review") {
      throw new Error("Reviewer-required Discussion policy requires review mode");
    }
    if (
      policy.waveCompletionMode === "read_only_quorum" &&
      (
        policy.quorumMinimumCompleted > participantAgents.length ||
        participantAgents.some((agent) => !this.isQuorumCapableAgent(agent))
      )
    ) {
      throw new Error(
        "Read-only quorum requires managed supplemental-capable read-only participants"
      );
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
        displayLabel: agentMentionDisplayLabel(agent.name, agent.role)
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
    const settlement = this.settlement.settle(runId, this.clock());
    if (!settlement) return null;
    const discussion = this.requireDiscussion(settlement.discussionId);
    if (!settlement.wave || settlement.wave.state !== "open") {
      return this.mutationResult(discussion.discussionId);
    }
    const turns = discussion.policy.waveCompletionMode === "read_only_quorum"
      ? this.reconcileTerminalWaveTurns(settlement.wave, settlement.turns)
      : settlement.turns;
    if (turns.every(({ state }) => terminalTurnStates.has(state))) {
      return this.advanceReadyWave(discussion, settlement.wave, turns);
    }
    const seal = this.quorumSealIfReady(
      discussion,
      settlement.wave,
      turns
    );
    if (!seal) return this.mutationResult(settlement.discussionId);
    const acceptedTurnIds = new Set(
      seal.acceptedMembers.map(({ turnId }) => turnId)
    );
    return this.advanceSettledWave(
      discussion,
      settlement.wave,
      settlement.turns.filter(({ turnId }) => acceptedTurnIds.has(turnId)),
      settlement.turns,
      seal
    );
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
        this.evidence.appendFallbackConclusion(discussion, wave.inputMessageId);
      }
      const now = this.clock();
      if (finalizationSucceeded && this.planProposals) {
        this.planProposals.closeAndPropose({
          discussion,
          wave,
          state: terminalState,
          waveState: closeState,
          now
        });
      } else {
        this.repository.closeFinalizationAndFinish({
          discussionId: discussion.discussionId,
          expectedDiscussionVersion: discussion.version,
          state: terminalState,
          waveId: wave.waveId,
          expectedWaveVersion: wave.version,
          waveState: closeState,
          now
        });
      }
      return this.mutationResult(discussion.discussionId);
    }
    return this.advanceSettledWave(discussion, wave, turns, turns);
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
    this.planProposals?.reconcileAllTerminal();
    const scheduled = new Map<string, RunRecord>();
    this.recovery.closeCanceledWaves((runId) => this.onRunTerminal(runId));
    const now = Date.parse(this.clock());
    for (const run of this.reconcileDueQuorums(now)) {
      scheduled.set(run.runId, run);
    }
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
        this.evidence.appendFallbackConclusion(current, current.rootMessageId);
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

  public expireDueWaves(): RunRecord[] {
    return this.recovery.expireDueWaves(
      (turn) => this.ensureRun(turn),
      (runId) => this.onRunTerminal(runId)
    );
  }

  public sweepDueWaves(): RunRecord[] {
    const scheduled = new Map<string, RunRecord>();
    for (const run of this.reconcileDueQuorums(Date.parse(this.clock()))) {
      scheduled.set(run.runId, run);
    }
    for (const run of this.expireDueWaves()) {
      scheduled.set(run.runId, run);
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
    for (const wave of this.repository.listWaves(discussionId)) {
      if (wave.state !== "open" || wave.selection === null) continue;
      assertDiscussionWaveSelection(
        wave.selection,
        this.repository.listTurnsForWave(wave.waveId)
          .map(({ speakerAgentId }) => speakerAgentId)
      );
    }
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
    projectionTurns: DiscussionTurn[],
    allTurns: DiscussionTurn[],
    seal?: DiscussionWaveSeal
  ): DiscussionMutationResult {
    const participants = this.repository.listParticipants(discussion.discussionId);
    const eligibleParticipants = this.eligibleParticipantsForNextWave(
      discussion,
      participants,
      wave.ordinal
    );
    const participantByAgent = new Map(
      participants.map((participant) => [participant.agentId, participant])
    );
    const successfulResults = projectionTurns.flatMap((turn) => {
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
    const nextInputMessageId = this.evidence.ensureWaveResultAnchor(
      discussion,
      wave,
      projectionTurns,
      this.clock()
    );
    let budget = recordTurnUsage({
      previous: discussion.budget,
      agentRuns: wave.expectedMembers,
      discussionStartedAt: discussion.createdAt,
      now: this.clock()
    });
    const closeState = seal ? "partial" as const : waveCloseState(allTurns);
    const outcomeCounts = {
      completed: allTurns.filter(({ state }) => state === "completed").length,
      failed: allTurns.filter(({ state }) => state === "failed").length,
      canceled: allTurns.filter(({ state }) => state === "canceled").length,
      live: allTurns.filter(({ state }) => !terminalTurnStates.has(state)).length,
      quorumSealId: seal?.sealId ?? null
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
      runtimeInputRequired: projectionTurns.some(
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
      decision.action === "continue" &&
      !this.requiredParticipantRolesAvailable(discussion, eligibleParticipants)
    ) {
      decision = {
        action: "wait_human",
        state: "waiting_human",
        reason: "policy_violation",
        outputMode: "none",
        grantAutomaticLease: false
      };
    } else if (
      eligibleParticipants.length === 0 && decision.action === "finalize"
    ) {
      this.evidence.appendFallbackConclusion(discussion, nextInputMessageId);
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
      const selection = this.selectParticipants(
        { ...discussion, progress: evaluation.snapshot, budget },
        eligibleParticipants
      );
      nextWave = buildWavePlan({
        discussion,
        participants: selection.participants,
        inputMessageId: nextInputMessageId,
        kind: "discussion",
        selection: selection.snapshot,
        now
      });
    } else if (
      decision.action === "finalize" && eligibleParticipants.length > 0
    ) {
      const selection = this.selectParticipants(
        { ...discussion, progress: evaluation.snapshot, budget },
        eligibleParticipants,
        true
      );
      nextWave = buildWavePlan({
        discussion,
        participants: selection.participants,
        inputMessageId: nextInputMessageId,
        kind: "finalization",
        selection: selection.snapshot,
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
      ...(nextWave ? { nextWave } : {}),
      ...(seal ? { seal } : {})
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
    const participants = this.eligibleParticipantsForNextWave(
      discussion,
      this.repository.listParticipants(discussion.discussionId),
      discussion.currentWave ?? 0
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
    if (!this.requiredParticipantRolesAvailable(discussion, participants)) {
      const decision: PolicyDecision = {
        action: "wait_human",
        state: "waiting_human",
        reason: "policy_violation",
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
      inputMessageId: this.evidence.latestOutputMessageId(discussion),
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
    const participants = this.eligibleParticipantsForNextWave(
      discussion,
      this.repository.listParticipants(discussion.discussionId),
      discussion.currentWave ?? 0
    );
    if (participants.length === 0) {
      this.evidence.appendFallbackConclusion(
        discussion,
        this.evidence.latestOutputMessageId(discussion)
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
      participants,
      inputMessageId: this.evidence.latestOutputMessageId(discussion),
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
    const selection = this.selectParticipants(
      input.discussion,
      input.participants,
      input.kind === "finalization"
    );
    const inputMessageId = this.evidence.uniqueWaveAnchor(
      input.discussion,
      selection.participants,
      input.inputMessageId,
      now
    );
    const plan = buildWavePlan({
      discussion: input.discussion,
      participants: selection.participants,
      inputMessageId,
      kind: input.kind,
      selection: selection.snapshot,
      now
    });
    this.repository.recordDecisionAndPlanWave({
      decision: this.newDecision(
        input.discussion,
        input.decision,
        input.progress,
        input.kind === "finalization"
          ? plan.turns[0]?.speakerAgentId ?? null
          : null,
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
      const latestAnchor = this.evidence.latestOutputMessageId(discussion);
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
      instruction: this.evidence.buildInstruction(discussion, wave, turn),
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
    const latestAnchor = this.evidence.latestOutputMessageId(discussion);
    const plannedAgents = new Set(turns.map(({ speakerAgentId }) => speakerAgentId));
    const replacement = this.evidence.uniqueWaveAnchor(
      discussion,
      this.repository.listParticipants(discussion.discussionId)
        .filter(({ agentId }) => plannedAgents.has(agentId)),
      latestAnchor,
      this.clock()
    );
    this.repository.reanchorPlannedWave(waveId, replacement, this.clock());
  }

  private eligibleParticipants(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[]
  ): DiscussionParticipant[] {
    const room = this.core.getRoom(discussion.roomId);
    const task = this.tasks.get(discussion.taskId);
    if (
      !room || !room.collaborationPolicy.allowDiscussion ||
      !task || task.roomId !== discussion.roomId ||
      task.state === "completed" || task.state === "canceled" ||
      task.lifecycleState === "completed" || task.lifecycleState === "canceled"
    ) return [];
    return participants.filter(({ agentId }) => {
      const agent = this.core.getAgent(agentId);
      return Boolean(
        agent?.enabled &&
        agent.teamId === room.teamId &&
        this.core.isRoomAgent(room.roomId, agentId) &&
        (task.isDefault || task.assignments.some((assignment) =>
          assignment.agentId === agentId
        )) &&
        (discussion.policy.waveCompletionMode !== "read_only_quorum" ||
          this.isQuorumCapableAgent(agent))
      );
    });
  }

  private eligibleParticipantsForNextWave(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[],
    throughWaveOrdinal: number
  ): DiscussionParticipant[] {
    const waves = new Map(
      this.repository.listWaves(discussion.discussionId)
        .map((wave) => [wave.waveId, wave.ordinal])
    );
    const liveAgents = new Set(
      this.repository.listTurns(discussion.discussionId)
        .filter((turn) =>
          !terminalTurnStates.has(turn.state) &&
          (turn.waveId ? (waves.get(turn.waveId) ?? 0) : 0) <= throughWaveOrdinal
        )
        .map(({ speakerAgentId }) => speakerAgentId)
    );
    return this.eligibleParticipants(discussion, participants)
      .filter(({ agentId }) => !liveAgents.has(agentId));
  }

  private isQuorumCapableAgent(
    agent: ReturnType<CoreRepository["getAgent"]>
  ): boolean {
    return Boolean(
      agent?.enabled && agent.integrationMode === "managed" && agent.deviceId &&
      agent.runtimePolicy?.filesystemAccess === "read-only" &&
      agent.capabilities.supportsDiscussionSupplementalEvidence === true &&
      this.core.getDevice(agent.deviceId)?.status === "active"
    );
  }

  private quorumSealIfReady(
    discussion: DiscussionRecord,
    wave: DiscussionWave,
    turns: DiscussionTurn[]
  ): DiscussionWaveSeal | null {
    if (
      discussion.policy.waveCompletionMode !== "read_only_quorum" ||
      wave.phase === "finalization" || wave.state !== "open" ||
      Date.parse(this.clock()) < Date.parse(quorumSoftDeadline(
        wave.createdAt,
        discussion.policy.quorumSoftDeadlineSeconds
      ))
    ) return null;
    const participants = new Map(
      this.repository.listParticipants(discussion.discussionId)
        .map((participant) => [participant.agentId, participant])
    );
    const acceptedMembers = turns.flatMap((turn) => {
      if (
        turn.state !== "completed" || !turn.runId || !turn.outputMessageId ||
        !turn.replyHash || turn.waveMemberOrdinal === null ||
        turn.waveMemberOrdinal === undefined
      ) return [];
      const message = this.core.getMessage(turn.outputMessageId);
      const reply = this.runs.listEvents(turn.runId)
        .filter(({ event }) => event.type === "reply")
        .find(({ sequence }) =>
          this.runs.getReplyMessageProjection(turn.runId!, sequence)?.messageId ===
            turn.outputMessageId
        );
      const role = participants.get(turn.speakerAgentId)?.role;
      if (!message || !reply || !role) return [];
      return [{
        turnId: turn.turnId,
        waveMemberOrdinal: turn.waveMemberOrdinal,
        agentId: turn.speakerAgentId,
        role,
        runId: turn.runId,
        sourceReplySequence: reply.sequence,
        outputMessageId: message.messageId,
        sourceMessageSequence: message.sequence,
        replyHash: turn.replyHash
      }];
    }).sort((left, right) => left.waveMemberOrdinal - right.waveMemberOrdinal);
    const requiredRoles = wave.selection?.requiredRoles ?? [];
    if (
      acceptedMembers.length < discussion.policy.quorumMinimumCompleted ||
      requiredRoles.some((role) =>
        !acceptedMembers.some((member) => member.role === role)
      )
    ) return null;
    return createDiscussionWaveSeal({
      sealId: createOpaqueId("seal"),
      discussionId: discussion.discussionId,
      waveId: wave.waveId,
      softDeadlineAt: quorumSoftDeadline(
        wave.createdAt,
        discussion.policy.quorumSoftDeadlineSeconds
      ),
      minimumCompleted: discussion.policy.quorumMinimumCompleted,
      requiredRoles,
      acceptedMembers,
      sealedAt: this.clock()
    });
  }

  private reconcileTerminalWaveTurns(
    wave: DiscussionWave,
    turns: DiscussionTurn[]
  ): DiscussionTurn[] {
    for (const turn of turns) {
      if (terminalTurnStates.has(turn.state) || !turn.runId) continue;
      const run = this.runs.getRun(turn.runId);
      if (!run || !terminalRunStates.has(run.state)) continue;
      this.settlement.settle(run.runId, this.clock());
    }
    return this.repository.listTurnsForWave(wave.waveId);
  }

  private reconcileDueQuorums(now: number): RunRecord[] {
    const scheduled = new Map<string, RunRecord>();
    for (const wave of this.repository.listOpenWaves()) {
      const discussion = this.repository.get(wave.discussionId);
      if (
        discussion?.policy.waveCompletionMode !== "read_only_quorum" ||
        Date.parse(quorumSoftDeadline(
          wave.createdAt,
          discussion.policy.quorumSoftDeadlineSeconds
        )) > now
      ) continue;
      for (const turn of this.repository.listTurnsForWave(wave.waveId)) {
        if (!turn.runId) continue;
        const run = this.runs.getRun(turn.runId);
        if (!run || !terminalRunStates.has(run.state)) continue;
        const result = this.onRunTerminal(run.runId);
        for (const next of result?.scheduledRuns ?? []) {
          scheduled.set(next.runId, next);
        }
        if (this.repository.getWave(wave.waveId)?.state !== "open") break;
      }
    }
    return [...scheduled.values()];
  }

  private selectParticipants(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[],
    finalization = false
  ): DiscussionParticipantSelection {
    const eligible = this.eligibleParticipants(discussion, participants);
    const task = this.tasks.get(discussion.taskId);
    const reports = new Map<string, Set<string>>();
    for (const turn of this.repository.listTurns(discussion.discussionId)) {
      if (turn.state !== "completed") continue;
      for (const question of turn.assessment?.openQuestions ?? []) {
        const reporters = reports.get(turn.speakerAgentId) ?? new Set<string>();
        reporters.add(question.id);
        reports.set(turn.speakerAgentId, reporters);
      }
    }
    const candidates = eligible.flatMap((participant) => {
      const agent = this.core.getAgent(participant.agentId);
      if (!agent) return [];
      const candidate: DiscussionParticipantCandidate = {
        participant,
        agentRole: agent.role,
        taskRole: task?.assignments.find(({ agentId }) =>
          agentId === participant.agentId
        )?.role ?? null,
        reportedQuestionIds: [...(reports.get(participant.agentId) ?? [])]
          .sort((left, right) => left.localeCompare(right, "en-US"))
      };
      return [candidate];
    });
    return selectDiscussionParticipants({
      discussion,
      candidates,
      ...(finalization ? { finalization: true } : {})
    });
  }

  private requiredParticipantRolesAvailable(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[]
  ): boolean {
    return (
      discussion.mode !== "review" && !discussion.policy.requireReviewer
    ) || participants.some(({ role }) => role === "reviewer");
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
      decisions: this.repository.listDecisions(discussionId),
      seals: this.repository.listWaveSeals(discussionId),
      supplementalEvidence: this.repository.listSupplementalEvidence(discussionId)
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
