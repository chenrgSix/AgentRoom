# Execution Coordination Module

- Prefix: `EXEC`
- Implementation directory: `apps/server/src/execution/`
- Owns: immutable decisions/plans, approvals, dependency/input bindings,
  dispatch intents and derived graph progress
- Governing decision: [ADR-0036](../adr/0036-add-governed-software-team-execution.md)

## Purpose and Non-goals

Turn an approved software-development plan into existing bounded Task Runs and
verified deliveries. This module does not duplicate Task lifecycle, Run outcome,
Result review, Artifact content, Discussion state or provider sessions. It does
not expose a shell. A top-level Product Task represents the objective.

## Requirement and Acceptance Map

Requirement IDs identify behavior, not delivery status. Only TASKS records state.

| ID | Required outcome | Owning task and decisive evidence |
| --- | --- | --- |
| EX-01 | Decisions and proposals are immutable, attributed and non-executing | EXEC-001, DISC-010; exact source and malformed-output tests |
| EX-02 | Complete versioned DAG validation and atomic child-Task compilation | CON-020, EXEC-001, EXEC-002; cycle/duplicate/rollback/reopen tests |
| EX-03 | Exact-version human approval fences scope, definitions and authority | EXEC-002; stale/foreign/changed-payload response-loss tests |
| EX-04 | Dependencies bind exact upstream outputs and authorized cross-Task inputs | EXEC-006 foundation plus EXEC-003, RUN-018, VER-001 and REPO-002; two-Task/two-Bridge transfer and foreign-scope negatives |
| EX-05 | One dispatch intent creates one ordinary Run under all admission gates | EXEC-004, RUN-018; concurrent schedulers, offline/reconnect and crash cuts |
| EX-06 | Coding uses explicit local grants and isolated workspaces before startup | WSP-003, BRG-071, REPO-001; actual Git and denied-runtime execution tests |
| EX-07 | Verifier receipts are independent from Agent claims and pin exact code | VER-001; actual command plus forgery/profile/tree mismatch tests |
| EX-08 | Integration checks the candidate and compare-and-sets the target | REPO-002; parallel patches, conflict, moved-base and response-loss tests |
| EX-09 | Scoped CI/PR operations reconcile external effects without blind retry | REPO-003; real HTTP adapter with lost responses and target identity checks |
| EX-10 | Web completes proposal, approval, diagnosis, review and recovery flows | WEB-063, WEB-064; real Server browser acceptance at desktop/mobile widths |
| EX-11 | Tech Lead proposals and bounded revisions do not inherit human authority | MCP-007, EXEC-005; assigned/unassigned and privilege/budget drift negatives |
| EX-12 | Focused/quorum discussions preserve frozen evidence and actual Run outcomes | DISC-011, DISC-012; permutation/restart/late-result/role tests |
| EX-13 | Existing Rooms, default Tasks, ordinary Runs and human Result review remain intact | QA-052, QA-053, QA-054; full regression plus legacy-route bypass negatives |
| EX-14 | Final scope and completion evidence match the accepted design | QA-055; requirement-by-requirement direction audit |

### Foundation and Closure Ordering

The accepted-result admission port is an independently testable prerequisite
owned by EXEC-006: atomic input freezing, exact manifests, current authorization,
sealed content reads and destination Artifact provenance. RUN-018 may connect
that port to ordinary Run Delivery without waiting for all graph gate producers.
Unavailable `verified_output` and `integrated_commit` gates remain explicit
errors; accepted Results cannot stand in for their independent proofs.

EXEC-003 retains the full EX-04 outcome after VER-001 and REPO-002 expose their
immutable receipt lookups: gate-specific bindings and actual authorized
two-Bridge materialization through RUN-018. QA-053 depends on that complete
outcome. This ordering breaks the implicit scheduler/integration/input cycle;
it does not mark the full dependency feature complete at the foundation gate,
weaken any approval, or permit dispatch with missing required inputs.

The [foundation audit](../acceptance/exec-006-input-foundation.md) maps the
accepted-result port to current transaction, authorization, sealed-content and
provenance evidence, including both unavailable independent gates and source
drift after scheduling pause. Its real HTTP/SQLite fixtures do not stand in for
the actual RUN-018/EXEC-003 delivery and materialization gates.

## Aggregates and Identities

