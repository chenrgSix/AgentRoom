export interface SequencedRoomMessage {
  messageId: string;
  sequence: number;
}

export interface RunOutputProjection {
  sequence: number;
  content: string;
  sealed: boolean;
}

export interface RunActivityItem {
  activityId: string;
  kind: "reasoning" | "tool";
  phase: "started" | "updated" | "completed" | "failed";
  label?: string;
  content: string;
  sequence: number;
}

export interface RunActivityProjection {
  sequence: number;
  items: RunActivityItem[];
  sealed: boolean;
}

export interface TeamChangeHint {
  changed: boolean;
  reset: boolean;
  team?: boolean;
  roomIds?: string[];
  runRoomIds?: string[];
}

export function teamChangeRefreshScope(
  change: TeamChangeHint,
  selectedRoomId: string
): "full" | "room" | "events" | null {
  const legacy = change.team === undefined && change.roomIds === undefined &&
    change.runRoomIds === undefined;
  if (change.reset || change.team === true || legacy) return "full";
  if (change.roomIds?.includes(selectedRoomId)) return "room";
  if (change.runRoomIds?.includes(selectedRoomId)) return "events";
  return null;
}

export interface RunEventRecord {
  sequence: number;
  event:
    | { type: "status"; sequence: number; status: string }
    | {
        type: "activity";
        sequence: number;
        activityId: string;
        kind: "reasoning" | "tool";
        phase: "started" | "updated" | "completed" | "failed";
        label?: string;
        content?: string;
        reset?: boolean;
      }
    | { type: "output"; sequence: number; content: string; reset?: boolean }
    | { type: "reply"; sequence: number; content: string };
}

export function reduceRunActivities(
  current: RunActivityProjection | undefined,
  records: RunEventRecord[]
): RunActivityProjection {
  const projection: RunActivityProjection = current
    ? { ...current, items: current.items.map((item) => ({ ...item })) }
    : { sequence: 0, items: [], sealed: false };
  for (const record of [...records].sort((left, right) =>
    left.sequence - right.sequence
  )) {
    if (record.sequence <= projection.sequence) continue;
    if (record.sequence !== projection.sequence + 1) break;
    projection.sequence = record.sequence;
    if (record.event.type === "activity") {
      const activity = record.event;
      const index = projection.items.findIndex(
        ({ activityId }) => activityId === activity.activityId
      );
      const existing = index >= 0 ? projection.items[index] : undefined;
      const content = activity.content === undefined
        ? existing?.content ?? ""
        : activity.reset
          ? activity.content
          : `${existing?.content ?? ""}${activity.content}`.slice(-20_000);
      const label = activity.label ?? existing?.label;
      const item: RunActivityItem = {
        activityId: activity.activityId,
        kind: activity.kind,
        phase: activity.phase,
        ...(label ? { label } : {}),
        content,
        sequence: record.sequence
      };
      if (index >= 0) projection.items[index] = item;
      else projection.items.push(item);
    } else if (
      record.event.type === "reply" ||
      (record.event.type === "status" && terminalRunStatuses.has(record.event.status))
    ) {
      projection.sealed = true;
    }
  }
  return projection;
}

const terminalRunStatuses = new Set([
  "completed",
  "failed",
  "canceled",
  "expired",
  "outcome_unknown"
]);

export function reduceRunOutput(
  current: RunOutputProjection | undefined,
  records: RunEventRecord[]
): RunOutputProjection {
  const projection: RunOutputProjection = current
    ? { ...current }
    : { sequence: 0, content: "", sealed: false };
  for (const record of [...records].sort((left, right) =>
    left.sequence - right.sequence
  )) {
    if (record.sequence <= projection.sequence) continue;
    if (record.sequence !== projection.sequence + 1) break;
    projection.sequence = record.sequence;
    if (projection.sealed) continue;
    if (record.event.type === "output") {
      projection.content = record.event.reset
        ? record.event.content
        : projection.content + record.event.content;
    } else if (
      record.event.type === "reply" ||
      (record.event.type === "status" && terminalRunStatuses.has(record.event.status))
    ) {
      projection.content = "";
      projection.sealed = true;
    }
  }
  return projection;
}

export function mergeRoomMessages<T extends SequencedRoomMessage>(
  current: T[],
  incoming: T[],
  historyLimit = 500
): T[] {
  const messages = new Map(current.map((message) => [message.messageId, message]));
  for (const message of incoming) {
    messages.set(message.messageId, message);
  }
  return [...messages.values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-historyLimit);
}

export function createSingleFlight(task: () => Promise<void>): () => Promise<boolean> {
  let running = false;
  return async () => {
    if (running) return false;
    running = true;
    try {
      await task();
      return true;
    } finally {
      running = false;
    }
  };
}
