import assert from "node:assert/strict";
import test from "node:test";

import { TeamChangeService } from "../src/team-room/team-change-service.js";

test("Team change waits wake once with a monotonic cursor", async () => {
  const changes = new TeamChangeService();
  const first = changes.wait("team_test", 0, { timeoutMilliseconds: 1_000 });
  const second = changes.wait("team_test", 0, { timeoutMilliseconds: 1_000 });
  assert.equal(changes.notify("team_test"), 1);
  assert.deepEqual(await first, {
    changed: true, cursor: 1, reset: false, team: true, roomIds: [], runRoomIds: []
  });
  assert.deepEqual(await second, {
    changed: true, cursor: 1, reset: false, team: true, roomIds: [], runRoomIds: []
  });
  assert.deepEqual(await changes.wait("team_test", 0), {
    changed: true,
    cursor: 1,
    reset: false,
    team: true,
    roomIds: [],
    runRoomIds: []
  });
});

test("Team change waits expose timeout, restart reset, and cancellation", async () => {
  const changes = new TeamChangeService();
  assert.deepEqual(await changes.wait("team_test", 0, { timeoutMilliseconds: 1 }), {
    changed: false,
    cursor: 0,
    reset: false,
    team: false,
    roomIds: [],
    runRoomIds: []
  });
  assert.deepEqual(await changes.wait("team_test", 9), {
    changed: false,
    cursor: 0,
    reset: true,
    team: true,
    roomIds: [],
    runRoomIds: []
  });
  const controller = new AbortController();
  const pending = changes.wait("team_test", 0, {
    signal: controller.signal,
    timeoutMilliseconds: 1_000
  });
  controller.abort(new Error("test abort"));
  await assert.rejects(pending, /test abort/u);
});

test("Team change cursors aggregate scoped Room hints without losing Team changes", async () => {
  const changes = new TeamChangeService();
  changes.notify("team_test", { kind: "room", roomId: "room_a" });
  changes.notify("team_test", { kind: "room", roomId: "room_b" });
  changes.notify("team_test", { kind: "run", roomId: "room_c" });
  assert.deepEqual(await changes.wait("team_test", 0), {
    changed: true,
    cursor: 3,
    reset: false,
    team: false,
    roomIds: ["room_a", "room_b"],
    runRoomIds: ["room_c"]
  });
  changes.notify("team_test");
  assert.deepEqual(await changes.wait("team_test", 1), {
    changed: true,
    cursor: 4,
    reset: false,
    team: true,
    roomIds: ["room_b"],
    runRoomIds: ["room_c"]
  });
});
