// Code generated from JSON Schema; DO NOT EDIT.

/**
 * Fields shared by versioned cross-process messages.
 */
export interface RunActivityMessage {
  messageId: string;
  payload:   RunActivityPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      RunActivityMessageType;
  [property: string]: unknown;
}

export interface RunActivityPayload {
  agentId:    string;
  runId:      string;
  sequence:   number;
  traceId:    string;
  activityId: string;
  content?:   string;
  kind:       string;
  label?:     string;
  phase:      string;
  reset?:     boolean;
}

export type RunActivityMessageType = "run.activity";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface RunOutputDeltaMessage {
  messageId: string;
  payload:   RunOutputDeltaPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      RunOutputDeltaMessageType;
  [property: string]: unknown;
}

export interface RunOutputDeltaPayload {
  agentId:  string;
  runId:    string;
  sequence: number;
  traceId:  string;
  content:  string;
  reset?:   boolean;
  [property: string]: unknown;
}

export type RunOutputDeltaMessageType = "run.output_delta";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface BridgeHelloMessage {
  messageId: string;
  payload:   BridgeHelloPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      BridgeHelloMessageType;
  [property: string]: unknown;
}

export interface BridgeHelloPayload {
  bridgeVersion:             string;
  connectionEpoch:           number;
  deviceId:                  string;
  supportedProtocolVersions: [string, ...string[]];
  /**
   * Whether this connection can authorize and apply central Agent provisioning requests.
   * Omission means unsupported.
   */
  supportsAgentProvisioning?: boolean;
  [property: string]: unknown;
}

export type BridgeHelloMessageType = "bridge.hello";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface BridgeHeartbeatMessage {
  messageId: string;
  payload:   BridgeHeartbeatPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      BridgeHeartbeatMessageType;
  [property: string]: unknown;
}

export interface BridgeHeartbeatPayload {
  connectionEpoch: number;
  deviceId:        string;
  [property: string]: unknown;
}

export type BridgeHeartbeatMessageType = "bridge.heartbeat";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface AgentPublishMessage {
  messageId: string;
  payload:   AgentPublishPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      AgentPublishMessageType;
  [property: string]: unknown;
}

export interface AgentPublishPayload {
  agentId:              string;
  capabilities:         Capabilities;
  deviceId:             string;
  name:                 string;
  ownerMemberId:        string;
  role:                 string;
  runtimePolicy?:       RuntimePolicy;
  runtimeScopeId?:      string;
  teamId:               string;
  workspaceGeneration?: string;
  workspaceRef?:        string;
  [property: string]: unknown;
}

export interface Capabilities {
  invocationMode:                   InvocationMode;
  supportsArtifactMaterialization?: boolean;
  supportsArtifactPublication?:     boolean;
  supportsHandoff:                  boolean;
  supportsInterrupt:                boolean;
  supportsResume:                   boolean;
  supportsRoomContextCoverage?:     boolean;
  supportsStart:                    boolean;
  supportsStreaming:                boolean;
  supportsWorkspaceLeases?:         boolean;
  [property: string]: unknown;
}

export type InvocationMode = "managed" | "manual";

export interface RuntimePolicy {
  filesystemAccess: FilesystemAccess;
}

export type FilesystemAccess = "read-only" | "workspace-write" | "local-policy";

export type AgentPublishMessageType = "agent.publish";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface AgentStatusMessage {
  messageId: string;
  payload:   AgentStatusPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      AgentStatusMessageType;
  [property: string]: unknown;
}

export interface AgentStatusPayload {
  agentId:         string;
  connectionEpoch: number;
  deviceId:        string;
  reason?:         string;
  status:          AgentPresenceStatus;
  [property: string]: unknown;
}

export type AgentPresenceStatus = "ready" | "busy" | "degraded";

export type AgentStatusMessageType = "agent.status";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface AgentProvisionRequestedMessage {
  messageId: string;
  payload:   AgentProvisionRequestedPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      AgentProvisionRequestedMessageType;
  [property: string]: unknown;
}

export interface AgentProvisionRequestedPayload {
  agentId:         string;
  deviceId:        string;
  managementCode:  string;
  name:            string;
  requestId:       string;
  role:            string;
  templateAgentId: string;
}

export type AgentProvisionRequestedMessageType = "agent.provision.requested";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface AgentProvisionResultMessage {
  messageId: string;
  payload:   AgentProvisionResultPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      AgentProvisionResultMessageType;
  [property: string]: unknown;
}

export interface AgentProvisionResultPayload {
  agentId:         string;
  deviceId:        string;
  reason?:         Reason;
  requestId:       string;
  status:          PayloadStatus;
  templateAgentId: string;
}

export type Reason = "provisioning_disabled" | "invalid_code" | "rate_limited" | "busy" | "template_not_found" | "identity_conflict" | "invalid_request" | "configuration_failed";

