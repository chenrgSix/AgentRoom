import path from "node:path";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";

import { CoreRepository } from "./data/core-repository.js";
import { BridgeConnectionRegistry } from "./bridge/bridge-connection-registry.js";
import { openDatabase } from "./data/database.js";
import { prepareDatabaseDirectory } from "./data/database-location.js";
import { migrateDatabase } from "./data/migration-runner.js";
import { createOpaqueId } from "./domain/identifiers.js";
import { DiscussionOrchestrator } from "./discussion/discussion-orchestrator.js";
import { DiscussionRepository } from "./discussion/discussion-repository.js";
import type {
  DiscussionMode,
  DiscussionOutputMode,
  DiscussionPolicy
} from "./discussion/discussion-types.js";
import { createTeamMcpServer } from "./mcp/mcp-server.js";
import { TeamWaitService } from "./mcp/team-wait-service.js";
import { OperationalMetrics } from "./observability/operational-metrics.js";
import { TraceRepository } from "./observability/trace-repository.js";
import { AgentService } from "./registry/agent-service.js";
import { MemberDeviceService } from "./registry/member-device-service.js";
import { PresenceService } from "./registry/presence-service.js";
import { DeliveryService } from "./run/delivery-service.js";
import { BridgeRunEventService } from "./run/bridge-run-event-service.js";
import { CancellationService } from "./run/cancellation-service.js";
import { HandoffService } from "./run/handoff-service.js";
import { ManualRunService } from "./run/manual-run-service.js";
import { RunRepository } from "./run/run-repository.js";
import { RunService } from "./run/run-service.js";
import { FakeRuntimeAdapter } from "./runtime/fake-runtime-adapter.js";
import { InProcessRunExecutor } from "./runtime/in-process-run-executor.js";
import {
  AuthService,
  AuthorizationError,
  type IssuedCredential,
  type WebPrincipal
} from "./security/auth-service.js";
import {
  AnonymousRateLimiter,
  AnonymousRateLimitError
} from "./security/anonymous-rate-limiter.js";
import { BridgePairingService } from "./security/bridge-pairing-service.js";
import { TrustedWebAccessService } from "./security/trusted-web-access-service.js";
import type { WebAuthConfiguration } from "./security/web-auth-config.js";
import { TeamRoomService } from "./team-room/team-room-service.js";
import { MessageService } from "./team-room/message-service.js";

export interface ServerAppOptions {
  anonymousRateLimit?: {
    maximumAttempts: number;
    windowMilliseconds: number;
  };
  databasePath: string;
  clock?: () => string;
  logger?: boolean;
  loggerInstance?: FastifyBaseLogger;
  trustProxyHops?: number;
  webAuth?: WebAuthConfiguration;
  webRoot?: string;
}

