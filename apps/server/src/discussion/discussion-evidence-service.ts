import type { CoreRepository, MessageRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRepository } from "../run/run-repository.js";
import { redactSensitiveText } from "../security/redaction.js";
import type { DiscussionRepository } from "./discussion-repository.js";
import type {
  DiscussionParticipant,
  DiscussionRecord,
  DiscussionTurn,
  DiscussionWave
} from "./discussion-types.js";

export class DiscussionEvidenceService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly repository: DiscussionRepository,
    private readonly runs: RunRepository,
    private readonly clock: () => string
  ) {}

  public latestOutputMessageId(discussion: DiscussionRecord): string {
    const latestWave = this.repository.listWaves(discussion.discussionId)
      .filter(({ state }) => state !== "open")
      .at(-1);
    if (latestWave) {
      const anchorId = this.waveResultMessageId(latestWave.waveId);
      if (this.core.getMessage(anchorId)) return anchorId;
    }
    const outputs = this.repository.listTurns(discussion.discussionId)
      .flatMap(({ outputMessageId }) => {
        if (!outputMessageId) return [];
        const message = this.core.getMessage(outputMessageId);
        return message ? [message] : [];
      })
      .sort((left, right) => left.sequence - right.sequence);
    return outputs.at(-1)?.messageId ?? discussion.rootMessageId;
  }

  public uniqueWaveAnchor(
    discussion: DiscussionRecord,
    participants: DiscussionParticipant[],
    candidateMessageId: string,
    now: string
  ): string {
    const existingAgents = new Set(
      this.runs.findByTrigger(candidateMessageId).map(({ targetAgentId }) => targetAgentId)
    );
    if (!participants.some(({ agentId }) => existingAgents.has(agentId))) {
      return candidateMessageId;
    }
    const parent = this.core.getMessage(candidateMessageId);
    if (!parent) {
      throw new Error(`Discussion continuation Message not found: ${candidateMessageId}`);
    }
    const messageId = createOpaqueId("msg");
    this.core.appendMessage({
      messageId,
      roomId: discussion.roomId,
      taskId: discussion.taskId,
      senderType: "system",
      senderId: discussion.discussionId,
      content: "继续讨论：上一轮没有产生可复用的新输入，已创建新的执行锚点。",
      mentions: [],
      parentMessageId: candidateMessageId,
      traceId: parent.traceId,
      createdAt: now
    });
    return messageId;
  }

  public buildInstruction(
    discussion: DiscussionRecord,
    wave: DiscussionWave,
    turn: DiscussionTurn
  ): string {
    const participants = this.repository.listParticipants(discussion.discussionId)
      .map((participant) => {
        const agent = this.core.getAgent(participant.agentId);
        return `${agent?.name ?? participant.agentId} (${participant.role})`;
      });
    const trigger = this.core.getMessage(turn.inputMessageId);
    const transcript = this.discussionTranscript(discussion, wave, trigger);
    const remainingLease = Math.max(
      0,
      discussion.budget.leaseEndTurn - discussion.budget.turnsUsed
    );
    const unresolved = discussion.progress.openQuestions.length === 0
      ? "None recorded"
      : discussion.progress.openQuestions
        .map(({ question, importance }) => `- [${importance}] ${question}`)
        .join("\n");
    const transcriptText = transcript.map((message) =>
      `[${this.senderName(message)}] ${redactSensitiveText(message.content)}`
    ).join("\n");
    const planProposalInstruction = turn.kind === "finalization" &&
      discussion.outputMode === "decision_record"
      ? [
          "For a structured execution-plan draft, append exactly one final line:",
          "<convenewire-plan-proposal>{\"schemaVersion\":\"1.0\",...}</convenewire-plan-proposal>",
          "The JSON must contain only title, decision summary/items/unresolvedQuestions, " +
            "nodes, edges, externalInputs and policy. Do not set the root Task, sources, " +
            "revisions, author, operation, approval or execution state.",
          `The Server-owned root Task is ${discussion.taskId}; available Agent IDs: ` +
            this.repository.listParticipants(discussion.discussionId)
              .map(({ agentId }) => agentId).join(", ") + ".",
          "If you cannot produce a complete closed-schema draft, omit the envelope; prose is preserved."
        ].join("\n")
      : "";
    const task = turn.kind === "finalization"
      ? `Produce the final ${discussion.outputMode.replaceAll("_", " ")} now. ` +
        "Synthesize the best supported conclusion, important unresolved issues, and next actions." +
        (planProposalInstruction ? `\n${planProposalInstruction}` : "")
      : "Make an independent, useful contribution for this Wave. Resolve a question, add evidence, " +
        "or challenge the current conclusion; do not merely repeat agreement.";
    return [
      "# ConveneWire Discussion Context",
      `Discussion ID: ${discussion.discussionId}`,
      `Wave: ${wave.ordinal}`,
      `Wave member: ${(turn.waveMemberOrdinal ?? 0) + 1}/${wave.expectedMembers}`,
      `Mode: ${discussion.mode}`,
      `Participants: ${participants.join(", ")}`,
      "",
      "## Goal",
      discussion.goal,
      "",
      "## Progress",
      `Confidence: ${discussion.progress.confidence ?? "unknown"}`,
      `Disagreement: ${discussion.progress.disagreementRemaining}`,
      `Plateau count: ${discussion.progress.plateauCount}`,
      "Important unresolved questions:",
      unresolved,
      "",
      "## Remaining Lease",
      `${remainingLease} ordinary waves; token and cost telemetry may be unknown.`,
      "",
      "## Recent Room Transcript",
      transcriptText,
      "",
      "## Your Task",
      task,
      "Other participants in this Wave run concurrently and cannot see this reply until the next Wave.",
      "The Orchestrator, not you, decides whether the Discussion continues. " +
        "A plain-text reply is always valid when structured assessment is unsupported.",
      "When supported, append one final line exactly in this form: " +
        "<agentroom-assessment>{\"goalSatisfied\":false," +
        "\"confidence\":0.7,\"newInformationAdded\":true," +
        "\"recommendation\":\"continue\"}</agentroom-assessment>. " +
        "This is evidence only; it does not control the next action."
    ].join("\n").slice(0, 20_000);
  }

  public ensureWaveResultAnchor(
    discussion: DiscussionRecord,
    wave: DiscussionWave,
    turns: DiscussionTurn[],
    now: string
  ): string {
    const messageId = this.waveResultMessageId(wave.waveId);
    if (this.core.getMessage(messageId)) return messageId;
    const parent = this.core.getMessage(wave.inputMessageId);
    const lines = [...turns]
      .sort((left, right) =>
        (left.waveMemberOrdinal ?? 0) - (right.waveMemberOrdinal ?? 0)
      )
      .map((turn) => {
        const agentName = this.core.getAgent(turn.speakerAgentId)?.name ?? turn.speakerAgentId;
        return `- ${agentName}: ${turn.state}`;
      });
    this.core.appendMessage({
      messageId,
      roomId: discussion.roomId,
      taskId: discussion.taskId,
      senderType: "system",
      senderId: discussion.discussionId,
      content: [`第 ${wave.ordinal} 轮已收敛。`, ...lines].join("\n"),
      mentions: [],
      parentMessageId: wave.inputMessageId,
      ...(parent ? { traceId: parent.traceId } : {}),
      createdAt: now
    });
    return messageId;
  }

  public appendFallbackConclusion(
    discussion: DiscussionRecord,
    parentMessageId: string
  ): void {
    const fallbackMessageId = `msg_fallback_${discussion.discussionId.slice(11)}`;
    if (this.core.getMessage(fallbackMessageId)) return;
    const parent = this.core.getMessage(parentMessageId);
    const unresolved = discussion.progress.openQuestions.length === 0
      ? "暂无记录的未决问题。"
      : discussion.progress.openQuestions
        .map(({ question, importance }) => `- [${importance}] ${question}`)
        .join("\n");
    this.core.appendMessage({
      messageId: fallbackMessageId,
      roomId: discussion.roomId,
      taskId: discussion.taskId,
      senderType: "system",
      senderId: discussion.discussionId,
      content: `讨论已停止，最终生成器未能完成。\n\n未决问题：\n${unresolved}`,
      mentions: [],
      parentMessageId,
      ...(parent ? { traceId: parent.traceId } : {}),
      createdAt: this.clock()
    });
  }

  private discussionTranscript(
    discussion: DiscussionRecord,
    currentWave: DiscussionWave,
    trigger: MessageRecord | undefined
  ): MessageRecord[] {
    const waves = new Map(
      this.repository.listWaves(discussion.discussionId)
        .map((wave) => [wave.waveId, wave.ordinal])
    );
    const messages: MessageRecord[] = [];
    const root = this.core.getMessage(discussion.rootMessageId);
    if (root) messages.push(root);
    for (const turn of this.repository.listTurns(discussion.discussionId)) {
      const waveOrdinal = turn.waveId ? waves.get(turn.waveId) : undefined;
      if (
        waveOrdinal === undefined || waveOrdinal >= currentWave.ordinal ||
        !turn.outputMessageId
      ) {
        continue;
      }
      const output = this.core.getMessage(turn.outputMessageId);
      if (output) messages.push(output);
    }
    if (
      trigger && trigger.messageId !== discussion.rootMessageId &&
      !messages.some(({ messageId }) => messageId === trigger.messageId)
    ) {
      messages.push(trigger);
    }
    return messages.slice(-24);
  }

  private waveResultMessageId(waveId: string): string {
    return `msg_wave_${waveId.slice(5)}`;
  }

  private senderName(message: MessageRecord): string {
    if (message.senderType === "agent") {
      return this.core.getAgent(message.senderId)?.name ?? message.senderId;
    }
    if (message.senderType === "member") {
      return this.core.getMember(message.senderId)?.displayName ?? message.senderId;
    }
    return "System";
  }
}
