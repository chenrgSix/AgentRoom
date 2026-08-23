export interface SequencedRoomMessage {
  messageId: string;
  sequence: number;
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
