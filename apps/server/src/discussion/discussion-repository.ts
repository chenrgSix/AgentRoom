import type Database from "better-sqlite3";
import { SqliteTransactionBoundary } from "../data/sqlite-transaction-boundary.js";

import {
  defaultDiscussionPolicy,
  type AgentAssessment,
  type BudgetSnapshot,
  type DiscussionBudgetEvent,
  type DiscussionDecision,
  type DiscussionOutputMode,
  type DiscussionParticipant,
  type DiscussionPolicy,
  type DiscussionRecord,
  type DiscussionState,
  type DiscussionStateReason,
  type DiscussionTurn,
  type DiscussionWave,
  type DiscussionWaveState,
  type ProgressSnapshot
} from "./discussion-types.js";

interface DiscussionRow {
  discussion_id: string;
  room_id: string;
  task_id: string;
  root_message_id: string;
  requester_member_id: string;
  goal: string;
  mode: DiscussionRecord["mode"];
  state: DiscussionState;
  state_reason: DiscussionStateReason | null;
  output_mode: DiscussionOutputMode;
  policy_json: string;
  progress_json: string;
  budget_json: string;
  execution_model: NonNullable<DiscussionRecord["executionModel"]>;
  current_turn: number;
  current_wave: number;
  next_speaker_index: number;
  requested_action: DiscussionRecord["requestedAction"];
  version: number;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface ParticipantRow {
  discussion_id: string;
  ordinal: number;
  agent_id: string;
  role: DiscussionParticipant["role"];
}

interface TurnRow {
  turn_id: string;
  discussion_id: string;
  ordinal: number;
  kind: DiscussionTurn["kind"];
  speaker_agent_id: string;
  input_message_id: string;
  run_id: string | null;
  output_message_id: string | null;
  state: DiscussionTurn["state"];
  assessment_json: string | null;
  reply_hash: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  wave_id: string | null;
  wave_member_ordinal: number | null;
  terminal_reason: string | null;
}

interface WaveRow {
  wave_id: string;
  discussion_id: string;
  ordinal: number;
  phase: DiscussionWave["phase"];
  input_message_id: string;
  state: DiscussionWaveState;
  deadline_at: string;
  expected_members: number;
  version: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface DecisionRow {
  decision_id: string;
  discussion_id: string;
  aggregate_version: number;
  progress_version: number;
  action: DiscussionDecision["action"];
  reason: string;
  next_agent_id: string | null;
  output_mode: DiscussionOutputMode;
  created_at: string;
}

interface BudgetEventRow {
  budget_event_id: string;
  discussion_id: string;
  ordinal: number;
  event_type: DiscussionBudgetEvent["eventType"];
  turns: number;
  tokens: number | null;
  duration_seconds: number;
  estimated_cost_micros: number | null;
  metadata_json: string;
  created_at: string;
}

function mapDiscussion(row: DiscussionRow): DiscussionRecord {
  const policy = JSON.parse(row.policy_json) as Partial<DiscussionPolicy>;
  const budget = JSON.parse(row.budget_json) as Partial<BudgetSnapshot> & {
    turnsUsed: number;
  };
  return {
    discussionId: row.discussion_id,
    roomId: row.room_id,
    taskId: row.task_id,
    rootMessageId: row.root_message_id,
    requesterMemberId: row.requester_member_id,
    goal: row.goal,
    mode: row.mode,
    state: row.state,
    stateReason: row.state_reason,
    outputMode: row.output_mode,
    policy: { ...defaultDiscussionPolicy, ...policy },
    progress: JSON.parse(row.progress_json) as ProgressSnapshot,
    budget: {
      ...budget,
      agentRunsUsed: budget.agentRunsUsed ?? budget.turnsUsed
    } as BudgetSnapshot,
    executionModel: row.execution_model,
    currentTurn: row.current_turn,
    currentWave: row.current_wave,
    nextSpeakerIndex: row.next_speaker_index,
    requestedAction: row.requested_action,
    version: row.version,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at
  };
}

function mapTurn(row: TurnRow): DiscussionTurn {
  return {
    turnId: row.turn_id,
    discussionId: row.discussion_id,
    ordinal: row.ordinal,
    kind: row.kind,
    speakerAgentId: row.speaker_agent_id,
    inputMessageId: row.input_message_id,
    runId: row.run_id,
    outputMessageId: row.output_message_id,
    state: row.state,
    assessment: row.assessment_json
      ? JSON.parse(row.assessment_json) as AgentAssessment
      : null,
    replyHash: row.reply_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    waveId: row.wave_id,
    waveMemberOrdinal: row.wave_member_ordinal,
    terminalReason: row.terminal_reason
  };
}

function mapWave(row: WaveRow): DiscussionWave {
  return {
    waveId: row.wave_id,
    discussionId: row.discussion_id,
    ordinal: row.ordinal,
    phase: row.phase,
    inputMessageId: row.input_message_id,
    state: row.state,
    deadlineAt: row.deadline_at,
    expectedMembers: row.expected_members,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at
  };
}

export interface SettleDiscussionTurnResult {
  applied: boolean;
  turn: DiscussionTurn;
}

export interface CloseDiscussionWaveResult {
  applied: boolean;
  wave: DiscussionWave;
}

export interface ApplyDiscussionWaveResult extends CloseDiscussionWaveResult {
  discussion: DiscussionRecord;
}

type ClosedDiscussionWaveState = Exclude<DiscussionWaveState, "open">;

export class DiscussionRepository {
  /** Coordinates the root Message, Discussion, first Wave and ordinary Runs. */
  public atomic<T>(work: () => T): T {
    return new SqliteTransactionBoundary(this.database).immediate(work);
  }

