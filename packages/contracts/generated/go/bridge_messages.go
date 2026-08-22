// Code generated from JSON Schema; DO NOT EDIT.

package contracts

import "time"

// Fields shared by versioned cross-process messages.
type BridgeHelloMessage struct {
	MessageID string             `json:"messageId"`
	Payload   BridgeHelloPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time              `json:"timestamp"`
	Type      BridgeHelloMessageType `json:"type"`
}

type BridgeHelloPayload struct {
	BridgeVersion             string   `json:"bridgeVersion"`
	ConnectionEpoch           int64    `json:"connectionEpoch"`
	DeviceID                  string   `json:"deviceId"`
	SupportedProtocolVersions []string `json:"supportedProtocolVersions"`
}

// Fields shared by versioned cross-process messages.
type BridgeHeartbeatMessage struct {
	MessageID string                 `json:"messageId"`
	Payload   BridgeHeartbeatPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time                  `json:"timestamp"`
	Type      BridgeHeartbeatMessageType `json:"type"`
}

type BridgeHeartbeatPayload struct {
	ConnectionEpoch int64  `json:"connectionEpoch"`
	DeviceID        string `json:"deviceId"`
}

// Fields shared by versioned cross-process messages.
type AgentPublishMessage struct {
	MessageID string              `json:"messageId"`
	Payload   AgentPublishPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time               `json:"timestamp"`
	Type      AgentPublishMessageType `json:"type"`
}

type AgentPublishPayload struct {
	AgentID       string       `json:"agentId"`
	Capabilities  Capabilities `json:"capabilities"`
	DeviceID      string       `json:"deviceId"`
	Name          string       `json:"name"`
	OwnerMemberID string       `json:"ownerMemberId"`
	Role          string       `json:"role"`
	TeamID        string       `json:"teamId"`
}

type Capabilities struct {
	InvocationMode    InvocationMode `json:"invocationMode"`
	SupportsHandoff   bool           `json:"supportsHandoff"`
	SupportsInterrupt bool           `json:"supportsInterrupt"`
	SupportsResume    bool           `json:"supportsResume"`
	SupportsStart     bool           `json:"supportsStart"`
	SupportsStreaming bool           `json:"supportsStreaming"`
}

// Fields shared by versioned cross-process messages.
type AgentStatusMessage struct {
	MessageID string             `json:"messageId"`
	Payload   AgentStatusPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time              `json:"timestamp"`
	Type      AgentStatusMessageType `json:"type"`
}

type AgentStatusPayload struct {
	AgentID         string              `json:"agentId"`
	ConnectionEpoch int64               `json:"connectionEpoch"`
	DeviceID        string              `json:"deviceId"`
	Reason          *string             `json:"reason,omitempty"`
	Status          AgentPresenceStatus `json:"status"`
}

// Fields shared by versioned cross-process messages.
type RunRequestedMessage struct {
	MessageID string              `json:"messageId"`
	Payload   RunRequestedPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time               `json:"timestamp"`
	Type      RunRequestedMessageType `json:"type"`
}

