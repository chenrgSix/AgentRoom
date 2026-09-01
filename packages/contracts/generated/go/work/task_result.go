// Code generated from JSON Schema; DO NOT EDIT.

package workcontracts

import "time"

type TaskProjection struct {
	Assignments        []TaskProjectionAssignment      `json:"assignments"`
	AttentionReasons   []TaskProjectionAttentionReason `json:"attentionReasons"`
	BudgetPolicy       TaskProjectionBudgetPolicy      `json:"budgetPolicy"`
	BudgetUsage        TaskProjectionBudgetUsage       `json:"budgetUsage"`
	CompletionPolicy   CompletionPolicy                `json:"completionPolicy"`
	CompletionResultID *string                         `json:"completionResultId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          time.Time                 `json:"createdAt"`
	CreatedByMemberID  string                    `json:"createdByMemberId"`
	Criteria           []TaskProjectionCriterion `json:"criteria"`
	CriteriaRevision   int64                     `json:"criteriaRevision"`
	DefinitionRevision int64                     `json:"definitionRevision"`
	DueAt              *time.Time                `json:"dueAt"`
	Goal               string                    `json:"goal"`
	IsDefault          bool                      `json:"isDefault"`
	LifecycleState     LifecycleState            `json:"lifecycleState"`
	NextAction         TaskProjectionNextAction  `json:"nextAction"`
	OwnerMemberID      string                    `json:"ownerMemberId"`
	ParentTaskID       *string                   `json:"parentTaskId"`
	Priority           Priority                  `json:"priority"`
	RoomID             string                    `json:"roomId"`
	SchedulingState    SchedulingState           `json:"schedulingState"`
	TaskDisplayNumber  int64                     `json:"taskDisplayNumber"`
	TaskID             string                    `json:"taskId"`
	TaskRevision       int64                     `json:"taskRevision"`
	TeamID             string                    `json:"teamId"`
	Title              string                    `json:"title"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt time.Time `json:"updatedAt"`
}

type TaskProjectionAssignment struct {
	AgentID string `json:"agentId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	AssignedAt         time.Time `json:"assignedAt"`
	AssignedByMemberID string    `json:"assignedByMemberId"`
	Role               Role      `json:"role"`
}

type TaskProjectionAttentionReason struct {
	ActorKind        AttentionReasonActorKind `json:"actorKind"`
	ExpectedAgentID  *string                  `json:"expectedAgentId"`
	ExpectedMemberID *string                  `json:"expectedMemberId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	OccurredAt time.Time        `json:"occurredAt"`
	Reason     AttentionElement `json:"reason"`
	SourceID   string           `json:"sourceId"`
}

type TaskProjectionBudgetPolicy struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type TaskProjectionBudgetUsage struct {
	ExecutionDurationSeconds int64    `json:"executionDurationSeconds"`
	ProviderCostUsd          *float64 `json:"providerCostUsd"`
	ProviderTokens           *int64   `json:"providerTokens"`
	RunAttempts              int64    `json:"runAttempts"`
	UsageRevision            int64    `json:"usageRevision"`
}

type TaskProjectionCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type TaskProjectionNextAction struct {
	ActorKind        AttentionReasonActorKind `json:"actorKind"`
	ExpectedAgentID  *string                  `json:"expectedAgentId"`
	ExpectedMemberID *string                  `json:"expectedMemberId"`
	Reason           NextActionReason         `json:"reason"`
	SourceID         *string                  `json:"sourceId"`
}

type TaskDefinitionCommand struct {
	Assignments          []TaskDefinitionCommandAssignment `json:"assignments"`
	BudgetPolicy         TaskDefinitionCommandBudgetPolicy `json:"budgetPolicy"`
	CompletionPolicy     CompletionPolicy                  `json:"completionPolicy"`
	Criteria             []TaskDefinitionCommandCriterion  `json:"criteria"`
	DueAt                *time.Time                        `json:"dueAt"`
	ExpectedTaskRevision int64                             `json:"expectedTaskRevision"`
	Goal                 string                            `json:"goal"`
	OperationID          string                            `json:"operationId"`
	OwnerMemberID        string                            `json:"ownerMemberId"`
	Priority             Priority                          `json:"priority"`
	Title                string                            `json:"title"`
}

