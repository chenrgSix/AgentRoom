import type Database from "better-sqlite3";

export type AgentTaskState =
  | "open"
  | "working"
  | "blocked"
  | "review"
  | "completed"
  | "canceled";

export interface AgentTaskRecord {
  taskId: string;
  roomId: string;
  parentTaskId: string | null;
  title: string;
  goal: string;
  state: AgentTaskState;
  primaryAgentId: string | null;
  workspaceRef: string | null;
  summary: string;
  lastRoomSequence: number;
  createdByMemberId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

interface AgentTaskRow {
  task_id: string;
  room_id: string;
  parent_task_id: string | null;
  title: string;
  goal: string;
  state: AgentTaskState;
  primary_agent_id: string | null;
  workspace_ref: string | null;
  summary: string;
  last_room_sequence: number;
  created_by_member_id: string;
  is_default: 0 | 1;
  created_at: string;
  updated_at: string;
}

function mapTask(row: AgentTaskRow): AgentTaskRecord {
  return {
    taskId: row.task_id,
    roomId: row.room_id,
    parentTaskId: row.parent_task_id,
    title: row.title,
    goal: row.goal,
    state: row.state,
    primaryAgentId: row.primary_agent_id,
    workspaceRef: row.workspace_ref,
    summary: row.summary,
    lastRoomSequence: row.last_room_sequence,
    createdByMemberId: row.created_by_member_id,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class AgentTaskRepository {
  public constructor(private readonly database: Database.Database) {}

  public create(task: AgentTaskRecord): AgentTaskRecord {
    this.database.prepare(`
      INSERT INTO agent_tasks (
        task_id, room_id, parent_task_id, title, goal, state,
        primary_agent_id, workspace_ref, summary, last_room_sequence,
        created_by_member_id, is_default, created_at, updated_at
      ) VALUES (
        @taskId, @roomId, @parentTaskId, @title, @goal, @state,
        @primaryAgentId, @workspaceRef, @summary, @lastRoomSequence,
        @createdByMemberId, @isDefault, @createdAt, @updatedAt
      )
    `).run({ ...task, isDefault: task.isDefault ? 1 : 0 });
    return task;
  }

  public get(taskId: string): AgentTaskRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM agent_tasks WHERE task_id = ?
    `).get(taskId) as AgentTaskRow | undefined;
    return row && mapTask(row);
  }

  public getDefaultForRoom(roomId: string): AgentTaskRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM agent_tasks WHERE room_id = ? AND is_default = 1
    `).get(roomId) as AgentTaskRow | undefined;
    return row && mapTask(row);
  }

  public listForRoom(roomId: string): AgentTaskRecord[] {
    return (this.database.prepare(`
      SELECT * FROM agent_tasks
      WHERE room_id = ?
      ORDER BY is_default DESC, updated_at DESC, task_id
    `).all(roomId) as AgentTaskRow[]).map(mapTask);
  }

  public hasActiveWork(taskId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM runs
        WHERE task_id = ?
          AND state NOT IN (
            'completed', 'failed', 'canceled', 'expired', 'outcome_unknown'
          )
      ) OR EXISTS (
        SELECT 1 FROM discussions
        WHERE task_id = ?
          AND state NOT IN ('completed', 'canceled', 'terminated')
      )
    `).get(taskId, taskId));
  }

  public update(
    taskId: string,
    input: Pick<
      AgentTaskRecord,
      "title" | "goal" | "state" | "primaryAgentId" | "workspaceRef" |
      "updatedAt"
    >
  ): AgentTaskRecord {
    const result = this.database.prepare(`
      UPDATE agent_tasks
      SET title = @title,
          goal = @goal,
          state = @state,
          primary_agent_id = @primaryAgentId,
          workspace_ref = @workspaceRef,
          updated_at = @updatedAt
      WHERE task_id = @taskId
    `).run({ taskId, ...input });
    if (result.changes !== 1) throw new Error(`Task not found: ${taskId}`);
    return this.get(taskId)!;
  }
}
