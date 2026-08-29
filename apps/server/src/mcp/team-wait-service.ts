import type {
  CoreRepository,
  MessageRecord
} from "../data/core-repository.js";
import type {
  AuthService,
  McpPrincipal
} from "../security/auth-service.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { TeamChangeService } from
  "../team-room/team-change-service.js";

interface WaitCursor {
  changeEpoch?: string;
  changeCursor?: number;
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
      (parsed.sequence ?? -1) < 0 ||
      (parsed.changeCursor !== undefined && (
        !Number.isSafeInteger(parsed.changeCursor) || parsed.changeCursor < 0
      )) ||
      (parsed.changeEpoch !== undefined && (
        typeof parsed.changeEpoch !== "string" ||
        !/^wait_[A-Za-z0-9_-]{8,128}$/u.test(parsed.changeEpoch)
      ))
    ) {
      throw new Error("cursor does not match Room");
    }
    return {
      ...(parsed.changeCursor === undefined
        ? {}
        : { changeCursor: parsed.changeCursor }),
      ...(parsed.changeEpoch === undefined
        ? {}
        : { changeEpoch: parsed.changeEpoch }),
      roomId,
      sequence: parsed.sequence ?? 0
    };
  } catch (error) {
    throw new Error("Invalid team.wait cursor", { cause: error });
  }
}

type TeamWaitCore = Pick<
  CoreRepository,
  "latestMessageSequence" | "listMessagesAfter"
>;

type TeamWaitAuth = Pick<AuthService, "requireRoomMember">;

type TeamWaitChanges = Pick<TeamChangeService, "current" | "wait">;

export class TeamWaitService {
  private readonly changeEpoch = createOpaqueId("wait");

  public constructor(
    private readonly core: TeamWaitCore,
    private readonly auth: TeamWaitAuth,
    private readonly changes: TeamWaitChanges
  ) {}

  public async wait(
    principal: McpPrincipal,
    input: {
      roomId: string;
      cursor?: string;
      timeoutMs: number;
      signal?: AbortSignal;
    }
  ): Promise<TeamWaitResult> {
    const member = this.auth.requireRoomMember(principal, input.roomId);
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 100 ||
      input.timeoutMs > 30_000
    ) {
      throw new Error("team.wait timeoutMs must be between 100 and 30000");
    }
    if (!input.cursor) {
      const changeCursor = this.changes.current(member.teamId);
      const latest = this.core.latestMessageSequence(input.roomId);
      return {
        cursor: encodeCursor({
          changeEpoch: this.changeEpoch,
          changeCursor,
          roomId: input.roomId,
          sequence: latest
        }),
        events: [],
        timedOut: false
      };
    }
    const cursor = decodeCursor(input.cursor, input.roomId);
    const observedChangeCursor = this.changes.current(member.teamId);
    const latest = this.core.latestMessageSequence(input.roomId);
    if (cursor.changeEpoch !== this.changeEpoch) {
      // Message-only cursors and cursors from an earlier Server process cannot
      // order in-memory Run notifications. A restored backup may also have a
      // lower Room sequence, so clamp the obsolete cursor to current durable
      // state and return immediately for one conservative reconciliation.
      return this.readAfter(
        input.roomId,
        Math.min(cursor.sequence, latest),
        observedChangeCursor
      );
    }
    if (cursor.sequence > latest) {
      throw new Error("team.wait cursor is ahead of Room state");
    }
    let changeCursor = cursor.changeCursor ?? 0;
    const immediate = this.readAfter(
      input.roomId,
      cursor.sequence,
      observedChangeCursor
    );
    if (immediate.events.length > 0) {
      return immediate;
    }

    const deadline = Date.now() + input.timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          cursor: encodeCursor({
            ...cursor,
            changeEpoch: this.changeEpoch,
            changeCursor
          }),
          events: [],
          timedOut: true
        };
      }
      const change = await this.changes.wait(member.teamId, changeCursor, {
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMilliseconds: remaining
      });
      changeCursor = change.cursor;
      if (!change.changed && !change.reset) {
        return {
          cursor: encodeCursor({
            ...cursor,
            changeEpoch: this.changeEpoch,
            changeCursor
          }),
          events: [],
          timedOut: true
        };
      }
      const roomChanged = change.roomIds.includes(input.roomId);
      const runChanged = change.runRoomIds.includes(input.roomId);
      if (!change.team && !change.reset && !roomChanged && !runChanged) continue;
      this.auth.requireRoomMember(principal, input.roomId);
      const result = this.readAfter(
        input.roomId,
        cursor.sequence,
        changeCursor
      );
      if (result.events.length > 0) return result;
      if (change.reset || runChanged) {
        return {
          cursor: encodeCursor({
            ...cursor,
            changeEpoch: this.changeEpoch,
            changeCursor
          }),
          events: [],
          timedOut: false
        };
      }
    }
  }

  private readAfter(
    roomId: string,
    sequence: number,
    changeCursor: number
  ): TeamWaitResult {
    const events = this.core.listMessagesAfter(roomId, sequence, 100);
    const lastSequence = events.at(-1)?.sequence ?? sequence;
    return {
      cursor: encodeCursor({
        changeEpoch: this.changeEpoch,
        changeCursor,
        roomId,
        sequence: lastSequence
      }),
      events,
      timedOut: false
    };
  }
}