  public constructor(private readonly database: Database.Database) {}

  public create(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[],
    initialBudgetEvent: DiscussionBudgetEvent
  ): DiscussionRecord {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO discussions (
          discussion_id, room_id, task_id, root_message_id,
          requester_member_id, goal, mode, state, state_reason, output_mode,
          policy_json, progress_json, budget_json, execution_model,
          current_turn, current_wave, next_speaker_index, requested_action,
          version, deadline_at, created_at, updated_at, terminal_at
        ) VALUES (
          @discussionId, @roomId, @taskId, @rootMessageId,
          @requesterMemberId, @goal, @mode, @state, @stateReason,
          @outputMode, @policyJson, @progressJson, @budgetJson,
          @executionModel, @currentTurn, @currentWave, @nextSpeakerIndex,
          @requestedAction, @version, @deadlineAt, @createdAt, @updatedAt,
          @terminalAt
        )
      `).run({
        ...discussion,
        executionModel: discussion.executionModel ?? "sequential",
        currentWave: discussion.currentWave ?? 0,
        policyJson: JSON.stringify(discussion.policy),
        progressJson: JSON.stringify(discussion.progress),
        budgetJson: JSON.stringify(discussion.budget)
      });
      const insertParticipant = this.database.prepare(`
        INSERT INTO discussion_participants (
          discussion_id, ordinal, agent_id, role
        ) VALUES (@discussionId, @ordinal, @agentId, @role)
      `);
      for (const participant of participants) {
        insertParticipant.run(participant);
      }
      this.insertBudgetEvent(initialBudgetEvent);
    }).immediate();
    return discussion;
  }

  public get(discussionId: string): DiscussionRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM discussions WHERE discussion_id = ?
    `).get(discussionId) as DiscussionRow | undefined;
    return row && mapDiscussion(row);
  }

  public listForRoom(roomId: string): DiscussionRecord[] {
    return (this.database.prepare(`
      SELECT * FROM discussions
      WHERE room_id = ? ORDER BY created_at, discussion_id
    `).all(roomId) as DiscussionRow[]).map(mapDiscussion);
  }

  public listOpen(): DiscussionRecord[] {
    return (this.database.prepare(`
      SELECT * FROM discussions
      WHERE state NOT IN ('completed', 'canceled', 'terminated')
      ORDER BY updated_at, discussion_id
    `).all() as DiscussionRow[]).map(mapDiscussion);
  }

  public listParticipants(discussionId: string): DiscussionParticipant[] {
    return (this.database.prepare(`
      SELECT * FROM discussion_participants
      WHERE discussion_id = ? ORDER BY ordinal
    `).all(discussionId) as ParticipantRow[]).map((row) => ({
      discussionId: row.discussion_id,
      ordinal: row.ordinal,
      agentId: row.agent_id,
      role: row.role
    }));
  }

