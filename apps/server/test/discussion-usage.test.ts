import assert from "node:assert/strict";
import test from "node:test";
import { observeDiscussionUsage } from "../src/discussion/discussion-usage.js";
import type { DiscussionRecord, DiscussionTurn } from "../src/discussion/discussion-types.js";
import type { RunRecord, RunState } from "../src/run/run-repository.js";

const start = "2026-09-05T00:00:00.000Z";
const end = "2026-09-05T00:00:30.000Z";
const discussion = { discussionId: "discussion_usage", roomId: "room_usage", taskId: "task_usage",
  createdAt: start, terminalAt: null, budget: { agentRunsUsed: 50 } } as DiscussionRecord;
function turn(runId: string | null): DiscussionTurn {
  return { discussionId: discussion.discussionId, runId, speakerAgentId: "agent_usage",
    inputMessageId: "msg_usage", state: "completed" } as DiscussionTurn;
}
function run(runId: string, state: RunState): RunRecord {
  return { runId, state, roomId: discussion.roomId, taskId: discussion.taskId,
    targetAgentId: "agent_usage", triggerMessageId: "msg_usage" } as RunRecord;
}

test("observed usage counts unique actual lifecycle states, including live quorum leftovers", () => {
  const states: RunState[] = ["queued", "delivered", "working", "input_required", "completed",
    "failed", "canceled", "expired", "outcome_unknown"];
  const runs = states.map((state, index) => run(`run_${index}`, state));
  const usage = observeDiscussionUsage({ discussion,
    turns: [...runs.map(({ runId }) => turn(runId)), turn(runs[0]!.runId), turn(null)],
    getRun: (id) => runs.find(({ runId }) => runId === id), now: end });
  assert.equal(usage.createdRuns, 9);
  assert.ok(Object.values(usage.runsByState).every((count) => count === 1));
  assert.equal(usage.unboundMemberSlots, 1);
  assert.equal(usage.unavailableRunRecords, 0);
  assert.equal(usage.wallDurationSeconds, 30);
  assert.equal(usage.tokens, null);
  assert.equal(usage.estimatedCostMicros, null);
});

test("unavailable or mismatched Run records never become zero-cost completed work", () => {
  for (const patch of [undefined, { roomId: "room_foreign" }, { taskId: "task_foreign" },
    { targetAgentId: "agent_foreign" }, { triggerMessageId: "msg_foreign" }]) {
    const usage = observeDiscussionUsage({ discussion, turns: [turn("run_test")],
      getRun: () => patch ? { ...run("run_test", "completed"), ...patch } : undefined, now: end });
    assert.equal(usage.createdRuns, 0);
    assert.equal(usage.unavailableRunRecords, 1);
    assert.equal(usage.runsByState.completed, 0);
  }
});

test("terminal wall time stays fixed while late Run outcomes remain observable", () => {
  const input = { discussion: { ...discussion, terminalAt: end }, turns: [turn("run_late")],
    now: "2026-09-05T01:00:00.000Z" };
  const early = observeDiscussionUsage({ ...input, getRun: () => run("run_late", "working") });
  const late = observeDiscussionUsage({ ...input, getRun: () => run("run_late", "completed") });
  assert.equal(early.wallDurationSeconds, 30);
  assert.equal(late.wallDurationSeconds, 30);
  assert.equal(early.runsByState.working, 1);
  assert.equal(late.runsByState.completed, 1);
  assert.equal(observeDiscussionUsage({ ...input,
    discussion: { ...discussion, createdAt: "invalid" }, getRun: () => undefined
  }).wallDurationSeconds, null);
});
