export interface RoomCollaborationPolicy {
  allowDiscussion: boolean;
  allowAll: boolean;
  allowAgentMentions: boolean;
  maxAgentMentionDepth: number;
}

export const maximumRoomAgentMentionDepth = 4;

export const defaultRoomCollaborationPolicy: RoomCollaborationPolicy = {
  allowDiscussion: true,
  allowAll: true,
  allowAgentMentions: true,
  maxAgentMentionDepth: maximumRoomAgentMentionDepth
};

export function parseRoomCollaborationPolicy(
  value: unknown
): RoomCollaborationPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Room collaboration policy must be a JSON object");
  }
  const source = value as Partial<RoomCollaborationPolicy>;
  if (
    typeof source.allowDiscussion !== "boolean" ||
    typeof source.allowAll !== "boolean" ||
    typeof source.allowAgentMentions !== "boolean" ||
    !Number.isSafeInteger(source.maxAgentMentionDepth) ||
    (source.maxAgentMentionDepth ?? 0) < 1 ||
    (source.maxAgentMentionDepth ?? 0) > maximumRoomAgentMentionDepth
  ) {
    throw new Error(
      `Room collaboration policy requires boolean switches and a maximum Agent mention depth from 1 to ${maximumRoomAgentMentionDepth}`
    );
  }
  return {
    allowDiscussion: source.allowDiscussion,
    allowAll: source.allowAll,
    allowAgentMentions: source.allowAgentMentions,
    maxAgentMentionDepth: source.maxAgentMentionDepth
  } as RoomCollaborationPolicy;
}

export function readPersistedRoomCollaborationPolicy(
  value: string
): RoomCollaborationPolicy {
  const source = JSON.parse(value) as Partial<RoomCollaborationPolicy>;
  return parseRoomCollaborationPolicy({
    ...defaultRoomCollaborationPolicy,
    ...source
  });
}
