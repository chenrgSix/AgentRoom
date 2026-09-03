import assert from "node:assert/strict";
import test from "node:test";

import {
  clearComposerUserState,
  composerStorageLimits,
  composerStoragePrefix,
  composerStorageTtlMs,
  composerUserGeneration,
  emptyComposerState,
  loadComposerState,
  saveComposerState,
  type ComposerScope,
  type ComposerStoredState
} from "../src/features/room/composer-storage.js";

const scope: ComposerScope = { userId: "user_storage", teamId: "team_one", roomId: "room_one", taskId: "task_one" };
const now = 1_700_000_000_000;
const draft = (content = "Unfinished draft"): ComposerStoredState => ({ ...emptyComposerState(), content });
const pending = (status: "pending" | "failed" = "pending") => ({
  clientMessageId: "client_original123", roomId: scope.roomId, taskId: scope.taskId,
  content: "  @Builder original payload\n", mentionAgentIds: ["agent_builder"], status
});

function storageFixture() {
  const data = new Map<string, string>();
  return { data, storage: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); }
  } };
}

test("composer storage isolates User, Team, Room and Task and contains no session authority", () => {
  const { storage, data } = storageFixture();
  const scopes = [scope, { ...scope, userId: "user_other" }, { ...scope, teamId: "team_other" },
    { ...scope, roomId: "room_other" }, { ...scope, taskId: "task_other" }];
  scopes.forEach((current, index) => assert.equal(saveComposerState(current, draft(`draft-${index}`), { storage, now }).saved, true));
  scopes.forEach((current, index) => assert.equal(loadComposerState(current, { storage, now }).state.content, `draft-${index}`));
  assert.equal(data.size, 2);
  const value = JSON.parse(data.get(`${composerStoragePrefix}${scope.userId}`)!);
  assert.deepEqual(Object.keys(value).sort(), ["entries", "userId", "version"]);
  assert.deepEqual(Object.keys(value.entries[0]).sort(), ["draft", "pendingMessages", "roomId", "taskId", "teamId", "updatedAt"]);
  assert.deepEqual(Object.keys(value.entries[0].draft).sort(), [
    "content", "discussionOptions", "mentionAgentIds", "retainedMentions"
  ]);
  assert.equal(saveComposerState(scope, { ...draft(), token: "must-not-save" } as ComposerStoredState, { storage, now }).saved, false);
  assert.equal([...data.values()].some((raw) => raw.includes("must-not-save")), false);
});

test("discussion policy persists per scope and legacy drafts receive safe defaults", () => {
  const { storage, data } = storageFixture();
  const configured: ComposerStoredState = {
    ...emptyComposerState(),
    discussionOptions: {
      participantSelectionMode: "all_eligible",
      focusedParticipantLimit: 4,
      waveCompletionMode: "read_only_quorum",
      quorumMinimumCompleted: 3,
      quorumSoftDeadlineSeconds: 45
    }
  };
  assert.equal(saveComposerState(scope, configured, { storage, now }).saved, true);
  assert.deepEqual(loadComposerState(scope, { storage, now }).state.discussionOptions,
    configured.discussionOptions);

  const key = `${composerStoragePrefix}${scope.userId}`;
  const legacy = JSON.parse(data.get(key)!);
  delete legacy.entries[0].draft.discussionOptions;
  legacy.entries[0].draft.content = "legacy draft";
  data.set(key, JSON.stringify(legacy));
  const restored = loadComposerState(scope, { storage, now });
  assert.equal(restored.warning, undefined);
  assert.equal(restored.state.content, "legacy draft");
  assert.deepEqual(restored.state.discussionOptions,
    emptyComposerState().discussionOptions);
});

test("hydration makes an uncertain pending delivery failed while preserving every payload field", () => {
  const { storage } = storageFixture();
  const state = { ...draft(), pendingMessages: [pending()] };
  assert.equal(saveComposerState(scope, state, { storage, now }).saved, true);
  const restored = loadComposerState(scope, { storage, now }).state;
  assert.deepEqual(restored.pendingMessages, [{ ...pending(), status: "failed" }]);
  assert.equal(state.pendingMessages[0]?.status, "pending");
});

test("24-hour TTL physically removes expired contexts without touching newer contexts", () => {
  const { storage, data } = storageFixture();
  const recent = { ...scope, taskId: "task_recent" };
  saveComposerState(scope, { ...draft(), pendingMessages: [pending()] }, { storage, now });
  saveComposerState(recent, draft("recent"), { storage, now: now + 60_000 });
  const restored = loadComposerState(scope, { storage, now: now + composerStorageTtlMs });
  assert.equal(restored.warning, "expired");
  assert.deepEqual(restored.state, emptyComposerState());
  assert.equal(loadComposerState(recent, { storage, now: now + composerStorageTtlMs }).state.content, "recent");
  const raw = data.get(`${composerStoragePrefix}${scope.userId}`)!;
  assert.equal(raw.includes("client_original123"), false);
});