type TaskDefinitionCommandAssignment struct {
	AgentID string `json:"agentId"`
	Role    Role   `json:"role"`
}

type TaskDefinitionCommandBudgetPolicy struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type TaskDefinitionCommandCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type RunAttemptProjection struct {
	AgentID       string `json:"agentId"`
	AttemptNumber int64  `json:"attemptNumber"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt    time.Time                 `json:"createdAt"`
	Phase        Phase                     `json:"phase"`
	RetryOfRunID *string                   `json:"retryOfRunId"`
	RunID        string                    `json:"runId"`
	State        RunAttemptProjectionState `json:"state"`
	TaskID       string                    `json:"taskId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt time.Time `json:"updatedAt"`
}

type RunContextManifest struct {
	Criteria           []RunContextManifestCriterion `json:"criteria"`
	CriteriaRevision   int64                         `json:"criteriaRevision"`
	DefinitionRevision int64                         `json:"definitionRevision"`
	Execution          *Execution                    `json:"execution,omitempty"`
	Goal               string                        `json:"goal"`
	Included           Included                      `json:"included"`
	ManifestVersion    ManifestVersion               `json:"manifestVersion"`
	OmittedCategories  []OmittedCategory             `json:"omittedCategories"`
	Permissions        Permissions                   `json:"permissions"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt   time.Time `json:"recordedAt"`
	RunID        string    `json:"runId"`
	Target       Target    `json:"target"`
	TaskID       string    `json:"taskId"`
	TaskRevision int64     `json:"taskRevision"`
}

type RunContextManifestCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type Execution struct {
	Capture *Capture `json:"capture,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline             time.Time             `json:"deadline"`
	Grant                Grant                 `json:"grant"`
	InputDigest          string                `json:"inputDigest"`
	Inputs               []Input               `json:"inputs"`
	ManifestDigest       string                `json:"manifestDigest"`
	Outputs              []ExecutionOutput     `json:"outputs"`
	Repository           Repository            `json:"repository"`
	Scope                ScopeClass            `json:"scope"`
	ScopePolicy          ScopePolicy           `json:"scopePolicy"`
	VerificationProfiles []VerificationProfile `json:"verificationProfiles"`
	Version              int64                 `json:"version"`
	Workspace            Workspace             `json:"workspace"`
}

type Capture struct {
	OperationID string          `json:"operationId"`
	Outputs     []CaptureOutput `json:"outputs"`
	RootTaskID  string          `json:"rootTaskId"`
}

type CaptureOutput struct {
	Path    *string `json:"path"`
	SlotKey string  `json:"slotKey"`
	Summary string  `json:"summary"`
	Title   string  `json:"title"`
}

