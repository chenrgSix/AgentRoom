import type { RunRecord, RunState } from "../run/run-repository.js";
import type { DiscussionRecord, DiscussionTurn } from "./discussion-types.js";

export interface DiscussionObservedUsage {
  observedAt: string;
  createdRuns: number;
  runsByState: Record<RunState, number>;
  unboundMemberSlots: number;
  unavailableRunRecords: number;
  wallDurationSeconds: number | null;
}

/** A read projection of canonical Run facts, independent of budget debits. */
export function observeDiscussionUsage(input: {
  discussion: DiscussionRecord;
  turns: DiscussionTurn[];
  getRun: (runId: string) => RunRecord | undefined;
  now: string;
}): DiscussionObservedUsage {
  const usage: DiscussionObservedUsage = {
    observedAt: input.now,
    createdRuns: 0,
    runsByState: { queued: 0, delivered: 0, working: 0, input_required: 0,
      completed: 0, failed: 0, canceled: 0, expired: 0, outcome_unknown: 0 },
    unboundMemberSlots: 0,
    unavailableRunRecords: 0,
    wallDurationSeconds: null
  };
  const seen = new Set<string>();
  for (const turn of input.turns) {
    if (turn.discussionId !== input.discussion.discussionId) continue;
    if (!turn.runId) {
      usage.unboundMemberSlots += 1;
      continue;
    }
    if (seen.has(turn.runId)) continue;
    seen.add(turn.runId);
    const run = input.getRun(turn.runId);
    if (!run || run.runId !== turn.runId || run.roomId !== input.discussion.roomId ||
        run.taskId !== input.discussion.taskId || run.targetAgentId !== turn.speakerAgentId ||
        run.triggerMessageId !== turn.inputMessageId) {
      usage.unavailableRunRecords += 1;
      continue;
    }
    usage.createdRuns += 1;
    usage.runsByState[run.state] += 1;
  }
  const elapsed = Date.parse(input.discussion.terminalAt ?? input.now) -
    Date.parse(input.discussion.createdAt);
  if (Number.isFinite(elapsed) && elapsed >= 0) {
    usage.wallDurationSeconds = Math.floor(elapsed / 1_000);
  }
  return usage;
}
