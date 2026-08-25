import type { CoreRepository } from "../data/core-repository.js";
import type { RunRecord, RunRepository } from "../run/run-repository.js";
import { terminalRunStates, terminalTurnStates } from "./discussion-state.js";
import type { DiscussionRepository } from "./discussion-repository.js";
import type { DiscussionTurn, DiscussionWave } from "./discussion-types.js";
import {
  hashDiscussionReply,
  parseAgentAssessment
} from "./progress-evaluator.js";

export interface WaveSettlement {
  discussionId: string;
  wave: DiscussionWave | null;
  turns: DiscussionTurn[];
  ready: boolean;
}

export class WaveSettlementService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly repository: DiscussionRepository,
    private readonly runs: RunRepository
  ) {}

  public settle(runId: string, now: string): WaveSettlement | null {
    const run = this.runs.getRun(runId);
    const turn = this.repository.findTurnByRun(runId);
    if (!run || !turn || !terminalRunStates.has(run.state)) return null;
    if (!turn.waveId) {
      throw new Error(`Discussion Turn has no Wave: ${turn.turnId}`);
    }
    const output = this.core.findAgentReply(
      turn.inputMessageId,
      turn.speakerAgentId
    );
    const replyEvent = this.runs.listEvents(runId)
      .filter(({ event }) => event.type === "reply")
      .at(-1)?.event as { assessment?: unknown } | undefined;
    const successful = run.state === "completed" && output !== undefined;
    this.repository.settleTurn({
      turnId: turn.turnId,
      outputMessageId: successful ? output.messageId : null,
      state: successful
        ? "completed"
        : run.state === "canceled"
          ? "canceled"
          : "failed",
      assessment: successful ? parseAgentAssessment(replyEvent?.assessment) : null,
      replyHash: successful ? hashDiscussionReply(output.content) : null,
      terminalReason: successful ? null : this.terminalReason(run, output !== undefined),
      now
    });
    const wave = this.repository.getWave(turn.waveId) ?? null;
    const turns = this.repository.listTurnsForWave(turn.waveId);
    return {
      discussionId: turn.discussionId,
      wave,
      turns,
      ready: wave?.state === "open" &&
        turns.every(({ state }) => terminalTurnStates.has(state))
    };
  }

  private terminalReason(run: RunRecord, hasOutput: boolean): string {
    if (this.runs.listEvents(run.runId).some(({ event }) =>
      event.type === "status" && event.status === "input_required"
    )) {
      return "input_required";
    }
    if (run.state === "completed" && !hasOutput) return "completed_without_reply";
    return `run_${run.state}`.slice(0, 160);
  }
}
