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
  agentId:       string;
  capabilities:  Capabilities;
  deviceId:      string;
  name:          string;
  ownerMemberId: string;
  role:          string;
  teamId:        string;
  [property: string]: unknown;
}

export interface Capabilities {
  invocationMode:    InvocationMode;
  supportsHandoff:   boolean;
  supportsInterrupt: boolean;
  supportsResume:    boolean;
  supportsStart:     boolean;
  supportsStreaming: boolean;
  [property: string]: unknown;
}

export type InvocationMode = "managed" | "manual";

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
  roomId:            string;
  routingAgents?:    RoutingAgent[];
  runId:             string;
  session?:          LogicalSessionRequest;
  targetAgentId:     string;
  targetAgentName?:  string;
  taskId?:           string;
  traceId:           string;
  triggerMessageId:  string;
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
  resultEvidence?: TaskResultEvidence;
  roomMemory?:     RoomMemoryClass;
  taskMemory?:     TaskMemoryClass;
}

export interface TaskResultEvidence {
  artifactRefs: [ArtifactReference, ...ArtifactReference[]];
  revision:     number;
}

export interface ArtifactReference {
  artifactId: string;
  branch?:    string;
  commitSha?: string;
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  createdAt:          string;
  createdByAgentId?:  string;
  createdByMemberId?: string;
  path?:              string;
  repository?:        string;
  sourceRunId?:       string;
  summary:            string;
  title:              string;
  type:               ArtifactReferenceType;
  workspaceRef?:      string;
}

export type ArtifactReferenceType = "commit" | "branch" | "file" | "patch" | "test_result" | "document";

export interface RoomMemoryClass {
  revision:         number;
  sourceCursor:     number;
  sourceMessageIds: string[];
  summary:          string;
}

export interface TaskMemoryClass {
  revision:         number;
  sourceCursor:     number;
  sourceMessageIds: string[];
  summary:          string;
}

export interface RoutingAgent {
  agentId: string;
  name:    string;
}

export interface LogicalSessionRequest {
  contextCursor: number;
  resumePolicy:  ResumePolicy;
  scope:         Scope;
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
  [property: string]: unknown;
}

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
  agentId:  string;
  runId:    string;
  sequence: number;
  traceId:  string;
  /**
   * Stable, client-safe error returned at a protocol boundary.
   */
  error?:   AgentRoomError;
  session?: LogicalSessionStatus;
  status:   RunExecutionStatus;
  [property: string]: unknown;
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
  contextCursor: number;
  disposition:   Disposition;
}

export type Disposition = "started" | "resumed" | "recreated";

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
  | RunRequestedMessage
  | RunAcceptedMessage
  | RunStatusMessage
  | RunReplyMessage
  | RunCancelRequestedMessage
  | RunHandoffRequestedMessage;
