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
import { RepositoryCaptureService } from "./repository/repository-capture-service.js";
import { RepositoryIntegrationService } from
  "./repository/repository-integration-service.js";
import { RepositoryVerificationService } from "./verification/repository-verification-service.js";
import { RemoteProviderBindingRepository } from
  "./remote/remote-provider-binding-repository.js";
import { RemoteProviderBindingService } from
  "./remote/remote-provider-binding-service.js";
import {
  RemoteProviderClient,
  type RemoteProviderCredentialResolver
} from "./remote/remote-provider-client.js";
import {
  createRemoteProviderEgressFetch,
  remoteProviderFetchAllowsTestLoopback
} from "./remote/remote-provider-egress-policy.js";
import { RemoteEvidenceRepository } from
  "./remote/remote-evidence-repository.js";
import { RemoteEvidenceService } from "./remote/remote-evidence-service.js";
import { RemoteEvidenceAdoptionRepository } from
  "./remote/remote-evidence-adoption-repository.js";
import { RemoteEvidenceAdoptionService } from
  "./remote/remote-evidence-adoption-service.js";
import { RemoteInputAttestationPlanner } from
  "./remote/remote-input-attestation-planner.js";
import { RemoteInputAttestationRepository } from
  "./remote/remote-input-attestation-repository.js";
import { RemoteInputAttestationService } from
  "./remote/remote-input-attestation-service.js";
import { IsolatedWorkspaceLeaseService } from "./workspace/isolated-workspace-lease-service.js";
import { LocalArtifactBlobStore } from
  "./artifact/local-artifact-blob-store.js";
import { CoreRepository } from "./data/core-repository.js";
import { HostedAgentRepository } from "./data/hosted-agent-repository.js";
import { BridgeConnectionRegistry } from "./bridge/bridge-connection-registry.js";
import { openDatabase } from "./data/database.js";
import { prepareDatabaseDirectory } from "./data/database-location.js";
import { migrateDatabase } from "./data/migration-runner.js";
import { SqliteTransactionBoundary } from "./data/sqlite-transaction-boundary.js";
import { registerClientAccessRoutes } from "./http/client-access-routes.js";
import { ClientAccessService } from "./security/client-access-service.js";
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
import { registerPrivateCARotationRoutes } from
  "./http/private-ca-rotation-routes.js";
import { registerMcpRoutes } from "./http/mcp-routes.js";
import { registerMessageRoutes } from "./http/message-routes.js";
import { registerMemoryCandidateRoutes } from "./http/memory-candidate-routes.js";
import { registerHostedAgentRoutes } from "./http/hosted-agent-routes.js";
import { registerRegistryRoutes } from "./http/registry-routes.js";
import type { ServerRouteContext } from "./http/route-context.js";
import { registerRunRoutes } from "./http/run-routes.js";
import { registerResultRoutes } from "./http/result-routes.js";
import { registerSystemRoutes } from "./http/system-routes.js";
import { registerTaskRoutes } from "./http/task-routes.js";
import { registerExecutionPlanRoutes } from "./http/execution-plan-routes.js";
import { registerRemoteEvidenceRoutes } from "./http/remote-evidence-routes.js";
import { ExecutionError } from "./execution/execution-error.js";
import { ExecutionPlanRepository } from "./execution/execution-plan-repository.js";
import { ExecutionSourceRepository } from "./execution/execution-source-repository.js";
import { ExecutionPlanService } from "./execution/execution-plan-service.js";
import { ExecutionPlanDraftWriter } from
  "./execution/execution-plan-draft-writer.js";
import { ExecutionNodeControlService } from
  "./execution/execution-node-control-service.js";
import { ExecutionNodeRetryRepository } from
  "./execution/execution-node-retry-repository.js";
import { ExecutionInputRepository } from "./execution/execution-input-repository.js";
import { ExecutionInputService } from "./execution/execution-input-service.js";
import { ExecutionEvidenceViewService } from
  "./execution/execution-evidence-view-service.js";
import { ExecutionDependencyResolver } from
  "./execution/execution-dependency-resolver.js";