test("malformed, cross-scope, unknown-field and oversized serialized records are ignored and removed", () => {
  const { storage, data } = storageFixture();
  const key = `${composerStoragePrefix}${scope.userId}`;
  saveComposerState(scope, { ...draft(), pendingMessages: [pending()] }, { storage, now });
  const valid = data.get(key)!;
  const corruptions: Array<string | ((value: any) => void)> = [
    "not json", "x".repeat(composerStorageLimits.serialized + 1),
    (value) => { value.version = 2; },
    (value) => { value.userId = "user_wrong"; },
    (value) => { value.entries[0].pendingMessages[0].roomId = "room_wrong"; },
    (value) => { value.entries[0].pendingMessages[0].taskId = "task_wrong"; },
    (value) => { value.entries[0].pendingMessages[0].status = "delivered"; },
    (value) => { value.entries[0].pendingMessages[0].clientMessageId = "invalid"; },
    (value) => { value.entries[0].pendingMessages[0].authorization = "secret"; },
    (value) => { value.entries[0].draft.mentionAgentIds = ["agent_one", "agent_one"]; },
    (value) => { value.entries[0].updatedAt = now + 60_001; },
    (value) => { value.entries.push(value.entries[0]); }
  ];
  for (const corruption of corruptions) {
    const value = JSON.parse(valid);
    if (typeof corruption === "function") corruption(value);
    data.set(key, typeof corruption === "string" ? corruption : JSON.stringify(value));
    const result = loadComposerState(scope, { storage, now });
    assert.equal(result.warning, "invalid");
    assert.deepEqual(result.state, emptyComposerState());
    assert.equal(data.has(key), false);
  }
});

test("entry, message, text and serialized limits refuse new writes without evicting saved work", () => {
  const { storage, data } = storageFixture();
  saveComposerState(scope, draft("preserve"), { storage, now });
  assert.equal(saveComposerState(scope, draft("x".repeat(composerStorageLimits.text + 1)), { storage, now }).warning, "limit");
  assert.equal(loadComposerState(scope, { storage, now }).state.content, "preserve");
  const tooMany = Array.from({ length: 11 }, (_, index) => ({ ...pending(), clientMessageId: `client_original${index}` }));
  assert.equal(saveComposerState(scope, { ...draft(), pendingMessages: tooMany }, { storage, now }).warning, "limit");
  for (let index = 1; index < 20; index += 1) {
    assert.equal(saveComposerState({ ...scope, taskId: `task_${index}` }, draft(`draft-${index}`), { storage, now }).saved, true);
  }
  const before = data.get(`${composerStoragePrefix}${scope.userId}`);
  assert.equal(saveComposerState({ ...scope, taskId: "task_overflow" }, draft(), { storage, now }).warning, "limit");
  assert.equal(data.get(`${composerStoragePrefix}${scope.userId}`), before);
  // A context itself is bounded, but three full outboxes exceed the total envelope bound.
  const large = storageFixture();
  for (let index = 0; index < 3; index += 1) {
    const largeScope = { ...scope, taskId: `task_large${index}` };
    const messages = Array.from({ length: 10 }, (_, number) => ({ ...pending(), taskId: largeScope.taskId,
      content: "x".repeat(20_000), clientMessageId: `client_large${number}000` }));
    const result = saveComposerState(largeScope, { ...draft(), pendingMessages: messages }, { storage: large.storage, now });
    assert.equal(result.saved, index < 2);
    if (index === 2) assert.equal(result.warning, "limit");
  }
});

test("blocked reads and quota writes degrade without throwing or losing the previous saved copy", () => {
  const { storage, data } = storageFixture();
  saveComposerState(scope, draft("saved"), { storage, now });
  const blocked = { ...storage, getItem: () => { throw new Error("SecurityError"); } };
  assert.equal(loadComposerState(scope, { storage: blocked, now }).warning, "unavailable");
  const quota = { ...storage, setItem: () => { throw new Error("QuotaExceededError"); } };
  assert.equal(saveComposerState(scope, draft("not saved"), { storage: quota, now }).warning, "unavailable");
  assert.equal(data.get(`${composerStoragePrefix}${scope.userId}`)?.includes("saved"), true);
  assert.equal(loadComposerState(scope, { storage, now }).state.content, "saved");
});

test("logout clears exactly one User and fences old asynchronous responses, including a blocked clear", () => {
  const { storage, data } = storageFixture();
  const other = { ...scope, userId: "user_keep" };
  saveComposerState(scope, draft(), { storage, now });
  saveComposerState(other, draft("keep"), { storage, now });
  data.set("credential-unrelated", "leave untouched");
  const before = composerUserGeneration(scope.userId);
  assert.equal(clearComposerUserState(scope.userId, { storage }), true);
  assert.equal(composerUserGeneration(scope.userId), before + 1);
  assert.equal(data.has(`${composerStoragePrefix}${scope.userId}`), false);
  assert.equal(loadComposerState(other, { storage, now }).state.content, "keep");
  assert.equal(data.get("credential-unrelated"), "leave untouched");
  saveComposerState(scope, draft("old secret draft"), { storage, now });
  const blocked = { ...storage, removeItem: () => { throw new Error("blocked"); } };
  assert.equal(clearComposerUserState(scope.userId, { storage: blocked }), false);
  assert.equal(loadComposerState(scope, { storage: blocked, now }).warning, "unavailable");
  assert.deepEqual(loadComposerState(scope, { storage, now }).state, emptyComposerState());
});
