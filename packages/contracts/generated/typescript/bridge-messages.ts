// Code generated from JSON Schema; DO NOT EDIT.

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
  /**
   * RFC 3339 date-time normalized to the UTC Z suffix.
   */
  deadline:          string;
  instruction:       string;
  parentRunId?:      string;
  requesterMemberId: string;
  roomId:            string;
  runId:             string;
  targetAgentId:     string;
  triggerMessageId:  string;
  [property: string]: unknown;
}

export interface ContextMessage {
  content:   string;
  messageId: string;
  /**
   * Opaque identifier with a lowercase type prefix and non-semantic suffix.
   */
  senderId: string;
  [property: string]: unknown;
}

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
  /**
   * Stable, client-safe error returned at a protocol boundary.
   */
  error?: AgentRoomError;
  status: RunExecutionStatus;
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
  agentId:  string;
  runId:    string;
  sequence: number;
  content:  string;
  [property: string]: unknown;
}

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
  handoffId:     string;
  summary:       string;
  targetAgentId: string;
  [property: string]: unknown;
}

export type RunHandoffRequestedMessageType = "run.handoff_requested";

export type BridgeMessage =
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
