// Code generated from JSON Schema; DO NOT EDIT.

package executioncontracts

import "time"

type ExecutionPlanProjection struct {
	CompiledTasks   []CompiledTask `json:"compiledTasks"`
	ControlRevision int64          `json:"controlRevision"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt     time.Time `json:"createdAt"`
	Current       Current   `json:"current"`
	OwnerMemberID string    `json:"ownerMemberId"`
	PlanID        string    `json:"planId"`
	RoomID        string    `json:"roomId"`
	RootTaskID    string    `json:"rootTaskId"`
	State         State     `json:"state"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt time.Time `json:"updatedAt"`
}

type CompiledTask struct {
	CriteriaRevision   int64  `json:"criteriaRevision"`
	DefinitionRevision int64  `json:"definitionRevision"`
	NodeKey            string `json:"nodeKey"`
	TaskID             string `json:"taskId"`
	TaskRevision       int64  `json:"taskRevision"`
}

type Current struct {
	Author CurrentAuthor `json:"author"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt  time.Time         `json:"createdAt"`
	DecisionID string            `json:"decisionId"`
	Definition CurrentDefinition `json:"definition"`
	Digest     string            `json:"digest"`
	PlanID     string            `json:"planId"`
	ProposalID string            `json:"proposalId"`
	Revision   int64             `json:"revision"`
}

type CurrentAuthor struct {
	Kind         AuthorKind `json:"kind"`
	MemberID     *string    `json:"memberId,omitempty"`
	AgentID      *string    `json:"agentId,omitempty"`
	RunID        *string    `json:"runId,omitempty"`
	DiscussionID *string    `json:"discussionId,omitempty"`
}

type CurrentDefinition struct {
	Decision       PurpleDecision        `json:"decision"`
	Edges          []PurpleEdge          `json:"edges"`
	ExternalInputs []PurpleExternalInput `json:"externalInputs"`
	Nodes          []PurpleNode          `json:"nodes"`
	Policy         PurplePolicy          `json:"policy"`
	RootTaskID     string                `json:"rootTaskId"`
	SchemaVersion  SchemaVersion         `json:"schemaVersion"`
	Title          string                `json:"title"`
}

type PurpleDecision struct {
	Items               []PurpleItem               `json:"items"`
	SourceRevisions     []PurpleSourceRevision     `json:"sourceRevisions"`
	Sources             []PurpleSource             `json:"sources"`
	Summary             string                     `json:"summary"`
	UnresolvedQuestions []PurpleUnresolvedQuestion `json:"unresolvedQuestions"`
}

type PurpleItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type PurpleSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
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
	ResultID      *string    `json:"resultId,omitempty"`
}

type PurpleUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type PurpleEdge struct {
	Bindings    []PurpleBinding `json:"bindings"`
	EdgeKey     string          `json:"edgeKey"`
	FromNodeKey string          `json:"fromNodeKey"`
	Gate        Gate            `json:"gate"`
	ToNodeKey   string          `json:"toNodeKey"`
}

type PurpleBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type PurpleExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type PurpleNode struct {
	AgentID              string                      `json:"agentId"`
	Budget               PurpleBudget                `json:"budget"`
	Inputs               []PurpleInput               `json:"inputs"`
	Kind                 NodeKind                    `json:"kind"`
	NodeKey              string                      `json:"nodeKey"`
	Outputs              []PurpleOutput              `json:"outputs"`
	Repository           PurpleRepository            `json:"repository"`
	Required             bool                        `json:"required"`
	Scope                PurpleScope                 `json:"scope"`
	Task                 PurpleTask                  `json:"task"`
	VerificationProfiles []PurpleVerificationProfile `json:"verificationProfiles"`
}

type PurpleBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type PurpleInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type PurpleOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type PurpleRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type PurpleScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type PurpleTask struct {
	Criteria             []PurpleCriterion `json:"criteria,omitempty"`
	Goal                 *string           `json:"goal,omitempty"`
	Mode                 Mode              `json:"mode"`
	OwnerMemberID        *string           `json:"ownerMemberId,omitempty"`
	Title                *string           `json:"title,omitempty"`
	CriteriaRevision     *int64            `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64            `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64            `json:"expectedTaskRevision,omitempty"`
	TaskID               *string           `json:"taskId,omitempty"`
}

type PurpleCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type PurpleVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type PurplePolicy struct {
	Budget                          FluffyBudget              `json:"budget"`
	Integration                     Integration               `json:"integration"`
	IntegrationTargets              []PurpleIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                     `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                      `json:"requireHumanIntegrationApproval"`
}

type FluffyBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type PurpleIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ExecutionDecisionRecord struct {
	Author  ExecutionDecisionRecordAuthor `json:"author"`
	Content Content                       `json:"content"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt            time.Time `json:"createdAt"`
	DecisionID           string    `json:"decisionId"`
	RoomID               string    `json:"roomId"`
	RootTaskID           string    `json:"rootTaskId"`
	SupersedesDecisionID *string   `json:"supersedesDecisionId"`
}

type ExecutionDecisionRecordAuthor struct {
	Kind         AuthorKind `json:"kind"`
	MemberID     *string    `json:"memberId,omitempty"`
	AgentID      *string    `json:"agentId,omitempty"`
	RunID        *string    `json:"runId,omitempty"`
	DiscussionID *string    `json:"discussionId,omitempty"`
}

type Content struct {
	Items               []ContentItem               `json:"items"`
	SourceRevisions     []ContentSourceRevision     `json:"sourceRevisions"`
	Sources             []ContentSource             `json:"sources"`
	Summary             string                      `json:"summary"`
	UnresolvedQuestions []ContentUnresolvedQuestion `json:"unresolvedQuestions"`
}

type ContentItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type ContentSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type ContentSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type ContentUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type ExecutionDecisionContent struct {
	Items               []ExecutionDecisionContentItem               `json:"items"`
	SourceRevisions     []ExecutionDecisionContentSourceRevision     `json:"sourceRevisions"`
	Sources             []ExecutionDecisionContentSource             `json:"sources"`
	Summary             string                                       `json:"summary"`
	UnresolvedQuestions []ExecutionDecisionContentUnresolvedQuestion `json:"unresolvedQuestions"`
}

type ExecutionDecisionContentItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type ExecutionDecisionContentSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type ExecutionDecisionContentSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type ExecutionDecisionContentUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type ExecutionPlanDefinition struct {
	Decision       ExecutionPlanDefinitionDecision        `json:"decision"`
	Edges          []ExecutionPlanDefinitionEdge          `json:"edges"`
	ExternalInputs []ExecutionPlanDefinitionExternalInput `json:"externalInputs"`
	Nodes          []ExecutionPlanDefinitionNode          `json:"nodes"`
	Policy         ExecutionPlanDefinitionPolicy          `json:"policy"`
	RootTaskID     string                                 `json:"rootTaskId"`
	SchemaVersion  SchemaVersion                          `json:"schemaVersion"`
	Title          string                                 `json:"title"`
}

type ExecutionPlanDefinitionDecision struct {
	Items               []FluffyItem               `json:"items"`
	SourceRevisions     []FluffySourceRevision     `json:"sourceRevisions"`
	Sources             []FluffySource             `json:"sources"`
	Summary             string                     `json:"summary"`
	UnresolvedQuestions []FluffyUnresolvedQuestion `json:"unresolvedQuestions"`
}

type FluffyItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type FluffySourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
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
	ResultID      *string    `json:"resultId,omitempty"`
}

type FluffyUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type ExecutionPlanDefinitionEdge struct {
	Bindings    []FluffyBinding `json:"bindings"`
	EdgeKey     string          `json:"edgeKey"`
	FromNodeKey string          `json:"fromNodeKey"`
	Gate        Gate            `json:"gate"`
	ToNodeKey   string          `json:"toNodeKey"`
}

type FluffyBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type ExecutionPlanDefinitionExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type ExecutionPlanDefinitionNode struct {
	AgentID              string                      `json:"agentId"`
	Budget               TentacledBudget             `json:"budget"`
	Inputs               []FluffyInput               `json:"inputs"`
	Kind                 NodeKind                    `json:"kind"`
	NodeKey              string                      `json:"nodeKey"`
	Outputs              []FluffyOutput              `json:"outputs"`
	Repository           FluffyRepository            `json:"repository"`
	Required             bool                        `json:"required"`
	Scope                FluffyScope                 `json:"scope"`
	Task                 FluffyTask                  `json:"task"`
	VerificationProfiles []FluffyVerificationProfile `json:"verificationProfiles"`
}

type TentacledBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type FluffyInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type FluffyOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type FluffyRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type FluffyScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type FluffyTask struct {
	Criteria             []FluffyCriterion `json:"criteria,omitempty"`
	Goal                 *string           `json:"goal,omitempty"`
	Mode                 Mode              `json:"mode"`
	OwnerMemberID        *string           `json:"ownerMemberId,omitempty"`
	Title                *string           `json:"title,omitempty"`
	CriteriaRevision     *int64            `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64            `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64            `json:"expectedTaskRevision,omitempty"`
	TaskID               *string           `json:"taskId,omitempty"`
}

type FluffyCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type FluffyVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type ExecutionPlanDefinitionPolicy struct {
	Budget                          StickyBudget              `json:"budget"`
	Integration                     Integration               `json:"integration"`
	IntegrationTargets              []FluffyIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                     `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                      `json:"requireHumanIntegrationApproval"`
}

type StickyBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type FluffyIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ExecutionPlanProposalCommand struct {
	Definition               ExecutionPlanProposalCommandDefinition `json:"definition"`
	ExpectedRootTaskRevision int64                                  `json:"expectedRootTaskRevision"`
	OperationID              string                                 `json:"operationId"`
}

type ExecutionPlanProposalCommandDefinition struct {
	Decision       FluffyDecision        `json:"decision"`
	Edges          []FluffyEdge          `json:"edges"`
	ExternalInputs []FluffyExternalInput `json:"externalInputs"`
	Nodes          []FluffyNode          `json:"nodes"`
	Policy         FluffyPolicy          `json:"policy"`
	RootTaskID     string                `json:"rootTaskId"`
	SchemaVersion  SchemaVersion         `json:"schemaVersion"`
	Title          string                `json:"title"`
}

type FluffyDecision struct {
	Items               []TentacledItem               `json:"items"`
	SourceRevisions     []TentacledSourceRevision     `json:"sourceRevisions"`
	Sources             []TentacledSource             `json:"sources"`
	Summary             string                        `json:"summary"`
	UnresolvedQuestions []TentacledUnresolvedQuestion `json:"unresolvedQuestions"`
}

type TentacledItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type TentacledSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type TentacledSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type TentacledUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type FluffyEdge struct {
	Bindings    []TentacledBinding `json:"bindings"`
	EdgeKey     string             `json:"edgeKey"`
	FromNodeKey string             `json:"fromNodeKey"`
	Gate        Gate               `json:"gate"`
	ToNodeKey   string             `json:"toNodeKey"`
}

type TentacledBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type FluffyExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type FluffyNode struct {
	AgentID              string                         `json:"agentId"`
	Budget               IndigoBudget                   `json:"budget"`
	Inputs               []TentacledInput               `json:"inputs"`
	Kind                 NodeKind                       `json:"kind"`
	NodeKey              string                         `json:"nodeKey"`
	Outputs              []TentacledOutput              `json:"outputs"`
	Repository           TentacledRepository            `json:"repository"`
	Required             bool                           `json:"required"`
	Scope                TentacledScope                 `json:"scope"`
	Task                 TentacledTask                  `json:"task"`
	VerificationProfiles []TentacledVerificationProfile `json:"verificationProfiles"`
}

type IndigoBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type TentacledInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type TentacledOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type TentacledRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type TentacledScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type TentacledTask struct {
	Criteria             []TentacledCriterion `json:"criteria,omitempty"`
	Goal                 *string              `json:"goal,omitempty"`
	Mode                 Mode                 `json:"mode"`
	OwnerMemberID        *string              `json:"ownerMemberId,omitempty"`
	Title                *string              `json:"title,omitempty"`
	CriteriaRevision     *int64               `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64               `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64               `json:"expectedTaskRevision,omitempty"`
	TaskID               *string              `json:"taskId,omitempty"`
}

type TentacledCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type TentacledVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type FluffyPolicy struct {
	Budget                          IndecentBudget               `json:"budget"`
	Integration                     Integration                  `json:"integration"`
	IntegrationTargets              []TentacledIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                        `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                         `json:"requireHumanIntegrationApproval"`
}

type IndecentBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type TentacledIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ExecutionPlanRevisionCommand struct {
	Definition               ExecutionPlanRevisionCommandDefinition `json:"definition"`
	ExpectedRevision         int64                                  `json:"expectedRevision"`
	ExpectedRootTaskRevision int64                                  `json:"expectedRootTaskRevision"`
	OperationID              string                                 `json:"operationId"`
}

type ExecutionPlanRevisionCommandDefinition struct {
	Decision       TentacledDecision        `json:"decision"`
	Edges          []TentacledEdge          `json:"edges"`
	ExternalInputs []TentacledExternalInput `json:"externalInputs"`
	Nodes          []TentacledNode          `json:"nodes"`
	Policy         TentacledPolicy          `json:"policy"`
	RootTaskID     string                   `json:"rootTaskId"`
	SchemaVersion  SchemaVersion            `json:"schemaVersion"`
	Title          string                   `json:"title"`
}

type TentacledDecision struct {
	Items               []StickyItem               `json:"items"`
	SourceRevisions     []StickySourceRevision     `json:"sourceRevisions"`
	Sources             []StickySource             `json:"sources"`
	Summary             string                     `json:"summary"`
	UnresolvedQuestions []StickyUnresolvedQuestion `json:"unresolvedQuestions"`
}

type StickyItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type StickySourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type StickySource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type StickyUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type TentacledEdge struct {
	Bindings    []StickyBinding `json:"bindings"`
	EdgeKey     string          `json:"edgeKey"`
	FromNodeKey string          `json:"fromNodeKey"`
	Gate        Gate            `json:"gate"`
	ToNodeKey   string          `json:"toNodeKey"`
}

type StickyBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type TentacledExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type TentacledNode struct {
	AgentID              string                      `json:"agentId"`
	Budget               HilariousBudget             `json:"budget"`
	Inputs               []StickyInput               `json:"inputs"`
	Kind                 NodeKind                    `json:"kind"`
	NodeKey              string                      `json:"nodeKey"`
	Outputs              []StickyOutput              `json:"outputs"`
	Repository           StickyRepository            `json:"repository"`
	Required             bool                        `json:"required"`
	Scope                StickyScope                 `json:"scope"`
	Task                 StickyTask                  `json:"task"`
	VerificationProfiles []StickyVerificationProfile `json:"verificationProfiles"`
}

type HilariousBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type StickyInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type StickyOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type StickyRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type StickyScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type StickyTask struct {
	Criteria             []StickyCriterion `json:"criteria,omitempty"`
	Goal                 *string           `json:"goal,omitempty"`
	Mode                 Mode              `json:"mode"`
	OwnerMemberID        *string           `json:"ownerMemberId,omitempty"`
	Title                *string           `json:"title,omitempty"`
	CriteriaRevision     *int64            `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64            `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64            `json:"expectedTaskRevision,omitempty"`
	TaskID               *string           `json:"taskId,omitempty"`
}

type StickyCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type StickyVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type TentacledPolicy struct {
	Budget                          AmbitiousBudget           `json:"budget"`
	Integration                     Integration               `json:"integration"`
	IntegrationTargets              []StickyIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                     `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                      `json:"requireHumanIntegrationApproval"`
}

type AmbitiousBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type StickyIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ExecutionPlanApprovalCommand struct {
	Decision                 DecisionEnum `json:"decision"`
	ExpectedDigest           string       `json:"expectedDigest"`
	ExpectedRevision         int64        `json:"expectedRevision"`
	ExpectedRootTaskRevision int64        `json:"expectedRootTaskRevision"`
	OperationID              string       `json:"operationId"`
	Reason                   string       `json:"reason"`
}

type ExecutionPlanControlCommand struct {
	Action                  Action `json:"action"`
	ExpectedControlRevision int64  `json:"expectedControlRevision"`
	OperationID             string `json:"operationId"`
	Reason                  string `json:"reason"`
}