const trustedSessionCookie = "__Host-agentroom_session";
const unsafeHttpMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  return /^(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/iu.test(host) ||
    /^\[::1\](?::[0-9]{1,5})?$/u.test(host);
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  for (const part of request.headers.cookie?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

function sessionCookie(credential: IssuedCredential): string {
  if (!credential.expiresAt) throw new Error("Web session expiry is required");
  return [
    `${trustedSessionCookie}=${credential.secret}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Expires=${new Date(credential.expiresAt).toUTCString()}`
  ].join("; ");
}

function clearSessionCookie(): string {
  return [
    `${trustedSessionCookie}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0"
  ].join("; ");
}

function noStore(reply: FastifyReply): void {
  void reply.header("cache-control", "no-store");
}

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
    throw new Error("Request body must be a JSON object");
  }
  return request.body as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  maximum = 80
): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) {
    throw new AuthorizationError("UNAUTHENTICATED", "Bearer session required");
  }
  return authorization.slice(7);
}

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

export async function createServerApp(
  options: ServerAppOptions
): Promise<FastifyInstance> {
  await prepareDatabaseDirectory(options.databasePath);
  await migrateDatabase(options.databasePath);
  const database = openDatabase(options.databasePath);
  const core = new CoreRepository(database);
  const auth = new AuthService(database);
  const webAuth = options.webAuth ?? { mode: "local" as const };
  const trustedWeb = webAuth.mode === "trusted-team"
    ? new TrustedWebAccessService(
        database,
        core,
        auth,
        webAuth.publicOrigin,
        webAuth.ownerRecoveryToken
      )
    : undefined;
  const anonymousRateLimit = new AnonymousRateLimiter(
    options.anonymousRateLimit?.maximumAttempts,
    options.anonymousRateLimit?.windowMilliseconds
  );
  const teamRooms = new TeamRoomService(core, auth);
  const registry = new MemberDeviceService(core, auth);
  const agents = new AgentService(core, auth);
  const presence = new PresenceService(core, auth);
  const messages = new MessageService(core, auth);
  const teamWait = new TeamWaitService(core, auth);
  const pairing = new BridgePairingService(database, core, auth);
  const clock = options.clock ?? (() => new Date().toISOString());
  const runRepository = new RunRepository(database);
  const traces = new TraceRepository(database);
  const runs = new RunService(core, runRepository, auth);
  const executor = new InProcessRunExecutor(core, runRepository, clock);
  const fakeAdapters = new Map<string, FakeRuntimeAdapter>();
  const bridgeConnections = new BridgeConnectionRegistry();
  const operationalMetrics = new OperationalMetrics(
    database, bridgeConnections, clock
  );
  const delivery = new DeliveryService(
    database,
    core,
    runRepository,
    bridgeConnections,
    clock
  );
  const bridgeRunEvents = new BridgeRunEventService(core, runRepository);
  const handoffs = new HandoffService(core, runRepository);
  const cancellations = new CancellationService(
    core, runRepository, auth, bridgeConnections, clock
  );
  const discussionRepository = new DiscussionRepository(database);
  const discussions = new DiscussionOrchestrator(
    core,
    messages,
    discussionRepository,
    runRepository,
    auth,
    clock
  );
  let discussionSweepTimer: ReturnType<typeof setInterval> | undefined;
  let discussionSweepInFlight = false;
  const dispatchDiscussionRun = async (run: ReturnType<RunRepository["getRun"]>) => {
    if (!run) return;
    const agent = core.getAgent(run.targetAgentId);
    const adapter = fakeAdapters.get(run.targetAgentId);
    if (adapter) {
      const turn = discussionRepository.findTurnByRun(run.runId);
      adapter.enqueue({
        expectedInstruction: run.instruction,
        events: [
          { type: "status", sequence: 1, status: "working" },
          {
            type: "reply",
            sequence: 2,
            content: turn?.kind === "finalization"
              ? `${agent?.name ?? "Agent"} 结论：保留已形成的共识，并明确记录未决问题。`
              : `${agent?.name ?? "Agent"}：建议核对证据、风险和未决问题。`
          },
          { type: "status", sequence: 3, status: "completed" }
        ]
      });
      const completed = await executor.execute(run.runId, adapter);
      if (completed.state === "input_required") {
        await pauseDiscussionForInput(completed.runId);
      } else {
        await advanceDiscussion(completed.runId);
      }
      return;
    }
    if (agent?.integrationMode === "managed") {
      const dispatched = delivery.dispatch(run.runId);
      app.log.info({
        event: "run.delivery.dispatched",
        traceId: run.traceId,
        runId: run.runId,
        agentId: run.targetAgentId,
        deviceId: dispatched?.deviceId ?? null,
        sendCount: dispatched?.sendCount ?? 0,
        sent: (dispatched?.sendCount ?? 0) > 0
      }, "Managed Run delivery processed");
    }
  };
  const dispatchDiscussionRuns = async (
    runs: NonNullable<ReturnType<RunRepository["getRun"]>>[]
  ): Promise<void> => {
    await Promise.all(runs.map((run) => dispatchDiscussionRun(run)));
  };
  const advanceDiscussion = async (runId: string): Promise<void> => {
    const result = discussions.onRunTerminal(runId);
    if (result?.scheduledRuns.length) {
      await dispatchDiscussionRuns(result.scheduledRuns);
    }
  };
  const pauseDiscussionForInput = async (runId: string): Promise<void> => {
    const result = discussions.onRunInputRequired(runId);
    if (result?.scheduledRuns.length) {
      await dispatchDiscussionRuns(result.scheduledRuns);
    }
  };
  const sweepDiscussionDeadlines = async (): Promise<void> => {
    if (discussionSweepInFlight) return;
    discussionSweepInFlight = true;
    try {
      await dispatchDiscussionRuns(discussions.expireDueWaves());
    } finally {
      discussionSweepInFlight = false;
    }
  };
  const manualRuns = new ManualRunService(
    core,
    runRepository,
    messages,
    (run) => {
      void advanceDiscussion(run.runId);
    }
  );
  const app = Fastify({
    ...(options.loggerInstance
      ? { loggerInstance: options.loggerInstance }
      : { logger: options.logger ?? false }),
    logController: new LogController({ disableRequestLogging: true }),
    ...(options.trustProxyHops === undefined
      ? {}
      : {
          trustProxy: (_address: string, hop: number) =>
            hop < options.trustProxyHops!
        })
  });
  const requestStartedAt = new WeakMap<FastifyRequest, bigint>();
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 1024 }
  });
  const requireTrustedOrigin = (request: FastifyRequest): void => {
    if (
      webAuth.mode !== "trusted-team" ||
      request.headers.origin !== webAuth.publicOrigin
    ) {
      throw new AuthorizationError("FORBIDDEN", "Trusted Web origin required");
    }
  };
  const principal = (request: FastifyRequest): WebPrincipal => {
    if (webAuth.mode === "local") {
      return auth.authenticateWebSession(bearerToken(request), clock());
    }
    const token = cookieValue(request, trustedSessionCookie);
    if (!token) {
      throw new AuthorizationError("UNAUTHENTICATED", "Web session required");
    }
    if (unsafeHttpMethods.has(request.method)) requireTrustedOrigin(request);
    return auth.authenticateWebSession(token, clock());
  };
  const optionalPrincipal = (request: FastifyRequest): WebPrincipal | undefined => {
    try {
      return principal(request);
    } catch (error) {
      if (error instanceof AuthorizationError) return undefined;
      throw error;
    }
  };
  const limitAnonymous = (request: FastifyRequest, bucket: string): void => {
    const timestamp = Date.parse(clock());
    anonymousRateLimit.consume(
      `${bucket}:${request.ip}`,
      Number.isFinite(timestamp) ? timestamp : Date.now()
    );
  };

  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, process.hrtime.bigint());
    if (webAuth.mode === "local" && !isLoopbackHost(request.headers.host)) {
      throw new AuthorizationError(
        "FORBIDDEN",
        "Local Web access requires a loopback Host"
      );
    }
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request);
    const durationMs = startedAt === undefined
      ? 0
      : Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    operationalMetrics.recordHttpRequest(request.method, reply.statusCode);
    app.log.info({
      event: "http.request.completed",
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      statusCode: reply.statusCode,
      durationMs: Number(durationMs.toFixed(3))
    }, "HTTP request completed");
  });

  app.addHook("onClose", (_instance, done) => {
    if (discussionSweepTimer) clearInterval(discussionSweepTimer);
    database.close();
    done();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AnonymousRateLimitError) {
      app.log.warn({
        event: "http.request.rate_limited",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode: 429
      }, "Anonymous request rate limited");
      void reply.code(429).send({
        error: { code: "RATE_LIMITED", message: error.message }
      });
      return;
    }
    if (error instanceof AuthorizationError) {
      const statusCode = error.code === "UNAUTHENTICATED" ? 401 : 403;
      app.log.warn({
        event: "http.request.rejected",
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        statusCode,
        errorCode: error.code
      }, "HTTP request rejected");
      void reply.code(statusCode).send({
        error: { code: error.code, message: error.message }
      });
      return;
    }
    const message = error instanceof Error ? error.message : "Unexpected error";
    const statusCode = message.includes("UNIQUE constraint failed") ||
      message.startsWith("Room already has an active Discussion:")
      ? 409
      : 400;
    app.log.warn({
      event: "http.request.rejected",
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      statusCode,
      errorCode: statusCode === 409 ? "CONFLICT" : "INVALID_REQUEST"
    }, "HTTP request rejected");
    void reply.code(statusCode).send({
      error: {
        code: statusCode === 409 ? "CONFLICT" : "INVALID_REQUEST",
        message
      }
    });
  });

  app.get("/api/health/live", async () => ({
    status: "alive",
    uptimeSeconds: Math.floor(process.uptime())
  }));
  app.get("/api/health/ready", async (_request, reply) => {
    const ready = operationalMetrics.databaseReady();
    if (!ready) void reply.code(503);
    return { status: ready ? "ready" : "unavailable" };
  });
  app.get("/api/health", async () => {
    const databaseReady = operationalMetrics.databaseReady();
    const snapshot = databaseReady ? operationalMetrics.snapshot() : null;
    const bridgeConfigured = (snapshot?.managedAgents ?? 0) > 0;
    const bridgeReady = (snapshot?.activeBridgeConnections ?? 0) > 0;
    return {
      status: !databaseReady
        ? "unavailable"
        : bridgeConfigured && !bridgeReady ? "degraded" : "ready",
      checks: {
        database: databaseReady ? "ready" : "unavailable",
        bridge: !bridgeConfigured
          ? "not_configured"
          : bridgeReady ? "ready" : "degraded"
      }
    };
  });
  app.get("/api/metrics", async (_request, reply) => {
    void reply.type("text/plain; version=0.0.4; charset=utf-8");
    return operationalMetrics.renderPrometheus();
  });
  app.get("/ws/bridge", {
    websocket: true,
    preValidation: async (request) => {
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
          return;
        }
        if (message.type === "run.status" && registeredEpoch !== undefined) {
          const error = message.payload.error;
          if (
            typeof message.payload.runId !== "string" ||
            typeof message.payload.agentId !== "string" ||
            !Number.isSafeInteger(message.payload.sequence) ||
            typeof message.payload.status !== "string" ||
            (error !== undefined && (typeof error !== "object" || error === null))
          ) {
            rejectMessage("run_status_rejected");
            return;
          }
          if (!isBridgeTraceId(message.payload.traceId)) {
            rejectMessage("invalid_trace_id");
            return;
          }
          const runtimeError = error as Record<string, unknown> | undefined;
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
                    retryable: runtimeError.retryable === true
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
            void advanceDiscussion(applied.run.runId).catch((error: unknown) => {
              app.log.error(error, "Discussion advancement failed");
            });
          } else if (applied.applied && applied.run.state === "input_required") {
            void pauseDiscussionForInput(applied.run.runId).catch((error: unknown) => {
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
          return;
        }
        rejectMessage("hello_required");
      } catch {
        const category: BridgeRejectionCategory = message.type === "run.accepted"
          ? "run_acceptance_rejected"
          : message.type === "run.status"
            ? "run_status_rejected"
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
      app.log.info({
        event: "bridge.connection.closed",
        deviceId: devicePrincipal.deviceId,
        connectionEpoch: registeredEpoch ?? null
      }, "Bridge connection closed");
    });
  });
  app.get("/api/auth/status", async (request, reply) => {
    noStore(reply);
    const actor = optionalPrincipal(request);
    const user = actor ? core.getUser(actor.userId) : undefined;
    if (actor && user) {
      return {
        mode: webAuth.mode,
        state: "authenticated",
        user,
        session: { expiresAt: auth.getWebSessionExpiresAt(actor.sessionId) }
      };
    }
    return {
      mode: webAuth.mode,
      state: trustedWeb?.status() ?? "local_bootstrap"
    };
  });
  app.get("/api/auth/session", async (request, reply) => {
    noStore(reply);
    const actor = principal(request);
    const user = core.getUser(actor.userId);
    if (!user) {
      throw new AuthorizationError("UNAUTHENTICATED", "Session User not found");
    }
    return {
      user,
      session: { expiresAt: auth.getWebSessionExpiresAt(actor.sessionId) }
    };
  });
  app.delete("/api/auth/session", async (request, reply) => {
    noStore(reply);
    const actor = principal(request);
    auth.revokeWebSession(actor.sessionId, clock());
    if (webAuth.mode === "trusted-team") {
      void reply.header("set-cookie", clearSessionCookie());
    }
    return { status: "signed_out" };
  });

  if (trustedWeb) {
    const recoveryToken = (request: FastifyRequest): string =>
      requiredString(
        request.headers["x-agent-room-recovery-token"],
        "x-agent-room-recovery-token",
        512
      );
    const establishSession = (
      reply: FastifyReply,
      result: ReturnType<TrustedWebAccessService["recover"]>
    ) => {
      noStore(reply);
      void reply.header("set-cookie", sessionCookie(result.session));
      return {
        user: result.user,
        session: { expiresAt: result.session.expiresAt }
      };
    };
    app.post("/api/auth/setup", async (request, reply) => {
      limitAnonymous(request, "web-setup");
      requireTrustedOrigin(request);
      const body = bodyObject(request);
      return establishSession(reply, trustedWeb.setup(
        recoveryToken(request),
        requiredString(body.displayName, "displayName"),
        clock()
      ));
    });
    app.post("/api/auth/recover-owner", async (request, reply) => {
      limitAnonymous(request, "web-recover");
      requireTrustedOrigin(request);
      return establishSession(
        reply,
        trustedWeb.recover(recoveryToken(request), clock())
      );
    });
    app.post("/api/auth/member-invitations/claim", async (request, reply) => {
      limitAnonymous(request, "member-invitation-claim");
      requireTrustedOrigin(request);
      const body = bodyObject(request);
      const result = trustedWeb.claimMemberInvitation(
        requiredString(body.token, "token", 128),
        clock()
      );
      noStore(reply);
      void reply.header("set-cookie", sessionCookie(result.session));
      return {
        member: result.member,
        user: result.user,
        session: { expiresAt: result.session.expiresAt }
      };
    });
  } else {
    app.post("/api/bootstrap", async (request) => {
      const body = bodyObject(request);
      const displayName = requiredString(body.displayName, "displayName");
      const requestedUserId = body.userId;
      const userId = requestedUserId === undefined
        ? createOpaqueId("user")
        : requiredString(requestedUserId, "userId", 140);
      if (!/^user_[A-Za-z0-9_-]{8,128}$/u.test(userId)) {
        throw new Error("userId is not a valid opaque User identifier");
      }
      const now = clock();
      core.ensureUser({ userId, displayName: displayName.trim(), createdAt: now });
      const expiresAt = new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000)
        .toISOString();
      const session = auth.issueWebSession(userId, now, expiresAt);
      return {
        user: core.getUser(userId),
        session: { token: session.secret, expiresAt }
      };
    });
  }

  app.get("/api/teams", async (request) =>
    teamRooms.listTeams(principal(request))
  );
  app.post("/api/teams", async (request) => {
    const actor = principal(request);
    const user = core.getUser(actor.userId);
    if (!user) {
      throw new AuthorizationError("UNAUTHENTICATED", "Session User not found");
    }
    const body = bodyObject(request);
    return teamRooms.createTeamForUser({
      userId: actor.userId,
      userDisplayName: user.displayName,
      teamName: requiredString(body.name, "name"),
      now: clock()
    });
  });
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/rooms",
    async (request) => teamRooms.listRooms(principal(request), request.params.teamId)
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/rooms",
    async (request) => {
      const body = bodyObject(request);
      return teamRooms.createRoom(
        principal(request),
        request.params.teamId,
        requiredString(body.name, "name"),
        clock()
      );
    }
  );
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/devices",
    async (request) => registry.listDevices(principal(request), request.params.teamId)
  );
  app.delete<{ Params: { teamId: string; deviceId: string } }>(
    "/api/teams/:teamId/devices/:deviceId",
    async (request) => {
      const device = registry.revokeDevice(
        principal(request),
        request.params.teamId,
        request.params.deviceId,
        clock()
      );
      bridgeConnections.revoke(device.deviceId);
      return device;
    }
  );
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/members",
    async (request) => registry.listMembers(principal(request), request.params.teamId)
  );
  if (trustedWeb) {
    app.post<{ Params: { teamId: string } }>(
      "/api/teams/:teamId/member-invitations",
      async (request, reply) => {
        const body = bodyObject(request);
        const invitation = trustedWeb.createMemberInvitation(
          principal(request),
          request.params.teamId,
          requiredString(body.displayName, "displayName"),
          clock()
        );
        noStore(reply);
        return invitation;
      }
    );
  } else {
    app.post<{ Params: { teamId: string } }>(
      "/api/teams/:teamId/members",
      async (request) => {
        const body = bodyObject(request);
        return registry.addMember(principal(request), {
          teamId: request.params.teamId,
          userId: requiredString(body.userId, "userId", 140),
          displayName: requiredString(body.displayName, "displayName"),
          now: clock()
        });
      }
    );
  }
  app.get<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/agents",
    async (request) => presence.listAgents(
      principal(request),
      request.params.teamId,
      clock()
    )
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/fake-agents",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const now = clock();
      const name = requiredString(body.name, "name");
      const device = registry.registerOwnDevice(
        actor,
        request.params.teamId,
        `${name} Fake Bridge`,
        now
      );
      const agent = agents.publishAgent(actor, {
        teamId: request.params.teamId,
        deviceId: device.deviceId,
        name,
        role: requiredString(body.role, "role"),
        integrationMode: "fake",
        capabilities: {
          supportsHandoff: true,
          supportsInterrupt: true,
          supportsResume: false,
          supportsStart: true,
          supportsStreaming: true
        },
        now
      });
      const credential = auth.issueDeviceCredential(device.deviceId, now);
      const devicePrincipal = auth.authenticateDevice(credential.secret, now);
      presence.recordHeartbeat(devicePrincipal, {
        deviceId: device.deviceId,
        connectionEpoch: 1,
        adapterAvailable: true,
        now
      });
      fakeAdapters.set(agent.agentId, new FakeRuntimeAdapter());
      return core.getAgent(agent.agentId);
    }
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/manual-agents",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const now = clock();
      const agent = agents.publishAgent(actor, {
        teamId: request.params.teamId,
        deviceId: null,
        name: requiredString(body.name, "name"),
        role: requiredString(body.role, "role"),
        integrationMode: "manual",
        capabilities: {
          supportsHandoff: true,
          supportsInterrupt: false,
          supportsResume: false,
          supportsStart: false,
          supportsStreaming: false
        },
        now
      });
      const expiresAt = new Date(
        Date.parse(now) + 90 * 24 * 60 * 60 * 1000
      ).toISOString();
      const credential = auth.issueMcpCredential(
        actor,
        agent.agentId,
        now,
        expiresAt
      );
      return {
        agent,
        credential: { token: credential.secret, expiresAt }
      };
    }
  );
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/bridge-invites",
    async (request) => {
      const body = bodyObject(request);
      return pairing.createInvite(
        principal(request),
        request.params.teamId,
        requiredString(body.deviceName, "deviceName"),
        clock()
      );
    }
  );
  app.post("/api/bridge/join-requests", async (request) => {
    limitAnonymous(request, "bridge-join-request");
    const body = bodyObject(request);
    return pairing.createJoinRequest({
      deviceName: requiredString(body.deviceName, "deviceName"),
      agentName: requiredString(body.agentName, "agentName"),
      agentRole: requiredString(body.agentRole, "agentRole")
    }, clock());
  });
  app.post<{ Params: { teamId: string } }>(
    "/api/teams/:teamId/bridge-join-requests/approve",
    async (request) => {
      const body = bodyObject(request);
      return pairing.approveJoinRequest(
        principal(request),
        request.params.teamId,
        requiredString(body.code, "code", 20),
        clock()
      );
    }
  );
  app.post<{ Params: { joinRequestId: string } }>(
    "/api/bridge/join-requests/:joinRequestId/claim",
    async (request, reply) => {
      const body = bodyObject(request);
      const result = pairing.claimJoinRequest(
        request.params.joinRequestId,
        requiredString(body.pollToken, "pollToken", 128),
        clock()
      );
      if (result.status === "pending") {
        void reply.code(202);
        return result;
      }
      return {
        status: result.status,
        device: result.device,
        credential: {
          token: result.credential.secret,
          expiresAt: result.credential.expiresAt
        }
      };
    }
  );
  app.post("/api/bridge/pair", async (request) => {
    limitAnonymous(request, "bridge-pair");
    const body = bodyObject(request);
    const result = pairing.exchange(
      requiredString(body.code, "code", 128),
      requiredString(body.deviceName, "deviceName"),
      clock()
    );
    return {
      device: result.device,
      credential: {
        token: result.credential.secret,
        expiresAt: result.credential.expiresAt
      }
    };
  });
  app.get<{
    Params: { roomId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/api/rooms/:roomId/messages", async (request) => {
    const parsedLimit = request.query.limit === undefined
      ? 100
      : Number.parseInt(request.query.limit, 10);
    return messages.listMessages(principal(request), {
      roomId: request.params.roomId,
      limit: parsedLimit,
      ...(request.query.cursor ? { cursor: request.query.cursor } : {})
    });
  });
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/messages",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const mentionAgentId = body.mentionAgentId === undefined
        ? undefined
        : requiredString(body.mentionAgentId, "mentionAgentId", 140);
      const target = mentionAgentId ? core.getAgent(mentionAgentId) : undefined;
      const message = messages.createMemberMessage(actor, {
        roomId: request.params.roomId,
        content: requiredString(body.content, "content", 20_000),
        ...(mentionAgentId
          ? {
              mentions: [{
                targetType: "agent" as const,
                targetAgentId: mentionAgentId,
                displayLabel: target
                  ? `${target.name} / ${target.role}`
                  : mentionAgentId
              }]
            }
          : {}),
        now: clock()
      });
      const createdRuns = runs.createRunsForMessage(actor, message.messageId, clock());
      const executedRuns = [];
      for (const run of createdRuns) {
        const adapter = fakeAdapters.get(run.targetAgentId);
        if (!adapter) {
          const dispatched = delivery.dispatch(run.runId);
          app.log.info({
            event: "run.delivery.dispatched",
            traceId: run.traceId,
            runId: run.runId,
            agentId: run.targetAgentId,
            deviceId: dispatched?.deviceId ?? null,
            sendCount: dispatched?.sendCount ?? 0,
            sent: (dispatched?.sendCount ?? 0) > 0
          }, "Managed Run delivery processed");
          executedRuns.push(runRepository.getRun(run.runId) ?? run);
          continue;
        }
        adapter.enqueue({
          expectedInstruction: message.content,
          events: [
            { type: "status", sequence: 1, status: "working" },
            {
              type: "reply",
              sequence: 2,
              content: `${target?.name ?? "Agent"} completed: ${message.content}`
            },
            { type: "status", sequence: 3, status: "completed" }
          ]
        });
        executedRuns.push(await executor.execute(run.runId, adapter));
      }
      return {
        message,
        runs: executedRuns
      };
    }
  );
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/discussions",
    async (request) => discussions.list(principal(request), request.params.roomId)
  );
  app.post<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/discussions",
    async (request) => {
      const body = bodyObject(request);
      if (
        !Array.isArray(body.participantAgentIds) ||
        !body.participantAgentIds.every((value) => typeof value === "string")
      ) {
        throw new Error("participantAgentIds must be an array of Agent IDs");
      }
      const rawPolicy = body.policy;
      if (
        rawPolicy !== undefined &&
        (!rawPolicy || typeof rawPolicy !== "object" || Array.isArray(rawPolicy))
      ) {
        throw new Error("policy must be a JSON object");
      }
      const result = discussions.create(principal(request), {
        roomId: request.params.roomId,
        goal: requiredString(body.goal, "goal", 20_000),
        participantAgentIds: body.participantAgentIds,
        ...(body.mode === undefined
          ? {}
          : { mode: body.mode as DiscussionMode }),
        ...(body.outputMode === undefined
          ? {}
          : { outputMode: body.outputMode as DiscussionOutputMode }),
        ...(rawPolicy === undefined
          ? {}
          : { policy: rawPolicy as Partial<DiscussionPolicy> })
      });
      if (result.scheduledRuns.length) {
        await dispatchDiscussionRuns(result.scheduledRuns);
      }
      return discussions.get(principal(request), result.discussion.discussionId);
    }
  );
  app.get<{ Params: { discussionId: string } }>(
    "/api/discussions/:discussionId",
    async (request) => discussions.get(
      principal(request),
      request.params.discussionId
    )
  );
  app.post<{ Params: { discussionId: string } }>(
    "/api/discussions/:discussionId/actions",
    async (request) => {
      const actor = principal(request);
      const body = bodyObject(request);
      const action = requiredString(body.action, "action", 40);
      if (!new Set([
        "finish", "stop_after_turn", "pause", "cancel", "continue",
        "adjust_goal"
      ]).has(action)) {
        throw new Error("Unsupported Discussion action");
      }
      const result = discussions.control(
        actor,
        request.params.discussionId,
        {
          action: action as Parameters<DiscussionOrchestrator["control"]>[2]["action"],
          ...(body.goal === undefined
            ? {}
            : { goal: requiredString(body.goal, "goal", 20_000) }),
          ...(body.extensionTurns === undefined
            ? {}
            : { extensionTurns: Number(body.extensionTurns) })
        }
      );
      const cancelWarnings: string[] = [];
      for (const cancelRunId of result.cancelRunIds) {
        try {
          const canceledRun = cancellations.cancel(
            actor,
            cancelRunId,
            "Discussion stopped immediately"
          );
          if (new Set([
            "completed", "failed", "canceled", "expired", "outcome_unknown"
          ]).has(canceledRun.state)) {
            await advanceDiscussion(canceledRun.runId);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Runtime cancel failed";
          cancelWarnings.push(`${cancelRunId}: ${message}`);
        }
      }
      if (result.scheduledRuns.length) {
        await dispatchDiscussionRuns(result.scheduledRuns);
      }
      return {
        ...discussions.get(actor, request.params.discussionId),
        cancelWarning: cancelWarnings.length > 0 ? cancelWarnings.join("; ") : null
      };
    }
  );
  app.get<{ Params: { roomId: string } }>(
    "/api/rooms/:roomId/runs",
    async (request) => runs.listRoomRuns(
      principal(request), request.params.roomId, clock()
    )
  );
  app.get<{ Params: { runId: string } }>(
    "/api/runs/:runId/events",
    async (request) => {
      const actor = principal(request);
      const run = runRepository.getRun(request.params.runId);
      if (!run) {
        throw new Error(`Run not found: ${request.params.runId}`);
      }
      runs.listRoomRuns(actor, run.roomId);
      return runRepository.listEvents(run.runId);
    }
  );
  app.get<{ Params: { traceId: string } }>(
    "/api/traces/:traceId",
    async (request) => {
      const actor = principal(request);
      const entries = traces.list(request.params.traceId);
      const roomId = entries[0]?.roomId;
      if (!roomId) {
        throw new Error(`Trace not found: ${request.params.traceId}`);
      }
      auth.requireRoomMember(actor, roomId);
      return { traceId: request.params.traceId, entries };
    }
  );
  app.post<{ Params: { runId: string } }>(
    "/api/runs/:runId/cancel",
    async (request) => {
      const body = bodyObject(request);
      return cancellations.cancel(
        principal(request),
        request.params.runId,
        typeof body.reason === "string" ? body.reason : "Canceled from Web"
      );
    }
  );

  app.post("/mcp", async (request, reply) => {
    const mcpPrincipal = auth.authenticateMcp(bearerToken(request), clock());
    const server = createTeamMcpServer(mcpPrincipal, {
      clock,
      core,
      delivery,
      handoffs,
      manualRuns,
      messages,
      wait: teamWait
    });
    const transportOptions = {
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    } as unknown as StreamableHTTPServerTransportOptions;
    const transport = new StreamableHTTPServerTransport(transportOptions);
    await server.connect(transport as unknown as Transport);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } finally {
      await transport.close();
      await server.close();
    }
  });
  app.get("/mcp", async (_request, reply) => reply.code(405).send({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed" },
    id: null
  }));
  app.delete("/mcp", async (_request, reply) => reply.code(405).send({
    jsonrpc: "2.0",
    error: { code: -32_000, message: "Method not allowed" },
    id: null
  }));

  await dispatchDiscussionRuns(discussions.recover());
  discussionSweepTimer = setInterval(() => {
    void sweepDiscussionDeadlines().catch((error: unknown) => {
      app.log.error({
        event: "discussion.wave.deadline_sweep_failed",
        error: error instanceof Error ? error.message : "Unexpected error"
      }, "Discussion Wave deadline sweep failed");
    });
  }, 1_000);
  discussionSweepTimer.unref();

  if (options.webRoot) {
    await app.register(fastifyStatic, {
      root: path.resolve(options.webRoot),
      prefix: "/"
    });
  }
  return app;
}
