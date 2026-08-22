import type { BridgeConnectionRegistry } from "../bridge/bridge-connection-registry.js";
import type { CoreRepository } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import {
  AuthorizationError,
  type AuthService,
  type WebPrincipal
} from "../security/auth-service.js";
import type { RunRecord, RunRepository } from "./run-repository.js";

const terminalStates = new Set(["completed", "failed", "canceled", "expired", "outcome_unknown"]);

export class CancellationService {
  public constructor(
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly auth: AuthService,
    private readonly connections: BridgeConnectionRegistry,
    private readonly clock: () => string
  ) {}

  public cancel(principal: WebPrincipal, runId: string, reason: string): RunRecord {
    const run = this.runs.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const member = this.auth.requireRoomMember(principal, run.roomId);
    if (member.memberId !== run.requesterMemberId && member.role !== "owner") {
      throw new AuthorizationError("FORBIDDEN", "Run cancellation denied");
    }
    if (terminalStates.has(run.state)) return run;
    if (run.state === "queued") {
      return this.runs.applyEvent(run.runId, {
        type: "status", sequence: run.lastSequence + 1, status: "canceled"
      }, this.clock()).run;
    }
    const agent = this.core.getAgent(run.targetAgentId);
    if (
      !agent ||
      !agent.deviceId ||
      agent.integrationMode !== "managed" ||
      !agent.capabilities.supportsInterrupt
    ) {
      throw new Error("Target Agent does not support interruption");
    }
    const sent = this.connections.send(agent.deviceId, {
      protocolVersion: "1.0",
      messageId: createOpaqueId("msg"),
      timestamp: this.clock(),
      type: "run.cancel_requested",
      payload: {
        runId: run.runId,
        agentId: run.targetAgentId,
        reason: reason.trim().slice(0, 512) || "Canceled by requester"
      }
    });
    if (!sent) {
      return this.runs.applyEvent(run.runId, {
        type: "status",
        sequence: run.lastSequence + 1,
        status: "outcome_unknown",
        error: {
          code: "RUN_CANCEL_DELIVERY_LOST",
          message: "Cancellation could not reach the managed Runtime.",
          retryable: false
        }
      }, this.clock()).run;
    }
    return this.runs.getRun(run.runId) ?? run;
  }
}