export type PayloadStatus = "accepted" | "rejected";

export type AgentProvisionResultMessageType = "agent.provision.result";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface RunRequestedMessage {
  messageId: string;
  payload:   RunRequestedPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      RunRequestedMessageType;
  [property: string]: unknown;
}

export interface RunRequestedPayload {
  contextMessages: ContextMessage[];
  contextPlan?:    RuntimeContextPlan;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  deadline:          string;
  deliveryAttemptId: string;
  idempotencyKey:    string;
  instruction:       string;
  parentRunId?:      string;
  requesterMemberId: string;
  /**
   * Server-owned coverage ending with one separate current request. Bridge derives
   * session-local consumption from this bundle.
   */
  roomContextBundle?: ServerRoomContextBundle;
  roomId:             string;
  routingAgents?:     RoutingAgent[];
  runId:              string;
  session?:           LogicalSessionRequest;
  targetAgentId:      string;
  targetAgentName?:   string;
  taskId?:            string;
  traceId:            string;
  triggerMessageId:   string;
  [property: string]: unknown;
}

export interface ContextMessage {
  content:   string;
  messageId: string;
  /**
   * Opaque identifier with a lowercase type prefix and non-semantic suffix.
   */
  senderId:    string;
  senderName?: string;
  sequence?:   number;
  [property: string]: unknown;
}

export interface RuntimeContextPlan {
  longTermMemory?: LongTermProvenanceMemoryPlan;
  resultEvidence?: TaskResultEvidence;
  roomMemory?:     RoomMemoryClass;
  taskMemory?:     TaskMemoryClass;
}

export interface LongTermProvenanceMemoryPlan {
  room?: RoomClass;
  task?: TaskClass;
}

export interface RoomClass {
  activeComplete: boolean;
  entries:        [RoomProvenanceMemoryEntry, ...RoomProvenanceMemoryEntry[]];
  revision:       number;
}

export interface RoomProvenanceMemoryEntry {
  content:             string;
  memoryId:            string;
  revision:            number;
  sourceArtifactIds:   [string, ...string[]];
  sourceDiscussionIds: [string, ...string[]];
  sourceMessageIds:    [string, ...string[]];
  sourceRunIds:        [string, ...string[]];
  state:               State;
  supersedesMemoryId?: string;
  type:                ProvenanceMemoryEntryType;
}

export type State = "active" | "superseded" | "retracted";

export type ProvenanceMemoryEntryType = "decision" | "constraint" | "fact" | "open_question" | "convention" | "goal" | "acceptance_criterion" | "plan" | "progress" | "blocker" | "result";

export interface TaskClass {
  activeComplete: boolean;
  entries:        [TaskProvenanceMemoryEntry, ...TaskProvenanceMemoryEntry[]];
  revision:       number;
}

export interface TaskProvenanceMemoryEntry {
  content:             string;
  memoryId:            string;
  revision:            number;
  sourceArtifactIds:   [string, ...string[]];
  sourceDiscussionIds: [string, ...string[]];
  sourceMessageIds:    [string, ...string[]];
  sourceRunIds:        [string, ...string[]];
  state:               State;
  supersedesMemoryId?: string;
  type:                ProvenanceMemoryEntryType;
}

export interface TaskResultEvidence {
  artifactRefs:     [ArtifactReference, ...ArtifactReference[]];
  deliveryKind?:    DeliveryKind;
  fromRevision?:    number;
  hasMore?:         boolean;
  revision:         number;
  throughRevision?: number;
}

export interface ArtifactReference {
  artifactId:        string;
  artifactRevision?: number;
  branch?:           string;
  commitSha?:        string;
  /**
   * Immutable content metadata and a path-free logical alias pinned into one Run delivery.
   */
  content?: PinnedArtifactContent;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  createdAt:          string;
  createdByAgentId?:  string;
  createdByMemberId?: string;
  path?:              string;
  relations?:         ArtifactRelationReference[];
  repository?:        string;
  sourceRunId?:       string;
  summary:            string;
  title:              string;
  type:               ArtifactReferenceType;
  workspaceRef?:      string;
}

/**
 * Immutable content metadata and a path-free logical alias pinned into one Run delivery.
 */
export interface PinnedArtifactContent {
  contentId:    string;
  logicalAlias: string;
  mediaType:    MediaType;
  sha256:       string;
  sizeBytes:    number;
}

export type MediaType = "text/x-diff" | "text/markdown" | "application/json";

/**
 * Immutable lineage from the containing source Artifact to older Task evidence.
 */
export interface ArtifactRelationReference {
  relationId:       string;
  targetArtifactId: string;
  type:             RelationType;
}

export type RelationType = "derives_from" | "reviews" | "verifies";

