export interface MemoryReducerMessage {
  messageId: string;
  sequence: number;
  senderType: "member" | "agent" | "system";
  senderId: string;
  content: string;
}

export interface MemoryReducerInput {
  roomId: string;
  buildKind: "incremental" | "rebase";
  fromSequenceExclusive: number;
  throughSequence: number;
  previousCheckpoint?: {
    checkpointId: string;
    throughSequence: number;
    summary: string;
  };
  messages: MemoryReducerMessage[];
}

export interface MemoryCandidateSuggestion {
  scopeKind: "room" | "task";
  scopeId: string;
  type:
    | "decision" | "constraint" | "fact" | "open_question" | "convention"
    | "goal" | "acceptance_criterion" | "plan" | "progress" | "blocker"
    | "result";
  content: string;
  sourceMessageIds: string[];
}

export interface MemoryReducerOutput {
  summary: string;
  provenanceMessageIds: string[];
  modelFingerprint: string;
  candidates?: MemoryCandidateSuggestion[];
}

export interface MemoryReducerRunner {
  readonly promptVersion: number;
  reduce(input: MemoryReducerInput): Promise<MemoryReducerOutput>;
}

const summaryLimit = 12_000;
const excerptLimit = 480;

function excerpt(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= excerptLimit
    ? normalized
    : `${normalized.slice(0, excerptLimit - 1)}…`;
}

// This opt-in baseline is deliberately extractive. It proves scheduling,
// coverage, redaction, and recovery without claiming semantic recall quality.
export class ExtractiveMemoryReducerRunner implements MemoryReducerRunner {
  public readonly promptVersion = 1;

  public async reduce(input: MemoryReducerInput): Promise<MemoryReducerOutput> {
    const prior = input.buildKind === "incremental"
      ? input.previousCheckpoint?.summary.trim() ?? ""
      : "";
    const lines = input.messages.map((message) =>
      `- [sequence ${message.sequence}; ${message.senderType}:${message.senderId}] ${
        excerpt(message.content)
      }`
    );
    const recent = lines.join("\n");
    const prefix = prior.length > 0
      ? `Earlier rolling context:\n${prior}\n\nNew Room evidence:\n`
      : "Room evidence:\n";
    const available = Math.max(0, summaryLimit - prefix.length);
    const boundedRecent = recent.length <= available
      ? recent
      : recent.slice(recent.length - available);
    const summary = `${prefix}${boundedRecent}`.slice(0, summaryLimit).trim();
    if (summary.length === 0) {
      throw new Error("Extractive reducer received no usable Room evidence");
    }
    return {
      summary,
      provenanceMessageIds: input.messages
        .slice(-64)
        .map(({ messageId }) => messageId),
      modelFingerprint: "extractive-v1"
    };
  }
}
