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
	// Whether this connection can authorize and apply central Agent provisioning requests.
	// Omission means unsupported.
	SupportsAgentProvisioning *bool `json:"supportsAgentProvisioning,omitempty"`
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
	AgentID        string         `json:"agentId"`
	Capabilities   Capabilities   `json:"capabilities"`
	DeviceID       string         `json:"deviceId"`
	Name           string         `json:"name"`
	OwnerMemberID  string         `json:"ownerMemberId"`
	Role           string         `json:"role"`
	RuntimePolicy  *RuntimePolicy `json:"runtimePolicy,omitempty"`
	RuntimeScopeID *string        `json:"runtimeScopeId,omitempty"`
	TeamID         string         `json:"teamId"`
	// Bridge-authorized path-free label for one local Workspace binding. It grants no
	// filesystem or network authority.
	WorkspaceAlias      *string `json:"workspaceAlias,omitempty"`
	WorkspaceGeneration *string `json:"workspaceGeneration,omitempty"`
	WorkspaceRef        *string `json:"workspaceRef,omitempty"`
}

type Capabilities struct {
	InvocationMode                  InvocationMode `json:"invocationMode"`
	SupportsArtifactMaterialization *bool          `json:"supportsArtifactMaterialization,omitempty"`
	SupportsArtifactPublication     *bool          `json:"supportsArtifactPublication,omitempty"`
	SupportsHandoff                 bool           `json:"supportsHandoff"`
	SupportsInterrupt               bool           `json:"supportsInterrupt"`
	SupportsResume                  bool           `json:"supportsResume"`
	SupportsRoomContextCoverage     *bool          `json:"supportsRoomContextCoverage,omitempty"`
	SupportsStart                   bool           `json:"supportsStart"`
	SupportsStreaming               bool           `json:"supportsStreaming"`
	SupportsWorkspaceLeases         *bool          `json:"supportsWorkspaceLeases,omitempty"`
}

