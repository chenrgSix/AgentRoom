import type { BridgeRunEventService } from "../run/bridge-run-event-service.js";
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
  | "invalid_trace_id"
  | "run_acceptance_rejected"
  | "run_status_rejected"
  | "run_activity_rejected"
  | "run_output_rejected"
  | "run_reply_rejected"
  | "hello_required";

const bridgeTraceIdPattern = /^trace_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const bridgeLogIdentifierPattern =
  /^(?:agent|run)_[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const bridgeLogMessageTypes = new Set([
  "bridge.hello",
  "bridge.heartbeat",
  "agent.publish",
  "run.accepted",
  "run.status",
  "run.activity",
  "run.output_delta",
  "run.reply"
]);

function isBridgeTraceId(value: unknown): value is string {
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

export function registerBridgeSocketRoutes({
  advanceDiscussion,
  agents,
  app,
  auth,
  bridgeConnections,
  bridgeRunEvents,
  clock,
  delivery,
  pauseDiscussionForInput,
  presence,
  requireBridgeServerToken,
  routeAgentReplyMentions,
  teamChanges
}: ServerRouteContext): void {
  app.get("/ws/bridge", {
    websocket: true,
    preValidation: async (request) => {
      requireBridgeServerToken(request);
      auth.authenticateDevice(bearerToken(request), clock());
    }
  }, (socket, request) => {
    const devicePrincipal = auth.authenticateDevice(bearerToken(request), clock());
    let registeredEpoch: number | undefined;
    socket.on("message", (source: { toString(): string }) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(source.toString()) as unknown;
      } catch {
        app.log.warn({
          event: "bridge.message.malformed",
          deviceId: devicePrincipal.deviceId,
          connectionEpoch: registeredEpoch ?? null
        }, "Malformed Bridge message");
        socket.close(4_007, "Malformed Bridge message");
        return;
      }
      const message = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as BridgeMessageEnvelope
        : undefined;
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
          const supported = message.payload.supportedProtocolVersions;
          if (
            deviceId !== devicePrincipal.deviceId ||
            !Number.isSafeInteger(epoch) ||
            (epoch as number) < 1 ||
            !Array.isArray(supported) ||
            !supported.includes("1.0")
          ) {
            rejectMessage("invalid_hello");
            return;
          }
          if (!bridgeConnections.register(devicePrincipal.deviceId, epoch as number, socket)) {
            socket.close(4_009, "Stale Bridge connection epoch");
            return;
          }
          registeredEpoch = epoch as number;
          app.log.info({
            event: "bridge.connection.registered",
            deviceId: devicePrincipal.deviceId,
            connectionEpoch: registeredEpoch
          }, "Bridge connection registered");
          presence.recordHeartbeat(devicePrincipal, {
            deviceId: devicePrincipal.deviceId,
            connectionEpoch: registeredEpoch,
            adapterAvailable: true,
            now: clock()
          });
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
          delivery.dispatchQueuedForDevice(devicePrincipal.deviceId);
          teamChanges.notify(devicePrincipal.teamId);
          return;
        }
        if (message.type === "agent.publish" && registeredEpoch !== undefined) {
          const capabilities = message.payload.capabilities as
            | Record<string, unknown>
            | undefined;
          if (
            message.payload.deviceId !== devicePrincipal.deviceId ||
            message.payload.teamId !== devicePrincipal.teamId ||
            message.payload.ownerMemberId !== devicePrincipal.ownerMemberId ||
            typeof message.payload.agentId !== "string" ||
            typeof message.payload.name !== "string" ||
            typeof message.payload.role !== "string" ||
            capabilities?.invocationMode !== "managed"
          ) {
            rejectMessage("agent_publication_rejected");
            return;
          }
          agents.publishDeviceAgent(devicePrincipal, {
            agentId: message.payload.agentId,
            name: message.payload.name,
            role: message.payload.role,
            ...(typeof message.payload.runtimeScopeId === "string"
              ? { runtimeScopeId: message.payload.runtimeScopeId }
              : {}),
            capabilities: {
              supportsHandoff: capabilities.supportsHandoff === true,
              supportsInterrupt: capabilities.supportsInterrupt === true,
              supportsResume: capabilities.supportsResume === true,
              supportsStart: capabilities.supportsStart === true,
              supportsStreaming: capabilities.supportsStreaming === true
            },
            now: clock()
          });
          delivery.dispatchQueuedForDevice(devicePrincipal.deviceId);
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
            clock()
          );
          app.log.info({
            event: "run.delivery.accepted",
            traceId: accepted.traceId,
            runId: accepted.runId,
            agentId: accepted.targetAgentId,
            deviceId: devicePrincipal.deviceId,
            state: accepted.state
          }, "Run delivery accepted");
          teamChanges.notify(devicePrincipal.teamId, {
            kind: "room", roomId: accepted.roomId
          });
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
          teamChanges.notify(devicePrincipal.teamId, {
            kind: "room", roomId: applied.run.roomId
          });
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
          teamChanges.notify(devicePrincipal.teamId, {
            kind: "room", roomId: applied.run.roomId
          });
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
          if (applied.applied) teamChanges.notify(devicePrincipal.teamId, {
            kind: "run", roomId: applied.run.roomId
          });
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
          if (applied.applied) {
            teamChanges.notify(devicePrincipal.teamId, {
              kind: "run", roomId: applied.run.roomId
            });
          }
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
