# ADR-0036: Add governed software-team execution

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none; ADR-0039 supersedes this ADR's Remote Forge and Core
  completion assumptions while preserving the delivered local design

## Context

ConveneWire already has durable Task ownership and criteria, bounded Run
attempts, immutable Result proposals and human review, Task Artifact transport,
and deterministic Discussion Waves. The next product outcome is a software
team that turns an approved plan into verified repository changes, including
parallel implementation, review, integration and recoverable coordination.

The input architecture proposal correctly separates deliberation from
execution, but assumes Task/Run/Result are missing, leaves cross-Task inputs
undefined, and puts isolation after automatic coding. It also mixes code
pipelines into Discussion strategies. This decision preserves the current
authorities and fills those gaps instead of replacing existing aggregates.

This is an additive extension of the v0.2 baseline's repository-lifecycle
non-goal, not permission for Central to become a remote shell or filesystem.
ADRs 0011, 0012, 0016 and 0022 retain authority in their respective domains.

## Decision

### Product outcome and scope

The complete delivery has three increments, each with its own acceptance gate:

1. A human or assigned planning Agent proposes a structured decision and static
   development plan. A human approves its exact version. The system compiles
   existing Product Tasks, executes dependency-ready work in locally authorized
   isolated workspaces, collects independent verification, and offers Result
   review and explicit integration. Restart and response loss must not duplicate
   work or turn unknown effects into success.
2. Multiple implementation nodes run in parallel, including different Bridges.
   Exact upstream code and content enter dependent tasks. A serialized integration
   queue validates the actual candidate tree, handles conflicts, and binds CI/PR
   observations to exact repository identities and commits.
3. Scoped Tech Lead proposals support graph revisions and bounded replanning.
   Read-only Discussion can select relevant participants and optionally seal on
   a quorum; neither feature changes coding completion or local permissions.

The first increment is not the final completion claim for this workstream.
The task register includes all three and a final direction audit. Public
deployment, publishing a Release, production deployment credentials,
unrestricted autonomous merging, general distributed transactions,
cross-project memory, new model providers and an additional judge-model loop
are not required to implement this design. Existing workflows remain usable.

### Ownership map

| Owner | Authority | Explicitly not owned |
| --- | --- | --- |
| Room | conversation, membership and ordered Messages | repository or local permissions |
| Discussion | Wave, barrier, progress, budget and policy | Task completion or coding pipeline |
| Execution | decision/plan revisions, approvals, dependencies, input grants and dispatch intents | Task/Run/Result state or a second runtime |
| Task | goal, criteria, human Owner, assignment, budget and completion | graph scheduling or repository storage |
| Run | one execution attempt, frozen Delivery, events and outcome | Task acceptance or merge authority |
| Result/Artifact | immutable claims, review and canonical content/provenance | trusted test execution merely from Agent prose |
| Workspace/Bridge | opaque leases and owner-local workspace operations respectively | Central-generated operating-system permissions |
| Repository/Bridge | owner-local paths, remotes, credentials, Git commands, worktrees and ref mutation | Central possession of repository or machine authority |
| Verification | authenticated observation against an exact input and profile | accepting Results or declaring arbitrary claims true |

Execution coordination lives in the existing Server; Repository execution
lives on the Client/Bridge. The Server retains opaque requests and receipts but
does not become a repository adapter or shell. The retained Remote Evidence
adapter is an optional extension under ADR-0039, not Core Repository authority.
No duplicate Issue, TaskAttempt or TaskEvidence authority is created.
A top-level non-default Task is the development objective; an external Issue is
an optional attributed reference, not another completion state machine.

### Structured decisions and proposals

`DecisionRecord` is immutable domain content: source Task/Discussion/Result
references, exact source versions, summary, stable decision-item keys,
unresolved questions and evidence references. It is distinct from the
Discussion engine's `OrchestrationDecision` action record. A decision may be
superseded by a new record, never edited retroactively. It has no `executing`
state; plan execution belongs to an approved plan.

`PlanProposal` contains node blueprints, dependency edges, exact repository
inputs, expected outputs, verification profile references and bounded resource
policy. Natural-language summaries are explanatory, not executable commands.
Human entry and assigned Tech Lead entry use the same schema and domain
validation. An Agent may propose only from its own persisted Task Run or owned
Discussion context. It cannot acquire human authority by using a role name.

Discussion finalization may publish one structured proposal through a stable
operation identity. Invalid or missing structure leaves the existing final
Message intact and produces no plan. An accepted Result's next actions remain
immutable; compiling their selected actions creates ordinary child Tasks and
explicit plan provenance without rewriting or auto-completing the Result.