  public appendTurn(turn: DiscussionTurn, expectedVersion: number): DiscussionTurn {
    this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE discussions
        SET current_turn = ?, version = version + 1, updated_at = ?
        WHERE discussion_id = ? AND version = ?
      `).run(turn.ordinal, turn.updatedAt, turn.discussionId, expectedVersion);
      if (updated.changes !== 1) {
        throw new Error("Stale Discussion aggregate version");
      }
      this.database.prepare(`
        INSERT INTO discussion_turns (
          turn_id, discussion_id, ordinal, kind, speaker_agent_id,
          input_message_id, run_id, output_message_id, state, assessment_json,
          reply_hash, created_at, updated_at, completed_at, wave_id,
          wave_member_ordinal, terminal_reason
        ) VALUES (
          @turnId, @discussionId, @ordinal, @kind, @speakerAgentId,
          @inputMessageId, @runId, @outputMessageId, @state, @assessmentJson,
          @replyHash, @createdAt, @updatedAt, @completedAt, @waveId,
          @waveMemberOrdinal, @terminalReason
        )
      `).run({
        ...turn,
        waveId: turn.waveId ?? null,
        waveMemberOrdinal: turn.waveMemberOrdinal ?? null,
        terminalReason: turn.terminalReason ?? null,
        assessmentJson: turn.assessment ? JSON.stringify(turn.assessment) : null
      });
    }).immediate();
    return turn;
  }

  public bindTurnRun(
    turnId: string,
    runId: string,
    state: "queued" | "working",
    now: string
  ): DiscussionTurn {
    const updated = this.database.prepare(`
      UPDATE discussion_turns
      SET run_id = ?, state = ?, updated_at = ?
      WHERE turn_id = ? AND run_id IS NULL AND state = 'planned'
    `).run(runId, state, now, turnId);
    if (updated.changes !== 1) {
      throw new Error("Discussion Turn is already bound to a Run");
    }
    return this.requireTurn(turnId);
  }

  public reanchorPlannedTurn(
    turnId: string,
    inputMessageId: string,
    now: string
  ): DiscussionTurn {
    const turn = this.requireTurn(turnId);
    if (turn.waveId) {
      this.reanchorPlannedWave(turn.waveId, inputMessageId, now);
      return this.requireTurn(turnId);
    }
    const updated = this.database.prepare(`
      UPDATE discussion_turns
      SET input_message_id = ?, updated_at = ?
      WHERE turn_id = ? AND run_id IS NULL AND state = 'planned'
    `).run(inputMessageId, now, turnId);
    if (updated.changes !== 1) {
      throw new Error("Discussion Turn cannot be reanchored after Run binding");
    }
    return this.requireTurn(turnId);
  }

  public reanchorPlannedWave(
    waveId: string,
    inputMessageId: string,
    now: string
  ): DiscussionWave {
    this.database.transaction(() => {
      const wave = this.requireWave(waveId);
      const members = this.listTurnsForWave(waveId);
      if (
        wave.state !== "open" || members.length !== wave.expectedMembers ||
        members.some(({ runId, state }) => runId !== null || state !== "planned")
      ) {
        throw new Error("Discussion Wave cannot be reanchored after Run binding");
      }
      const turnsUpdated = this.database.prepare(`
        UPDATE discussion_turns
        SET input_message_id = ?, updated_at = ?
        WHERE wave_id = ? AND run_id IS NULL AND state = 'planned'
      `).run(inputMessageId, now, waveId);
      if (turnsUpdated.changes !== wave.expectedMembers) {
        throw new Error("Discussion Wave member set changed during reanchor");
      }
      const waveUpdated = this.database.prepare(`
        UPDATE discussion_waves
        SET input_message_id = ?, version = version + 1, updated_at = ?
        WHERE wave_id = ? AND version = ? AND state = 'open'
      `).run(inputMessageId, now, waveId, wave.version);
      if (waveUpdated.changes !== 1) {
        throw new Error("Stale Discussion Wave version");
      }
    }).immediate();
    return this.requireWave(waveId);
  }

  public completeTurn(input: {
    turnId: string;
    outputMessageId: string | null;
    state: "completed" | "failed" | "canceled";
    assessment: AgentAssessment | null;
    replyHash: string | null;
    now: string;
  }): DiscussionTurn {
    return this.settleTurn(input).turn;
  }

  public settleTurn(input: {
    turnId: string;
    outputMessageId: string | null;
    state: "completed" | "failed" | "canceled";
    assessment: AgentAssessment | null;
    replyHash: string | null;
    terminalReason?: string | null;
    now: string;
  }): SettleDiscussionTurnResult {
    const updated = this.database.prepare(`
      UPDATE discussion_turns
      SET output_message_id = ?, state = ?, assessment_json = ?, reply_hash = ?,
          terminal_reason = ?, updated_at = ?, completed_at = ?
      WHERE turn_id = ? AND state NOT IN ('completed', 'failed', 'canceled')
    `).run(
      input.outputMessageId,
      input.state,
      input.assessment ? JSON.stringify(input.assessment) : null,
      input.replyHash,
      input.terminalReason ?? null,
      input.now,
      input.now,
      input.turnId
    );
    return {
      applied: updated.changes === 1,
      turn: this.requireTurn(input.turnId)
    };
  }

  public findTurnByRun(runId: string): DiscussionTurn | undefined {
    const row = this.database.prepare(`
      SELECT * FROM discussion_turns WHERE run_id = ?
    `).get(runId) as TurnRow | undefined;
    return row && mapTurn(row);
  }

  public getTurn(turnId: string): DiscussionTurn | undefined {
    const row = this.database.prepare(`
      SELECT * FROM discussion_turns WHERE turn_id = ?
    `).get(turnId) as TurnRow | undefined;
    return row && mapTurn(row);
  }

  public listTurns(discussionId: string): DiscussionTurn[] {
    return (this.database.prepare(`
      SELECT * FROM discussion_turns
      WHERE discussion_id = ? ORDER BY ordinal
    `).all(discussionId) as TurnRow[]).map(mapTurn);
  }

  public getWave(waveId: string): DiscussionWave | undefined {
    const row = this.database.prepare(`
      SELECT * FROM discussion_waves WHERE wave_id = ?
    `).get(waveId) as WaveRow | undefined;
    return row && mapWave(row);
  }

  public listWaves(discussionId: string): DiscussionWave[] {
    return (this.database.prepare(`
      SELECT * FROM discussion_waves
      WHERE discussion_id = ? ORDER BY ordinal
    `).all(discussionId) as WaveRow[]).map(mapWave);
  }

  public listOpenWaves(): DiscussionWave[] {
    return (this.database.prepare(`
      SELECT * FROM discussion_waves
      WHERE state = 'open' ORDER BY deadline_at, discussion_id, ordinal
    `).all() as WaveRow[]).map(mapWave);
  }

  public listTurnsForWave(waveId: string): DiscussionTurn[] {
    return (this.database.prepare(`
      SELECT * FROM discussion_turns
      WHERE wave_id = ? ORDER BY wave_member_ordinal, ordinal
    `).all(waveId) as TurnRow[]).map(mapTurn);
  }

  public recordDecisionAndUpdate(input: {
    decision: DiscussionDecision;
    expectedVersion: number;
    state: DiscussionState;
    stateReason: DiscussionStateReason | null;
    outputMode: DiscussionOutputMode;
    progress: ProgressSnapshot;
    budget: BudgetSnapshot;
    nextSpeakerIndex: number;
    requestedAction: DiscussionRecord["requestedAction"];
    terminalAt: string | null;
    budgetEvents?: DiscussionBudgetEvent[];
    closingWave?: {
      waveId: string;
      state: ClosedDiscussionWaveState;
      completedAt: string;
      expectedVersion?: number;
    };
  }): DiscussionRecord {
    this.database.transaction(() => {
      if (input.closingWave) {
        const closed = this.closeReadyWaveRow({
          waveId: input.closingWave.waveId,
          discussionId: input.decision.discussionId,
          state: input.closingWave.state,
          closedAt: input.closingWave.completedAt,
          ...(input.closingWave.expectedVersion === undefined
            ? {}
            : { expectedVersion: input.closingWave.expectedVersion })
        });
        if (!closed) {
          throw new Error("Discussion Wave is not ready or already closed");
        }
      }
      this.database.prepare(`
        INSERT INTO discussion_decisions (
          decision_id, discussion_id, aggregate_version, progress_version,
          action, reason, next_agent_id, output_mode, created_at
        ) VALUES (
          @decisionId, @discussionId, @aggregateVersion, @progressVersion,
          @action, @reason, @nextAgentId, @outputMode, @createdAt
        )
      `).run(input.decision);
      const updated = this.database.prepare(`
        UPDATE discussions
        SET state = ?, state_reason = ?, output_mode = ?, progress_json = ?,
            budget_json = ?, next_speaker_index = ?, requested_action = ?,
            version = version + 1, updated_at = ?, terminal_at = ?
        WHERE discussion_id = ? AND version = ?
      `).run(
        input.state,
        input.stateReason,
        input.outputMode,
        JSON.stringify(input.progress),
        JSON.stringify(input.budget),
        input.nextSpeakerIndex,
        input.requestedAction,
        input.decision.createdAt,
        input.terminalAt,
        input.decision.discussionId,
        input.expectedVersion
      );
      if (updated.changes !== 1) {
        throw new Error("Stale Discussion aggregate version");
      }
      for (const event of input.budgetEvents ?? []) {
        this.insertBudgetEvent(event);
      }
    }).immediate();
    return this.require(input.decision.discussionId);
  }

  public recordDecisionAndPlanTurn(input: {
    decision: DiscussionDecision;
    turn: DiscussionTurn;
    expectedVersion: number;
    state: DiscussionState;
    stateReason: DiscussionStateReason | null;
    outputMode: DiscussionOutputMode;
    progress: ProgressSnapshot;
    budget: BudgetSnapshot;
    nextSpeakerIndex: number;
    requestedAction: DiscussionRecord["requestedAction"];
    budgetEvents?: DiscussionBudgetEvent[];
  }): DiscussionRecord {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO discussion_decisions (
          decision_id, discussion_id, aggregate_version, progress_version,
          action, reason, next_agent_id, output_mode, created_at
        ) VALUES (
          @decisionId, @discussionId, @aggregateVersion, @progressVersion,
          @action, @reason, @nextAgentId, @outputMode, @createdAt
        )
      `).run(input.decision);
      const updated = this.database.prepare(`
        UPDATE discussions
        SET state = ?, state_reason = ?, output_mode = ?, progress_json = ?,
            budget_json = ?, current_turn = ?, next_speaker_index = ?,
            requested_action = ?, version = version + 1, updated_at = ?
        WHERE discussion_id = ? AND version = ?
      `).run(
        input.state,
        input.stateReason,
        input.outputMode,
        JSON.stringify(input.progress),
        JSON.stringify(input.budget),
        input.turn.ordinal,
        input.nextSpeakerIndex,
        input.requestedAction,
        input.decision.createdAt,
        input.decision.discussionId,
        input.expectedVersion
      );
      if (updated.changes !== 1) {
        throw new Error("Stale Discussion aggregate version");
      }
      this.database.prepare(`
        INSERT INTO discussion_turns (
          turn_id, discussion_id, ordinal, kind, speaker_agent_id,
          input_message_id, run_id, output_message_id, state, assessment_json,
          reply_hash, created_at, updated_at, completed_at, wave_id,
          wave_member_ordinal, terminal_reason
        ) VALUES (
          @turnId, @discussionId, @ordinal, @kind, @speakerAgentId,
          @inputMessageId, @runId, @outputMessageId, @state, @assessmentJson,
          @replyHash, @createdAt, @updatedAt, @completedAt, @waveId,
          @waveMemberOrdinal, @terminalReason
        )
      `).run({
        ...input.turn,
        waveId: input.turn.waveId ?? null,
        waveMemberOrdinal: input.turn.waveMemberOrdinal ?? null,
        terminalReason: input.turn.terminalReason ?? null,
        assessmentJson: input.turn.assessment
          ? JSON.stringify(input.turn.assessment)
          : null
      });
      for (const event of input.budgetEvents ?? []) {
        this.insertBudgetEvent(event);
      }
    }).immediate();
    return this.require(input.decision.discussionId);
  }

  public recordDecisionAndPlanWave(input: {
    decision: DiscussionDecision;
    wave: DiscussionWave;
    turns: DiscussionTurn[];
    expectedVersion: number;
    state: DiscussionState;
    stateReason: DiscussionStateReason | null;
    outputMode: DiscussionOutputMode;
    progress: ProgressSnapshot;
    budget: BudgetSnapshot;
    nextSpeakerIndex: number;
    requestedAction: DiscussionRecord["requestedAction"];
    budgetEvents?: DiscussionBudgetEvent[];
  }): DiscussionRecord {
    this.validateWavePlan(input.wave, input.turns);
    if (input.decision.discussionId !== input.wave.discussionId) {
      throw new Error("Discussion Wave decision targets another Discussion");
    }
    const currentTurn = Math.max(...input.turns.map(({ ordinal }) => ordinal));
    this.database.transaction(() => {
      this.insertDecision(input.decision);
      const updated = this.database.prepare(`
        UPDATE discussions
        SET state = ?, state_reason = ?, output_mode = ?, progress_json = ?,
            budget_json = ?, execution_model = 'parallel_wave',
            current_turn = ?, current_wave = ?, next_speaker_index = ?,
            requested_action = ?, version = version + 1, updated_at = ?
        WHERE discussion_id = ? AND version = ? AND current_wave = ?
      `).run(
        input.state,
        input.stateReason,
        input.outputMode,
        JSON.stringify(input.progress),
        JSON.stringify(input.budget),
        currentTurn,
        input.wave.ordinal,
        input.nextSpeakerIndex,
        input.requestedAction,
        input.decision.createdAt,
        input.decision.discussionId,
        input.expectedVersion,
        input.wave.ordinal - 1
      );
      if (updated.changes !== 1) {
        throw new Error("Stale Discussion aggregate version");
      }
      this.insertWave(input.wave);
      for (const turn of input.turns) {
        this.insertTurn(turn);
      }
      for (const event of input.budgetEvents ?? []) {
        this.insertBudgetEvent(event);
      }
    }).immediate();
    return this.require(input.decision.discussionId);
  }

  public closeWave(input: {
    waveId: string;
    expectedVersion: number;
    state: ClosedDiscussionWaveState;
    now: string;
  }): CloseDiscussionWaveResult {
    const current = this.getWave(input.waveId);
    if (!current) {
      throw new Error(`Discussion Wave not found: ${input.waveId}`);
    }
    const applied = this.database.transaction(() => this.closeReadyWaveRow({
      waveId: input.waveId,
      discussionId: current.discussionId,
      state: input.state,
      closedAt: input.now,
      expectedVersion: input.expectedVersion
    })).immediate();
    return { applied, wave: this.requireWave(input.waveId) };
  }

  public closeReadyWaveAndApply(input: {
    waveId: string;
    expectedWaveVersion: number;
    closeState: ClosedDiscussionWaveState;
    closedAt: string;
    decision: DiscussionDecision;
    expectedDiscussionVersion: number;
    state: DiscussionState;
    stateReason: DiscussionStateReason | null;
    outputMode: DiscussionOutputMode;
    progress: ProgressSnapshot;
    budget: BudgetSnapshot;
    nextSpeakerIndex: number;
    requestedAction: DiscussionRecord["requestedAction"];
    terminalAt: string | null;
    budgetEvents?: DiscussionBudgetEvent[];
    nextWave?: {
      wave: DiscussionWave;
      turns: DiscussionTurn[];
    };
  }): ApplyDiscussionWaveResult {
    if (input.nextWave) {
      this.validateWavePlan(input.nextWave.wave, input.nextWave.turns);
      if (input.nextWave.wave.discussionId !== input.decision.discussionId) {
        throw new Error("Next Discussion Wave targets another Discussion");
      }
    }
    const applied = this.database.transaction(() => {
      const aggregate = this.database.prepare(`
        SELECT version, current_wave FROM discussions
        WHERE discussion_id = ?
      `).get(input.decision.discussionId) as {
        version: number;
        current_wave: number;
      } | undefined;
      const currentWave = this.getWave(input.waveId);
      if (
        !aggregate || aggregate.version !== input.expectedDiscussionVersion ||
        !currentWave || currentWave.discussionId !== input.decision.discussionId ||
        aggregate.current_wave !== currentWave.ordinal ||
        (input.nextWave !== undefined &&
          input.nextWave.wave.ordinal !== currentWave.ordinal + 1)
      ) {
        return false;
      }
      const closed = this.closeReadyWaveRow({
        waveId: input.waveId,
        discussionId: input.decision.discussionId,
        state: input.closeState,
        closedAt: input.closedAt,
        expectedVersion: input.expectedWaveVersion
      });
      if (!closed) {
        return false;
      }
      this.insertDecision(input.decision);
      const nextCurrentTurn = input.nextWave
        ? Math.max(...input.nextWave.turns.map(({ ordinal }) => ordinal))
        : null;
      const nextCurrentWave = input.nextWave?.wave.ordinal ?? null;
      const updated = this.database.prepare(`
        UPDATE discussions
        SET state = ?, state_reason = ?, output_mode = ?, progress_json = ?,
            budget_json = ?,
            current_turn = coalesce(?, current_turn),
            current_wave = coalesce(?, current_wave),
            next_speaker_index = ?, requested_action = ?,
            version = version + 1, updated_at = ?, terminal_at = ?
        WHERE discussion_id = ? AND version = ?
      `).run(
        input.state,
        input.stateReason,
        input.outputMode,
        JSON.stringify(input.progress),
        JSON.stringify(input.budget),
        nextCurrentTurn,
        nextCurrentWave,
        input.nextSpeakerIndex,
        input.requestedAction,
        input.decision.createdAt,
        input.terminalAt,
        input.decision.discussionId,
        input.expectedDiscussionVersion
      );
      if (updated.changes !== 1) {
        throw new Error("Stale Discussion aggregate version");
      }
      if (input.nextWave) {
        this.insertWave(input.nextWave.wave);
        for (const turn of input.nextWave.turns) {
          this.insertTurn(turn);
        }
      }
      for (const event of input.budgetEvents ?? []) {
        this.insertBudgetEvent(event);
      }
      return true;
    }).immediate();
    return {
      applied,
      discussion: this.require(input.decision.discussionId),
      wave: this.requireWave(input.waveId)
    };
  }

  public requestAction(input: {
    discussionId: string;
    expectedVersion: number;
    action: DiscussionRecord["requestedAction"];
    state: DiscussionState;
    stateReason: DiscussionStateReason | null;
    now: string;
  }): DiscussionRecord {
    const updated = this.database.prepare(`
      UPDATE discussions
      SET requested_action = ?, state = ?, state_reason = ?,
          version = version + 1, updated_at = ?
      WHERE discussion_id = ? AND version = ?
    `).run(
      input.action,
      input.state,
      input.stateReason,
      input.now,
      input.discussionId,
      input.expectedVersion
    );
    if (updated.changes !== 1) {
      throw new Error("Stale Discussion aggregate version");
    }
    return this.require(input.discussionId);
  }

  public updateGoal(input: {
    discussionId: string;
    expectedVersion: number;
    goal: string;
    now: string;
  }): DiscussionRecord {
    const updated = this.database.prepare(`
      UPDATE discussions
      SET goal = ?, state = 'active', state_reason = NULL,
          requested_action = NULL, version = version + 1, updated_at = ?
      WHERE discussion_id = ? AND version = ?
    `).run(input.goal, input.now, input.discussionId, input.expectedVersion);
    if (updated.changes !== 1) {
      throw new Error("Stale Discussion aggregate version");
    }
    return this.require(input.discussionId);
  }

  public finishFinalization(input: {
    discussionId: string;
    expectedVersion: number;
    state: "completed" | "terminated";
    now: string;
    closingWave?: {
      waveId: string;
      state: ClosedDiscussionWaveState;
      expectedVersion?: number;
    };
  }): DiscussionRecord {
    this.database.transaction(() => {
      if (input.closingWave) {
        const closed = this.closeReadyWaveRow({
          waveId: input.closingWave.waveId,
          discussionId: input.discussionId,
          state: input.closingWave.state,
          closedAt: input.now,
          ...(input.closingWave.expectedVersion === undefined
            ? {}
            : { expectedVersion: input.closingWave.expectedVersion })
        });
        if (!closed) {
          throw new Error("Finalization Wave is not ready or already closed");
        }
      }
      const updated = this.database.prepare(`
        UPDATE discussions
        SET state = ?, requested_action = NULL, version = version + 1,
            updated_at = ?, terminal_at = ?
        WHERE discussion_id = ? AND version = ? AND state = 'finalizing'
      `).run(
        input.state,
        input.now,
        input.now,
        input.discussionId,
        input.expectedVersion
      );
      if (updated.changes !== 1) {
        throw new Error("Stale or non-finalizing Discussion aggregate");
      }
    }).immediate();
    return this.require(input.discussionId);
  }

  public closeFinalizationAndFinish(input: {
    discussionId: string;
    expectedDiscussionVersion: number;
    state: "completed" | "terminated";
    waveId: string;
    expectedWaveVersion: number;
    waveState: ClosedDiscussionWaveState;
    now: string;
  }): DiscussionRecord {
    return this.finishFinalization({
      discussionId: input.discussionId,
      expectedVersion: input.expectedDiscussionVersion,
      state: input.state,
      now: input.now,
      closingWave: {
        waveId: input.waveId,
        state: input.waveState,
        expectedVersion: input.expectedWaveVersion
      }
    });
  }

  public listPlannedTurns(): DiscussionTurn[] {
    return (this.database.prepare(`
      SELECT dt.*
      FROM discussion_turns dt
      JOIN discussions d ON d.discussion_id = dt.discussion_id
      WHERE dt.state = 'planned'
        AND d.state IN ('active', 'stop_requested', 'finalizing')
      ORDER BY dt.created_at, dt.turn_id
    `).all() as TurnRow[]).map(mapTurn);
  }

  public appendBudgetEvent(event: DiscussionBudgetEvent): void {
    this.insertBudgetEvent(event);
  }

  public listBudgetEvents(discussionId: string): DiscussionBudgetEvent[] {
    return (this.database.prepare(`
      SELECT * FROM discussion_budget_events
      WHERE discussion_id = ? ORDER BY ordinal
    `).all(discussionId) as BudgetEventRow[]).map((row) => ({
      budgetEventId: row.budget_event_id,
      discussionId: row.discussion_id,
      ordinal: row.ordinal,
      eventType: row.event_type,
      turns: row.turns,
      tokens: row.tokens,
      durationSeconds: row.duration_seconds,
      estimatedCostMicros: row.estimated_cost_micros,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
      createdAt: row.created_at
    }));
  }

  public listDecisions(discussionId: string): DiscussionDecision[] {
    return (this.database.prepare(`
      SELECT * FROM discussion_decisions
      WHERE discussion_id = ? ORDER BY aggregate_version
    `).all(discussionId) as DecisionRow[]).map((row) => ({
      decisionId: row.decision_id,
      discussionId: row.discussion_id,
      aggregateVersion: row.aggregate_version,
      progressVersion: row.progress_version,
      action: row.action,
      reason: row.reason,
      nextAgentId: row.next_agent_id,
      outputMode: row.output_mode,
      createdAt: row.created_at
    }));
  }

  private closeReadyWaveRow(input: {
    waveId: string;
    discussionId: string;
    state: ClosedDiscussionWaveState;
    closedAt: string;
    expectedVersion?: number;
  }): boolean {
    const updated = this.database.prepare(`
      UPDATE discussion_waves
      SET state = ?, version = version + 1, updated_at = ?, closed_at = ?
      WHERE wave_id = ? AND discussion_id = ? AND state = 'open'
        AND (? IS NULL OR version = ?)
        AND expected_members = (
          SELECT count(*) FROM discussion_turns
          WHERE wave_id = discussion_waves.wave_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM discussion_turns
          WHERE wave_id = discussion_waves.wave_id
            AND state NOT IN ('completed', 'failed', 'canceled')
        )
    `).run(
      input.state,
      input.closedAt,
      input.closedAt,
      input.waveId,
      input.discussionId,
      input.expectedVersion ?? null,
      input.expectedVersion ?? null
    );
    return updated.changes === 1;
  }

  private insertDecision(decision: DiscussionDecision): void {
    this.database.prepare(`
      INSERT INTO discussion_decisions (
        decision_id, discussion_id, aggregate_version, progress_version,
        action, reason, next_agent_id, output_mode, created_at
      ) VALUES (
        @decisionId, @discussionId, @aggregateVersion, @progressVersion,
        @action, @reason, @nextAgentId, @outputMode, @createdAt
      )
    `).run(decision);
  }

  private insertWave(wave: DiscussionWave): void {
    this.database.prepare(`
      INSERT INTO discussion_waves (
        wave_id, discussion_id, ordinal, phase, input_message_id, state,
        deadline_at, expected_members, version, created_at, updated_at,
        closed_at
      ) VALUES (
        @waveId, @discussionId, @ordinal, @phase, @inputMessageId, @state,
        @deadlineAt, @expectedMembers, @version, @createdAt, @updatedAt,
        @closedAt
      )
    `).run(wave);
  }

  private insertTurn(turn: DiscussionTurn): void {
    this.database.prepare(`
      INSERT INTO discussion_turns (
        turn_id, discussion_id, ordinal, kind, speaker_agent_id,
        input_message_id, run_id, output_message_id, state, assessment_json,
        reply_hash, created_at, updated_at, completed_at, wave_id,
        wave_member_ordinal, terminal_reason
      ) VALUES (
        @turnId, @discussionId, @ordinal, @kind, @speakerAgentId,
        @inputMessageId, @runId, @outputMessageId, @state, @assessmentJson,
        @replyHash, @createdAt, @updatedAt, @completedAt, @waveId,
        @waveMemberOrdinal, @terminalReason
      )
    `).run({
      ...turn,
      assessmentJson: turn.assessment ? JSON.stringify(turn.assessment) : null,
      waveId: turn.waveId ?? null,
      waveMemberOrdinal: turn.waveMemberOrdinal ?? null,
      terminalReason: turn.terminalReason ?? null
    });
  }

  private validateWavePlan(wave: DiscussionWave, turns: DiscussionTurn[]): void {
    if (
      wave.state !== "open" || wave.closedAt !== null ||
      !Number.isSafeInteger(wave.expectedMembers) ||
      wave.expectedMembers !== turns.length || turns.length === 0
    ) {
      throw new Error("Discussion Wave member count is inconsistent");
    }
    const memberOrdinals = new Set<number>();
    const agents = new Set<string>();
    const turnOrdinals = new Set<number>();
    for (const turn of turns) {
      const memberOrdinal = turn.waveMemberOrdinal;
      if (
        turn.discussionId !== wave.discussionId || turn.waveId !== wave.waveId ||
        turn.inputMessageId !== wave.inputMessageId ||
        memberOrdinal === undefined || memberOrdinal === null ||
        !Number.isSafeInteger(memberOrdinal) || memberOrdinal < 0 ||
        memberOrdinal >= turns.length || memberOrdinals.has(memberOrdinal) ||
        agents.has(turn.speakerAgentId) || turnOrdinals.has(turn.ordinal) ||
        turn.state !== "planned" || turn.runId !== null ||
        turn.outputMessageId !== null || turn.completedAt !== null ||
        (wave.phase === "finalization") !== (turn.kind === "finalization")
      ) {
        throw new Error("Discussion Wave contains an invalid member Turn");
      }
      memberOrdinals.add(memberOrdinal);
      agents.add(turn.speakerAgentId);
      turnOrdinals.add(turn.ordinal);
    }
  }

  private insertBudgetEvent(event: DiscussionBudgetEvent): void {
    this.database.prepare(`
      INSERT INTO discussion_budget_events (
        budget_event_id, discussion_id, ordinal, event_type, turns, tokens,
        duration_seconds, estimated_cost_micros, metadata_json, created_at
      ) VALUES (
        @budgetEventId, @discussionId, @ordinal, @eventType, @turns, @tokens,
        @durationSeconds, @estimatedCostMicros, @metadataJson, @createdAt
      )
    `).run({ ...event, metadataJson: JSON.stringify(event.metadata) });
  }

  private require(discussionId: string): DiscussionRecord {
    const discussion = this.get(discussionId);
    if (!discussion) {
      throw new Error(`Discussion not found: ${discussionId}`);
    }
    return discussion;
  }

  private requireTurn(turnId: string): DiscussionTurn {
    const turn = this.getTurn(turnId);
    if (!turn) {
      throw new Error(`Discussion Turn not found: ${turnId}`);
    }
    return turn;
  }

  private requireWave(waveId: string): DiscussionWave {
    const wave = this.getWave(waveId);
    if (!wave) {
      throw new Error(`Discussion Wave not found: ${waveId}`);
    }
    return wave;
  }
}
