import type { CoreRepository, MessageRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  exceedsUnicodeCodePointLimit,
  truncateUnicodeCodePoints
} from "../domain/unicode-length.js";
import type { RunRepository } from "../run/run-repository.js";
import { redactSensitiveText } from "../security/redaction.js";
import type { ArtifactRepository } from "../task/artifact-repository.js";
import type { MemoryEntryRepository } from "../task/memory-entry-repository.js";
import type { ResultRepository } from "../task/result-repository.js";
import { verifyDiscussionEvidenceReferences } from
  "./discussion-evidence-reference.js";
import type { DiscussionRepository } from "./discussion-repository.js";
import type {
  DiscussionParticipant,
  DiscussionRecord,
  DiscussionTurn,
  DiscussionWave
} from "./discussion-types.js";

const maximumInstructionCodePoints = 20_000;
const maximumGoalCodePoints = 8_000;
const maximumProgressCodePoints = 6_000;
const truncationMarker = "\n[... truncated to preserve required instruction sections ...]";

export interface DiscussionEvidenceReferenceSources {
  artifacts?: Pick<ArtifactRepository, "get">;
  results?: Pick<ResultRepository, "get">;
  memories?: Pick<MemoryEntryRepository, "get">;
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _codePoint of value) length += 1;
  return length;
}

function truncateSection(value: string, maximum: number): string {
  if (!exceedsUnicodeCodePointLimit(value, maximum)) return value;
  const markerLength = codePointLength(truncationMarker);
  if (maximum <= markerLength) {
    return truncateUnicodeCodePoints(value, maximum);
  }
  const contentLimit = maximum - markerLength;
  return truncateUnicodeCodePoints(value, contentLimit) + truncationMarker;
}

function truncateTranscript(lines: readonly string[], maximum: number): string {
  if (maximum <= 0) return "";
  const complete = lines.join("\n");
  if (!exceedsUnicodeCodePointLimit(complete, maximum)) return complete;

  const marker = truncationMarker.trimStart();
  const markerLength = codePointLength(marker);
  if (maximum <= markerLength) {
    return truncateUnicodeCodePoints(marker, maximum);
  }
  const selected: string[] = [];
  let remaining = maximum - markerLength - 1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const separatorLength = selected.length === 0 ? 0 : 1;
    const lineLength = codePointLength(line);
    if (lineLength + separatorLength <= remaining) {
      selected.unshift(line);
      remaining -= lineLength + separatorLength;
      continue;
    }
    if (selected.length === 0) {
      selected.unshift(truncateUnicodeCodePoints(line, remaining));
    }
    break;
  }
  return selected.length === 0 ? marker : `${marker}\n${selected.join("\n")}`;
}

