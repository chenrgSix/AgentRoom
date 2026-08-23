import assert from "node:assert/strict";
import test from "node:test";

import { createSingleFlight, mergeRoomMessages } from "../src/room-sync.js";

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