| Record | Minimum identity and frozen content |
| --- | --- |
| DecisionRecord | decisionId, rootTaskId, sources, item keys, summary, unresolved questions, supersedes |
| PlanProposal | proposalId, revision, digest, author/source, node blueprints, edge/input specification, policy |
| ExecutionPlan | planId, rootTaskId, roomId, ownerMemberId, current revision, execution-control revision |
| PlanRevision | planId/revision, schema version, canonical digest, complete nodes/edges/policy, source proposal |
| PlanApproval | operationId, exact revision/digest, actor, root Task revision, decision, timestamp |
| PlanNode | stable nodeKey, taskId, definition/criteria pins, Agent, repository and verifier requirements |
| PlanEdge | edgeKey, source/target node keys, gate, selected output/input slots |
| NodeMaterialization | plan revision/node/gate, exact source Run/Result/review and canonical checkpoint Artifact pins |
| TaskInputBinding | bindingId, plan revision/edge, source receipt, destination Task/Run, immutable content pins |
| DispatchIntent | plan revision/node/generation, unique Run ID, exact inputs, operation digest |
| PlanControlEvent | operationId, expected execution revision, actor, pause/resume/cancel reason |

Opaque IDs, not names or display numbers, are authoritative. JSON canonicalization
sorts object keys recursively and preserves semantically ordered arrays; nodes,
edges and set-like fields are normalized deterministically before hashing.
Duplicates are rejected, not silently discarded. JSON is finite, bounded and
schema-validated before hashing. Reusing an operation ID with another actor,
target or normalized payload fails instead of returning an unrelated receipt.

## Plan Validation and Compilation

Validation is layered: closed JSON Schema; deterministic graph validation;
current authorization/Task pins; repository and grant capability checks.
Schema validity never claims referential, cycle, approval or permission validity.
Use binary key order for a deterministic Kahn topological ordering. At most 64
nodes, 256 edges and concurrency 8 are accepted. Every required input has one
explicit producer or pinned external input; unresolved mandatory questions block
approval. A node cannot appear twice under different aliases for the same Task.

Draft creation performs no Run dispatch. Compilation is one shared SQLite
transaction over approval, graph rows, canonical child Tasks, criteria and
assignments. Source-result next actions use the existing child provenance port.
New tasks belong to the root Room, have explicit human Owners and assignments,
and use `accepted_result_required` for governed delivery. Existing tasks must
have equivalent completion policy and compatible current criteria.

Human review uses `POST /api/execution-plans/:planId/approvals`; bounded history
uses `GET` on the same path with `afterRevision` and `limit`. One immutable
approved or rejected decision exists per revision. Rejection leaves the plan a
draft with no compiled Tasks or root revision advance; another decision requires
a new plan revision. Approval increments the root Task revision exactly once
without changing its definition, criteria or lifecycle, and advances the plan's
control revision. Both decisions retain an exact response-loss receipt bound to
the actor, operation identity and command; current authorization precedes replay.

New compiled Tasks begin as ordinary `draft` Tasks. Existing Tasks retain their
identity, parent and canonical definition; they require the caller's Task/Team
Owner authority and cannot have active work, unacknowledged unknown outcomes or
another active plan claim. A root also cannot belong to another active plan.
Optional `task.sourceAction` binds one accepted root Result's exact next-action
key and goal through the canonical Result-to-child provenance port. It does not
copy acceptance. Canonical Task text must match the approved blueprint; trimming
must not silently change reviewed content.

Immutable compilation snapshots and mutable current Task claims are separate.
Definition, owner, assignment, workspace or budget changes pause admission and
append a drift event. Human scheduling pause/cancellation also pauses the plan;
historical approval receipts and Task pins remain unchanged. Completion-policy
downgrade cannot remove an active node's execution governance.

RUN-018 establishes the initial owner-dispatched, zero-input governed admission.
The frozen [EXEC-004 Graph Runtime increment](../acceptance/exec-004-graph-runtime-scheduler.md)
reuses that exact manifest/lease/Delivery path for deterministic automatic
admission of one dependency-free implementation node. Review, verification,
dependency materialization and explicit retries remain fail-closed. VER-001 must
still replace the governed Result review/completion fence before any node may be
projected as successful. Approval alone never grants local filesystem or Runtime
capability.

An approved plan has no back door through ordinary Message, handoff, Discussion,
manual MCP, retry, Result completion or compatibility PATCH APIs. All new work
against an actively governed node passes the same execution admission port.
Task definition/assignment edits remain human commands but pause affected plan
admission; an edit cannot invalidate a frozen Run's historical manifest.

## Dependency and Input Semantics