export type ArtifactReferenceType = "commit" | "branch" | "file" | "patch" | "test_result" | "document";

export type DeliveryKind = "bootstrap" | "delta";

export interface RoomMemoryClass {
  projectionKind?:  ProjectionKind;
  revision:         number;
  sourceCursor:     number;
  sourceMessageIds: string[];
  summary:          string;
}

export type ProjectionKind = "canonical" | "historical";

export interface TaskMemoryClass {
  projectionKind?:  ProjectionKind;
  revision:         number;
  sourceCursor:     number;
  sourceMessageIds: string[];
  summary:          string;
}

/**
 * Server-owned coverage ending with one separate current request. Bridge derives
 * session-local consumption from this bundle.
 */
export interface ServerRoomContextBundle {
  checkpoint?:                 RollingRoomCheckpoint;
  priorContextThroughSequence: number;
  rawTail:                     RoomContextRawTail;
  requestMessageId:            string;
  targetThroughSequence:       number;
}

export interface RollingRoomCheckpoint {
  buildKind:             BuildKind;
  checkpointId:          string;
  fromSequenceExclusive: number;
  modelFingerprint:      string;
  promptVersion:         string;
  provenanceMessageIds:  [string, ...string[]];
  sourceDigest:          string;
  sourceMessageCount:    number;
  summary:               string;
  throughSequence:       number;
}

export type BuildKind = "incremental" | "rebase";

export interface RoomContextRawTail {
  fromSequenceExclusive:    number;
  messageCount:             number;
  messages:                 Message[];
  throughSequenceInclusive: number;
  utf8Bytes:                number;
}

export interface Message {
  content:   string;
  messageId: string;
  /**
   * Opaque identifier with a lowercase type prefix and non-semantic suffix.
   */
  senderId:    string;
  senderName?: string;
  sequence?:   number;
  [property: string]: unknown;
}

export interface RoutingAgent {
  agentId: string;
  name:    string;
}

export interface LogicalSessionRequest {
  contextCursor:   number;
  resumePolicy:    ResumePolicy;
  runtimeScopeId?: string;
  scope:           Scope;
}

export type ResumePolicy = "resume_or_start" | "start_new";

export type Scope = "task";

export type RunRequestedMessageType = "run.requested";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface RunAcceptedMessage {
  messageId: string;
  payload:   RunAcceptedPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      RunAcceptedMessageType;
  [property: string]: unknown;
}

export interface RunAcceptedPayload {
  agentId:  string;
  runId:    string;
  sequence: number;
  traceId:  string;
  /**
   * Non-retryable negative acknowledgement when pinned Artifact content cannot be verified
   * before Runtime admission.
   */
  artifactMaterializationError?: ArtifactMaterializationError;
  artifactMaterializations?:     VerifiedArtifactMaterializationReceipt[];
  [property: string]: unknown;
}

/**
 * Non-retryable negative acknowledgement when pinned Artifact content cannot be verified
 * before Runtime admission.
 */
export interface ArtifactMaterializationError {
  code:      string;
  message:   string;
  retryable: boolean;
}

/**
 * Bridge-owned receipt for verified isolated staging; it never contains a local path.
 */
export interface VerifiedArtifactMaterializationReceipt {
  artifactId:           string;
  contentId:            string;
  logicalAlias:         string;
  materializationState: MaterializationState;
  mediaType:            MediaType;
  sha256:               string;
  sizeBytes:            number;
}

export type MaterializationState = "verified" | "reused";

export type RunAcceptedMessageType = "run.accepted";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface RunStatusMessage {
  messageId: string;
  payload:   RunStatusPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      RunStatusMessageType;
  [property: string]: unknown;
}

export interface RunStatusPayload {
  agentId:        string;
  runId:          string;
  sequence:       number;
  traceId:        string;
  clarification?: TaskClarificationRequest;
  /**
   * Stable, client-safe error returned at a protocol boundary.
   */
  error?:   AgentRoomError;
  session?: LogicalSessionStatus;
  status:   RunExecutionStatus;
  [property: string]: unknown;
}

export interface TaskClarificationRequest {
  choices?: [string, string, ...string[]];
  kind:     Scope;
  question: string;
}

/**
 * Stable, client-safe error returned at a protocol boundary.
 */
export interface AgentRoomError {
  code:      string;
  details?:  { [key: string]: unknown };
  message:   string;
  retryable: boolean;
  [property: string]: unknown;
}

export interface LogicalSessionStatus {
  contextCursor:           number;
  disposition:             Disposition;
  resultEvidenceRevision?: number;
  /**
   * Bridge-owned receipt for the exact checkpoint and raw interval accepted by one logical
   * Runtime session.
   */
  roomContextConsumption?: BridgeRoomContextConsumption;
  runtimeScopeId?:         string;
}

