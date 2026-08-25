export interface PendingRoomMessage {
  clientMessageId: string;
  roomId: string;
  taskId?: string;
  content: string;
  mentionAgentIds?: string[];
  status: "pending" | "failed";
}

export function createClientMessageId(randomValue?: string): string {
  const source = randomValue ?? globalThis.crypto.randomUUID();
  const normalized = source.replace(/[^A-Za-z0-9_-]/gu, "");
  if (normalized.length < 8) {
    throw new Error("Client Message ID source is too short");
  }
  return `client_${normalized.slice(0, 128)}`;
}

export function queuePendingMessage(
  current: PendingRoomMessage[],
  message: PendingRoomMessage
): PendingRoomMessage[] {
  return [
    ...current.filter(({ clientMessageId }) =>
      clientMessageId !== message.clientMessageId
    ),
    message
  ];
}

export function updatePendingMessage(
  current: PendingRoomMessage[],
  clientMessageId: string,
  status: PendingRoomMessage["status"]
): PendingRoomMessage[] {
  return current.map((message) =>
    message.clientMessageId === clientMessageId ? { ...message, status } : message
  );
}
