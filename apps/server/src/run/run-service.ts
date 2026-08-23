import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { AuthService, WebPrincipal } from "../security/auth-service.js";
import type { RunRecord, RunRepository } from "./run-repository.js";

const defaultRunDurationMilliseconds = 20 * 60 * 1000;

export class RunService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly auth: AuthService
  ) {}

  public createRunsForMessage(
    principal: WebPrincipal,
    messageId: string,
    now: string
  ): RunRecord[] {
    const message = this.core.getMessage(messageId);
    if (!message) {
      throw new Error(`Message not found: ${messageId}`);
    }
    const member = this.auth.requireRoomMember(principal, message.roomId);
    if (message.senderType !== "member" || message.senderId !== member.memberId) {
      throw new Error("Only the sending Member can route a Message");
    }
    const existing = this.runs.findByTrigger(messageId);
    if (existing.length > 0 || message.mentions.length === 0) {
      return existing;
    }
    const deadlineAt = new Date(
      Date.parse(now) + defaultRunDurationMilliseconds
    ).toISOString();
    return this.runs.createRuns(message.mentions.map((mention) => ({
      runId: createOpaqueId("run"),
      traceId: message.traceId,
      roomId: message.roomId,
      triggerMessageId: message.messageId,
      requesterMemberId: member.memberId,
      targetAgentId: mention.targetAgentId,
      parentRunId: null,
      instruction: message.content,
      state: "queued",
      lastSequence: 0,
      deadlineAt,
      createdAt: now,
      updatedAt: now,
      terminalAt: null
    })));
  }

  public listRoomRuns(
    principal: WebPrincipal,
    roomId: string,
    now?: string
  ): RunRecord[] {
    this.auth.requireRoomMember(principal, roomId);
    if (now) {
      this.runs.expireQueued(roomId, now);
    }
    return this.runs.listRoomRuns(roomId);
  }
}
