# ADR-0022: Make Task, Run, and Result the primary work model

- Status: Accepted
- Date: 2026-08-28
- Supersedes: none

## Context

AgentRoom already gives every Run and Discussion one durable Task, scopes native
Runtime Sessions and context revisions to that Task, persists immutable Task
Artifacts and result evidence, supports human clarification, and keeps Runtime
output distinct from the final Room reply. The current browser remains primarily
a Room conversation surface with a selected Task, inline Run presentation, and
Task-scoped Artifact and clarification panels.

The product needs to answer a different first question: what work needs human
attention, what is executing, what evidence was produced, and whether the work
is accepted. Room conversation remains important, but it cannot remain the only
presentation for work lifecycle, execution diagnosis, review, and completion.

The current Task aggregate has `open`, `working`, `blocked`, `review`,
`completed`, and `canceled` states. It has no human Owner, canonical criteria
revision, completion policy, or reviewable Result aggregate. Existing structured
result evidence consists of immutable Artifact references and provenance Memory;
those records must remain canonical rather than being duplicated into a new
Result store.

The current Run state machine deliberately distinguishes transport loss from
execution outcome. Any redesign that replaces `outcome_unknown` with
`connection_lost`, retries an ambiguous attempt, or infers state from the current
connection would regress recovery safety.

## Decision

### Product definitions

**Task** is the durable human-owned work aggregate. It owns the goal, canonical
acceptance criteria, lifecycle, scheduling policy, budget, assignments,
completion Result, and next required action across several bounded Runs and
Discussions.

**Run** is one bounded execution attempt by one Agent on one Device and Runtime.
It owns delivery, accepted execution, ordered events, terminal outcome, and the
exact context and permission manifest used for that attempt. A successful Run
does not complete a Task.

**Result** is one immutable, reviewable submission about a Task. It makes bounded
claims against one exact definition and acceptance-criteria revision and
references existing Run events, Discussion, Message, Memory, and Artifact
evidence. A Result does not copy that evidence, mutate an Artifact, or grant
Workspace access.

**Room** remains the ordered discussion and message authority. Task-linked Room
Messages and existing Clarification records carry human questions and review
comments; the existing **Discussion** aggregate remains multi-Agent
orchestration rather than becoming a second human chat log. **Run Activity**
carries system execution events and provisional output. **Result** carries the
reviewable conclusion. Only a short durable summary links those surfaces back
into the Room timeline.

### Current and target state

| Concern | Current implementation | Target extension |
| --- | --- | --- |
| Task identity | every Run/Discussion already has a Task; every Room has a default Task | unchanged |
| Task lifecycle | one mutable `state` without revision CAS | versioned lifecycle, scheduling state, human Owner, completion policy |
| Acceptance criteria | optional provenance Memory entry | canonical immutable criteria revisions; Memory remains a claim/projection |
| Result evidence | immutable Task Artifacts and typed Memory | immutable Result submission referencing existing evidence |
| Run state | recoverable queued-to-terminal state machine | unchanged; add redacted manifest and diagnostic phase projection |
| Work navigation | Room-first shell and selected Task | Team-scoped Workbench plus Task, Run, Result detail surfaces |
| Completion | Room Member may set a terminal Task state when no work is active | policy-gated human command with revision and optional completion Result |

There is no migration phase in which `run.taskId` becomes nullable. The existing
non-null Task binding and default Task are prerequisites for this decision, not
future work.

### Identity and display references

Opaque `taskId`, `runId`, and `resultId` values remain the only API,
authorization, foreign-key, and idempotency identities. The target allocates a
monotonic `taskDisplayNumber` per Team and may render `TASK-142`; the display
number is unique only inside its Team and is never accepted as an authorization
input. Run and Result labels may use the same presentation-only pattern.

### Target Task aggregate

The target Task core state is:

```text
taskId / taskDisplayNumber
teamId / roomId / optional parentTaskId
title / goal
ownerMemberId
lifecycleState
schedulingState
completionPolicy
criteriaRevision
definitionRevision
taskRevision
priority / optional dueAt
assignments
budgetPolicy / budgetUsageRevision
completionResultId
createdBy / timestamps
```

Priority is the closed `low`, `normal`, `high`, or `urgent` value. `dueAt` is an
optional UTC advisory deadline for attention and ordering; it does not terminate
a Run or bypass that Run's persisted deadline.

Initial lifecycle transitions are:

```text
draft -> ready -> active <-> review
draft | ready | active | review -> canceled
active | review -> completed
```

The exact transition rules are:

- A non-default Task is created as `draft` unless the create request explicitly
  supplies a valid goal, Owner, and the criteria required by its completion
  policy and asks to create it as `ready`.
- `draft -> ready` requires the Task Owner or Team Owner, a non-empty goal, a
  current Owner who belongs to the Room, and at least one required criterion for
  `accepted_result_required`.
- A new Run or Discussion cannot target `draft`. Starting the first authorized
  Run may atomically transition `ready -> active`; an explicit activation command
  may do the same without starting execution.
- `active -> review` is explicit. A proposed Result creates
  `needs_approval` attention but does not silently close concurrent work or
  change lifecycle state.
- A rejected current Result or an explicitly started new Run may transition
  `review -> active` under Task revision compare-and-set.
- `active` or `review` may enter `completed` only through the completion policy
  and only after the active-work and ambiguity fences pass.
- Any nonterminal non-default Task may enter `canceled` only after the same
  active-work and ambiguity fences. Cancellation never deletes Task history.
- `completed` and `canceled` remain terminal. New work uses a follow-up or child
  Task rather than reopening and rewriting accepted history.

The separate scheduling state is:

```text
enabled <-> paused
```

Pausing prevents creation and dispatch of new Runs and Discussions. It does not
pause a provider process or alter an already accepted Run. The human command may
separately request cancellation of current Runs through the existing cancellation
contract. Generic Run pause is not part of this decision.

Every Task mutation carries `expectedTaskRevision`. A successful mutation
increments `taskRevision` exactly once. Goal or canonical criteria changes also
increment `definitionRevision`; title, Owner, assignment, scheduling, priority,
due date, budget, block, review, and lifecycle changes do not. A stale command
returns the current projection and performs no partial update.

### Human ownership and authorization

A Task has exactly one human `ownerMemberId`; Agent assignment is separate.
The Owner must remain a Member of the Task Room. Reassigning ownership requires
the current Task Owner or Team Owner and an expected Task revision. If the Owner
loses Room membership, the Task becomes attention-blocked until a Team Owner
assigns another eligible Member; it does not silently transfer authority.

Product Tasks have an explicit Agent assignment set. Each entry names one
current Room Agent, a `primary`, `contributor`, or `reviewer` role, assigner, and
timestamp; at most one assignment is primary. Task/Team Owners replace the set
under Task revision CAS. New direct Runs and Discussion participants must be
assigned. The permanent default Task retains current compatibility semantics and
may target any eligible Agent in the current Room roster without persisting that
roster as Task assignments. Handoff remains additionally constrained by its
existing Room policy and lineage rules; a Product Task handoff target must also
be assigned.

Initial authority is:

| Operation | Task Owner | Team Owner | Agent principal | Orchestrator |
| --- | ---: | ---: | ---: | ---: |
| Edit goal or criteria | yes | yes | no | no |
| Reassign Task Owner | yes | yes | no | no |
| Replace Agent assignments | yes | yes | no | no |
| Start Run | yes | yes | request only when assigned | policy-controlled |
| Pause scheduling or increase budget | yes | yes | no | no |
| Acknowledge ambiguous Run outcome | yes | yes | no | no |
| Propose Result | yes | yes | yes, from own Run | yes, from owned Discussion |
| Accept or reject Result | yes | yes | no | no |
| Complete or cancel Task | yes | yes | no | no |

