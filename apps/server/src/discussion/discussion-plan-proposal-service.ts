import type {
  DiscussionPlanProposalDraft,
  ExecutionPlanDefinition,
  ExecutionPlanProjection,
  ExecutionPlanProposalCommand
} from "@convene-wire/contracts/execution-plan";
import {
  ExecutionContractError,
  executionOperationDigest
} from "@convene-wire/contracts/execution-validation";
import type { CoreRepository, MessageRecord } from
  "../data/core-repository.js";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import { ExecutionError } from "../execution/execution-error.js";
import type { ExecutionPlanDraftWriter } from
  "../execution/execution-plan-draft-writer.js";
import type {
  AgentTaskRecord,
  AgentTaskRepository
} from "../task/task-repository.js";
import { parseDiscussionPlanProposalEnvelope } from
  "./discussion-plan-proposal-envelope.js";
import type { DiscussionRepository } from "./discussion-repository.js";
import type {
  DiscussionRecord,
  DiscussionTurn,
  DiscussionWave,
  DiscussionWaveState
} from "./discussion-types.js";

const discussionEvidenceRefId = "evidence_final_discussion";
const messageEvidenceRefId = "evidence_final_message";

export interface CloseDiscussionPlanProposalInput {
  discussion: DiscussionRecord;
  wave: DiscussionWave;
  state: "completed" | "terminated";
  waveState: Exclude<DiscussionWaveState, "open">;
  now: string;
}