type Grant struct {
	Digest string `json:"digest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt time.Time `json:"expiresAt"`
	GrantID   string    `json:"grantId"`
	Revision  int64     `json:"revision"`
}

type Input struct {
	Artifact            ArtifactClass `json:"artifact"`
	BindingID           string        `json:"bindingId"`
	DestinationAgentID  string        `json:"destinationAgentId"`
	DestinationDeviceID string        `json:"destinationDeviceId"`
	DestinationRunID    string        `json:"destinationRunId"`
	DestinationTaskID   string        `json:"destinationTaskId"`
	EdgeKey             *string       `json:"edgeKey"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt       time.Time `json:"expiresAt"`
	Gate            Gate      `json:"gate"`
	GateDigest      string    `json:"gateDigest"`
	GateOperationID string    `json:"gateOperationId"`
	InputSlot       string    `json:"inputSlot"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt                 time.Time `json:"issuedAt"`
	PlanID                   string    `json:"planId"`
	PlanRevision             int64     `json:"planRevision"`
	RepositoryID             *string   `json:"repositoryId"`
	SourceCommit             *string   `json:"sourceCommit"`
	SourceCriteriaRevision   int64     `json:"sourceCriteriaRevision"`
	SourceDefinitionRevision int64     `json:"sourceDefinitionRevision"`
	SourceOutputSlot         string    `json:"sourceOutputSlot"`
	SourceResultID           *string   `json:"sourceResultId"`
	SourceResultVersion      *int64    `json:"sourceResultVersion"`
	SourceTaskID             string    `json:"sourceTaskId"`
	SourceTree               *string   `json:"sourceTree"`
}

type ArtifactClass struct {
	ArtifactID       string       `json:"artifactId"`
	ArtifactRevision int64        `json:"artifactRevision"`
	ByteLength       int64        `json:"byteLength"`
	ContentDigest    string       `json:"contentDigest"`
	Kind             ArtifactKind `json:"kind"`
}

type ExecutionOutput struct {
	Kind     ArtifactKind `json:"kind"`
	Required bool         `json:"required"`
	SlotKey  string       `json:"slotKey"`
}

type Repository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type ScopeClass struct {
	AgentID             string `json:"agentId"`
	ApprovalOperationID string `json:"approvalOperationId"`
	CriteriaRevision    int64  `json:"criteriaRevision"`
	DefinitionRevision  int64  `json:"definitionRevision"`
	DeviceID            string `json:"deviceId"`
	DispatchGeneration  int64  `json:"dispatchGeneration"`
	NodeKey             string `json:"nodeKey"`
	PlanControlRevision int64  `json:"planControlRevision"`
	PlanDigest          string `json:"planDigest"`
	PlanID              string `json:"planId"`
	PlanRevision        int64  `json:"planRevision"`
	RoomID              string `json:"roomId"`
	RunID               string `json:"runId"`
	TaskID              string `json:"taskId"`
	TaskRevision        int64  `json:"taskRevision"`
}

type ScopePolicy struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type VerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type Workspace struct {
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt time.Time `json:"expiresAt"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt            time.Time `json:"issuedAt"`
	LeaseID             string    `json:"leaseId"`
	Mode                Mode      `json:"mode"`
	WorkspaceGeneration string    `json:"workspaceGeneration"`
	WorkspaceRef        string    `json:"workspaceRef"`
}

type Included struct {
	ArtifactIDS         []string `json:"artifactIds"`
	ArtifactRevision    int64    `json:"artifactRevision"`
	MemoryIDS           []string `json:"memoryIds"`
	MessageIDS          []string `json:"messageIds"`
	ParentRunIDS        []string `json:"parentRunIds"`
	RoomContextRevision int64    `json:"roomContextRevision"`
	TaskMemoryRevision  int64    `json:"taskMemoryRevision"`
}

type Permissions struct {
	FilesystemAccess   FilesystemAccess `json:"filesystemAccess"`
	Handoff            Handoff          `json:"handoff"`
	Interrupt          Handoff          `json:"interrupt"`
	MaxDurationSeconds *int64           `json:"maxDurationSeconds"`
	NetworkAccess      NetworkAccess    `json:"networkAccess"`
}

type Target struct {
	AgentID        string      `json:"agentId"`
	DeviceID       *string     `json:"deviceId"`
	RuntimeKind    RuntimeKind `json:"runtimeKind"`
	WorkspaceAlias *string     `json:"workspaceAlias"`
}

type AmbiguityAcknowledgement struct {
	ExpectedTaskRevision int64  `json:"expectedTaskRevision"`
	OperationID          string `json:"operationId"`
	Reason               string `json:"reason"`
	RunID                string `json:"runId"`
}

type ResultProposal struct {
	CriteriaRevision       int64                          `json:"criteriaRevision"`
	CriterionClaims        []ResultProposalCriterionClaim `json:"criterionClaims"`
	DefinitionRevision     int64                          `json:"definitionRevision"`
	NextActions            []ResultProposalNextAction     `json:"nextActions"`
	OpenQuestions          []string                       `json:"openQuestions"`
	OperationID            string                         `json:"operationId"`
	Outcome                Outcome                        `json:"outcome"`
	ProposedAtTaskRevision int64                          `json:"proposedAtTaskRevision"`
	Risks                  []string                       `json:"risks"`
	Sources                []ResultProposalSource         `json:"sources"`
	Summary                string                         `json:"summary"`
	SupersedesResultID     *string                        `json:"supersedesResultId"`
	TaskID                 string                         `json:"taskId"`
}

type ResultProposalCriterionClaim struct {
	Coverage       Coverage `json:"coverage"`
	CriterionKey   string   `json:"criterionKey"`
	EvidenceRefIDS []string `json:"evidenceRefIds"`
	Explanation    string   `json:"explanation"`
}

