import type Database from "better-sqlite3";

import type { RuntimeEvent } from "../runtime/runtime-adapter.js";

export type RunState =
  | "queued"
  | "delivered"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled"
  | "expired"
  | "outcome_unknown";

export interface RunRecord {
  runId: string;
  roomId: string;
  triggerMessageId: string;
  requesterMemberId: string;
  targetAgentId: string;
  parentRunId: string | null;
  instruction: string;
  state: RunState;
  lastSequence: number;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface RunEventRecord {
  runId: string;
  sequence: number;
  event: RuntimeEvent;
  createdAt: string;
}

export interface AppliedRunEvent {
  applied: boolean;
  run: RunRecord;
}

interface RunRow {
  run_id: string;
  room_id: string;
  trigger_message_id: string;
  requester_member_id: string;
  target_agent_id: string;
  parent_run_id: string | null;
  instruction: string;
  state: RunState;
  last_sequence: number;
  deadline_at: string;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
}

interface RunEventRow {
  run_id: string;
  sequence: number;
  event_type: RuntimeEvent["type"];
  status: RunState | null;
  content: string | null;
  assessment_json: string | null;
  error_json: string | null;
  created_at: string;
}

const terminalStates = new Set<RunState>([
  "completed",
  "failed",
  "canceled",
  "expired",
  "outcome_unknown"
]);

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    roomId: row.room_id,
    triggerMessageId: row.trigger_message_id,
    requesterMemberId: row.requester_member_id,
    targetAgentId: row.target_agent_id,
    parentRunId: row.parent_run_id,
    instruction: row.instruction,
    state: row.state,
    lastSequence: row.last_sequence,
    deadlineAt: row.deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at
  };
}

function mapRunEvent(row: RunEventRow): RunEventRecord {
  const event: RuntimeEvent = row.event_type === "reply"
      ? {
        type: "reply",
        sequence: row.sequence,
        content: row.content ?? "",
        ...(row.assessment_json
          ? { assessment: JSON.parse(row.assessment_json) as Record<string, unknown> }
          : {})
      }
    : {
        type: "status",
        sequence: row.sequence,
        status: row.status as Extract<RuntimeEvent, { type: "status" }>["status"],
        ...(row.error_json
          ? { error: JSON.parse(row.error_json) as {
              code: string;
              message: string;
              retryable: boolean;
            } }
          : {})
      };
  return {
    runId: row.run_id,
    sequence: row.sequence,
    event,
    createdAt: row.created_at
  };
}

export class RunRepository {
  public constructor(private readonly database: Database.Database) {}

  public createRuns(runs: RunRecord[]): RunRecord[] {
    const insert = this.database.prepare(`
      INSERT INTO runs (
        run_id, room_id, trigger_message_id, requester_member_id,
        target_agent_id, parent_run_id, instruction, state, last_sequence,
        deadline_at, created_at, updated_at, terminal_at
      ) VALUES (
        @runId, @roomId, @triggerMessageId, @requesterMemberId,
        @targetAgentId, @parentRunId, @instruction, @state, @lastSequence,
        @deadlineAt, @createdAt, @updatedAt, @terminalAt
      )
    `);
    this.database.transaction(() => {
      for (const run of runs) {
        insert.run(run);
      }
    }).immediate();
    return runs;
  }

  public getRun(runId: string): RunRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM runs WHERE run_id = ?
    `).get(runId) as RunRow | undefined;
    return row && mapRun(row);
  }

  public findByTrigger(messageId: string): RunRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM runs WHERE trigger_message_id = ? ORDER BY target_agent_id
    `).all(messageId) as RunRow[];
    return rows.map(mapRun);
  }

  public listRoomRuns(roomId: string): RunRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM runs WHERE room_id = ? ORDER BY created_at, run_id
    `).all(roomId) as RunRow[];
    return rows.map(mapRun);
  }

  public listAgentRuns(agentId: string): RunRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM runs
      WHERE target_agent_id = ?
      ORDER BY created_at, run_id
    `).all(agentId) as RunRow[];
    return rows.map(mapRun);
  }

  public expireQueued(roomId: string, now: string): RunRecord[] {
    const due = this.database.prepare(`
      SELECT run_id FROM runs
      WHERE room_id = ? AND state = 'queued' AND deadline_at <= ?
      ORDER BY created_at, run_id
    `).all(roomId, now) as Array<{ run_id: string }>;
    return due.map(({ run_id: runId }) => this.applyEvent(runId, {
      type: "status",
      sequence: (this.getRun(runId)?.lastSequence ?? 0) + 1,
      status: "expired",
      error: {
        code: "RUN_EXPIRED",
        message: "Run expired before its target Agent accepted delivery.",
        retryable: false
      }
    }, now).run);
  }

  public applyEvent(
    runId: string,
    event: RuntimeEvent,
    now: string
  ): AppliedRunEvent {
    return this.database.transaction(() => {
      const current = this.getRun(runId);
      if (!current) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (event.sequence <= current.lastSequence || terminalStates.has(current.state)) {
        return { applied: false, run: current };
      }
      if (event.sequence !== current.lastSequence + 1) {
        throw new Error(`Run event sequence gap: ${event.sequence}`);
      }

      const nextState = event.type === "status" ? event.status : current.state;
      const terminalAt = terminalStates.has(nextState) ? now : null;
      this.database.prepare(`
        INSERT INTO run_events (
          run_id, sequence, event_type, status, content, error_json,
          assessment_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        event.sequence,
        event.type,
        event.type === "status" ? event.status : null,
        event.type === "reply" ? event.content : null,
        event.type === "status" && event.error
          ? JSON.stringify(event.error)
          : null,
        event.type === "reply" && event.assessment
          ? JSON.stringify(event.assessment)
          : null,
        now
      );
      this.database.prepare(`
        UPDATE runs
        SET state = ?, last_sequence = ?, updated_at = ?, terminal_at = ?
        WHERE run_id = ?
      `).run(nextState, event.sequence, now, terminalAt, runId);
      const updated = this.getRun(runId);
      if (!updated) {
        throw new Error(`Run disappeared after event: ${runId}`);
      }
      return { applied: true, run: updated };
    }).immediate();
  }

  public listEvents(runId: string): RunEventRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence
    `).all(runId) as RunEventRow[];
    return rows.map(mapRunEvent);
  }
}
