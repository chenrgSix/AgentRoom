import type {
  CoreRepository,
  MessageRecord
} from "../data/core-repository.js";
import type {
  AuthService,
  McpPrincipal
} from "../security/auth-service.js";

interface WaitCursor {
  roomId: string;
  sequence: number;
}

export interface TeamWaitResult {
  cursor: string;
  events: MessageRecord[];
  timedOut: boolean;
}

function encodeCursor(value: WaitCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string, roomId: string): WaitCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Partial<WaitCursor>;
    if (
      parsed.roomId !== roomId ||
      !Number.isSafeInteger(parsed.sequence) ||
      (parsed.sequence ?? -1) < 0
    ) {
      throw new Error("cursor does not match Room");
    }
    return { roomId, sequence: parsed.sequence ?? 0 };
  } catch (error) {
    throw new Error("Invalid team.wait cursor", { cause: error });
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class TeamWaitService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly auth: AuthService
  ) {}

  public async wait(
    principal: McpPrincipal,
    input: {
      roomId: string;
      cursor?: string;
      timeoutMs: number;
    }
  ): Promise<TeamWaitResult> {
    this.auth.requireRoomMember(principal, input.roomId);
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 100 ||
      input.timeoutMs > 30_000
    ) {
      throw new Error("team.wait timeoutMs must be between 100 and 30000");
    }
    const latest = this.core.latestMessageSequence(input.roomId);
    if (!input.cursor) {
      return {
        cursor: encodeCursor({ roomId: input.roomId, sequence: latest }),
        events: [],
        timedOut: false
      };
    }
    const cursor = decodeCursor(input.cursor, input.roomId);
    if (cursor.sequence > latest) {
      throw new Error("team.wait cursor is ahead of Room state");
    }
    const immediate = this.readAfter(input.roomId, cursor.sequence);
    if (immediate.events.length > 0) {
      return immediate;
    }

    const deadline = Date.now() + input.timeoutMs;
    while (Date.now() < deadline) {
      await pause(Math.min(100, Math.max(1, deadline - Date.now())));
      const result = this.readAfter(input.roomId, cursor.sequence);
      if (result.events.length > 0) {
        return result;
      }
    }
    return {
      cursor: encodeCursor(cursor),
      events: [],
      timedOut: true
    };
  }

  private readAfter(roomId: string, sequence: number): TeamWaitResult {
    const events = this.core.listMessagesAfter(roomId, sequence, 100);
    const lastSequence = events.at(-1)?.sequence ?? sequence;
    return {
      cursor: encodeCursor({ roomId, sequence: lastSequence }),
      events,
      timedOut: false
    };
  }
}