type ResultProposalNextAction struct {
	Description   string `json:"description"`
	NextActionKey string `json:"nextActionKey"`
}

type ResultProposalSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
}

type AgentResultProposal struct {
	ActorKind AgentResultProposalActorKind `json:"actorKind"`
	AgentID   string                       `json:"agentId"`
	Proposal  AgentResultProposalProposal  `json:"proposal"`
	RunID     string                       `json:"runId"`
}

type AgentResultProposalProposal struct {
	CriteriaRevision       int64                  `json:"criteriaRevision"`
	CriterionClaims        []PurpleCriterionClaim `json:"criterionClaims"`
	DefinitionRevision     int64                  `json:"definitionRevision"`
	NextActions            []PurpleNextAction     `json:"nextActions"`
	OpenQuestions          []string               `json:"openQuestions"`
	OperationID            string                 `json:"operationId"`
	Outcome                Outcome                `json:"outcome"`
	ProposedAtTaskRevision int64                  `json:"proposedAtTaskRevision"`
	Risks                  []string               `json:"risks"`
	Sources                []PurpleSource         `json:"sources"`
	Summary                string                 `json:"summary"`
	SupersedesResultID     *string                `json:"supersedesResultId"`
	TaskID                 string                 `json:"taskId"`
}

type PurpleCriterionClaim struct {
	Coverage       Coverage `json:"coverage"`
	CriterionKey   string   `json:"criterionKey"`
	EvidenceRefIDS []string `json:"evidenceRefIds"`
	Explanation    string   `json:"explanation"`
}

type PurpleNextAction struct {
	Description   string `json:"description"`
	NextActionKey string `json:"nextActionKey"`
}

type PurpleSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
}

type ResultReviewCommand struct {
	CompleteTask           bool     `json:"completeTask"`
	Decision               Decision `json:"decision"`
	ExpectedReviewRevision int64    `json:"expectedReviewRevision"`
	ExpectedTaskRevision   int64    `json:"expectedTaskRevision"`
	OperationID            string   `json:"operationId"`
	Reason                 string   `json:"reason"`
}

type ResultProjection struct {
	Proposal ResultProjectionProposal `json:"proposal"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ProposedAt    time.Time             `json:"proposedAt"`
	ProposedBy    ProposedBy            `json:"proposedBy"`
	ResultID      string                `json:"resultId"`
	ResultVersion int64                 `json:"resultVersion"`
	Review        *Review               `json:"review"`
	RoomID        string                `json:"roomId"`
	State         ResultProjectionState `json:"state"`
	TaskID        string                `json:"taskId"`
}

type ResultProjectionProposal struct {
	CriteriaRevision       int64                  `json:"criteriaRevision"`
	CriterionClaims        []FluffyCriterionClaim `json:"criterionClaims"`
	DefinitionRevision     int64                  `json:"definitionRevision"`
	NextActions            []FluffyNextAction     `json:"nextActions"`
	OpenQuestions          []string               `json:"openQuestions"`
	OperationID            string                 `json:"operationId"`
	Outcome                Outcome                `json:"outcome"`
	ProposedAtTaskRevision int64                  `json:"proposedAtTaskRevision"`
	Risks                  []string               `json:"risks"`
	Sources                []FluffySource         `json:"sources"`
	Summary                string                 `json:"summary"`
	SupersedesResultID     *string                `json:"supersedesResultId"`
	TaskID                 string                 `json:"taskId"`
}

type FluffyCriterionClaim struct {
	Coverage       Coverage `json:"coverage"`
	CriterionKey   string   `json:"criterionKey"`
	EvidenceRefIDS []string `json:"evidenceRefIds"`
	Explanation    string   `json:"explanation"`
}

type FluffyNextAction struct {
	Description   string `json:"description"`
	NextActionKey string `json:"nextActionKey"`
}

type FluffySource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
}

type ProposedBy struct {
	Kind         ProposedByKind `json:"kind"`
	MemberID     *string        `json:"memberId,omitempty"`
	AgentID      *string        `json:"agentId,omitempty"`
	RunID        *string        `json:"runId,omitempty"`
	DiscussionID *string        `json:"discussionId,omitempty"`
}

type Review struct {
	Decision Decision `json:"decision"`
	Reason   string   `json:"reason"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ReviewedAt         time.Time `json:"reviewedAt"`
	ReviewedByMemberID string    `json:"reviewedByMemberId"`
	ReviewRevision     int64     `json:"reviewRevision"`
}