Room membership remains mandatory for every operation. Team Owner status never
grants access to a Room from which the Owner could be absent; the existing rule
that every Team Owner remains in every Room preserves that administration path.

### Canonical acceptance criteria

Canonical criteria are an immutable Task-local revision, not free text in the
current Task row. Each criteria change appends one complete `criteriaRevision`
containing ordered rows:

```text
criterionKey
description
required
ordinal
```

An unchanged logical criterion retains its stable Task-local `criterionKey`
across revisions. Editing, adding, removing, reordering, or changing required
status creates a new full revision and increments the Task revision in the same
transaction. Old revisions remain queryable for Run and Result evidence.

The existing long-term Memory type `acceptance_criterion` remains an attributed
claim or collaboration-memory projection. It does not create, edit, satisfy, or
supersede canonical Task criteria. Context planning labels canonical criteria
and Memory claims separately so a Runtime cannot mistake one authority for the
other.

Each Run Delivery pins the `definitionRevision`, `criteriaRevision`, and Task
revision it received. A Result pins the definition and criteria revisions it
evaluates plus the Task revision at proposal time; it cannot claim against a
definition that did not exist when submitted. A Result against a stale
definition or criteria revision remains historical evidence and may retain its
human review, but it cannot become the Task's `completionResultId`. The author
must submit a new Result against the current definition and criteria.

Changing the goal or criteria does not rewrite, cancel, or relabel an already
created Run. Its frozen Delivery remains historical evidence against the pinned
definition. New Runs use the current definition, and any later Result must make
its pinned revision explicit.

### Attention and next action

Attention is a derived set, not a single persisted enum. Initial reasons are:

```text
needs_input
outcome_unknown
needs_approval
result_stale
blocked
overdue
paused
budget_exhausted
runtime_unavailable
result_rejected
```

Their authoritative sources are:

| Attention reason | Source |
| --- | --- |
| `needs_input` | one open Task clarification |
| `outcome_unknown` | one unacknowledged terminal Run with an ambiguous execution outcome |
| `needs_approval` | one or more current-definition proposed Results without decisions |
| `result_stale` | newest proposed Result pins an older definition or criteria revision |
| `blocked` | explicit human block record or missing eligible Task Owner |
| `overdue` | nonterminal Task has passed its advisory `dueAt` |
| `paused` | Task scheduling state |
| `budget_exhausted` | persisted Task budget admission decision |
| `runtime_unavailable` | assigned Agent capability/presence prevents the requested next Run |
| `result_rejected` | newest current-definition Result was rejected and no newer Result exists |

Several reasons may coexist. The Workbench may choose one primary badge using
the fixed priority shown above, but the API returns all reasons with source IDs,
timestamps, and the principal expected to act. `none` is a presentation value
for an empty set, not stored state.

The Task `nextAction` is likewise a server-derived projection naming one of
`member`, `agent`, or `system`, the expected principal when known, a closed
reason, and its source entity. It is not editable prose and does not grant the
named actor permission.

An outcome-ambiguity acknowledgement is a separate audited human command with
the exact Run ID, expected Task revision, bounded reason, and idempotency key.
It does not change the Run terminal state or claim an external side effect did
or did not occur. Retrying an `outcome_unknown` Run requires an acknowledgement
for that exact Run. Task completion or cancellation requires acknowledgements
for every `outcome_unknown` Run in the Task. Either command may atomically record
the acknowledgements it requires.

### Task budget

The first Task-level scheduling budget supports comparable authoritative units:

```text
maxRunAttempts
maxExecutionDurationSeconds
```

Run-attempt usage and duration derived from persisted execution events are
append-only ledger values.
A retry is a new attempt and consumes the ledger. Discussion-owned Wave, member-
slot, finalization-reserve, token, duration, and cost accounting remains under
the existing Discussion budget ledger and is projected into the parent Task
without double counting physical Runs.

