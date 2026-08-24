import assert from "node:assert/strict";
import test from "node:test";

import { TeamChangeService } from "../src/team-room/team-change-service.js";

test("Team change waits wake once with a monotonic cursor", async () => {
  const changes = new TeamChangeService();
  const first = changes.wait("team_test", 0, { timeoutMilliseconds: 1_000 });
  const second = changes.wait("team_test", 0, { timeoutMilliseconds: 1_000 });
  assert.equal(changes.notify("team_test"), 1);
  assert.deepEqual(await first, { changed: true, cursor: 1, reset: false });
  assert.deepEqual(await second, { changed: true, cursor: 1, reset: false });
  assert.deepEqual(await changes.wait("team_test", 0), {
    changed: true,
    cursor: 1,
    reset: false
  });
});

test("Team change waits expose timeout, restart reset, and cancellation", async () => {
  const changes = new TeamChangeService();
  assert.deepEqual(await changes.wait("team_test", 0, { timeoutMilliseconds: 1 }), {
    changed: false,
    cursor: 0,
    reset: false
  });
  assert.deepEqual(await changes.wait("team_test", 9), {
    changed: false,
    cursor: 0,
    reset: true
  });
  const controller = new AbortController();
  const pending = changes.wait("team_test", 0, {
    signal: controller.signal,
    timeoutMilliseconds: 1_000
  });
  controller.abort(new Error("test abort"));
  await assert.rejects(pending, /test abort/u);
});
