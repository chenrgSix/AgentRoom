import type { FastifyInstance, FastifyRequest } from "fastify";

import type { BridgeConnectionRegistry } from "../bridge/bridge-connection-registry.js";
import type { CoreRepository } from "../data/core-repository.js";
import type { DiscussionOrchestrator } from "../discussion/discussion-orchestrator.js";
import type { DiscussionRepository } from "../discussion/discussion-repository.js";
import type { TeamWaitService } from "../mcp/team-wait-service.js";
import type { OperationalMetrics } from "../observability/operational-metrics.js";
import type { TraceRepository } from "../observability/trace-repository.js";
import type { AgentService } from "../registry/agent-service.js";
import type { MemberDeviceService } from "../registry/member-device-service.js";
import type { PresenceService } from "../registry/presence-service.js";
import type { BridgeRunEventService } from "../run/bridge-run-event-service.js";
import type { CancellationService } from "../run/cancellation-service.js";
import type { DeliveryService } from "../run/delivery-service.js";
import type { HandoffService } from "../run/handoff-service.js";
import type { ManualRunService } from "../run/manual-run-service.js";
import type { RunRepository } from "../run/run-repository.js";
import type { RunService } from "../run/run-service.js";
import type { FakeRuntimeAdapter } from "../runtime/fake-runtime-adapter.js";
import type { InProcessRunExecutor } from "../runtime/in-process-run-executor.js";
import type {
  AuthService,
  WebPrincipal
} from "../security/auth-service.js";
import type { BridgePairingService } from "../security/bridge-pairing-service.js";
import type { TrustedWebAccessService } from "../security/trusted-web-access-service.js";
import type { WebAuthConfiguration } from "../security/web-auth-config.js";
import type { MessageService } from "../team-room/message-service.js";
import type { TeamChangeService } from "../team-room/team-change-service.js";
import type { TeamRoomService } from "../team-room/team-room-service.js";
import type { AgentTaskService } from "../task/agent-task-service.js";
import type { TaskArtifactService } from "../task/task-artifact-service.js";
import type { TaskClarificationService } from "../task/task-clarification-service.js";

export type PersistedRun = NonNullable<ReturnType<RunRepository["getRun"]>>;

export interface ServerRouteContext {
  app: FastifyInstance;
  advanceDiscussion: (runId: string) => Promise<void>;
  agents: AgentService;
  auth: AuthService;
  bridgeConnections: BridgeConnectionRegistry;
  bridgeRunEvents: BridgeRunEventService;
  cancellations: CancellationService;
  clock: () => string;
  core: CoreRepository;
  delivery: DeliveryService;
  discussions: DiscussionOrchestrator;
  discussionRepository: DiscussionRepository;
  dispatchDiscussionRuns: (runs: PersistedRun[]) => Promise<void>;
  executor: InProcessRunExecutor;
  fakeAdapters: Map<string, FakeRuntimeAdapter>;
  handoffs: HandoffService;
  limitAnonymous: (request: FastifyRequest, bucket: string) => void;
  manualRuns: ManualRunService;
  messages: MessageService;
  operationalMetrics: OperationalMetrics;
  optionalPrincipal: (request: FastifyRequest) => WebPrincipal | undefined;
  pairing: BridgePairingService;
  pauseDiscussionForInput: (runId: string) => Promise<void>;
  presence: PresenceService;
  principal: (request: FastifyRequest) => WebPrincipal;
  registry: MemberDeviceService;
  requireBridgeServerToken: (request: FastifyRequest) => void;
  requireTrustedOrigin: (request: FastifyRequest) => void;
  routeAgentReplyMentions: (runId: string) => Promise<void>;
  runRepository: RunRepository;
  runs: RunService;
  taskArtifacts: TaskArtifactService;
  taskClarifications: TaskClarificationService;
  tasks: AgentTaskService;
  teamChanges: TeamChangeService;
  teamRooms: TeamRoomService;
  teamWait: TeamWaitService;
  traces: TraceRepository;
  trustedWeb?: TrustedWebAccessService;
  webAuth: WebAuthConfiguration;
}