Provider token and cost telemetry is not sufficiently uniform to become a hard
Task admission limit in this milestone. If shown, missing telemetry is unknown,
never zero. Budget exhaustion prevents new scheduling but does not mark success,
cancel an already accepted Run, or complete a Task. The Task or Team Owner may
increase the budget through a revisioned, audited command; an Agent cannot.

### Authoritative Run state and diagnostic phase

The existing Run state machine remains authoritative:

```text
queued -> delivered -> working
  -> input_required
  -> completed | failed | canceled | expired | outcome_unknown
```

`transport_lost` or `connectionLost` remains connection metadata. It is never a
replacement for `outcome_unknown`. Delivery and execution phases such as
`sending`, `preparing_context`, `starting_runtime`, `running_tests`, or
`submitting_result` are optional bounded projections from persisted Delivery and
Run events. The Web never reconstructs them from current Agent presence or
invented text, and absence of a phase is displayed as unknown.

A retry always creates a new Run with a new `runId`, `attemptNumber`, and
`retryOfRunId`; it never replays a terminal Run identity. Automatic retry is
limited to the existing unaccepted delivery of the same Run. Creating another
attempt from `outcome_unknown` requires the Task Owner or Team Owner to submit an
explicit ambiguity acknowledgement recorded in audit. It is never automatic.

### Run Context Manifest

Every Run exposes a redacted Context Manifest derived only from its frozen
durable Delivery and authorization snapshot. It includes:

- Task, goal, criteria, Room context, Memory and Artifact revisions;
- exact Message, Artifact, Memory and parent Run identifiers included;
- target Agent, Device, Runtime kind/capability and safe Workspace alias;
- closed filesystem/network/interrupt/handoff and duration summaries;
- explicit categories not sent, such as unrelated Room history, local paths,
  environment values, provider credentials, hidden reasoning, and other
  Workspaces.

It never resolves current live Task, Artifact, Workspace, Agent, or policy state
when rendering an old Run. It contains no prompt-only secret, provider-native
session ID, absolute path, command, environment value, credential, tool input or
output, or hidden reasoning. A legacy Delivery that lacks one field reports
`not_recorded`; the browser does not guess.

### Result aggregate

A Result is split into immutable submission content and append-only review
decisions.

New Result submissions are accepted only while the Task is `active` or
`review`; terminal Tasks and `draft` or merely `ready` Tasks do not accept new
submissions. Existing submissions and reviews remain readable in every state.

`ResultSubmission` contains:

```text
resultId / task-local resultVersion
taskId / roomId
definitionRevision / criteriaRevision / proposedAtTaskRevision
optional supersedesResultId
outcome
summary
risks / openQuestions
nextActions keyed by submission-local nextActionKey
proposedBy principal and timestamp
```

Initial outcomes are `satisfied`, `partial`, `not_satisfied`, and
`informational`. Outcome is a claim by the submitter, not a Task transition.

Every submission has at least one exact in-scope source edge to a durable Run
event, Discussion, Message, Memory entry, or Artifact. An Agent may reference
only events from a Run assigned to that Agent and evidence already authorized
for the same Task. An Orchestrator may reference only its Task-owned Discussion
and events from its child Runs. Member-authored Results still require at least
one authoritative source.

Every source and criterion evidence reference uses a closed kind of `artifact`,
`run_event`, `message`, `memory`, or `discussion` plus the exact existing entity
ID and an immutable submission-local reference ID. A `run_event` additionally
names its durable Run event sequence. The Server resolves and authorizes each
edge at insertion; free-form URLs, copied prose, and mutable browser locations
are not evidence identities.

Criterion claims are stored against the submission's exact criteria revision:

```text
criterionKey
coverage: satisfied | unresolved | not_satisfied | not_applicable
explanation
evidenceRefIds
```

Each `satisfied` required criterion must cite at least one in-scope existing
evidence reference. The Result references canonical Artifact and evidence IDs;
it never copies Blob bytes, changes Artifact lineage, or treats a Runtime reply
as verified merely because it was persisted.