type WorkbenchQuery struct {
	AgentID        *string            `json:"agentId"`
	Attention      []AttentionElement `json:"attention"`
	Cursor         *string            `json:"cursor"`
	LifecycleState []LifecycleState   `json:"lifecycleState"`
	Limit          int64              `json:"limit"`
	OwnerMemberID  *string            `json:"ownerMemberId"`
	Priority       []Priority         `json:"priority,omitempty"`
	RoomID         *string            `json:"roomId"`
	Scope          ScopeEnum          `json:"scope"`
	// Optional trimmed Task title search. Case-insensitive literal title substrings match;
	// numeric or TASK-n text also matches the exact Team display number. Empty text is
	// equivalent to omission.
	Search        *string    `json:"search,omitempty"`
	UpdatedAfter  *time.Time `json:"updatedAfter"`
	UpdatedBefore *time.Time `json:"updatedBefore"`
}

type WorkbenchPage struct {
	Items      []Item  `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

type Item struct {
	AttentionReasons          []ItemAttentionReason `json:"attentionReasons"`
	BudgetUsage               ItemBudgetUsage       `json:"budgetUsage"`
	LatestResultCurrent       *bool                 `json:"latestResultCurrent"`
	LatestResultID            *string               `json:"latestResultId"`
	LatestRun                 *LatestRun            `json:"latestRun"`
	LifecycleState            LifecycleState        `json:"lifecycleState"`
	NextAction                ItemNextAction        `json:"nextAction"`
	OwnerMemberID             string                `json:"ownerMemberId"`
	PrimaryAttention          *AttentionElement     `json:"primaryAttention"`
	Priority                  Priority              `json:"priority"`
	RequiredCriteriaSatisfied int64                 `json:"requiredCriteriaSatisfied"`
	RequiredCriteriaTotal     int64                 `json:"requiredCriteriaTotal"`
	RoomID                    string                `json:"roomId"`
	SchedulingState           SchedulingState       `json:"schedulingState"`
	TaskDisplayNumber         int64                 `json:"taskDisplayNumber"`
	TaskID                    string                `json:"taskId"`
	Title                     string                `json:"title"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt time.Time `json:"updatedAt"`
}

