import type { PendingRoomMessage } from "../../message-outbox.js";

export const composerStoragePrefix = "convenewire:composer:v1:";
export const composerClearedEvent = "convenewire:composer-cleared";
export const composerStorageTtlMs = 24 * 60 * 60 * 1_000;
export const composerStorageLimits = {
  scopes: 20, pendingPerScope: 10, text: 20_000, serialized: 500_000
} as const;

export interface ComposerScope {
  userId: string;
  teamId: string;
  roomId: string;
  taskId: string;
}

export interface ComposerStoredState {
  content: string;
  discussionOptions: DiscussionComposerOptions;
  mentionAgentIds: string[];
  retainedMentions: Array<{ agentId: string; name: string }>;
  pendingMessages: PendingRoomMessage[];
}

export interface DiscussionComposerOptions {
  participantSelectionMode: "all_eligible" | "question_focused";
  focusedParticipantLimit: number;
  waveCompletionMode: "all_settled" | "read_only_quorum";
  quorumMinimumCompleted: number;
  quorumSoftDeadlineSeconds: number;
}

export const defaultDiscussionComposerOptions: DiscussionComposerOptions = {
  participantSelectionMode: "question_focused",
  focusedParticipantLimit: 3,
  waveCompletionMode: "all_settled",
  quorumMinimumCompleted: 2,
  quorumSoftDeadlineSeconds: 60
};