The default edge gate is `accepted_result`. `verified_output` may release a
bounded downstream verifier/reviewer without prematurely completing its source
Task. `integrated_commit` requires a successful exact-candidate integration
receipt. Gate selection is part of human-approved policy, not a runtime guess.
Node success and input readiness are different facts. Failed/canceled/unknown
upstream work blocks required downstream nodes; optional work requires an
explicit approved omission, never an implicit successful status.

Each selected output has a stable slot key and expected kind. A source receipt
pins its exact Result/Artifact/commit. The binding proves source and destination
authorization in the same Room and approved graph. It creates a bounded read
capability for an exact destination Run, not a global Artifact ACL extension.
Staging stays read-only and is not a Workspace apply. Code changes need the
separate local preparation operation described in Repository Execution.

Old source acceptance is not copied into destination claims. New derived
Artifacts stay destination-owned and cite the immutable binding. Existing
same-Task Artifact relation and Result evidence validation remain unchanged.
Revocation prevents new input materialization; frozen receipts still provide
authorized historical diagnosis without disclosing data to removed members.

### Accepted-Result Input Admission

The internal `freezeForRun` port resolves an approved edge or exact external
input to an accepted Result and its sealed canonical Artifact. It must run in
the same transaction as destination Run admission and manifest freezing; a
nested savepoint prevents a caught later insert failure from leaving partial
input grants. Stable Run/slot identities return the original immutable binding
on an exact retry. A frozen manifest cannot acquire new bindings afterward.
The default accepted-result resolver does not stand in for independent
`verified_output` or `integrated_commit` proof resolution. Those gates require
their owning Verification and Repository implementations before admission.

`GET /api/bridge/runs/:runId/execution-inputs/:bindingId/content` checks the
authenticated destination Device, current Room/Team, Task/Agent ownership and
assignment, active Run, expiry, approved plan pins, and the complete identical
Run/Delivery Context Manifest. It verifies the manifest/input digests and the
source's current definition/criteria and accepted review before reading sealed
bytes. Revocation, archived scope, malformed or substituted context and source
drift deny further reads. Content corruption is a safe unavailable response,
not returned bytes. This endpoint has no public grant-creation counterpart and
does not expand the existing same-Task Artifact download endpoint.

The Bridge-internal `ExecutionInputClient` consumes that endpoint only for an
exact schema-valid manifest and the paired Device at the identical Server
origin. It preflights all bindings before any request, preserves manifest order
and currently accepts only repository-matched patch inputs up to the Server's
4 MiB sealed-input limit. Every response must be non-redirected `200`,
`no-store`, `nosniff`, `text/x-diff`, and reproduce the binding ID, declared
length and SHA-256; the client also hashes the actual bounded body. Duplicate,
cross-destination, commit, compressed, truncated, malformed or substituted
content fails closed. The client caches nothing and is not yet constructed by
the production inbox/Handler path.

Initial destination Artifact binding records the Run manifest's supplied input
bindings in the same canonical Artifact/publication transaction. These immutable
records identify provided inputs, not proof that an Agent consumed them or that
the output is correct. They cannot be added to an already-bound Artifact.
Room-authorized history is available at
`GET /api/execution-plans/:planId/inputs/:bindingId` and
`GET /api/execution-plans/:planId/artifacts/:artifactId/inputs` without exposing
storage keys or local paths. Neither provenance nor a read grant accepts a
destination Result, enables a legacy Run, applies code or starts a Runtime.

## Scheduling, Budgets and Recovery

The scheduler is a deterministic application service driven by persisted state,
startup reconciliation and bounded wakeups. It never needs an LLM to decide
that an already-approved dependency is satisfied. Plan-wide Run count/duration
budgets compose with each Task budget; unknown token/cost telemetry stays null.
Queued work consumes reserved capacity so offline Agents cannot overbook a plan.
Released slots derive from actual terminal Runs, not from a UI badge.

Admission validates the plan approval and control revision, Task pins, active
Room/Team, current human ownership/Agent assignments, input receipts, required
runtime capabilities, grant expiry and repository capacity. It atomically
reserves the node generation and creates an ordinary Run using a unique
orchestration identity. Dispatch occurs after commit through existing delivery.

| Crash cut | Authoritative evidence | Recovery |
| --- | --- | --- |
| proposal/approval response lost | operation fingerprint and immutable revision | return exact stored receipt |
| child compilation fails | shared transaction not committed | no partial Tasks/graph/approval |
| dispatch committed before transport | dispatch intent and queued Run | replay existing Run ID |
| workspace prepared before Runtime start | Bridge operation journal | reuse only exact owned prepared workspace |
| Runtime may have started | durable Run/inbox and invocation marker | preserve unknown; no automatic new attempt |
| Run terminal before graph projection | existing Run events and input receipts | recompute, never invent Result acceptance |
| verification response lost | verifier operation and receipt | query/replay receipt; no hidden rerun |
| target/remote mutation response lost | repository intent plus exact ref/PR query | confirm or retain unknown |
| plan revision changes during dispatch | revision CAS and frozen manifest | one winner; old Run remains historical |

