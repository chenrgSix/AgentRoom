import path from "node:path";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest
} from "fastify";

import { ArtifactPublicationRepository } from
  "./artifact/artifact-publication-repository.js";
import { ArtifactDeliveryService } from
  "./artifact/artifact-delivery-service.js";
import { ArtifactPreviewService } from
  "./artifact/artifact-preview-service.js";
import { ArtifactPublicationService } from
  "./artifact/artifact-publication-service.js";
import { LocalArtifactBlobStore } from
  "./artifact/local-artifact-blob-store.js";
import { CoreRepository } from "./data/core-repository.js";
import { BridgeConnectionRegistry } from "./bridge/bridge-connection-registry.js";
import { openDatabase } from "./data/database.js";
import { prepareDatabaseDirectory } from "./data/database-location.js";
import { migrateDatabase } from "./data/migration-runner.js";
import { SqliteTransactionBoundary } from "./data/sqlite-transaction-boundary.js";
import { registerAuthRoutes } from "./http/auth-routes.js";
import { registerArtifactRoutes } from "./http/artifact-routes.js";
import { registerBridgeSocketRoutes } from "./http/bridge-socket-routes.js";
import {
  bearerToken,
  cookieValue,
  isLoopbackHost,
  trustedSessionCookie,
  unsafeHttpMethods
} from "./http/http-helpers.js";
import { registerDiscussionRoutes } from "./http/discussion-routes.js";
import { registerDevicePairingSessionRoutes } from
  "./http/device-pairing-session-routes.js";
import { registerMcpRoutes } from "./http/mcp-routes.js";
import { registerMessageRoutes } from "./http/message-routes.js";
import { registerMemoryCandidateRoutes } from "./http/memory-candidate-routes.js";
import { registerRegistryRoutes } from "./http/registry-routes.js";
import type { ServerRouteContext } from "./http/route-context.js";
import { registerRunRoutes } from "./http/run-routes.js";
import { registerResultRoutes } from "./http/result-routes.js";
import { registerSystemRoutes } from "./http/system-routes.js";
import { registerTaskRoutes } from "./http/task-routes.js";
import { registerTeamRoomRoutes } from "./http/team-room-routes.js";
import { registerWorkbenchRoutes } from "./http/workbench-routes.js";
import { DiscussionOrchestrator } from "./discussion/discussion-orchestrator.js";
import { DiscussionRepository } from "./discussion/discussion-repository.js";
import { TeamWaitService } from "./mcp/team-wait-service.js";
import { ManualTaskWorkService } from
  "./mcp/manual-task-work-service.js";
import { OperationalMetrics } from "./observability/operational-metrics.js";
import { TraceRepository } from "./observability/trace-repository.js";
import { AgentService } from "./registry/agent-service.js";
import { AgentProvisioningService } from
  "./registry/agent-provisioning-service.js";
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
import { AuthService, AuthorizationError, type WebPrincipal } from "./security/auth-service.js";
import {
  AnonymousRateLimiter,
  AnonymousRateLimitError
} from "./security/anonymous-rate-limiter.js";
import { BridgePairingService } from "./security/bridge-pairing-service.js";
import { DevicePairingSessionService } from
  "./security/device-pairing-session-service.js";
import {
  assertBridgeServerToken,
  bridgeServerTokenHeader,
  normalizeBridgeServerToken
} from "./security/bridge-server-token.js";
import { TrustedWebAccessService } from "./security/trusted-web-access-service.js";
import type { WebAuthConfiguration } from "./security/web-auth-config.js";
import { TeamRoomService } from "./team-room/team-room-service.js";
import { TeamChangeService } from "./team-room/team-change-service.js";
import { MessageService } from "./team-room/message-service.js";
import { AgentTaskService } from "./task/agent-task-service.js";
import { ArtifactContentBindingService } from
  "./task/artifact-content-binding-service.js";
import { ArtifactRepository } from "./task/artifact-repository.js";
import { ContextPlanner } from "./task/context-planner.js";
import { LongTermMemoryService } from "./task/long-term-memory-service.js";
import { MemoryEntryRepository } from "./task/memory-entry-repository.js";
import { ResultRepository } from "./task/result-repository.js";
import { ResultService } from "./task/result-service.js";
import { WorkbenchService } from "./task/workbench-service.js";
import {
  ResultEvidenceConsumptionRepository
} from "./task/result-evidence-consumption-repository.js";
import { ClarificationRepository } from "./task/clarification-repository.js";
import { TaskArtifactService } from "./task/task-artifact-service.js";
import { TaskClarificationService } from "./task/task-clarification-service.js";
import { AgentTaskRepository } from "./task/task-repository.js";
import {
  MemoryReducerScheduler
} from "./memory/memory-reducer-scheduler.js";
import type {
  MemoryReducerRunner
} from "./memory/memory-reducer-runner.js";
import {
  RollingRoomMemoryRepository
} from "./memory/rolling-room-memory-repository.js";
import { MemoryCandidateService } from "./memory/memory-candidate-service.js";
import { WorkspaceLeaseRepository } from
  "./workspace/workspace-lease-repository.js";