type RunRequestedPayload struct {
	ContextMessages []ContextMessage `json:"contextMessages"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Deadline          time.Time `json:"deadline"`
	Instruction       string    `json:"instruction"`
	ParentRunID       *string   `json:"parentRunId,omitempty"`
	RequesterMemberID string    `json:"requesterMemberId"`
	RoomID            string    `json:"roomId"`
	RunID             string    `json:"runId"`
	TargetAgentID     string    `json:"targetAgentId"`
	TriggerMessageID  string    `json:"triggerMessageId"`
}

type ContextMessage struct {
	Content   string `json:"content"`
	MessageID string `json:"messageId"`
	// Opaque identifier with a lowercase type prefix and non-semantic suffix.
	SenderID string `json:"senderId"`
}

// Fields shared by versioned cross-process messages.
type RunAcceptedMessage struct {
	MessageID string             `json:"messageId"`
	Payload   RunAcceptedPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time              `json:"timestamp"`
	Type      RunAcceptedMessageType `json:"type"`
}

type RunAcceptedPayload struct {
	AgentID  string `json:"agentId"`
	RunID    string `json:"runId"`
	Sequence int64  `json:"sequence"`
}

// Fields shared by versioned cross-process messages.
type RunStatusMessage struct {
	MessageID string           `json:"messageId"`
	Payload   RunStatusPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time            `json:"timestamp"`
	Type      RunStatusMessageType `json:"type"`
}

type RunStatusPayload struct {
	AgentID  string `json:"agentId"`
	RunID    string `json:"runId"`
	Sequence int64  `json:"sequence"`
	// Stable, client-safe error returned at a protocol boundary.
	Error  *AgentRoomError    `json:"error,omitempty"`
	Status RunExecutionStatus `json:"status"`
}

// Stable, client-safe error returned at a protocol boundary.
type AgentRoomError struct {
	Code      string                 `json:"code"`
	Details   map[string]interface{} `json:"details,omitempty"`
	Message   string                 `json:"message"`
	Retryable bool                   `json:"retryable"`
}

// Fields shared by versioned cross-process messages.
type RunReplyMessage struct {
	MessageID string          `json:"messageId"`
	Payload   RunReplyPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time           `json:"timestamp"`
	Type      RunReplyMessageType `json:"type"`
}

type RunReplyPayload struct {
	AgentID  string `json:"agentId"`
	RunID    string `json:"runId"`
	Sequence int64  `json:"sequence"`
	Content  string `json:"content"`
}

// Fields shared by versioned cross-process messages.
type RunCancelRequestedMessage struct {
	MessageID string                    `json:"messageId"`
	Payload   RunCancelRequestedPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time                     `json:"timestamp"`
	Type      RunCancelRequestedMessageType `json:"type"`
}

type RunCancelRequestedPayload struct {
	AgentID string `json:"agentId"`
	Reason  string `json:"reason"`
	RunID   string `json:"runId"`
}

// Fields shared by versioned cross-process messages.
type RunHandoffRequestedMessage struct {
	MessageID string                     `json:"messageId"`
	Payload   RunHandoffRequestedPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time                      `json:"timestamp"`
	Type      RunHandoffRequestedMessageType `json:"type"`
}

type RunHandoffRequestedPayload struct {
	AgentID       string `json:"agentId"`
	RunID         string `json:"runId"`
	Sequence      int64  `json:"sequence"`
	HandoffID     string `json:"handoffId"`
	Summary       string `json:"summary"`
	TargetAgentID string `json:"targetAgentId"`
}

type BridgeHelloMessageType string

const (
	BridgeHello BridgeHelloMessageType = "bridge.hello"
)

type BridgeHeartbeatMessageType string

const (
	BridgeHeartbeat BridgeHeartbeatMessageType = "bridge.heartbeat"
)

type InvocationMode string

const (
	Managed InvocationMode = "managed"
	Manual  InvocationMode = "manual"
)

type AgentPublishMessageType string

const (
	AgentPublish AgentPublishMessageType = "agent.publish"
)

type AgentPresenceStatus string

const (
	Busy     AgentPresenceStatus = "busy"
	Degraded AgentPresenceStatus = "degraded"
	Ready    AgentPresenceStatus = "ready"
)

type AgentStatusMessageType string

const (
	AgentStatus AgentStatusMessageType = "agent.status"
)

type RunRequestedMessageType string

const (
	RunRequested RunRequestedMessageType = "run.requested"
)

type RunAcceptedMessageType string

const (
	RunAccepted RunAcceptedMessageType = "run.accepted"
)

type RunExecutionStatus string

const (
	Canceled       RunExecutionStatus = "canceled"
	Completed      RunExecutionStatus = "completed"
	Failed         RunExecutionStatus = "failed"
	InputRequired  RunExecutionStatus = "input_required"
	OutcomeUnknown RunExecutionStatus = "outcome_unknown"
	Working        RunExecutionStatus = "working"
)

type RunStatusMessageType string

const (
	RunStatus RunStatusMessageType = "run.status"
)

type RunReplyMessageType string

const (
	RunReply RunReplyMessageType = "run.reply"
)

type RunCancelRequestedMessageType string

const (
	RunCancelRequested RunCancelRequestedMessageType = "run.cancel_requested"
)

type RunHandoffRequestedMessageType string

const (
	RunHandoffRequested RunHandoffRequestedMessageType = "run.handoff_requested"
)
