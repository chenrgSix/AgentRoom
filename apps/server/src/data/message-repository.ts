import type Database from "better-sqlite3";

import { createOpaqueId } from "../domain/identifiers.js";
import type { MessageRecord } from "./core-repository.js";
import { SqliteTransactionBoundary } from "./sqlite-transaction-boundary.js";

interface MessageRow {
  message_id: string;
  trace_id: string;
  room_id: string;
  task_id: string;
  sequence: number;
  sender_type: MessageRecord["senderType"];
  sender_id: string;
  content: string;
  parent_message_id: string | null;
  client_message_id: string | null;
  created_at: string;
}

export type AppendMessageInput = Omit<
  MessageRecord,
  "sequence" | "traceId" | "taskId"
> & {
  traceId?: string;
  taskId?: string;
};

export class MessageRepository {
  public constructor(
    private readonly database: Database.Database,
    private readonly transactions = new SqliteTransactionBoundary(database)
  ) {}

  public append(message: AppendMessageInput): MessageRecord {
    return this.appendWithResult(message).message;
  }

  public appendWithResult(
    message: AppendMessageInput
  ): { created: boolean; message: MessageRecord } {
    const persistedMessage = {
      ...message,
      clientMessageId: message.clientMessageId ?? null,
      traceId: message.traceId ?? createOpaqueId("trace")
    };
    return this.transactions.immediate(() => {
      const room = this.database.prepare(`
        SELECT team_id FROM rooms WHERE room_id = ?
      `).get(persistedMessage.roomId) as { team_id: string } | undefined;
      if (!room) {
        throw new Error(`Room not found: ${persistedMessage.roomId}`);
      }

      const parentTask = persistedMessage.parentMessageId
        ? this.database.prepare(`
            SELECT task_id FROM messages
            WHERE message_id = ? AND room_id = ?
          `).get(persistedMessage.parentMessageId, persistedMessage.roomId) as
            | { task_id: string }
            | undefined
        : undefined;
      if (
        persistedMessage.taskId && parentTask &&
        persistedMessage.taskId !== parentTask.task_id
      ) {
        throw new Error("Reply Message must use its parent Task");
      }
      const resolvedTask = this.database.prepare(`
        SELECT task_id, state, lifecycle_state, scheduling_state, is_default,
          max_run_attempts, max_execution_duration_seconds,
          budget_run_attempts, budget_execution_duration_seconds
        FROM agent_tasks
        WHERE task_id = coalesce(?, task_id) AND room_id = ?
          AND (? IS NOT NULL OR is_default = 1)
        ORDER BY is_default DESC
        LIMIT 1
      `).get(
        persistedMessage.taskId ?? parentTask?.task_id ?? null,
        persistedMessage.roomId,
        persistedMessage.taskId ?? parentTask?.task_id ?? null
      ) as {
        task_id: string;
        state: string;
        lifecycle_state: string;
        scheduling_state: string;
        is_default: number;
        max_run_attempts: number;
        max_execution_duration_seconds: number;
        budget_run_attempts: number;
        budget_execution_duration_seconds: number;
      } | undefined;
      if (!resolvedTask) {
        throw new Error("Message Task must belong to its Room");
      }
      const taskMessage = { ...persistedMessage, taskId: resolvedTask.task_id };

      if (persistedMessage.clientMessageId) {
        const existing = this.database.prepare(`
          SELECT * FROM messages
          WHERE room_id = ? AND sender_type = ? AND sender_id = ?
            AND client_message_id = ?
        `).get(
          persistedMessage.roomId,
          persistedMessage.senderType,
          persistedMessage.senderId,
          persistedMessage.clientMessageId
        ) as MessageRow | undefined;
        if (existing) {
          if (existing.task_id !== taskMessage.taskId) {
            throw new Error("Client Message ID is already bound to another Task");
          }
          return { created: false, message: this.map(existing) };
        }
      }

      if (taskMessage.mentions.length > 0 && (
        !["ready", "active", "review"].includes(resolvedTask.lifecycle_state) ||
        resolvedTask.scheduling_state !== "enabled" ||
        resolvedTask.budget_run_attempts >= resolvedTask.max_run_attempts ||
        resolvedTask.budget_execution_duration_seconds >=
          resolvedTask.max_execution_duration_seconds
      )) {
        throw new Error(
          `Task is not runnable in state ${resolvedTask.lifecycle_state}`
        );
      }

      const findAgent = this.database.prepare(`
        SELECT team_id, enabled FROM agents WHERE agent_id = ?
      `);
      for (const mention of taskMessage.mentions) {
        const agent = findAgent.get(mention.targetAgentId) as
          | { team_id: string; enabled: number }
          | undefined;
        if (!agent || agent.team_id !== room.team_id || agent.enabled !== 1) {
          throw new Error(`Mention target is unavailable: ${mention.targetAgentId}`);
        }
        if (resolvedTask.is_default !== 1 && !this.database.prepare(`
          SELECT 1 FROM task_agent_assignments
          WHERE task_id = ? AND agent_id = ?
        `).get(resolvedTask.task_id, mention.targetAgentId)) {
          throw new Error(
            `Mention target is not assigned to Task: ${mention.targetAgentId}`
          );
        }
      }

      const sequenceRow = this.database.prepare(`
        UPDATE rooms
        SET next_message_sequence = next_message_sequence + 1
        WHERE room_id = ?
        RETURNING next_message_sequence AS sequence
      `).get(taskMessage.roomId) as { sequence: number };

      this.database.prepare(`
        INSERT INTO messages (
          message_id, trace_id, room_id, task_id, sequence, sender_type,
          sender_id, content, parent_message_id, client_message_id, created_at
        ) VALUES (
          @messageId, @traceId, @roomId, @taskId, @sequence, @senderType,
          @senderId, @content, @parentMessageId, @clientMessageId, @createdAt
        )
      `).run({ ...taskMessage, sequence: sequenceRow.sequence });

      const insertMention = this.database.prepare(`
        INSERT INTO message_mentions (
          message_id, ordinal, target_type, target_agent_id, display_label
        ) VALUES (?, ?, 'agent', ?, ?)
      `);
      for (const [ordinal, mention] of taskMessage.mentions.entries()) {
        insertMention.run(
          taskMessage.messageId,
          ordinal,
          mention.targetAgentId,
          mention.displayLabel
        );
      }

      return {
        created: true,
        message: { ...taskMessage, sequence: sequenceRow.sequence }
      };
    });
  }