import { WorkspaceLeaseService } from
  "./workspace/workspace-lease-service.js";

export interface ServerAppOptions {
  anonymousRateLimit?: {
    maximumAttempts: number;
    windowMilliseconds: number;
  };
  databasePath: string;
  artifactBlobRoot?: string;
  bridgeServerToken?: string;
  clock?: () => string;
  logger?: boolean;
  loggerInstance?: FastifyBaseLogger;
  memoryReducer?: MemoryReducerRunner;
  memoryReducerSweepMilliseconds?: number;
  trustProxyHops?: number;
  webAuth?: WebAuthConfiguration;
  webRoot?: string;
}

export async function createServerApp(
  options: ServerAppOptions
): Promise<FastifyInstance> {
  const memoryReducerSweepMilliseconds =
    options.memoryReducerSweepMilliseconds ?? 1_000;
  if (
    options.memoryReducer &&
    (!Number.isSafeInteger(memoryReducerSweepMilliseconds) ||
      memoryReducerSweepMilliseconds < 100 ||
      memoryReducerSweepMilliseconds > 60_000)
  ) {
    throw new Error(
      "Memory reducer sweep interval must be between 100 and 60000 milliseconds"
    );
  }
  await prepareDatabaseDirectory(options.databasePath);
  await migrateDatabase(options.databasePath);
  const database = openDatabase(options.databasePath);
  const transactions = new SqliteTransactionBoundary(database);
  const core = new CoreRepository(database, transactions);
  const auth = new AuthService(database);
  const bridgeServerToken = normalizeBridgeServerToken(options.bridgeServerToken);
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
  const teamChanges = new TeamChangeService();
  const registry = new MemberDeviceService(core, auth);
  const agents = new AgentService(core, auth);
  const agentProvisioning = new AgentProvisioningService(
    database,
    core,
    auth,
    transactions
  );
  const presence = new PresenceService(core, auth);
  const messages = new MessageService(core, auth);
  const teamWait = new TeamWaitService(core, auth);
  const pairing = new BridgePairingService(database, core, auth);
  const devicePairingSessions = new DevicePairingSessionService(
    database,
    core,
    auth
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  const runRepository = new RunRepository(database);
  const taskRepository = new AgentTaskRepository(database);
  const tasks = new AgentTaskService(taskRepository, core, auth);
  const artifactRepository = new ArtifactRepository(database, transactions);
  const workspaceLeases = new WorkspaceLeaseService(
    new WorkspaceLeaseRepository(database, transactions),
    runRepository,
    taskRepository,
    core
  );
  const artifactPublicationRepository = new ArtifactPublicationRepository(
    database,
    transactions
  );
  const artifactBlobs = new LocalArtifactBlobStore(
    options.artifactBlobRoot ??
      path.join(path.dirname(options.databasePath), "artifact-blobs")
  );
  const artifactPublications = new ArtifactPublicationService(
    artifactPublicationRepository,
    workspaceLeases,
    artifactBlobs
  );
  const artifactDeliveries = new ArtifactDeliveryService(
    database,
    artifactPublicationRepository,
    artifactBlobs
  );
  const artifactPreviews = new ArtifactPreviewService(
    artifactRepository,
    artifactPublicationRepository,
    artifactBlobs,
    auth
  );
  const artifactContentBinding = new ArtifactContentBindingService(
    transactions,
    artifactRepository,
    artifactPublicationRepository,
    taskRepository,
    runRepository,
    core
  );
  const taskArtifacts = new TaskArtifactService(
    artifactRepository,
    taskRepository,
    runRepository,
    core,
    auth
  );
  const contextPlanner = new ContextPlanner(database, core, taskRepository);
  const memoryEntries = new MemoryEntryRepository(database, transactions);
  const rollingRoomMemory = new RollingRoomMemoryRepository(database, transactions);
  const longTermMemory = new LongTermMemoryService(
    database,
    memoryEntries,
    artifactRepository,
    taskRepository,
    core,
    runRepository,
    auth
  );
  const memoryCandidates = new MemoryCandidateService(
    database,
    transactions,
    auth,
    longTermMemory,
    (roomId) => {
      const room = core.getRoom(roomId);
      if (room) teamChanges.notify(room.teamId, { kind: "room", roomId });
    }
  );
  const memoryReducer = options.memoryReducer
    ? new MemoryReducerScheduler(
        core,
        rollingRoomMemory,
        options.memoryReducer,
        clock,
        memoryCandidates
      )
    : undefined;
  const resultEvidenceConsumption = new ResultEvidenceConsumptionRepository(database);
  const traces = new TraceRepository(database);
  const runs = new RunService(core, runRepository, auth, taskRepository);
  const resultRepository = new ResultRepository(database);
  const results = new ResultService(
    database,
    resultRepository,
    tasks,
    taskRepository,
    runRepository,
    core,
    auth
  );
  const manualTaskWork = new ManualTaskWorkService(
    core,
    taskRepository,
    runRepository,
    resultRepository,
    results
  );
  const workbench = new WorkbenchService(
    core,
    taskRepository,
    runRepository,
    resultRepository,
    auth
  );
  const clarificationRepository = new ClarificationRepository(database);
  const taskClarifications = new TaskClarificationService(
    transactions,
    clarificationRepository,
    taskRepository,
    core,
    runRepository,
    runs,
    messages,
    auth
  );
  const executor = new InProcessRunExecutor(
    core,
    runRepository,
    contextPlanner,
    clock
  );
  const fakeAdapters = new Map<string, FakeRuntimeAdapter>();
  const bridgeConnections = new BridgeConnectionRegistry();
  const operationalMetrics = new OperationalMetrics(
    database, bridgeConnections, clock
  );
  const delivery = new DeliveryService(
    database,
    core,
    runRepository,
    contextPlanner,
    bridgeConnections,
    clock
  );
  const bridgeRunEvents = new BridgeRunEventService(
    core,
    runRepository,
    resultEvidenceConsumption,
    delivery
  );
  const handoffs = new HandoffService(core, runRepository, taskRepository);
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
    taskRepository,
    clock
  );
  let discussionSweepTimer: ReturnType<typeof setInterval> | undefined;
  let discussionSweepInFlight = false;
  let memoryReducerSweepTimer: ReturnType<typeof setInterval> | undefined;
  let memoryReducerSweepInFlight = false;
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
      await routeAgentReplyMentions(completed.runId);
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
  const dispatchOrdinaryHandoffRun = async (
    run: NonNullable<ReturnType<RunRepository["getRun"]>>
  ): Promise<void> => {
    if (new Set([
      "completed", "failed", "canceled", "expired", "outcome_unknown"
    ]).has(run.state)) return;
    const agent = core.getAgent(run.targetAgentId);
    const adapter = fakeAdapters.get(run.targetAgentId);
    if (adapter) {
      adapter.enqueue({
        expectedInstruction: run.instruction,
        events: [
          { type: "status", sequence: 1, status: "working" },
          {
            type: "reply",
            sequence: 2,
            content: `${agent?.name ?? "Agent"} completed: ${run.instruction}`
          },
          { type: "status", sequence: 3, status: "completed" }
        ]
      });
      await executor.execute(run.runId, adapter);
      await routeAgentReplyMentions(run.runId);
      return;
    }
    if (agent?.integrationMode === "managed") delivery.dispatch(run.runId);
  };
  async function routeAgentReplyMentions(runId: string): Promise<void> {
    for (const intent of runRepository.listPendingReplyRoutingIntents(runId)) {
      if (!discussionRepository.findTurnByRun(runId)) {
        const routedRuns = handoffs.createFromReply(
          runId,
          intent.content,
          clock()
        );
        for (const run of routedRuns) {
          await dispatchOrdinaryHandoffRun(run);
        }
      }
      runRepository.completeReplyRoutingIntent(
        runId,
        intent.replySequence,
        clock()
      );
    }
  }
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
      if (discussionRepository.findTurnByRun(run.runId)) {
        void routeAgentReplyMentions(run.runId).then(() =>
          advanceDiscussion(run.runId)
        );
        return;
      }
      void routeAgentReplyMentions(run.runId);
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
  const requireBridgeServerToken = (request: FastifyRequest): void => {
    assertBridgeServerToken(
      bridgeServerToken,
      request.headers[bridgeServerTokenHeader]
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
    if (reply.statusCode < 400 && unsafeHttpMethods.has(request.method)) {
      const params = (request.params ?? {}) as Record<string, string | undefined>;
      let changedTeamId = params.teamId;
      if (!changedTeamId && params.roomId) {
        changedTeamId = core.getRoom(params.roomId)?.teamId;
      }
      if (!changedTeamId && params.runId) {
        const run = runRepository.getRun(params.runId);
        changedTeamId = run ? core.getRoom(run.roomId)?.teamId : undefined;
      }
      if (!changedTeamId && params.discussionId) {
        const discussion = discussionRepository.get(params.discussionId);
        changedTeamId = discussion
          ? core.getRoom(discussion.roomId)?.teamId
          : undefined;
      }
      if (!changedTeamId && params.agentId) {
        changedTeamId = core.getAgent(params.agentId)?.teamId;
      }
      if (!changedTeamId && params.taskId) {
        const task = taskRepository.get(params.taskId);
        changedTeamId = task ? core.getRoom(task.roomId)?.teamId : undefined;
      }
      if (changedTeamId) {
        const roomId = params.roomId;
        const roomTimelineMutation =
          request.routeOptions.url === "/api/rooms/:roomId/messages";
        teamChanges.notify(
          changedTeamId,
          roomTimelineMutation && roomId
            ? { kind: "room", roomId }
            : { kind: "team" }
        );
      }
    }
  });

  app.addHook("onClose", (_instance, done) => {
    if (discussionSweepTimer) clearInterval(discussionSweepTimer);
    if (memoryReducerSweepTimer) clearInterval(memoryReducerSweepTimer);
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
      message.startsWith("Device pairing conflict:") ||
      message === "Room settings changed; reload and retry" ||
      message.startsWith("Agent provisioning conflict:") ||
      message.startsWith("Room already has an active Discussion:") ||
      message.startsWith("Task already has an active Discussion:")
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

  const routeContext: ServerRouteContext = {
    app,
    artifactContentBinding,
    artifactDeliveries,
    artifactPreviews,
    artifactPublications,
    advanceDiscussion,
    agents,
    agentProvisioning,
    auth,
    bridgeConnections,
    bridgeRunEvents,
    cancellations,
    clock,
    core,
    delivery,
    devicePairingSessions,
    discussions,
    discussionRepository,
    dispatchDiscussionRuns,
    executor,
    fakeAdapters,
    handoffs,
    limitAnonymous,
    longTermMemory,
    memoryCandidates,
    manualRuns,
    manualTaskWork,
    messages,
    operationalMetrics,
    optionalPrincipal,
    pairing,
    pauseDiscussionForInput,
    presence,
    principal,
    registry,
    requireBridgeServerToken,
    requireTrustedOrigin,
    routeAgentReplyMentions,
    runRepository,
    runs,
    results,
    taskArtifacts,
    taskClarifications,
    tasks,
    teamChanges,
    teamRooms,
    teamWait,
    traces,
    webAuth,
    workbench,
    workspaceLeases,
    ...(trustedWeb ? { trustedWeb } : {})
  };

  registerSystemRoutes(routeContext);
  registerBridgeSocketRoutes(routeContext);
  registerArtifactRoutes(routeContext);
  registerAuthRoutes(routeContext);

  registerTeamRoomRoutes(routeContext);
  registerTaskRoutes(routeContext);
  registerResultRoutes(routeContext);
  registerWorkbenchRoutes(routeContext);
  registerRegistryRoutes(routeContext);
  registerDevicePairingSessionRoutes(routeContext);
  registerMessageRoutes(routeContext);
  registerMemoryCandidateRoutes(routeContext);
  registerDiscussionRoutes(routeContext);
  registerRunRoutes(routeContext);

  registerMcpRoutes(routeContext);

  taskClarifications.reconcile(clock());
  await dispatchDiscussionRuns(discussions.recover());
  for (const runId of new Set(
    runRepository.listPendingReplyRoutingIntents().map(({ parentRunId }) =>
      parentRunId
    )
  )) {
    await routeAgentReplyMentions(runId);
  }
  discussionSweepTimer = setInterval(() => {
    void sweepDiscussionDeadlines().catch((error: unknown) => {
      app.log.error({
        event: "discussion.wave.deadline_sweep_failed",
        error: error instanceof Error ? error.message : "Unexpected error"
      }, "Discussion Wave deadline sweep failed");
    });
  }, 1_000);
  discussionSweepTimer.unref();

  if (memoryReducer) {
    memoryReducer.enableAllRooms();
    const sweepMemory = async (): Promise<void> => {
      if (memoryReducerSweepInFlight) return;
      memoryReducerSweepInFlight = true;
      try {
        await memoryReducer.sweep();
      } finally {
        memoryReducerSweepInFlight = false;
      }
    };
    await sweepMemory();
    memoryReducerSweepTimer = setInterval(() => {
      void sweepMemory().catch((error: unknown) => {
        app.log.error({
          event: "memory.reducer.sweep_failed",
          error: error instanceof Error ? error.message : "Unexpected error"
        }, "Memory reducer sweep failed");
      });
    }, memoryReducerSweepMilliseconds);
    memoryReducerSweepTimer.unref();
  }

  if (options.webRoot) {
    await app.register(fastifyStatic, {
      root: path.resolve(options.webRoot),
      prefix: "/"
    });
  }
  return app;
}
