import type { BridgeConnectionRegistry } from "../bridge/bridge-connection-registry.js";
import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";
import type { RunRecord, RunRepository } from "./run-repository.js";
import { truncateUnicodeCodePoints } from "../domain/unicode-length.js";

const terminalStates = new Set(["completed", "failed", "canceled", "expired", "outcome_unknown"]);

const defaultAckTimeoutMilliseconds = 30_000;
const defaultRetryIntervalMilliseconds = 2_000;
const defaultSweepBatchSize = 100;

export interface CancellationSweepResult {
  expiredRunIds: string[];
  sentRunIds: string[];
}

export interface CancellationServiceOptions {
  ackTimeoutMilliseconds?: number;
  retryIntervalMilliseconds?: number;
  sweepBatchSize?: number;
}

export class CancellationService {
  private readonly ackTimeoutMilliseconds: number;
  private readonly retryIntervalMilliseconds: number;
  private readonly sweepBatchSize: number;

  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly auth: AuthService,
    private readonly connections: BridgeConnectionRegistry,
    private readonly clock: () => string,
    options: CancellationServiceOptions = {}
  ) {
    this.ackTimeoutMilliseconds = this.positiveInteger(
      options.ackTimeoutMilliseconds,
      defaultAckTimeoutMilliseconds,
      "cancellation acknowledgement timeout"
    );
    this.retryIntervalMilliseconds = this.positiveInteger(
      options.retryIntervalMilliseconds,
      defaultRetryIntervalMilliseconds,
      "cancellation retry interval"
    );
    this.sweepBatchSize = this.positiveInteger(
      options.sweepBatchSize,
      defaultSweepBatchSize,
      "cancellation sweep batch size"
    );
  }

  public cancel(principal: WebPrincipal, runId: string, reason: string): RunRecord {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const member = this.auth.requireRoomMember(principal, run.roomId);
    if (member.memberId !== run.requesterMemberId && member.role !== "owner") {
      throw new AuthorizationError("FORBIDDEN", "Run cancellation denied");
    }
    if (terminalStates.has(run.state)) return run;
    const existing = this.runs.getCancellationIntent(run.runId);
    const delivery = this.runs.getCancellationDelivery(run.runId);
    // Any durable Delivery row is possibly visible to Bridge: the process can
    // crash after the socket write and before send_count is persisted.
    const queuedMayHaveReachedBridge = run.state === "queued" &&
      delivery !== undefined;
    const requiresRemoteInterrupt = run.state === "delivered" ||
      run.state === "working" || queuedMayHaveReachedBridge;
    if (!existing && requiresRemoteInterrupt) {
      const agent = this.core.getAgent(run.targetAgentId);
      if (
        !agent ||
        agent.integrationMode !== "managed" ||
        !agent.capabilities.supportsInterrupt
      ) {
        throw new Error("Target Agent does not support interruption");
      }
    }
    const now = this.clock();
    const normalizedReason = truncateUnicodeCodePoints(reason.trim(), 512) ||
      "Canceled by requester";
    const requested = this.runs.requestCancellation({
      runId: run.runId,
      messageId: createOpaqueId("msg"),
      requestedByMemberId: member.memberId,
      reason: normalizedReason,
      now,
      ackDeadlineAt: this.addMilliseconds(now, this.ackTimeoutMilliseconds)
    });
    if (requested.intent?.state === "pending") {
      this.dispatch(requested.intent.runId, now);
    }
    return this.runs.getRun(run.runId) ?? requested.run;
  }

  public recover(): CancellationSweepResult {
    return this.sweep(true);
  }

  public resendForDevice(deviceId: string): string[] {
    const now = this.clock();
    this.runs.expireCancellationIntents(now, this.sweepBatchSize);
    return this.dispatchDue(now, deviceId, false);
  }

  public sweep(force = false): CancellationSweepResult {
    const now = this.clock();
    const expired = this.runs.expireCancellationIntents(
      now,
      this.sweepBatchSize
    );
    return {
      expiredRunIds: expired.map(({ runId }) => runId),
      sentRunIds: this.dispatchDue(now, undefined, force)
    };
  }

  private dispatchDue(
    now: string,
    deviceId: string | undefined,
    force: boolean
  ): string[] {
    const sentBefore = force
      ? "9999-12-31T23:59:59.999Z"
      : this.addMilliseconds(now, -this.retryIntervalMilliseconds);
    const intents = this.runs.listDispatchableCancellationIntents({
      now,
      sentBefore,
      limit: this.sweepBatchSize,
      ...(deviceId ? { deviceId } : {})
    });
    const sentRunIds: string[] = [];
    for (const intent of intents) {
      if (this.dispatch(intent.runId, now)) sentRunIds.push(intent.runId);
    }
    return sentRunIds;
  }

  private dispatch(runId: string, sentAt: string): boolean {
    const intent = this.runs.getCancellationIntent(runId);
    const run = this.runs.getRun(runId);
    if (!intent || intent.state !== "pending" || !run ||
      terminalStates.has(run.state)) {
      return false;
    }
    let sent = false;
    try {
      sent = this.connections.send(intent.deviceId, {
        protocolVersion: "1.0",
        messageId: intent.messageId,
        timestamp: intent.createdAt,
        type: "run.cancel_requested",
        payload: {
          runId: run.runId,
          traceId: run.traceId,
          agentId: intent.agentId,
          reason: intent.reason
        }
      });
    } catch {
      return false;
    }
    if (!sent) return false;
    this.runs.markCancellationIntentSent(runId, intent.messageId, sentAt);
    return true;
  }

  private addMilliseconds(timestamp: string, milliseconds: number): string {
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) throw new Error("Invalid cancellation clock");
    return new Date(parsed + milliseconds).toISOString();
  }

  private positiveInteger(
    value: number | undefined,
    fallback: number,
    label: string
  ): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
      throw new Error(`Invalid ${label}`);
    }
    return resolved;
  }
}