Result content is immutable after insertion. A correction to a proposed or
rejected submission creates a new task-local version with
`supersedesResultId`; the complete old submission and review history remain
queryable and the old version is projected as `superseded`. An accepted Result
cannot be superseded or rewritten. Additional later evidence is a new independent
Result, and a correction after Task terminalization requires a follow-up Task.

Each Result version accepts at most one terminal human review decision:

```text
accepted | rejected
```

The decision records reviewer, expected Task and Result review revisions,
bounded reason, and timestamp. It is append-only and idempotent. `proposed`,
`accepted`, `rejected`, and `superseded` are derived Result states. A temporary
“under review” presentation is not authoritative unless a later milestone adds
an explicit expiring reviewer lease.

Rejecting a Result never edits its content. A later correction is a new Result.
Accepting a Result records human review but does not by itself identify the
Task's completion evidence or prevent another independent Result from being
reviewed. Accepting and completing may occur in one transaction; only a Result
that passes the completion policy becomes `completionResultId`. Response loss
reads back the same Result decision, completion reference, and Task revision.

Result authoring is always explicit. An authorized Member uses the HTTP command;
a manual Agent uses the contract-bound MCP proposal tool; a managed Agent uses
the Device-authenticated Bridge proposal bound to its exact Agent and Run; and
the Discussion Orchestrator invokes the same Task service for its owned
Discussion. Each path supplies one stable operation identity and receives the
same immutable Result on retry. The Server never infers a Result from Run
success, a final reply, output text, or Artifact existence.

A managed or manual Agent proposal must cite an already persisted event from
its own assigned Run. Bridge and MCP are transport principals, not evidence or
completion authorities; the Server revalidates the current credential and Room
scope, frozen Run assignment, pinned revisions, every source, and every evidence
reference before inserting the Result.

### Task completion policies

Initial completion policies are:

| Policy | Completion requirement |
| --- | --- |
| `owner_confirmed` | Task/Team Owner explicitly confirms completion at current Task revision; accepted Result is optional |
| `accepted_result_required` | current-definition Result is accepted, every required criterion is satisfied with evidence, and that Result becomes `completionResultId` |

Both policies require no active Run, Discussion, or clarification and no
unacknowledged `outcome_unknown` Run in the Task. A scheduling pause neither
proves nor prevents completion; the completion event records the prior
scheduling state and terminalizes the Task. Agents and the Orchestrator may
recommend completion but cannot perform it.

Room default Tasks use `owner_confirmed`, remain permanently `active`, and cannot
be completed or canceled. They preserve the compatibility path for ordinary
messages and older clients without manufacturing ceremonial Results. Product
Tasks default to `accepted_result_required`; clients may explicitly choose
`owner_confirmed` for lightweight work.

Parent and child Tasks are lifecycle-independent in this milestone. A child
does not automatically block, complete, cancel, satisfy criteria for, or move
evidence into its parent. An authorized Member may create a child from a Result
next action, but parent completion still follows the parent's own current
definition and completion policy.

An accepted `partial` Result cannot complete an `accepted_result_required` Task
while any required criterion is unresolved or not satisfied. A `not_satisfied`
or `informational` Result never becomes completion evidence. Creating a follow-up
Task is allowed, but it does not silently move, delete, or waive the parent's
criteria. Changing the parent criteria requires a new criteria revision and a
new Result against it.

### Workbench read model

The default authenticated destination becomes **Work**, backed by a Team-scoped
authorized read model. It returns only Tasks in Rooms the principal may access
and supports cursor pagination and stable filtering by Owner, Room, lifecycle,
attention reason, priority, Agent, and update time.

Each row contains only authoritative or explicitly derived state:

```text
opaque Task identity and display number
title / Room / human Owner
lifecycle and scheduling state
all attention reasons and primary badge
current or latest Run
latest Result and whether it matches the current definition
required-criteria coverage
budget usage with unknown telemetry preserved
next action
updated timestamp
```

The default Work view groups **needs human action**, **executing**, **waiting for
review**, **blocked**, and **recently completed**. Counts are query results, not
independent mutable counters. The read model may be cached, but every command
revalidates aggregate revision, authorization, and source state; stale Workbench
data grants no authority.

