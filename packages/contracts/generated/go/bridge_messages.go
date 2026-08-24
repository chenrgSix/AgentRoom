// Code generated from JSON Schema; DO NOT EDIT.

package contracts

import "time"

// Fields shared by versioned cross-process messages.
type RunOutputDeltaMessage struct {
	MessageID string                `json:"messageId"`
	Payload   RunOutputDeltaPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time                 `json:"timestamp"`
	Type      RunOutputDeltaMessageType `json:"type"`
}

type RunOutputDeltaPayload struct {
	AgentID  string `json:"agentId"`
	RunID    string `json:"runId"`
	Sequence int64  `json:"sequence"`
	TraceID  string `json:"traceId"`
	Content  string `json:"content"`
	Reset    *bool  `json:"reset,omitempty"`
}

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
	DeliveryAttemptID string    `json:"deliveryAttemptId"`
	IdempotencyKey    string    `json:"idempotencyKey"`
	Instruction       string    `json:"instruction"`
	ParentRunID       *string   `json:"parentRunId,omitempty"`
	RequesterMemberID string    `json:"requesterMemberId"`
	RoomID            string    `json:"roomId"`
	RunID             string    `json:"runId"`
	TargetAgentID     string    `json:"targetAgentId"`
	TraceID           string    `json:"traceId"`
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
	TraceID  string `json:"traceId"`
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
	TraceID  string `json:"traceId"`
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
	AgentID    string      `json:"agentId"`
	RunID      string      `json:"runId"`
	Sequence   int64       `json:"sequence"`
	TraceID    string      `json:"traceId"`
	Assessment *Assessment `json:"assessment,omitempty"`
	Content    string      `json:"content"`
}

type Assessment struct {
	Confidence            *float64               `json:"confidence,omitempty"`
	DisagreementRemaining *DisagreementRemaining `json:"disagreementRemaining,omitempty"`
	GoalSatisfied         *bool                  `json:"goalSatisfied,omitempty"`
	NewEvidenceRefs       []string               `json:"newEvidenceRefs,omitempty"`
	NewInformationAdded   *bool                  `json:"newInformationAdded,omitempty"`
	OpenQuestions         []OpenQuestion         `json:"openQuestions,omitempty"`
	Recommendation        *Recommendation        `json:"recommendation,omitempty"`
	ResolvedQuestionIDS   []string               `json:"resolvedQuestionIds,omitempty"`
	ReviewerApproved      *bool                  `json:"reviewerApproved,omitempty"`
}

type OpenQuestion struct {
	ID         string     `json:"id"`
	Importance Importance `json:"importance"`
	Question   string     `json:"question"`
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
	TraceID string `json:"traceId"`
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
	TraceID       string `json:"traceId"`
	HandoffID     string `json:"handoffId"`
	Summary       string `json:"summary"`
	TargetAgentID string `json:"targetAgentId"`
}

type BridgeJoinRequest struct {
	AgentName  string `json:"agentName"`
	AgentRole  string `json:"agentRole"`
	DeviceName string `json:"deviceName"`
}

type BridgeJoinChallenge struct {
	// RFC 3339 date-time normalized to the UTC Z suffix.
	ExpiresAt time.Time `json:"expiresAt"`
	// Opaque identifier with a lowercase type prefix and non-semantic suffix.
	JoinRequestID  string `json:"joinRequestId"`
	PollIntervalMS int64  `json:"pollIntervalMs"`
	PollToken      string `json:"pollToken"`
	UserCode       string `json:"userCode"`
}

type BridgeJoinApprovalRequest struct {
	Code string `json:"code"`
}

type BridgeJoinApproval struct {
	AgentName  string `json:"agentName"`
	AgentRole  string `json:"agentRole"`
	DeviceName string `json:"deviceName"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	ExpiresAt time.Time `json:"expiresAt"`
	// Opaque identifier with a lowercase type prefix and non-semantic suffix.
	JoinRequestID string                   `json:"joinRequestId"`
	Status        BridgeJoinApprovalStatus `json:"status"`
}

type BridgeJoinClaimRequest struct {
	PollToken string `json:"pollToken"`
}

type BridgeJoinPending struct {
	// RFC 3339 date-time normalized to the UTC Z suffix.
	ExpiresAt time.Time               `json:"expiresAt"`
	Status    BridgeJoinPendingStatus `json:"status"`
}

type BridgeJoinPaired struct {
	Credential Credential             `json:"credential"`
	Device     Device                 `json:"device"`
	Status     BridgeJoinPairedStatus `json:"status"`
}

type Credential struct {
	ExpiresAt *time.Time `json:"expiresAt"`
	Token     string     `json:"token"`
}

type Device struct {
	DeviceID      string `json:"deviceId"`
	OwnerMemberID string `json:"ownerMemberId"`
	TeamID        string `json:"teamId"`
}

type RunOutputDeltaMessageType string

const (
	RunOutputDelta RunOutputDeltaMessageType = "run.output_delta"
)

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

type DisagreementRemaining string

const (
	DisagreementRemainingHigh   DisagreementRemaining = "high"
	DisagreementRemainingLow    DisagreementRemaining = "low"
	DisagreementRemainingMedium DisagreementRemaining = "medium"
	None                        DisagreementRemaining = "none"
)

type Importance string

const (
	ImportanceHigh   Importance = "high"
	ImportanceLow    Importance = "low"
	ImportanceMedium Importance = "medium"
)

type Recommendation string

const (
	Continue  Recommendation = "continue"
	Finish    Recommendation = "finish"
	WaitHuman Recommendation = "wait_human"
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

type BridgeJoinApprovalStatus string

const (
	Approved BridgeJoinApprovalStatus = "approved"
)

type BridgeJoinPendingStatus string

const (
	Pending BridgeJoinPendingStatus = "pending"
)

type BridgeJoinPairedStatus string

const (
	Paired BridgeJoinPairedStatus = "paired"
)