export class DiscussionEvidenceService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly repository: DiscussionRepository,
    private readonly runs: RunRepository,
    private readonly clock: () => string,
    private readonly referenceSources: DiscussionEvidenceReferenceSources = {}
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
    const discussionParticipants = this.repository.listParticipants(discussion.discussionId);
    const participants = discussionParticipants
      .map((participant) => {
        const agent = this.core.getAgent(participant.agentId);
        return `${agent?.name ?? participant.agentId} (${participant.role})`;
      });
    const currentParticipant = discussionParticipants.find(
      ({ agentId }) => agentId === turn.speakerAgentId
    );
    const currentAgent = this.core.getAgent(turn.speakerAgentId);
    const currentRole = currentParticipant?.role ?? "participant";
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
    const transcriptLines = transcript.map((message) =>
      `[${message.messageId} | ${this.senderName(message)}] ` +
        redactSensitiveText(message.content)
    );
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
    const progress = truncateSection([
      `Confidence: ${discussion.progress.confidence ?? "unknown"}`,
      `Disagreement: ${discussion.progress.disagreementRemaining}`,
      `Plateau count: ${discussion.progress.plateauCount}`,
      `Verified evidence references: ${
        discussion.progress.verifiedEvidenceRefs.length > 0
          ? discussion.progress.verifiedEvidenceRefs.join(", ")
          : "None"
      }`,
      "Important unresolved questions:",
      unresolved
    ].join("\n"), maximumProgressCodePoints);
    const leading = [
      "# ConveneWire Discussion Context",
      `Discussion ID: ${discussion.discussionId}`,
      `Task ID: ${discussion.taskId}`,
      `Wave: ${wave.ordinal}`,
      `Wave member: ${(turn.waveMemberOrdinal ?? 0) + 1}/${wave.expectedMembers}`,
      `Mode: ${discussion.mode}`,
      `Current Agent: ${currentAgent?.name ?? turn.speakerAgentId} (${currentRole})`,
      `Participants: ${participants.join(", ")}`,
      "",
      "## Goal",
      truncateSection(discussion.goal, maximumGoalCodePoints),
      "",
      "## Progress",
      progress,
      "",
      "## Remaining Lease",
      `${remainingLease} ordinary waves.`,
      "",
      "## Recent Room Transcript"
    ].join("\n");
    const assessmentExample = "<agentroom-assessment>{\"goalSatisfied\":false," +
      "\"confidence\":0.75,\"resolvedQuestionIds\":[\"q1\"]," +
      "\"openQuestions\":[{\"id\":\"q2\",\"question\":\"What remains?\"," +
      "\"importance\":\"high\"}],\"newEvidenceRefs\":[\"msg_example1\"]," +
      "\"disagreementRemaining\":\"medium\",\"newInformationAdded\":true," +
      "\"reviewerApproved\":false,\"recommendation\":\"continue\"}" +
      "</agentroom-assessment>";
    const trailing = [
      "## Your Task",
      task,
      "Other participants in this Wave run concurrently and cannot see this reply until the next Wave.",
      "The Orchestrator, not you, decides whether the Discussion continues. " +
        "A plain-text reply is always valid when structured assessment is unsupported.",
      "When supported, append exactly one final line in this complete optional-field form:",
      assessmentExample,
      "Only report fields you can justify. Do not invent question IDs or evidence references.",
      ...(currentRole === "reviewer"
        ? ["As the designated Reviewer, always report reviewerApproved as true or false."]
        : []),
      "The assessment is evidence only; it does not control the next action."
    ].join("\n");
    const framingCodePoints = codePointLength(leading) + codePointLength(trailing) + 3;
    if (framingCodePoints > maximumInstructionCodePoints) {
      throw new Error("Required Discussion instruction exceeds its character boundary");
    }
    const transcriptBudget = maximumInstructionCodePoints - framingCodePoints;
    const transcriptText = truncateTranscript(transcriptLines, transcriptBudget) ||
      "None available.";
    const instruction = `${leading}\n${transcriptText}\n\n${trailing}`;
    if (exceedsUnicodeCodePointLimit(instruction, maximumInstructionCodePoints)) {
      throw new Error("Discussion instruction exceeds its character boundary");
    }
    return instruction;
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

  public verifyEvidenceRefs(
    discussion: DiscussionRecord,
    references: readonly string[]
  ): string[] {
    return verifyDiscussionEvidenceReferences(discussion, references, {
      message: (reference) => this.core.getMessage(reference),
      run: (reference) => this.runs.getRun(reference),
      artifact: (reference) => this.referenceSources.artifacts?.get(reference),
      result: (reference) => this.referenceSources.results?.get(reference),
      memory: (reference) => this.referenceSources.memories?.get(reference),
      discussion: (reference) => this.repository.get(reference)
    });
  }

  public recentAcceptedReplies(
    discussion: DiscussionRecord,
    currentWave: DiscussionWave,
    maximum = 10
  ): string[] {
    return this.acceptedPriorTurnMessages(discussion, currentWave)
      .slice(-maximum)
      .map(({ content }) => content);
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
    const messages: MessageRecord[] = [];
    const root = this.core.getMessage(discussion.rootMessageId);
    if (root) messages.push(root);
    messages.push(...this.acceptedPriorTurnMessages(discussion, currentWave));
    if (
      trigger && trigger.messageId !== discussion.rootMessageId &&
      !messages.some(({ messageId }) => messageId === trigger.messageId)
    ) {
      messages.push(trigger);
    }
    return messages.slice(-24);
  }

  private acceptedPriorTurnMessages(
    discussion: DiscussionRecord,
    currentWave: DiscussionWave
  ): MessageRecord[] {
    const waves = new Map(
      this.repository.listWaves(discussion.discussionId)
        .map((wave) => [wave.waveId, wave.ordinal])
    );
    const sealedAcceptedTurns = new Map(
      this.repository.listWaveSeals(discussion.discussionId)
        .map((seal) => [
          seal.waveId,
          new Set(seal.acceptedMembers.map(({ turnId }) => turnId))
        ])
    );
    const messages: MessageRecord[] = [];
    for (const turn of this.repository.listTurns(discussion.discussionId)) {
      const waveOrdinal = turn.waveId ? waves.get(turn.waveId) : undefined;
      if (
        waveOrdinal === undefined || waveOrdinal >= currentWave.ordinal ||
        !turn.outputMessageId ||
        (sealedAcceptedTurns.has(turn.waveId!) &&
          !sealedAcceptedTurns.get(turn.waveId!)!.has(turn.turnId))
      ) {
        continue;
      }
      const output = this.core.getMessage(turn.outputMessageId);
      if (output) messages.push(output);
    }
    return messages;
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