Task detail opens Overview by default with Goal, current Criteria, execution,
latest Result, open questions, next action, Owner and budget. Runs, Results,
Artifacts, Discussion, and Audit are separate tabs or routes. A Run view renders
the frozen manifest and durable events. A Result view renders submission,
criteria claims, evidence links, risk, questions, next actions, and human review
controls.

### Room interaction

Room chat remains available for discussion and information sharing. A Message
without an Agent target creates no Run. New UI that targets one or more Agents
must select an existing runnable Task or create one before submission. The
existing default Task remains an explicit **quick Room work** choice and the
compatibility fallback for old clients; the Server never creates a hidden new
Task per Mention.

Promoting a Message to a Task records one idempotent source edge and carries its
Room, author, attachments, and selected Agent identities under normal
authorization. Promoting the same Message with the same idempotency key returns
the same Task. An Agent may propose follow-up work only as a keyed `nextAction`
inside a Result; only an authorized Member accepts it into a new Task aggregate.

Creating a follow-up from a Result creates it in the same Room, records the
source Result and parent Task, copies only the Member-selected `nextActionKey`
text into an editable draft, and does not copy acceptance, criteria
satisfaction, evidence authority, Agent
assignments, or completion state. Retrying the same source Result,
`nextActionKey`, and idempotency key returns the same child Task.

Run output deltas and activity never become Room Messages. A terminal Run may
append the existing final Agent reply. Result proposal, acceptance, rejection,
and Task completion append only bounded summary events with links; complete
Result bodies and execution logs remain on their owned surfaces.

### Target HTTP surface

The target API is command-oriented where lifecycle or review authority matters:

```text
GET  /api/teams/:teamId/work-items
GET  /api/teams/:teamId/runs
GET  /api/teams/:teamId/results
GET  /api/tasks/:taskId
POST /api/rooms/:roomId/tasks
POST /api/messages/:messageId/promote-to-task
POST /api/results/:resultId/follow-up-tasks

PATCH /api/tasks/:taskId
POST /api/tasks/:taskId/definition-revisions
POST /api/tasks/:taskId/owner-changes
POST /api/tasks/:taskId/assignment-replacements
POST /api/tasks/:taskId/blocks
POST /api/task-blocks/:taskBlockId/resolve
POST /api/tasks/:taskId/budget-extensions
POST /api/tasks/:taskId/activate
POST /api/tasks/:taskId/pause
POST /api/tasks/:taskId/resume
POST /api/tasks/:taskId/cancel
POST /api/tasks/:taskId/complete

POST /api/tasks/:taskId/runs
GET  /api/tasks/:taskId/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/events
POST /api/runs/:runId/retries
POST /api/runs/:runId/outcome-acknowledgements
GET  /api/runs/:runId/context-manifest

GET  /api/tasks/:taskId/results
GET  /api/results/:resultId
POST /api/tasks/:taskId/results
POST /api/results/:resultId/review-decisions
```

Every mutation carries an idempotency key and `expectedTaskRevision`; Result
review also carries the expected Result review revision. Creation requests use
stable client operation IDs. Lifecycle commands are transactional domain
operations rather than unrestricted state PATCHes. The target PATCH is limited
to title, priority, and due date. Existing broader Task PATCH remains a
compatibility surface during migration but routes through the same definition,
ownership, assignment, transition, completion, and authorization services and
cannot directly force a terminal state.

### Persistence and atomic cuts

Target persistence adds, behind the existing Task aggregate:

```text
task_display_sequences
task_source_edges
task_criteria_sets / task_criteria
task_assignments
task_blocks
task_budget_events
run_outcome_acknowledgements
task_result_sequences
task_result_submissions
task_result_sources
task_result_criterion_claims
task_result_evidence_refs
task_result_review_decisions
```

These atomic boundaries are mandatory:

1. Task create allocates display number, optional Message/Result source edge,
   Owner, lifecycle, completion policy, initial definition and criteria
   revisions, assignments, and Task revision together.
2. Goal edit advances the definition and Task revisions together. A criteria
   edit also appends the complete criteria set and advances the criteria
   revision in that transaction.
3. Run creation validates Task lifecycle/scheduling/budget, records budget
   admission and any required ambiguity acknowledgement, captures
   Task/definition/criteria/context fences, creates Run and Delivery, and
   advances Task execution projection in one transaction.
4. Result proposal allocates its monotonic Task-local version and inserts
   immutable content, sources, claims, evidence links, and attention wakeup
   together.
5. Result review inserts one terminal decision and may assign
   `completionResultId` and complete the Task together when the policy passes.
6. Response-loss retry reads the same operation identity; it never creates a
   second source edge, definition or criteria revision, ambiguity
   acknowledgement, Run attempt, Result version, review decision, or completion
   event.

The Workbench is a rebuildable projection. Task, Run, Result, Artifact, Message,
Memory, Discussion, budget, and review rows remain authoritative.

### Migration

The migration preserves all existing Task and Run identities and never creates
fictional Results.

Existing Task state maps as follows:

| Existing state | Target state |
| --- | --- |
| default Task in any nonterminal state | `active`, `owner_confirmed`, nonterminal forever |
| terminal default Task | preserved as terminal ordinary history; a new active default Task is created without moving old Messages or Runs |
| `open` with existing Run/Discussion history | `active` |
| `open` without execution history | `ready` |
| `working` | `active` |
| `blocked` | `active` plus explicit migrated block record |
| `review` | `review` |
| `completed` | `completed`, `owner_confirmed`, no fabricated accepted Result |
| `canceled` | `canceled` |

The existing creator becomes Task Owner when still eligible in the Room;
otherwise the deterministic oldest current Team Owner becomes Owner and the
migration records that fallback. Within each Team, existing Tasks receive stable
display numbers ordered by `(createdAt, taskId)`; the sequence resumes after the
largest allocated value. The current primary Agent becomes the primary
assignment when eligible. Distinct Agents found in historical Runs or
Discussions become contributor assignments without re-enabling a disabled Agent
or changing Room membership. The active default Task continues to derive its
eligible Agent set from the current Room roster instead of materializing those
assignments.

Existing goal state initializes definition revision zero; an empty criteria set
initializes criteria revision zero with no required criteria and
`owner_confirmed` completion. Existing Artifact, Memory, Run, Discussion,
clarification, context, and Runtime Session revisions remain unchanged.

New Results may reference old evidence. Historical completed Tasks are labeled
`legacy_completed_without_result`; the label is a compatibility projection, not
a synthetic Result or a claim that a current definition and criteria were
reviewed.

## Alternatives

- Keep Room as the only primary surface: rejected because work attention,
  execution, evidence review, and acceptance remain hidden inside conversation.
- Treat every final Agent reply as a Result: rejected because a reply is not a
  structured claim, may lack criteria/evidence, and may be provisional or unsafe.
- Require an accepted Result for the permanent default Task: rejected because it
  turns compatibility and lightweight chat into ceremonial workflow.
- Store one mutable Result row with a mutable status: rejected because content,
  versioning, review decisions, and audit authority would be conflated.
- Replace Artifact and Memory evidence with Result-owned copies: rejected
  because duplicate authorities would diverge and break lineage and cursor
  recovery.
- Persist one `attentionState` enum: rejected because several independent human
  and system actions may be required simultaneously.
- Add `connection_lost` as a Run state or retry it automatically: rejected
  because transport loss does not prove whether the provider executed.
- Add generic Runtime pause: rejected because Codex, Pi, and Generic processes do
  not share a trustworthy pause/resume contract.
- Use provider token or cost estimates as a universal hard Task budget: rejected
  until comparable complete telemetry exists; unknown usage must not become zero.

## Consequences

