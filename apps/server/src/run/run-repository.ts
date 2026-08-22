import type Database from "better-sqlite3";

export type RunState =
  | "queued"
  | "delivered"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled"
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
}