import { ExecutionNodeMaterializationRepository } from
  "./execution/execution-node-materialization-repository.js";
import { ExecutionNodeProjector } from
  "./execution/execution-node-projector.js";
import { ExecutionApprovalRepository } from "./execution/execution-approval-repository.js";
import { ExecutionPlanCompiler } from "./execution/execution-plan-compiler.js";
import { GovernedRunAdmissionService } from
  "./execution/governed-run-admission-service.js";
import { ExecutionNodeStateRepository } from
  "./execution/execution-node-state-repository.js";
import { ExecutionSettlementService } from
  "./execution/execution-settlement-service.js";
import { ExecutionRecoveryService } from
  "./execution/execution-recovery-service.js";
import { ExecutionScheduler } from "./execution/execution-scheduler.js";
import { ExecutionSchedulerControlRepository } from
  "./execution/execution-scheduler-control-repository.js";
import { ExecutionSchedulerControlService } from
  "./execution/execution-scheduler-control-service.js";
import { ExecutionSchedulerFairnessRepository } from
  "./execution/execution-scheduler-fairness-repository.js";
import { AcceptedResultMaterializer } from
  "./execution/materialization/accepted-result-materializer.js";
import { ExecutionMaterializationService } from
  "./execution/materialization/execution-materialization-service.js";
import { VerifiedOutputMaterializer } from
  "./execution/materialization/verified-output-materializer.js";
import { IntegratedCommitMaterializer } from
  "./execution/materialization/integrated-commit-materializer.js";
import { registerTeamRoomRoutes } from "./http/team-room-routes.js";
import { registerWorkbenchRoutes } from "./http/workbench-routes.js";
import { DiscussionOrchestrator } from "./discussion/discussion-orchestrator.js";
import { DiscussionRepository } from "./discussion/discussion-repository.js";
import { DiscussionPlanProposalService } from
  "./discussion/discussion-plan-proposal-service.js";
import { TeamWaitService } from "./mcp/team-wait-service.js";
import { ManualTaskWorkService } from
  "./mcp/manual-task-work-service.js";
import { ManualExecutionPlanService } from
  "./mcp/manual-execution-plan-service.js";
import { OperationalMetrics } from "./observability/operational-metrics.js";
import type { BuildIdentity } from "./observability/build-identity.js";
import { TraceRepository } from "./observability/trace-repository.js";
import { AgentService } from "./registry/agent-service.js";
import { AgentProvisioningService } from
  "./registry/agent-provisioning-service.js";
import { MemberDeviceService } from "./registry/member-device-service.js";
import { DeviceRevocationService } from
  "./registry/device-revocation-service.js";
import { PresenceService } from "./registry/presence-service.js";
import { DeliveryService } from "./run/delivery-service.js";
import { BridgeRunEventService } from "./run/bridge-run-event-service.js";
import { CancellationService } from "./run/cancellation-service.js";
import { HandoffService } from "./run/handoff-service.js";
import { ManualRunService } from "./run/manual-run-service.js";
import { MemberMessageRunService } from "./run/member-message-run-service.js";
import { RunProjectionReconciler } from
  "./run/run-projection-reconciler.js";
import { RunRepository } from "./run/run-repository.js";
import { RunService } from "./run/run-service.js";
import { HostedInvocationRepository } from
  "./run/hosted-invocation-repository.js";
import { HostedRunScheduler } from "./run/hosted-run-scheduler.js";
import { FakeRuntimeAdapter } from "./runtime/fake-runtime-adapter.js";
import { InProcessRunExecutor } from "./runtime/in-process-run-executor.js";
import { HostedOpenAIResponsesProbe } from
  "./runtime/hosted-openai-responses-adapter.js";
import { AuthService, AuthorizationError, type WebPrincipal } from "./security/auth-service.js";
import {
  AnonymousRateLimiter,
  AnonymousRateLimitError
} from "./security/anonymous-rate-limiter.js";
import { BridgePairingService } from "./security/bridge-pairing-service.js";
import { DevicePairingSessionService } from
  "./security/device-pairing-session-service.js";
