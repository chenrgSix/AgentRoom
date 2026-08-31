import { decodeBridgeMessage } from "@convene-wire/contracts/bridge-validator";

import type { BridgeRunEventService } from "../run/bridge-run-event-service.js";
import type { AgentRuntimePolicy } from "../data/core-repository.js";
import { normalizeBridgeVersion } from "../domain/bridge-version.js";
import { bearerToken } from "./http-helpers.js";
import type { ServerRouteContext } from "./route-context.js";

interface BridgeMessageEnvelope {
  protocolVersion?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

type BridgeRejectionCategory =
  | "invalid_envelope"
  | "invalid_hello"
  | "heartbeat_identity_mismatch"
  | "agent_publication_rejected"
  | "agent_status_rejected"
  | "agent_provision_result_rejected"
  | "invalid_trace_id"
  | "run_acceptance_rejected"
  | "run_status_rejected"
  | "run_activity_rejected"
  | "run_output_rejected"
  | "run_reply_rejected"
  | "hello_required";

const bridgeTraceIdPattern = /^trace_[A-Za-z0-9_-]{8,128}$/u;
const bridgeLogIdentifierPattern =
  /^(?:agent|run)_[A-Za-z0-9_-]{8,128}$/u;
const bridgeLogMessageTypes = new Set([
  "bridge.hello",
  "bridge.heartbeat",
  "agent.publish",
  "agent.status",
  "agent.provision.result",
  "run.accepted",
  "run.status",
  "run.activity",
  "run.output_delta",
  "run.reply"
]);
const filesystemAccessPolicies = new Set<AgentRuntimePolicy["filesystemAccess"]>([
  "read-only",
  "workspace-write",
  "local-policy"
]);

function isFilesystemAccessPolicy(
  value: unknown
): value is AgentRuntimePolicy["filesystemAccess"] {
  return typeof value === "string" && filesystemAccessPolicies.has(value as
    AgentRuntimePolicy["filesystemAccess"]);
}

export function isBridgeTraceId(value: unknown): value is string {
  return typeof value === "string" && bridgeTraceIdPattern.test(value);
}

function safeBridgeLogIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && bridgeLogIdentifierPattern.test(value)
    ? value
    : undefined;
}

function safeBridgeLogMessageType(value: unknown): string {
  return typeof value === "string" && bridgeLogMessageTypes.has(value)
    ? value
    : "unknown";
}