type ExecutionPlanRevision struct {
	Author ExecutionPlanRevisionAuthor `json:"author"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt  time.Time                       `json:"createdAt"`
	DecisionID string                          `json:"decisionId"`
	Definition ExecutionPlanRevisionDefinition `json:"definition"`
	Digest     string                          `json:"digest"`
	PlanID     string                          `json:"planId"`
	ProposalID string                          `json:"proposalId"`
	Revision   int64                           `json:"revision"`
}

type ExecutionPlanRevisionAuthor struct {
	Kind         AuthorKind `json:"kind"`
	MemberID     *string    `json:"memberId,omitempty"`
	AgentID      *string    `json:"agentId,omitempty"`
	RunID        *string    `json:"runId,omitempty"`
	DiscussionID *string    `json:"discussionId,omitempty"`
}

type ExecutionPlanRevisionDefinition struct {
	Decision       StickyDecision        `json:"decision"`
	Edges          []StickyEdge          `json:"edges"`
	ExternalInputs []StickyExternalInput `json:"externalInputs"`
	Nodes          []StickyNode          `json:"nodes"`
	Policy         StickyPolicy          `json:"policy"`
	RootTaskID     string                `json:"rootTaskId"`
	SchemaVersion  SchemaVersion         `json:"schemaVersion"`
	Title          string                `json:"title"`
}

type StickyDecision struct {
	Items               []IndigoItem               `json:"items"`
	SourceRevisions     []IndigoSourceRevision     `json:"sourceRevisions"`
	Sources             []IndigoSource             `json:"sources"`
	Summary             string                     `json:"summary"`
	UnresolvedQuestions []IndigoUnresolvedQuestion `json:"unresolvedQuestions"`
}

type IndigoItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type IndigoSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type IndigoSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type IndigoUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type StickyEdge struct {
	Bindings    []IndigoBinding `json:"bindings"`
	EdgeKey     string          `json:"edgeKey"`
	FromNodeKey string          `json:"fromNodeKey"`
	Gate        Gate            `json:"gate"`
	ToNodeKey   string          `json:"toNodeKey"`
}

type IndigoBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type StickyExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type StickyNode struct {
	AgentID              string                      `json:"agentId"`
	Budget               CunningBudget               `json:"budget"`
	Inputs               []IndigoInput               `json:"inputs"`
	Kind                 NodeKind                    `json:"kind"`
	NodeKey              string                      `json:"nodeKey"`
	Outputs              []IndigoOutput              `json:"outputs"`
	Repository           IndigoRepository            `json:"repository"`
	Required             bool                        `json:"required"`
	Scope                IndigoScope                 `json:"scope"`
	Task                 IndigoTask                  `json:"task"`
	VerificationProfiles []IndigoVerificationProfile `json:"verificationProfiles"`
}

type CunningBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type IndigoInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type IndigoOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type IndigoRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type IndigoScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type IndigoTask struct {
	Criteria             []IndigoCriterion `json:"criteria,omitempty"`
	Goal                 *string           `json:"goal,omitempty"`
	Mode                 Mode              `json:"mode"`
	OwnerMemberID        *string           `json:"ownerMemberId,omitempty"`
	Title                *string           `json:"title,omitempty"`
	CriteriaRevision     *int64            `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64            `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64            `json:"expectedTaskRevision,omitempty"`
	TaskID               *string           `json:"taskId,omitempty"`
}

type IndigoCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type IndigoVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type StickyPolicy struct {
	Budget                          MagentaBudget             `json:"budget"`
	Integration                     Integration               `json:"integration"`
	IntegrationTargets              []IndigoIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                     `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                      `json:"requireHumanIntegrationApproval"`
}

type MagentaBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type IndigoIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ExecutionAgentPlanProposalCommand struct {
	Command Command `json:"command"`
	RunID   string  `json:"runId"`
}

type Command struct {
	Definition               CommandDefinition `json:"definition"`
	ExpectedRootTaskRevision int64             `json:"expectedRootTaskRevision"`
	OperationID              string            `json:"operationId"`
}

type CommandDefinition struct {
	Decision       IndigoDecision        `json:"decision"`
	Edges          []IndigoEdge          `json:"edges"`
	ExternalInputs []IndigoExternalInput `json:"externalInputs"`
	Nodes          []IndigoNode          `json:"nodes"`
	Policy         IndigoPolicy          `json:"policy"`
	RootTaskID     string                `json:"rootTaskId"`
	SchemaVersion  SchemaVersion         `json:"schemaVersion"`
	Title          string                `json:"title"`
}

