import type Database from "better-sqlite3";

export type TraceEntryKind = "message" | "run" | "delivery" | "run_event";

export interface TraceEntry {
  traceId: string;
  kind: TraceEntryKind;
  entityId: string;
  roomId: string;
  occurredAt: string;
  details: Record<string, unknown>;
}

interface TraceEntryRow {
  trace_id: string;
  kind: TraceEntryKind;
  entity_id: string;
  room_id: string;
  occurred_at: string;
  details_json: string;
}

export class TraceRepository {
  public constructor(private readonly database: Database.Database) {}

  public list(traceId: string): TraceEntry[] {
    const rows = this.database.prepare(`
      SELECT trace_id, kind, entity_id, room_id, occurred_at, details_json
      FROM (
        SELECT
          trace_id,
          'message' AS kind,
          message_id AS entity_id,
          room_id,
          created_at AS occurred_at,
          1 AS stage_order,
          json_object(
            'sequence', sequence,
            'senderType', sender_type,
            'senderId', sender_id,
            'parentMessageId', parent_message_id
          ) AS details_json
        FROM messages
        WHERE trace_id = ?

        UNION ALL

        SELECT
          trace_id,
          'run' AS kind,
          run_id AS entity_id,
          room_id,
          created_at AS occurred_at,
          2 AS stage_order,
          json_object(
            'triggerMessageId', trigger_message_id,
            'targetAgentId', target_agent_id,
            'parentRunId', parent_run_id,
            'state', state
          ) AS details_json
        FROM runs
        WHERE trace_id = ?

        UNION ALL

        SELECT
          d.trace_id,
          'delivery' AS kind,
          d.delivery_attempt_id AS entity_id,
          r.room_id,
          d.created_at AS occurred_at,
          3 AS stage_order,
          json_object(
            'runId', d.run_id,
            'deviceId', d.device_id,
            'state', d.state,
            'sendCount', d.send_count
          ) AS details_json
        FROM run_deliveries d
        JOIN runs r ON r.run_id = d.run_id
        WHERE d.trace_id = ?

        UNION ALL

        SELECT
          e.trace_id,
          'run_event' AS kind,
          e.run_id || ':' || e.sequence AS entity_id,
          r.room_id,
          e.created_at AS occurred_at,
          4 AS stage_order,
          json_object(
            'runId', e.run_id,
            'sequence', e.sequence,
            'eventType', e.event_type,
            'status', e.status
          ) AS details_json
        FROM run_events e
        JOIN runs r ON r.run_id = e.run_id
        WHERE e.trace_id = ?
      )
      ORDER BY occurred_at, stage_order, entity_id
    `).all(traceId, traceId, traceId, traceId) as TraceEntryRow[];

    return rows.map((row) => ({
      traceId: row.trace_id,
      kind: row.kind,
      entityId: row.entity_id,
      roomId: row.room_id,
      occurredAt: row.occurred_at,
      details: JSON.parse(row.details_json) as Record<string, unknown>
    }));
  }
}