export type ComposerStorageWarning = "unavailable" | "invalid" | "limit" | "expired";
interface StorageAccess {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
interface StorageOptions { storage?: StorageAccess; now?: number }
interface StoredEntry extends Omit<ComposerScope, "userId"> {
  updatedAt: number;
  draft: Omit<ComposerStoredState, "pendingMessages" | "discussionOptions"> & {
    discussionOptions?: DiscussionComposerOptions;
  };
  pendingMessages: PendingRoomMessage[];
}

const userGenerations = new Map<string, number>();
const invalidatedUsers = new Set<string>();
const identity = (value: unknown, prefix: string): value is string =>
  typeof value === "string" && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,128}$`, "u").test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const agentIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 5 &&
  value.every((id) => identity(id, "agent")) && new Set(value).size === value.length;

export function emptyComposerState(): ComposerStoredState {
  return {
    content: "",
    discussionOptions: { ...defaultDiscussionComposerOptions },
    mentionAgentIds: [],
    retainedMentions: [],
    pendingMessages: []
  };
}

export function validComposerScope(scope: ComposerScope): boolean {
  return identity(scope.userId, "user") && identity(scope.teamId, "team") &&
    identity(scope.roomId, "room") && identity(scope.taskId, "task");
}

export function validPendingMessage(value: unknown, scope: Pick<ComposerScope, "roomId" | "taskId">): value is PendingRoomMessage {
  return record(value) && onlyKeys(value, ["clientMessageId", "roomId", "taskId", "content", "mentionAgentIds", "status"]) &&
    typeof value.clientMessageId === "string" && /^client_[A-Za-z0-9_-]{8,128}$/u.test(value.clientMessageId) &&
    value.roomId === scope.roomId && value.taskId === scope.taskId &&
    typeof value.content === "string" && value.content.trim().length > 0 && value.content.length <= composerStorageLimits.text &&
    (value.mentionAgentIds === undefined || agentIds(value.mentionAgentIds)) &&
    (value.status === "pending" || value.status === "failed");
}

function validDiscussionOptions(value: unknown): value is DiscussionComposerOptions {
  return record(value) && onlyKeys(value, [
    "participantSelectionMode", "focusedParticipantLimit", "waveCompletionMode",
    "quorumMinimumCompleted", "quorumSoftDeadlineSeconds"
  ]) && (value.participantSelectionMode === "all_eligible" ||
    value.participantSelectionMode === "question_focused") &&
    Number.isSafeInteger(value.focusedParticipantLimit) &&
    (value.focusedParticipantLimit as number) >= 2 &&
    (value.focusedParticipantLimit as number) <= 5 &&
    (value.waveCompletionMode === "all_settled" ||
      value.waveCompletionMode === "read_only_quorum") &&
    Number.isSafeInteger(value.quorumMinimumCompleted) &&
    (value.quorumMinimumCompleted as number) >= 2 &&
    (value.quorumMinimumCompleted as number) <= 5 &&
    Number.isSafeInteger(value.quorumSoftDeadlineSeconds) &&
    (value.quorumSoftDeadlineSeconds as number) >= 1 &&
    (value.quorumSoftDeadlineSeconds as number) < 300;
}

function validDraft(value: unknown): value is StoredEntry["draft"] {
  return record(value) && onlyKeys(value, ["content", "discussionOptions", "mentionAgentIds", "retainedMentions"]) &&
    typeof value.content === "string" && value.content.length <= composerStorageLimits.text &&
    (value.discussionOptions === undefined || validDiscussionOptions(value.discussionOptions)) &&
    agentIds(value.mentionAgentIds) && Array.isArray(value.retainedMentions) && value.retainedMentions.length <= 5 &&
    value.retainedMentions.every((item) => record(item) && onlyKeys(item, ["agentId", "name"]) &&
      identity(item.agentId, "agent") && (value.mentionAgentIds as string[]).includes(item.agentId) &&
      typeof item.name === "string" && item.name.length > 0 && item.name.length <= 160) &&
    new Set(value.retainedMentions.map((item) => item.agentId)).size === value.retainedMentions.length;
}

function validEntry(value: unknown, now: number): value is StoredEntry {
  return record(value) && onlyKeys(value, ["teamId", "roomId", "taskId", "updatedAt", "draft", "pendingMessages"]) &&
    identity(value.teamId, "team") && identity(value.roomId, "room") && identity(value.taskId, "task") &&
    typeof value.updatedAt === "number" && Number.isSafeInteger(value.updatedAt) && value.updatedAt >= 0 && value.updatedAt <= now + 60_000 &&
    validDraft(value.draft) && Array.isArray(value.pendingMessages) && value.pendingMessages.length <= composerStorageLimits.pendingPerScope &&
    value.pendingMessages.every((item) => validPendingMessage(item, { roomId: value.roomId as string, taskId: value.taskId as string })) &&
    new Set(value.pendingMessages.map((item) => item.clientMessageId)).size === value.pendingMessages.length;
}

function storageFor(options: StorageOptions): StorageAccess {
  const storage = options.storage ?? globalThis.sessionStorage ?? globalThis.window?.sessionStorage;
  if (!storage) throw new Error("Session storage is unavailable");
  return storage;
}

const keyFor = (userId: string) => `${composerStoragePrefix}${userId}`;
const sameScope = (entry: Omit<ComposerScope, "userId">, scope: ComposerScope) =>
  entry.teamId === scope.teamId && entry.roomId === scope.roomId && entry.taskId === scope.taskId;
const entryKey = (entry: Omit<ComposerScope, "userId">) => JSON.stringify([entry.teamId, entry.roomId, entry.taskId]);

function readEntries(userId: string, storage: StorageAccess, now: number): { entries: StoredEntry[]; warning?: ComposerStorageWarning } {
  const key = keyFor(userId);
  if (invalidatedUsers.has(userId)) {
    storage.removeItem(key);
    invalidatedUsers.delete(userId);
  }
  const raw = storage.getItem(key);
  if (raw === null) return { entries: [] };
  let value: unknown;
  try { value = raw.length <= composerStorageLimits.serialized ? JSON.parse(raw) : null; } catch { value = null; }
  if (!record(value) || !onlyKeys(value, ["version", "userId", "entries"]) || value.version !== 1 || value.userId !== userId ||
    !Array.isArray(value.entries) || value.entries.length > composerStorageLimits.scopes ||
    !value.entries.every((entry) => validEntry(entry, now)) || new Set(value.entries.map(entryKey)).size !== value.entries.length) {
    storage.removeItem(key);
    return { entries: [], warning: "invalid" };
  }
  const entries = value.entries.filter((entry) => now - entry.updatedAt < composerStorageTtlMs);
  if (entries.length !== value.entries.length) {
    if (entries.length) storage.setItem(key, JSON.stringify({ version: 1, userId, entries }));
    else storage.removeItem(key);
    return { entries, warning: "expired" };
  }
  return { entries };
}

export function loadComposerState(scope: ComposerScope, options: StorageOptions = {}): {
  state: ComposerStoredState; warning?: ComposerStorageWarning;
} {
  if (!validComposerScope(scope)) return { state: emptyComposerState(), warning: "invalid" };
  try {
    const result = readEntries(scope.userId, storageFor(options), options.now ?? Date.now());
    const entry = result.entries.find((item) => sameScope(item, scope));
    return {
      state: entry ? {
        ...entry.draft,
        discussionOptions: entry.draft.discussionOptions ?? {
          ...defaultDiscussionComposerOptions
        },
        // A saved in-flight submission has an uncertain outcome after recovery.
        pendingMessages: entry.pendingMessages.map((item) => ({ ...item, status: "failed" }))
      } : emptyComposerState(),
      ...(result.warning ? { warning: result.warning } : {})
    };
  } catch {
    return { state: emptyComposerState(), warning: "unavailable" };
  }
}

export function saveComposerState(scope: ComposerScope, state: ComposerStoredState, options: StorageOptions = {}): {
  saved: boolean; warning?: ComposerStorageWarning;
} {
  const now = options.now ?? Date.now();
  const { pendingMessages, ...draft } = state;
  const entry = { teamId: scope.teamId, roomId: scope.roomId, taskId: scope.taskId, updatedAt: now, draft, pendingMessages };
  if (!validComposerScope(scope) || !validEntry(entry, now)) return { saved: false, warning: "limit" };
  try {
    const storage = storageFor(options);
    const { entries } = readEntries(scope.userId, storage, now);
    const next = entries.filter((item) => !sameScope(item, scope));
    const nonDefaultDiscussionOptions = JSON.stringify(draft.discussionOptions) !==
      JSON.stringify(defaultDiscussionComposerOptions);
    if (draft.content || pendingMessages.length || nonDefaultDiscussionOptions) next.push(entry);
    if (next.length > composerStorageLimits.scopes) return { saved: false, warning: "limit" };
    const raw = JSON.stringify({ version: 1, userId: scope.userId, entries: next });
    if (raw.length > composerStorageLimits.serialized) return { saved: false, warning: "limit" };
    if (next.length) storage.setItem(keyFor(scope.userId), raw);
    else storage.removeItem(keyFor(scope.userId));
    return { saved: true };
  } catch {
    return { saved: false, warning: "unavailable" };
  }
}

export function composerUserGeneration(userId: string): number {
  return userGenerations.get(userId) ?? 0;
}

/** Clears only this User's unsent work. No credentials or other storage keys are touched. */
export function clearComposerUserState(userId: string, options: StorageOptions = {}): boolean {
  if (!identity(userId, "user")) return false;
  userGenerations.set(userId, composerUserGeneration(userId) + 1);
  invalidatedUsers.add(userId);
  let cleared = false;
  try {
    storageFor(options).removeItem(keyFor(userId));
    invalidatedUsers.delete(userId);
    cleared = true;
  } catch { /* The current document must still forget its in-memory copy. */ }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new window.CustomEvent(composerClearedEvent, { detail: { userId, cleared } }));
  }
  return cleared;
}
