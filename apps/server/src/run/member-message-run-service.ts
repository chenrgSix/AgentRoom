import type { MessageRecord } from "../data/core-repository.js";
import type { SqliteTransactionBoundary } from
  "../data/sqlite-transaction-boundary.js";
import type { WebPrincipal } from "../security/auth-service.js";
import type {
  CreateMemberMessageInput,
  MessageService
} from "../team-room/message-service.js";
import type { RunRecord } from "./run-repository.js";
import type { RunService } from "./run-service.js";

export interface MemberMessageRunResult {
  message: MessageRecord;
  messageCreated: boolean;
  runs: RunRecord[];
  runsCreated: boolean;
}

export class MemberMessageRunService {
  public constructor(
    private readonly transactions: SqliteTransactionBoundary,
    private readonly messages: MessageService,
    private readonly runs: RunService
  ) {}

  public create(
    principal: WebPrincipal,
    input: CreateMemberMessageInput
  ): MemberMessageRunResult {
    return this.transactions.immediate(() => {
      const persisted = this.messages.createMemberMessageResult(principal, input);
      const routed = this.runs.createRunsForMessageResult(
        principal,
        persisted.message.messageId,
        input.now
      );
      return {
        message: persisted.message,
        messageCreated: persisted.created,
        runs: routed.runs,
        runsCreated: routed.created
      };
    });
  }
}
