import { createHash } from "node:crypto";

import type { CoreRepository, MessageRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import { redactSensitiveText } from "../security/redaction.js";
import type {
  MemoryCandidateSuggestion,
  MemoryReducerInput,
  MemoryReducerRunner
} from "./memory-reducer-runner.js";
import {
  RollingRoomMemoryRepository,
  type RollingRoomCheckpoint,
  type RollingRoomState
} from "./rolling-room-memory-repository.js";

const defaultIncrementalMessageLimit = 32;
const defaultRebaseMessageLimit = 128;
const reducerInputUtf8ByteLimit = 64 * 1024;
const leaseDurationMilliseconds = 60_000;

export interface MemoryCandidateSink {
  persistSuggestions(input: {
    roomId: string;
    checkpointId: string;
    sourceDigest: string;
    suggestions: MemoryCandidateSuggestion[];
    now: string;
  }): Promise<void> | void;
}

export interface MemoryReducerSweepResult {
  attemptedRooms: number;
  committedCheckpoints: number;
  failedRooms: number;
  candidateFailures: number;
}

function sourceDigest(messages: MessageRecord[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map((message) => ({
    messageId: message.messageId,
    sequence: message.sequence,
    senderType: message.senderType,
    senderId: message.senderId,
    content: message.content
  })))).digest("hex");
}

function validateReducerOutput(
  output: Awaited<ReturnType<MemoryReducerRunner["reduce"]>>,
  messages: MessageRecord[]
): void {
  if (
    output.summary.trim().length === 0 || output.summary.length > 12_000 ||
    output.modelFingerprint.trim().length === 0 ||
    output.modelFingerprint.length > 160 ||
    output.provenanceMessageIds.length === 0 ||
    output.provenanceMessageIds.length > 64 ||
    new Set(output.provenanceMessageIds).size !==
      output.provenanceMessageIds.length
  ) {
    throw new Error("Memory reducer output is outside its bounds");
  }
  const sourceIds = new Set(messages.map(({ messageId }) => messageId));
  if (output.provenanceMessageIds.some((messageId) => !sourceIds.has(messageId))) {
    throw new Error("Memory reducer provenance is outside its input interval");
  }
}

export class MemoryReducerScheduler {
  public constructor(
    private readonly core: CoreRepository,
    private readonly rolling: RollingRoomMemoryRepository,
    private readonly runner: MemoryReducerRunner,
    private readonly clock: () => string,
    private readonly candidateSink?: MemoryCandidateSink
  ) {}

  public enableAllRooms(): number {
    return this.rolling.enableAll(this.clock());
  }

