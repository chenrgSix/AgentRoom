import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleFlight,
  mergeRoomMessages,
  reduceRunActivities,
  reduceRunOutput,
  teamChangeRefreshScope
} from "../src/room-sync.js";

test("Room synchronization appends cursor deltas once and keeps newest history", () => {
  const snapshot = Array.from({ length: 100 }, (_, index) => ({
    messageId: `message-${index + 6}`,
    sequence: index + 6
  }));
  const merged = mergeRoomMessages(snapshot, [
    { messageId: "message-105", sequence: 105 },
    { messageId: "message-106", sequence: 106 }
  ]);

  assert.equal(merged.length, 101);
  assert.equal(merged[0]?.sequence, 6);
  assert.equal(merged.at(-1)?.sequence, 106);
  assert.equal(
    merged.filter(({ messageId }) => messageId === "message-105").length,
    1
  );

  const bounded = mergeRoomMessages([], Array.from({ length: 510 }, (_, index) => ({
    messageId: `bounded-${index + 1}`,
    sequence: index + 1
  })));
  assert.equal(bounded.length, 500);
  assert.equal(bounded[0]?.sequence, 11);
});

test("Room refresh is single-flight across overlapping poll ticks", async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const refresh = createSingleFlight(async () => {
    calls += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });

  const first = refresh();
  const overlapping = await refresh();
  assert.equal(overlapping, false);
  assert.equal(calls, 1);
  release?.();
  assert.equal(await first, true);

  const next = refresh();
  assert.equal(calls, 2);
  release?.();
  assert.equal(await next, true);
});

test("Run output resumes ordered deltas, resets, and seals on the final reply", () => {
  const first = reduceRunOutput(undefined, [
    { sequence: 2, event: { type: "output", sequence: 2, content: "先分析" } },
    { sequence: 1, event: { type: "status", sequence: 1, status: "working" } }
  ]);
  assert.deepEqual(first, {
    sequence: 2,
    content: "先分析",
    sealed: false
  });

  const reset = reduceRunOutput(first, [
    { sequence: 2, event: { type: "output", sequence: 2, content: "重复" } },
    {
      sequence: 3,
      event: { type: "output", sequence: 3, content: "最终回答", reset: true }
    }
  ]);
  assert.deepEqual(reset, {
    sequence: 3,
    content: "最终回答",
    sealed: false
  });

  assert.deepEqual(reduceRunOutput(reset, [
    { sequence: 4, event: { type: "reply", sequence: 4, content: "最终回答" } },
    { sequence: 5, event: { type: "status", sequence: 5, status: "completed" } }
  ]), {
    sequence: 5,
    content: "",
    sealed: true
  });
});

test("Run output waits for a missing sequence and clears on failure", () => {
  const gap = reduceRunOutput(undefined, [
    { sequence: 2, event: { type: "output", sequence: 2, content: "不应越过缺口" } }
  ]);
  assert.deepEqual(gap, { sequence: 0, content: "", sealed: false });
  assert.deepEqual(reduceRunOutput(undefined, [
    { sequence: 1, event: { type: "status", sequence: 1, status: "working" } },
    { sequence: 2, event: { type: "output", sequence: 2, content: "处理中" } },
    { sequence: 3, event: { type: "status", sequence: 3, status: "failed" } }
  ]), {
    sequence: 3,
    content: "",
    sealed: true
  });
});

test("Run activities merge reasoning deltas and tool lifecycle by stable id", () => {
  const projection = reduceRunActivities(undefined, [
    { sequence: 1, event: { type: "status", sequence: 1, status: "working" } },
    {
      sequence: 2,
      event: {
        type: "activity", sequence: 2, activityId: "reasoning-1",
        kind: "reasoning", phase: "updated", label: "Thinking", content: "先检查"
      }
    },
    {
      sequence: 3,
      event: {
        type: "activity", sequence: 3, activityId: "reasoning-1",
        kind: "reasoning", phase: "completed", content: "调度"
      }
    },
    {
      sequence: 4,
      event: {
        type: "activity", sequence: 4, activityId: "tool-1",
        kind: "tool", phase: "started", label: "search"
      }
    },
    {
      sequence: 5,
      event: {
        type: "activity", sequence: 5, activityId: "tool-1",
        kind: "tool", phase: "completed", label: "search"
      }
    },
    { sequence: 6, event: { type: "reply", sequence: 6, content: "完成" } }
  ]);
  assert.equal(projection.sequence, 6);
  assert.equal(projection.sealed, true);
  assert.deepEqual(projection.items, [
    {
      activityId: "reasoning-1", kind: "reasoning", phase: "completed",
      label: "Thinking", content: "先检查调度", sequence: 3
    },
    {
      activityId: "tool-1", kind: "tool", phase: "completed",
      label: "search", content: "", sequence: 5
    }
  ]);
});

test("Team change hints choose full, selected-Room, or no reconciliation", () => {
  assert.equal(teamChangeRefreshScope({
    changed: true, reset: false, team: true, roomIds: []
  }, "room_selected"), "full");
  assert.equal(teamChangeRefreshScope({
    changed: true, reset: false, team: false, roomIds: ["room_selected"]
  }, "room_selected"), "room");
  assert.equal(teamChangeRefreshScope({
    changed: true, reset: false, team: false, roomIds: [],
    runRoomIds: ["room_selected"]
  }, "room_selected"), "events");
  assert.equal(teamChangeRefreshScope({
    changed: true, reset: false, team: false, roomIds: ["room_other"]
  }, "room_selected"), null);
  assert.equal(teamChangeRefreshScope({
    changed: true, reset: false
  }, "room_selected"), "full");
  assert.equal(teamChangeRefreshScope({
    changed: false, reset: true, team: false, roomIds: []
  }, "room_selected"), "full");
});
