import type Database from "better-sqlite3";

export type TaskClarificationState = "waiting" | "resumed" | "canceled";
export type TaskClarificationResolutionReason =
  | "run_canceled"
  | "run_expired"
  | "run_terminal"
  | "task_terminal"
  | "agent_unavailable"
  | "orphaned";

export interface TaskClarificationRecord {
  clarificationId: string;
  taskId: string;
  roomId: string;
  requestingRunId: string;
  targetAgentId: string;
  question: string;
  choices: string[];
  state: TaskClarificationState;
  questionMessageId: string;
  answerMessageId: string | null;
  answeredByMemberId: string | null;
  continuationRunId: string | null;
  createdAt: string;
  answeredAt: string | null;
  resumedAt: string | null;
  resolutionReason: TaskClarificationResolutionReason | null;
  canceledAt: string | null;
}

interface TaskClarificationRow {
  clarification_id: string;
  task_id: string;
  room_id: string;
  requesting_run_id: string;
  target_agent_id: string;
  question: string;
  choices_json: string | null;
  state: TaskClarificationState;
  question_message_id: string;
  answer_message_id: string | null;
  answered_by_member_id: string | null;
  continuation_run_id: string | null;
  created_at: string;
  answered_at: string | null;
  resumed_at: string | null;
  resolution_reason: TaskClarificationResolutionReason | null;
  canceled_at: string | null;
}

function mapClarification(row: TaskClarificationRow): TaskClarificationRecord {
  return {
    clarificationId: row.clarification_id,
    taskId: row.task_id,
    roomId: row.room_id,
    requestingRunId: row.requesting_run_id,
    targetAgentId: row.target_agent_id,
    question: row.question,
    choices: row.choices_json
      ? JSON.parse(row.choices_json) as string[]
      : [],
    state: row.state,
    questionMessageId: row.question_message_id,
    answerMessageId: row.answer_message_id,
    answeredByMemberId: row.answered_by_member_id,
    continuationRunId: row.continuation_run_id,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    resumedAt: row.resumed_at,
    resolutionReason: row.resolution_reason,
    canceledAt: row.canceled_at
  };
}

export class ClarificationRepository {
  public constructor(private readonly database: Database.Database) {}

  public get(clarificationId: string): TaskClarificationRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM task_clarifications WHERE clarification_id = ?
    `).get(clarificationId) as TaskClarificationRow | undefined;
    return row && mapClarification(row);
  }

  public listForTask(taskId: string): TaskClarificationRecord[] {
    return (this.database.prepare(`
      SELECT * FROM task_clarifications
      WHERE task_id = ?
      ORDER BY created_at DESC, clarification_id DESC
    `).all(taskId) as TaskClarificationRow[]).map(mapClarification);
  }

  public listWaiting(taskId?: string): TaskClarificationRecord[] {
    return (this.database.prepare(`
      SELECT * FROM task_clarifications
      WHERE state = 'waiting' AND (@taskId IS NULL OR task_id = @taskId)
      ORDER BY created_at, clarification_id
    `).all({ taskId: taskId ?? null }) as TaskClarificationRow[])
      .map(mapClarification);
  }

  public cancelWaiting(input: {
    clarificationId: string;
    reason: TaskClarificationResolutionReason;
    now: string;
  }): TaskClarificationRecord {
    this.database.prepare(`
      UPDATE task_clarifications
      SET state = 'canceled', resolution_reason = @reason, canceled_at = @now
      WHERE clarification_id = @clarificationId AND state = 'waiting'
    `).run(input);
    const clarification = this.get(input.clarificationId);
    if (!clarification) {
      throw new Error(`Task clarification not found: ${input.clarificationId}`);
    }
    return clarification;
  }

  public markResumed(input: {
    clarificationId: string;
    answerMessageId: string;
    answeredByMemberId: string;
    continuationRunId: string;
    now: string;
  }): TaskClarificationRecord {
    const updated = this.database.prepare(`
      UPDATE task_clarifications
      SET state = 'resumed', answer_message_id = @answerMessageId,
          answered_by_member_id = @answeredByMemberId,
          continuation_run_id = @continuationRunId,
          answered_at = @now, resumed_at = @now
      WHERE clarification_id = @clarificationId AND state = 'waiting'
    `).run(input);
    if (updated.changes !== 1) {
      throw new Error("Task clarification was already resolved");
    }
    const clarification = this.get(input.clarificationId);
    if (!clarification) {
      throw new Error(`Task clarification not found: ${input.clarificationId}`);
    }
    return clarification;
  }
}