export type Disposition = "started" | "resumed" | "recreated";

/**
 * Bridge-owned receipt for the exact checkpoint and raw interval accepted by one logical
 * Runtime session.
 */
export interface BridgeRoomContextConsumption {
  baseContextCursor:           number;
  checkpointId?:               string;
  coverageThroughSequence:     number;
  rawFromSequenceExclusive:    number;
  rawMessageCount:             number;
  rawThroughSequenceInclusive: number;
}

export type RunExecutionStatus = "working" | "input_required" | "completed" | "failed" | "canceled" | "outcome_unknown";

export type RunStatusMessageType = "run.status";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface RunReplyMessage {
  messageId: string;
  payload:   RunReplyPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      RunReplyMessageType;
  [property: string]: unknown;
}

export interface RunReplyPayload {
  agentId:     string;
  runId:       string;
  sequence:    number;
  traceId:     string;
  assessment?: Assessment;
  content:     string;
  [property: string]: unknown;
}

export interface Assessment {
  confidence?:            number;
  disagreementRemaining?: DisagreementRemaining;
  goalSatisfied?:         boolean;
  newEvidenceRefs?:       string[];
  newInformationAdded?:   boolean;
  openQuestions?:         OpenQuestion[];
  recommendation?:        Recommendation;
  resolvedQuestionIds?:   string[];
  reviewerApproved?:      boolean;
}

export type DisagreementRemaining = "none" | "low" | "medium" | "high";

export interface OpenQuestion {
  id:         string;
  importance: Importance;
  question:   string;
}

export type Importance = "low" | "medium" | "high";

export type Recommendation = "continue" | "finish" | "wait_human";

export type RunReplyMessageType = "run.reply";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface RunCancelRequestedMessage {
  messageId: string;
  payload:   RunCancelRequestedPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      RunCancelRequestedMessageType;
  [property: string]: unknown;
}

export interface RunCancelRequestedPayload {
  agentId: string;
  reason:  string;
  runId:   string;
  traceId: string;
  [property: string]: unknown;
}

export type RunCancelRequestedMessageType = "run.cancel_requested";

/**
 * Fields shared by versioned cross-process messages.
 */
export interface RunHandoffRequestedMessage {
  messageId: string;
  payload:   RunHandoffRequestedPayload;
  /**
   * Major and minor protocol version negotiated by peers.
   */
  protocolVersion: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  timestamp: string;
  type:      RunHandoffRequestedMessageType;
  [property: string]: unknown;
}

export interface RunHandoffRequestedPayload {
  agentId:       string;
  runId:         string;
  sequence:      number;
  traceId:       string;
  handoffId:     string;
  summary:       string;
  targetAgentId: string;
  [property: string]: unknown;
}

export type RunHandoffRequestedMessageType = "run.handoff_requested";

export interface BridgeJoinRequest {
  agentName:  string;
  agentRole:  string;
  deviceName: string;
}

export interface BridgeJoinChallenge {
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  expiresAt: string;
  /**
   * Opaque identifier with a lowercase type prefix and non-semantic suffix.
   */
  joinRequestId:  string;
  pollIntervalMs: number;
  pollToken:      string;
  userCode:       string;
}

export interface BridgeJoinApprovalRequest {
  code: string;
}

export interface BridgeJoinApproval {
  agentName:  string;
  agentRole:  string;
  deviceName: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  expiresAt: string;
  /**
   * Opaque identifier with a lowercase type prefix and non-semantic suffix.
   */
  joinRequestId: string;
  status:        BridgeJoinApprovalStatus;
}

export type BridgeJoinApprovalStatus = "approved";

export interface BridgeJoinClaimRequest {
  pollToken: string;
}

export interface BridgeJoinPending {
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  expiresAt: string;
  status:    BridgeJoinPendingStatus;
}

export type BridgeJoinPendingStatus = "pending";

export interface BridgeJoinPaired {
  credential: Credential;
  device:     Device;
  status:     BridgeJoinPairedStatus;
}

export interface Credential {
  expiresAt: null | string;
  token:     string;
}

export interface Device {
  deviceId:      string;
  ownerMemberId: string;
  teamId:        string;
  [property: string]: unknown;
}

export type BridgeJoinPairedStatus = "paired";

export type BridgeMessage =
  | RunActivityMessage
  | RunOutputDeltaMessage
  | BridgeHelloMessage
  | BridgeHeartbeatMessage
  | AgentPublishMessage
  | AgentStatusMessage
  | AgentProvisionRequestedMessage
  | AgentProvisionResultMessage
  | RunRequestedMessage
  | RunAcceptedMessage
  | RunStatusMessage
  | RunReplyMessage
  | RunCancelRequestedMessage
  | RunHandoffRequestedMessage;
