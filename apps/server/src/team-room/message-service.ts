import type {
  CoreRepository,
  MentionRecord,
  MessageRecord
} from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type {
  AuthService,
  McpPrincipal,
  WebPrincipal
} from "../security/auth-service.js";
import { redactSensitiveText } from "../security/redaction.js";
import { containsExactAllMention } from "./exact-agent-mentions.js";

interface MessageCursor {
  roomId: string;
  sequence: number;
}

export interface MessagePage {
  items: MessageRecord[];
  nextCursor: string | null;
  syncCursor: string;
}

function encodeCursor(cursor: MessageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, roomId: string): MessageCursor {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as Partial<MessageCursor>;
    if (
      value.roomId !== roomId ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence ?? -1) < 0
    ) {
      throw new Error("cursor fields do not match the Room");
    }
    return { roomId, sequence: value.sequence ?? 0 };
  } catch (error) {
    throw new Error("Invalid Room message cursor", { cause: error });
  }
}

export class MessageService {
  public constructor(
    private readonly repository: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public createMemberMessage(
    principal: WebPrincipal,
    input: {
      roomId: string;
      taskId?: string;
      content: string;
      mentions?: MentionRecord[];
      parentMessageId?: string | null;
      clientMessageId?: string;
      now: string;
    }
  ): MessageRecord {
    return this.createMemberMessageResult(principal, input).message;
  }

  public createMemberMessageResult(
    principal: WebPrincipal,
    input: {
      roomId: string;
      taskId?: string;
      content: string;
      mentions?: MentionRecord[];
      parentMessageId?: string | null;
      clientMessageId?: string;
      now: string;
    }
  ): { created: boolean; message: MessageRecord } {
    const member = this.auth.requireRoomMember(principal, input.roomId);
    const room = this.repository.getRoom(input.roomId);
    if (!room) throw new Error(`Room not found: ${input.roomId}`);
    if (input.content.trim().length === 0 || input.content.length > 20_000) {
      throw new Error("Message content must contain 1 to 20000 characters");
    }
    if (
      containsExactAllMention(input.content) &&
      !room.collaborationPolicy.allowAll
    ) {
      throw new Error("Room policy does not allow the @all command");
    }
    if (
      input.clientMessageId !== undefined &&
      !/^client_[A-Za-z0-9_-]{8,128}$/u.test(input.clientMessageId)
    ) {
      throw new Error("Client Message ID is invalid");
    }
    const parent = input.parentMessageId
      ? this.repository.getMessage(input.parentMessageId)
      : undefined;
    if (input.parentMessageId) {
      if (!parent || parent.roomId !== input.roomId) {
        throw new Error("Parent Message must belong to the same Room");
      }
    }
    const mentions = input.mentions ?? [];
    if (mentions.length > 5) {
      throw new Error("A Room Message cannot route to more than 5 Agents");
    }
    const targets = new Set<string>();
    for (const mention of mentions) {
      if (
        mention.targetType !== "agent" ||
        mention.displayLabel.trim().length === 0 ||
        mention.displayLabel.length > 160
      ) {
        throw new Error("Malformed structured Agent Mention");
      }
      if (targets.has(mention.targetAgentId)) {
        throw new Error(`Duplicate Agent Mention: ${mention.targetAgentId}`);
      }
      targets.add(mention.targetAgentId);
      const agent = this.repository.getAgent(mention.targetAgentId);
      if (
        !agent ||
        agent.teamId !== member.teamId ||
        !agent.enabled ||
        !this.repository.isRoomAgent(input.roomId, agent.agentId)
      ) {
        throw new Error(`Mention target is unavailable: ${mention.targetAgentId}`);
      }
    }
    return this.repository.appendMessageWithResult({
      messageId: createOpaqueId("msg"),
      roomId: input.roomId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      senderType: "member",
      senderId: member.memberId,
      content: input.content,
      mentions,
      parentMessageId: input.parentMessageId ?? null,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      ...(parent ? { traceId: parent.traceId } : {}),
      createdAt: input.now
    });
  }

  public createAgentMessage(
    principal: McpPrincipal,
    input: {
      roomId: string;
      taskId?: string;
      content: string;
      parentMessageId?: string | null;
      now: string;
    }
  ): MessageRecord {
    const member = this.auth.requireRoomMember(principal, input.roomId);
    const agent = this.repository.getAgent(principal.agentId);
    if (
      !agent ||
      !agent.enabled ||
      agent.teamId !== member.teamId ||
      agent.ownerMemberId !== member.memberId ||
      !this.repository.isRoomAgent(input.roomId, agent.agentId)
    ) {
      throw new Error("Authenticated MCP Agent is unavailable in this Room");
    }
    if (input.content.trim().length === 0 || input.content.length > 20_000) {
      throw new Error("Message content must contain 1 to 20000 characters");
    }
    const parent = input.parentMessageId
      ? this.repository.getMessage(input.parentMessageId)
      : undefined;
    if (input.parentMessageId) {
      if (!parent || parent.roomId !== input.roomId) {
        throw new Error("Parent Message must belong to the same Room");
      }
    }
    return this.repository.appendMessage({
      messageId: createOpaqueId("msg"),
      roomId: input.roomId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      senderType: "agent",
      senderId: agent.agentId,
      content: redactSensitiveText(input.content),
      mentions: [],
      parentMessageId: input.parentMessageId ?? null,
      ...(parent ? { traceId: parent.traceId } : {}),
      createdAt: input.now
    });
  }

  public listMessages(
    principal: WebPrincipal,
    input: { roomId: string; cursor?: string; limit?: number; tail?: boolean }
  ): MessagePage {
    this.auth.requireRoomMember(principal, input.roomId);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Message page limit must be between 1 and 100");
    }
    if (input.cursor && input.tail) {
      throw new Error("Message cursor and tail mode cannot be combined");
    }
    if (input.tail) {
      const latest = this.repository.latestMessageSequence(input.roomId);
      return {
        items: latest === 0
          ? []
          : this.repository.listMessagesThrough(input.roomId, latest, limit),
        nextCursor: null,
        syncCursor: encodeCursor({ roomId: input.roomId, sequence: latest })
      };
    }
    const after = input.cursor
      ? decodeCursor(input.cursor, input.roomId).sequence
      : 0;
    const rows = this.repository.listMessagesAfter(input.roomId, after, limit + 1);
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last
        ? encodeCursor({ roomId: input.roomId, sequence: last.sequence })
        : null,
      syncCursor: encodeCursor({
        roomId: input.roomId,
        sequence: last?.sequence ?? after
      })
    };
  }
}
