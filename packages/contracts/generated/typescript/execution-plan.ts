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
  state:         State;
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
  mode:                  Mode;
  ownerMemberId?:        string;
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

export type Mode = "new" | "existing";

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

export type State = "draft" | "approved" | "running" | "paused" | "review" | "completed" | "canceled";

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
  plans:           Plan[];
}

export interface Plan {
  compiledTasks:   PlanCompiledTask[];
  controlRevision: number;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  createdAt:     string;
  current:       PlanCurrent;
  ownerMemberId: string;
  planId:        string;
  roomId:        string;
  rootTaskId:    string;
  state:         State;
  /**
   * Canonical RFC 3339 date-time using uppercase T, a UTC Z suffix, seconds 00-59, and at
   * most nanosecond precision.
   */
  updatedAt: string;
}

export interface PlanCompiledTask {
  criteriaRevision:   number;
  definitionRevision: number;
  nodeKey:            string;
  taskId:             string;
  taskRevision:       number;
}

export interface PlanCurrent {
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
  mode:                  Mode;
  ownerMemberId?:        string;
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
  mode:                  Mode;
  ownerMemberId?:        string;
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
  mode:                  Mode;
  ownerMemberId?:        string;
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
  mode:                  Mode;
  ownerMemberId?:        string;
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
  items:               IndecentItem[];
  sourceRevisions:     [IndecentSourceRevision, ...IndecentSourceRevision[]];
  sources:             [IndecentSource, ...IndecentSource[]];
  summary:             string;
  unresolvedQuestions: IndecentUnresolvedQuestion[];
}

export interface IndecentItem {
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

export interface IndecentUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface IndigoEdge {
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
  mode:                  Mode;
  ownerMemberId?:        string;
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

export interface IndecentVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface IndigoPolicy {
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

export interface ExecutionPlanApprovalCommand {
  decision:                 DecisionEnum;
  expectedDigest:           string;
  expectedRevision:         number;
  expectedRootTaskRevision: number;
  operationId:              string;
  reason:                   string;
}

export type DecisionEnum = "approved" | "rejected";

export interface ExecutionPlanControlCommand {
  action:                  Action;
  expectedControlRevision: number;
  operationId:             string;
  reason:                  string;
}

export type Action = "pause" | "resume" | "cancel";

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
  items:               HilariousItem[];
  sourceRevisions:     [HilariousSourceRevision, ...HilariousSourceRevision[]];
  sources:             [HilariousSource, ...HilariousSource[]];
  summary:             string;
  unresolvedQuestions: HilariousUnresolvedQuestion[];
}

export interface HilariousItem {
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

export interface HilariousUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface IndecentEdge {
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
  mode:                  Mode;
  ownerMemberId?:        string;
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

export interface HilariousVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface IndecentPolicy {
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
  items:               AmbitiousItem[];
  sourceRevisions:     [AmbitiousSourceRevision, ...AmbitiousSourceRevision[]];
  sources:             [AmbitiousSource, ...AmbitiousSource[]];
  summary:             string;
  unresolvedQuestions: AmbitiousUnresolvedQuestion[];
}

export interface AmbitiousItem {
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

export interface AmbitiousUnresolvedQuestion {
  questionKey: string;
  required:    boolean;
  text:        string;
}

export interface HilariousEdge {
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
  mode:                  Mode;
  ownerMemberId?:        string;
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

export interface AmbitiousVerificationProfile {
  digest:    string;
  profileId: string;
  required:  boolean;
  revision:  number;
}

export interface HilariousPolicy {
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