import { createDeploymentTrustProvider } from
  "./security/deployment-trust.js";
import { createDeploymentTrustRotationProvider } from
  "./security/deployment-trust-rotation.js";
import { PrivateCARotationService } from
  "./security/private-ca-rotation-service.js";
import {
  assertBridgeServerToken,
  bridgeServerTokenHeader,
  normalizeBridgeServerToken
} from "./security/bridge-server-token.js";
import { TrustedWebAccessService } from "./security/trusted-web-access-service.js";
import { HostedAgentConfigurationService } from
  "./hosted/hosted-agent-configuration-service.js";
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
  deploymentTrustFile?: string;
  deploymentTrustRotationFile?: string;
  artifactBlobRoot?: string;
  bridgeServerToken?: string;
  buildIdentity?: BuildIdentity;
  clock?: () => string;
  logger?: boolean;
  loggerInstance?: FastifyBaseLogger;
  hostedFetch?: typeof fetch;
  remoteProviderFetch?: typeof fetch;
  remoteProviderCredentialResolver?: RemoteProviderCredentialResolver;
  remoteProviderTimeoutMilliseconds?: number;
  remoteGitExecutable?: string;
  remoteGitTemporaryBase?: string;
  memoryReducer?: MemoryReducerRunner;
  memoryReducerSweepMilliseconds?: number;
  executionSchedulerSweepMilliseconds?: number;
  trustProxyHops?: number;
  webAuth?: WebAuthConfiguration;
  webRoot?: string;
}