// This adapter can only retain a draft. It owns no approval, Task mutation,
// Run dispatch, Result review, repository or local Runtime authority.
export class DiscussionPlanProposalService {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly core: CoreRepository,
    private readonly discussions: DiscussionRepository,
    private readonly drafts: ExecutionPlanDraftWriter,
    private readonly tasks: AgentTaskRepository
  ) {}

  public closeAndPropose(
    input: CloseDiscussionPlanProposalInput
  ): ExecutionPlanProjection | undefined {
    return this.transactions.immediate(() => {
      const closed = this.discussions.closeFinalizationAndFinish({
        discussionId: input.discussion.discussionId,
        expectedDiscussionVersion: input.discussion.version,
        state: input.state,
        waveId: input.wave.waveId,
        expectedWaveVersion: input.wave.version,
        waveState: input.waveState,
        now: input.now
      });
      const closedWave = this.discussions.getWave(input.wave.waveId);
      if (!closedWave) throw new Error("Finalization Wave disappeared after closure");
      return this.proposeWithinTransaction(
        closed,
        closedWave,
        this.discussions.listTurnsForWave(closedWave.waveId),
        input.now
      );
    });
  }

  public reconcileTerminal(discussionId: string): ExecutionPlanProjection | undefined {
    return this.transactions.immediate(() => {
      const discussion = this.discussions.get(discussionId);
      if (!discussion || discussion.outputMode !== "decision_record" ||
        !this.isTerminal(discussion)) return undefined;
      const wave = this.discussions.listWaves(discussionId)
        .filter(({ phase, state }) => phase === "finalization" && state !== "open")
        .at(-1);
      if (!wave) return undefined;
      return this.proposeWithinTransaction(
        discussion,
        wave,
        this.discussions.listTurnsForWave(wave.waveId),
        discussion.terminalAt ?? discussion.updatedAt
      );
    });
  }

  public reconcileAllTerminal(): void {
    for (const discussion of this.discussions.listTerminalDecisionRecords()) {
      this.reconcileTerminal(discussion.discussionId);
    }
  }

  private proposeWithinTransaction(
    discussion: DiscussionRecord,
    wave: DiscussionWave,
    turns: DiscussionTurn[],
    now: string
  ): ExecutionPlanProjection | undefined {
    if (discussion.outputMode !== "decision_record" ||
      !this.isTerminal(discussion) || wave.phase !== "finalization" ||
      wave.state === "open") return undefined;
    const successful = turns.filter((turn) => turn.kind === "finalization" &&
      turn.state === "completed" && turn.outputMessageId !== null);
    if (successful.length !== 1) return undefined;
    const turn = successful[0]!;
    const message = this.core.getMessage(turn.outputMessageId!);
    if (!message || !this.isExactFinalMessage(discussion, turn, message)) {
      return undefined;
    }
    const draft = parseDiscussionPlanProposalEnvelope(message.content);
    if (!draft) return undefined;
    try {
      const definition = this.definition(draft, discussion, message);
      const command: ExecutionPlanProposalCommand = {
        operationId: `op_${executionOperationDigest({
          purpose: "discussion_plan_proposal",
          discussionId: discussion.discussionId,
          turnId: turn.turnId
        })}`,
        expectedRootTaskRevision: this.requireRootRevision(discussion),
        definition
      };
      return this.drafts.write({
        author: { kind: "discussion", discussionId: discussion.discussionId },
        command,
        now,
        rootTaskId: discussion.taskId,
        authorize: (root, plan) => this.authorize(
          discussion, wave, turn, message, root, plan
        )
      });
    } catch (error) {
      if (error instanceof ExecutionContractError || error instanceof ExecutionError) {
        return undefined;
      }
      throw error;
    }
  }

  private definition(
    draft: DiscussionPlanProposalDraft,
    discussion: DiscussionRecord,
    message: MessageRecord
  ): ExecutionPlanDefinition {
    const definition: ExecutionPlanDefinition = {
      ...draft,
      rootTaskId: discussion.taskId,
      decision: {
        ...draft.decision,
        sources: [
          {
            evidenceRefId: discussionEvidenceRefId,
            kind: "discussion",
            discussionId: discussion.discussionId
          },
          {
            evidenceRefId: messageEvidenceRefId,
            kind: "message",
            messageId: message.messageId
          }
        ],
        sourceRevisions: [
          { evidenceRefId: discussionEvidenceRefId, revision: discussion.version },
          { evidenceRefId: messageEvidenceRefId, revision: message.sequence }
        ]
      }
    };
    return definition;
  }

  private authorize(
    expectedDiscussion: DiscussionRecord,
    expectedWave: DiscussionWave,
    expectedTurn: DiscussionTurn,
    expectedMessage: MessageRecord,
    root: AgentTaskRecord,
    plan: ExecutionPlanProjection | undefined
  ): void {
    if (plan || root.taskId !== expectedDiscussion.taskId ||
      root.roomId !== expectedDiscussion.roomId) {
      throw new ExecutionError("EXECUTION_DISCUSSION_SCOPE_MISMATCH");
    }
    const discussion = this.discussions.get(expectedDiscussion.discussionId);
    const wave = this.discussions.getWave(expectedWave.waveId);
    const turn = this.discussions.getTurn(expectedTurn.turnId);
    const message = this.core.getMessage(expectedMessage.messageId);
    if (!discussion || discussion.version !== expectedDiscussion.version ||
      discussion.outputMode !== "decision_record" || !this.isTerminal(discussion) ||
      !wave || wave.discussionId !== discussion.discussionId ||
      wave.phase !== "finalization" || wave.state === "open" ||
      !turn || turn.discussionId !== discussion.discussionId ||
      turn.waveId !== wave.waveId || turn.kind !== "finalization" ||
      turn.state !== "completed" || turn.outputMessageId !== expectedMessage.messageId ||
      !message || message.sequence !== expectedMessage.sequence ||
      !this.isExactFinalMessage(discussion, turn, message)) {
      throw new ExecutionError("EXECUTION_DISCUSSION_SOURCE_STALE", 409);
    }
  }

  private requireRootRevision(discussion: DiscussionRecord): number {
    const root = this.tasks.get(discussion.taskId);
    if (!root) throw new ExecutionError("EXECUTION_ROOT_NOT_FOUND", 404);
    return root.taskRevision;
  }

  private isTerminal(discussion: DiscussionRecord): boolean {
    return discussion.state === "completed" || discussion.state === "terminated";
  }

  private isExactFinalMessage(
    discussion: DiscussionRecord,
    turn: DiscussionTurn,
    message: MessageRecord
  ): boolean {
    return message.roomId === discussion.roomId &&
      message.taskId === discussion.taskId && message.senderType === "agent" &&
      message.senderId === turn.speakerAgentId;
  }
}
