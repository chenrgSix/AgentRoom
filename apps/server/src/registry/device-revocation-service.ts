import type { BridgeConnectionRegistry } from
  "../bridge/bridge-connection-registry.js";
import type { CoreRepository, DeviceRecord } from "../data/core-repository.js";
import { createOpaqueId } from "../domain/identifiers.js";
import type { RunRepository } from "../run/run-repository.js";
import type { WebPrincipal } from "../security/auth-service.js";
import type { MemberDeviceService } from "./member-device-service.js";

export class DeviceRevocationService {
  public constructor(
    private readonly registry: MemberDeviceService,
    private readonly core: CoreRepository,
    private readonly runs: RunRepository,
    private readonly connections: BridgeConnectionRegistry,
    private readonly clock: () => string
  ) {}

  public revoke(
    principal: WebPrincipal,
    teamId: string,
    deviceId: string
  ): DeviceRecord {
    const now = this.clock();
    const device = this.registry.revokeDevice(
      principal,
      teamId,
      deviceId,
      now
    );
    try {
      this.reconcile(device.deviceId, now, true);
    } finally {
      this.connections.revoke(device.deviceId);
    }
    return device;
  }

  public recover(): void {
    const now = this.clock();
    for (const deviceId of this.runs.listRevokedDeviceIdsWithActiveRuns()) {
      this.reconcile(deviceId, now, false);
    }
  }

  private reconcile(
    deviceId: string,
    now: string,
    sendBestEffortCancel: boolean
  ): void {
    const affected = this.runs.listDeviceRevocationRuns(deviceId);
    if (sendBestEffortCancel) {
      for (const { run, acceptedByBridge } of affected) {
        const agent = this.core.getAgent(run.targetAgentId);
        if (!acceptedByBridge || !agent?.capabilities.supportsInterrupt) continue;
        this.connections.send(deviceId, {
          protocolVersion: "1.0",
          messageId: createOpaqueId("msg"),
          timestamp: now,
          type: "run.cancel_requested",
          payload: {
            runId: run.runId,
            traceId: run.traceId,
            agentId: run.targetAgentId,
            reason: "Target Device was revoked"
          }
        });
      }
    }
    for (const { run, acceptedByBridge } of affected) {
      this.runs.applyEvent(run.runId, {
        type: "status",
        sequence: run.lastSequence + 1,
        status: acceptedByBridge ? "outcome_unknown" : "failed",
        error: acceptedByBridge
          ? {
              code: "RUN_DEVICE_REVOKED_OUTCOME_UNKNOWN",
              message:
                "Target Device was revoked after accepting delivery; Runtime outcome cannot be verified.",
              retryable: false
            }
          : {
              code: "RUN_DEVICE_REVOKED",
              message: "Target Device was revoked before accepting delivery.",
              retryable: false
            }
      }, now);
    }
  }
}
