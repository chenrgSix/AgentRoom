import type Database from "better-sqlite3";

import type {
  AgentAssessment,
  BudgetSnapshot,
  DiscussionBudgetEvent,
  DiscussionDecision,
  DiscussionOutputMode,
  DiscussionParticipant,
  DiscussionPolicy,
  DiscussionRecord,
  DiscussionState,
  DiscussionStateReason,
  DiscussionTurn,
  ProgressSnapshot
} from "./discussion-types.js";

interface DiscussionRow {
  discussion_id: string;
  room_id: string;
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
  current_turn: number;
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
  return {
    discussionId: row.discussion_id,
    roomId: row.room_id,
    rootMessageId: row.root_message_id,
    requesterMemberId: row.requester_member_id,
    goal: row.goal,
    mode: row.mode,
    state: row.state,
    stateReason: row.state_reason,
    outputMode: row.output_mode,
    policy: JSON.parse(row.policy_json) as DiscussionPolicy,
    progress: JSON.parse(row.progress_json) as ProgressSnapshot,
    budget: JSON.parse(row.budget_json) as BudgetSnapshot,
    currentTurn: row.current_turn,
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
    completedAt: row.completed_at
  };
}

export class DiscussionRepository {
  public constructor(private readonly database: Database.Database) {}

  public create(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[],
    initialBudgetEvent: DiscussionBudgetEvent
  ): DiscussionRecord {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO discussions (
          discussion_id, room_id, root_message_id, requester_member_id, goal,
          mode, state, state_reason, output_mode, policy_json, progress_json,
          budget_json, current_turn, next_speaker_index, requested_action,
          version, deadline_at, created_at, updated_at, terminal_at
        ) VALUES (
          @discussionId, @roomId, @rootMessageId, @requesterMemberId, @goal,
          @mode, @state, @stateReason, @outputMode, @policyJson, @progressJson,
          @budgetJson, @currentTurn, @nextSpeakerIndex, @requestedAction,
          @version, @deadlineAt, @createdAt, @updatedAt, @terminalAt
        )
      `).run({
        ...discussion,
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
          reply_hash, created_at, updated_at, completed_at
        ) VALUES (
          @turnId, @discussionId, @ordinal, @kind, @speakerAgentId,
          @inputMessageId, @runId, @outputMessageId, @state, @assessmentJson,
          @replyHash, @createdAt, @updatedAt, @completedAt
        )
      `).run({
        ...turn,
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

  public completeTurn(input: {
    turnId: string;
    outputMessageId: string | null;
    state: "completed" | "failed" | "canceled";
    assessment: AgentAssessment | null;
    replyHash: string | null;
    now: string;
  }): DiscussionTurn {
    const updated = this.database.prepare(`
      UPDATE discussion_turns
      SET output_message_id = ?, state = ?, assessment_json = ?, reply_hash = ?,
          updated_at = ?, completed_at = ?
      WHERE turn_id = ? AND state NOT IN ('completed', 'failed', 'canceled')
    `).run(
      input.outputMessageId,
      input.state,
      input.assessment ? JSON.stringify(input.assessment) : null,
      input.replyHash,
      input.now,
      input.now,
      input.turnId
    );
    if (updated.changes === 0) {
      return this.requireTurn(input.turnId);
    }
    return this.requireTurn(input.turnId);
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
    }).immediate();
    return this.require(input.decision.discussionId);
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
}
