export interface SequencedRoomMessage {
  messageId: string;
  sequence: number;
}

export interface RunOutputProjection {
  sequence: number;
  content: string;
  sealed: boolean;
}

export interface RunEventRecord {
  sequence: number;
  event:
    | { type: "status"; sequence: number; status: string }
    | { type: "output"; sequence: number; content: string; reset?: boolean }
    | { type: "reply"; sequence: number; content: string };
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