function bridgeMessageBytes(source: unknown): Uint8Array | undefined {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (!Array.isArray(source) ||
      source.some((chunk) => !(chunk instanceof Uint8Array))) {
    return undefined;
  }
  const size = source.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of source) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function registerBridgeSocketRoutes({
  advanceDiscussion,
  agentProvisioning,
  agents,
  app,
  auth,
  bridgeConnections,
  bridgeRunEvents,
  cancellations,
  clock,
  delivery,
  pauseDiscussionForInput,
  presence,
  routeAgentReplyMentions,
  teamChanges
}: ServerRouteContext): void {
  app.get("/ws/bridge", {
    websocket: true,
    preValidation: async (request) => {
      auth.authenticateDevice(bearerToken(request), clock());
    }
  }, (socket, request) => {
    const devicePrincipal = auth.authenticateDevice(bearerToken(request), clock());
    let registeredEpoch: number | undefined;
    socket.on("message", (source: unknown, isBinary: boolean) => {
      let message: BridgeMessageEnvelope | undefined;
      try {
        const bytes = isBinary ? undefined : bridgeMessageBytes(source);
        if (!bytes) throw new TypeError("Bridge frames must be UTF-8 text");
        message = decodeBridgeMessage(bytes) as
          BridgeMessageEnvelope | undefined;
      } catch {
        app.log.warn({
          event: "bridge.message.malformed",
          deviceId: devicePrincipal.deviceId,
          connectionEpoch: registeredEpoch ?? null
        }, "Malformed Bridge message");
        socket.close(4_007, "Malformed Bridge message");
        return;
      }
      const rejectMessage = (category: BridgeRejectionCategory): void => {
        const payload = message?.payload && typeof message.payload === "object" &&
          !Array.isArray(message.payload)
          ? message.payload
          : undefined;
        const runId = safeBridgeLogIdentifier(payload?.runId);
        const agentId = safeBridgeLogIdentifier(payload?.agentId);
        app.log.warn({
          event: "bridge.message.rejected",
          deviceId: devicePrincipal.deviceId,
          connectionEpoch: registeredEpoch ?? null,
          type: safeBridgeLogMessageType(message?.type),
          errorCategory: category,
          ...(runId ? { runId } : {}),
          ...(agentId ? { agentId } : {})
        }, "Bridge message rejected");
        socket.close(4_008, `Bridge message rejected: ${category}`);
      };
      const failMessage = (category: BridgeRejectionCategory): void => {
        const payload = message?.payload && typeof message.payload === "object" &&
          !Array.isArray(message.payload)
          ? message.payload
          : undefined;
        const runId = safeBridgeLogIdentifier(payload?.runId);
        const agentId = safeBridgeLogIdentifier(payload?.agentId);
        app.log.error({
          event: "bridge.message.processing_failed",
          deviceId: devicePrincipal.deviceId,
          connectionEpoch: registeredEpoch ?? null,
          type: safeBridgeLogMessageType(message?.type),
          errorCategory: category,
          ...(runId ? { runId } : {}),
          ...(agentId ? { agentId } : {})
        }, "Bridge message processing failed");
        socket.close(4_008, `Bridge message rejected: ${category}`);
      };
      if (!message) {
        rejectMessage("invalid_envelope");
        return;
      }
      try {
        if (message.protocolVersion !== "1.0") {
          socket.close(4_002, "Unsupported Bridge protocol");
          return;
        }
        if (
          !message.payload ||
          typeof message.payload !== "object" ||
          Array.isArray(message.payload)
        ) {
          rejectMessage("invalid_envelope");
          return;
        }
        if (message.type === "bridge.hello") {
          const deviceId = message.payload.deviceId;
          const epoch = message.payload.connectionEpoch;
          const bridgeVersion = normalizeBridgeVersion(
            message.payload.bridgeVersion
          );
          const sourceCommit = message.payload.sourceCommit;
          const executableSha256 = message.payload.executableSha256;
          const buildIdentityPresent =
            sourceCommit !== undefined || executableSha256 !== undefined;
          const supported = message.payload.supportedProtocolVersions;
          if (
            deviceId !== devicePrincipal.deviceId ||
            !Number.isSafeInteger(epoch) ||
            (epoch as number) < 1 ||
            bridgeVersion === undefined ||
            (buildIdentityPresent &&
              (typeof sourceCommit !== "string" ||
                !/^[0-9a-f]{40}$/u.test(sourceCommit) ||
                typeof executableSha256 !== "string" ||
                !/^[0-9a-f]{64}$/u.test(executableSha256))) ||
            !Array.isArray(supported) ||
            !supported.includes("1.0")
          ) {
            rejectMessage("invalid_hello");
            return;
          }
          if (!bridgeConnections.register(
            devicePrincipal.deviceId,
            epoch as number,
            socket,
            {
              supportsAgentProvisioning:
                message.payload.supportsAgentProvisioning === true,
              governedExecution: message.payload.governedExecution
            }
          )) {
            socket.close(4_009, "Stale Bridge connection epoch");
            return;
          }
          registeredEpoch = epoch as number;
          app.log.info({
            event: "bridge.connection.registered",
            deviceId: devicePrincipal.deviceId,
            connectionEpoch: registeredEpoch
          }, "Bridge connection registered");
          presence.recordHello(devicePrincipal, {
            deviceId: devicePrincipal.deviceId,
            connectionEpoch: registeredEpoch,
            bridgeVersion,
            ...(sourceCommit !== undefined ? { sourceCommit } : {}),
            ...(executableSha256 !== undefined ? { executableSha256 } : {}),
            adapterAvailable: true,
            now: clock()
          });
          cancellations.resendForDevice(devicePrincipal.deviceId);
          delivery.dispatchQueuedForDevice(devicePrincipal.deviceId);
          teamChanges.notify(devicePrincipal.teamId);
          return;
        }
        if (message.type === "bridge.heartbeat" && registeredEpoch !== undefined) {
          if (
            message.payload.deviceId !== devicePrincipal.deviceId ||
            message.payload.connectionEpoch !== registeredEpoch
          ) {
            rejectMessage("heartbeat_identity_mismatch");
            return;
          }
          presence.recordHeartbeat(devicePrincipal, {
            deviceId: devicePrincipal.deviceId,
            connectionEpoch: registeredEpoch,
            adapterAvailable: true,
            now: clock()
          });
          cancellations.resendForDevice(devicePrincipal.deviceId);
          delivery.dispatchQueuedForDevice(devicePrincipal.deviceId);
          teamChanges.notify(devicePrincipal.teamId);
          return;
        }
        if (message.type === "agent.status" && registeredEpoch !== undefined) {
          if (
            typeof message.payload.agentId !== "string" ||
            message.payload.deviceId !== devicePrincipal.deviceId ||
            message.payload.connectionEpoch !== registeredEpoch ||
            !new Set(["ready", "busy", "degraded"])
              .has(String(message.payload.status))
          ) {
            rejectMessage("agent_status_rejected");
            return;
          }
          presence.recordAgentStatus(devicePrincipal, {
            agentId: message.payload.agentId,
            deviceId: devicePrincipal.deviceId,
            connectionEpoch: registeredEpoch,
            status: message.payload.status as "ready" | "busy" | "degraded",
            now: clock()
          });
          teamChanges.notify(devicePrincipal.teamId);
          return;
        }
        if (message.type === "agent.publish" && registeredEpoch !== undefined) {
          const publicationPayload = message.payload;
          const forbiddenLocalFields = [
            "workspace",
            "workspacePath",
            "workspaceRoot",
            "filesystemPolicy",
            "networkPolicy",
            "command",
            "runtimeCommand",
            "env",
            "environment"
          ];
          const capabilities = publicationPayload.capabilities as
            | Record<string, unknown>
            | undefined;
          const runtimePolicy = publicationPayload.runtimePolicy;
          const runtimePolicyObject = runtimePolicy &&
            typeof runtimePolicy === "object" &&
            !Array.isArray(runtimePolicy)
            ? runtimePolicy as Record<string, unknown>
            : undefined;
          const validRuntimePolicy = runtimePolicy === undefined || (
            runtimePolicyObject !== undefined &&
            Object.keys(runtimePolicyObject).length === 1 &&
            isFilesystemAccessPolicy(runtimePolicyObject.filesystemAccess)
          );
          if (
            publicationPayload.deviceId !== devicePrincipal.deviceId ||
            publicationPayload.teamId !== devicePrincipal.teamId ||
            publicationPayload.ownerMemberId !== devicePrincipal.ownerMemberId ||
            typeof publicationPayload.agentId !== "string" ||
            typeof publicationPayload.name !== "string" ||
            typeof publicationPayload.role !== "string" ||
            forbiddenLocalFields.some((field) =>
              Object.prototype.hasOwnProperty.call(publicationPayload, field)
            ) ||
            capabilities?.invocationMode !== "managed" ||
            !validRuntimePolicy
          ) {
            rejectMessage("agent_publication_rejected");
            return;
          }
          agentProvisioning.convergePublishedAgent(
            devicePrincipal,
            publicationPayload.agentId as string,
            clock(),
            () => agents.publishDeviceAgent(devicePrincipal, {
              agentId: publicationPayload.agentId as string,
              name: publicationPayload.name as string,
              role: publicationPayload.role as string,
              ...(runtimePolicyObject &&
                isFilesystemAccessPolicy(runtimePolicyObject.filesystemAccess)
                ? {
                    runtimePolicy: {
                      filesystemAccess: runtimePolicyObject.filesystemAccess
                    }
                  }
                : {}),
              ...(typeof publicationPayload.runtimeScopeId === "string"
                ? { runtimeScopeId: publicationPayload.runtimeScopeId }
                : {}),
              capabilities: {
                supportsHandoff: capabilities.supportsHandoff === true,
                supportsInterrupt: capabilities.supportsInterrupt === true,
                supportsResume: capabilities.supportsResume === true,
                supportsStart: capabilities.supportsStart === true,
                supportsStreaming: capabilities.supportsStreaming === true,
                supportsRoomContextCoverage:
                  capabilities.supportsRoomContextCoverage === true,
                supportsWorkspaceLeases:
                  capabilities.supportsWorkspaceLeases === true,
                supportsArtifactPublication:
                  capabilities.supportsArtifactPublication === true,
                supportsArtifactMaterialization:
                  capabilities.supportsArtifactMaterialization === true
              },
              ...(typeof publicationPayload.workspaceRef === "string"
                ? { workspaceRef: publicationPayload.workspaceRef }
                : {}),
              ...(typeof publicationPayload.workspaceGeneration === "string"
                ? { workspaceGeneration: publicationPayload.workspaceGeneration }
                : {}),
              ...(typeof publicationPayload.workspaceAlias === "string"
                ? { workspaceAlias: publicationPayload.workspaceAlias }
                : {}),
              now: clock()
            })
          );
          cancellations.resendForDevice(devicePrincipal.deviceId);
          delivery.dispatchQueuedForDevice(devicePrincipal.deviceId);
          teamChanges.notify(devicePrincipal.teamId);
          return;
        }
        if (
          message.type === "agent.provision.result" &&
          registeredEpoch !== undefined
        ) {
          const validReasons = new Set([
            "provisioning_disabled",
            "invalid_code",
            "rate_limited",
            "busy",
            "template_not_found",
            "identity_conflict",
            "invalid_request",
            "configuration_failed"
          ]);
          if (
            typeof message.payload.requestId !== "string" ||
            typeof message.payload.deviceId !== "string" ||
            typeof message.payload.templateAgentId !== "string" ||
            typeof message.payload.agentId !== "string" ||
            !["accepted", "rejected"].includes(
              String(message.payload.status)
            ) ||
            (message.payload.status === "accepted" &&
              message.payload.reason !== undefined) ||
            (message.payload.status === "rejected" &&
              !validReasons.has(String(message.payload.reason)))
          ) {
            rejectMessage("agent_provision_result_rejected");
            return;
          }
          agentProvisioning.applyResult(devicePrincipal, {
            requestId: message.payload.requestId,
            deviceId: message.payload.deviceId,
            templateAgentId: message.payload.templateAgentId,
            agentId: message.payload.agentId,
            status: message.payload.status as "accepted" | "rejected",
            ...(typeof message.payload.reason === "string"
              ? {
                  reason: message.payload.reason as
                    | "provisioning_disabled"
                    | "invalid_code"
                    | "rate_limited"
                    | "busy"
                    | "template_not_found"
                    | "identity_conflict"
                    | "invalid_request"
                    | "configuration_failed"
                }
              : {})
          }, clock());
          teamChanges.notify(devicePrincipal.teamId);
          return;
        }
        if (message.type === "run.accepted" && registeredEpoch !== undefined) {
          if (
            typeof message.payload.runId !== "string" ||
            typeof message.payload.agentId !== "string" ||
            message.payload.sequence !== 1
          ) {
            rejectMessage("run_acceptance_rejected");
            return;
          }
          if (!isBridgeTraceId(message.payload.traceId)) {
            rejectMessage("invalid_trace_id");
            return;
          }
          const accepted = delivery.accept(
            devicePrincipal,
            message.payload.runId,
            message.payload.traceId,
            message.payload.agentId,
            1,
            clock(),
            message.payload.artifactMaterializations,
            message.payload.artifactMaterializationError
          );
          app.log.info({
            event: "run.delivery.accepted",
            traceId: accepted.traceId,
            runId: accepted.runId,
            agentId: accepted.targetAgentId,
            deviceId: devicePrincipal.deviceId,
            state: accepted.state
          }, "Run delivery accepted");
          return;
        }
        if (message.type === "run.status" && registeredEpoch !== undefined) {
          const error = message.payload.error;
          const session = message.payload.session;
          const clarification = message.payload.clarification;
          if (
            typeof message.payload.runId !== "string" ||
            typeof message.payload.agentId !== "string" ||
            !Number.isSafeInteger(message.payload.sequence) ||
            typeof message.payload.status !== "string" ||
            (error !== undefined && (typeof error !== "object" || error === null)) ||
            (session !== undefined && (typeof session !== "object" || session === null)) ||
            (clarification !== undefined && (
              typeof clarification !== "object" || clarification === null ||
              Array.isArray(clarification)
            ))
          ) {
            rejectMessage("run_status_rejected");
            return;
          }
          if (!isBridgeTraceId(message.payload.traceId)) {
            rejectMessage("invalid_trace_id");
            return;
          }
          const runtimeError = error as Record<string, unknown> | undefined;
          const runtimeSession = session as Record<string, unknown> | undefined;
          const roomContextConsumption = runtimeSession?.roomContextConsumption as
            | Record<string, unknown>
            | undefined;
          const runtimeClarification = clarification as
            | Record<string, unknown>
            | undefined;
          if (runtimeClarification && (
            Object.keys(runtimeClarification).some((key) =>
              !new Set(["kind", "question", "choices"]).has(key)
            ) ||
            typeof runtimeClarification.kind !== "string" ||
            typeof runtimeClarification.question !== "string" ||
            (runtimeClarification.choices !== undefined && (
              !Array.isArray(runtimeClarification.choices) ||
              runtimeClarification.choices.some((choice) =>
                typeof choice !== "string"
              )
            ))
          )) {
            rejectMessage("run_status_rejected");
            return;
          }
          const applied = bridgeRunEvents.applyStatus(devicePrincipal, {
            runId: message.payload.runId,
            traceId: message.payload.traceId,
            agentId: message.payload.agentId,
            sequence: message.payload.sequence as number,
            status: message.payload.status as Parameters<
              BridgeRunEventService["applyStatus"]
            >[1]["status"],
            ...(runtimeError
              ? {
                  error: {
                    code: String(runtimeError.code ?? ""),
                    message: String(runtimeError.message ?? ""),
                    retryable: runtimeError.retryable === true,
                    ...(runtimeError.details === undefined
                      ? {}
                      : { details: runtimeError.details })
                  }
                }
              : {}),
            ...(runtimeSession
              ? {
                  session: {
                    disposition: String(runtimeSession.disposition ?? "") as
                      "started" | "resumed" | "recreated",
                    contextCursor: Number(runtimeSession.contextCursor),
                    ...(typeof runtimeSession.runtimeScopeId === "string"
                      ? { runtimeScopeId: runtimeSession.runtimeScopeId }
                      : {}),
                    ...(runtimeSession.resultEvidenceRevision === undefined
                      ? {}
                      : {
                          resultEvidenceRevision: Number(
                            runtimeSession.resultEvidenceRevision
                          )
                        }),
                    ...(roomContextConsumption === undefined
                      ? {}
                      : {
                          roomContextConsumption: {
                            baseContextCursor: Number(
                              roomContextConsumption.baseContextCursor
                            ),
                            ...(typeof roomContextConsumption.checkpointId ===
                              "string"
                              ? {
                                  checkpointId:
                                    roomContextConsumption.checkpointId
                                }
                              : {}),
                            rawFromSequenceExclusive: Number(
                              roomContextConsumption.rawFromSequenceExclusive
                            ),
                            rawThroughSequenceInclusive: Number(
                              roomContextConsumption.rawThroughSequenceInclusive
                            ),
                            rawMessageCount: Number(
                              roomContextConsumption.rawMessageCount
                            ),
                            coverageThroughSequence: Number(
                              roomContextConsumption.coverageThroughSequence
                            )
                          }
                        })
                  }
                }
              : {}),
            ...(runtimeClarification
              ? {
                  clarification: {
                    kind: String(runtimeClarification.kind ?? "") as "task",
                    question: String(runtimeClarification.question ?? ""),
                    ...(runtimeClarification.choices === undefined
                      ? {}
                      : {
                          choices: Array.isArray(runtimeClarification.choices)
                            ? runtimeClarification.choices as string[]
                            : [""]
                        })
                  }
                }
              : {})
          }, clock());
          app.log.info({
            event: "run.state.applied",
            traceId: applied.run.traceId,
            runId: applied.run.runId,
            agentId: applied.run.targetAgentId,
            state: applied.run.state,
            sequence: message.payload.sequence,
            applied: applied.applied
          }, "Run state event processed");
          if (
            applied.applied &&
            new Set(["completed", "failed", "canceled", "outcome_unknown"])
              .has(applied.run.state)
          ) {
            void advanceDiscussion(applied.run.runId)
              .then(() => teamChanges.notify(devicePrincipal.teamId, {
                kind: "room", roomId: applied.run.roomId
              }))
              .catch((error: unknown) => {
                app.log.error(error, "Discussion advancement failed");
              });
          } else if (applied.applied && applied.run.state === "input_required") {
            void pauseDiscussionForInput(applied.run.runId)
              .then(() => teamChanges.notify(devicePrincipal.teamId, {
                kind: "room", roomId: applied.run.roomId
              }))
              .catch((error: unknown) => {
                app.log.error(error, "Discussion input-required transition failed");
              });
          }
          return;
        }
        if (message.type === "run.reply" && registeredEpoch !== undefined) {
          if (
            typeof message.payload.runId !== "string" ||
            typeof message.payload.agentId !== "string" ||
            !Number.isSafeInteger(message.payload.sequence) ||
            typeof message.payload.content !== "string"
          ) {
            rejectMessage("run_reply_rejected");
            return;
          }
          if (!isBridgeTraceId(message.payload.traceId)) {
            rejectMessage("invalid_trace_id");
            return;
          }
          const applied = bridgeRunEvents.applyReply(devicePrincipal, {
            runId: message.payload.runId,
            traceId: message.payload.traceId,
            agentId: message.payload.agentId,
            sequence: message.payload.sequence as number,
            content: message.payload.content,
            ...(message.payload.assessment === undefined
              ? {}
              : { assessment: message.payload.assessment })
          }, clock());
          app.log.info({
            event: "run.reply.applied",
            traceId: applied.run.traceId,
            runId: applied.run.runId,
            agentId: applied.run.targetAgentId,
            sequence: message.payload.sequence,
            applied: applied.applied
          }, "Run reply event processed");
          if (applied.applied) {
            void routeAgentReplyMentions(applied.run.runId)
              .then(() => teamChanges.notify(devicePrincipal.teamId, {
                kind: "room", roomId: applied.run.roomId
              }))
              .catch((error: unknown) => {
                app.log.error(error, "Agent reply mention routing failed");
              });
          }
          return;
        }
        if (message.type === "run.activity" && registeredEpoch !== undefined) {
          if (
            typeof message.payload.runId !== "string" ||
            typeof message.payload.agentId !== "string" ||
            !Number.isSafeInteger(message.payload.sequence) ||
            typeof message.payload.activityId !== "string" ||
            typeof message.payload.kind !== "string" ||
            typeof message.payload.phase !== "string" ||
            (message.payload.label !== undefined &&
              typeof message.payload.label !== "string") ||
            (message.payload.content !== undefined &&
              typeof message.payload.content !== "string") ||
            (message.payload.reset !== undefined &&
              typeof message.payload.reset !== "boolean")
          ) {
            rejectMessage("run_activity_rejected");
            return;
          }
          if (!isBridgeTraceId(message.payload.traceId)) {
            rejectMessage("invalid_trace_id");
            return;
          }
          const applied = bridgeRunEvents.applyActivity(devicePrincipal, {
            runId: message.payload.runId,
            traceId: message.payload.traceId,
            agentId: message.payload.agentId,
            sequence: message.payload.sequence as number,
            activityId: message.payload.activityId,
            kind: message.payload.kind as "reasoning" | "tool",
            phase: message.payload.phase as
              "started" | "updated" | "completed" | "failed",
            ...(typeof message.payload.label === "string"
              ? { label: message.payload.label }
              : {}),
            ...(typeof message.payload.content === "string"
              ? { content: message.payload.content }
              : {}),
            ...(message.payload.reset === true ? { reset: true } : {})
          }, clock());
          app.log.info({
            event: "run.activity.applied",
            traceId: applied.run.traceId,
            runId: applied.run.runId,
            agentId: applied.run.targetAgentId,
            sequence: message.payload.sequence,
            applied: applied.applied
          }, "Run activity event processed");
          return;
        }
        if (message.type === "run.output_delta" && registeredEpoch !== undefined) {
          if (
            typeof message.payload.runId !== "string" ||
            typeof message.payload.agentId !== "string" ||
            !Number.isSafeInteger(message.payload.sequence) ||
            typeof message.payload.content !== "string" ||
            (message.payload.reset !== undefined &&
              typeof message.payload.reset !== "boolean")
          ) {
            rejectMessage("run_output_rejected");
            return;
          }
          if (!isBridgeTraceId(message.payload.traceId)) {
            rejectMessage("invalid_trace_id");
            return;
          }
          const applied = bridgeRunEvents.applyOutput(devicePrincipal, {
            runId: message.payload.runId,
            traceId: message.payload.traceId,
            agentId: message.payload.agentId,
            sequence: message.payload.sequence as number,
            content: message.payload.content,
            ...(message.payload.reset === true ? { reset: true } : {})
          }, clock());
          app.log.info({
            event: "run.output.applied",
            traceId: applied.run.traceId,
            runId: applied.run.runId,
            agentId: applied.run.targetAgentId,
            sequence: message.payload.sequence,
            applied: applied.applied
          }, "Run output event processed");
          return;
        }
        rejectMessage("hello_required");
      } catch {
        const category: BridgeRejectionCategory = message.type === "run.accepted"
          ? "run_acceptance_rejected"
          : message.type === "run.status"
            ? "run_status_rejected"
            : message.type === "run.activity"
              ? "run_activity_rejected"
            : message.type === "run.output_delta"
              ? "run_output_rejected"
            : message.type === "run.reply"
              ? "run_reply_rejected"
              : message.type === "agent.provision.result"
                ? "agent_provision_result_rejected"
              : message.type === "agent.status"
                ? "agent_status_rejected"
              : message.type === "agent.publish"
                ? "agent_publication_rejected"
                : "invalid_envelope";
        failMessage(category);
      }
    });
    socket.on("close", () => {
      bridgeConnections.remove(devicePrincipal.deviceId, socket);
      teamChanges.notify(devicePrincipal.teamId);
      app.log.info({
        event: "bridge.connection.closed",
        deviceId: devicePrincipal.deviceId,
        connectionEpoch: registeredEpoch ?? null
      }, "Bridge connection closed");
    });
  });
}