### Immutable plans and atomic compilation

`ExecutionPlan` identifies one root Task and Room. Every `PlanRevision` is a
complete immutable snapshot with monotonic revision, canonical digest, creator,
source decision/proposal, nodes, edges and policy. Nodes have stable `nodeKey`
identities independent of labels, Task IDs and array positions. Edges have
stable keys and explicit satisfaction conditions. Limits are 64 nodes, 256
edges, 32 input/output slots per node, and concurrency 1 through 8. The first
supported graph is a DAG; duplicate nodes, self/cyclic edges, missing endpoints
and inconsistent input bindings fail before any Task or Run is committed.

An approval binds the exact proposal/plan revision and digest, human actor,
root Task revision, child definition/criteria revisions, repository snapshot,
assignments, local-grant requirements, verification profiles, allowed output
scope, graph policy, concurrency and budget. One approval transaction validates
current Room membership and Task ownership, allocates or links ordinary child
Tasks, persists the full graph and approval, and fences root revision changes.
Failure leaves no partial Task graph. An operation identity plus normalized
payload digest makes an exact response-loss retry return the original result;
the same identity with changed content is a conflict.

A linked Task must be non-default, in the same Room, owned by an authorized
human, and not owned by another active plan. New child Tasks use the existing
Task service; they retain canonical criteria, Result review and budget rules.
Plan approval does not accept their Results or move them to `completed`.
Task/definition/criteria drift pauses admission and creates explicit attention.
It does not relabel prior Runs or silently broaden an approved snapshot.

Execution state is `draft`, `approved`, `running`, `paused`, `review`,
`completed` or `canceled`. Approval review and execution control are separate
append-only operations. Node presentation is derived from dependency bindings,
existing Tasks/Runs, verification and repository receipts. No mirrored mutable
Task or Run terminal state is authoritative.

### Dependencies carry data as well as ordering

An edge identifies upstream/downstream nodes and an explicit gate:
`accepted_result`, `verified_output` or `integrated_commit`. `run.completed`
alone never satisfies an edge. A gate resolves to a pinned receipt containing
the relevant Task definition/criteria, Result, Artifact and commit identities.
Downstream admission atomically freezes those exact inputs; later observations
cannot silently replace them. A downstream instruction must not use "latest
upstream output" after dispatch.

`TaskInputBinding` is a new explicit cross-Task read authority, not a relaxation
of the same-Task Result evidence trigger. It binds an approved plan revision,
edge, source Task/Result/output, destination Task/Run, content digest and current
Room authorization. Only content explicitly selected in the approved graph may
be delivered. A destination Task does not inherit source acceptance or criteria.
If it publishes a derived Artifact, provenance names the authorized input
binding; the resulting Artifact remains canonical to the destination Task.
Existing same-Task Artifact relations remain unchanged.

Repository dependencies pin full Git object IDs and an opaque repository
binding. Downstream preparation applies exactly the selected predecessor
changes to the approved base, in deterministic topological/node-key order.
Conflicts pause that node for explicit resolution. A downstream reviewer must
see the exact selected candidate, not a coincidentally current local checkout.
Cross-Bridge transfer uses authenticated content transport with pinned digests;
it never grants arbitrary same-Team content access.

Logical `repositoryId` and owner-local `bindingId` are distinct. Multiple
Bridges may explicitly enroll bindings into one authorized logical repository;
display names and matching paths cannot establish that relationship. All
integration locks and target identities use the logical repository, not an
individual checkout. Every operation still resolves its specific local binding
and grant. A verified-output edge may release only the approved dependent work;
it never accepts its producer's Result. Definition drift or withdrawal of a
selected proposal blocks new use and requires explicit plan reconciliation.

### Scheduler and Run integration

One deterministic scheduler selects dependency-ready nodes by approved
topological order and binary `nodeKey`, subject to graph/Task budgets, current
membership, assignment, runtime capability, local grant, workspace capacity and
plan state. It persists a unique dispatch intent and ordinary Run atomically.
The uniqueness identity includes plan revision, node key and an explicit
dispatch generation. Physical execution still uses existing Run Delivery and
the Bridge inbox; scheduling adds no second process-start path.

The frozen execution manifest extends the existing Run Context Manifest and
Delivery with plan/node identities, exact input receipts, repository base,
local grant reference, scope policy, verifier profile digests and output slots.
An execution-bound Run is never sent to a Bridge that lacks the new capability.
Generic/manual/hosted Agents remain available for ordinary work and planning;
they must not silently emulate isolated coding or trusted verification.