export async function createServerApp(
  options: ServerAppOptions
): Promise<FastifyInstance> {
  const memoryReducerSweepMilliseconds =
    options.memoryReducerSweepMilliseconds ?? 1_000;
  const executionSchedulerSweepMilliseconds =
    options.executionSchedulerSweepMilliseconds ?? 1_000;
  if (
    !Number.isSafeInteger(executionSchedulerSweepMilliseconds) ||
    executionSchedulerSweepMilliseconds < 0 ||
    executionSchedulerSweepMilliseconds > 60_000 ||
    (executionSchedulerSweepMilliseconds > 0 &&
      executionSchedulerSweepMilliseconds < 100)
  ) {
    throw new Error(
      "Execution scheduler sweep interval must be 0 or between 100 and 60000 milliseconds"
    );
  }
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
  const teamChanges = new TeamChangeService();
  const core = new CoreRepository(
    database,
    transactions,
    ({ teamId, roomId }) => {
      teamChanges.notify(teamId, { kind: "room", roomId });
    }
  );
  const auth = new AuthService(database);
  const bridgeServerToken = normalizeBridgeServerToken(options.bridgeServerToken);
  const webAuth = options.webAuth ?? { mode: "local" as const };
  const deploymentTrust = createDeploymentTrustProvider(
    options.deploymentTrustFile,
    webAuth.mode === "trusted-team" ? webAuth.publicOrigin : undefined
  );
  const deploymentTrustRotation = createDeploymentTrustRotationProvider(
    options.deploymentTrustRotationFile,
    deploymentTrust
  );
  const privateCARotation = new PrivateCARotationService(
    database,
    deploymentTrust,
    deploymentTrustRotation
  );
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
  let hostedAgentRepository: HostedAgentRepository;
  try {
    hostedAgentRepository = new HostedAgentRepository(
      database,
      webAuth.mode === "trusted-team"
        ? { mode: "trusted_recovery", secret: webAuth.ownerRecoveryToken }
        : { mode: "local_database" },
      transactions
    );
  } catch (error) {
    database.close();
    throw error;
  }
  const teamRooms = new TeamRoomService(core, auth, hostedAgentRepository);
  const registry = new MemberDeviceService(core, auth);
  const agents = new AgentService(core, auth);
  const agentProvisioning = new AgentProvisioningService(
    database,
    core,
    auth,
    transactions
  );
  const presence = new PresenceService(
    core,
    auth,
    30_000,
    hostedAgentRepository
  );
  const messages = new MessageService(core, auth);
  const teamWait = new TeamWaitService(core, auth, teamChanges);
  const pairing = new BridgePairingService(database, core, auth);
  const clientAccess = new ClientAccessService(database, core, auth);
  const devicePairingSessions = new DevicePairingSessionService(
    database,
    core,
    auth,
    deploymentTrust,
    clientAccess
  );
  const clock = options.clock ?? (() => new Date().toISOString());
  const runRepository = new RunRepository(
    database,
    transactions,
    ({ kind, roomId, teamId }) => {
      teamChanges.notify(teamId, { kind, roomId });
    }
  );
  const taskRepository = new AgentTaskRepository(database);
  const tasks = new AgentTaskService(taskRepository, core, auth);
  const artifactRepository = new ArtifactRepository(database, transactions);
  const workspaceLeases = new WorkspaceLeaseService(
    new WorkspaceLeaseRepository(database, transactions),
    runRepository,
    taskRepository,
    core,
    (principal, lease, publication, now) => publication.verificationOperationId
      ? repositoryVerifications.requireActiveLogSource(
        principal, lease, publication, now
      )
      : repositoryCaptures.requireActiveSource(
        principal, lease, publication.artifactType, now
      )
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
    core,
    (principal, artifact, now) => executionInputs.recordArtifactInputs(principal, artifact, now),
    (principal, publication, now) => workspaceLeases.requireCurrentCapturePublication(principal, publication, now),
    (publication) => artifactPublications.commitCandidate(publication)
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
  const memberMessageRuns = new MemberMessageRunService(
    transactions,
    messages,
    runs
  );
  const runProjections = new RunProjectionReconciler(
    database,
    transactions,
    core,
    taskRepository,
    runRepository
  );
  const resultRepository = new ResultRepository(database);
  const executionApprovals = new ExecutionApprovalRepository(database);
  const executionPlanRepository = new ExecutionPlanRepository(database);
  const executionSources = new ExecutionSourceRepository(database);
  const notifyExecutionChanged = (roomId: string) => {
    const room = core.getRoom(roomId);
    if (room) teamChanges.notify(room.teamId, { kind: "room", roomId });
  };
  const executionDraftWriter = new ExecutionPlanDraftWriter(
    transactions,
    executionPlanRepository,
    executionSources,
    taskRepository,
    core,
    notifyExecutionChanged
  );
  const executionMaterializations =
    new ExecutionNodeMaterializationRepository(database);
  const executionDependencies = new ExecutionDependencyResolver(
    executionPlanRepository,
    executionMaterializations
  );
  const executionInputs = new ExecutionInputService(
    database, new ExecutionInputRepository(database), executionPlanRepository,
    executionApprovals, artifactRepository, artifactPublicationRepository, artifactBlobs, auth
  );
  const executionPlans = new ExecutionPlanService(
    transactions,
    executionPlanRepository,
    executionSources,
    taskRepository,
    core,
    auth,
    notifyExecutionChanged,
    executionApprovals,
    new ExecutionPlanCompiler(tasks, taskRepository, resultRepository, executionApprovals),
    tasks,
    executionDraftWriter
  );
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
  const manualExecutionPlans = new ManualExecutionPlanService(
    core,
    taskRepository,
    runRepository,
    executionPlanRepository,
    executionDraftWriter
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
  const bridgeConnections = new BridgeConnectionRegistry(
    () => new Date(clock())
  );
  const isolatedWorkspaces = new IsolatedWorkspaceLeaseService(
    database, new ExecutionPlanRepository(database), bridgeConnections
  );
  const executionSchedulerControlRepository =
    new ExecutionSchedulerControlRepository(database);
  const executionSchedulerFairness =
    new ExecutionSchedulerFairnessRepository(database);
  const governedAdmission = new GovernedRunAdmissionService(
    database,
    transactions,
    core,
    taskRepository,
    new ExecutionPlanRepository(database),
    executionApprovals,
    executionInputs,
    executionDependencies,
    isolatedWorkspaces,
    bridgeConnections,
    runRepository,
    executionSchedulerControlRepository,
    executionSchedulerFairness
  );
  runs.configureGovernedAdmission(governedAdmission);
  const repositoryCaptures = new RepositoryCaptureService(database,
    isolatedWorkspaces,
    artifactRepository, artifactPublicationRepository, artifactBlobs);
  const repositoryVerifications = new RepositoryVerificationService(
    database, artifactRepository, artifactBlobs
  );
  const repositoryIntegrations = new RepositoryIntegrationService(
    database,
    transactions,
    auth,
    executionMaterializations,
    bridgeConnections
  );
  const remoteProviderBindingRepository = new RemoteProviderBindingRepository(
    database, transactions
  );
  const remoteProviderFetch = options.remoteProviderFetch ??
    createRemoteProviderEgressFetch();
  const remoteProviderBindings = new RemoteProviderBindingService(
    remoteProviderBindingRepository,
    auth,
    remoteProviderFetchAllowsTestLoopback(remoteProviderFetch)
  );
  const remoteEvidenceRepository = new RemoteEvidenceRepository(
    database, artifactRepository, artifactPublicationRepository, transactions
  );
  const remoteProviderClient = new RemoteProviderClient(
    options.remoteProviderCredentialResolver ?? (() => undefined),
    remoteProviderFetch,
    options.remoteProviderTimeoutMilliseconds
  );
  const remoteInputAttestationRepository =
    new RemoteInputAttestationRepository(database, transactions);
  const remoteInputAttestationPlanner = new RemoteInputAttestationPlanner(
    database,
    artifactBlobs
  );
  const remoteEvidence = new RemoteEvidenceService(
    database,
    remoteEvidenceRepository,
    remoteProviderBindingRepository,
    executionPlanRepository,
    auth,
    remoteProviderClient,
    artifactBlobs,
    {
      ...(options.remoteGitExecutable === undefined
        ? {} : { gitExecutable: options.remoteGitExecutable }),
      ...(options.remoteGitTemporaryBase === undefined
        ? {} : { temporaryBase: options.remoteGitTemporaryBase })
    }
  );
  const remoteInputAttestations = new RemoteInputAttestationService(
    database,
    remoteInputAttestationRepository,
    remoteEvidenceRepository,
    remoteProviderBindingRepository,
    executionPlanRepository,
    auth,
    remoteProviderClient,
    remoteInputAttestationPlanner
  );
  const remoteEvidenceAdoptions = new RemoteEvidenceAdoptionService(
    database,
    new RemoteEvidenceAdoptionRepository(database, transactions),
    remoteEvidenceRepository,
    remoteProviderBindingRepository,
    executionPlanRepository,
    auth,
    remoteInputAttestationRepository,
    remoteInputAttestationPlanner
  );
  const operationalMetrics = new OperationalMetrics(
    database, bridgeConnections, clock, options.buildIdentity
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
  const deviceRevocation = new DeviceRevocationService(
    registry,
    core,
    runRepository,
    bridgeConnections,
    clock
  );
  deviceRevocation.recover();
  const discussionRepository = new DiscussionRepository(database);
  const discussionPlanProposals = new DiscussionPlanProposalService(
    transactions,
    core,
    discussionRepository,
    executionDraftWriter,
    taskRepository
  );
  const discussions = new DiscussionOrchestrator(
    core,
    messages,
    discussionRepository,
    runRepository,
    auth,
    taskRepository,
    clock,
    discussionPlanProposals
  );
  let discussionSweepTimer: ReturnType<typeof setInterval> | undefined;
  let discussionSweepInFlight = false;
  let cancellationSweepTimer: ReturnType<typeof setInterval> | undefined;
  let executionSchedulerSweepTimer: ReturnType<typeof setInterval> | undefined;
  let memoryReducerSweepTimer: ReturnType<typeof setInterval> | undefined;
  let memoryReducerSweepInFlight = false;
  let hostedScheduler: HostedRunScheduler;
  const dispatchRun = async (
    run: NonNullable<ReturnType<RunRepository["getRun"]>>
  ): Promise<NonNullable<ReturnType<RunRepository["getRun"]>>> => {
    if (new Set([
      "completed", "failed", "canceled", "expired", "outcome_unknown"
    ]).has(run.state)) return run;
    const agent = core.getAgent(run.targetAgentId);
    const adapter = fakeAdapters.get(run.targetAgentId);
    if (adapter) {
      const turn = discussionRepository.findTurnByRun(run.runId);
      const firstSequence = run.lastSequence + 1;
      adapter.enqueue({
        expectedInstruction: run.instruction,
        events: [
          { type: "status", sequence: firstSequence, status: "working" },
          {
            type: "reply",
            sequence: firstSequence + 1,
            content: turn
              ? turn.kind === "finalization"
                ? `${agent?.name ?? "Agent"} 结论：保留已形成的共识，并明确记录未决问题。`
                : `${agent?.name ?? "Agent"}：建议核对证据、风险和未决问题。`
              : `${agent?.name ?? "Agent"} completed: ${run.instruction}`
          },
          { type: "status", sequence: firstSequence + 2, status: "completed" }
        ]
      });
      const completed = await executor.execute(run.runId, adapter);
      await routeAgentReplyMentions(completed.runId);
      if (turn) {
        if (completed.state === "input_required") {
          await pauseDiscussionForInput(completed.runId);
        } else {
          await advanceDiscussion(completed.runId);
        }
      }
      return completed;
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
    } else if (agent?.integrationMode === "hosted") {
      hostedScheduler.enqueue(run.runId);
    }
    return runRepository.getRun(run.runId) ?? run;
  };
  const executionNodeStates = new ExecutionNodeStateRepository(database);
  const executionEvidence = new ExecutionEvidenceViewService(
    database,
    executionPlans,
    executionNodeStates,
    executionMaterializations,
    new RemoteEvidenceAdoptionRepository(database, transactions),
    remoteEvidenceAdoptions,
    remoteInputAttestationRepository,
    remoteProviderBindingRepository,
    repositoryIntegrations
  );
  const executionNodeProjector = new ExecutionNodeProjector(
    executionNodeStates
  );
  const executionSettlement = new ExecutionSettlementService(
    database,
    transactions,
    executionNodeProjector,
    new ExecutionMaterializationService(
      new AcceptedResultMaterializer(database, executionMaterializations),
      new VerifiedOutputMaterializer(database, executionMaterializations),
      new IntegratedCommitMaterializer(database, executionMaterializations)
    )
  );
  const executionRecovery = new ExecutionRecoveryService(
    database,
    executionSettlement,
    runRepository
  );
  const executionScheduler = new ExecutionScheduler(
    transactions,
    executionNodeStates,
    executionNodeProjector,
    executionSettlement,
    governedAdmission,
    executionSchedulerFairness,
    clock
  );
  const executionNodeControls = new ExecutionNodeControlService(
    transactions,
    core,
    auth,
    executionPlanRepository,
    taskRepository,
    executionNodeStates,
    new ExecutionNodeRetryRepository(database),
    executionSettlement,
    governedAdmission,
    runRepository
  );
  const executionSchedulerControls = new ExecutionSchedulerControlService(
    transactions,
    executionPlanRepository,
    taskRepository,
    auth,
    executionSchedulerControlRepository,
    executionSchedulerFairness,
    executionNodeStates,
    executionScheduler,
    governedAdmission
  );
  let executionSweepInFlight = false;
  const sweepExecution = async (): Promise<void> => {
    if (executionSweepInFlight) return;
    executionSweepInFlight = true;
    try {
      for (const run of executionScheduler.sweep()) await dispatchRun(run);
    } finally {
      executionSweepInFlight = false;
    }
  };
  const dispatchDiscussionRuns = async (
    runs: NonNullable<ReturnType<RunRepository["getRun"]>>[]
  ): Promise<void> => {
    await Promise.all(runs.map((run) => dispatchRun(run)));
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
  async function routeAgentReplyMentions(runId: string): Promise<void> {
    for (const intent of runRepository.listPendingReplyRoutingIntents(runId)) {
      if (!discussionRepository.findTurnByRun(runId)) {
        const routedRuns = handoffs.createFromReply(
          runId,
          intent.content,
          clock()
        );
        for (const run of routedRuns) {
          await dispatchRun(run);
        }
      }
      runRepository.completeReplyRoutingIntent(
        runId,
        intent.replySequence,
        clock()
      );
    }
  }
  const hostedInvocations = new HostedInvocationRepository(
    database,
    runRepository,
    transactions
  );
  hostedScheduler = new HostedRunScheduler(
    core,
    runRepository,
    hostedAgentRepository,
    hostedInvocations,
    executor,
    clock,
    {
      ...(options.hostedFetch ? { fetch: options.hostedFetch } : {}),
      onTerminal: async (run) => {
        await routeAgentReplyMentions(run.runId);
        if (discussionRepository.findTurnByRun(run.runId)) {
          if (run.state === "input_required") {
            await pauseDiscussionForInput(run.runId);
          } else {
            await advanceDiscussion(run.runId);
          }
        }
      }
    }
  );
  cancellations.attachHostedCancellation(hostedScheduler);
  const hostedAgents = new HostedAgentConfigurationService(
    hostedAgentRepository,
    core,
    agents,
    auth,
    transactions,
    new HostedOpenAIResponsesProbe(options.hostedFetch ?? globalThis.fetch),
    (agentId) => hostedScheduler.revokeAgent(agentId)
  );
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
    transactions,
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
      const repositoryPublishesTimeline =
        request.routeOptions.url === "/api/rooms/:roomId/messages" ||
        request.routeOptions.url === "/api/tasks/:taskId/execution-plans" ||
        request.routeOptions.url?.startsWith("/api/execution-plans/") === true ||
        request.routeOptions.url?.startsWith("/api/runs/:runId/") === true;
      if (changedTeamId && !repositoryPublishesTimeline) {
        teamChanges.notify(changedTeamId);
      }
    }
  });

  app.addHook("preClose", async () => {
    hostedAgents.shutdown();
  });
  app.addHook("onClose", async () => {
    if (discussionSweepTimer) clearInterval(discussionSweepTimer);
    if (cancellationSweepTimer) clearInterval(cancellationSweepTimer);
    if (executionSchedulerSweepTimer) {
      clearInterval(executionSchedulerSweepTimer);
    }
    if (memoryReducerSweepTimer) clearInterval(memoryReducerSweepTimer);
    await hostedScheduler.shutdown();
    database.close();
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ExecutionError) {
      void reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message }
      });
      return;
    }
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
      message === "Owner recovery key changed; reload and retry" ||
      message === "Hosted Runtime Profile changed; reload and retry" ||
      message === "Hosted Agent configuration is locked while work is active" ||
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
    deviceRevocation,
    devicePairingSessions,
    clientAccess,
    discussions,
    discussionRepository,
    dispatchRun,
    dispatchDiscussionRuns,
    executor,
    executionPlans,
    executionEvidence,
    executionInputs,
    executionNodeControls,
    executionSchedulerControls,
    isolatedWorkspaces,
    repositoryCaptures,
    repositoryIntegrations,
    repositoryVerifications,
    remoteProviderBindings,
    remoteEvidence,
    remoteInputAttestations,
    remoteEvidenceAdoptions,
    fakeAdapters,
    handoffs,
    hostedAgents,
    limitAnonymous,
    longTermMemory,
    memoryCandidates,
    manualRuns,
    manualExecutionPlans,
    manualTaskWork,
    memberMessageRuns,
    messages,
    operationalMetrics,
    optionalPrincipal,
    pairing,
    pauseDiscussionForInput,
    presence,
    privateCARotation,
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
  registerClientAccessRoutes(routeContext);

  registerTeamRoomRoutes(routeContext);
  registerTaskRoutes(routeContext);
  registerExecutionPlanRoutes(routeContext);
  registerRemoteEvidenceRoutes(routeContext);
  registerResultRoutes(routeContext);
  registerWorkbenchRoutes(routeContext);
  registerRegistryRoutes(routeContext);
  registerHostedAgentRoutes(routeContext);
  registerDevicePairingSessionRoutes(routeContext);
  registerPrivateCARotationRoutes(routeContext);
  registerMessageRoutes(routeContext);
  registerMemoryCandidateRoutes(routeContext);
  registerDiscussionRoutes(routeContext);
  registerRunRoutes(routeContext);

  registerMcpRoutes(routeContext);

  taskClarifications.reconcile(clock());
  const projectionRecovery = runProjections.reconcile(clock());
  if (projectionRecovery.memberMessageFailures.length > 0) {
    app.log.error({
      event: "run.member_message_projection.reconciliation_failed",
      failures: projectionRecovery.memberMessageFailures
    }, "Member Message Run projection reconciliation failed closed");
  }
  if (projectionRecovery.replyProjectionFailures.length > 0) {
    app.log.error({
      event: "run.reply_message_projection.reconciliation_failed",
      failures: projectionRecovery.replyProjectionFailures.map((failure) => ({
        runId: failure.runId,
        replySequence: failure.replySequence,
        errorCode: failure.errorCode,
        candidateCount: failure.candidateCount
      }))
    }, "Run reply Message projection reconciliation failed closed");
  }
  if (projectionRecovery.expiredRuns.length > 0) {
    app.log.info({
      event: "run.member_message_projection.expired",
      runIds: projectionRecovery.expiredRuns.map(({ runId }) => runId)
    }, "Stale Member Message Run projections were restored as expired");
  }
  const cancellationRecovery = cancellations.recover();
  if (
    cancellationRecovery.expiredRunIds.length > 0 ||
    cancellationRecovery.sentRunIds.length > 0
  ) {
    app.log.info({
      event: "run.cancellation.recovered",
      expiredRunIds: cancellationRecovery.expiredRunIds,
      sentRunIds: cancellationRecovery.sentRunIds
    }, "Pending Run cancellation intents were recovered");
  }
  const hostedRecovery = hostedScheduler.recover();
  if (
    hostedRecovery.outcomeUnknownRunIds.length > 0 ||
    hostedRecovery.reconciledRunIds.length > 0
  ) {
    app.log.info({
      event: "run.hosted.recovered",
      outcomeUnknownRunIds: hostedRecovery.outcomeUnknownRunIds,
      reconciledRunIds: hostedRecovery.reconciledRunIds
    }, "Hosted Run invocation intents were recovered");
  }
  const executionRecoveryRuns = executionRecovery.recover(clock());
  for (const run of new Map([
    ...projectionRecovery.queuedRuns,
    ...executionRecoveryRuns
  ].map((candidate) => [candidate.runId, candidate])).values()) {
    await dispatchRun(run);
  }
  if (executionSchedulerSweepMilliseconds > 0) {
    await sweepExecution();
  }
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

  cancellationSweepTimer = setInterval(() => {
    try {
      const sweep = cancellations.sweep();
      if (sweep.expiredRunIds.length > 0 || sweep.sentRunIds.length > 0) {
        app.log.info({
          event: "run.cancellation.swept",
          expiredRunIds: sweep.expiredRunIds,
          sentRunIds: sweep.sentRunIds
        }, "Pending Run cancellation intents were swept");
      }
    } catch (error) {
      app.log.error({
        event: "run.cancellation.sweep_failed",
        error: error instanceof Error ? error.message : "Unexpected error"
      }, "Run cancellation intent sweep failed");
    }
  }, 1_000);
  cancellationSweepTimer.unref();

  if (executionSchedulerSweepMilliseconds > 0) {
    executionSchedulerSweepTimer = setInterval(() => {
      void sweepExecution().catch((error: unknown) => {
        app.log.error({
          event: "execution.scheduler.sweep_failed",
          error: error instanceof Error ? error.message : "Unexpected error"
        }, "Execution scheduler sweep failed");
      });
    }, executionSchedulerSweepMilliseconds);
    executionSchedulerSweepTimer.unref();
  }

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
