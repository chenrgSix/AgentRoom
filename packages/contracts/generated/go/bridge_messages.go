// Code generated from JSON Schema; DO NOT EDIT.

package contracts

import "time"

// Fields shared by versioned cross-process messages.
type RunActivityMessage struct {
	MessageID string             `json:"messageId"`
	Payload   RunActivityPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time              `json:"timestamp"`
	Type      RunActivityMessageType `json:"type"`
}

type RunActivityPayload struct {
	AgentID    string  `json:"agentId"`
	RunID      string  `json:"runId"`
	Sequence   int64   `json:"sequence"`
	TraceID    string  `json:"traceId"`
	ActivityID string  `json:"activityId"`
	Content    *string `json:"content,omitempty"`
	Kind       string  `json:"kind"`
	Label      *string `json:"label,omitempty"`
	Phase      string  `json:"phase"`
	Reset      *bool   `json:"reset,omitempty"`
}

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
	ContextMessages []ContextMessage    `json:"contextMessages"`
	ContextPlan     *RuntimeContextPlan `json:"contextPlan,omitempty"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Deadline          time.Time              `json:"deadline"`
	DeliveryAttemptID string                 `json:"deliveryAttemptId"`
	IdempotencyKey    string                 `json:"idempotencyKey"`
	Instruction       string                 `json:"instruction"`
	ParentRunID       *string                `json:"parentRunId,omitempty"`
	RequesterMemberID string                 `json:"requesterMemberId"`
	RoomID            string                 `json:"roomId"`
	RoutingAgents     []RoutingAgent         `json:"routingAgents,omitempty"`
	RunID             string                 `json:"runId"`
	Session           *LogicalSessionRequest `json:"session,omitempty"`
	TargetAgentID     string                 `json:"targetAgentId"`
	TargetAgentName   *string                `json:"targetAgentName,omitempty"`
	TaskID            *string                `json:"taskId,omitempty"`
	TraceID           string                 `json:"traceId"`
	TriggerMessageID  string                 `json:"triggerMessageId"`
}

type ContextMessage struct {
	Content   string `json:"content"`
	MessageID string `json:"messageId"`
	// Opaque identifier with a lowercase type prefix and non-semantic suffix.
	SenderID   string  `json:"senderId"`
	SenderName *string `json:"senderName,omitempty"`
	Sequence   *int64  `json:"sequence,omitempty"`
}

type RuntimeContextPlan struct {
	ResultEvidence *TaskResultEvidence `json:"resultEvidence,omitempty"`
	RoomMemory     *RoomMemoryClass    `json:"roomMemory,omitempty"`
	TaskMemory     *TaskMemoryClass    `json:"taskMemory,omitempty"`
}

type TaskResultEvidence struct {
	ArtifactRefs []ArtifactReference `json:"artifactRefs"`
	Revision     int64               `json:"revision"`
}

type ArtifactReference struct {
	ArtifactID string  `json:"artifactId"`
	Branch     *string `json:"branch,omitempty"`
	CommitSHA  *string `json:"commitSha,omitempty"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	CreatedAt         time.Time             `json:"createdAt"`
	CreatedByAgentID  *string               `json:"createdByAgentId,omitempty"`
	CreatedByMemberID *string               `json:"createdByMemberId,omitempty"`
	Path              *string               `json:"path,omitempty"`
	Repository        *string               `json:"repository,omitempty"`
	SourceRunID       *string               `json:"sourceRunId,omitempty"`
	Summary           string                `json:"summary"`
	Title             string                `json:"title"`
	Type              ArtifactReferenceType `json:"type"`
	WorkspaceRef      *string               `json:"workspaceRef,omitempty"`
}

type RoomMemoryClass struct {
	ProjectionKind   *ProjectionKind `json:"projectionKind,omitempty"`
	Revision         int64           `json:"revision"`
	SourceCursor     int64           `json:"sourceCursor"`
	SourceMessageIDS []string        `json:"sourceMessageIds"`
	Summary          string          `json:"summary"`
}

type TaskMemoryClass struct {
	ProjectionKind   *ProjectionKind `json:"projectionKind,omitempty"`
	Revision         int64           `json:"revision"`
	SourceCursor     int64           `json:"sourceCursor"`
	SourceMessageIDS []string        `json:"sourceMessageIds"`
	Summary          string          `json:"summary"`
}

type RoutingAgent struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
}

type LogicalSessionRequest struct {
	ContextCursor int64        `json:"contextCursor"`
	ResumePolicy  ResumePolicy `json:"resumePolicy"`
	Scope         Scope        `json:"scope"`
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
	AgentID       string                    `json:"agentId"`
	RunID         string                    `json:"runId"`
	Sequence      int64                     `json:"sequence"`
	TraceID       string                    `json:"traceId"`
	Clarification *TaskClarificationRequest `json:"clarification,omitempty"`
	// Stable, client-safe error returned at a protocol boundary.
	Error   *AgentRoomError       `json:"error,omitempty"`
	Session *LogicalSessionStatus `json:"session,omitempty"`
	Status  RunExecutionStatus    `json:"status"`
}

type TaskClarificationRequest struct {
	Choices  []string `json:"choices,omitempty"`
	Kind     Scope    `json:"kind"`
	Question string   `json:"question"`
}

// Stable, client-safe error returned at a protocol boundary.
type AgentRoomError struct {
	Code      string                 `json:"code"`
	Details   map[string]interface{} `json:"details,omitempty"`
	Message   string                 `json:"message"`
	Retryable bool                   `json:"retryable"`
}

type LogicalSessionStatus struct {
	ContextCursor int64       `json:"contextCursor"`
	Disposition   Disposition `json:"disposition"`
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

type RunActivityMessageType string

const (
	RunActivity RunActivityMessageType = "run.activity"
)

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

type ArtifactReferenceType string

const (
	Branch     ArtifactReferenceType = "branch"
	Commit     ArtifactReferenceType = "commit"
	Document   ArtifactReferenceType = "document"
	File       ArtifactReferenceType = "file"
	Patch      ArtifactReferenceType = "patch"
	TestResult ArtifactReferenceType = "test_result"
)

type ProjectionKind string

const (
	Canonical  ProjectionKind = "canonical"
	Historical ProjectionKind = "historical"
)

type ResumePolicy string

const (
	ResumeOrStart ResumePolicy = "resume_or_start"
	StartNew      ResumePolicy = "start_new"
)

type Scope string

const (
	Task Scope = "task"
)

type RunRequestedMessageType string

const (
	RunRequested RunRequestedMessageType = "run.requested"
)

type RunAcceptedMessageType string

const (
	RunAccepted RunAcceptedMessageType = "run.accepted"
)

type Disposition string

const (
	Recreated Disposition = "recreated"
	Resumed   Disposition = "resumed"
	Started   Disposition = "started"
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
