import assert from "node:assert/strict";
import test from "node:test";

import { parseWorkTaskLink } from "../src/features/room/RoomTimeline.js";

test("Room Result summaries accept only same-origin opaque Work links", () => {
  const origin = "https://team.example.com";
  assert.deepEqual(parseWorkTaskLink(
    "/?team=team_summary0001&room=room_summary0001&workTask=task_summary0001",
    origin
  ), {
    roomId: "room_summary0001",
    taskId: "task_summary0001"
  });
  assert.equal(parseWorkTaskLink(
    "https://outside.example/?team=team_summary0001&room=room_summary0001&workTask=task_summary0001",
    origin
  ), null);
  assert.equal(parseWorkTaskLink(
    "/?team=team_summary0001&room=/Users/private&workTask=task_summary0001",
    origin
  ), null);
  assert.equal(parseWorkTaskLink(
    "/?team=team_summary0001&room=room_summary0001&workTask=TASK-3",
    origin
  ), null);
});