type ItemAttentionReason struct {
	ActorKind        AttentionReasonActorKind `json:"actorKind"`
	ExpectedAgentID  *string                  `json:"expectedAgentId"`
	ExpectedMemberID *string                  `json:"expectedMemberId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	OccurredAt time.Time        `json:"occurredAt"`
	Reason     AttentionElement `json:"reason"`
	SourceID   string           `json:"sourceId"`
}

type ItemBudgetUsage struct {
	ExecutionDurationSeconds int64    `json:"executionDurationSeconds"`
	ProviderCostUsd          *float64 `json:"providerCostUsd"`
	ProviderTokens           *int64   `json:"providerTokens"`
	RunAttempts              int64    `json:"runAttempts"`
	UsageRevision            int64    `json:"usageRevision"`
}

type LatestRun struct {
	AgentID       string `json:"agentId"`
	AttemptNumber int64  `json:"attemptNumber"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt    time.Time                 `json:"createdAt"`
	Phase        Phase                     `json:"phase"`
	RetryOfRunID *string                   `json:"retryOfRunId"`
	RunID        string                    `json:"runId"`
	State        RunAttemptProjectionState `json:"state"`
	TaskID       string                    `json:"taskId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt time.Time `json:"updatedAt"`
}

type ItemNextAction struct {
	ActorKind        AttentionReasonActorKind `json:"actorKind"`
	ExpectedAgentID  *string                  `json:"expectedAgentId"`
	ExpectedMemberID *string                  `json:"expectedMemberId"`
	Reason           NextActionReason         `json:"reason"`
	SourceID         *string                  `json:"sourceId"`
}

type LegacyTaskMapping struct {
	CompletionPolicy CompletionPolicy `json:"completionPolicy"`
	IsDefault        bool             `json:"isDefault"`
	LegacyState      LegacyState      `json:"legacyState"`
	LifecycleState   LifecycleState   `json:"lifecycleState"`
	SchedulingState  SchedulingState  `json:"schedulingState"`
}

type ChildTaskFromResultCommand struct {
	NextActionKey string `json:"nextActionKey"`
	OperationID   string `json:"operationId"`
	OwnerMemberID string `json:"ownerMemberId"`
	Title         string `json:"title"`
}

type Role string

const (
	Contributor Role = "contributor"
	Primary     Role = "primary"
	Reviewer    Role = "reviewer"
)

type AttentionReasonActorKind string

const (
	ActorKindMember AttentionReasonActorKind = "member"
	Agent           AttentionReasonActorKind = "agent"
	System          AttentionReasonActorKind = "system"
)

type AttentionElement string

const (
	BudgetExhausted      AttentionElement = "budget_exhausted"
	NeedsApproval        AttentionElement = "needs_approval"
	NeedsInput           AttentionElement = "needs_input"
	Overdue              AttentionElement = "overdue"
	ReasonBlocked        AttentionElement = "blocked"
	ReasonOutcomeUnknown AttentionElement = "outcome_unknown"
	ReasonPaused         AttentionElement = "paused"
	ResultRejected       AttentionElement = "result_rejected"
	ResultStale          AttentionElement = "result_stale"
	RuntimeUnavailable   AttentionElement = "runtime_unavailable"
)

type CompletionPolicy string

const (
	AcceptedResultRequired CompletionPolicy = "accepted_result_required"
	OwnerConfirmed         CompletionPolicy = "owner_confirmed"
)

type LifecycleState string

const (
	Active                  LifecycleState = "active"
	Draft                   LifecycleState = "draft"
	LifecycleStateCanceled  LifecycleState = "canceled"
	LifecycleStateCompleted LifecycleState = "completed"
	LifecycleStateReview    LifecycleState = "review"
	Ready                   LifecycleState = "ready"
)

type NextActionReason string

const (
	AcknowledgeOutcome NextActionReason = "acknowledge_outcome"
	IncreaseBudget     NextActionReason = "increase_budget"
	None               NextActionReason = "none"
	ProvideInput       NextActionReason = "provide_input"
	ResolveBlock       NextActionReason = "resolve_block"
	RestoreRuntime     NextActionReason = "restore_runtime"
	ResumeScheduling   NextActionReason = "resume_scheduling"
	ReviewResult       NextActionReason = "review_result"
	StartWork          NextActionReason = "start_work"
	SubmitResult       NextActionReason = "submit_result"
)

type Priority string

const (
	High   Priority = "high"
	Low    Priority = "low"
	Normal Priority = "normal"
	Urgent Priority = "urgent"
)

type SchedulingState string

const (
	Enabled               SchedulingState = "enabled"
	SchedulingStatePaused SchedulingState = "paused"
)

type Phase string

const (
	PreparingContext Phase = "preparing_context"
	Running          Phase = "running"
	RunningTests     Phase = "running_tests"
	Sending          Phase = "sending"
	StartingRuntime  Phase = "starting_runtime"
	SubmittingResult Phase = "submitting_result"
	Unknown          Phase = "unknown"
)

type RunAttemptProjectionState string

const (
	Delivered           RunAttemptProjectionState = "delivered"
	Expired             RunAttemptProjectionState = "expired"
	Failed              RunAttemptProjectionState = "failed"
	InputRequired       RunAttemptProjectionState = "input_required"
	Queued              RunAttemptProjectionState = "queued"
	StateCanceled       RunAttemptProjectionState = "canceled"
	StateCompleted      RunAttemptProjectionState = "completed"
	StateOutcomeUnknown RunAttemptProjectionState = "outcome_unknown"
	StateWorking        RunAttemptProjectionState = "working"
)

type ArtifactKind string

const (
	Commit     ArtifactKind = "commit"
	Document   ArtifactKind = "document"
	Patch      ArtifactKind = "patch"
	TestResult ArtifactKind = "test_result"
)

type Gate string

const (
	AcceptedResult   Gate = "accepted_result"
	IntegratedCommit Gate = "integrated_commit"
	VerifiedOutput   Gate = "verified_output"
)

type Access string

const (
	IsolatedWrite Access = "isolated_write"
	ReadOnly      Access = "read_only"
)

type Mode string

const (
	IsolatedWorktree Mode = "isolated_worktree"
)

type ManifestVersion string

const (
	The10 ManifestVersion = "1.0"
)

type OmittedCategory string

const (
	EnvironmentValues    OmittedCategory = "environment_values"
	HiddenReasoning      OmittedCategory = "hidden_reasoning"
	LocalPaths           OmittedCategory = "local_paths"
	OtherWorkspaces      OmittedCategory = "other_workspaces"
	ProviderCredentials  OmittedCategory = "provider_credentials"
	ProviderSessionIDS   OmittedCategory = "provider_session_ids"
	ToolPayloads         OmittedCategory = "tool_payloads"
	UnrelatedRoomHistory OmittedCategory = "unrelated_room_history"
)

type FilesystemAccess string

const (
	FilesystemAccessLocalPolicy FilesystemAccess = "local-policy"
	FilesystemAccessNotRecorded FilesystemAccess = "not_recorded"
	FilesystemAccessReadOnly    FilesystemAccess = "read-only"
	WorkspaceWrite              FilesystemAccess = "workspace-write"
)

type Handoff string

const (
	HandoffNotRecorded Handoff = "not_recorded"
	Supported          Handoff = "supported"
	Unsupported        Handoff = "unsupported"
)

type NetworkAccess string

const (
	Disabled                 NetworkAccess = "disabled"
	NetworkAccessLocalPolicy NetworkAccess = "local-policy"
	NetworkAccessNotRecorded NetworkAccess = "not_recorded"
)

type RuntimeKind string

const (
	Codex                  RuntimeKind = "codex"
	Fake                   RuntimeKind = "fake"
	Generic                RuntimeKind = "generic"
	Manual                 RuntimeKind = "manual"
	Pi                     RuntimeKind = "pi"
	RuntimeKindNotRecorded RuntimeKind = "not_recorded"
)

type Coverage string

const (
	CoverageNotSatisfied Coverage = "not_satisfied"
	CoverageSatisfied    Coverage = "satisfied"
	NotApplicable        Coverage = "not_applicable"
	Unresolved           Coverage = "unresolved"
)

type Outcome string

const (
	Informational       Outcome = "informational"
	OutcomeNotSatisfied Outcome = "not_satisfied"
	OutcomeSatisfied    Outcome = "satisfied"
	Partial             Outcome = "partial"
)

type SourceKind string

const (
	Artifact   SourceKind = "artifact"
	Discussion SourceKind = "discussion"
	Memory     SourceKind = "memory"
	Message    SourceKind = "message"
	RunEvent   SourceKind = "run_event"
)

type AgentResultProposalActorKind string

const (
	ActorKindManagedAgent AgentResultProposalActorKind = "managed_agent"
	ActorKindManualAgent  AgentResultProposalActorKind = "manual_agent"
)

type Decision string

const (
	DecisionAccepted Decision = "accepted"
	DecisionRejected Decision = "rejected"
)

type ProposedByKind string

const (
	KindManagedAgent ProposedByKind = "managed_agent"
	KindManualAgent  ProposedByKind = "manual_agent"
	KindMember       ProposedByKind = "member"
	Orchestrator     ProposedByKind = "orchestrator"
)

type ResultProjectionState string

const (
	Proposed      ResultProjectionState = "proposed"
	StateAccepted ResultProjectionState = "accepted"
	StateRejected ResultProjectionState = "rejected"
	Superseded    ResultProjectionState = "superseded"
)

type ScopeEnum string

const (
	Mine ScopeEnum = "mine"
	Team ScopeEnum = "team"
)

type LegacyState string

const (
	LegacyStateBlocked   LegacyState = "blocked"
	LegacyStateCanceled  LegacyState = "canceled"
	LegacyStateCompleted LegacyState = "completed"
	LegacyStateReview    LegacyState = "review"
	LegacyStateWorking   LegacyState = "working"
	Open                 LegacyState = "open"
)
