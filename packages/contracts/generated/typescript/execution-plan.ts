// Code generated from JSON Schema; DO NOT EDIT.

export interface ExecutionPlanProjection {
  compiledTasks:   ExecutionPlanProjectionCompiledTask[];
  controlRevision: number;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:     string;
  current:       ExecutionPlanProjectionCurrent;
  ownerMemberId: string;
  planId:        string;
  roomId:        string;
  rootTaskId:    string;
  state:         ExecutionPlanProjectionState;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  updatedAt: string;
}

export interface ExecutionPlanProjectionCompiledTask {
  criteriaRevision:   number;
  definitionRevision: number;
  nodeKey:            string;
  taskId:             string;
  taskRevision:       number;
}

export interface ExecutionPlanProjectionCurrent {
  author: PurpleAuthor;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:  string;
  decisionId: string;
  definition: PurpleDefinition;
  digest:     string;
  planId:     string;
  proposalId: string;
  revision:   number;
}

export interface PurpleAuthor {
  kind:          AuthorKind;
  memberId?:     string;
  agentId?:      string;
  runId?:        string;
  discussionId?: string;
}

export type AuthorKind = "member" | "agent" | "discussion";

export interface PurpleDefinition {
  decision:       PurpleDecision;
  edges:          PurpleEdge[];
  externalInputs: PurpleExternalInput[];
  nodes:          [PurpleNode, ...PurpleNode[]];
  policy:         PurplePolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface PurpleDecision {
  items:               PurpleItem[];
  sourceRevisions:     [PurpleSourceRevision, ...PurpleSourceRevision[]];
  sources:             [PurpleSource, ...PurpleSource[]];
  summary:             string;
  unresolvedQuestions: PurpleUnresolvedQuestion[];
}

export interface PurpleItem {
  itemKey:   string;
  statement: string;
}

export interface PurpleSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface PurpleSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export type SourceKind = "artifact" | "run_event" | "message" | "memory" | "discussion" | "result";

export interface PurpleUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface PurpleEdge {
  bindings:    PurpleBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface PurpleBinding {
  inputSlot:  string;
  outputSlot: string;
}

export type Gate = "accepted_result" | "verified_output" | "integrated_commit";

export interface PurpleExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export type ExternalInputKind = "patch" | "commit" | "document" | "test_result";

export interface PurpleNode {
  agentId:              string;
  budget:               PurpleBudget;
  inputs:               PurpleInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [PurpleOutput, ...PurpleOutput[]];
  repository:           PurpleRepository;
  required:             boolean;
  scope:                PurpleScope;
  task:                 PurpleTask;
  verificationProfiles: PurpleVerificationProfile[];
}

export interface PurpleBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface PurpleInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export type NodeKind = "implementation" | "review" | "verification";

export interface PurpleOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface PurpleRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface PurpleScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export type Access = "read_only" | "isolated_write";

export interface PurpleTask {
  criteria?:             [PurpleCriterion, ...PurpleCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         PurpleSourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface PurpleCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export type TaskMode = "new" | "existing";

export interface PurpleSourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface PurpleVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface PurplePolicy {
  budget:                          FluffyBudget;
  integration:                     Integration;
  integrationTargets:              PurpleIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface FluffyBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export type Integration = "reviewed_candidate" | "local_integration" | "remote_pr";

export interface PurpleIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export type SchemaVersion = "1.0";

export type ExecutionPlanProjectionState = "draft" | "approved" | "running" | "paused" | "review" | "completed" | "canceled";

export interface ExecutionDecisionSourceSnapshot {
  digest:   string;
  revision: number;
  /**
   * Bounded canonical JSON evidence archive, not an executable object or an authorization
   * receipt. Its SHA-256 must equal digest.
   */
  snapshotJson: string;
  source:       ExecutionDecisionSourceSnapshotSource;
}

export interface ExecutionDecisionSourceSnapshotSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface ExecutionPlanPage {
  nextAfterPlanId: null | string;
  plans:           PlanElement[];
}

export interface PlanElement {
  compiledTasks:   PurpleCompiledTask[];
  controlRevision: number;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:     string;
  current:       PurpleCurrent;
  ownerMemberId: string;
  planId:        string;
  roomId:        string;
  rootTaskId:    string;
  state:         ExecutionPlanProjectionState;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  updatedAt: string;
}

export interface PurpleCompiledTask {
  criteriaRevision:   number;
  definitionRevision: number;
  nodeKey:            string;
  taskId:             string;
  taskRevision:       number;
}

export interface PurpleCurrent {
  author: FluffyAuthor;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:  string;
  decisionId: string;
  definition: FluffyDefinition;
  digest:     string;
  planId:     string;
  proposalId: string;
  revision:   number;
}

export interface FluffyAuthor {
  kind:          AuthorKind;
  memberId?:     string;
  agentId?:      string;
  runId?:        string;
  discussionId?: string;
}

export interface FluffyDefinition {
  decision:       FluffyDecision;
  edges:          FluffyEdge[];
  externalInputs: FluffyExternalInput[];
  nodes:          [FluffyNode, ...FluffyNode[]];
  policy:         FluffyPolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface FluffyDecision {
  items:               FluffyItem[];
  sourceRevisions:     [FluffySourceRevision, ...FluffySourceRevision[]];
  sources:             [FluffySource, ...FluffySource[]];
  summary:             string;
  unresolvedQuestions: FluffyUnresolvedQuestion[];
}

export interface FluffyItem {
  itemKey:   string;
  statement: string;
}

export interface FluffySourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface FluffySource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface FluffyUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface FluffyEdge {
  bindings:    FluffyBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface FluffyBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface FluffyExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface FluffyNode {
  agentId:              string;
  budget:               TentacledBudget;
  inputs:               FluffyInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [FluffyOutput, ...FluffyOutput[]];
  repository:           FluffyRepository;
  required:             boolean;
  scope:                FluffyScope;
  task:                 FluffyTask;
  verificationProfiles: FluffyVerificationProfile[];
}

export interface TentacledBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface FluffyInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface FluffyOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface FluffyRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface FluffyScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface FluffyTask {
  criteria?:             [FluffyCriterion, ...FluffyCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         FluffySourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface FluffyCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface FluffySourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface FluffyVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface FluffyPolicy {
  budget:                          StickyBudget;
  integration:                     Integration;
  integrationTargets:              FluffyIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface StickyBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface FluffyIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface ExecutionPlanRevisionPage {
  nextAfterRevision: number | null;
  revisions:         Revision[];
}

export interface Revision {
  author: RevisionAuthor;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:  string;
  decisionId: string;
  definition: RevisionDefinition;
  digest:     string;
  planId:     string;
  proposalId: string;
  revision:   number;
}

export interface RevisionAuthor {
  kind:          AuthorKind;
  memberId?:     string;
  agentId?:      string;
  runId?:        string;
  discussionId?: string;
}

export interface RevisionDefinition {
  decision:       TentacledDecision;
  edges:          TentacledEdge[];
  externalInputs: TentacledExternalInput[];
  nodes:          [TentacledNode, ...TentacledNode[]];
  policy:         TentacledPolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface TentacledDecision {
  items:               TentacledItem[];
  sourceRevisions:     [TentacledSourceRevision, ...TentacledSourceRevision[]];
  sources:             [TentacledSource, ...TentacledSource[]];
  summary:             string;
  unresolvedQuestions: TentacledUnresolvedQuestion[];
}

export interface TentacledItem {
  itemKey:   string;
  statement: string;
}

export interface TentacledSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface TentacledSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface TentacledUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface TentacledEdge {
  bindings:    TentacledBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface TentacledBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface TentacledExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface TentacledNode {
  agentId:              string;
  budget:               IndigoBudget;
  inputs:               TentacledInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [TentacledOutput, ...TentacledOutput[]];
  repository:           TentacledRepository;
  required:             boolean;
  scope:                TentacledScope;
  task:                 TentacledTask;
  verificationProfiles: TentacledVerificationProfile[];
}

export interface IndigoBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface TentacledInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface TentacledOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface TentacledRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface TentacledScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface TentacledTask {
  criteria?:             [TentacledCriterion, ...TentacledCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         TentacledSourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface TentacledCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface TentacledSourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface TentacledVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface TentacledPolicy {
  budget:                          IndecentBudget;
  integration:                     Integration;
  integrationTargets:              TentacledIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface IndecentBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface TentacledIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface ExecutionDecisionRecord {
  author:  ExecutionDecisionRecordAuthor;
  content: Content;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:            string;
  decisionId:           string;
  roomId:               string;
  rootTaskId:           string;
  supersedesDecisionId: null | string;
}

export interface ExecutionDecisionRecordAuthor {
  kind:          AuthorKind;
  memberId?:     string;
  agentId?:      string;
  runId?:        string;
  discussionId?: string;
}

export interface Content {
  items:               ContentItem[];
  sourceRevisions:     [ContentSourceRevision, ...ContentSourceRevision[]];
  sources:             [ContentSource, ...ContentSource[]];
  summary:             string;
  unresolvedQuestions: ContentUnresolvedQuestion[];
}

export interface ContentItem {
  itemKey:   string;
  statement: string;
}

export interface ContentSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface ContentSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface ContentUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface ExecutionDecisionContent {
  items:               ExecutionDecisionContentItem[];
  sourceRevisions:     [ExecutionDecisionContentSourceRevision, ...ExecutionDecisionContentSourceRevision[]];
  sources:             [ExecutionDecisionContentSource, ...ExecutionDecisionContentSource[]];
  summary:             string;
  unresolvedQuestions: ExecutionDecisionContentUnresolvedQuestion[];
}

export interface ExecutionDecisionContentItem {
  itemKey:   string;
  statement: string;
}

export interface ExecutionDecisionContentSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface ExecutionDecisionContentSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface ExecutionDecisionContentUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface ExecutionPlanDefinition {
  decision:       ExecutionPlanDefinitionDecision;
  edges:          ExecutionPlanDefinitionEdge[];
  externalInputs: ExecutionPlanDefinitionExternalInput[];
  nodes:          [ExecutionPlanDefinitionNode, ...ExecutionPlanDefinitionNode[]];
  policy:         ExecutionPlanDefinitionPolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface ExecutionPlanDefinitionDecision {
  items:               StickyItem[];
  sourceRevisions:     [StickySourceRevision, ...StickySourceRevision[]];
  sources:             [StickySource, ...StickySource[]];
  summary:             string;
  unresolvedQuestions: StickyUnresolvedQuestion[];
}

export interface StickyItem {
  itemKey:   string;
  statement: string;
}

export interface StickySourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface StickySource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface StickyUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface ExecutionPlanDefinitionEdge {
  bindings:    StickyBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface StickyBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface ExecutionPlanDefinitionExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface ExecutionPlanDefinitionNode {
  agentId:              string;
  budget:               HilariousBudget;
  inputs:               StickyInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [StickyOutput, ...StickyOutput[]];
  repository:           StickyRepository;
  required:             boolean;
  scope:                StickyScope;
  task:                 StickyTask;
  verificationProfiles: StickyVerificationProfile[];
}

export interface HilariousBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface StickyInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface StickyOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface StickyRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface StickyScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface StickyTask {
  criteria?:             [StickyCriterion, ...StickyCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         StickySourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface StickyCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface StickySourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface StickyVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface ExecutionPlanDefinitionPolicy {
  budget:                          AmbitiousBudget;
  integration:                     Integration;
  integrationTargets:              StickyIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface AmbitiousBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface StickyIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface ExecutionPlanProposalCommand {
  definition:               ExecutionPlanProposalCommandDefinition;
  expectedRootTaskRevision: number;
  operationId:              string;
}

export interface ExecutionPlanProposalCommandDefinition {
  decision:       StickyDecision;
  edges:          StickyEdge[];
  externalInputs: StickyExternalInput[];
  nodes:          [StickyNode, ...StickyNode[]];
  policy:         StickyPolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface StickyDecision {
  items:               IndigoItem[];
  sourceRevisions:     [IndigoSourceRevision, ...IndigoSourceRevision[]];
  sources:             [IndigoSource, ...IndigoSource[]];
  summary:             string;
  unresolvedQuestions: IndigoUnresolvedQuestion[];
}

export interface IndigoItem {
  itemKey:   string;
  statement: string;
}

export interface IndigoSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface IndigoSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface IndigoUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface StickyEdge {
  bindings:    IndigoBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface IndigoBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface StickyExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface StickyNode {
  agentId:              string;
  budget:               CunningBudget;
  inputs:               IndigoInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [IndigoOutput, ...IndigoOutput[]];
  repository:           IndigoRepository;
  required:             boolean;
  scope:                IndigoScope;
  task:                 IndigoTask;
  verificationProfiles: IndigoVerificationProfile[];
}

export interface CunningBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface IndigoInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface IndigoOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface IndigoRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface IndigoScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface IndigoTask {
  criteria?:             [IndigoCriterion, ...IndigoCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         IndigoSourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface IndigoCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface IndigoSourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface IndigoVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface StickyPolicy {
  budget:                          MagentaBudget;
  integration:                     Integration;
  integrationTargets:              IndigoIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface MagentaBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface IndigoIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface DiscussionPlanProposalDraft {
  decision:       DiscussionPlanProposalDraftDecision;
  edges:          DiscussionPlanProposalDraftEdge[];
  externalInputs: DiscussionPlanProposalDraftExternalInput[];
  nodes:          [DiscussionPlanProposalDraftNode, ...DiscussionPlanProposalDraftNode[]];
  policy:         DiscussionPlanProposalDraftPolicy;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface DiscussionPlanProposalDraftDecision {
  items:               IndecentItem[];
  summary:             string;
  unresolvedQuestions: IndecentUnresolvedQuestion[];
}

export interface IndecentItem {
  itemKey:   string;
  statement: string;
}

export interface IndecentUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface DiscussionPlanProposalDraftEdge {
  bindings:    IndecentBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface IndecentBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface DiscussionPlanProposalDraftExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface DiscussionPlanProposalDraftNode {
  agentId:              string;
  budget:               FriskyBudget;
  inputs:               IndecentInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [IndecentOutput, ...IndecentOutput[]];
  repository:           IndecentRepository;
  required:             boolean;
  scope:                IndecentScope;
  task:                 IndecentTask;
  verificationProfiles: IndecentVerificationProfile[];
}

export interface FriskyBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface IndecentInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface IndecentOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface IndecentRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface IndecentScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface IndecentTask {
  criteria?:             [IndecentCriterion, ...IndecentCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         IndecentSourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface IndecentCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface IndecentSourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface IndecentVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface DiscussionPlanProposalDraftPolicy {
  budget:                          MischievousBudget;
  integration:                     Integration;
  integrationTargets:              IndecentIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface MischievousBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface IndecentIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface ExecutionPlanRevisionCommand {
  definition:               ExecutionPlanRevisionCommandDefinition;
  expectedRevision:         number;
  expectedRootTaskRevision: number;
  operationId:              string;
}

export interface ExecutionPlanRevisionCommandDefinition {
  decision:       IndigoDecision;
  edges:          IndigoEdge[];
  externalInputs: IndigoExternalInput[];
  nodes:          [IndigoNode, ...IndigoNode[]];
  policy:         IndigoPolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface IndigoDecision {
  items:               HilariousItem[];
  sourceRevisions:     [IndecentSourceRevision, ...IndecentSourceRevision[]];
  sources:             [IndecentSource, ...IndecentSource[]];
  summary:             string;
  unresolvedQuestions: HilariousUnresolvedQuestion[];
}

export interface HilariousItem {
  itemKey:   string;
  statement: string;
}

export interface IndecentSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface IndecentSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface HilariousUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface IndigoEdge {
  bindings:    HilariousBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface HilariousBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface IndigoExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface IndigoNode {
  agentId:              string;
  budget:               BraggadociousBudget;
  inputs:               HilariousInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [HilariousOutput, ...HilariousOutput[]];
  repository:           HilariousRepository;
  required:             boolean;
  scope:                HilariousScope;
  task:                 HilariousTask;
  verificationProfiles: HilariousVerificationProfile[];
}

export interface BraggadociousBudget {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface HilariousInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface HilariousOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface HilariousRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface HilariousScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface HilariousTask {
  criteria?:             [HilariousCriterion, ...HilariousCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         HilariousSourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface HilariousCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface HilariousSourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface HilariousVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface IndigoPolicy {
  budget:                          Budget1;
  integration:                     Integration;
  integrationTargets:              HilariousIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface Budget1 {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface HilariousIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface ExecutionPlanApprovalCommand {
  decision:                 DecisionEnum;
  expectedDigest:           string;
  expectedRevision:         number;
  expectedRootTaskRevision: number;
  operationId:              string;
  reason:                   string;
}

export type DecisionEnum = "approved" | "rejected";

export interface ExecutionPlanApprovalRecord {
  compiledTasks: ExecutionPlanApprovalRecordCompiledTask[];
  decision:      DecisionEnum;
  digest:        string;
  operationId:   string;
  planId:        string;
  reason:        string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  reviewedAt:             string;
  reviewedByMemberId:     string;
  revision:               number;
  rootTaskRevisionAfter:  number;
  rootTaskRevisionBefore: number;
}

export interface ExecutionPlanApprovalRecordCompiledTask {
  criteriaRevision:   number;
  definitionRevision: number;
  nodeKey:            string;
  taskId:             string;
  taskRevision:       number;
}

export interface ExecutionPlanApprovalReceipt {
  approval: ExecutionPlanApprovalReceiptApproval;
  plan:     ExecutionPlanApprovalReceiptPlan;
}

export interface ExecutionPlanApprovalReceiptApproval {
  compiledTasks: FluffyCompiledTask[];
  decision:      DecisionEnum;
  digest:        string;
  operationId:   string;
  planId:        string;
  reason:        string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  reviewedAt:             string;
  reviewedByMemberId:     string;
  revision:               number;
  rootTaskRevisionAfter:  number;
  rootTaskRevisionBefore: number;
}

export interface FluffyCompiledTask {
  criteriaRevision:   number;
  definitionRevision: number;
  nodeKey:            string;
  taskId:             string;
  taskRevision:       number;
}

export interface ExecutionPlanApprovalReceiptPlan {
  compiledTasks:   TentacledCompiledTask[];
  controlRevision: number;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:     string;
  current:       FluffyCurrent;
  ownerMemberId: string;
  planId:        string;
  roomId:        string;
  rootTaskId:    string;
  state:         ExecutionPlanProjectionState;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  updatedAt: string;
}

export interface TentacledCompiledTask {
  criteriaRevision:   number;
  definitionRevision: number;
  nodeKey:            string;
  taskId:             string;
  taskRevision:       number;
}

export interface FluffyCurrent {
  author: TentacledAuthor;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:  string;
  decisionId: string;
  definition: TentacledDefinition;
  digest:     string;
  planId:     string;
  proposalId: string;
  revision:   number;
}

export interface TentacledAuthor {
  kind:          AuthorKind;
  memberId?:     string;
  agentId?:      string;
  runId?:        string;
  discussionId?: string;
}

export interface TentacledDefinition {
  decision:       IndecentDecision;
  edges:          IndecentEdge[];
  externalInputs: IndecentExternalInput[];
  nodes:          [IndecentNode, ...IndecentNode[]];
  policy:         IndecentPolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface IndecentDecision {
  items:               AmbitiousItem[];
  sourceRevisions:     [HilariousSourceRevision, ...HilariousSourceRevision[]];
  sources:             [HilariousSource, ...HilariousSource[]];
  summary:             string;
  unresolvedQuestions: AmbitiousUnresolvedQuestion[];
}

export interface AmbitiousItem {
  itemKey:   string;
  statement: string;
}

export interface HilariousSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface HilariousSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface AmbitiousUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface IndecentEdge {
  bindings:    AmbitiousBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface AmbitiousBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface IndecentExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface IndecentNode {
  agentId:              string;
  budget:               Budget2;
  inputs:               AmbitiousInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [AmbitiousOutput, ...AmbitiousOutput[]];
  repository:           AmbitiousRepository;
  required:             boolean;
  scope:                AmbitiousScope;
  task:                 AmbitiousTask;
  verificationProfiles: AmbitiousVerificationProfile[];
}

export interface Budget2 {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface AmbitiousInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface AmbitiousOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface AmbitiousRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface AmbitiousScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface AmbitiousTask {
  criteria?:             [AmbitiousCriterion, ...AmbitiousCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         AmbitiousSourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface AmbitiousCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface AmbitiousSourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface AmbitiousVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface IndecentPolicy {
  budget:                          Budget3;
  integration:                     Integration;
  integrationTargets:              AmbitiousIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface Budget3 {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface AmbitiousIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface ExecutionPlanApprovalPage {
  approvals:         ApprovalElement[];
  nextAfterRevision: number | null;
}

export interface ApprovalElement {
  compiledTasks: StickyCompiledTask[];
  decision:      DecisionEnum;
  digest:        string;
  operationId:   string;
  planId:        string;
  reason:        string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  reviewedAt:             string;
  reviewedByMemberId:     string;
  revision:               number;
  rootTaskRevisionAfter:  number;
  rootTaskRevisionBefore: number;
}

export interface StickyCompiledTask {
  criteriaRevision:   number;
  definitionRevision: number;
  nodeKey:            string;
  taskId:             string;
  taskRevision:       number;
}

export interface ExecutionPlanControlCommand {
  action:                  ActionEnum;
  expectedControlRevision: number;
  operationId:             string;
  reason:                  string;
}

export type ActionEnum = "pause" | "resume" | "cancel";

export interface ExecutionNodeRetryCommand {
  ambiguityAcknowledgementOperationId: null | string;
  expectedControlRevision:             number;
  expectedNodeProjectionRevision:      number;
  expectedPlanDigest:                  string;
  expectedPlanRevision:                number;
  expectedPreviousGeneration:          number;
  expectedPreviousRunId:               string;
  nodeKey:                             string;
  operationId:                         string;
  reason:                              string;
}

export interface ExecutionNodeRetryAuthorization {
  ambiguityAcknowledgementOperationId: null | string;
  authorizationDigest:                 string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:                      string;
  newDispatchIntentId:            string;
  newGeneration:                  number;
  newRunId:                       string;
  nodeKey:                        string;
  operationId:                    string;
  planControlRevision:            number;
  planDigest:                     string;
  planId:                         string;
  planRevision:                   number;
  previousGeneration:             number;
  previousNodeProjectionRevision: number;
  previousRunId:                  string;
  previousRunState:               PreviousRunState;
  reason:                         string;
  requestDigest:                  string;
  requestedByMemberId:            string;
}

export type PreviousRunState = "failed" | "canceled" | "expired" | "outcome_unknown";

export interface ExecutionPlanRevision {
  author: ExecutionPlanRevisionAuthor;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:  string;
  decisionId: string;
  definition: ExecutionPlanRevisionDefinition;
  digest:     string;
  planId:     string;
  proposalId: string;
  revision:   number;
}

export interface ExecutionPlanRevisionAuthor {
  kind:          AuthorKind;
  memberId?:     string;
  agentId?:      string;
  runId?:        string;
  discussionId?: string;
}

export interface ExecutionPlanRevisionDefinition {
  decision:       HilariousDecision;
  edges:          HilariousEdge[];
  externalInputs: HilariousExternalInput[];
  nodes:          [HilariousNode, ...HilariousNode[]];
  policy:         HilariousPolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface HilariousDecision {
  items:               CunningItem[];
  sourceRevisions:     [AmbitiousSourceRevision, ...AmbitiousSourceRevision[]];
  sources:             [AmbitiousSource, ...AmbitiousSource[]];
  summary:             string;
  unresolvedQuestions: CunningUnresolvedQuestion[];
}

export interface CunningItem {
  itemKey:   string;
  statement: string;
}

export interface AmbitiousSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface AmbitiousSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface CunningUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface HilariousEdge {
  bindings:    CunningBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface CunningBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface HilariousExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface HilariousNode {
  agentId:              string;
  budget:               Budget4;
  inputs:               CunningInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [CunningOutput, ...CunningOutput[]];
  repository:           CunningRepository;
  required:             boolean;
  scope:                CunningScope;
  task:                 CunningTask;
  verificationProfiles: CunningVerificationProfile[];
}

export interface Budget4 {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface CunningInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface CunningOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface CunningRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface CunningScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface CunningTask {
  criteria?:             [CunningCriterion, ...CunningCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         CunningSourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface CunningCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface CunningSourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface CunningVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface HilariousPolicy {
  budget:                          Budget5;
  integration:                     Integration;
  integrationTargets:              CunningIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface Budget5 {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface CunningIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface ExecutionAgentPlanProposalCommand {
  command: Command;
  runId:   string;
}

export interface Command {
  definition:               CommandDefinition;
  expectedRootTaskRevision: number;
  operationId:              string;
}

export interface CommandDefinition {
  decision:       AmbitiousDecision;
  edges:          AmbitiousEdge[];
  externalInputs: AmbitiousExternalInput[];
  nodes:          [AmbitiousNode, ...AmbitiousNode[]];
  policy:         AmbitiousPolicy;
  rootTaskId:     string;
  schemaVersion:  SchemaVersion;
  title:          string;
}

export interface AmbitiousDecision {
  items:               MagentaItem[];
  sourceRevisions:     [CunningSourceRevision, ...CunningSourceRevision[]];
  sources:             [CunningSource, ...CunningSource[]];
  summary:             string;
  unresolvedQuestions: MagentaUnresolvedQuestion[];
}

export interface MagentaItem {
  itemKey:   string;
  statement: string;
}

export interface CunningSourceRevision {
  evidenceRefId: string;
  revision:      number;
}

export interface CunningSource {
  artifactId?:   string;
  evidenceRefId: string;
  kind:          SourceKind;
  runId?:        string;
  sequence?:     number;
  messageId?:    string;
  memoryId?:     string;
  discussionId?: string;
  resultId?:     string;
}

export interface MagentaUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface AmbitiousEdge {
  bindings:    MagentaBinding[];
  edgeKey:     string;
  fromNodeKey: string;
  gate:        Gate;
  toNodeKey:   string;
}

export interface MagentaBinding {
  inputSlot:  string;
  outputSlot: string;
}

export interface AmbitiousExternalInput {
  artifactId:       string;
  artifactRevision: number;
  contentDigest:    string;
  inputSlot:        string;
  kind:             ExternalInputKind;
  nodeKey:          string;
  sourceResultId:   string;
  sourceTaskId:     string;
}

export interface AmbitiousNode {
  agentId:              string;
  budget:               Budget6;
  inputs:               MagentaInput[];
  kind:                 NodeKind;
  nodeKey:              string;
  outputs:              [MagentaOutput, ...MagentaOutput[]];
  repository:           MagentaRepository;
  required:             boolean;
  scope:                MagentaScope;
  task:                 MagentaTask;
  verificationProfiles: MagentaVerificationProfile[];
}

export interface Budget6 {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface MagentaInput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface MagentaOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface MagentaRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface MagentaScope {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface MagentaTask {
  criteria?:             [MagentaCriterion, ...MagentaCriterion[]];
  goal?:                 string;
  mode:                  TaskMode;
  ownerMemberId?:        string;
  sourceAction?:         MagentaSourceAction;
  title?:                string;
  criteriaRevision?:     number;
  definitionRevision?:   number;
  expectedTaskRevision?: number;
  taskId?:               string;
}

export interface MagentaCriterion {
  criterionKey: string;
  description:  string;
  ordinal:      number;
  required:     boolean;
}

export interface MagentaSourceAction {
  nextActionKey: string;
  resultId:      string;
}

export interface MagentaVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface AmbitiousPolicy {
  budget:                          Budget7;
  integration:                     Integration;
  integrationTargets:              MagentaIntegrationTarget[];
  maxConcurrency:                  number;
  requireHumanIntegrationApproval: boolean;
}

export interface Budget7 {
  maxExecutionDurationSeconds: number;
  maxRunAttempts:              number;
}

export interface MagentaIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface GovernedExecutionManifest {
  capture?: GovernedExecutionManifestCapture;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  deadline:             string;
  grant:                GovernedExecutionManifestGrant;
  inputDigest:          string;
  inputs:               GovernedExecutionManifestInput[];
  manifestDigest:       string;
  outputs:              [GovernedExecutionManifestOutput, ...GovernedExecutionManifestOutput[]];
  repository:           GovernedExecutionManifestRepository;
  scope:                GovernedExecutionManifestScope;
  scopePolicy:          GovernedExecutionManifestScopePolicy;
  verificationProfiles: GovernedExecutionManifestVerificationProfile[];
  version:              number;
  workspace:            GovernedExecutionManifestWorkspace;
}

export interface GovernedExecutionManifestCapture {
  operationId: string;
  outputs:     [FriskyOutput, ...FriskyOutput[]];
  rootTaskId:  string;
}

export interface FriskyOutput {
  path:    null | string;
  slotKey: string;
  summary: string;
  title:   string;
}

export interface GovernedExecutionManifestGrant {
  digest: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt: string;
  grantId:   string;
  revision:  number;
}

export interface GovernedExecutionManifestInput {
  artifact:            PurpleArtifact;
  bindingId:           string;
  destinationAgentId:  string;
  destinationDeviceId: string;
  destinationRunId:    string;
  destinationTaskId:   string;
  edgeKey:             null | string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt:       string;
  gate:            Gate;
  gateDigest:      string;
  gateOperationId: string;
  inputSlot:       string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  issuedAt:                 string;
  planId:                   string;
  planRevision:             number;
  repositoryId:             null | string;
  sourceCommit:             null | string;
  sourceCriteriaRevision:   number;
  sourceDefinitionRevision: number;
  sourceOutputSlot:         string;
  sourceResultId:           null | string;
  sourceResultVersion:      number | null;
  sourceTaskId:             string;
  sourceTree:               null | string;
}

export interface PurpleArtifact {
  artifactId:       string;
  artifactRevision: number;
  byteLength:       number;
  contentDigest:    string;
  kind:             ExternalInputKind;
}

export interface GovernedExecutionManifestOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface GovernedExecutionManifestRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface GovernedExecutionManifestScope {
  agentId:             string;
  approvalOperationId: string;
  criteriaRevision:    number;
  definitionRevision:  number;
  deviceId:            string;
  dispatchGeneration:  number;
  nodeKey:             string;
  planControlRevision: number;
  planDigest:          string;
  planId:              string;
  planRevision:        number;
  roomId:              string;
  runId:               string;
  taskId:              string;
  taskRevision:        number;
}

export interface GovernedExecutionManifestScopePolicy {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface GovernedExecutionManifestVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface GovernedExecutionManifestWorkspace {
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  issuedAt:            string;
  leaseId:             string;
  mode:                WorkspaceMode;
  workspaceGeneration: string;
  workspaceRef:        string;
}

export type WorkspaceMode = "isolated_worktree";

export interface ExecutionInputBinding {
  artifact:            ExecutionInputBindingArtifact;
  bindingId:           string;
  destinationAgentId:  string;
  destinationDeviceId: string;
  destinationRunId:    string;
  destinationTaskId:   string;
  edgeKey:             null | string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt:       string;
  gate:            Gate;
  gateDigest:      string;
  gateOperationId: string;
  inputSlot:       string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  issuedAt:                 string;
  planId:                   string;
  planRevision:             number;
  repositoryId:             null | string;
  sourceCommit:             null | string;
  sourceCriteriaRevision:   number;
  sourceDefinitionRevision: number;
  sourceOutputSlot:         string;
  sourceResultId:           null | string;
  sourceResultVersion:      number | null;
  sourceTaskId:             string;
  sourceTree:               null | string;
}

export interface ExecutionInputBindingArtifact {
  artifactId:       string;
  artifactRevision: number;
  byteLength:       number;
  contentDigest:    string;
  kind:             ExternalInputKind;
}

export interface GovernedExecutionCapability {
  operations:                [KindElement, ...KindElement[]];
  preventivePathEnforcement: boolean;
  /**
   * Path-free current local grant summaries available to one published Agent. Omission means
   * no admission-ready grant was published and grants no authority.
   */
  readyGrants?:      [GovernedExecutionCapabilityReadyGrant, ...GovernedExecutionCapabilityReadyGrant[]];
  version:           number;
  workspaceBoundary: WorkspaceBoundary;
}

export type KindElement = "prepare" | "capture" | "verify" | "integrate" | "publish" | "observe";

export interface GovernedExecutionCapabilityReadyGrant {
  agentId:            string;
  bindingId:          string;
  deviceId:           string;
  grant:              PurpleGrant;
  integrationTargets: FriskyIntegrationTarget[];
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  issuedAt:             string;
  nodeKey:              string;
  operations:           [KindElement, ...KindElement[]];
  planId:               string;
  repositoryId:         string;
  revokedAt:            null | string;
  runtimeProfile:       PurpleRuntimeProfile;
  scopePolicy:          PurpleScopePolicy;
  verificationProfiles: FriskyVerificationProfile[];
}

export interface PurpleGrant {
  digest: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt: string;
  grantId:   string;
  revision:  number;
}

export interface FriskyIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface PurpleRuntimeProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface PurpleScopePolicy {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface FriskyVerificationProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export type WorkspaceBoundary = "enforced";

export interface RuntimeAuthorityRequest {
  leaseId:             string;
  manifestDigest:      string;
  runId:               string;
  version:             number;
  workspaceGeneration: string;
  workspaceRef:        string;
}

export interface RuntimeAuthorityView {
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  checkedAt: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt:           string;
  leaseId:             string;
  leaseRevision:       number;
  manifestDigest:      string;
  runId:               string;
  state:               RuntimeAuthorityViewState;
  version:             number;
  workspaceGeneration: string;
  workspaceRef:        string;
}

export type RuntimeAuthorityViewState = "active";

export interface RepositoryBindingSummary {
  bindingId:      string;
  capability:     Capability;
  deviceId:       string;
  observedCommit: string;
  repositoryId:   string;
  revision:       number;
  runtimeProfile: RepositoryBindingSummaryRuntimeProfile;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  updatedAt:            string;
  verificationProfiles: RepositoryBindingSummaryVerificationProfile[];
  workspaceGeneration:  string;
  workspaceRef:         string;
}

export interface Capability {
  operations:                [KindElement, ...KindElement[]];
  preventivePathEnforcement: boolean;
  /**
   * Path-free current local grant summaries available to one published Agent. Omission means
   * no admission-ready grant was published and grants no authority.
   */
  readyGrants?:      [CapabilityReadyGrant, ...CapabilityReadyGrant[]];
  version:           number;
  workspaceBoundary: WorkspaceBoundary;
}

export interface CapabilityReadyGrant {
  agentId:            string;
  bindingId:          string;
  deviceId:           string;
  grant:              FluffyGrant;
  integrationTargets: MischievousIntegrationTarget[];
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  issuedAt:             string;
  nodeKey:              string;
  operations:           [KindElement, ...KindElement[]];
  planId:               string;
  repositoryId:         string;
  revokedAt:            null | string;
  runtimeProfile:       FluffyRuntimeProfile;
  scopePolicy:          FluffyScopePolicy;
  verificationProfiles: MischievousVerificationProfile[];
}

export interface FluffyGrant {
  digest: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt: string;
  grantId:   string;
  revision:  number;
}

export interface MischievousIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface FluffyRuntimeProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface FluffyScopePolicy {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface MischievousVerificationProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface RepositoryBindingSummaryRuntimeProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface RepositoryBindingSummaryVerificationProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface ExecutionGrantSummary {
  agentId:            string;
  bindingId:          string;
  deviceId:           string;
  grant:              ExecutionGrantSummaryGrant;
  integrationTargets: ExecutionGrantSummaryIntegrationTarget[];
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  issuedAt:             string;
  nodeKey:              string;
  operations:           [KindElement, ...KindElement[]];
  planId:               string;
  repositoryId:         string;
  revokedAt:            null | string;
  runtimeProfile:       ExecutionGrantSummaryRuntimeProfile;
  scopePolicy:          ExecutionGrantSummaryScopePolicy;
  verificationProfiles: ExecutionGrantSummaryVerificationProfile[];
}

export interface ExecutionGrantSummaryGrant {
  digest: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt: string;
  grantId:   string;
  revision:  number;
}

export interface ExecutionGrantSummaryIntegrationTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface ExecutionGrantSummaryRuntimeProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface ExecutionGrantSummaryScopePolicy {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface ExecutionGrantSummaryVerificationProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface RepositoryOperationRequest {
  action:    ActionClass;
  bindingId: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  deadline:           string;
  deviceId:           string;
  execution:          RepositoryOperationRequestExecution | null;
  expectedGeneration: string;
  grant:              RepositoryOperationRequestGrant;
  operationId:        string;
  plan:               RepositoryOperationRequestPlan;
  repositoryId:       string;
  requestDigest:      string;
  version:            number;
}

export interface ActionClass {
  kind:       KindElement;
  prepare?:   Prepare;
  capture?:   ActionCapture;
  verify?:    Verify;
  integrate?: Integrate;
  publish?:   Publish;
  observe?:   Observe;
}

export interface ActionCapture {
  manifestDigest: string;
}

export interface Integrate {
  candidateCommit:                string;
  candidateTree:                  string;
  inputDigest:                    string;
  integrationApprovalOperationId: string;
  target:                         IntegrateTarget;
  verificationIds:                [string, ...string[]];
}

export interface IntegrateTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface Observe {
  candidateCommit:     string;
  checkKeys:           string[];
  providerBindingId:   string;
  providerOperationId: null | string;
}

export interface Prepare {
  manifest:           Manifest;
  resumeCheckpointId: null | string;
}

export interface Manifest {
  capture?: ManifestCapture;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  deadline:             string;
  grant:                ManifestGrant;
  inputDigest:          string;
  inputs:               ManifestInput[];
  manifestDigest:       string;
  outputs:              [ManifestOutput, ...ManifestOutput[]];
  repository:           ManifestRepository;
  scope:                ManifestScope;
  scopePolicy:          ManifestScopePolicy;
  verificationProfiles: ManifestVerificationProfile[];
  version:              number;
  workspace:            ManifestWorkspace;
}

export interface ManifestCapture {
  operationId: string;
  outputs:     [MischievousOutput, ...MischievousOutput[]];
  rootTaskId:  string;
}

export interface MischievousOutput {
  path:    null | string;
  slotKey: string;
  summary: string;
  title:   string;
}

export interface ManifestGrant {
  digest: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt: string;
  grantId:   string;
  revision:  number;
}

export interface ManifestInput {
  artifact:            FluffyArtifact;
  bindingId:           string;
  destinationAgentId:  string;
  destinationDeviceId: string;
  destinationRunId:    string;
  destinationTaskId:   string;
  edgeKey:             null | string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt:       string;
  gate:            Gate;
  gateDigest:      string;
  gateOperationId: string;
  inputSlot:       string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  issuedAt:                 string;
  planId:                   string;
  planRevision:             number;
  repositoryId:             null | string;
  sourceCommit:             null | string;
  sourceCriteriaRevision:   number;
  sourceDefinitionRevision: number;
  sourceOutputSlot:         string;
  sourceResultId:           null | string;
  sourceResultVersion:      number | null;
  sourceTaskId:             string;
  sourceTree:               null | string;
}

export interface FluffyArtifact {
  artifactId:       string;
  artifactRevision: number;
  byteLength:       number;
  contentDigest:    string;
  kind:             ExternalInputKind;
}

export interface ManifestOutput {
  kind:     ExternalInputKind;
  required: boolean;
  slotKey:  string;
}

export interface ManifestRepository {
  baseCommit:           string;
  bindingId:            string;
  grantId:              string;
  grantRevision:        number;
  repositoryId:         string;
  runtimeProfileDigest: string;
  runtimeProfileId:     string;
}

export interface ManifestScope {
  agentId:             string;
  approvalOperationId: string;
  criteriaRevision:    number;
  definitionRevision:  number;
  deviceId:            string;
  dispatchGeneration:  number;
  nodeKey:             string;
  planControlRevision: number;
  planDigest:          string;
  planId:              string;
  planRevision:        number;
  roomId:              string;
  runId:               string;
  taskId:              string;
  taskRevision:        number;
}

export interface ManifestScopePolicy {
  access:                           Access;
  allowedPaths:                     string[];
  forbiddenPaths:                   string[];
  requirePreventivePathEnforcement: boolean;
}

export interface ManifestVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface ManifestWorkspace {
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  issuedAt:            string;
  leaseId:             string;
  mode:                WorkspaceMode;
  workspaceGeneration: string;
  workspaceRef:        string;
}

export interface Publish {
  candidateCommit:        string;
  integrationOperationId: string;
  mode:                   PublishMode;
  providerBindingId:      string;
  target:                 PublishTarget;
}

export type PublishMode = "push" | "pull_request";

export interface PublishTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface Verify {
  candidateCommit: string;
  candidateTree:   string;
  inputDigest:     string;
  profile:         VerifyProfile;
}

export interface VerifyProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface RepositoryOperationRequestExecution {
  agentId:             string;
  approvalOperationId: string;
  criteriaRevision:    number;
  definitionRevision:  number;
  deviceId:            string;
  dispatchGeneration:  number;
  nodeKey:             string;
  planControlRevision: number;
  planDigest:          string;
  planId:              string;
  planRevision:        number;
  roomId:              string;
  runId:               string;
  taskId:              string;
  taskRevision:        number;
}

export interface RepositoryOperationRequestGrant {
  digest: string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  expiresAt: string;
  grantId:   string;
  revision:  number;
}

export interface RepositoryOperationRequestPlan {
  approvalOperationId: string;
  digest:              string;
  planId:              string;
  revision:            number;
  roomId:              string;
  rootTaskId:          string;
}

export interface RepositoryOperationReceipt {
  bindingId:             string;
  candidateCommit:       null | string;
  candidateTree:         null | string;
  checkpointId:          null | string;
  deviceId:              string;
  errorCode:             null | string;
  kind:                  KindElement;
  observedGeneration:    null | string;
  operationId:           string;
  providerObservationId: null | string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  recordedAt:     string;
  repositoryId:   string;
  requestDigest:  string;
  state:          RepositoryOperationReceiptState;
  target:         RepositoryOperationReceiptTarget | null;
  verificationId: null | string;
  version:        number;
}

export type RepositoryOperationReceiptState = "prepared" | "succeeded" | "failed" | "canceled" | "outcome_unknown";

export interface RepositoryOperationReceiptTarget {
  expectedCommit: string;
  repositoryId:   string;
  targetRef:      string;
}

export interface RepositoryCheckpoint {
  baseCommit:      string;
  bindingId:       string;
  candidateCommit: string;
  candidateTree:   string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  capturedAt:          string;
  checkpointId:        string;
  digest:              string;
  inputDigest:         string;
  operationId:         string;
  outputs:             RepositoryCheckpointOutput[];
  repositoryId:        string;
  scope:               RepositoryCheckpointScope;
  workspaceGeneration: string;
  workspaceRef:        string;
}

export interface RepositoryCheckpointOutput {
  artifact: OutputArtifact;
  slotKey:  string;
}

export interface OutputArtifact {
  artifactId:       string;
  artifactRevision: number;
  byteLength:       number;
  contentDigest:    string;
  kind:             ExternalInputKind;
}

export interface RepositoryCheckpointScope {
  agentId:             string;
  approvalOperationId: string;
  criteriaRevision:    number;
  definitionRevision:  number;
  deviceId:            string;
  dispatchGeneration:  number;
  nodeKey:             string;
  planControlRevision: number;
  planDigest:          string;
  planId:              string;
  planRevision:        number;
  roomId:              string;
  runId:               string;
  taskId:              string;
  taskRevision:        number;
}

export interface VerificationReceipt {
  authority:            VerificationReceiptAuthority;
  bindingId:            null | string;
  candidateCommit:      string;
  candidateTree:        string;
  durationMilliseconds: number;
  execution:            VerificationReceiptExecution | null;
  exitCode:             number | null;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  finishedAt:             string;
  inputDigest:            string;
  integrationOperationId: null | string;
  logArtifact:            LogArtifact | null;
  operationId:            string;
  outcome:                Outcome;
  plan:                   VerificationReceiptPlan;
  profile:                VerificationReceiptProfile;
  repositoryId:           string;
  requestDigest:          string;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  startedAt:      string;
  verificationId: string;
  version:        number;
}

export type Authority = VerificationReceiptAuthority;

export interface VerificationReceiptAuthority {
  deviceId?:          string;
  kind:               AuthorityKind;
  attempt?:           number;
  checkKey?:          string;
  providerBindingId?: string;
}

export type AuthorityKind = "bridge" | "ci";

export interface VerificationReceiptExecution {
  agentId:             string;
  approvalOperationId: string;
  criteriaRevision:    number;
  definitionRevision:  number;
  deviceId:            string;
  dispatchGeneration:  number;
  nodeKey:             string;
  planControlRevision: number;
  planDigest:          string;
  planId:              string;
  planRevision:        number;
  roomId:              string;
  runId:               string;
  taskId:              string;
  taskRevision:        number;
}

export interface LogArtifact {
  artifactId:       string;
  artifactRevision: number;
  byteLength:       number;
  contentDigest:    string;
  kind:             ExternalInputKind;
}

export type Outcome = "passed" | "failed" | "timed_out" | "canceled" | "outcome_unknown";

export interface VerificationReceiptPlan {
  approvalOperationId: string;
  digest:              string;
  planId:              string;
  revision:            number;
  roomId:              string;
  rootTaskId:          string;
}

export interface VerificationReceiptProfile {
  digest:    string;
  profileId: string;
  revision:  number;
}

export interface SourceEvidence {
  agentId?:     string;
  artifactPins: [ArtifactPin, ...ArtifactPin[]];
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:           string;
  criteriaRevision?:   number;
  definitionRevision?: number;
  deviceId?:           string;
  dispatchGeneration?: number;
  kind:                SourceEvidenceKind;
  resultId?:           string;
  resultVersion?:      number;
  roomId?:             string;
  sourceDigest:        string;
  sourceEvidenceId:    string;
  sourceRunId?:        string;
  taskId?:             string;
  version:             number;
  commit?:             string;
  inputDigest?:        string;
  objectFormat?:       ObjectFormat;
  origin?:             Origin;
  repositoryId?:       string;
  tree?:               string;
}

export interface ArtifactPin {
  artifactId:       string;
  artifactRevision: number;
  byteLength:       number;
  contentDigest:    string;
  kind:             ExternalInputKind;
  outputSlot:       string;
}

export type SourceEvidenceKind = "task_result" | "repository_commit";

export type ObjectFormat = "sha1" | "sha256";

export interface Origin {
  bindingId?:                 string;
  captureOperationId?:        string;
  checkpointDigest?:          string;
  checkpointId?:              string;
  companionSourceDigest?:     string;
  companionSourceEvidenceId?: string;
  deviceId?:                  string;
  dispatchGeneration?:        number;
  kind:                       OriginKind;
  sourceRunId?:               string;
  commitBundleArtifactId?:    string;
  observationDigest?:         string;
  observationId?:             string;
  providerBindingId?:         string;
  providerRepositoryId?:      string;
}

export type OriginKind = "local_checkpoint" | "remote_observation";

export interface GateProofRef {
  kind:               GateProofRefKind;
  operationId:        string;
  proofDigest:        string;
  resultId?:          string;
  resultVersion?:     number;
  profileDigest?:     string;
  profileId?:         string;
  profileRevision?:   number;
  verificationId?:    string;
  attempt?:           number;
  checkKey?:          string;
  observationId?:     string;
  providerBindingId?: string;
  repositoryId?:      string;
  resultingCommit?:   string;
}

export type GateProofRefKind = "result_review" | "verification_receipt" | "ci_observation_receipt" | "integration_receipt";

export interface EvidenceAdoption {
  adoptionDigest: string;
  adoptionId:     string;
  authority:      EvidenceAdoptionAuthority;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:              string;
  gate:                   Gate;
  nodeContractDigest:     string;
  nodeKey:                string;
  operationDigest:        string;
  operationId:            string;
  planId:                 string;
  planRevision:           number;
  proofs:                 [Proof, ...Proof[]];
  proofSetDigest:         string;
  resolvedInputSetDigest: string;
  sourceDigest:           string;
  sourceEvidenceId:       string;
  sourceExecution:        SourceExecution | null;
  version:                number;
}

export interface EvidenceAdoptionAuthority {
  agentId:             string;
  approvalOperationId: string;
  criteriaRevision:    number;
  definitionRevision:  number;
  deviceId:            string;
  grantDigest:         string;
  grantId:             string;
  grantRevision:       number;
  planDigest:          string;
  roomId:              string;
  service:             Service;
  taskId:              string;
}

export type Service = "execution_materialization";

export interface Proof {
  kind:               GateProofRefKind;
  operationId:        string;
  proofDigest:        string;
  resultId?:          string;
  resultVersion?:     number;
  profileDigest?:     string;
  profileId?:         string;
  profileRevision?:   number;
  verificationId?:    string;
  attempt?:           number;
  checkKey?:          string;
  observationId?:     string;
  providerBindingId?: string;
  repositoryId?:      string;
  resultingCommit?:   string;
}

export interface SourceExecution {
  dispatchGeneration: number;
  runId:              string;
}