- AgentRoom's primary information architecture moves from conversation-first to
  work-first while preserving Room discussion and backward-compatible routing.
- Current Task, Run, Artifact, Memory, Discussion, delivery, and Runtime Session
  investments remain authoritative and become more visible.
- Versioned Task definitions and criteria, human ownership, explicit Agent
  assignments, ambiguity acknowledgement, Result review, budget admission, Team
  Workbench queries, and migrations are new domain work.
- Existing unrestricted Task PATCH semantics must be narrowed behind revisioned
  commands before Result-gated completion is trustworthy.
- A first-class Result introduces deliberate review ceremony only for Tasks whose
  completion policy requires it.
- UI counts and progress become evidence-backed projections rather than guessed
  percentages or independently mutable dashboards.

## Compatibility and Security

Old clients continue routing Messages and Runs through the Room default Task.
They may read legacy Task states during a rolling window, but terminal writes
must pass the new service rules. New fields are additive on public reads until
the target API version is required. No Server or Bridge protocol removes
`outcome_unknown`, Task binding, Artifact cursor, or context-fence fields.

Result creation and review require exact Room membership and Task scope. Source,
criterion, evidence, Run, Discussion, Message, Memory, Artifact, reviewer,
Owner, and completion-Result identities are all cross-checked in one Team and
Room. Agent and Orchestrator proposal authority is narrower than human review
authority. A display number, Agent prose, Result outcome, Workbench next action,
or cached attention flag grants no permission.

Result summaries, risks, questions, criterion explanations, Messages, Runtime
output, and Artifact previews are untrusted content. Existing redaction and safe
rendering boundaries apply before durable persistence and presentation. Result
and Context Manifest APIs never expose credentials, provider-native sessions,
hidden reasoning, commands, tool payloads, absolute paths, Blob storage keys, or
local policy details beyond the existing closed summary.

## Verification

- Migration preserves every Task/Run/Discussion identity, deterministically
  allocates display numbers and assignments, and maps every old Task state
  without fabricating a Result.
- Every new Run remains Task-bound; default Task compatibility works for old
  clients while new UI requires an explicit Task or quick-work choice.
- Task lifecycle, scheduling, ownership, budget, criteria, completion, and
  terminal fences reject stale revisions, duplicates, unauthorized principals,
  active work, and cross-Room identities.
- Multiple simultaneous attention reasons and next actions rebuild identically
  from reopened SQLite and never grant command authority.
- A Run Context Manifest after restart matches the exact frozen Delivery and
  reports absent legacy fields as unknown without resolving current live state.
- Delivery retry retains one Run; user retry creates a new linked attempt; an
  `outcome_unknown` attempt cannot rerun, and its Task cannot become terminal,
  without the required audited human acknowledgement.
- Result proposal response loss converges on one immutable version with exact
  sources, definition/criteria revisions, claims, and evidence links across
  Member HTTP, manual-Agent MCP, managed-Agent Bridge, and Orchestrator paths.
- Result content cannot be edited; rejection and correction retain the old
  version; concurrent accept/reject or accept/criteria-edit races allow exactly
  one revision-consistent outcome.
- `accepted_result_required` completion fails for a stale definition or criteria
  set, unresolved or evidence-free required criteria, active work or an
  unacknowledged ambiguous outcome,
  `not_satisfied`/`informational` outcome, rejected Result, or foreign reviewer;
  accept-and-complete response loss returns one decision and Task.
- `owner_confirmed` and permanent default Tasks retain lightweight behavior
  without weakening formal Task policy.
- Workbench pagination and filters expose only authorized Rooms and show no
  invented percentage, zero-valued unknown telemetry, local path, or credential.
- Room summaries link to Run and Result surfaces without duplicating provisional
  output, complete Result bodies, or review actions.
- Deterministic service, SQLite reopen, HTTP, MCP, managed Bridge, Web, and E2E
  tests pass; isolated browser acceptance covers desktop and narrow-screen Work,
  Task, Run, Result, review, attention, stale-state, and accessibility flows.
