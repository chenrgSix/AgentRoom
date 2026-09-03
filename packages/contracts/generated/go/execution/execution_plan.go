// Code generated from JSON Schema; DO NOT EDIT.

package executioncontracts

type ExecutionPlanProjection struct {
	CompiledTasks   []ExecutionPlanProjectionCompiledTask `json:"compiledTasks"`
	ControlRevision int64                                 `json:"controlRevision"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt     string                         `json:"createdAt"`
	Current       ExecutionPlanProjectionCurrent `json:"current"`
	OwnerMemberID string                         `json:"ownerMemberId"`
	PlanID        string                         `json:"planId"`
	RoomID        string                         `json:"roomId"`
	RootTaskID    string                         `json:"rootTaskId"`
	State         ExecutionPlanProjectionState   `json:"state"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt string `json:"updatedAt"`
}

type ExecutionPlanProjectionCompiledTask struct {
	CriteriaRevision   int64  `json:"criteriaRevision"`
	DefinitionRevision int64  `json:"definitionRevision"`
	NodeKey            string `json:"nodeKey"`
	TaskID             string `json:"taskId"`
	TaskRevision       int64  `json:"taskRevision"`
}

type ExecutionPlanProjectionCurrent struct {
	Author PurpleAuthor `json:"author"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt  string           `json:"createdAt"`
	DecisionID string           `json:"decisionId"`
	Definition PurpleDefinition `json:"definition"`
	Digest     string           `json:"digest"`
	PlanID     string           `json:"planId"`
	ProposalID string           `json:"proposalId"`
	Revision   int64            `json:"revision"`
}

type PurpleAuthor struct {
	Kind         AuthorKind `json:"kind"`
	MemberID     *string    `json:"memberId,omitempty"`
	AgentID      *string    `json:"agentId,omitempty"`
	RunID        *string    `json:"runId,omitempty"`
	DiscussionID *string    `json:"discussionId,omitempty"`
}

type PurpleDefinition struct {
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
	Kind          PurpleKind `json:"kind"`
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
	Criteria             []PurpleCriterion   `json:"criteria,omitempty"`
	Goal                 *string             `json:"goal,omitempty"`
	Mode                 TaskMode            `json:"mode"`
	OwnerMemberID        *string             `json:"ownerMemberId,omitempty"`
	SourceAction         *PurpleSourceAction `json:"sourceAction,omitempty"`
	Title                *string             `json:"title,omitempty"`
	CriteriaRevision     *int64              `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64              `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64              `json:"expectedTaskRevision,omitempty"`
	TaskID               *string             `json:"taskId,omitempty"`
}

type PurpleCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type PurpleSourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type PurpleVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type PurplePolicy struct {
	Budget                          FluffyBudget              `json:"budget"`
	Integration                     IntegrationEnum           `json:"integration"`
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

type ExecutionDecisionSourceSnapshot struct {
	Digest   string `json:"digest"`
	Revision int64  `json:"revision"`
	// Bounded canonical JSON evidence archive, not an executable object or an authorization
	// receipt. Its SHA-256 must equal digest.
	SnapshotJSON string                                `json:"snapshotJson"`
	Source       ExecutionDecisionSourceSnapshotSource `json:"source"`
}

type ExecutionDecisionSourceSnapshotSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          PurpleKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type ExecutionPlanPage struct {
	NextAfterPlanID *string                 `json:"nextAfterPlanId"`
	Plans           []ExecutionPlanPagePlan `json:"plans"`
}

type ExecutionPlanPagePlan struct {
	CompiledTasks   []PurpleCompiledTask `json:"compiledTasks"`
	ControlRevision int64                `json:"controlRevision"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt     string                       `json:"createdAt"`
	Current       PurpleCurrent                `json:"current"`
	OwnerMemberID string                       `json:"ownerMemberId"`
	PlanID        string                       `json:"planId"`
	RoomID        string                       `json:"roomId"`
	RootTaskID    string                       `json:"rootTaskId"`
	State         ExecutionPlanProjectionState `json:"state"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt string `json:"updatedAt"`
}

type PurpleCompiledTask struct {
	CriteriaRevision   int64  `json:"criteriaRevision"`
	DefinitionRevision int64  `json:"definitionRevision"`
	NodeKey            string `json:"nodeKey"`
	TaskID             string `json:"taskId"`
	TaskRevision       int64  `json:"taskRevision"`
}

type PurpleCurrent struct {
	Author FluffyAuthor `json:"author"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt  string           `json:"createdAt"`
	DecisionID string           `json:"decisionId"`
	Definition FluffyDefinition `json:"definition"`
	Digest     string           `json:"digest"`
	PlanID     string           `json:"planId"`
	ProposalID string           `json:"proposalId"`
	Revision   int64            `json:"revision"`
}

type FluffyAuthor struct {
	Kind         AuthorKind `json:"kind"`
	MemberID     *string    `json:"memberId,omitempty"`
	AgentID      *string    `json:"agentId,omitempty"`
	RunID        *string    `json:"runId,omitempty"`
	DiscussionID *string    `json:"discussionId,omitempty"`
}