Pause prevents new admission but does not pretend to pause a provider process.
Cancel records durable cancellation requests for active Runs and repository
operations. Terminal plan cancellation waits for active operations or explicitly
audited unresolved outcomes. Retrying a failed node uses a new Run ID and
existing ambiguity acknowledgement, never an automatic duplicate attempt.

Canonical repository identity is distinct from a Device's local binding. All
graph references and integration-capacity locks use the authorized logical
repository ID; every dispatch additionally pins the selected local binding.
This prevents two different Bridges from concurrently promoting the same
logical target under separate checkout locks.

### First Graph Runtime Increment

EXEC-004 begins with one bounded vertical slice rather than scaffolding every
future policy. `ExecutionNodeState` is a recomputable Execution-owned projection;
it is not a provider Runtime or a second Run aggregate. The first slice supports
generation 1 of dependency-free, zero-input `implementation` nodes. Incoming
edges, review/verification kinds, required inputs and automatic retries remain
explicit blockers.

`ExecutionNodeProjector` is the sole application mutation path for this
projection. The Scheduler owns candidate order/readiness and asks it to record a
readiness result. Settlement owns interpretation of Run/Result facts and asks it
to record a settled attempt. The node-state repository is CRUD only. This
matches the actual two-source projection inputs without giving either Scheduler
or Settlement ownership of the other's facts.

The scheduler persists an immutable DispatchIntent and ordinary governed Run in
one immediate transaction. Because the existing Run schema still requires a
trigger Message for Context/reply compatibility, the same transaction creates a
zero-mention `system` trace Message. It is an audit projection only: it bypasses
Message routing, is not the Run instruction and holds no dispatch authority.
The approved/current Task goal supplies the instruction and the DispatchIntent
is the unique scheduling fact.

`run.completed` settles the node to `awaiting_result`, never success. Failed,
canceled, expired and outcome-unknown Runs remain bound to their original intent
and cannot create generation 2 automatically. Startup settlement precedes
admission and ordinary Delivery replay; bounded single-flight wakeups cover
state changes. Concurrent Server processes rely on immediate transactions plus
unique plan/revision/node/generation and Run constraints, then reread the winner.

### First Accepted-Result Dependency Increment

EXEC-007 adds no separate materialization engine. A thin read-only
`ExecutionDependencyResolver` maps approved inbound `accepted_result` edges and
retained NodeMaterialization evidence to the existing input `Selection[]` port.
`ExecutionInputService.freezeForRun()` remains the final authority validation
and persistence boundary inside the destination admission transaction.

NodeMaterialization is immutable evidence, not a new transient node state. It
pins the exact generation-1 completed Run, its accepted managed Result and human
review, and canonical checkpoint output Artifacts. A completed node therefore
remains `awaiting_result`; a separate materialization record releases eligible
downstream edges. Governed Result acceptance is allowed only for this exact
canonical shape, never completes the Task and never stands in for independent
verification or integration.

The bounded first edge uses the existing production-supported patch input. The
[frozen acceptance record](../acceptance/exec-007-accepted-result-dependency-runtime.md)
defines the physical A-to-B provenance, restart and concurrency evidence. Commit
bundle preparation, `verified_output`, `integrated_commit` and generation 2
remain fail-closed.

## APIs and Agent Tools

The typed HTTP surface includes Room-scoped proposal/plan listing and creation,
proposal revision and compilation, exact revision approval, plan detail,
pause/resume/cancel, node retry, input inspection, verification and integration
receipt reads. Routes use current Web authentication, Origin protection,
bounded payloads, safe errors, no-store and Team change wakeups.

Agent tools are `team.propose_plan`, `team.get_plan`, and
`team.propose_plan_revision`. They require the assigned Agent's own persisted
Run and current Room access. They cannot directly approve plans, accept Results,
acknowledge ambiguity, expand budgets, grant local permissions or merge code.
Decision finalization is a typed proposal adapter, not a prose parser.

### Draft History Surface and Source Pins