Admission occurs only after graph and Task prerequisites pass. Bridge preparation
and runtime invocation share a durable local operation journal: workspace
creation alone is not proof that the Runtime started. Loss after possible
invocation remains `outcome_unknown`. Explicit retry creates a new Run through
the existing retry contract and pins a new dispatch generation; no timer
automatically retries ambiguous execution.

### Local authority, isolation and scope

The Bridge owner explicitly registers a repository binding, permitted runtime
profiles, verification profiles and allowed integration targets. Central sees
opaque IDs, capability summaries and fingerprints, not absolute paths, shell
commands, environments or credentials. Pairing/Agent creation grants none of
these new authorities. Existing bindings do not opt into coding automatically.

`TaskScopedGrant` is owner-local, revocable and bounded by repository, Device,
Agent, plan/node, operation kinds, expiry and local policy revision. Central
approval can request only the intersection of that grant and the Task contract.
Grant revocation or expiry prevents new operations; in-flight operations receive
bounded cancellation and retain unknown outcomes until trustworthy settlement.

Every coding attempt has a Bridge-owned branch/worktree derived from a pinned
base. Worktrees, runtime session scopes, staging, ports and writable build/test
state are isolated per active attempt. No two active writers share a worktree.
Same-task retries may import a prior sealed checkpoint explicitly but never
resume an ambiguous live writer or silently inherit its dirty directory.

A worktree is a version-control isolation mechanism, not an OS sandbox. Runtime
admission requires a supported locally enforced workspace boundary. A Runtime
without that capability fails closed for governed coding. `allowedPaths` and
`forbiddenPaths` are independently enforced as output/merge scope gates; they
do not claim to prevent intermediate writes within the isolated workspace.
When a Task requires preventive per-path restrictions, the selected backend
must advertise and enforce them or reject the task. Unsupported requirements
are visible errors, never prompt-only substitutes.

Checkpoint captures pin code tree, parent/base commit, output metadata and
generation; they are not provider-session snapshots. Cleanup is owner-scoped,
receipt-driven and never deletes an uncollected/ambiguous workspace. External
checkouts and branches not created by the recorded operation are never removed.

### Verification and Result completion

An Agent assertion, an independently collected verifier observation, a code
review and a human acceptance are separate records, not trust levels that the
Agent can promote. `VerificationReceipt` is immutable and binds exact
repository/candidate commit, input digest, local profile ID/version/digest,
runner identity, start/end, exit classification and redacted log Artifact.
Raw commands, secrets, provider tool traces and absolute paths stay local.

Only the Bridge verification service or authenticated configured CI adapter may
submit a verified receipt, for an active authorized operation it owns. Agent
Result/MCP channels cannot manufacture verified observations. The threat model
trusts the explicitly enrolled host/runner, not arbitrary Agent-generated JSON;
it does not attest a malicious host or equate a zero exit with semantic quality.
Required verification policy is checked independently of ordinary Result
evidence references. Current human Result acceptance and Task completion stay
with Task/Team Owners; Reviewer Agents contribute claims, not human decisions.

### Integration and repository operations

Integration is a separate explicit authority. A queue serializes by repository
ID and target ref across all enrolled bindings, pins its expected target commit and all reviewed inputs,
constructs a candidate, checks scope and required verification against that
candidate, and updates the target only under an exact-base compare-and-set.
Target movement invalidates the candidate checks; it never invokes an implicit
force update, automatic conflict resolution or a blanket push.

The Core repository adapter implements local integration on the Client/Bridge.
Repository paths, remotes, Git/SSH credentials, fetch/pull/push, worktrees and
Git commands stay under Owner-local authority. Central can approve an opaque
operation and retain its receipt; it cannot execute or credential the Git side
effect.

The delivered remote commit/CI/input observation adapter is retained as an
Optional Remote Evidence Extension under ADR-0039. Remote push, PR creation,
webhooks, remote merge and deployment are paused and excluded from the current
roadmap. They require a new accepted product decision rather than inheriting
authority from this ADR.

Plan completion requires every required node's current accepted Task Result,
its required verification, satisfied edge/input bindings, resolved integration
policy and no active or unacknowledged ambiguous operations. Nodes omitted or
canceled by a new approved plan revision stay visible as history; they cannot
be disguised as successfully delivered work.

### Scoped autonomy and deliberation efficiency

