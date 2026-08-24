import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleFlight,
  mergeRoomMessages,
  reduceRunOutput
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