Human draft create/revise commands require the current root Task Owner or Team
Owner and current Room membership. The plan's `ownerMemberId` preserves the
Owner at creation; a later root ownership transfer does not let that historical
Owner retain mutation authority. Agent and Discussion entry points must supply
server-verified attribution through their separately governed adapters, never
an `author` field in a human request. Root Tasks are top-level and non-default.
Multiple alternative drafts may coexist; they confer no execution authority.

| HTTP operation | Resource |
| --- | --- |
| POST human proposal | `/api/tasks/:taskId/execution-plans` |
| GET Room drafts/plans | `/api/rooms/:roomId/execution-plans` |
| GET exact current projection | `/api/execution-plans/:planId` |
| POST append a draft revision | `/api/execution-plans/:planId/revisions` |
| GET immutable revision history | `/api/execution-plans/:planId/revisions` |
| GET immutable decision | `/api/execution-decisions/:decisionId` |
| GET frozen decision-source records | `/api/execution-decisions/:decisionId/sources` |

Listing uses a binary `afterPlanId` cursor; revision history uses an integer
`afterRevision`. Both return a next cursor or null and accept limits 1–50
(default 20). Start a fresh listing on a Room change notification. Every route,
including authorization errors, uses `no-store`. Mutation bodies are at most
512 KiB and use the shared closed command schema. Conflict codes distinguish
operation, root, node and source revision conflicts without echoing input or
SQLite diagnostics. Trusted Web mutations retain the existing Origin check.

`sourceRevisions` is one-to-one with the decision's evidence IDs. Its revision
means the following existing authoritative value, not a new cross-source clock:

| Source kind | Pinned revision and frozen content |
| --- | --- |
| Message | immutable Room sequence and the exact Message content/identity |
| Run event | exact `(runId, sequence)` event; sequence is also the revision |
| Artifact | immutable `artifactRevision`, descriptive metadata and content pins; no bytes or local path expansion |
| Memory | current lifecycle `revision` and its content/state snapshot |
| Discussion | aggregate `version` and policy/progress/state snapshot |
| Result | immutable `resultVersion`, proposal content, sources and claims; no mutable review/acceptance copied |

All sources must exist in the same Room; decision context may refer to another
Task in that Room without granting an Agent cross-Task delivery. Snapshot bytes
are bounded (512 KiB per source, 2 MiB total), hashed and stored atomically with
the proposal. The closed shared response carries `snapshotJson` as canonical JSON
archive text and its SHA-256, not an executable or permission-shaped object.
Once the proposal references its decision, its source set is
sealed against additions as well as edits/deletes. Mutable source changes do
not rewrite old snapshots. Fresh writes require current source pins, whereas
an exact operation replay returns the original receipt after checking current
authority. Subsequent approval/admission must still recheck current authority
and selected inputs; history is not an authorization cache.

Draft repository/grant/profile IDs express requirements only. Persistence does
not claim those local capabilities exist, compile Tasks, dispatch Runs, stage
content, accept Results or execute repository operations. External input
declarations must name an accepted same-Room Result's exact same-Task snapshot
Artifact and content digest, but no input delivery grant is issued here.

## Autonomy Policy

Low-risk delegation is explicit, revocable, versioned and bounded. A candidate
revision may be automatically adopted only when a deterministic comparison
proves it is within the approved repository/path/Agent/budget envelope, does
not weaken criteria or required verification, and does not broaden integration
authority. Otherwise it waits for a human. Policy expiry/revocation stops new
admission. No automatic revision changes existing accepted history.

## User Experience

The Plan surface shows the objective, proposal source, dependency graph,
required inputs and outputs, scope/permissions, verification requirements,
budget and approval diff. Approval clearly names the exact digest/version.
Execution shows node blockers and links to existing Task, Run, Result and
Artifact surfaces. Review and integration are independent actions with explicit
candidate/base identity. Unknown outcomes never appear as retryable success.

Drafts, mutation operation IDs, selection and pending receipts survive refresh
where existing Web recovery infrastructure supports them. Responses are scoped
to plan/revision/request identity. Tests cover unauthorized selection, stale
tabs, changed revisions, response loss, keyboard access, localization and
390/720/1280 pixel layouts. No new global dashboard replaces ordinary Room use.

## Dependencies and Commands

Contracts, Task, Run, Discussion, Workspace, Artifact, Repository, Verification,
Security and shared Persistence. Composition owns cross-module callbacks;
repositories do not import each other's process lifecycle. Delivery tasks live
only in TASKS. Build with `npm run build --workspace @convene-wire/server`;
test with `npm run test --workspace @convene-wire/server` and
`npm run test:e2e`; follow two-space TypeScript and `git diff --check`.
