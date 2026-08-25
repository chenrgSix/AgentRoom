import type {
  DiscussionTurn,
  DiscussionWaveState
} from "./discussion-types.js";

export const terminalRunStates = new Set([
  "completed", "failed", "canceled", "expired", "outcome_unknown"
]);

export const terminalTurnStates = new Set(["completed", "failed", "canceled"]);

export const terminalDiscussionStates = new Set([
  "completed", "canceled", "terminated"
]);

export function waveCloseState(
  turns: Array<Pick<DiscussionTurn, "state">>
): Exclude<DiscussionWaveState, "open"> {
  const completed = turns.filter(({ state }) => state === "completed").length;
  const canceled = turns.filter(({ state }) => state === "canceled").length;
  if (completed === turns.length) return "completed";
  if (canceled === turns.length) return "canceled";
  if (completed > 0) return "partial";
  return "failed";
}