type IndigoDecision struct {
	Items               []IndecentItem               `json:"items"`
	SourceRevisions     []IndecentSourceRevision     `json:"sourceRevisions"`
	Sources             []IndecentSource             `json:"sources"`
	Summary             string                       `json:"summary"`
	UnresolvedQuestions []IndecentUnresolvedQuestion `json:"unresolvedQuestions"`
}

type IndecentItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type IndecentSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type IndecentSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          SourceKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type IndecentUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type IndigoEdge struct {
	Bindings    []IndecentBinding `json:"bindings"`
	EdgeKey     string            `json:"edgeKey"`
	FromNodeKey string            `json:"fromNodeKey"`
	Gate        Gate              `json:"gate"`
	ToNodeKey   string            `json:"toNodeKey"`
}

type IndecentBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type IndigoExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type IndigoNode struct {
	AgentID              string                        `json:"agentId"`
	Budget               FriskyBudget                  `json:"budget"`
	Inputs               []IndecentInput               `json:"inputs"`
	Kind                 NodeKind                      `json:"kind"`
	NodeKey              string                        `json:"nodeKey"`
	Outputs              []IndecentOutput              `json:"outputs"`
	Repository           IndecentRepository            `json:"repository"`
	Required             bool                          `json:"required"`
	Scope                IndecentScope                 `json:"scope"`
	Task                 IndecentTask                  `json:"task"`
	VerificationProfiles []IndecentVerificationProfile `json:"verificationProfiles"`
}

type FriskyBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type IndecentInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type IndecentOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type IndecentRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type IndecentScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type IndecentTask struct {
	Criteria             []IndecentCriterion `json:"criteria,omitempty"`
	Goal                 *string             `json:"goal,omitempty"`
	Mode                 Mode                `json:"mode"`
	OwnerMemberID        *string             `json:"ownerMemberId,omitempty"`
	Title                *string             `json:"title,omitempty"`
	CriteriaRevision     *int64              `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64              `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64              `json:"expectedTaskRevision,omitempty"`
	TaskID               *string             `json:"taskId,omitempty"`
}

type IndecentCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type IndecentVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type IndigoPolicy struct {
	Budget                          MischievousBudget           `json:"budget"`
	Integration                     Integration                 `json:"integration"`
	IntegrationTargets              []IndecentIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                       `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                        `json:"requireHumanIntegrationApproval"`
}

type MischievousBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type IndecentIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type AuthorKind string

const (
	Agent            AuthorKind = "agent"
	Member           AuthorKind = "member"
	PurpleDiscussion AuthorKind = "discussion"
)

type SourceKind string

const (
	Artifact         SourceKind = "artifact"
	FluffyDiscussion SourceKind = "discussion"
	Memory           SourceKind = "memory"
	Message          SourceKind = "message"
	Result           SourceKind = "result"
	RunEvent         SourceKind = "run_event"
)

type Gate string

const (
	AcceptedResult   Gate = "accepted_result"
	IntegratedCommit Gate = "integrated_commit"
	VerifiedOutput   Gate = "verified_output"
)

type ExternalInputKind string

const (
	Commit     ExternalInputKind = "commit"
	Document   ExternalInputKind = "document"
	Patch      ExternalInputKind = "patch"
	TestResult ExternalInputKind = "test_result"
)

type NodeKind string

const (
	Implementation NodeKind = "implementation"
	KindReview     NodeKind = "review"
	Verification   NodeKind = "verification"
)

type Access string

const (
	IsolatedWrite Access = "isolated_write"
	ReadOnly      Access = "read_only"
)

type Mode string

const (
	Existing Mode = "existing"
	New      Mode = "new"
)

type Integration string

const (
	LocalIntegration  Integration = "local_integration"
	RemotePR          Integration = "remote_pr"
	ReviewedCandidate Integration = "reviewed_candidate"
)

type SchemaVersion string

const (
	The10 SchemaVersion = "1.0"
)

type State string

const (
	Canceled      State = "canceled"
	Completed     State = "completed"
	Draft         State = "draft"
	Paused        State = "paused"
	Running       State = "running"
	StateApproved State = "approved"
	StateReview   State = "review"
)

type DecisionEnum string

const (
	DecisionApproved DecisionEnum = "approved"
	Rejected         DecisionEnum = "rejected"
)

type Action string

const (
	Cancel Action = "cancel"
	Pause  Action = "pause"
	Resume Action = "resume"
)