type RuntimePolicy struct {
	FilesystemAccess FilesystemAccess `json:"filesystemAccess"`
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
type AgentProvisionRequestedMessage struct {
	MessageID string                         `json:"messageId"`
	Payload   AgentProvisionRequestedPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time                          `json:"timestamp"`
	Type      AgentProvisionRequestedMessageType `json:"type"`
}

type AgentProvisionRequestedPayload struct {
	AgentID         string `json:"agentId"`
	DeviceID        string `json:"deviceId"`
	ManagementCode  string `json:"managementCode"`
	Name            string `json:"name"`
	RequestID       string `json:"requestId"`
	Role            string `json:"role"`
	TemplateAgentID string `json:"templateAgentId"`
}

// Fields shared by versioned cross-process messages.
type AgentProvisionResultMessage struct {
	MessageID string                      `json:"messageId"`
	Payload   AgentProvisionResultPayload `json:"payload"`
	// Major and minor protocol version negotiated by peers.
	ProtocolVersion string `json:"protocolVersion"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	Timestamp time.Time                       `json:"timestamp"`
	Type      AgentProvisionResultMessageType `json:"type"`
}

type AgentProvisionResultPayload struct {
	AgentID         string        `json:"agentId"`
	DeviceID        string        `json:"deviceId"`
	Reason          *Reason       `json:"reason,omitempty"`
	RequestID       string        `json:"requestId"`
	Status          PayloadStatus `json:"status"`
	TemplateAgentID string        `json:"templateAgentId"`
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
	Deadline          time.Time `json:"deadline"`
	DeliveryAttemptID string    `json:"deliveryAttemptId"`
	IdempotencyKey    string    `json:"idempotencyKey"`
	Instruction       string    `json:"instruction"`
	ParentRunID       *string   `json:"parentRunId,omitempty"`
	RequesterMemberID string    `json:"requesterMemberId"`
	// Server-owned coverage ending with one separate current request. Bridge derives
	// session-local consumption from this bundle.
	RoomContextBundle *ServerRoomContextBundle `json:"roomContextBundle,omitempty"`
	RoomID            string                   `json:"roomId"`
	RoutingAgents     []RoutingAgent           `json:"routingAgents,omitempty"`
	RunID             string                   `json:"runId"`
	Session           *LogicalSessionRequest   `json:"session,omitempty"`
	TargetAgentID     string                   `json:"targetAgentId"`
	TargetAgentName   *string                  `json:"targetAgentName,omitempty"`
	TaskID            *string                  `json:"taskId,omitempty"`
	TraceID           string                   `json:"traceId"`
	TriggerMessageID  string                   `json:"triggerMessageId"`
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
	LongTermMemory *LongTermProvenanceMemoryPlan `json:"longTermMemory,omitempty"`
	ResultEvidence *TaskResultEvidence           `json:"resultEvidence,omitempty"`
	RoomMemory     *RoomMemoryClass              `json:"roomMemory,omitempty"`
	TaskMemory     *TaskMemoryClass              `json:"taskMemory,omitempty"`
}

type LongTermProvenanceMemoryPlan struct {
	Room *RoomClass `json:"room,omitempty"`
	Task *TaskClass `json:"task,omitempty"`
}

type RoomClass struct {
	ActiveComplete bool                        `json:"activeComplete"`
	Entries        []RoomProvenanceMemoryEntry `json:"entries"`
	Revision       int64                       `json:"revision"`
}

type RoomProvenanceMemoryEntry struct {
	Content             string                    `json:"content"`
	MemoryID            string                    `json:"memoryId"`
	Revision            int64                     `json:"revision"`
	SourceArtifactIDS   []string                  `json:"sourceArtifactIds"`
	SourceDiscussionIDS []string                  `json:"sourceDiscussionIds"`
	SourceMessageIDS    []string                  `json:"sourceMessageIds"`
	SourceRunIDS        []string                  `json:"sourceRunIds"`
	State               State                     `json:"state"`
	SupersedesMemoryID  *string                   `json:"supersedesMemoryId,omitempty"`
	Type                ProvenanceMemoryEntryType `json:"type"`
}

type TaskClass struct {
	ActiveComplete bool                        `json:"activeComplete"`
	Entries        []TaskProvenanceMemoryEntry `json:"entries"`
	Revision       int64                       `json:"revision"`
}

type TaskProvenanceMemoryEntry struct {
	Content             string                    `json:"content"`
	MemoryID            string                    `json:"memoryId"`
	Revision            int64                     `json:"revision"`
	SourceArtifactIDS   []string                  `json:"sourceArtifactIds"`
	SourceDiscussionIDS []string                  `json:"sourceDiscussionIds"`
	SourceMessageIDS    []string                  `json:"sourceMessageIds"`
	SourceRunIDS        []string                  `json:"sourceRunIds"`
	State               State                     `json:"state"`
	SupersedesMemoryID  *string                   `json:"supersedesMemoryId,omitempty"`
	Type                ProvenanceMemoryEntryType `json:"type"`
}

type TaskResultEvidence struct {
	ArtifactRefs    []ArtifactReference `json:"artifactRefs"`
	DeliveryKind    *DeliveryKind       `json:"deliveryKind,omitempty"`
	FromRevision    *int64              `json:"fromRevision,omitempty"`
	HasMore         *bool               `json:"hasMore,omitempty"`
	Revision        int64               `json:"revision"`
	ThroughRevision *int64              `json:"throughRevision,omitempty"`
}

type ArtifactReference struct {
	ArtifactID       string  `json:"artifactId"`
	ArtifactRevision *int64  `json:"artifactRevision,omitempty"`
	Branch           *string `json:"branch,omitempty"`
	CommitSHA        *string `json:"commitSha,omitempty"`
	// Immutable content metadata and a path-free logical alias pinned into one Run delivery.
	Content *PinnedArtifactContent `json:"content,omitempty"`
	// RFC 3339 date-time normalized to the UTC Z suffix.
	CreatedAt         time.Time                   `json:"createdAt"`
	CreatedByAgentID  *string                     `json:"createdByAgentId,omitempty"`
	CreatedByMemberID *string                     `json:"createdByMemberId,omitempty"`
	Path              *string                     `json:"path,omitempty"`
	Relations         []ArtifactRelationReference `json:"relations,omitempty"`
	Repository        *string                     `json:"repository,omitempty"`
	SourceRunID       *string                     `json:"sourceRunId,omitempty"`
	Summary           string                      `json:"summary"`
	Title             string                      `json:"title"`
	Type              ArtifactReferenceType       `json:"type"`
	WorkspaceRef      *string                     `json:"workspaceRef,omitempty"`
}

// Immutable content metadata and a path-free logical alias pinned into one Run delivery.
type PinnedArtifactContent struct {
	ContentID    string    `json:"contentId"`
	LogicalAlias string    `json:"logicalAlias"`
	MediaType    MediaType `json:"mediaType"`
	Sha256       string    `json:"sha256"`
	SizeBytes    int64     `json:"sizeBytes"`
}

// Immutable lineage from the containing source Artifact to older Task evidence.
type ArtifactRelationReference struct {
	RelationID       string       `json:"relationId"`
	TargetArtifactID string       `json:"targetArtifactId"`
	Type             RelationType `json:"type"`
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

// Server-owned coverage ending with one separate current request. Bridge derives
// session-local consumption from this bundle.
type ServerRoomContextBundle struct {
	Checkpoint                  *RollingRoomCheckpoint `json:"checkpoint,omitempty"`
	PriorContextThroughSequence int64                  `json:"priorContextThroughSequence"`
	RawTail                     RoomContextRawTail     `json:"rawTail"`
	RequestMessageID            string                 `json:"requestMessageId"`
	TargetThroughSequence       int64                  `json:"targetThroughSequence"`
}

type RollingRoomCheckpoint struct {
	BuildKind             BuildKind `json:"buildKind"`
	CheckpointID          string    `json:"checkpointId"`
	FromSequenceExclusive int64     `json:"fromSequenceExclusive"`
	ModelFingerprint      string    `json:"modelFingerprint"`
	PromptVersion         string    `json:"promptVersion"`
	ProvenanceMessageIDS  []string  `json:"provenanceMessageIds"`
	SourceDigest          string    `json:"sourceDigest"`
	SourceMessageCount    int64     `json:"sourceMessageCount"`
	Summary               string    `json:"summary"`
	ThroughSequence       int64     `json:"throughSequence"`
}

type RoomContextRawTail struct {
	FromSequenceExclusive    int64     `json:"fromSequenceExclusive"`
	MessageCount             int64     `json:"messageCount"`
	Messages                 []Message `json:"messages"`
	ThroughSequenceInclusive int64     `json:"throughSequenceInclusive"`
	Utf8Bytes                int64     `json:"utf8Bytes"`
}

type Message struct {
	Content   string `json:"content"`
	MessageID string `json:"messageId"`
	// Opaque identifier with a lowercase type prefix and non-semantic suffix.
	SenderID   string  `json:"senderId"`
	SenderName *string `json:"senderName,omitempty"`
	Sequence   *int64  `json:"sequence,omitempty"`
}

type RoutingAgent struct {
	AgentID string `json:"agentId"`
	Name    string `json:"name"`
}

type LogicalSessionRequest struct {
	ContextCursor  int64        `json:"contextCursor"`
	ResumePolicy   ResumePolicy `json:"resumePolicy"`
	RuntimeScopeID *string      `json:"runtimeScopeId,omitempty"`
	Scope          Scope        `json:"scope"`
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
	// Non-retryable negative acknowledgement when pinned Artifact content cannot be verified
	// before Runtime admission.
	ArtifactMaterializationError *ArtifactMaterializationError            `json:"artifactMaterializationError,omitempty"`
	ArtifactMaterializations     []VerifiedArtifactMaterializationReceipt `json:"artifactMaterializations,omitempty"`
}

// Non-retryable negative acknowledgement when pinned Artifact content cannot be verified
// before Runtime admission.
type ArtifactMaterializationError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

// Bridge-owned receipt for verified isolated staging; it never contains a local path.
type VerifiedArtifactMaterializationReceipt struct {
	ArtifactID           string               `json:"artifactId"`
	ContentID            string               `json:"contentId"`
	LogicalAlias         string               `json:"logicalAlias"`
	MaterializationState MaterializationState `json:"materializationState"`
	MediaType            MediaType            `json:"mediaType"`
	Sha256               string               `json:"sha256"`
	SizeBytes            int64                `json:"sizeBytes"`
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
	ContextCursor          int64       `json:"contextCursor"`
	Disposition            Disposition `json:"disposition"`
	ResultEvidenceRevision *int64      `json:"resultEvidenceRevision,omitempty"`
	// Bridge-owned receipt for the exact checkpoint and raw interval accepted by one logical
	// Runtime session.
	RoomContextConsumption *BridgeRoomContextConsumption `json:"roomContextConsumption,omitempty"`
	RuntimeScopeID         *string                       `json:"runtimeScopeId,omitempty"`
}

// Bridge-owned receipt for the exact checkpoint and raw interval accepted by one logical
// Runtime session.
type BridgeRoomContextConsumption struct {
	BaseContextCursor           int64   `json:"baseContextCursor"`
	CheckpointID                *string `json:"checkpointId,omitempty"`
	CoverageThroughSequence     int64   `json:"coverageThroughSequence"`
	RawFromSequenceExclusive    int64   `json:"rawFromSequenceExclusive"`
	RawMessageCount             int64   `json:"rawMessageCount"`
	RawThroughSequenceInclusive int64   `json:"rawThroughSequenceInclusive"`
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
	OpenQuestions         []OpenQuestionElement  `json:"openQuestions,omitempty"`
	Recommendation        *Recommendation        `json:"recommendation,omitempty"`
	ResolvedQuestionIDS   []string               `json:"resolvedQuestionIds,omitempty"`
	ReviewerApproved      *bool                  `json:"reviewerApproved,omitempty"`
}

type OpenQuestionElement struct {
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

type FilesystemAccess string

const (
	LocalPolicy    FilesystemAccess = "local-policy"
	ReadOnly       FilesystemAccess = "read-only"
	WorkspaceWrite FilesystemAccess = "workspace-write"
)

type AgentPublishMessageType string

const (
	AgentPublish AgentPublishMessageType = "agent.publish"
)

type AgentPresenceStatus string

const (
	AgentPresenceStatusBusy AgentPresenceStatus = "busy"
	Degraded                AgentPresenceStatus = "degraded"
	Ready                   AgentPresenceStatus = "ready"
)

type AgentStatusMessageType string

const (
	AgentStatus AgentStatusMessageType = "agent.status"
)

type AgentProvisionRequestedMessageType string

const (
	AgentProvisionRequested AgentProvisionRequestedMessageType = "agent.provision.requested"
)

type Reason string

const (
	ConfigurationFailed  Reason = "configuration_failed"
	IdentityConflict     Reason = "identity_conflict"
	InvalidCode          Reason = "invalid_code"
	InvalidRequest       Reason = "invalid_request"
	ProvisioningDisabled Reason = "provisioning_disabled"
	RateLimited          Reason = "rate_limited"
	ReasonBusy           Reason = "busy"
	TemplateNotFound     Reason = "template_not_found"
)

type PayloadStatus string

const (
	Accepted PayloadStatus = "accepted"
	Rejected PayloadStatus = "rejected"
)

type AgentProvisionResultMessageType string

const (
	AgentProvisionResult AgentProvisionResultMessageType = "agent.provision.result"
)

type State string

const (
	Active     State = "active"
	Retracted  State = "retracted"
	Superseded State = "superseded"
)

type ProvenanceMemoryEntryType string

const (
	AcceptanceCriterion ProvenanceMemoryEntryType = "acceptance_criterion"
	Blocker             ProvenanceMemoryEntryType = "blocker"
	Constraint          ProvenanceMemoryEntryType = "constraint"
	Convention          ProvenanceMemoryEntryType = "convention"
	Decision            ProvenanceMemoryEntryType = "decision"
	Fact                ProvenanceMemoryEntryType = "fact"
	Goal                ProvenanceMemoryEntryType = "goal"
	OpenQuestion        ProvenanceMemoryEntryType = "open_question"
	Plan                ProvenanceMemoryEntryType = "plan"
	Progress            ProvenanceMemoryEntryType = "progress"
	Result              ProvenanceMemoryEntryType = "result"
)

type MediaType string

const (
	ApplicationJSON MediaType = "application/json"
	TextMarkdown    MediaType = "text/markdown"
	TextXDiff       MediaType = "text/x-diff"
)

type RelationType string

const (
	DerivesFrom RelationType = "derives_from"
	Reviews     RelationType = "reviews"
	Verifies    RelationType = "verifies"
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

type DeliveryKind string

const (
	Bootstrap DeliveryKind = "bootstrap"
	Delta     DeliveryKind = "delta"
)

type ProjectionKind string

const (
	Canonical  ProjectionKind = "canonical"
	Historical ProjectionKind = "historical"
)

type BuildKind string

const (
	Incremental BuildKind = "incremental"
	Rebase      BuildKind = "rebase"
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

type MaterializationState string

const (
	Reused   MaterializationState = "reused"
	Verified MaterializationState = "verified"
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