Tech Lead uses explicit propose/revise/cancel-request tools. A delegation grant
may allow a policy engine to adopt only bounded low-risk graph changes: within
the same repository, approved path envelope, existing Agent assignments,
verification floor and remaining budget. Expansion of scope, privileges,
integration targets, budget or acceptance criteria requires renewed human
approval. Replanning is versioned; in-flight Runs retain their old manifests,
and the new revision cannot count incompatible old evidence as current work.

Execution review/test pipelines stay in the graph. Discussion may use focused
participant proposals checked against Room and Task assignments. Selection,
focus questions and excluded participants are frozen before opening a Wave.

Optional soft-deadline/quorum sealing is allowed only for explicitly read-only
Discussion workloads with enforceable read-only participants. Required roles
cannot be waived by response count. A sealed projection freezes the accepted
member set and source sequences. Remaining members retain real Run lifecycle
and cancellation/ambiguity handling; late content enters an append-only
supplemental-evidence record and never edits the sealed projection. A new Wave
cannot reuse an Agent whose old work is still live. Ordinary all-settled remains
the default, and coding never relies on quorum to declare completion.

Late evidence uses a separate capability-negotiated, bounded supplemental
submission with its own operation identity and the original frozen Run/Device
binding. It cannot reopen a terminal Run or bypass its rejected late-event
rules. Current Device/Agent/Room authorization and the sealed Wave identity are
rechecked. Terminal Task Results and accepted plan evidence are never rewritten
by supplemental submissions.

### Public surfaces and compatibility

Web provides a plan editor/preview, dependency and input inspection, exact
version approval, node progress and blocking reasons, workspace/verification
summaries, Result review, integration queue and recovery actions. Workbench
links back to existing Task/Run/Result details rather than duplicating them.
All mutation receipts survive refresh and response loss; late responses cannot
update another selected plan. Agent tools propose/read scoped plans only.

New JSON Schemas are authoritative and generate TypeScript/Go types. Additive
Bridge fields are feature-negotiated; missing support blocks only new governed
work, not ordinary Rooms. Migrations append tables and constraints without
rewriting historical Task Results, Runs, Artifact lineage or default Tasks.
Old clients cannot bypass execution admission or completion gates through
legacy Task/Run APIs.

## Alternatives

- Replace Discussion with an execution workflow engine: loses useful Wave
  semantics and duplicates existing work aggregates.
- Reuse DiscussionTurn as Task or create a second TaskAttempt: rejected because
  conversation membership and bounded execution have existing authorities.
- Parse Agent prose to schedule or merge: rejected because it has no stable
  authorization or retry identity.
- Give a Tech Lead the Owner's credential: rejected; delegated capabilities
  cannot silently become human review or repository administration.
- Add worktrees after automatic coding: rejected; isolation is an admission
  prerequisite, not later polish.
- Treat uploaded test JSON as verified evidence: rejected; content integrity
  does not establish execution provenance or exact candidate coverage.

## Consequences

The change is a meaningful product expansion, not a scheduler-only patch.
Reliable graph execution requires coordinated contracts, Server, Bridge, Web,
Git, verification and recovery work. Initial defaults remain human-approved and
conservative. Explicit unsupported states are preferable to hidden downgrades.
The plan/receipt layer adds storage and review complexity while preserving
observable, versioned authority across crashes and concurrent operators.

ADR-0039 narrows Core completion to the Client/Bridge-owned local path. Optional
Remote Evidence regressions remain required when that retained extension is
changed, but provider availability is not a Core completion condition.

## Compatibility and Security

Every read revalidates Team/Room access; every mutation additionally proves its
actor and expected revision. A graph edge is not a Room membership grant.
Sensitive local data never enters prompts, wire metadata or Room summaries.
Untrusted repository content, CI text and Agent proposals are rendered as data.
Test execution uses locally approved restricted profiles without production
credentials. Independent approvals remain separate across planning, local
execution, Result acceptance, integration and external operations.

## Verification

The detailed requirements and acceptance mapping are maintained in
[Execution Coordination](../modules/execution-coordination.md) and
[Repository Execution](../modules/repository-execution.md). Delivery state is
tracked only in [TASKS](../TASKS.md). The
[design review](../reviews/0036-software-team-design-review.md) records findings
and their design resolutions. Accepted design is not implementation acceptance.
Final acceptance must include
real temporary Git repositories, real Go Bridge processes, actual verification
commands, restart/fault injection, Web-to-Server flows and a direction audit;
schema validation and mocked schedulers alone are insufficient.
