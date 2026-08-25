import type { RunRecord, RunRepository } from "../run/run-repository.js";
import {
  terminalRunStates,
  terminalTurnStates,
  waveCloseState
} from "./discussion-state.js";
import type { DiscussionRepository } from "./discussion-repository.js";
import type { DiscussionTurn } from "./discussion-types.js";

interface TerminalMutation {
  scheduledRuns: RunRecord[];
}

export class DiscussionRecoveryService {
  public constructor(
    private readonly repository: DiscussionRepository,
    private readonly runs: RunRepository,
    private readonly clock: () => string
  ) {}

  public closeCanceledWaves(
    onRunTerminal: (runId: string) => TerminalMutation | null
  ): void {
    const now = this.clock();
    for (const wave of this.repository.listOpenWaves()) {
      const discussion = this.repository.get(wave.discussionId);
      if (discussion?.state !== "canceled") continue;
      for (const turn of this.repository.listTurnsForWave(wave.waveId)) {
        if (terminalTurnStates.has(turn.state)) continue;
        if (!turn.runId) {
          this.repository.settleTurn({
            turnId: turn.turnId,
            outputMessageId: null,
            state: "canceled",
            assessment: null,
            replyHash: null,
            terminalReason: "discussion_canceled_before_dispatch",
            now
          });
          continue;
        }
        let run = this.runs.getRun(turn.runId);
        if (!run) continue;
        if (!terminalRunStates.has(run.state)) {
          const neverAccepted = run.state === "queued";
          run = this.runs.applyEvent(run.runId, {
            type: "status",
            sequence: run.lastSequence + 1,
            status: neverAccepted ? "canceled" : "outcome_unknown",
            error: {
              code: neverAccepted
                ? "DISCUSSION_CANCELED"
                : "DISCUSSION_CANCEL_RECOVERY_UNKNOWN",
              message: neverAccepted
                ? "The Discussion was canceled before this Run was accepted."
                : "The server restarted before cancellation reached a known Runtime outcome.",
              retryable: false
            }
          }, now).run;
        }
        onRunTerminal(run.runId);
      }
      const currentWave = this.repository.getWave(wave.waveId);
      const members = this.repository.listTurnsForWave(wave.waveId);
      if (
        currentWave?.state === "open" &&
        members.every(({ state }) => terminalTurnStates.has(state))
      ) {
        this.repository.closeWave({
          waveId: wave.waveId,
          expectedVersion: currentWave.version,
          state: waveCloseState(members),
          now
        });
      }
    }
  }

  public expireDueWaves(
    ensureRun: (turn: DiscussionTurn) => RunRecord | null,
    onRunTerminal: (runId: string) => TerminalMutation | null
  ): RunRecord[] {
    const now = this.clock();
    const scheduled = new Map<string, RunRecord>();
    const dueWaves = this.repository.listOpenWaves()
      .filter(({ deadlineAt }) => Date.parse(deadlineAt) <= Date.parse(now));
    for (const wave of dueWaves) {
      for (const currentTurn of this.repository.listTurnsForWave(wave.waveId)) {
        let run = currentTurn.runId
          ? this.runs.getRun(currentTurn.runId)
          : ensureRun(currentTurn);
        if (!run) continue;
        if (!terminalRunStates.has(run.state)) {
          const accepted = run.state !== "queued";
          run = this.runs.applyEvent(run.runId, {
            type: "status",
            sequence: run.lastSequence + 1,
            status: accepted ? "outcome_unknown" : "expired",
            error: {
              code: accepted ? "DISCUSSION_WAVE_DEADLINE_UNKNOWN" : "RUN_EXPIRED",
              message: accepted
                ? "The Discussion Wave deadline passed before a terminal Runtime outcome."
                : "The Run expired before its Discussion Wave deadline.",
              retryable: false
            }
          }, now).run;
        }
        const result = onRunTerminal(run.runId);
        for (const next of result?.scheduledRuns ?? []) {
          if (next.state === "queued") scheduled.set(next.runId, next);
        }
      }
    }
    return [...scheduled.values()];
  }
}