  public async sweep(limit = 8): Promise<MemoryReducerSweepResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Memory reducer sweep limit must be between 1 and 100");
    }
    this.enableAllRooms();
    const retryBefore = Date.parse(this.clock()) - 30_000;
    const states = this.rolling
      .listPending(Math.min(100, limit * 4))
      .filter((state) =>
        state.mode !== "degraded" || Date.parse(state.updatedAt) <= retryBefore
      )
      .slice(0, limit);
    const result: MemoryReducerSweepResult = {
      attemptedRooms: states.length,
      committedCheckpoints: 0,
      failedRooms: 0,
      candidateFailures: 0
    };
    for (const state of states) {
      const drained = await this.drainRoom(state.roomId);
      if (drained.committed) result.committedCheckpoints += 1;
      if (drained.failed) result.failedRooms += 1;
      if (drained.candidateFailed) result.candidateFailures += 1;
    }
    return result;
  }

  public async drainRoom(
    roomId: string,
    options: { rebase?: boolean } = {}
  ): Promise<{ committed: boolean; failed: boolean; candidateFailed: boolean }> {
    const now = this.clock();
    const lease = this.rolling.acquireLease({
      roomId,
      leaseToken: createOpaqueId("lease"),
      now,
      leaseExpiresAt: new Date(
        Date.parse(now) + leaseDurationMilliseconds
      ).toISOString()
    });
    if (!lease) {
      return { committed: false, failed: false, candidateFailed: false };
    }
    try {
      const work = this.planWork(lease, options.rebase === true);
      const previousCheckpoint = lease.latestCheckpointId
        ? this.rolling.getCheckpoint(lease.latestCheckpointId)
        : undefined;
      const reducerInput: MemoryReducerInput = {
        roomId,
        buildKind: work.buildKind,
        fromSequenceExclusive: work.fromSequenceExclusive,
        throughSequence: work.throughSequence,
        ...(previousCheckpoint && work.buildKind === "incremental"
          ? {
              previousCheckpoint: {
                checkpointId: previousCheckpoint.checkpointId,
                throughSequence: previousCheckpoint.throughSequence,
                summary: previousCheckpoint.summary
              }
            }
          : {}),
        messages: work.messages.map((message) => ({
          messageId: message.messageId,
          sequence: message.sequence,
          senderType: message.senderType,
          senderId: message.senderId,
          content: redactSensitiveText(message.content)
        }))
      };
      const output = await this.runner.reduce(reducerInput);
      validateReducerOutput(output, work.messages);
      const digest = sourceDigest(work.messages);
      const checkpoint: RollingRoomCheckpoint = {
        checkpointId: createOpaqueId("checkpoint"),
        roomId,
        parentCheckpointId: work.buildKind === "incremental"
          ? lease.latestCheckpointId
          : null,
        inputFromSequenceExclusive: work.fromSequenceExclusive,
        throughSequence: work.throughSequence,
        summary: redactSensitiveText(output.summary.trim()),
        provenance: output.provenanceMessageIds,
        sourceMessageCount: work.messages.length,
        sourceDigest: digest,
        promptVersion: this.runner.promptVersion,
        modelFingerprint: redactSensitiveText(output.modelFingerprint.trim()),
        buildKind: work.buildKind,
        createdAt: this.clock()
      };
      this.rolling.commitCheckpoint({
        checkpoint,
        expectedGeneration: lease.generation,
        leaseToken: lease.leaseToken!,
        now: this.clock()
      });
      let candidateFailed = false;
      if (this.candidateSink && (output.candidates?.length ?? 0) > 0) {
        try {
          await this.candidateSink.persistSuggestions({
            roomId,
            checkpointId: checkpoint.checkpointId,
            sourceDigest: digest,
            suggestions: output.candidates ?? [],
            now: this.clock()
          });
        } catch {
          candidateFailed = true;
        }
      }
      return { committed: true, failed: false, candidateFailed };
    } catch (error) {
      this.rolling.recordFailure({
        roomId,
        expectedGeneration: lease.generation,
        leaseToken: lease.leaseToken!,
        safeError: redactSensitiveText(
          error instanceof Error ? error.message : "Memory reducer failed"
        ).slice(0, 1000),
        now: this.clock()
      });
      return { committed: false, failed: true, candidateFailed: false };
    }
  }

  private planWork(
    state: RollingRoomState,
    rebase: boolean
  ): {
    buildKind: "incremental" | "rebase";
    fromSequenceExclusive: number;
    throughSequence: number;
    messages: MessageRecord[];
  } {
    const fromSequenceExclusive = rebase ? 0 : state.latestThroughSequence;
    const messageLimit = rebase
      ? defaultRebaseMessageLimit
      : defaultIncrementalMessageLimit;
    const maximumTarget = Math.min(
      state.desiredThroughSequence,
      fromSequenceExclusive + messageLimit
    );
    const availableMessages = this.core.listMessagesRange(
      state.roomId,
      fromSequenceExclusive,
      maximumTarget,
      messageLimit + 1
    );
    if (
      availableMessages.length !== maximumTarget - fromSequenceExclusive ||
      availableMessages.some((message, index) =>
        message.sequence !== fromSequenceExclusive + index + 1
      )
    ) {
      throw new Error("Memory reducer input interval is not contiguous");
    }
    const messages: MessageRecord[] = [];
    let bytes = 0;
    for (const message of availableMessages) {
      const nextBytes = bytes + Buffer.byteLength(message.content, "utf8");
      if (nextBytes > reducerInputUtf8ByteLimit) break;
      messages.push(message);
      bytes = nextBytes;
    }
    if (messages.length === 0) {
      throw new Error("Memory reducer input exceeds its byte bound");
    }
    const target = messages.at(-1)!.sequence;
    if (rebase && target < state.latestThroughSequence) {
      throw new Error("Bounded rebase cannot cover the current latest checkpoint");
    }
    return {
      buildKind: rebase ? "rebase" : "incremental",
      fromSequenceExclusive,
      throughSequence: target,
      messages
    };
  }
}