type FluffyDefinition struct {
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
	Kind          PurpleKind `json:"kind"`
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

type FluffyEdge struct {
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
	Criteria             []FluffyCriterion   `json:"criteria,omitempty"`
	Goal                 *string             `json:"goal,omitempty"`
	Mode                 TaskMode            `json:"mode"`
	OwnerMemberID        *string             `json:"ownerMemberId,omitempty"`
	SourceAction         *FluffySourceAction `json:"sourceAction,omitempty"`
	Title                *string             `json:"title,omitempty"`
	CriteriaRevision     *int64              `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64              `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64              `json:"expectedTaskRevision,omitempty"`
	TaskID               *string             `json:"taskId,omitempty"`
}

type FluffyCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type FluffySourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type FluffyVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type FluffyPolicy struct {
	Budget                          StickyBudget              `json:"budget"`
	Integration                     IntegrationEnum           `json:"integration"`
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

type ExecutionPlanRevisionPage struct {
	NextAfterRevision *int64     `json:"nextAfterRevision"`
	Revisions         []Revision `json:"revisions"`
}

type Revision struct {
	Author RevisionAuthor `json:"author"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt  string             `json:"createdAt"`
	DecisionID string             `json:"decisionId"`
	Definition RevisionDefinition `json:"definition"`
	Digest     string             `json:"digest"`
	PlanID     string             `json:"planId"`
	ProposalID string             `json:"proposalId"`
	Revision   int64              `json:"revision"`
}

type RevisionAuthor struct {
	Kind         AuthorKind `json:"kind"`
	MemberID     *string    `json:"memberId,omitempty"`
	AgentID      *string    `json:"agentId,omitempty"`
	RunID        *string    `json:"runId,omitempty"`
	DiscussionID *string    `json:"discussionId,omitempty"`
}

type RevisionDefinition struct {
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
	Kind          PurpleKind `json:"kind"`
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

type TentacledEdge struct {
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
	Criteria             []TentacledCriterion   `json:"criteria,omitempty"`
	Goal                 *string                `json:"goal,omitempty"`
	Mode                 TaskMode               `json:"mode"`
	OwnerMemberID        *string                `json:"ownerMemberId,omitempty"`
	SourceAction         *TentacledSourceAction `json:"sourceAction,omitempty"`
	Title                *string                `json:"title,omitempty"`
	CriteriaRevision     *int64                 `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64                 `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64                 `json:"expectedTaskRevision,omitempty"`
	TaskID               *string                `json:"taskId,omitempty"`
}

type TentacledCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type TentacledSourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type TentacledVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type TentacledPolicy struct {
	Budget                          IndecentBudget               `json:"budget"`
	Integration                     IntegrationEnum              `json:"integration"`
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

type ExecutionDecisionRecord struct {
	Author  ExecutionDecisionRecordAuthor `json:"author"`
	Content Content                       `json:"content"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt            string  `json:"createdAt"`
	DecisionID           string  `json:"decisionId"`
	RoomID               string  `json:"roomId"`
	RootTaskID           string  `json:"rootTaskId"`
	SupersedesDecisionID *string `json:"supersedesDecisionId"`
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
	Kind          PurpleKind `json:"kind"`
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
	Kind          PurpleKind `json:"kind"`
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
	Kind          PurpleKind `json:"kind"`
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

type ExecutionPlanDefinitionEdge struct {
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
	Criteria             []StickyCriterion   `json:"criteria,omitempty"`
	Goal                 *string             `json:"goal,omitempty"`
	Mode                 TaskMode            `json:"mode"`
	OwnerMemberID        *string             `json:"ownerMemberId,omitempty"`
	SourceAction         *StickySourceAction `json:"sourceAction,omitempty"`
	Title                *string             `json:"title,omitempty"`
	CriteriaRevision     *int64              `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64              `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64              `json:"expectedTaskRevision,omitempty"`
	TaskID               *string             `json:"taskId,omitempty"`
}

type StickyCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type StickySourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type StickyVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type ExecutionPlanDefinitionPolicy struct {
	Budget                          AmbitiousBudget           `json:"budget"`
	Integration                     IntegrationEnum           `json:"integration"`
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

type ExecutionPlanProposalCommand struct {
	Definition               ExecutionPlanProposalCommandDefinition `json:"definition"`
	ExpectedRootTaskRevision int64                                  `json:"expectedRootTaskRevision"`
	OperationID              string                                 `json:"operationId"`
}

type ExecutionPlanProposalCommandDefinition struct {
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
	Kind          PurpleKind `json:"kind"`
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
	Criteria             []IndigoCriterion   `json:"criteria,omitempty"`
	Goal                 *string             `json:"goal,omitempty"`
	Mode                 TaskMode            `json:"mode"`
	OwnerMemberID        *string             `json:"ownerMemberId,omitempty"`
	SourceAction         *IndigoSourceAction `json:"sourceAction,omitempty"`
	Title                *string             `json:"title,omitempty"`
	CriteriaRevision     *int64              `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64              `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64              `json:"expectedTaskRevision,omitempty"`
	TaskID               *string             `json:"taskId,omitempty"`
}

type IndigoCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type IndigoSourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type IndigoVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type StickyPolicy struct {
	Budget                          MagentaBudget             `json:"budget"`
	Integration                     IntegrationEnum           `json:"integration"`
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

type DiscussionPlanProposalDraft struct {
	Decision       DiscussionPlanProposalDraftDecision        `json:"decision"`
	Edges          []DiscussionPlanProposalDraftEdge          `json:"edges"`
	ExternalInputs []DiscussionPlanProposalDraftExternalInput `json:"externalInputs"`
	Nodes          []DiscussionPlanProposalDraftNode          `json:"nodes"`
	Policy         DiscussionPlanProposalDraftPolicy          `json:"policy"`
	SchemaVersion  SchemaVersion                              `json:"schemaVersion"`
	Title          string                                     `json:"title"`
}

type DiscussionPlanProposalDraftDecision struct {
	Items               []IndecentItem               `json:"items"`
	Summary             string                       `json:"summary"`
	UnresolvedQuestions []IndecentUnresolvedQuestion `json:"unresolvedQuestions"`
}

type IndecentItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type IndecentUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type DiscussionPlanProposalDraftEdge struct {
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

type DiscussionPlanProposalDraftExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type DiscussionPlanProposalDraftNode struct {
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
	Criteria             []IndecentCriterion   `json:"criteria,omitempty"`
	Goal                 *string               `json:"goal,omitempty"`
	Mode                 TaskMode              `json:"mode"`
	OwnerMemberID        *string               `json:"ownerMemberId,omitempty"`
	SourceAction         *IndecentSourceAction `json:"sourceAction,omitempty"`
	Title                *string               `json:"title,omitempty"`
	CriteriaRevision     *int64                `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64                `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64                `json:"expectedTaskRevision,omitempty"`
	TaskID               *string               `json:"taskId,omitempty"`
}

type IndecentCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type IndecentSourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type IndecentVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type DiscussionPlanProposalDraftPolicy struct {
	Budget                          MischievousBudget           `json:"budget"`
	Integration                     IntegrationEnum             `json:"integration"`
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

type ExecutionPlanRevisionCommand struct {
	Definition               ExecutionPlanRevisionCommandDefinition `json:"definition"`
	ExpectedRevision         int64                                  `json:"expectedRevision"`
	ExpectedRootTaskRevision int64                                  `json:"expectedRootTaskRevision"`
	OperationID              string                                 `json:"operationId"`
}

type ExecutionPlanRevisionCommandDefinition struct {
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
	Items               []HilariousItem               `json:"items"`
	SourceRevisions     []IndecentSourceRevision      `json:"sourceRevisions"`
	Sources             []IndecentSource              `json:"sources"`
	Summary             string                        `json:"summary"`
	UnresolvedQuestions []HilariousUnresolvedQuestion `json:"unresolvedQuestions"`
}

type HilariousItem struct {
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
	Kind          PurpleKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type HilariousUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type IndigoEdge struct {
	Bindings    []HilariousBinding `json:"bindings"`
	EdgeKey     string             `json:"edgeKey"`
	FromNodeKey string             `json:"fromNodeKey"`
	Gate        Gate               `json:"gate"`
	ToNodeKey   string             `json:"toNodeKey"`
}

type HilariousBinding struct {
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
	AgentID              string                         `json:"agentId"`
	Budget               BraggadociousBudget            `json:"budget"`
	Inputs               []HilariousInput               `json:"inputs"`
	Kind                 NodeKind                       `json:"kind"`
	NodeKey              string                         `json:"nodeKey"`
	Outputs              []HilariousOutput              `json:"outputs"`
	Repository           HilariousRepository            `json:"repository"`
	Required             bool                           `json:"required"`
	Scope                HilariousScope                 `json:"scope"`
	Task                 HilariousTask                  `json:"task"`
	VerificationProfiles []HilariousVerificationProfile `json:"verificationProfiles"`
}

type BraggadociousBudget struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type HilariousInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type HilariousOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type HilariousRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type HilariousScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type HilariousTask struct {
	Criteria             []HilariousCriterion   `json:"criteria,omitempty"`
	Goal                 *string                `json:"goal,omitempty"`
	Mode                 TaskMode               `json:"mode"`
	OwnerMemberID        *string                `json:"ownerMemberId,omitempty"`
	SourceAction         *HilariousSourceAction `json:"sourceAction,omitempty"`
	Title                *string                `json:"title,omitempty"`
	CriteriaRevision     *int64                 `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64                 `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64                 `json:"expectedTaskRevision,omitempty"`
	TaskID               *string                `json:"taskId,omitempty"`
}

type HilariousCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type HilariousSourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type HilariousVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type IndigoPolicy struct {
	Budget                          Budget1                      `json:"budget"`
	Integration                     IntegrationEnum              `json:"integration"`
	IntegrationTargets              []HilariousIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                        `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                         `json:"requireHumanIntegrationApproval"`
}

type Budget1 struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type HilariousIntegrationTarget struct {
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

type ExecutionPlanApprovalRecord struct {
	CompiledTasks []ExecutionPlanApprovalRecordCompiledTask `json:"compiledTasks"`
	Decision      DecisionEnum                              `json:"decision"`
	Digest        string                                    `json:"digest"`
	OperationID   string                                    `json:"operationId"`
	PlanID        string                                    `json:"planId"`
	Reason        string                                    `json:"reason"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ReviewedAt             string `json:"reviewedAt"`
	ReviewedByMemberID     string `json:"reviewedByMemberId"`
	Revision               int64  `json:"revision"`
	RootTaskRevisionAfter  int64  `json:"rootTaskRevisionAfter"`
	RootTaskRevisionBefore int64  `json:"rootTaskRevisionBefore"`
}

type ExecutionPlanApprovalRecordCompiledTask struct {
	CriteriaRevision   int64  `json:"criteriaRevision"`
	DefinitionRevision int64  `json:"definitionRevision"`
	NodeKey            string `json:"nodeKey"`
	TaskID             string `json:"taskId"`
	TaskRevision       int64  `json:"taskRevision"`
}

type ExecutionPlanApprovalReceipt struct {
	Approval ExecutionPlanApprovalReceiptApproval `json:"approval"`
	Plan     ExecutionPlanApprovalReceiptPlan     `json:"plan"`
}

type ExecutionPlanApprovalReceiptApproval struct {
	CompiledTasks []FluffyCompiledTask `json:"compiledTasks"`
	Decision      DecisionEnum         `json:"decision"`
	Digest        string               `json:"digest"`
	OperationID   string               `json:"operationId"`
	PlanID        string               `json:"planId"`
	Reason        string               `json:"reason"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ReviewedAt             string `json:"reviewedAt"`
	ReviewedByMemberID     string `json:"reviewedByMemberId"`
	Revision               int64  `json:"revision"`
	RootTaskRevisionAfter  int64  `json:"rootTaskRevisionAfter"`
	RootTaskRevisionBefore int64  `json:"rootTaskRevisionBefore"`
}

type FluffyCompiledTask struct {
	CriteriaRevision   int64  `json:"criteriaRevision"`
	DefinitionRevision int64  `json:"definitionRevision"`
	NodeKey            string `json:"nodeKey"`
	TaskID             string `json:"taskId"`
	TaskRevision       int64  `json:"taskRevision"`
}

type ExecutionPlanApprovalReceiptPlan struct {
	CompiledTasks   []TentacledCompiledTask `json:"compiledTasks"`
	ControlRevision int64                   `json:"controlRevision"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt     string                       `json:"createdAt"`
	Current       FluffyCurrent                `json:"current"`
	OwnerMemberID string                       `json:"ownerMemberId"`
	PlanID        string                       `json:"planId"`
	RoomID        string                       `json:"roomId"`
	RootTaskID    string                       `json:"rootTaskId"`
	State         ExecutionPlanProjectionState `json:"state"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt string `json:"updatedAt"`
}

type TentacledCompiledTask struct {
	CriteriaRevision   int64  `json:"criteriaRevision"`
	DefinitionRevision int64  `json:"definitionRevision"`
	NodeKey            string `json:"nodeKey"`
	TaskID             string `json:"taskId"`
	TaskRevision       int64  `json:"taskRevision"`
}

type FluffyCurrent struct {
	Author TentacledAuthor `json:"author"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt  string              `json:"createdAt"`
	DecisionID string              `json:"decisionId"`
	Definition TentacledDefinition `json:"definition"`
	Digest     string              `json:"digest"`
	PlanID     string              `json:"planId"`
	ProposalID string              `json:"proposalId"`
	Revision   int64               `json:"revision"`
}

type TentacledAuthor struct {
	Kind         AuthorKind `json:"kind"`
	MemberID     *string    `json:"memberId,omitempty"`
	AgentID      *string    `json:"agentId,omitempty"`
	RunID        *string    `json:"runId,omitempty"`
	DiscussionID *string    `json:"discussionId,omitempty"`
}

type TentacledDefinition struct {
	Decision       IndecentDecision        `json:"decision"`
	Edges          []IndecentEdge          `json:"edges"`
	ExternalInputs []IndecentExternalInput `json:"externalInputs"`
	Nodes          []IndecentNode          `json:"nodes"`
	Policy         IndecentPolicy          `json:"policy"`
	RootTaskID     string                  `json:"rootTaskId"`
	SchemaVersion  SchemaVersion           `json:"schemaVersion"`
	Title          string                  `json:"title"`
}

type IndecentDecision struct {
	Items               []AmbitiousItem               `json:"items"`
	SourceRevisions     []HilariousSourceRevision     `json:"sourceRevisions"`
	Sources             []HilariousSource             `json:"sources"`
	Summary             string                        `json:"summary"`
	UnresolvedQuestions []AmbitiousUnresolvedQuestion `json:"unresolvedQuestions"`
}

type AmbitiousItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type HilariousSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type HilariousSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          PurpleKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type AmbitiousUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type IndecentEdge struct {
	Bindings    []AmbitiousBinding `json:"bindings"`
	EdgeKey     string             `json:"edgeKey"`
	FromNodeKey string             `json:"fromNodeKey"`
	Gate        Gate               `json:"gate"`
	ToNodeKey   string             `json:"toNodeKey"`
}

type AmbitiousBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type IndecentExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type IndecentNode struct {
	AgentID              string                         `json:"agentId"`
	Budget               Budget2                        `json:"budget"`
	Inputs               []AmbitiousInput               `json:"inputs"`
	Kind                 NodeKind                       `json:"kind"`
	NodeKey              string                         `json:"nodeKey"`
	Outputs              []AmbitiousOutput              `json:"outputs"`
	Repository           AmbitiousRepository            `json:"repository"`
	Required             bool                           `json:"required"`
	Scope                AmbitiousScope                 `json:"scope"`
	Task                 AmbitiousTask                  `json:"task"`
	VerificationProfiles []AmbitiousVerificationProfile `json:"verificationProfiles"`
}

type Budget2 struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type AmbitiousInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type AmbitiousOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type AmbitiousRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type AmbitiousScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type AmbitiousTask struct {
	Criteria             []AmbitiousCriterion   `json:"criteria,omitempty"`
	Goal                 *string                `json:"goal,omitempty"`
	Mode                 TaskMode               `json:"mode"`
	OwnerMemberID        *string                `json:"ownerMemberId,omitempty"`
	SourceAction         *AmbitiousSourceAction `json:"sourceAction,omitempty"`
	Title                *string                `json:"title,omitempty"`
	CriteriaRevision     *int64                 `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64                 `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64                 `json:"expectedTaskRevision,omitempty"`
	TaskID               *string                `json:"taskId,omitempty"`
}

type AmbitiousCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type AmbitiousSourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type AmbitiousVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type IndecentPolicy struct {
	Budget                          Budget3                      `json:"budget"`
	Integration                     IntegrationEnum              `json:"integration"`
	IntegrationTargets              []AmbitiousIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                        `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                         `json:"requireHumanIntegrationApproval"`
}

type Budget3 struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type AmbitiousIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ExecutionPlanApprovalPage struct {
	Approvals         []ApprovalElement `json:"approvals"`
	NextAfterRevision *int64            `json:"nextAfterRevision"`
}

type ApprovalElement struct {
	CompiledTasks []StickyCompiledTask `json:"compiledTasks"`
	Decision      DecisionEnum         `json:"decision"`
	Digest        string               `json:"digest"`
	OperationID   string               `json:"operationId"`
	PlanID        string               `json:"planId"`
	Reason        string               `json:"reason"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ReviewedAt             string `json:"reviewedAt"`
	ReviewedByMemberID     string `json:"reviewedByMemberId"`
	Revision               int64  `json:"revision"`
	RootTaskRevisionAfter  int64  `json:"rootTaskRevisionAfter"`
	RootTaskRevisionBefore int64  `json:"rootTaskRevisionBefore"`
}

type StickyCompiledTask struct {
	CriteriaRevision   int64  `json:"criteriaRevision"`
	DefinitionRevision int64  `json:"definitionRevision"`
	NodeKey            string `json:"nodeKey"`
	TaskID             string `json:"taskId"`
	TaskRevision       int64  `json:"taskRevision"`
}

type ExecutionPlanControlCommand struct {
	Action                  ExecutionPlanControlCommandAction `json:"action"`
	ExpectedControlRevision int64                             `json:"expectedControlRevision"`
	OperationID             string                            `json:"operationId"`
	Reason                  string                            `json:"reason"`
}

type ExecutionSchedulerControl struct {
	LastOperationID *string                `json:"lastOperationId"`
	Mode            ExecutionSchedulerMode `json:"mode"`
	ModeRevision    int64                  `json:"modeRevision"`
	PlanID          string                 `json:"planId"`
	Reason          string                 `json:"reason"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt         string  `json:"updatedAt"`
	UpdatedByMemberID *string `json:"updatedByMemberId"`
}

type ExecutionSchedulerModeCommand struct {
	ExpectedModeRevision        int64                  `json:"expectedModeRevision"`
	ExpectedPlanControlRevision int64                  `json:"expectedPlanControlRevision"`
	ExpectedPlanDigest          string                 `json:"expectedPlanDigest"`
	ExpectedPlanRevision        int64                  `json:"expectedPlanRevision"`
	Mode                        ExecutionSchedulerMode `json:"mode"`
	OperationID                 string                 `json:"operationId"`
	Reason                      string                 `json:"reason"`
}

type ExecutionSchedulerModeReceipt struct {
	Mode                 ExecutionSchedulerMode `json:"mode"`
	ModeRevision         int64                  `json:"modeRevision"`
	OperationDigest      string                 `json:"operationDigest"`
	OperationID          string                 `json:"operationId"`
	PlanControlRevision  int64                  `json:"planControlRevision"`
	PlanDigest           string                 `json:"planDigest"`
	PlanID               string                 `json:"planId"`
	PlanRevision         int64                  `json:"planRevision"`
	PreviousMode         ExecutionSchedulerMode `json:"previousMode"`
	PreviousModeRevision int64                  `json:"previousModeRevision"`
	Reason               string                 `json:"reason"`
	RequestDigest        string                 `json:"requestDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt         string `json:"updatedAt"`
	UpdatedByMemberID string `json:"updatedByMemberId"`
}

type ExecutionSchedulerManualDispatchCommand struct {
	ExpectedModeRevision           int64  `json:"expectedModeRevision"`
	ExpectedNodeProjectionRevision int64  `json:"expectedNodeProjectionRevision"`
	ExpectedPlanControlRevision    int64  `json:"expectedPlanControlRevision"`
	ExpectedPlanDigest             string `json:"expectedPlanDigest"`
	ExpectedPlanRevision           int64  `json:"expectedPlanRevision"`
	NodeKey                        string `json:"nodeKey"`
	OperationID                    string `json:"operationId"`
	Reason                         string `json:"reason"`
}

type ExecutionSchedulerAdvanceCommand struct {
	ExpectedModeRevision        int64  `json:"expectedModeRevision"`
	ExpectedPlanControlRevision int64  `json:"expectedPlanControlRevision"`
	ExpectedPlanDigest          string `json:"expectedPlanDigest"`
	ExpectedPlanRevision        int64  `json:"expectedPlanRevision"`
	OperationID                 string `json:"operationId"`
	Reason                      string `json:"reason"`
}

type ExecutionSchedulerDispatchReceipt struct {
	Action ExecutionSchedulerDispatchReceiptAction `json:"action"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt           string                 `json:"createdAt"`
	Mode                ExecutionSchedulerMode `json:"mode"`
	ModeRevision        int64                  `json:"modeRevision"`
	OperationDigest     string                 `json:"operationDigest"`
	OperationID         string                 `json:"operationId"`
	PlanControlRevision int64                  `json:"planControlRevision"`
	PlanDigest          string                 `json:"planDigest"`
	PlanID              string                 `json:"planId"`
	PlanRevision        int64                  `json:"planRevision"`
	Reason              string                 `json:"reason"`
	RequestDigest       string                 `json:"requestDigest"`
	RequestedByMemberID string                 `json:"requestedByMemberId"`
	Selection           *Selection             `json:"selection"`
}

type Selection struct {
	DispatchIntentID string `json:"dispatchIntentId"`
	NodeKey          string `json:"nodeKey"`
	RunID            string `json:"runId"`
}

type ExecutionNodeRetryCommand struct {
	AmbiguityAcknowledgementOperationID *string `json:"ambiguityAcknowledgementOperationId"`
	ExpectedControlRevision             int64   `json:"expectedControlRevision"`
	ExpectedNodeProjectionRevision      int64   `json:"expectedNodeProjectionRevision"`
	ExpectedPlanDigest                  string  `json:"expectedPlanDigest"`
	ExpectedPlanRevision                int64   `json:"expectedPlanRevision"`
	ExpectedPreviousGeneration          int64   `json:"expectedPreviousGeneration"`
	ExpectedPreviousRunID               string  `json:"expectedPreviousRunId"`
	NodeKey                             string  `json:"nodeKey"`
	OperationID                         string  `json:"operationId"`
	Reason                              string  `json:"reason"`
}

type ExecutionNodeRetryAuthorization struct {
	AmbiguityAcknowledgementOperationID *string `json:"ambiguityAcknowledgementOperationId"`
	AuthorizationDigest                 string  `json:"authorizationDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt                      string           `json:"createdAt"`
	NewDispatchIntentID            string           `json:"newDispatchIntentId"`
	NewGeneration                  int64            `json:"newGeneration"`
	NewRunID                       string           `json:"newRunId"`
	NodeKey                        string           `json:"nodeKey"`
	OperationID                    string           `json:"operationId"`
	PlanControlRevision            int64            `json:"planControlRevision"`
	PlanDigest                     string           `json:"planDigest"`
	PlanID                         string           `json:"planId"`
	PlanRevision                   int64            `json:"planRevision"`
	PreviousGeneration             int64            `json:"previousGeneration"`
	PreviousNodeProjectionRevision int64            `json:"previousNodeProjectionRevision"`
	PreviousRunID                  string           `json:"previousRunId"`
	PreviousRunState               PreviousRunState `json:"previousRunState"`
	Reason                         string           `json:"reason"`
	RequestDigest                  string           `json:"requestDigest"`
	RequestedByMemberID            string           `json:"requestedByMemberId"`
}

type ExecutionPlanRevision struct {
	Author ExecutionPlanRevisionAuthor `json:"author"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt  string                          `json:"createdAt"`
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
	Decision       HilariousDecision        `json:"decision"`
	Edges          []HilariousEdge          `json:"edges"`
	ExternalInputs []HilariousExternalInput `json:"externalInputs"`
	Nodes          []HilariousNode          `json:"nodes"`
	Policy         HilariousPolicy          `json:"policy"`
	RootTaskID     string                   `json:"rootTaskId"`
	SchemaVersion  SchemaVersion            `json:"schemaVersion"`
	Title          string                   `json:"title"`
}

type HilariousDecision struct {
	Items               []CunningItem               `json:"items"`
	SourceRevisions     []AmbitiousSourceRevision   `json:"sourceRevisions"`
	Sources             []AmbitiousSource           `json:"sources"`
	Summary             string                      `json:"summary"`
	UnresolvedQuestions []CunningUnresolvedQuestion `json:"unresolvedQuestions"`
}

type CunningItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type AmbitiousSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type AmbitiousSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          PurpleKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type CunningUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type HilariousEdge struct {
	Bindings    []CunningBinding `json:"bindings"`
	EdgeKey     string           `json:"edgeKey"`
	FromNodeKey string           `json:"fromNodeKey"`
	Gate        Gate             `json:"gate"`
	ToNodeKey   string           `json:"toNodeKey"`
}

type CunningBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type HilariousExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type HilariousNode struct {
	AgentID              string                       `json:"agentId"`
	Budget               Budget4                      `json:"budget"`
	Inputs               []CunningInput               `json:"inputs"`
	Kind                 NodeKind                     `json:"kind"`
	NodeKey              string                       `json:"nodeKey"`
	Outputs              []CunningOutput              `json:"outputs"`
	Repository           CunningRepository            `json:"repository"`
	Required             bool                         `json:"required"`
	Scope                CunningScope                 `json:"scope"`
	Task                 CunningTask                  `json:"task"`
	VerificationProfiles []CunningVerificationProfile `json:"verificationProfiles"`
}

type Budget4 struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type CunningInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type CunningOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type CunningRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type CunningScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type CunningTask struct {
	Criteria             []CunningCriterion   `json:"criteria,omitempty"`
	Goal                 *string              `json:"goal,omitempty"`
	Mode                 TaskMode             `json:"mode"`
	OwnerMemberID        *string              `json:"ownerMemberId,omitempty"`
	SourceAction         *CunningSourceAction `json:"sourceAction,omitempty"`
	Title                *string              `json:"title,omitempty"`
	CriteriaRevision     *int64               `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64               `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64               `json:"expectedTaskRevision,omitempty"`
	TaskID               *string              `json:"taskId,omitempty"`
}

type CunningCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type CunningSourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type CunningVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type HilariousPolicy struct {
	Budget                          Budget5                    `json:"budget"`
	Integration                     IntegrationEnum            `json:"integration"`
	IntegrationTargets              []CunningIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                      `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                       `json:"requireHumanIntegrationApproval"`
}

type Budget5 struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type CunningIntegrationTarget struct {
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
	Decision       AmbitiousDecision        `json:"decision"`
	Edges          []AmbitiousEdge          `json:"edges"`
	ExternalInputs []AmbitiousExternalInput `json:"externalInputs"`
	Nodes          []AmbitiousNode          `json:"nodes"`
	Policy         AmbitiousPolicy          `json:"policy"`
	RootTaskID     string                   `json:"rootTaskId"`
	SchemaVersion  SchemaVersion            `json:"schemaVersion"`
	Title          string                   `json:"title"`
}

type AmbitiousDecision struct {
	Items               []MagentaItem               `json:"items"`
	SourceRevisions     []CunningSourceRevision     `json:"sourceRevisions"`
	Sources             []CunningSource             `json:"sources"`
	Summary             string                      `json:"summary"`
	UnresolvedQuestions []MagentaUnresolvedQuestion `json:"unresolvedQuestions"`
}

type MagentaItem struct {
	ItemKey   string `json:"itemKey"`
	Statement string `json:"statement"`
}

type CunningSourceRevision struct {
	EvidenceRefID string `json:"evidenceRefId"`
	Revision      int64  `json:"revision"`
}

type CunningSource struct {
	ArtifactID    *string    `json:"artifactId,omitempty"`
	EvidenceRefID string     `json:"evidenceRefId"`
	Kind          PurpleKind `json:"kind"`
	RunID         *string    `json:"runId,omitempty"`
	Sequence      *int64     `json:"sequence,omitempty"`
	MessageID     *string    `json:"messageId,omitempty"`
	MemoryID      *string    `json:"memoryId,omitempty"`
	DiscussionID  *string    `json:"discussionId,omitempty"`
	ResultID      *string    `json:"resultId,omitempty"`
}

type MagentaUnresolvedQuestion struct {
	QuestionKey string `json:"questionKey"`
	Required    bool   `json:"required"`
	Text        string `json:"text"`
}

type AmbitiousEdge struct {
	Bindings    []MagentaBinding `json:"bindings"`
	EdgeKey     string           `json:"edgeKey"`
	FromNodeKey string           `json:"fromNodeKey"`
	Gate        Gate             `json:"gate"`
	ToNodeKey   string           `json:"toNodeKey"`
}

type MagentaBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type AmbitiousExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type AmbitiousNode struct {
	AgentID              string                       `json:"agentId"`
	Budget               Budget6                      `json:"budget"`
	Inputs               []MagentaInput               `json:"inputs"`
	Kind                 NodeKind                     `json:"kind"`
	NodeKey              string                       `json:"nodeKey"`
	Outputs              []MagentaOutput              `json:"outputs"`
	Repository           MagentaRepository            `json:"repository"`
	Required             bool                         `json:"required"`
	Scope                MagentaScope                 `json:"scope"`
	Task                 MagentaTask                  `json:"task"`
	VerificationProfiles []MagentaVerificationProfile `json:"verificationProfiles"`
}

type Budget6 struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type MagentaInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type MagentaOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type MagentaRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type MagentaScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type MagentaTask struct {
	Criteria             []MagentaCriterion   `json:"criteria,omitempty"`
	Goal                 *string              `json:"goal,omitempty"`
	Mode                 TaskMode             `json:"mode"`
	OwnerMemberID        *string              `json:"ownerMemberId,omitempty"`
	SourceAction         *MagentaSourceAction `json:"sourceAction,omitempty"`
	Title                *string              `json:"title,omitempty"`
	CriteriaRevision     *int64               `json:"criteriaRevision,omitempty"`
	DefinitionRevision   *int64               `json:"definitionRevision,omitempty"`
	ExpectedTaskRevision *int64               `json:"expectedTaskRevision,omitempty"`
	TaskID               *string              `json:"taskId,omitempty"`
}

type MagentaCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type MagentaSourceAction struct {
	NextActionKey string `json:"nextActionKey"`
	ResultID      string `json:"resultId"`
}

type MagentaVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type AmbitiousPolicy struct {
	Budget                          Budget7                    `json:"budget"`
	Integration                     IntegrationEnum            `json:"integration"`
	IntegrationTargets              []MagentaIntegrationTarget `json:"integrationTargets"`
	MaxConcurrency                  int64                      `json:"maxConcurrency"`
	RequireHumanIntegrationApproval bool                       `json:"requireHumanIntegrationApproval"`
}

type Budget7 struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type MagentaIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type GovernedExecutionManifest struct {
	Capture *GovernedExecutionManifestCapture `json:"capture,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline             string                                         `json:"deadline"`
	Grant                GovernedExecutionManifestGrant                 `json:"grant"`
	InputDigest          string                                         `json:"inputDigest"`
	Inputs               []GovernedExecutionManifestInput               `json:"inputs"`
	ManifestDigest       string                                         `json:"manifestDigest"`
	Outputs              []GovernedExecutionManifestOutput              `json:"outputs"`
	Repository           GovernedExecutionManifestRepository            `json:"repository"`
	Scope                GovernedExecutionManifestScope                 `json:"scope"`
	ScopePolicy          GovernedExecutionManifestScopePolicy           `json:"scopePolicy"`
	VerificationProfiles []GovernedExecutionManifestVerificationProfile `json:"verificationProfiles"`
	Version              int64                                          `json:"version"`
	Workspace            GovernedExecutionManifestWorkspace             `json:"workspace"`
}

type GovernedExecutionManifestCapture struct {
	OperationID string         `json:"operationId"`
	Outputs     []FriskyOutput `json:"outputs"`
	RootTaskID  string         `json:"rootTaskId"`
}

type FriskyOutput struct {
	Path    *string `json:"path"`
	SlotKey string  `json:"slotKey"`
	Summary string  `json:"summary"`
	Title   string  `json:"title"`
}

type GovernedExecutionManifestGrant struct {
	Digest string `json:"digest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt string `json:"expiresAt"`
	GrantID   string `json:"grantId"`
	Revision  int64  `json:"revision"`
}

type GovernedExecutionManifestInput struct {
	Artifact            PurpleArtifact `json:"artifact"`
	BindingID           string         `json:"bindingId"`
	DestinationAgentID  string         `json:"destinationAgentId"`
	DestinationDeviceID string         `json:"destinationDeviceId"`
	DestinationRunID    string         `json:"destinationRunId"`
	DestinationTaskID   string         `json:"destinationTaskId"`
	EdgeKey             *string        `json:"edgeKey"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt       string `json:"expiresAt"`
	Gate            Gate   `json:"gate"`
	GateDigest      string `json:"gateDigest"`
	GateOperationID string `json:"gateOperationId"`
	InputSlot       string `json:"inputSlot"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt                 string                 `json:"issuedAt"`
	PlanID                   string                 `json:"planId"`
	PlanRevision             int64                  `json:"planRevision"`
	RepositoryID             *string                `json:"repositoryId"`
	SourceAuthority          *PurpleSourceAuthority `json:"sourceAuthority,omitempty"`
	SourceCommit             *string                `json:"sourceCommit"`
	SourceCriteriaRevision   int64                  `json:"sourceCriteriaRevision"`
	SourceDefinitionRevision int64                  `json:"sourceDefinitionRevision"`
	SourceOutputSlot         string                 `json:"sourceOutputSlot"`
	SourceResultID           *string                `json:"sourceResultId"`
	SourceResultVersion      *int64                 `json:"sourceResultVersion"`
	SourceTaskID             string                 `json:"sourceTaskId"`
	SourceTree               *string                `json:"sourceTree"`
}

type PurpleArtifact struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
}

type PurpleSourceAuthority struct {
	AdoptionDigest   string `json:"adoptionDigest"`
	AdoptionID       string `json:"adoptionId"`
	SourceDigest     string `json:"sourceDigest"`
	SourceEvidenceID string `json:"sourceEvidenceId"`
}

type GovernedExecutionManifestOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type GovernedExecutionManifestRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type GovernedExecutionManifestScope struct {
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

type GovernedExecutionManifestScopePolicy struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type GovernedExecutionManifestVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type GovernedExecutionManifestWorkspace struct {
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt string `json:"expiresAt"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt            string        `json:"issuedAt"`
	LeaseID             string        `json:"leaseId"`
	Mode                WorkspaceMode `json:"mode"`
	WorkspaceGeneration string        `json:"workspaceGeneration"`
	WorkspaceRef        string        `json:"workspaceRef"`
}

type ExecutionInputBinding struct {
	Artifact            ExecutionInputBindingArtifact `json:"artifact"`
	BindingID           string                        `json:"bindingId"`
	DestinationAgentID  string                        `json:"destinationAgentId"`
	DestinationDeviceID string                        `json:"destinationDeviceId"`
	DestinationRunID    string                        `json:"destinationRunId"`
	DestinationTaskID   string                        `json:"destinationTaskId"`
	EdgeKey             *string                       `json:"edgeKey"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt       string `json:"expiresAt"`
	Gate            Gate   `json:"gate"`
	GateDigest      string `json:"gateDigest"`
	GateOperationID string `json:"gateOperationId"`
	InputSlot       string `json:"inputSlot"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt                 string                                `json:"issuedAt"`
	PlanID                   string                                `json:"planId"`
	PlanRevision             int64                                 `json:"planRevision"`
	RepositoryID             *string                               `json:"repositoryId"`
	SourceAuthority          *ExecutionInputBindingSourceAuthority `json:"sourceAuthority,omitempty"`
	SourceCommit             *string                               `json:"sourceCommit"`
	SourceCriteriaRevision   int64                                 `json:"sourceCriteriaRevision"`
	SourceDefinitionRevision int64                                 `json:"sourceDefinitionRevision"`
	SourceOutputSlot         string                                `json:"sourceOutputSlot"`
	SourceResultID           *string                               `json:"sourceResultId"`
	SourceResultVersion      *int64                                `json:"sourceResultVersion"`
	SourceTaskID             string                                `json:"sourceTaskId"`
	SourceTree               *string                               `json:"sourceTree"`
}

type ExecutionInputBindingArtifact struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
}

type ExecutionInputBindingSourceAuthority struct {
	AdoptionDigest   string `json:"adoptionDigest"`
	AdoptionID       string `json:"adoptionId"`
	SourceDigest     string `json:"sourceDigest"`
	SourceEvidenceID string `json:"sourceEvidenceId"`
}

type GovernedExecutionCapability struct {
	Operations                []KindElement `json:"operations"`
	PreventivePathEnforcement bool          `json:"preventivePathEnforcement"`
	// Path-free current local grant summaries available to one published Agent. Omission means
	// no admission-ready grant was published and grants no authority.
	ReadyGrants       []GovernedExecutionCapabilityReadyGrant `json:"readyGrants,omitempty"`
	Version           int64                                   `json:"version"`
	WorkspaceBoundary WorkspaceBoundary                       `json:"workspaceBoundary"`
}

type GovernedExecutionCapabilityReadyGrant struct {
	AgentID            string                    `json:"agentId"`
	BindingID          string                    `json:"bindingId"`
	DeviceID           string                    `json:"deviceId"`
	Grant              PurpleGrant               `json:"grant"`
	IntegrationTargets []FriskyIntegrationTarget `json:"integrationTargets"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt             string                      `json:"issuedAt"`
	NodeKey              string                      `json:"nodeKey"`
	Operations           []KindElement               `json:"operations"`
	PlanID               string                      `json:"planId"`
	RepositoryID         string                      `json:"repositoryId"`
	RevokedAt            *string                     `json:"revokedAt"`
	RuntimeProfile       PurpleRuntimeProfile        `json:"runtimeProfile"`
	ScopePolicy          PurpleScopePolicy           `json:"scopePolicy"`
	VerificationProfiles []FriskyVerificationProfile `json:"verificationProfiles"`
}

type PurpleGrant struct {
	Digest string `json:"digest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt string `json:"expiresAt"`
	GrantID   string `json:"grantId"`
	Revision  int64  `json:"revision"`
}

type FriskyIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type PurpleRuntimeProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type PurpleScopePolicy struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type FriskyVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type RuntimeAuthorityRequest struct {
	LeaseID             string `json:"leaseId"`
	ManifestDigest      string `json:"manifestDigest"`
	RunID               string `json:"runId"`
	Version             int64  `json:"version"`
	WorkspaceGeneration string `json:"workspaceGeneration"`
	WorkspaceRef        string `json:"workspaceRef"`
}

type RuntimeAuthorityView struct {
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CheckedAt string `json:"checkedAt"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt           string                    `json:"expiresAt"`
	LeaseID             string                    `json:"leaseId"`
	LeaseRevision       int64                     `json:"leaseRevision"`
	ManifestDigest      string                    `json:"manifestDigest"`
	RunID               string                    `json:"runId"`
	State               RuntimeAuthorityViewState `json:"state"`
	Version             int64                     `json:"version"`
	WorkspaceGeneration string                    `json:"workspaceGeneration"`
	WorkspaceRef        string                    `json:"workspaceRef"`
}

type RepositoryBindingSummary struct {
	BindingID      string                                 `json:"bindingId"`
	Capability     Capability                             `json:"capability"`
	DeviceID       string                                 `json:"deviceId"`
	ObservedCommit string                                 `json:"observedCommit"`
	RepositoryID   string                                 `json:"repositoryId"`
	Revision       int64                                  `json:"revision"`
	RuntimeProfile RepositoryBindingSummaryRuntimeProfile `json:"runtimeProfile"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt            string                                        `json:"updatedAt"`
	VerificationProfiles []RepositoryBindingSummaryVerificationProfile `json:"verificationProfiles"`
	WorkspaceGeneration  string                                        `json:"workspaceGeneration"`
	WorkspaceRef         string                                        `json:"workspaceRef"`
}

type Capability struct {
	Operations                []KindElement `json:"operations"`
	PreventivePathEnforcement bool          `json:"preventivePathEnforcement"`
	// Path-free current local grant summaries available to one published Agent. Omission means
	// no admission-ready grant was published and grants no authority.
	ReadyGrants       []CapabilityReadyGrant `json:"readyGrants,omitempty"`
	Version           int64                  `json:"version"`
	WorkspaceBoundary WorkspaceBoundary      `json:"workspaceBoundary"`
}

type CapabilityReadyGrant struct {
	AgentID            string                         `json:"agentId"`
	BindingID          string                         `json:"bindingId"`
	DeviceID           string                         `json:"deviceId"`
	Grant              FluffyGrant                    `json:"grant"`
	IntegrationTargets []MischievousIntegrationTarget `json:"integrationTargets"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt             string                           `json:"issuedAt"`
	NodeKey              string                           `json:"nodeKey"`
	Operations           []KindElement                    `json:"operations"`
	PlanID               string                           `json:"planId"`
	RepositoryID         string                           `json:"repositoryId"`
	RevokedAt            *string                          `json:"revokedAt"`
	RuntimeProfile       FluffyRuntimeProfile             `json:"runtimeProfile"`
	ScopePolicy          FluffyScopePolicy                `json:"scopePolicy"`
	VerificationProfiles []MischievousVerificationProfile `json:"verificationProfiles"`
}

type FluffyGrant struct {
	Digest string `json:"digest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt string `json:"expiresAt"`
	GrantID   string `json:"grantId"`
	Revision  int64  `json:"revision"`
}

type MischievousIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type FluffyRuntimeProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type FluffyScopePolicy struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type MischievousVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type RepositoryBindingSummaryRuntimeProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type RepositoryBindingSummaryVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type ExecutionGrantSummary struct {
	AgentID            string                                   `json:"agentId"`
	BindingID          string                                   `json:"bindingId"`
	DeviceID           string                                   `json:"deviceId"`
	Grant              ExecutionGrantSummaryGrant               `json:"grant"`
	IntegrationTargets []ExecutionGrantSummaryIntegrationTarget `json:"integrationTargets"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt             string                                     `json:"issuedAt"`
	NodeKey              string                                     `json:"nodeKey"`
	Operations           []KindElement                              `json:"operations"`
	PlanID               string                                     `json:"planId"`
	RepositoryID         string                                     `json:"repositoryId"`
	RevokedAt            *string                                    `json:"revokedAt"`
	RuntimeProfile       ExecutionGrantSummaryRuntimeProfile        `json:"runtimeProfile"`
	ScopePolicy          ExecutionGrantSummaryScopePolicy           `json:"scopePolicy"`
	VerificationProfiles []ExecutionGrantSummaryVerificationProfile `json:"verificationProfiles"`
}

type ExecutionGrantSummaryGrant struct {
	Digest string `json:"digest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt string `json:"expiresAt"`
	GrantID   string `json:"grantId"`
	Revision  int64  `json:"revision"`
}

type ExecutionGrantSummaryIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ExecutionGrantSummaryRuntimeProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type ExecutionGrantSummaryScopePolicy struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type ExecutionGrantSummaryVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type RepositoryOperationRequest struct {
	Action    ActionClass `json:"action"`
	BindingID string      `json:"bindingId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline           string                               `json:"deadline"`
	DeviceID           string                               `json:"deviceId"`
	Execution          *RepositoryOperationRequestExecution `json:"execution"`
	ExpectedGeneration string                               `json:"expectedGeneration"`
	Grant              RepositoryOperationRequestGrant      `json:"grant"`
	OperationID        string                               `json:"operationId"`
	Plan               RepositoryOperationRequestPlan       `json:"plan"`
	RepositoryID       string                               `json:"repositoryId"`
	RequestDigest      string                               `json:"requestDigest"`
	Version            int64                                `json:"version"`
}

type ActionClass struct {
	Kind      KindElement     `json:"kind"`
	Prepare   *PrepareClass   `json:"prepare,omitempty"`
	Capture   *ActionCapture  `json:"capture,omitempty"`
	Verify    *VerifyClass    `json:"verify,omitempty"`
	Integrate *IntegrateClass `json:"integrate,omitempty"`
	Publish   *PublishClass   `json:"publish,omitempty"`
	Observe   *ObserveClass   `json:"observe,omitempty"`
}

type ActionCapture struct {
	ManifestDigest string `json:"manifestDigest"`
}

type IntegrateClass struct {
	CandidateCommit                string          `json:"candidateCommit"`
	CandidateTree                  string          `json:"candidateTree"`
	InputDigest                    string          `json:"inputDigest"`
	IntegrationApprovalOperationID string          `json:"integrationApprovalOperationId"`
	Target                         IntegrateTarget `json:"target"`
	VerificationIDS                []string        `json:"verificationIds"`
}

type IntegrateTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ObserveClass struct {
	CandidateCommit     string   `json:"candidateCommit"`
	CheckKeys           []string `json:"checkKeys"`
	ProviderBindingID   string   `json:"providerBindingId"`
	ProviderOperationID *string  `json:"providerOperationId"`
}

type PrepareClass struct {
	Manifest           Manifest `json:"manifest"`
	ResumeCheckpointID *string  `json:"resumeCheckpointId"`
}

type Manifest struct {
	Capture *ManifestCapture `json:"capture,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline             string                        `json:"deadline"`
	Grant                ManifestGrant                 `json:"grant"`
	InputDigest          string                        `json:"inputDigest"`
	Inputs               []ManifestInput               `json:"inputs"`
	ManifestDigest       string                        `json:"manifestDigest"`
	Outputs              []ManifestOutput              `json:"outputs"`
	Repository           ManifestRepository            `json:"repository"`
	Scope                ManifestScope                 `json:"scope"`
	ScopePolicy          ManifestScopePolicy           `json:"scopePolicy"`
	VerificationProfiles []ManifestVerificationProfile `json:"verificationProfiles"`
	Version              int64                         `json:"version"`
	Workspace            ManifestWorkspace             `json:"workspace"`
}

type ManifestCapture struct {
	OperationID string              `json:"operationId"`
	Outputs     []MischievousOutput `json:"outputs"`
	RootTaskID  string              `json:"rootTaskId"`
}

type MischievousOutput struct {
	Path    *string `json:"path"`
	SlotKey string  `json:"slotKey"`
	Summary string  `json:"summary"`
	Title   string  `json:"title"`
}

type ManifestGrant struct {
	Digest string `json:"digest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt string `json:"expiresAt"`
	GrantID   string `json:"grantId"`
	Revision  int64  `json:"revision"`
}

type ManifestInput struct {
	Artifact            FluffyArtifact `json:"artifact"`
	BindingID           string         `json:"bindingId"`
	DestinationAgentID  string         `json:"destinationAgentId"`
	DestinationDeviceID string         `json:"destinationDeviceId"`
	DestinationRunID    string         `json:"destinationRunId"`
	DestinationTaskID   string         `json:"destinationTaskId"`
	EdgeKey             *string        `json:"edgeKey"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt       string `json:"expiresAt"`
	Gate            Gate   `json:"gate"`
	GateDigest      string `json:"gateDigest"`
	GateOperationID string `json:"gateOperationId"`
	InputSlot       string `json:"inputSlot"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt                 string                 `json:"issuedAt"`
	PlanID                   string                 `json:"planId"`
	PlanRevision             int64                  `json:"planRevision"`
	RepositoryID             *string                `json:"repositoryId"`
	SourceAuthority          *FluffySourceAuthority `json:"sourceAuthority,omitempty"`
	SourceCommit             *string                `json:"sourceCommit"`
	SourceCriteriaRevision   int64                  `json:"sourceCriteriaRevision"`
	SourceDefinitionRevision int64                  `json:"sourceDefinitionRevision"`
	SourceOutputSlot         string                 `json:"sourceOutputSlot"`
	SourceResultID           *string                `json:"sourceResultId"`
	SourceResultVersion      *int64                 `json:"sourceResultVersion"`
	SourceTaskID             string                 `json:"sourceTaskId"`
	SourceTree               *string                `json:"sourceTree"`
}

type FluffyArtifact struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
}

type FluffySourceAuthority struct {
	AdoptionDigest   string `json:"adoptionDigest"`
	AdoptionID       string `json:"adoptionId"`
	SourceDigest     string `json:"sourceDigest"`
	SourceEvidenceID string `json:"sourceEvidenceId"`
}

type ManifestOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type ManifestRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type ManifestScope struct {
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

type ManifestScopePolicy struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type ManifestVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type ManifestWorkspace struct {
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt string `json:"expiresAt"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	IssuedAt            string        `json:"issuedAt"`
	LeaseID             string        `json:"leaseId"`
	Mode                WorkspaceMode `json:"mode"`
	WorkspaceGeneration string        `json:"workspaceGeneration"`
	WorkspaceRef        string        `json:"workspaceRef"`
}

type PublishClass struct {
	CandidateCommit        string        `json:"candidateCommit"`
	IntegrationOperationID string        `json:"integrationOperationId"`
	Mode                   PublishMode   `json:"mode"`
	ProviderBindingID      string        `json:"providerBindingId"`
	Target                 PublishTarget `json:"target"`
}

type PublishTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type VerifyClass struct {
	CandidateCommit string        `json:"candidateCommit"`
	CandidateTree   string        `json:"candidateTree"`
	InputDigest     string        `json:"inputDigest"`
	Profile         VerifyProfile `json:"profile"`
}

type VerifyProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type RepositoryOperationRequestExecution struct {
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

type RepositoryOperationRequestGrant struct {
	Digest string `json:"digest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ExpiresAt string `json:"expiresAt"`
	GrantID   string `json:"grantId"`
	Revision  int64  `json:"revision"`
}

type RepositoryOperationRequestPlan struct {
	ApprovalOperationID string `json:"approvalOperationId"`
	Digest              string `json:"digest"`
	PlanID              string `json:"planId"`
	Revision            int64  `json:"revision"`
	RoomID              string `json:"roomId"`
	RootTaskID          string `json:"rootTaskId"`
}

type RepositoryOperationReceipt struct {
	BindingID             string      `json:"bindingId"`
	CandidateCommit       *string     `json:"candidateCommit"`
	CandidateTree         *string     `json:"candidateTree"`
	CheckpointID          *string     `json:"checkpointId"`
	DeviceID              string      `json:"deviceId"`
	ErrorCode             *string     `json:"errorCode"`
	Kind                  KindElement `json:"kind"`
	ObservedGeneration    *string     `json:"observedGeneration"`
	OperationID           string      `json:"operationId"`
	ProviderObservationID *string     `json:"providerObservationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt     string                            `json:"recordedAt"`
	RepositoryID   string                            `json:"repositoryId"`
	RequestDigest  string                            `json:"requestDigest"`
	State          RepositoryOperationReceiptState   `json:"state"`
	Target         *RepositoryOperationReceiptTarget `json:"target"`
	VerificationID *string                           `json:"verificationId"`
	Version        int64                             `json:"version"`
}

type RepositoryOperationReceiptTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type RepositoryCheckpoint struct {
	BaseCommit      string `json:"baseCommit"`
	BindingID       string `json:"bindingId"`
	CandidateCommit string `json:"candidateCommit"`
	CandidateTree   string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CapturedAt          string                       `json:"capturedAt"`
	CheckpointID        string                       `json:"checkpointId"`
	Digest              string                       `json:"digest"`
	InputDigest         string                       `json:"inputDigest"`
	OperationID         string                       `json:"operationId"`
	Outputs             []RepositoryCheckpointOutput `json:"outputs"`
	RepositoryID        string                       `json:"repositoryId"`
	Scope               RepositoryCheckpointScope    `json:"scope"`
	WorkspaceGeneration string                       `json:"workspaceGeneration"`
	WorkspaceRef        string                       `json:"workspaceRef"`
}

type RepositoryCheckpointOutput struct {
	Artifact OutputArtifact `json:"artifact"`
	SlotKey  string         `json:"slotKey"`
}

type OutputArtifact struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
}

type RepositoryCheckpointScope struct {
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

type VerificationReceipt struct {
	Authority            VerificationReceiptAuthority  `json:"authority"`
	BindingID            *string                       `json:"bindingId"`
	CandidateCommit      string                        `json:"candidateCommit"`
	CandidateTree        string                        `json:"candidateTree"`
	DurationMilliseconds int64                         `json:"durationMilliseconds"`
	Execution            *VerificationReceiptExecution `json:"execution"`
	ExitCode             *int64                        `json:"exitCode"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	FinishedAt             string                          `json:"finishedAt"`
	InputDigest            string                          `json:"inputDigest"`
	IntegrationOperationID *string                         `json:"integrationOperationId"`
	LogArtifact            *VerificationReceiptLogArtifact `json:"logArtifact"`
	OperationID            string                          `json:"operationId"`
	Outcome                VerificationReceiptOutcome      `json:"outcome"`
	Plan                   VerificationReceiptPlan         `json:"plan"`
	Profile                VerificationReceiptProfile      `json:"profile"`
	RepositoryID           string                          `json:"repositoryId"`
	RequestDigest          string                          `json:"requestDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	StartedAt      string `json:"startedAt"`
	VerificationID string `json:"verificationId"`
	Version        int64  `json:"version"`
}

type Authority = VerificationReceiptAuthority

type VerificationReceiptAuthority struct {
	DeviceID          *string       `json:"deviceId,omitempty"`
	Kind              AuthorityKind `json:"kind"`
	Attempt           *int64        `json:"attempt,omitempty"`
	CheckKey          *string       `json:"checkKey,omitempty"`
	ProviderBindingID *string       `json:"providerBindingId,omitempty"`
}

type VerificationReceiptExecution struct {
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

type VerificationReceiptLogArtifact struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
}

type VerificationReceiptPlan struct {
	ApprovalOperationID string `json:"approvalOperationId"`
	Digest              string `json:"digest"`
	PlanID              string `json:"planId"`
	Revision            int64  `json:"revision"`
	RoomID              string `json:"roomId"`
	RootTaskID          string `json:"rootTaskId"`
}

type VerificationReceiptProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type SourceEvidence struct {
	AgentID      *string                     `json:"agentId,omitempty"`
	ArtifactPins []SourceEvidenceArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string                `json:"createdAt"`
	CriteriaRevision   *int64                `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64                `json:"definitionRevision,omitempty"`
	DeviceID           *string               `json:"deviceId,omitempty"`
	DispatchGeneration *int64                `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind    `json:"kind"`
	ResultID           *string               `json:"resultId,omitempty"`
	ResultVersion      *int64                `json:"resultVersion,omitempty"`
	RoomID             *string               `json:"roomId,omitempty"`
	SourceDigest       string                `json:"sourceDigest"`
	SourceEvidenceID   string                `json:"sourceEvidenceId"`
	SourceRunID        *string               `json:"sourceRunId,omitempty"`
	TaskID             *string               `json:"taskId,omitempty"`
	Version            int64                 `json:"version"`
	Commit             *string               `json:"commit,omitempty"`
	InputDigest        *string               `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat         `json:"objectFormat,omitempty"`
	Origin             *SourceEvidenceOrigin `json:"origin,omitempty"`
	RepositoryID       *string               `json:"repositoryId,omitempty"`
	Tree               *string               `json:"tree,omitempty"`
}

type SourceEvidenceArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type SourceEvidenceOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type GateProofRef struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type EvidenceAdoption struct {
	AdoptionDigest string                    `json:"adoptionDigest"`
	AdoptionID     string                    `json:"adoptionId"`
	Authority      EvidenceAdoptionAuthority `json:"authority"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt              string                           `json:"createdAt"`
	Gate                   Gate                             `json:"gate"`
	NodeContractDigest     string                           `json:"nodeContractDigest"`
	NodeKey                string                           `json:"nodeKey"`
	OperationDigest        string                           `json:"operationDigest"`
	OperationID            string                           `json:"operationId"`
	PlanID                 string                           `json:"planId"`
	PlanRevision           int64                            `json:"planRevision"`
	Proofs                 []EvidenceAdoptionProof          `json:"proofs"`
	ProofSetDigest         string                           `json:"proofSetDigest"`
	ResolvedInputSetDigest string                           `json:"resolvedInputSetDigest"`
	SourceDigest           string                           `json:"sourceDigest"`
	SourceEvidenceID       string                           `json:"sourceEvidenceId"`
	SourceExecution        *EvidenceAdoptionSourceExecution `json:"sourceExecution"`
	Version                int64                            `json:"version"`
}

type EvidenceAdoptionAuthority struct {
	AgentID             *string `json:"agentId,omitempty"`
	ApprovalOperationID string  `json:"approvalOperationId"`
	CriteriaRevision    int64   `json:"criteriaRevision"`
	DefinitionRevision  int64   `json:"definitionRevision"`
	DeviceID            *string `json:"deviceId,omitempty"`
	GrantDigest         *string `json:"grantDigest,omitempty"`
	GrantID             *string `json:"grantId,omitempty"`
	GrantRevision       *int64  `json:"grantRevision,omitempty"`
	PlanDigest          string  `json:"planDigest"`
	RoomID              string  `json:"roomId"`
	Service             Service `json:"service"`
	TaskID              string  `json:"taskId"`
	ActorMemberID       *string `json:"actorMemberId,omitempty"`
	BindingDigest       *string `json:"bindingDigest,omitempty"`
	ProviderBindingID   *string `json:"providerBindingId,omitempty"`
}

type EvidenceAdoptionProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type EvidenceAdoptionSourceExecution struct {
	DispatchGeneration int64  `json:"dispatchGeneration"`
	RunID              string `json:"runId"`
}

type EvidenceReuseContract struct {
	AdoptionDigest string `json:"adoptionDigest"`
	AdoptionID     string `json:"adoptionId"`
	ContractDigest string `json:"contractDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt                 string                    `json:"createdAt"`
	Gate                      Gate                      `json:"gate"`
	IntegrationPolicy         IntegrationPolicy         `json:"integrationPolicy"`
	Node                      EvidenceReuseContractNode `json:"node"`
	NodeExecutionDigest       string                    `json:"nodeExecutionDigest"`
	NodeKey                   string                    `json:"nodeKey"`
	NodeReuseContractDigest   string                    `json:"nodeReuseContractDigest"`
	PlanID                    string                    `json:"planId"`
	PlanRevision              int64                     `json:"planRevision"`
	ReuseContractID           string                    `json:"reuseContractId"`
	ReuseInputEvidenceDigest  string                    `json:"reuseInputEvidenceDigest"`
	ReuseInputs               []ReuseInputElement       `json:"reuseInputs"`
	RuntimeInputBindingDigest string                    `json:"runtimeInputBindingDigest"`
	Task                      EvidenceReuseContractTask `json:"task"`
	Version                   int64                     `json:"version"`
}

type IntegrationPolicy struct {
	Integration                     IntegrationEnum                      `json:"integration"`
	IntegrationTargets              []IntegrationPolicyIntegrationTarget `json:"integrationTargets"`
	RequireHumanIntegrationApproval bool                                 `json:"requireHumanIntegrationApproval"`
}

type IntegrationPolicyIntegrationTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type EvidenceReuseContractNode struct {
	AgentID              string                             `json:"agentId"`
	Budget               Budget8                            `json:"budget"`
	Inputs               []FriskyInput                      `json:"inputs"`
	Kind                 NodeKind                           `json:"kind"`
	NodeKey              string                             `json:"nodeKey"`
	Outputs              []BraggadociousOutput              `json:"outputs"`
	Repository           FriskyRepository                   `json:"repository"`
	Required             bool                               `json:"required"`
	Scope                FriskyScope                        `json:"scope"`
	VerificationProfiles []BraggadociousVerificationProfile `json:"verificationProfiles"`
}

type Budget8 struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type FriskyInput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type BraggadociousOutput struct {
	Kind     ExternalInputKind `json:"kind"`
	Required bool              `json:"required"`
	SlotKey  string            `json:"slotKey"`
}

type FriskyRepository struct {
	BaseCommit           string `json:"baseCommit"`
	BindingID            string `json:"bindingId"`
	GrantID              string `json:"grantId"`
	GrantRevision        int64  `json:"grantRevision"`
	RepositoryID         string `json:"repositoryId"`
	RuntimeProfileDigest string `json:"runtimeProfileDigest"`
	RuntimeProfileID     string `json:"runtimeProfileId"`
}

type FriskyScope struct {
	Access                           Access   `json:"access"`
	AllowedPaths                     []string `json:"allowedPaths"`
	ForbiddenPaths                   []string `json:"forbiddenPaths"`
	RequirePreventivePathEnforcement bool     `json:"requirePreventivePathEnforcement"`
}

type BraggadociousVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Required  bool   `json:"required"`
	Revision  int64  `json:"revision"`
}

type ReuseInputElement struct {
	Artifact  TentacledArtifact `json:"artifact"`
	InputSlot string            `json:"inputSlot"`
	Producer  PurpleProducer    `json:"producer"`
}

type TentacledArtifact struct {
	ContentDigest string            `json:"contentDigest"`
	Kind          ExternalInputKind `json:"kind"`
}

type PurpleProducer struct {
	Edge              *CunningEdge          `json:"edge,omitempty"`
	Kind              ProducerKind          `json:"kind"`
	ProofSetDigest    *string               `json:"proofSetDigest,omitempty"`
	SourceDigest      *string               `json:"sourceDigest,omitempty"`
	SourceEvidenceID  *string               `json:"sourceEvidenceId,omitempty"`
	ExternalInput     *CunningExternalInput `json:"externalInput,omitempty"`
	ReviewDigest      *string               `json:"reviewDigest,omitempty"`
	ReviewOperationID *string               `json:"reviewOperationId,omitempty"`
}

type CunningEdge struct {
	Bindings    []FriskyBinding `json:"bindings"`
	EdgeKey     string          `json:"edgeKey"`
	FromNodeKey string          `json:"fromNodeKey"`
	Gate        Gate            `json:"gate"`
	ToNodeKey   string          `json:"toNodeKey"`
}

type FriskyBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type CunningExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type EvidenceReuseContractTask struct {
	Assignments        []Assignment      `json:"assignments"`
	BudgetPolicy       BudgetPolicy      `json:"budgetPolicy"`
	CompletionPolicy   CompletionPolicy  `json:"completionPolicy"`
	Criteria           []FriskyCriterion `json:"criteria"`
	CriteriaRevision   int64             `json:"criteriaRevision"`
	DefinitionRevision int64             `json:"definitionRevision"`
	Goal               string            `json:"goal"`
	OwnerMemberID      string            `json:"ownerMemberId"`
	ParentTaskID       *string           `json:"parentTaskId"`
	RoomID             string            `json:"roomId"`
	TaskID             string            `json:"taskId"`
	Title              string            `json:"title"`
}

type Assignment struct {
	AgentID string `json:"agentId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	AssignedAt         string `json:"assignedAt"`
	AssignedByMemberID string `json:"assignedByMemberId"`
	Role               Role   `json:"role"`
}

type BudgetPolicy struct {
	MaxExecutionDurationSeconds int64 `json:"maxExecutionDurationSeconds"`
	MaxRunAttempts              int64 `json:"maxRunAttempts"`
}

type FriskyCriterion struct {
	CriterionKey string `json:"criterionKey"`
	Description  string `json:"description"`
	Ordinal      int64  `json:"ordinal"`
	Required     bool   `json:"required"`
}

type RemoteProviderBinding struct {
	BindingDigest string    `json:"bindingDigest"`
	CiChecks      []CiCheck `json:"ciChecks"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt            string `json:"createdAt"`
	CreatedByMemberID    string `json:"createdByMemberId"`
	ProviderBindingID    string `json:"providerBindingId"`
	ProviderOrigin       string `json:"providerOrigin"`
	ProviderRepositoryID string `json:"providerRepositoryId"`
	RepositoryID         string `json:"repositoryId"`
	TeamID               string `json:"teamId"`
	Version              int64  `json:"version"`
}

type CiCheck struct {
	CheckKey        string `json:"checkKey"`
	ProfileDigest   string `json:"profileDigest"`
	ProfileID       string `json:"profileId"`
	ProfileRevision int64  `json:"profileRevision"`
}

type RemoteProviderBindingRevocation struct {
	ExpectedBindingDigest string `json:"expectedBindingDigest"`
	OperationID           string `json:"operationId"`
	ProviderBindingID     string `json:"providerBindingId"`
	Reason                string `json:"reason"`
	RevocationDigest      string `json:"revocationDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RevokedAt         string `json:"revokedAt"`
	RevokedByMemberID string `json:"revokedByMemberId"`
	Version           int64  `json:"version"`
}

type ProviderCommitObservation struct {
	BaseCommit       string       `json:"baseCommit"`
	BundleByteLength int64        `json:"bundleByteLength"`
	BundleDigest     string       `json:"bundleDigest"`
	Commit           string       `json:"commit"`
	ObjectFormat     ObjectFormat `json:"objectFormat"`
	ObservationID    string       `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                                `json:"observedAt"`
	OperationID               string                                `json:"operationId"`
	ProviderObservationDigest string                                `json:"providerObservationDigest"`
	ProviderRepositoryID      string                                `json:"providerRepositoryId"`
	PullRequest               *ProviderCommitObservationPullRequest `json:"pullRequest"`
	Tree                      string                                `json:"tree"`
	Version                   int64                                 `json:"version"`
}

type ProviderCommitObservationPullRequest struct {
	BaseRef string `json:"baseRef"`
	HeadRef string `json:"headRef"`
	Number  int64  `json:"number"`
}

type RemoteCommitObservation struct {
	BaseCommit        string       `json:"baseCommit"`
	BundleArtifactID  string       `json:"bundleArtifactId"`
	BundleByteLength  int64        `json:"bundleByteLength"`
	BundleDigest      string       `json:"bundleDigest"`
	Commit            string       `json:"commit"`
	InputDigest       string       `json:"inputDigest"`
	ObjectFormat      ObjectFormat `json:"objectFormat"`
	ObservationDigest string       `json:"observationDigest"`
	ObservationID     string       `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                              `json:"observedAt"`
	OperationID               string                              `json:"operationId"`
	PatchArtifactID           string                              `json:"patchArtifactId"`
	PatchArtifactRevision     int64                               `json:"patchArtifactRevision"`
	PatchByteLength           int64                               `json:"patchByteLength"`
	PatchDigest               string                              `json:"patchDigest"`
	PatchOutputSlot           string                              `json:"patchOutputSlot"`
	ProviderBindingID         string                              `json:"providerBindingId"`
	ProviderObservationDigest string                              `json:"providerObservationDigest"`
	ProviderRepositoryID      string                              `json:"providerRepositoryId"`
	PullRequest               *RemoteCommitObservationPullRequest `json:"pullRequest"`
	RepositoryID              string                              `json:"repositoryId"`
	TaskID                    string                              `json:"taskId"`
	Tree                      string                              `json:"tree"`
	Version                   int64                               `json:"version"`
}

type RemoteCommitObservationPullRequest struct {
	BaseRef string `json:"baseRef"`
	HeadRef string `json:"headRef"`
	Number  int64  `json:"number"`
}

type ProviderCIObservation struct {
	Attempt       int64  `json:"attempt"`
	CheckKey      string `json:"checkKey"`
	Commit        string `json:"commit"`
	ObservationID string `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                       `json:"observedAt"`
	OperationID               string                       `json:"operationId"`
	Outcome                   ProviderCIObservationOutcome `json:"outcome"`
	ProviderObservationDigest string                       `json:"providerObservationDigest"`
	ProviderRepositoryID      string                       `json:"providerRepositoryId"`
	Tree                      string                       `json:"tree"`
	Version                   int64                        `json:"version"`
}

type RemoteCIObservationReceipt struct {
	Attempt       int64  `json:"attempt"`
	CheckKey      string `json:"checkKey"`
	Commit        string `json:"commit"`
	ObservationID string `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                       `json:"observedAt"`
	OperationID               string                       `json:"operationId"`
	Outcome                   ProviderCIObservationOutcome `json:"outcome"`
	ProfileDigest             string                       `json:"profileDigest"`
	ProfileID                 string                       `json:"profileId"`
	ProfileRevision           int64                        `json:"profileRevision"`
	ProviderBindingID         string                       `json:"providerBindingId"`
	ProviderObservationDigest string                       `json:"providerObservationDigest"`
	ProviderRepositoryID      string                       `json:"providerRepositoryId"`
	ReceiptDigest             string                       `json:"receiptDigest"`
	RepositoryID              string                       `json:"repositoryId"`
	SourceEvidenceID          string                       `json:"sourceEvidenceId"`
	Tree                      string                       `json:"tree"`
	Version                   int64                        `json:"version"`
}

type ProviderInputAttestation struct {
	AttestationID string `json:"attestationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	AttestedAt                string                          `json:"attestedAt"`
	Commit                    string                          `json:"commit"`
	Inputs                    []ProviderInputAttestationInput `json:"inputs"`
	NodeKey                   string                          `json:"nodeKey"`
	OperationID               string                          `json:"operationId"`
	ProviderAttestationDigest string                          `json:"providerAttestationDigest"`
	ProviderRepositoryID      string                          `json:"providerRepositoryId"`
	RemoteInputEvidenceDigest string                          `json:"remoteInputEvidenceDigest"`
	Tree                      string                          `json:"tree"`
	Version                   int64                           `json:"version"`
}

type ProviderInputAttestationInput struct {
	AdoptionDigest string           `json:"adoptionDigest"`
	AdoptionID     string           `json:"adoptionId"`
	ReuseInput     PurpleReuseInput `json:"reuseInput"`
}

type PurpleReuseInput struct {
	Artifact  StickyArtifact `json:"artifact"`
	InputSlot string         `json:"inputSlot"`
	Producer  FluffyProducer `json:"producer"`
}

type StickyArtifact struct {
	ContentDigest string            `json:"contentDigest"`
	Kind          ExternalInputKind `json:"kind"`
}

type FluffyProducer struct {
	Edge              *MagentaEdge          `json:"edge,omitempty"`
	Kind              ProducerKind          `json:"kind"`
	ProofSetDigest    *string               `json:"proofSetDigest,omitempty"`
	SourceDigest      *string               `json:"sourceDigest,omitempty"`
	SourceEvidenceID  *string               `json:"sourceEvidenceId,omitempty"`
	ExternalInput     *MagentaExternalInput `json:"externalInput,omitempty"`
	ReviewDigest      *string               `json:"reviewDigest,omitempty"`
	ReviewOperationID *string               `json:"reviewOperationId,omitempty"`
}

type MagentaEdge struct {
	Bindings    []MischievousBinding `json:"bindings"`
	EdgeKey     string               `json:"edgeKey"`
	FromNodeKey string               `json:"fromNodeKey"`
	Gate        Gate                 `json:"gate"`
	ToNodeKey   string               `json:"toNodeKey"`
}

type MischievousBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type MagentaExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type RemoteInputAttestation struct {
	AttestationDigest string `json:"attestationDigest"`
	AttestationID     string `json:"attestationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	AttestedAt                string                        `json:"attestedAt"`
	Commit                    string                        `json:"commit"`
	Inputs                    []RemoteInputAttestationInput `json:"inputs"`
	NodeKey                   string                        `json:"nodeKey"`
	OperationID               string                        `json:"operationId"`
	PlanID                    string                        `json:"planId"`
	PlanRevision              int64                         `json:"planRevision"`
	ProviderAttestationDigest string                        `json:"providerAttestationDigest"`
	ProviderBindingID         string                        `json:"providerBindingId"`
	ProviderRepositoryID      string                        `json:"providerRepositoryId"`
	RemoteInputEvidenceDigest string                        `json:"remoteInputEvidenceDigest"`
	RepositoryID              string                        `json:"repositoryId"`
	SourceDigest              string                        `json:"sourceDigest"`
	SourceEvidenceID          string                        `json:"sourceEvidenceId"`
	SourceObservationDigest   string                        `json:"sourceObservationDigest"`
	SourceObservationID       string                        `json:"sourceObservationId"`
	Tree                      string                        `json:"tree"`
	Version                   int64                         `json:"version"`
}

type RemoteInputAttestationInput struct {
	AdoptionDigest string           `json:"adoptionDigest"`
	AdoptionID     string           `json:"adoptionId"`
	ReuseInput     FluffyReuseInput `json:"reuseInput"`
}

type FluffyReuseInput struct {
	Artifact  IndigoArtifact    `json:"artifact"`
	InputSlot string            `json:"inputSlot"`
	Producer  TentacledProducer `json:"producer"`
}

type IndigoArtifact struct {
	ContentDigest string            `json:"contentDigest"`
	Kind          ExternalInputKind `json:"kind"`
}

type TentacledProducer struct {
	Edge              *FriskyEdge          `json:"edge,omitempty"`
	Kind              ProducerKind         `json:"kind"`
	ProofSetDigest    *string              `json:"proofSetDigest,omitempty"`
	SourceDigest      *string              `json:"sourceDigest,omitempty"`
	SourceEvidenceID  *string              `json:"sourceEvidenceId,omitempty"`
	ExternalInput     *FriskyExternalInput `json:"externalInput,omitempty"`
	ReviewDigest      *string              `json:"reviewDigest,omitempty"`
	ReviewOperationID *string              `json:"reviewOperationId,omitempty"`
}

type FriskyEdge struct {
	Bindings    []BraggadociousBinding `json:"bindings"`
	EdgeKey     string                 `json:"edgeKey"`
	FromNodeKey string                 `json:"fromNodeKey"`
	Gate        Gate                   `json:"gate"`
	ToNodeKey   string                 `json:"toNodeKey"`
}

type BraggadociousBinding struct {
	InputSlot  string `json:"inputSlot"`
	OutputSlot string `json:"outputSlot"`
}

type FriskyExternalInput struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ContentDigest    string            `json:"contentDigest"`
	InputSlot        string            `json:"inputSlot"`
	Kind             ExternalInputKind `json:"kind"`
	NodeKey          string            `json:"nodeKey"`
	SourceResultID   string            `json:"sourceResultId"`
	SourceTaskID     string            `json:"sourceTaskId"`
}

type ExecutionEvidencePage struct {
	Plans   []ExecutionEvidencePagePlan `json:"plans"`
	TaskID  string                      `json:"taskId"`
	Version int64                       `json:"version"`
}

type ExecutionEvidencePagePlan struct {
	ControlRevision int64                        `json:"controlRevision"`
	Nodes           []PlanNode                   `json:"nodes"`
	PlanDigest      string                       `json:"planDigest"`
	PlanID          string                       `json:"planId"`
	PlanRevision    int64                        `json:"planRevision"`
	State           ExecutionPlanProjectionState `json:"state"`
}

type PlanNode struct {
	Integration                  PurpleIntegration                   `json:"integration"`
	NextAction                   PurpleNextAction                    `json:"nextAction"`
	NodeKey                      string                              `json:"nodeKey"`
	Remote                       *PurpleRemote                       `json:"remote"`
	RequiredVerificationProfiles []PurpleRequiredVerificationProfile `json:"requiredVerificationProfiles"`
	Runtime                      *PurpleRuntime                      `json:"runtime"`
	Stages                       []PurpleStage                       `json:"stages"`
	TaskID                       string                              `json:"taskId"`
	Verifications                []PurpleVerification                `json:"verifications"`
}

type PurpleIntegration struct {
	Approval        *PurpleApproval        `json:"approval"`
	BlockerCode     *string                `json:"blockerCode"`
	CommandTemplate *PurpleCommandTemplate `json:"commandTemplate"`
	Receipt         *PurpleReceipt         `json:"receipt"`
	State           IntegrationState       `json:"state"`
	Target          *StickyTarget          `json:"target"`
}

type PurpleApproval struct {
	ApprovalDigest string `json:"approvalDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ApprovedAt         string `json:"approvedAt"`
	ApprovedByMemberID string `json:"approvedByMemberId"`
	CandidateCommit    string `json:"candidateCommit"`
	CandidateTree      string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline               string                      `json:"deadline"`
	InputDigest            string                      `json:"inputDigest"`
	IntegrationOperationID string                      `json:"integrationOperationId"`
	MaterializationDigest  string                      `json:"materializationDigest"`
	NodeKey                string                      `json:"nodeKey"`
	OperationID            string                      `json:"operationId"`
	PlanID                 string                      `json:"planId"`
	PlanRevision           int64                       `json:"planRevision"`
	Target                 PurpleTarget                `json:"target"`
	VerificationReceipts   []PurpleVerificationReceipt `json:"verificationReceipts"`
}

type PurpleTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type PurpleVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type PurpleCommandTemplate struct {
	CandidateCommit string `json:"candidateCommit"`
	CandidateTree   string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline              string                      `json:"deadline"`
	InputDigest           string                      `json:"inputDigest"`
	MaterializationDigest string                      `json:"materializationDigest"`
	NodeKey               string                      `json:"nodeKey"`
	PlanID                string                      `json:"planId"`
	PlanRevision          int64                       `json:"planRevision"`
	Target                FluffyTarget                `json:"target"`
	VerificationReceipts  []FluffyVerificationReceipt `json:"verificationReceipts"`
}

type FluffyTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type FluffyVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type PurpleReceipt struct {
	Receipt       FluffyReceipt `json:"receipt"`
	ReceiptDigest string        `json:"receiptDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt string `json:"recordedAt"`
}

type FluffyReceipt struct {
	BindingID             string      `json:"bindingId"`
	CandidateCommit       *string     `json:"candidateCommit"`
	CandidateTree         *string     `json:"candidateTree"`
	CheckpointID          *string     `json:"checkpointId"`
	DeviceID              string      `json:"deviceId"`
	ErrorCode             *string     `json:"errorCode"`
	Kind                  KindElement `json:"kind"`
	ObservedGeneration    *string     `json:"observedGeneration"`
	OperationID           string      `json:"operationId"`
	ProviderObservationID *string     `json:"providerObservationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt     string                          `json:"recordedAt"`
	RepositoryID   string                          `json:"repositoryId"`
	RequestDigest  string                          `json:"requestDigest"`
	State          RepositoryOperationReceiptState `json:"state"`
	Target         *TentacledTarget                `json:"target"`
	VerificationID *string                         `json:"verificationId"`
	Version        int64                           `json:"version"`
}

type TentacledTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type StickyTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type PurpleNextAction struct {
	ActorKind  ActorKind      `json:"actorKind"`
	Kind       NextActionKind `json:"kind"`
	ReasonCode ReasonCode     `json:"reasonCode"`
}

type PurpleRemote struct {
	AdoptionState     AdoptionState           `json:"adoptionState"`
	BlockerCodes      []BlockerCode           `json:"blockerCodes"`
	CiReceipts        []PurpleCiReceipt       `json:"ciReceipts"`
	CommandTemplate   *FluffyCommandTemplate  `json:"commandTemplate"`
	CommitObservation PurpleCommitObservation `json:"commitObservation"`
	Source            MagentaSource           `json:"source"`
}

type PurpleCiReceipt struct {
	Attempt       int64  `json:"attempt"`
	CheckKey      string `json:"checkKey"`
	Commit        string `json:"commit"`
	ObservationID string `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                       `json:"observedAt"`
	OperationID               string                       `json:"operationId"`
	Outcome                   ProviderCIObservationOutcome `json:"outcome"`
	ProfileDigest             string                       `json:"profileDigest"`
	ProfileID                 string                       `json:"profileId"`
	ProfileRevision           int64                        `json:"profileRevision"`
	ProviderBindingID         string                       `json:"providerBindingId"`
	ProviderObservationDigest string                       `json:"providerObservationDigest"`
	ProviderRepositoryID      string                       `json:"providerRepositoryId"`
	ReceiptDigest             string                       `json:"receiptDigest"`
	RepositoryID              string                       `json:"repositoryId"`
	SourceEvidenceID          string                       `json:"sourceEvidenceId"`
	Tree                      string                       `json:"tree"`
	Version                   int64                        `json:"version"`
}

type FluffyCommandTemplate struct {
	ExpectedControlRevision int64  `json:"expectedControlRevision"`
	ExpectedPlanDigest      string `json:"expectedPlanDigest"`
	NodeKey                 string `json:"nodeKey"`
	PlanRevision            int64  `json:"planRevision"`
	ProviderBindingID       string `json:"providerBindingId"`
	SourceEvidenceID        string `json:"sourceEvidenceId"`
}

type PurpleCommitObservation struct {
	BaseCommit        string       `json:"baseCommit"`
	BundleArtifactID  string       `json:"bundleArtifactId"`
	BundleByteLength  int64        `json:"bundleByteLength"`
	BundleDigest      string       `json:"bundleDigest"`
	Commit            string       `json:"commit"`
	InputDigest       string       `json:"inputDigest"`
	ObjectFormat      ObjectFormat `json:"objectFormat"`
	ObservationDigest string       `json:"observationDigest"`
	ObservationID     string       `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string             `json:"observedAt"`
	OperationID               string             `json:"operationId"`
	PatchArtifactID           string             `json:"patchArtifactId"`
	PatchArtifactRevision     int64              `json:"patchArtifactRevision"`
	PatchByteLength           int64              `json:"patchByteLength"`
	PatchDigest               string             `json:"patchDigest"`
	PatchOutputSlot           string             `json:"patchOutputSlot"`
	ProviderBindingID         string             `json:"providerBindingId"`
	ProviderObservationDigest string             `json:"providerObservationDigest"`
	ProviderRepositoryID      string             `json:"providerRepositoryId"`
	PullRequest               *PurplePullRequest `json:"pullRequest"`
	RepositoryID              string             `json:"repositoryId"`
	TaskID                    string             `json:"taskId"`
	Tree                      string             `json:"tree"`
	Version                   int64              `json:"version"`
}

type PurplePullRequest struct {
	BaseRef string `json:"baseRef"`
	HeadRef string `json:"headRef"`
	Number  int64  `json:"number"`
}

type MagentaSource struct {
	AgentID      *string             `json:"agentId,omitempty"`
	ArtifactPins []PurpleArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string             `json:"createdAt"`
	CriteriaRevision   *int64             `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64             `json:"definitionRevision,omitempty"`
	DeviceID           *string            `json:"deviceId,omitempty"`
	DispatchGeneration *int64             `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind `json:"kind"`
	ResultID           *string            `json:"resultId,omitempty"`
	ResultVersion      *int64             `json:"resultVersion,omitempty"`
	RoomID             *string            `json:"roomId,omitempty"`
	SourceDigest       string             `json:"sourceDigest"`
	SourceEvidenceID   string             `json:"sourceEvidenceId"`
	SourceRunID        *string            `json:"sourceRunId,omitempty"`
	TaskID             *string            `json:"taskId,omitempty"`
	Version            int64              `json:"version"`
	Commit             *string            `json:"commit,omitempty"`
	InputDigest        *string            `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat      `json:"objectFormat,omitempty"`
	Origin             *PurpleOrigin      `json:"origin,omitempty"`
	RepositoryID       *string            `json:"repositoryId,omitempty"`
	Tree               *string            `json:"tree,omitempty"`
}

type PurpleArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type PurpleOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type PurpleRequiredVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type PurpleRuntime struct {
	BlockerCode        *string       `json:"blockerCode"`
	DispatchGeneration *int64        `json:"dispatchGeneration"`
	LastRunState       *LastRunState `json:"lastRunState"`
	ProjectionRevision int64         `json:"projectionRevision"`
	RunID              *string       `json:"runId"`
	State              RuntimeState  `json:"state"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt string `json:"updatedAt"`
}

type PurpleStage struct {
	Adoption              PurpleAdoption `json:"adoption"`
	Gate                  Gate           `json:"gate"`
	MaterializationDigest string         `json:"materializationDigest"`
	Proofs                []FluffyProof  `json:"proofs"`
	Source                FriskySource   `json:"source"`
}

type PurpleAdoption struct {
	AdoptionDigest string          `json:"adoptionDigest"`
	AdoptionID     string          `json:"adoptionId"`
	Authority      PurpleAuthority `json:"authority"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt              string                 `json:"createdAt"`
	Gate                   Gate                   `json:"gate"`
	NodeContractDigest     string                 `json:"nodeContractDigest"`
	NodeKey                string                 `json:"nodeKey"`
	OperationDigest        string                 `json:"operationDigest"`
	OperationID            string                 `json:"operationId"`
	PlanID                 string                 `json:"planId"`
	PlanRevision           int64                  `json:"planRevision"`
	Proofs                 []PurpleProof          `json:"proofs"`
	ProofSetDigest         string                 `json:"proofSetDigest"`
	ResolvedInputSetDigest string                 `json:"resolvedInputSetDigest"`
	SourceDigest           string                 `json:"sourceDigest"`
	SourceEvidenceID       string                 `json:"sourceEvidenceId"`
	SourceExecution        *PurpleSourceExecution `json:"sourceExecution"`
	Version                int64                  `json:"version"`
}

type PurpleAuthority struct {
	AgentID             *string `json:"agentId,omitempty"`
	ApprovalOperationID string  `json:"approvalOperationId"`
	CriteriaRevision    int64   `json:"criteriaRevision"`
	DefinitionRevision  int64   `json:"definitionRevision"`
	DeviceID            *string `json:"deviceId,omitempty"`
	GrantDigest         *string `json:"grantDigest,omitempty"`
	GrantID             *string `json:"grantId,omitempty"`
	GrantRevision       *int64  `json:"grantRevision,omitempty"`
	PlanDigest          string  `json:"planDigest"`
	RoomID              string  `json:"roomId"`
	Service             Service `json:"service"`
	TaskID              string  `json:"taskId"`
	ActorMemberID       *string `json:"actorMemberId,omitempty"`
	BindingDigest       *string `json:"bindingDigest,omitempty"`
	ProviderBindingID   *string `json:"providerBindingId,omitempty"`
}

type PurpleProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type PurpleSourceExecution struct {
	DispatchGeneration int64  `json:"dispatchGeneration"`
	RunID              string `json:"runId"`
}

type FluffyProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type FriskySource struct {
	AgentID      *string             `json:"agentId,omitempty"`
	ArtifactPins []FluffyArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string             `json:"createdAt"`
	CriteriaRevision   *int64             `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64             `json:"definitionRevision,omitempty"`
	DeviceID           *string            `json:"deviceId,omitempty"`
	DispatchGeneration *int64             `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind `json:"kind"`
	ResultID           *string            `json:"resultId,omitempty"`
	ResultVersion      *int64             `json:"resultVersion,omitempty"`
	RoomID             *string            `json:"roomId,omitempty"`
	SourceDigest       string             `json:"sourceDigest"`
	SourceEvidenceID   string             `json:"sourceEvidenceId"`
	SourceRunID        *string            `json:"sourceRunId,omitempty"`
	TaskID             *string            `json:"taskId,omitempty"`
	Version            int64              `json:"version"`
	Commit             *string            `json:"commit,omitempty"`
	InputDigest        *string            `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat      `json:"objectFormat,omitempty"`
	Origin             *FluffyOrigin      `json:"origin,omitempty"`
	RepositoryID       *string            `json:"repositoryId,omitempty"`
	Tree               *string            `json:"tree,omitempty"`
}

type FluffyArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type FluffyOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type PurpleVerification struct {
	Kind          VerificationKind `json:"kind"`
	Receipt       TentacledReceipt `json:"receipt"`
	ReceiptDigest *string          `json:"receiptDigest,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt *string `json:"recordedAt,omitempty"`
}

type TentacledReceipt struct {
	Authority            *FluffyAuthority `json:"authority,omitempty"`
	BindingID            *string          `json:"bindingId"`
	CandidateCommit      *string          `json:"candidateCommit,omitempty"`
	CandidateTree        *string          `json:"candidateTree,omitempty"`
	DurationMilliseconds *int64           `json:"durationMilliseconds,omitempty"`
	Execution            *PurpleExecution `json:"execution"`
	ExitCode             *int64           `json:"exitCode"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	FinishedAt             *string            `json:"finishedAt,omitempty"`
	InputDigest            *string            `json:"inputDigest,omitempty"`
	IntegrationOperationID *string            `json:"integrationOperationId"`
	LogArtifact            *PurpleLogArtifact `json:"logArtifact"`
	OperationID            string             `json:"operationId"`
	Outcome                ReceiptOutcome     `json:"outcome"`
	Plan                   *PurplePlan        `json:"plan,omitempty"`
	Profile                *PurpleProfile     `json:"profile,omitempty"`
	RepositoryID           string             `json:"repositoryId"`
	RequestDigest          *string            `json:"requestDigest,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	StartedAt      *string `json:"startedAt,omitempty"`
	VerificationID *string `json:"verificationId,omitempty"`
	Version        int64   `json:"version"`
	Attempt        *int64  `json:"attempt,omitempty"`
	CheckKey       *string `json:"checkKey,omitempty"`
	Commit         *string `json:"commit,omitempty"`
	ObservationID  *string `json:"observationId,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                *string `json:"observedAt,omitempty"`
	ProfileDigest             *string `json:"profileDigest,omitempty"`
	ProfileID                 *string `json:"profileId,omitempty"`
	ProfileRevision           *int64  `json:"profileRevision,omitempty"`
	ProviderBindingID         *string `json:"providerBindingId,omitempty"`
	ProviderObservationDigest *string `json:"providerObservationDigest,omitempty"`
	ProviderRepositoryID      *string `json:"providerRepositoryId,omitempty"`
	ReceiptDigest             *string `json:"receiptDigest,omitempty"`
	SourceEvidenceID          *string `json:"sourceEvidenceId,omitempty"`
	Tree                      *string `json:"tree,omitempty"`
}

type FluffyAuthority struct {
	DeviceID          *string       `json:"deviceId,omitempty"`
	Kind              AuthorityKind `json:"kind"`
	Attempt           *int64        `json:"attempt,omitempty"`
	CheckKey          *string       `json:"checkKey,omitempty"`
	ProviderBindingID *string       `json:"providerBindingId,omitempty"`
}

type PurpleExecution struct {
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

type PurpleLogArtifact struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
}

type PurplePlan struct {
	ApprovalOperationID string `json:"approvalOperationId"`
	Digest              string `json:"digest"`
	PlanID              string `json:"planId"`
	Revision            int64  `json:"revision"`
	RoomID              string `json:"roomId"`
	RootTaskID          string `json:"rootTaskId"`
}

type PurpleProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type ExecutionEvidencePlan struct {
	ControlRevision int64                        `json:"controlRevision"`
	Nodes           []ExecutionEvidencePlanNode  `json:"nodes"`
	PlanDigest      string                       `json:"planDigest"`
	PlanID          string                       `json:"planId"`
	PlanRevision    int64                        `json:"planRevision"`
	State           ExecutionPlanProjectionState `json:"state"`
}

type ExecutionEvidencePlanNode struct {
	Integration                  FluffyIntegration                   `json:"integration"`
	NextAction                   FluffyNextAction                    `json:"nextAction"`
	NodeKey                      string                              `json:"nodeKey"`
	Remote                       *FluffyRemote                       `json:"remote"`
	RequiredVerificationProfiles []FluffyRequiredVerificationProfile `json:"requiredVerificationProfiles"`
	Runtime                      *FluffyRuntime                      `json:"runtime"`
	Stages                       []FluffyStage                       `json:"stages"`
	TaskID                       string                              `json:"taskId"`
	Verifications                []FluffyVerification                `json:"verifications"`
}

type FluffyIntegration struct {
	Approval        *FluffyApproval           `json:"approval"`
	BlockerCode     *string                   `json:"blockerCode"`
	CommandTemplate *TentacledCommandTemplate `json:"commandTemplate"`
	Receipt         *StickyReceipt            `json:"receipt"`
	State           IntegrationState          `json:"state"`
	Target          *AmbitiousTarget          `json:"target"`
}

type FluffyApproval struct {
	ApprovalDigest string `json:"approvalDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ApprovedAt         string `json:"approvedAt"`
	ApprovedByMemberID string `json:"approvedByMemberId"`
	CandidateCommit    string `json:"candidateCommit"`
	CandidateTree      string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline               string                         `json:"deadline"`
	InputDigest            string                         `json:"inputDigest"`
	IntegrationOperationID string                         `json:"integrationOperationId"`
	MaterializationDigest  string                         `json:"materializationDigest"`
	NodeKey                string                         `json:"nodeKey"`
	OperationID            string                         `json:"operationId"`
	PlanID                 string                         `json:"planId"`
	PlanRevision           int64                          `json:"planRevision"`
	Target                 IndigoTarget                   `json:"target"`
	VerificationReceipts   []TentacledVerificationReceipt `json:"verificationReceipts"`
}

type IndigoTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type TentacledVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type TentacledCommandTemplate struct {
	CandidateCommit string `json:"candidateCommit"`
	CandidateTree   string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline              string                      `json:"deadline"`
	InputDigest           string                      `json:"inputDigest"`
	MaterializationDigest string                      `json:"materializationDigest"`
	NodeKey               string                      `json:"nodeKey"`
	PlanID                string                      `json:"planId"`
	PlanRevision          int64                       `json:"planRevision"`
	Target                IndecentTarget              `json:"target"`
	VerificationReceipts  []StickyVerificationReceipt `json:"verificationReceipts"`
}

type IndecentTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type StickyVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type StickyReceipt struct {
	Receipt       IndigoReceipt `json:"receipt"`
	ReceiptDigest string        `json:"receiptDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt string `json:"recordedAt"`
}

type IndigoReceipt struct {
	BindingID             string      `json:"bindingId"`
	CandidateCommit       *string     `json:"candidateCommit"`
	CandidateTree         *string     `json:"candidateTree"`
	CheckpointID          *string     `json:"checkpointId"`
	DeviceID              string      `json:"deviceId"`
	ErrorCode             *string     `json:"errorCode"`
	Kind                  KindElement `json:"kind"`
	ObservedGeneration    *string     `json:"observedGeneration"`
	OperationID           string      `json:"operationId"`
	ProviderObservationID *string     `json:"providerObservationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt     string                          `json:"recordedAt"`
	RepositoryID   string                          `json:"repositoryId"`
	RequestDigest  string                          `json:"requestDigest"`
	State          RepositoryOperationReceiptState `json:"state"`
	Target         *HilariousTarget                `json:"target"`
	VerificationID *string                         `json:"verificationId"`
	Version        int64                           `json:"version"`
}

type HilariousTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type AmbitiousTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type FluffyNextAction struct {
	ActorKind  ActorKind      `json:"actorKind"`
	Kind       NextActionKind `json:"kind"`
	ReasonCode ReasonCode     `json:"reasonCode"`
}

type FluffyRemote struct {
	AdoptionState     AdoptionState           `json:"adoptionState"`
	BlockerCodes      []BlockerCode           `json:"blockerCodes"`
	CiReceipts        []FluffyCiReceipt       `json:"ciReceipts"`
	CommandTemplate   *StickyCommandTemplate  `json:"commandTemplate"`
	CommitObservation FluffyCommitObservation `json:"commitObservation"`
	Source            MischievousSource       `json:"source"`
}

type FluffyCiReceipt struct {
	Attempt       int64  `json:"attempt"`
	CheckKey      string `json:"checkKey"`
	Commit        string `json:"commit"`
	ObservationID string `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                       `json:"observedAt"`
	OperationID               string                       `json:"operationId"`
	Outcome                   ProviderCIObservationOutcome `json:"outcome"`
	ProfileDigest             string                       `json:"profileDigest"`
	ProfileID                 string                       `json:"profileId"`
	ProfileRevision           int64                        `json:"profileRevision"`
	ProviderBindingID         string                       `json:"providerBindingId"`
	ProviderObservationDigest string                       `json:"providerObservationDigest"`
	ProviderRepositoryID      string                       `json:"providerRepositoryId"`
	ReceiptDigest             string                       `json:"receiptDigest"`
	RepositoryID              string                       `json:"repositoryId"`
	SourceEvidenceID          string                       `json:"sourceEvidenceId"`
	Tree                      string                       `json:"tree"`
	Version                   int64                        `json:"version"`
}

type StickyCommandTemplate struct {
	ExpectedControlRevision int64  `json:"expectedControlRevision"`
	ExpectedPlanDigest      string `json:"expectedPlanDigest"`
	NodeKey                 string `json:"nodeKey"`
	PlanRevision            int64  `json:"planRevision"`
	ProviderBindingID       string `json:"providerBindingId"`
	SourceEvidenceID        string `json:"sourceEvidenceId"`
}

type FluffyCommitObservation struct {
	BaseCommit        string       `json:"baseCommit"`
	BundleArtifactID  string       `json:"bundleArtifactId"`
	BundleByteLength  int64        `json:"bundleByteLength"`
	BundleDigest      string       `json:"bundleDigest"`
	Commit            string       `json:"commit"`
	InputDigest       string       `json:"inputDigest"`
	ObjectFormat      ObjectFormat `json:"objectFormat"`
	ObservationDigest string       `json:"observationDigest"`
	ObservationID     string       `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string             `json:"observedAt"`
	OperationID               string             `json:"operationId"`
	PatchArtifactID           string             `json:"patchArtifactId"`
	PatchArtifactRevision     int64              `json:"patchArtifactRevision"`
	PatchByteLength           int64              `json:"patchByteLength"`
	PatchDigest               string             `json:"patchDigest"`
	PatchOutputSlot           string             `json:"patchOutputSlot"`
	ProviderBindingID         string             `json:"providerBindingId"`
	ProviderObservationDigest string             `json:"providerObservationDigest"`
	ProviderRepositoryID      string             `json:"providerRepositoryId"`
	PullRequest               *FluffyPullRequest `json:"pullRequest"`
	RepositoryID              string             `json:"repositoryId"`
	TaskID                    string             `json:"taskId"`
	Tree                      string             `json:"tree"`
	Version                   int64              `json:"version"`
}

type FluffyPullRequest struct {
	BaseRef string `json:"baseRef"`
	HeadRef string `json:"headRef"`
	Number  int64  `json:"number"`
}

type MischievousSource struct {
	AgentID      *string                `json:"agentId,omitempty"`
	ArtifactPins []TentacledArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string             `json:"createdAt"`
	CriteriaRevision   *int64             `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64             `json:"definitionRevision,omitempty"`
	DeviceID           *string            `json:"deviceId,omitempty"`
	DispatchGeneration *int64             `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind `json:"kind"`
	ResultID           *string            `json:"resultId,omitempty"`
	ResultVersion      *int64             `json:"resultVersion,omitempty"`
	RoomID             *string            `json:"roomId,omitempty"`
	SourceDigest       string             `json:"sourceDigest"`
	SourceEvidenceID   string             `json:"sourceEvidenceId"`
	SourceRunID        *string            `json:"sourceRunId,omitempty"`
	TaskID             *string            `json:"taskId,omitempty"`
	Version            int64              `json:"version"`
	Commit             *string            `json:"commit,omitempty"`
	InputDigest        *string            `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat      `json:"objectFormat,omitempty"`
	Origin             *TentacledOrigin   `json:"origin,omitempty"`
	RepositoryID       *string            `json:"repositoryId,omitempty"`
	Tree               *string            `json:"tree,omitempty"`
}

type TentacledArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type TentacledOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type FluffyRequiredVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type FluffyRuntime struct {
	BlockerCode        *string       `json:"blockerCode"`
	DispatchGeneration *int64        `json:"dispatchGeneration"`
	LastRunState       *LastRunState `json:"lastRunState"`
	ProjectionRevision int64         `json:"projectionRevision"`
	RunID              *string       `json:"runId"`
	State              RuntimeState  `json:"state"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt string `json:"updatedAt"`
}

type FluffyStage struct {
	Adoption              FluffyAdoption      `json:"adoption"`
	Gate                  Gate                `json:"gate"`
	MaterializationDigest string              `json:"materializationDigest"`
	Proofs                []StickyProof       `json:"proofs"`
	Source                BraggadociousSource `json:"source"`
}

type FluffyAdoption struct {
	AdoptionDigest string             `json:"adoptionDigest"`
	AdoptionID     string             `json:"adoptionId"`
	Authority      TentacledAuthority `json:"authority"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt              string                 `json:"createdAt"`
	Gate                   Gate                   `json:"gate"`
	NodeContractDigest     string                 `json:"nodeContractDigest"`
	NodeKey                string                 `json:"nodeKey"`
	OperationDigest        string                 `json:"operationDigest"`
	OperationID            string                 `json:"operationId"`
	PlanID                 string                 `json:"planId"`
	PlanRevision           int64                  `json:"planRevision"`
	Proofs                 []TentacledProof       `json:"proofs"`
	ProofSetDigest         string                 `json:"proofSetDigest"`
	ResolvedInputSetDigest string                 `json:"resolvedInputSetDigest"`
	SourceDigest           string                 `json:"sourceDigest"`
	SourceEvidenceID       string                 `json:"sourceEvidenceId"`
	SourceExecution        *FluffySourceExecution `json:"sourceExecution"`
	Version                int64                  `json:"version"`
}

type TentacledAuthority struct {
	AgentID             *string `json:"agentId,omitempty"`
	ApprovalOperationID string  `json:"approvalOperationId"`
	CriteriaRevision    int64   `json:"criteriaRevision"`
	DefinitionRevision  int64   `json:"definitionRevision"`
	DeviceID            *string `json:"deviceId,omitempty"`
	GrantDigest         *string `json:"grantDigest,omitempty"`
	GrantID             *string `json:"grantId,omitempty"`
	GrantRevision       *int64  `json:"grantRevision,omitempty"`
	PlanDigest          string  `json:"planDigest"`
	RoomID              string  `json:"roomId"`
	Service             Service `json:"service"`
	TaskID              string  `json:"taskId"`
	ActorMemberID       *string `json:"actorMemberId,omitempty"`
	BindingDigest       *string `json:"bindingDigest,omitempty"`
	ProviderBindingID   *string `json:"providerBindingId,omitempty"`
}

type TentacledProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type FluffySourceExecution struct {
	DispatchGeneration int64  `json:"dispatchGeneration"`
	RunID              string `json:"runId"`
}

type StickyProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type BraggadociousSource struct {
	AgentID      *string             `json:"agentId,omitempty"`
	ArtifactPins []StickyArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string             `json:"createdAt"`
	CriteriaRevision   *int64             `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64             `json:"definitionRevision,omitempty"`
	DeviceID           *string            `json:"deviceId,omitempty"`
	DispatchGeneration *int64             `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind `json:"kind"`
	ResultID           *string            `json:"resultId,omitempty"`
	ResultVersion      *int64             `json:"resultVersion,omitempty"`
	RoomID             *string            `json:"roomId,omitempty"`
	SourceDigest       string             `json:"sourceDigest"`
	SourceEvidenceID   string             `json:"sourceEvidenceId"`
	SourceRunID        *string            `json:"sourceRunId,omitempty"`
	TaskID             *string            `json:"taskId,omitempty"`
	Version            int64              `json:"version"`
	Commit             *string            `json:"commit,omitempty"`
	InputDigest        *string            `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat      `json:"objectFormat,omitempty"`
	Origin             *StickyOrigin      `json:"origin,omitempty"`
	RepositoryID       *string            `json:"repositoryId,omitempty"`
	Tree               *string            `json:"tree,omitempty"`
}

type StickyArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type StickyOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type FluffyVerification struct {
	Kind          VerificationKind `json:"kind"`
	Receipt       IndecentReceipt  `json:"receipt"`
	ReceiptDigest *string          `json:"receiptDigest,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt *string `json:"recordedAt,omitempty"`
}

type IndecentReceipt struct {
	Authority            *StickyAuthority `json:"authority,omitempty"`
	BindingID            *string          `json:"bindingId"`
	CandidateCommit      *string          `json:"candidateCommit,omitempty"`
	CandidateTree        *string          `json:"candidateTree,omitempty"`
	DurationMilliseconds *int64           `json:"durationMilliseconds,omitempty"`
	Execution            *FluffyExecution `json:"execution"`
	ExitCode             *int64           `json:"exitCode"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	FinishedAt             *string            `json:"finishedAt,omitempty"`
	InputDigest            *string            `json:"inputDigest,omitempty"`
	IntegrationOperationID *string            `json:"integrationOperationId"`
	LogArtifact            *FluffyLogArtifact `json:"logArtifact"`
	OperationID            string             `json:"operationId"`
	Outcome                ReceiptOutcome     `json:"outcome"`
	Plan                   *FluffyPlan        `json:"plan,omitempty"`
	Profile                *FluffyProfile     `json:"profile,omitempty"`
	RepositoryID           string             `json:"repositoryId"`
	RequestDigest          *string            `json:"requestDigest,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	StartedAt      *string `json:"startedAt,omitempty"`
	VerificationID *string `json:"verificationId,omitempty"`
	Version        int64   `json:"version"`
	Attempt        *int64  `json:"attempt,omitempty"`
	CheckKey       *string `json:"checkKey,omitempty"`
	Commit         *string `json:"commit,omitempty"`
	ObservationID  *string `json:"observationId,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                *string `json:"observedAt,omitempty"`
	ProfileDigest             *string `json:"profileDigest,omitempty"`
	ProfileID                 *string `json:"profileId,omitempty"`
	ProfileRevision           *int64  `json:"profileRevision,omitempty"`
	ProviderBindingID         *string `json:"providerBindingId,omitempty"`
	ProviderObservationDigest *string `json:"providerObservationDigest,omitempty"`
	ProviderRepositoryID      *string `json:"providerRepositoryId,omitempty"`
	ReceiptDigest             *string `json:"receiptDigest,omitempty"`
	SourceEvidenceID          *string `json:"sourceEvidenceId,omitempty"`
	Tree                      *string `json:"tree,omitempty"`
}

type StickyAuthority struct {
	DeviceID          *string       `json:"deviceId,omitempty"`
	Kind              AuthorityKind `json:"kind"`
	Attempt           *int64        `json:"attempt,omitempty"`
	CheckKey          *string       `json:"checkKey,omitempty"`
	ProviderBindingID *string       `json:"providerBindingId,omitempty"`
}

type FluffyExecution struct {
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

type FluffyLogArtifact struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
}

type FluffyPlan struct {
	ApprovalOperationID string `json:"approvalOperationId"`
	Digest              string `json:"digest"`
	PlanID              string `json:"planId"`
	Revision            int64  `json:"revision"`
	RoomID              string `json:"roomId"`
	RootTaskID          string `json:"rootTaskId"`
}

type FluffyProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type ExecutionEvidenceNode struct {
	Integration                  ExecutionEvidenceNodeIntegration                   `json:"integration"`
	NextAction                   ExecutionEvidenceNodeNextAction                    `json:"nextAction"`
	NodeKey                      string                                             `json:"nodeKey"`
	Remote                       *ExecutionEvidenceNodeRemote                       `json:"remote"`
	RequiredVerificationProfiles []ExecutionEvidenceNodeRequiredVerificationProfile `json:"requiredVerificationProfiles"`
	Runtime                      *ExecutionEvidenceNodeRuntime                      `json:"runtime"`
	Stages                       []ExecutionEvidenceNodeStage                       `json:"stages"`
	TaskID                       string                                             `json:"taskId"`
	Verifications                []ExecutionEvidenceNodeVerification                `json:"verifications"`
}

type ExecutionEvidenceNodeIntegration struct {
	Approval        *TentacledApproval     `json:"approval"`
	BlockerCode     *string                `json:"blockerCode"`
	CommandTemplate *IndigoCommandTemplate `json:"commandTemplate"`
	Receipt         *HilariousReceipt      `json:"receipt"`
	State           IntegrationState       `json:"state"`
	Target          *MischievousTarget     `json:"target"`
}

type TentacledApproval struct {
	ApprovalDigest string `json:"approvalDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ApprovedAt         string `json:"approvedAt"`
	ApprovedByMemberID string `json:"approvedByMemberId"`
	CandidateCommit    string `json:"candidateCommit"`
	CandidateTree      string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline               string                      `json:"deadline"`
	InputDigest            string                      `json:"inputDigest"`
	IntegrationOperationID string                      `json:"integrationOperationId"`
	MaterializationDigest  string                      `json:"materializationDigest"`
	NodeKey                string                      `json:"nodeKey"`
	OperationID            string                      `json:"operationId"`
	PlanID                 string                      `json:"planId"`
	PlanRevision           int64                       `json:"planRevision"`
	Target                 CunningTarget               `json:"target"`
	VerificationReceipts   []IndigoVerificationReceipt `json:"verificationReceipts"`
}

type CunningTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type IndigoVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type IndigoCommandTemplate struct {
	CandidateCommit string `json:"candidateCommit"`
	CandidateTree   string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline              string                        `json:"deadline"`
	InputDigest           string                        `json:"inputDigest"`
	MaterializationDigest string                        `json:"materializationDigest"`
	NodeKey               string                        `json:"nodeKey"`
	PlanID                string                        `json:"planId"`
	PlanRevision          int64                         `json:"planRevision"`
	Target                MagentaTarget                 `json:"target"`
	VerificationReceipts  []IndecentVerificationReceipt `json:"verificationReceipts"`
}

type MagentaTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type IndecentVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type HilariousReceipt struct {
	Receipt       AmbitiousReceipt `json:"receipt"`
	ReceiptDigest string           `json:"receiptDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt string `json:"recordedAt"`
}

type AmbitiousReceipt struct {
	BindingID             string      `json:"bindingId"`
	CandidateCommit       *string     `json:"candidateCommit"`
	CandidateTree         *string     `json:"candidateTree"`
	CheckpointID          *string     `json:"checkpointId"`
	DeviceID              string      `json:"deviceId"`
	ErrorCode             *string     `json:"errorCode"`
	Kind                  KindElement `json:"kind"`
	ObservedGeneration    *string     `json:"observedGeneration"`
	OperationID           string      `json:"operationId"`
	ProviderObservationID *string     `json:"providerObservationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt     string                          `json:"recordedAt"`
	RepositoryID   string                          `json:"repositoryId"`
	RequestDigest  string                          `json:"requestDigest"`
	State          RepositoryOperationReceiptState `json:"state"`
	Target         *FriskyTarget                   `json:"target"`
	VerificationID *string                         `json:"verificationId"`
	Version        int64                           `json:"version"`
}

type FriskyTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type MischievousTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type ExecutionEvidenceNodeNextAction struct {
	ActorKind  ActorKind      `json:"actorKind"`
	Kind       NextActionKind `json:"kind"`
	ReasonCode ReasonCode     `json:"reasonCode"`
}

type ExecutionEvidenceNodeRemote struct {
	AdoptionState     AdoptionState              `json:"adoptionState"`
	BlockerCodes      []BlockerCode              `json:"blockerCodes"`
	CiReceipts        []TentacledCiReceipt       `json:"ciReceipts"`
	CommandTemplate   *IndecentCommandTemplate   `json:"commandTemplate"`
	CommitObservation TentacledCommitObservation `json:"commitObservation"`
	Source            Source1                    `json:"source"`
}

type TentacledCiReceipt struct {
	Attempt       int64  `json:"attempt"`
	CheckKey      string `json:"checkKey"`
	Commit        string `json:"commit"`
	ObservationID string `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                       `json:"observedAt"`
	OperationID               string                       `json:"operationId"`
	Outcome                   ProviderCIObservationOutcome `json:"outcome"`
	ProfileDigest             string                       `json:"profileDigest"`
	ProfileID                 string                       `json:"profileId"`
	ProfileRevision           int64                        `json:"profileRevision"`
	ProviderBindingID         string                       `json:"providerBindingId"`
	ProviderObservationDigest string                       `json:"providerObservationDigest"`
	ProviderRepositoryID      string                       `json:"providerRepositoryId"`
	ReceiptDigest             string                       `json:"receiptDigest"`
	RepositoryID              string                       `json:"repositoryId"`
	SourceEvidenceID          string                       `json:"sourceEvidenceId"`
	Tree                      string                       `json:"tree"`
	Version                   int64                        `json:"version"`
}

type IndecentCommandTemplate struct {
	ExpectedControlRevision int64  `json:"expectedControlRevision"`
	ExpectedPlanDigest      string `json:"expectedPlanDigest"`
	NodeKey                 string `json:"nodeKey"`
	PlanRevision            int64  `json:"planRevision"`
	ProviderBindingID       string `json:"providerBindingId"`
	SourceEvidenceID        string `json:"sourceEvidenceId"`
}

type TentacledCommitObservation struct {
	BaseCommit        string       `json:"baseCommit"`
	BundleArtifactID  string       `json:"bundleArtifactId"`
	BundleByteLength  int64        `json:"bundleByteLength"`
	BundleDigest      string       `json:"bundleDigest"`
	Commit            string       `json:"commit"`
	InputDigest       string       `json:"inputDigest"`
	ObjectFormat      ObjectFormat `json:"objectFormat"`
	ObservationDigest string       `json:"observationDigest"`
	ObservationID     string       `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                `json:"observedAt"`
	OperationID               string                `json:"operationId"`
	PatchArtifactID           string                `json:"patchArtifactId"`
	PatchArtifactRevision     int64                 `json:"patchArtifactRevision"`
	PatchByteLength           int64                 `json:"patchByteLength"`
	PatchDigest               string                `json:"patchDigest"`
	PatchOutputSlot           string                `json:"patchOutputSlot"`
	ProviderBindingID         string                `json:"providerBindingId"`
	ProviderObservationDigest string                `json:"providerObservationDigest"`
	ProviderRepositoryID      string                `json:"providerRepositoryId"`
	PullRequest               *TentacledPullRequest `json:"pullRequest"`
	RepositoryID              string                `json:"repositoryId"`
	TaskID                    string                `json:"taskId"`
	Tree                      string                `json:"tree"`
	Version                   int64                 `json:"version"`
}

type TentacledPullRequest struct {
	BaseRef string `json:"baseRef"`
	HeadRef string `json:"headRef"`
	Number  int64  `json:"number"`
}

type Source1 struct {
	AgentID      *string             `json:"agentId,omitempty"`
	ArtifactPins []IndigoArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string             `json:"createdAt"`
	CriteriaRevision   *int64             `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64             `json:"definitionRevision,omitempty"`
	DeviceID           *string            `json:"deviceId,omitempty"`
	DispatchGeneration *int64             `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind `json:"kind"`
	ResultID           *string            `json:"resultId,omitempty"`
	ResultVersion      *int64             `json:"resultVersion,omitempty"`
	RoomID             *string            `json:"roomId,omitempty"`
	SourceDigest       string             `json:"sourceDigest"`
	SourceEvidenceID   string             `json:"sourceEvidenceId"`
	SourceRunID        *string            `json:"sourceRunId,omitempty"`
	TaskID             *string            `json:"taskId,omitempty"`
	Version            int64              `json:"version"`
	Commit             *string            `json:"commit,omitempty"`
	InputDigest        *string            `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat      `json:"objectFormat,omitempty"`
	Origin             *IndigoOrigin      `json:"origin,omitempty"`
	RepositoryID       *string            `json:"repositoryId,omitempty"`
	Tree               *string            `json:"tree,omitempty"`
}

type IndigoArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type IndigoOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type ExecutionEvidenceNodeRequiredVerificationProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type ExecutionEvidenceNodeRuntime struct {
	BlockerCode        *string       `json:"blockerCode"`
	DispatchGeneration *int64        `json:"dispatchGeneration"`
	LastRunState       *LastRunState `json:"lastRunState"`
	ProjectionRevision int64         `json:"projectionRevision"`
	RunID              *string       `json:"runId"`
	State              RuntimeState  `json:"state"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	UpdatedAt string `json:"updatedAt"`
}

type ExecutionEvidenceNodeStage struct {
	Adoption              TentacledAdoption `json:"adoption"`
	Gate                  Gate              `json:"gate"`
	MaterializationDigest string            `json:"materializationDigest"`
	Proofs                []IndecentProof   `json:"proofs"`
	Source                Source2           `json:"source"`
}

type TentacledAdoption struct {
	AdoptionDigest string          `json:"adoptionDigest"`
	AdoptionID     string          `json:"adoptionId"`
	Authority      IndigoAuthority `json:"authority"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt              string                    `json:"createdAt"`
	Gate                   Gate                      `json:"gate"`
	NodeContractDigest     string                    `json:"nodeContractDigest"`
	NodeKey                string                    `json:"nodeKey"`
	OperationDigest        string                    `json:"operationDigest"`
	OperationID            string                    `json:"operationId"`
	PlanID                 string                    `json:"planId"`
	PlanRevision           int64                     `json:"planRevision"`
	Proofs                 []IndigoProof             `json:"proofs"`
	ProofSetDigest         string                    `json:"proofSetDigest"`
	ResolvedInputSetDigest string                    `json:"resolvedInputSetDigest"`
	SourceDigest           string                    `json:"sourceDigest"`
	SourceEvidenceID       string                    `json:"sourceEvidenceId"`
	SourceExecution        *TentacledSourceExecution `json:"sourceExecution"`
	Version                int64                     `json:"version"`
}

type IndigoAuthority struct {
	AgentID             *string `json:"agentId,omitempty"`
	ApprovalOperationID string  `json:"approvalOperationId"`
	CriteriaRevision    int64   `json:"criteriaRevision"`
	DefinitionRevision  int64   `json:"definitionRevision"`
	DeviceID            *string `json:"deviceId,omitempty"`
	GrantDigest         *string `json:"grantDigest,omitempty"`
	GrantID             *string `json:"grantId,omitempty"`
	GrantRevision       *int64  `json:"grantRevision,omitempty"`
	PlanDigest          string  `json:"planDigest"`
	RoomID              string  `json:"roomId"`
	Service             Service `json:"service"`
	TaskID              string  `json:"taskId"`
	ActorMemberID       *string `json:"actorMemberId,omitempty"`
	BindingDigest       *string `json:"bindingDigest,omitempty"`
	ProviderBindingID   *string `json:"providerBindingId,omitempty"`
}

type IndigoProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type TentacledSourceExecution struct {
	DispatchGeneration int64  `json:"dispatchGeneration"`
	RunID              string `json:"runId"`
}

type IndecentProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type Source2 struct {
	AgentID      *string               `json:"agentId,omitempty"`
	ArtifactPins []IndecentArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string             `json:"createdAt"`
	CriteriaRevision   *int64             `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64             `json:"definitionRevision,omitempty"`
	DeviceID           *string            `json:"deviceId,omitempty"`
	DispatchGeneration *int64             `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind `json:"kind"`
	ResultID           *string            `json:"resultId,omitempty"`
	ResultVersion      *int64             `json:"resultVersion,omitempty"`
	RoomID             *string            `json:"roomId,omitempty"`
	SourceDigest       string             `json:"sourceDigest"`
	SourceEvidenceID   string             `json:"sourceEvidenceId"`
	SourceRunID        *string            `json:"sourceRunId,omitempty"`
	TaskID             *string            `json:"taskId,omitempty"`
	Version            int64              `json:"version"`
	Commit             *string            `json:"commit,omitempty"`
	InputDigest        *string            `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat      `json:"objectFormat,omitempty"`
	Origin             *IndecentOrigin    `json:"origin,omitempty"`
	RepositoryID       *string            `json:"repositoryId,omitempty"`
	Tree               *string            `json:"tree,omitempty"`
}

type IndecentArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type IndecentOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type ExecutionEvidenceNodeVerification struct {
	Kind          VerificationKind `json:"kind"`
	Receipt       CunningReceipt   `json:"receipt"`
	ReceiptDigest *string          `json:"receiptDigest,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt *string `json:"recordedAt,omitempty"`
}

type CunningReceipt struct {
	Authority            *IndecentAuthority  `json:"authority,omitempty"`
	BindingID            *string             `json:"bindingId"`
	CandidateCommit      *string             `json:"candidateCommit,omitempty"`
	CandidateTree        *string             `json:"candidateTree,omitempty"`
	DurationMilliseconds *int64              `json:"durationMilliseconds,omitempty"`
	Execution            *TentacledExecution `json:"execution"`
	ExitCode             *int64              `json:"exitCode"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	FinishedAt             *string               `json:"finishedAt,omitempty"`
	InputDigest            *string               `json:"inputDigest,omitempty"`
	IntegrationOperationID *string               `json:"integrationOperationId"`
	LogArtifact            *TentacledLogArtifact `json:"logArtifact"`
	OperationID            string                `json:"operationId"`
	Outcome                ReceiptOutcome        `json:"outcome"`
	Plan                   *TentacledPlan        `json:"plan,omitempty"`
	Profile                *TentacledProfile     `json:"profile,omitempty"`
	RepositoryID           string                `json:"repositoryId"`
	RequestDigest          *string               `json:"requestDigest,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	StartedAt      *string `json:"startedAt,omitempty"`
	VerificationID *string `json:"verificationId,omitempty"`
	Version        int64   `json:"version"`
	Attempt        *int64  `json:"attempt,omitempty"`
	CheckKey       *string `json:"checkKey,omitempty"`
	Commit         *string `json:"commit,omitempty"`
	ObservationID  *string `json:"observationId,omitempty"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                *string `json:"observedAt,omitempty"`
	ProfileDigest             *string `json:"profileDigest,omitempty"`
	ProfileID                 *string `json:"profileId,omitempty"`
	ProfileRevision           *int64  `json:"profileRevision,omitempty"`
	ProviderBindingID         *string `json:"providerBindingId,omitempty"`
	ProviderObservationDigest *string `json:"providerObservationDigest,omitempty"`
	ProviderRepositoryID      *string `json:"providerRepositoryId,omitempty"`
	ReceiptDigest             *string `json:"receiptDigest,omitempty"`
	SourceEvidenceID          *string `json:"sourceEvidenceId,omitempty"`
	Tree                      *string `json:"tree,omitempty"`
}

type IndecentAuthority struct {
	DeviceID          *string       `json:"deviceId,omitempty"`
	Kind              AuthorityKind `json:"kind"`
	Attempt           *int64        `json:"attempt,omitempty"`
	CheckKey          *string       `json:"checkKey,omitempty"`
	ProviderBindingID *string       `json:"providerBindingId,omitempty"`
}

type TentacledExecution struct {
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

type TentacledLogArtifact struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
}

type TentacledPlan struct {
	ApprovalOperationID string `json:"approvalOperationId"`
	Digest              string `json:"digest"`
	PlanID              string `json:"planId"`
	Revision            int64  `json:"revision"`
	RoomID              string `json:"roomId"`
	RootTaskID          string `json:"rootTaskId"`
}

type TentacledProfile struct {
	Digest    string `json:"digest"`
	ProfileID string `json:"profileId"`
	Revision  int64  `json:"revision"`
}

type ExecutionEvidenceStage struct {
	Adoption              ExecutionEvidenceStageAdoption `json:"adoption"`
	Gate                  Gate                           `json:"gate"`
	MaterializationDigest string                         `json:"materializationDigest"`
	Proofs                []ExecutionEvidenceStageProof  `json:"proofs"`
	Source                ExecutionEvidenceStageSource   `json:"source"`
}

type ExecutionEvidenceStageAdoption struct {
	AdoptionDigest string             `json:"adoptionDigest"`
	AdoptionID     string             `json:"adoptionId"`
	Authority      HilariousAuthority `json:"authority"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt              string                 `json:"createdAt"`
	Gate                   Gate                   `json:"gate"`
	NodeContractDigest     string                 `json:"nodeContractDigest"`
	NodeKey                string                 `json:"nodeKey"`
	OperationDigest        string                 `json:"operationDigest"`
	OperationID            string                 `json:"operationId"`
	PlanID                 string                 `json:"planId"`
	PlanRevision           int64                  `json:"planRevision"`
	Proofs                 []HilariousProof       `json:"proofs"`
	ProofSetDigest         string                 `json:"proofSetDigest"`
	ResolvedInputSetDigest string                 `json:"resolvedInputSetDigest"`
	SourceDigest           string                 `json:"sourceDigest"`
	SourceEvidenceID       string                 `json:"sourceEvidenceId"`
	SourceExecution        *StickySourceExecution `json:"sourceExecution"`
	Version                int64                  `json:"version"`
}

type HilariousAuthority struct {
	AgentID             *string `json:"agentId,omitempty"`
	ApprovalOperationID string  `json:"approvalOperationId"`
	CriteriaRevision    int64   `json:"criteriaRevision"`
	DefinitionRevision  int64   `json:"definitionRevision"`
	DeviceID            *string `json:"deviceId,omitempty"`
	GrantDigest         *string `json:"grantDigest,omitempty"`
	GrantID             *string `json:"grantId,omitempty"`
	GrantRevision       *int64  `json:"grantRevision,omitempty"`
	PlanDigest          string  `json:"planDigest"`
	RoomID              string  `json:"roomId"`
	Service             Service `json:"service"`
	TaskID              string  `json:"taskId"`
	ActorMemberID       *string `json:"actorMemberId,omitempty"`
	BindingDigest       *string `json:"bindingDigest,omitempty"`
	ProviderBindingID   *string `json:"providerBindingId,omitempty"`
}

type HilariousProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type StickySourceExecution struct {
	DispatchGeneration int64  `json:"dispatchGeneration"`
	RunID              string `json:"runId"`
}

type ExecutionEvidenceStageProof struct {
	Kind              GateProofRefKind `json:"kind"`
	OperationID       string           `json:"operationId"`
	ProofDigest       string           `json:"proofDigest"`
	ResultID          *string          `json:"resultId,omitempty"`
	ResultVersion     *int64           `json:"resultVersion,omitempty"`
	ProfileDigest     *string          `json:"profileDigest,omitempty"`
	ProfileID         *string          `json:"profileId,omitempty"`
	ProfileRevision   *int64           `json:"profileRevision,omitempty"`
	VerificationID    *string          `json:"verificationId,omitempty"`
	Attempt           *int64           `json:"attempt,omitempty"`
	CheckKey          *string          `json:"checkKey,omitempty"`
	ObservationID     *string          `json:"observationId,omitempty"`
	ProviderBindingID *string          `json:"providerBindingId,omitempty"`
	RepositoryID      *string          `json:"repositoryId,omitempty"`
	ResultingCommit   *string          `json:"resultingCommit,omitempty"`
}

type ExecutionEvidenceStageSource struct {
	AgentID      *string                `json:"agentId,omitempty"`
	ArtifactPins []HilariousArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string             `json:"createdAt"`
	CriteriaRevision   *int64             `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64             `json:"definitionRevision,omitempty"`
	DeviceID           *string            `json:"deviceId,omitempty"`
	DispatchGeneration *int64             `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind `json:"kind"`
	ResultID           *string            `json:"resultId,omitempty"`
	ResultVersion      *int64             `json:"resultVersion,omitempty"`
	RoomID             *string            `json:"roomId,omitempty"`
	SourceDigest       string             `json:"sourceDigest"`
	SourceEvidenceID   string             `json:"sourceEvidenceId"`
	SourceRunID        *string            `json:"sourceRunId,omitempty"`
	TaskID             *string            `json:"taskId,omitempty"`
	Version            int64              `json:"version"`
	Commit             *string            `json:"commit,omitempty"`
	InputDigest        *string            `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat      `json:"objectFormat,omitempty"`
	Origin             *HilariousOrigin   `json:"origin,omitempty"`
	RepositoryID       *string            `json:"repositoryId,omitempty"`
	Tree               *string            `json:"tree,omitempty"`
}

type HilariousArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type HilariousOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type ExecutionEvidenceNextAction struct {
	ActorKind  ActorKind      `json:"actorKind"`
	Kind       NextActionKind `json:"kind"`
	ReasonCode ReasonCode     `json:"reasonCode"`
}

type RemoteEvidenceView struct {
	AdoptionState     AdoptionState                       `json:"adoptionState"`
	BlockerCodes      []BlockerCode                       `json:"blockerCodes"`
	CiReceipts        []RemoteEvidenceViewCiReceipt       `json:"ciReceipts"`
	CommandTemplate   *RemoteEvidenceViewCommandTemplate  `json:"commandTemplate"`
	CommitObservation RemoteEvidenceViewCommitObservation `json:"commitObservation"`
	Source            RemoteEvidenceViewSource            `json:"source"`
}

type RemoteEvidenceViewCiReceipt struct {
	Attempt       int64  `json:"attempt"`
	CheckKey      string `json:"checkKey"`
	Commit        string `json:"commit"`
	ObservationID string `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string                       `json:"observedAt"`
	OperationID               string                       `json:"operationId"`
	Outcome                   ProviderCIObservationOutcome `json:"outcome"`
	ProfileDigest             string                       `json:"profileDigest"`
	ProfileID                 string                       `json:"profileId"`
	ProfileRevision           int64                        `json:"profileRevision"`
	ProviderBindingID         string                       `json:"providerBindingId"`
	ProviderObservationDigest string                       `json:"providerObservationDigest"`
	ProviderRepositoryID      string                       `json:"providerRepositoryId"`
	ReceiptDigest             string                       `json:"receiptDigest"`
	RepositoryID              string                       `json:"repositoryId"`
	SourceEvidenceID          string                       `json:"sourceEvidenceId"`
	Tree                      string                       `json:"tree"`
	Version                   int64                        `json:"version"`
}

type RemoteEvidenceViewCommandTemplate struct {
	ExpectedControlRevision int64  `json:"expectedControlRevision"`
	ExpectedPlanDigest      string `json:"expectedPlanDigest"`
	NodeKey                 string `json:"nodeKey"`
	PlanRevision            int64  `json:"planRevision"`
	ProviderBindingID       string `json:"providerBindingId"`
	SourceEvidenceID        string `json:"sourceEvidenceId"`
}

type RemoteEvidenceViewCommitObservation struct {
	BaseCommit        string       `json:"baseCommit"`
	BundleArtifactID  string       `json:"bundleArtifactId"`
	BundleByteLength  int64        `json:"bundleByteLength"`
	BundleDigest      string       `json:"bundleDigest"`
	Commit            string       `json:"commit"`
	InputDigest       string       `json:"inputDigest"`
	ObjectFormat      ObjectFormat `json:"objectFormat"`
	ObservationDigest string       `json:"observationDigest"`
	ObservationID     string       `json:"observationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ObservedAt                string             `json:"observedAt"`
	OperationID               string             `json:"operationId"`
	PatchArtifactID           string             `json:"patchArtifactId"`
	PatchArtifactRevision     int64              `json:"patchArtifactRevision"`
	PatchByteLength           int64              `json:"patchByteLength"`
	PatchDigest               string             `json:"patchDigest"`
	PatchOutputSlot           string             `json:"patchOutputSlot"`
	ProviderBindingID         string             `json:"providerBindingId"`
	ProviderObservationDigest string             `json:"providerObservationDigest"`
	ProviderRepositoryID      string             `json:"providerRepositoryId"`
	PullRequest               *StickyPullRequest `json:"pullRequest"`
	RepositoryID              string             `json:"repositoryId"`
	TaskID                    string             `json:"taskId"`
	Tree                      string             `json:"tree"`
	Version                   int64              `json:"version"`
}

type StickyPullRequest struct {
	BaseRef string `json:"baseRef"`
	HeadRef string `json:"headRef"`
	Number  int64  `json:"number"`
}

type RemoteEvidenceViewSource struct {
	AgentID      *string                `json:"agentId,omitempty"`
	ArtifactPins []AmbitiousArtifactPin `json:"artifactPins"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	CreatedAt          string             `json:"createdAt"`
	CriteriaRevision   *int64             `json:"criteriaRevision,omitempty"`
	DefinitionRevision *int64             `json:"definitionRevision,omitempty"`
	DeviceID           *string            `json:"deviceId,omitempty"`
	DispatchGeneration *int64             `json:"dispatchGeneration,omitempty"`
	Kind               SourceEvidenceKind `json:"kind"`
	ResultID           *string            `json:"resultId,omitempty"`
	ResultVersion      *int64             `json:"resultVersion,omitempty"`
	RoomID             *string            `json:"roomId,omitempty"`
	SourceDigest       string             `json:"sourceDigest"`
	SourceEvidenceID   string             `json:"sourceEvidenceId"`
	SourceRunID        *string            `json:"sourceRunId,omitempty"`
	TaskID             *string            `json:"taskId,omitempty"`
	Version            int64              `json:"version"`
	Commit             *string            `json:"commit,omitempty"`
	InputDigest        *string            `json:"inputDigest,omitempty"`
	ObjectFormat       *ObjectFormat      `json:"objectFormat,omitempty"`
	Origin             *AmbitiousOrigin   `json:"origin,omitempty"`
	RepositoryID       *string            `json:"repositoryId,omitempty"`
	Tree               *string            `json:"tree,omitempty"`
}

type AmbitiousArtifactPin struct {
	ArtifactID       string            `json:"artifactId"`
	ArtifactRevision int64             `json:"artifactRevision"`
	ByteLength       int64             `json:"byteLength"`
	ContentDigest    string            `json:"contentDigest"`
	Kind             ExternalInputKind `json:"kind"`
	OutputSlot       string            `json:"outputSlot"`
}

type AmbitiousOrigin struct {
	BindingID                 *string    `json:"bindingId,omitempty"`
	CaptureOperationID        *string    `json:"captureOperationId,omitempty"`
	CheckpointDigest          *string    `json:"checkpointDigest,omitempty"`
	CheckpointID              *string    `json:"checkpointId,omitempty"`
	CompanionSourceDigest     *string    `json:"companionSourceDigest,omitempty"`
	CompanionSourceEvidenceID *string    `json:"companionSourceEvidenceId,omitempty"`
	DeviceID                  *string    `json:"deviceId,omitempty"`
	DispatchGeneration        *int64     `json:"dispatchGeneration,omitempty"`
	Kind                      OriginKind `json:"kind"`
	SourceRunID               *string    `json:"sourceRunId,omitempty"`
	CommitBundleArtifactID    *string    `json:"commitBundleArtifactId,omitempty"`
	ObservationDigest         *string    `json:"observationDigest,omitempty"`
	ObservationID             *string    `json:"observationId,omitempty"`
	ProviderBindingID         *string    `json:"providerBindingId,omitempty"`
	ProviderRepositoryID      *string    `json:"providerRepositoryId,omitempty"`
}

type IntegrationView struct {
	Approval        *IntegrationViewApproval        `json:"approval"`
	BlockerCode     *string                         `json:"blockerCode"`
	CommandTemplate *IntegrationViewCommandTemplate `json:"commandTemplate"`
	Receipt         *IntegrationViewReceipt         `json:"receipt"`
	State           IntegrationState                `json:"state"`
	Target          *IntegrationViewTarget          `json:"target"`
}

type IntegrationViewApproval struct {
	ApprovalDigest string `json:"approvalDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ApprovedAt         string `json:"approvedAt"`
	ApprovedByMemberID string `json:"approvedByMemberId"`
	CandidateCommit    string `json:"candidateCommit"`
	CandidateTree      string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline               string                         `json:"deadline"`
	InputDigest            string                         `json:"inputDigest"`
	IntegrationOperationID string                         `json:"integrationOperationId"`
	MaterializationDigest  string                         `json:"materializationDigest"`
	NodeKey                string                         `json:"nodeKey"`
	OperationID            string                         `json:"operationId"`
	PlanID                 string                         `json:"planId"`
	PlanRevision           int64                          `json:"planRevision"`
	Target                 BraggadociousTarget            `json:"target"`
	VerificationReceipts   []HilariousVerificationReceipt `json:"verificationReceipts"`
}

type BraggadociousTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type HilariousVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type IntegrationViewCommandTemplate struct {
	CandidateCommit string `json:"candidateCommit"`
	CandidateTree   string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline              string                         `json:"deadline"`
	InputDigest           string                         `json:"inputDigest"`
	MaterializationDigest string                         `json:"materializationDigest"`
	NodeKey               string                         `json:"nodeKey"`
	PlanID                string                         `json:"planId"`
	PlanRevision          int64                          `json:"planRevision"`
	Target                Target1                        `json:"target"`
	VerificationReceipts  []AmbitiousVerificationReceipt `json:"verificationReceipts"`
}

type Target1 struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type AmbitiousVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type IntegrationViewReceipt struct {
	Receipt       MagentaReceipt `json:"receipt"`
	ReceiptDigest string         `json:"receiptDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt string `json:"recordedAt"`
}

type MagentaReceipt struct {
	BindingID             string      `json:"bindingId"`
	CandidateCommit       *string     `json:"candidateCommit"`
	CandidateTree         *string     `json:"candidateTree"`
	CheckpointID          *string     `json:"checkpointId"`
	DeviceID              string      `json:"deviceId"`
	ErrorCode             *string     `json:"errorCode"`
	Kind                  KindElement `json:"kind"`
	ObservedGeneration    *string     `json:"observedGeneration"`
	OperationID           string      `json:"operationId"`
	ProviderObservationID *string     `json:"providerObservationId"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	RecordedAt     string                          `json:"recordedAt"`
	RepositoryID   string                          `json:"repositoryId"`
	RequestDigest  string                          `json:"requestDigest"`
	State          RepositoryOperationReceiptState `json:"state"`
	Target         *Target2                        `json:"target"`
	VerificationID *string                         `json:"verificationId"`
	Version        int64                           `json:"version"`
}

type Target2 struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type IntegrationViewTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type RemoteEvidenceAdoptionCommandTemplate struct {
	ExpectedControlRevision int64  `json:"expectedControlRevision"`
	ExpectedPlanDigest      string `json:"expectedPlanDigest"`
	NodeKey                 string `json:"nodeKey"`
	PlanRevision            int64  `json:"planRevision"`
	ProviderBindingID       string `json:"providerBindingId"`
	SourceEvidenceID        string `json:"sourceEvidenceId"`
}

type RemoteEvidenceAdoptionCommand struct {
	ExpectedControlRevision int64  `json:"expectedControlRevision"`
	ExpectedPlanDigest      string `json:"expectedPlanDigest"`
	NodeKey                 string `json:"nodeKey"`
	OperationID             string `json:"operationId"`
	PlanRevision            int64  `json:"planRevision"`
	ProviderBindingID       string `json:"providerBindingId"`
	SourceEvidenceID        string `json:"sourceEvidenceId"`
}

type IntegrationApprovalCommandTemplate struct {
	CandidateCommit string `json:"candidateCommit"`
	CandidateTree   string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline              string                                                  `json:"deadline"`
	InputDigest           string                                                  `json:"inputDigest"`
	MaterializationDigest string                                                  `json:"materializationDigest"`
	NodeKey               string                                                  `json:"nodeKey"`
	PlanID                string                                                  `json:"planId"`
	PlanRevision          int64                                                   `json:"planRevision"`
	Target                IntegrationApprovalCommandTemplateTarget                `json:"target"`
	VerificationReceipts  []IntegrationApprovalCommandTemplateVerificationReceipt `json:"verificationReceipts"`
}

type IntegrationApprovalCommandTemplateTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type IntegrationApprovalCommandTemplateVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type IntegrationApprovalCommand struct {
	CandidateCommit string `json:"candidateCommit"`
	CandidateTree   string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline              string                                          `json:"deadline"`
	InputDigest           string                                          `json:"inputDigest"`
	MaterializationDigest string                                          `json:"materializationDigest"`
	NodeKey               string                                          `json:"nodeKey"`
	OperationID           string                                          `json:"operationId"`
	PlanID                string                                          `json:"planId"`
	PlanRevision          int64                                           `json:"planRevision"`
	Target                IntegrationApprovalCommandTarget                `json:"target"`
	VerificationReceipts  []IntegrationApprovalCommandVerificationReceipt `json:"verificationReceipts"`
}

type IntegrationApprovalCommandTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type IntegrationApprovalCommandVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type IntegrationApprovalRecord struct {
	ApprovalDigest string `json:"approvalDigest"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	ApprovedAt         string `json:"approvedAt"`
	ApprovedByMemberID string `json:"approvedByMemberId"`
	CandidateCommit    string `json:"candidateCommit"`
	CandidateTree      string `json:"candidateTree"`
	// Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
	// most nanosecond precision.
	Deadline               string                                         `json:"deadline"`
	InputDigest            string                                         `json:"inputDigest"`
	IntegrationOperationID string                                         `json:"integrationOperationId"`
	MaterializationDigest  string                                         `json:"materializationDigest"`
	NodeKey                string                                         `json:"nodeKey"`
	OperationID            string                                         `json:"operationId"`
	PlanID                 string                                         `json:"planId"`
	PlanRevision           int64                                          `json:"planRevision"`
	Target                 IntegrationApprovalRecordTarget                `json:"target"`
	VerificationReceipts   []IntegrationApprovalRecordVerificationReceipt `json:"verificationReceipts"`
}

type IntegrationApprovalRecordTarget struct {
	ExpectedCommit string `json:"expectedCommit"`
	RepositoryID   string `json:"repositoryId"`
	TargetRef      string `json:"targetRef"`
}

type IntegrationApprovalRecordVerificationReceipt struct {
	ReceiptDigest  string `json:"receiptDigest"`
	VerificationID string `json:"verificationId"`
}

type AuthorKind string

const (
	KindAgent        AuthorKind = "agent"
	Member           AuthorKind = "member"
	PurpleDiscussion AuthorKind = "discussion"
)

type PurpleKind string

const (
	Artifact         PurpleKind = "artifact"
	FluffyDiscussion PurpleKind = "discussion"
	Memory           PurpleKind = "memory"
	Message          PurpleKind = "message"
	Result           PurpleKind = "result"
	RunEvent         PurpleKind = "run_event"
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

type TaskMode string

const (
	Existing TaskMode = "existing"
	New      TaskMode = "new"
)

type IntegrationEnum string

const (
	LocalIntegration  IntegrationEnum = "local_integration"
	RemotePR          IntegrationEnum = "remote_pr"
	ReviewedCandidate IntegrationEnum = "reviewed_candidate"
)

type SchemaVersion string

const (
	The10 SchemaVersion = "1.0"
)

type ExecutionPlanProjectionState string

const (
	Draft          ExecutionPlanProjectionState = "draft"
	Paused         ExecutionPlanProjectionState = "paused"
	PurpleCanceled ExecutionPlanProjectionState = "canceled"
	Running        ExecutionPlanProjectionState = "running"
	StateApproved  ExecutionPlanProjectionState = "approved"
	StateCompleted ExecutionPlanProjectionState = "completed"
	StateReview    ExecutionPlanProjectionState = "review"
)

type DecisionEnum string

const (
	DecisionApproved DecisionEnum = "approved"
	Rejected         DecisionEnum = "rejected"
)

type ExecutionPlanControlCommandAction string

const (
	Cancel ExecutionPlanControlCommandAction = "cancel"
	Pause  ExecutionPlanControlCommandAction = "pause"
	Resume ExecutionPlanControlCommandAction = "resume"
)

type ExecutionSchedulerMode string

const (
	Automatic  ExecutionSchedulerMode = "automatic"
	Manual     ExecutionSchedulerMode = "manual"
	Supervised ExecutionSchedulerMode = "supervised"
)

type ExecutionSchedulerDispatchReceiptAction string

const (
	ManualDispatch    ExecutionSchedulerDispatchReceiptAction = "manual_dispatch"
	SupervisedAdvance ExecutionSchedulerDispatchReceiptAction = "supervised_advance"
)

type PreviousRunState string

const (
	PreviousRunStateCanceled       PreviousRunState = "canceled"
	PreviousRunStateExpired        PreviousRunState = "expired"
	PreviousRunStateFailed         PreviousRunState = "failed"
	PreviousRunStateOutcomeUnknown PreviousRunState = "outcome_unknown"
)

type WorkspaceMode string

const (
	IsolatedWorktree WorkspaceMode = "isolated_worktree"
)

type KindElement string

const (
	Capture   KindElement = "capture"
	Integrate KindElement = "integrate"
	Observe   KindElement = "observe"
	Prepare   KindElement = "prepare"
	Publish   KindElement = "publish"
	Verify    KindElement = "verify"
)

type WorkspaceBoundary string

const (
	Enforced WorkspaceBoundary = "enforced"
)

type RuntimeAuthorityViewState string

const (
	Active RuntimeAuthorityViewState = "active"
)

type PublishMode string

const (
	PullRequest PublishMode = "pull_request"
	Push        PublishMode = "push"
)

type RepositoryOperationReceiptState string

const (
	FluffyCanceled       RepositoryOperationReceiptState = "canceled"
	Prepared             RepositoryOperationReceiptState = "prepared"
	PurpleFailed         RepositoryOperationReceiptState = "failed"
	PurpleOutcomeUnknown RepositoryOperationReceiptState = "outcome_unknown"
	PurpleSucceeded      RepositoryOperationReceiptState = "succeeded"
)

type AuthorityKind string

const (
	Ci         AuthorityKind = "ci"
	KindBridge AuthorityKind = "bridge"
)

type Outcome = VerificationReceiptOutcome

const (
	OutcomeCanceled       Outcome = "canceled"
	OutcomeFailed         Outcome = "failed"
	OutcomeOutcomeUnknown Outcome = "outcome_unknown"
	Passed                Outcome = "passed"
)

type VerificationReceiptOutcome string

const (
	FluffyFailed         VerificationReceiptOutcome = "failed"
	FluffyOutcomeUnknown VerificationReceiptOutcome = "outcome_unknown"
	PurplePassed         VerificationReceiptOutcome = "passed"
	PurpleTimedOut       VerificationReceiptOutcome = "timed_out"
	TentacledCanceled    VerificationReceiptOutcome = "canceled"
)

type SourceEvidenceKind string

const (
	RepositoryCommit SourceEvidenceKind = "repository_commit"
	TaskResult       SourceEvidenceKind = "task_result"
)

type ObjectFormat string

const (
	Sha1   ObjectFormat = "sha1"
	Sha256 ObjectFormat = "sha256"
)

type OriginKind string

const (
	LocalCheckpoint   OriginKind = "local_checkpoint"
	RemoteObservation OriginKind = "remote_observation"
)

type GateProofRefKind string

const (
	CiObservationReceipt    GateProofRefKind = "ci_observation_receipt"
	IntegrationReceipt      GateProofRefKind = "integration_receipt"
	KindVerificationReceipt GateProofRefKind = "verification_receipt"
	ResultReview            GateProofRefKind = "result_review"
)

type Service string

const (
	ExecutionMaterialization Service = "execution_materialization"
	RemoteEvidenceAdoption   Service = "remote_evidence_adoption"
)

type ProducerKind string

const (
	AdoptedEvidence ProducerKind = "adopted_evidence"
	ExternalResult  ProducerKind = "external_result"
)

type Role string

const (
	Contributor Role = "contributor"
	Primary     Role = "primary"
	Reviewer    Role = "reviewer"
)

type CompletionPolicy string

const (
	AcceptedResultRequired CompletionPolicy = "accepted_result_required"
	OwnerConfirmed         CompletionPolicy = "owner_confirmed"
)

type ProviderCIObservationOutcome string

const (
	FluffyPassed            ProviderCIObservationOutcome = "passed"
	PurpleTimeout           ProviderCIObservationOutcome = "timeout"
	StickyCanceled          ProviderCIObservationOutcome = "canceled"
	TentacledFailed         ProviderCIObservationOutcome = "failed"
	TentacledOutcomeUnknown ProviderCIObservationOutcome = "outcome_unknown"
)

type IntegrationState string

const (
	ApprovalReady            IntegrationState = "approval_ready"
	Conflict                 IntegrationState = "conflict"
	FluffySucceeded          IntegrationState = "succeeded"
	IndigoCanceled           IntegrationState = "canceled"
	NotRequired              IntegrationState = "not_required"
	Pending                  IntegrationState = "pending"
	StickyFailed             IntegrationState = "failed"
	StickyOutcomeUnknown     IntegrationState = "outcome_unknown"
	WaitingForVerifiedOutput IntegrationState = "waiting_for_verified_output"
)

type ActorKind string

const (
	ActorKindAgent   ActorKind = "agent"
	ActorKindBridge  ActorKind = "bridge"
	ActorKindNone    ActorKind = "none"
	ProviderOperator ActorKind = "provider_operator"
	TaskOwner        ActorKind = "task_owner"
	TeamOwner        ActorKind = "team_owner"
)

type NextActionKind string

const (
	AdoptRemoteEvidence       NextActionKind = "adopt_remote_evidence"
	ApproveIntegration        NextActionKind = "approve_integration"
	InspectVerification       NextActionKind = "inspect_verification"
	InvestigateOutcomeUnknown NextActionKind = "investigate_outcome_unknown"
	KindNone                  NextActionKind = "none"
	ProduceCandidate          NextActionKind = "produce_candidate"
	ResolveTargetConflict     NextActionKind = "resolve_target_conflict"
	RetryNode                 NextActionKind = "retry_node"
	WaitForIntegration        NextActionKind = "wait_for_integration"
	WaitForVerification       NextActionKind = "wait_for_verification"
)

type ReasonCode string

const (
	CandidateMissing                         ReasonCode = "CANDIDATE_MISSING"
	IntegrationApprovalReady                 ReasonCode = "INTEGRATION_APPROVAL_READY"
	IntegrationOutcomeUnknown                ReasonCode = "INTEGRATION_OUTCOME_UNKNOWN"
	IntegrationPending                       ReasonCode = "INTEGRATION_PENDING"
	IntegrationTargetConflict                ReasonCode = "INTEGRATION_TARGET_CONFLICT"
	NoAction                                 ReasonCode = "NO_ACTION"
	NodeBlocked                              ReasonCode = "NODE_BLOCKED"
	NodeRetryAvailable                       ReasonCode = "NODE_RETRY_AVAILABLE"
	ReasonCodeREMOTEINPUTATTESTATIONREQUIRED ReasonCode = "REMOTE_INPUT_ATTESTATION_REQUIRED"
	RemoteAdoptionReady                      ReasonCode = "REMOTE_ADOPTION_READY"
	VerificationFailed                       ReasonCode = "VERIFICATION_FAILED"
	VerificationPending                      ReasonCode = "VERIFICATION_PENDING"
)

type AdoptionState string

const (
	Adopted              AdoptionState = "adopted"
	AdoptionStateBlocked AdoptionState = "blocked"
	AdoptionStateReady   AdoptionState = "ready"
)

type BlockerCode string

const (
	BlockerCodeREMOTEINPUTATTESTATIONREQUIRED BlockerCode = "REMOTE_INPUT_ATTESTATION_REQUIRED"
	RemoteAdoptionAlreadyRetained             BlockerCode = "REMOTE_ADOPTION_ALREADY_RETAINED"
	RemoteLocalAttemptExists                  BlockerCode = "REMOTE_LOCAL_ATTEMPT_EXISTS"
	RemotePlanStale                           BlockerCode = "REMOTE_PLAN_STALE"
	RemoteProviderRevoked                     BlockerCode = "REMOTE_PROVIDER_REVOKED"
	RemoteRequiredCiMissing                   BlockerCode = "REMOTE_REQUIRED_CI_MISSING"
	RemoteRequiredCiNotPassed                 BlockerCode = "REMOTE_REQUIRED_CI_NOT_PASSED"
)

type LastRunState string

const (
	Delivered                  LastRunState = "delivered"
	InputRequired              LastRunState = "input_required"
	LastRunStateCanceled       LastRunState = "canceled"
	LastRunStateCompleted      LastRunState = "completed"
	LastRunStateExpired        LastRunState = "expired"
	LastRunStateFailed         LastRunState = "failed"
	LastRunStateOutcomeUnknown LastRunState = "outcome_unknown"
	LastRunStateWorking        LastRunState = "working"
	Queued                     LastRunState = "queued"
)

type RuntimeState string

const (
	AwaitingResult       RuntimeState = "awaiting_result"
	Dispatched           RuntimeState = "dispatched"
	IndecentCanceled     RuntimeState = "canceled"
	IndigoFailed         RuntimeState = "failed"
	IndigoOutcomeUnknown RuntimeState = "outcome_unknown"
	StateBlocked         RuntimeState = "blocked"
	StateReady           RuntimeState = "ready"
	StateWorking         RuntimeState = "working"
)

type VerificationKind string

const (
	LocalVerification VerificationKind = "local_verification"
	RemoteCi          VerificationKind = "remote_ci"
)

type ReceiptOutcome string

const (
	FluffyTimedOut         ReceiptOutcome = "timed_out"
	FluffyTimeout          ReceiptOutcome = "timeout"
	HilariousCanceled      ReceiptOutcome = "canceled"
	IndecentFailed         ReceiptOutcome = "failed"
	IndecentOutcomeUnknown ReceiptOutcome = "outcome_unknown"
	TentacledPassed        ReceiptOutcome = "passed"
)