  public get(messageId: string): MessageRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM messages WHERE message_id = ?
    `).get(messageId) as MessageRow | undefined;
    return row && this.map(row);
  }

  public findAgentReply(
    parentMessageId: string,
    agentId: string
  ): MessageRecord | undefined {
    const row = this.database.prepare(`
      SELECT * FROM messages
      WHERE parent_message_id = ? AND sender_type = 'agent' AND sender_id = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(parentMessageId, agentId) as MessageRow | undefined;
    return row && this.map(row);
  }

  public listAfter(
    roomId: string,
    sequence: number,
    limit: number
  ): MessageRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM messages
      WHERE room_id = ? AND sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(roomId, sequence, limit) as MessageRow[];
    return rows.map((row) => this.map(row));
  }

  public listRange(
    roomId: string,
    fromSequenceExclusive: number,
    throughSequenceInclusive: number,
    limit: number
  ): MessageRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM messages
      WHERE room_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence
      LIMIT ?
    `).all(
      roomId,
      fromSequenceExclusive,
      throughSequenceInclusive,
      limit
    ) as MessageRow[];
    return rows.map((row) => this.map(row));
  }

  public listThrough(
    roomId: string,
    sequence: number,
    limit: number
  ): MessageRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE room_id = ? AND sequence <= ?
        ORDER BY sequence DESC
        LIMIT ?
      ) ORDER BY sequence
    `).all(roomId, sequence, limit) as MessageRow[];
    return rows.map((row) => this.map(row));
  }

  public listTaskThrough(
    taskId: string,
    sequence: number,
    limit: number
  ): MessageRecord[] {
    const rows = this.database.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE task_id = ? AND sequence <= ?
        ORDER BY sequence DESC
        LIMIT ?
      ) ORDER BY sequence
    `).all(taskId, sequence, limit) as MessageRow[];
    return rows.map((row) => this.map(row));
  }

  public latestSequence(roomId: string): number {
    const row = this.database.prepare(`
      SELECT next_message_sequence AS sequence FROM rooms WHERE room_id = ?
    `).get(roomId) as { sequence: number } | undefined;
    if (!row) {
      throw new Error(`Room not found: ${roomId}`);
    }
    return row.sequence;
  }

  private map(row: MessageRow): MessageRecord {
    const mentions = this.database.prepare(`
      SELECT target_type, target_agent_id, display_label
      FROM message_mentions WHERE message_id = ? ORDER BY ordinal
    `).all(row.message_id) as Array<{
      target_type: "agent";
      target_agent_id: string;
      display_label: string;
    }>;
    return {
      messageId: row.message_id,
      traceId: row.trace_id,
      roomId: row.room_id,
      taskId: row.task_id,
      sequence: row.sequence,
      senderType: row.sender_type,
      senderId: row.sender_id,
      content: row.content,
      mentions: mentions.map((mention) => ({
        targetType: mention.target_type,
        targetAgentId: mention.target_agent_id,
        displayLabel: mention.display_label
      })),
      parentMessageId: row.parent_message_id,
      clientMessageId: row.client_message_id,
      createdAt: row.created_at
    };
  }
}
