# Task Collaboration Module

- Prefix: `TASK`
- Implementation: `apps/server/src/task/`, migrations
  0024/0026/0027/0028/0029/0030/0031/0032/0033/0034/0037/0038/0043/0045, and the Web Room
  composer
- Owns: Agent Task identity, Task lifecycle, shared Task memory projections,
  and structured result evidence

## Purpose

Task Collaboration models one durable piece of work across multiple bounded
Runs. A Room remains the shared conversation and event authority; a Task tells
the control plane which Runs, Discussions, Agent assignments, Runtime Sessions,
and results belong to the same longer-lived goal.

## Core State

| Entity | Required State |
| --- | --- |
| AgentTask | taskId, Team display number, roomId, parentTaskId, title, goal, human Owner, lifecycle/scheduling/completion policy, Task/definition/criteria revisions, assignments, budget, completion Result, summary, memory/artifact revisions, lastRoomSequence, creator, timestamps |
| Logical Task Session | taskId, agentId, Runtime scope ID derived from runtime kind/workspace/config fingerprints/schema version, acknowledged consumed cursors |
| Task memory projection | taskId, source Room cursor, summary revision, provenance |
| Rolling Room checkpoint | immutable parent, contiguous input interval, through sequence, summary, provenance/digest, prompt/model version, build kind |
| Rolling Room state | mode, latest and desired through sequences, latest checkpoint, generation, lease, bounded failure projection |
| Long-term MemoryEntry | memoryId, Room/Task scope, typed content, active/superseded/retracted state, scope revision, supersession link, Message/Artifact/Run/Discussion provenance, Member author, timestamps |
| ArtifactRef | artifactId, taskId, artifactRevision, type, workspaceRef, repository/path/commit/branch metadata, content mode and optional sealed content/publication identity, title, summary, creator, optional sourceRunId, timestamp |
| ArtifactRelation | relationId, source Artifact, target Artifact, type, creator, timestamp |
| TaskClarification | clarificationId, taskId, requestingRunId, targetAgentId, question/choices, question and answer Message IDs, continuationRunId, state, terminal reason, timestamps |

The authoritative lifecycle is `draft`, `ready`, `active`, `review`,
`completed`, or `canceled`; scheduling is independently `enabled` or `paused`.
The former `open`/`working`/`blocked`/`review`/`completed`/`canceled` field is a
rolling-compatibility projection only. A Task state is explicit aggregate
state; one successful Run does not automatically complete a Task. Parent Tasks
provide hierarchy without changing Run or delivery semantics.

The Server exposes membership-authorized Room Task list/create operations and
an update operation by Task ID. Every Room has one non-removable default Task
for backward compatibility. A Task cannot enter a terminal state while it has
an active Run or Discussion, and new routed Messages are rejected atomically
when their Task is already terminal.

## Versioned Work Aggregate

[ADR-0022](../adr/0022-make-task-run-and-result-the-primary-work-model.md)
is implemented by migration 0043 and the Task repository/service without
weakening the existing Run binding, Artifact,
Memory, context, or recovery contracts. The target adds a human Owner, monotonic
Task revision, presentation-only Team display number, `draft`/`ready`/`active`/
`review`/`completed`/`canceled` lifecycle, independent enabled/paused scheduling,
completion policy, canonical criteria revision, Task budget ledger, completion
Result reference, explicit Product-Task Agent assignments, and derived
attention/next-action projection. Goal and criteria form a separately versioned
Task definition so unrelated ownership, scheduling, budget, review, or display
changes do not invalidate current execution evidence.

Migration history and target state remain distinguishable. Existing
nonterminal default Tasks become permanently active `owner_confirmed`
compatibility aggregates and cannot complete or cancel. A terminal historical
default remains terminal ordinary history while migration creates a new active
default without moving old Messages or Runs. Existing `open` Tasks with execution
history become active; untouched `open` Tasks become ready; `working` becomes
active; `blocked` becomes active plus an explicit block record; historical
terminal Tasks remain terminal without a fabricated Result.

Every Task mutation uses `expectedTaskRevision` and one idempotency identity.
Goal, Owner, criteria, Agent assignments, scheduling, budget, lifecycle,
completion Result, and completion commands advance exactly one revision or
return a conflict without a partial write. New UI cannot route work into a
draft, paused, budget-exhausted, or terminal Task. Older clients retain the Room
default Task, but a compatibility PATCH cannot bypass the same transition and
completion service.

Non-default Product Tasks carry an explicit set of current-Room Agent
assignments with `primary`, `contributor`, or `reviewer` roles and at most one
primary. New direct Runs, Discussion participants, and handoff targets must be
assigned in addition to satisfying existing Room and handoff policy. The
permanent default Task instead derives eligible Agents from the current Room
roster for compatibility and does not persist that roster as Task assignments.

### Canonical criteria

Canonical acceptance criteria are complete immutable Task-local revisions. Each
ordered row has a stable `criterionKey`, description, required flag, and ordinal.
Editing any row appends a new full criteria revision in the same transaction that
advances the Task definition, criteria, and aggregate revisions. Goal changes
advance the definition and aggregate revisions without fabricating a criteria
revision. Old revisions remain available to frozen Runs and Results.

The existing long-term Memory type `acceptance_criterion` remains an attributed
claim or context projection; it is not the canonical criterion table and cannot
silently edit or satisfy it. Context Planner labels the two sources separately.

### Result submission and review

New submissions are admitted only for `active` or `review` Tasks; other states
retain readable history but accept no new Result content.

A target Result contains immutable summary, outcome, risks, questions, next
actions with stable submission-local keys, exact definition/criteria revisions,
proposal-time Task revision, submitter, and a task-local version. It has at least
one in-scope source edge to a durable Run event, Discussion, Message, Memory
entry, or Artifact and stores criterion claims plus references to existing
evidence. Source and evidence kinds are closed and resolve exact existing IDs;
Run events additionally pin their durable sequence. It never copies Artifact
bytes or replaces Artifact lineage, Room Messages, Memory, Run events, or
Discussion output as evidence authority.

Result content never changes. A correction to a proposed or rejected submission
creates a new version that supersedes the old submission. An accepted Result is
never superseded or rewritten; additional evidence is a new independent Result.
One version accepts at most one append-only human
`accepted` or `rejected` decision. Proposed, accepted, rejected, and superseded
are derived states. Agents may propose a Result from their assigned Runs;
Discussion Orchestration may propose one from its owned Discussion; only the
human Task Owner or Team Owner may review or complete.

Member HTTP, manual-Agent MCP, managed-Agent Device/Bridge, and Discussion
Orchestration proposals all enter the same idempotent Result service. A manual
or managed Agent must cite a persisted event from its own assigned Run. No
transport path infers a Result from Run success, final prose, streamed output,
or Artifact existence.

An accepted completion Result must target the current definition and criteria
revisions and bind every required satisfied criterion to at least one existing
in-scope Artifact evidence record. Result acceptance and Task completion may commit
together, and only a Result that passes the completion policy becomes the
Task's completion reference. A `partial` Result can complete only when every
required criterion is satisfied; `not_satisfied` and `informational` never do.
A stale, rejected, evidence-free, or foreign-scope Result remains useful history
but cannot complete an `accepted_result_required` Task.

Initial completion policies are `owner_confirmed` and
`accepted_result_required`. Both fence active Runs, Discussions, and
clarifications plus every unacknowledged `outcome_unknown` Run in the Task. The
audited human ambiguity acknowledgement preserves that terminal state and never
asserts whether an external side effect occurred. Task budget
initially governs comparable persisted Run count and execution duration only;
unknown provider tokens or cost remain unknown and are not hard Task admission
units.

### Attention projection

Attention is rebuilt as a set from authoritative sources: open clarification,
unacknowledged ambiguous Run outcome, current proposed Result, stale proposed
Result, explicit block or missing Owner, advisory overdue time, paused
scheduling, budget admission, unavailable Runtime, and rejected latest Result.
Several reasons may coexist. A Workbench primary badge follows a fixed priority
but does not collapse, persist over, or grant authority beyond those sources.

## Ownership and Boundaries

- Every Run belongs to exactly one Task. A Mention still creates a bounded Run;
  it does not turn the Task itself into an execution attempt.
- A Discussion may belong to a Task, and only one nonterminal Discussion may
  exist per Task. Independent Tasks in the same Room may discuss concurrently.
- Room Messages remain ordered by the Room sequence. Messages may be general
  Room conversation, but a Message that routes execution identifies the Task
  used by every resulting Run.
- Handoff and Discussion child Runs inherit their parent Task. Agents cannot
  move a Run to a different Task through reply text or Bridge output.
- Parent and child Tasks remain lifecycle-independent. A Result next action may
  create one idempotently linked draft child only when an authorized Member
  accepts it; no criteria, evidence authority, assignment, acceptance, or
  completion state is copied into the child.
- Agent-native session IDs, provider history, hidden reasoning, tool records,
  and local paths remain on the Bridge. The central Server owns only the
  logical Task Session scope and safe disposition/cursor metadata.
- The Bridge session key includes workspace/configuration fingerprints and a
  local schema version. Its owner-only binding advances the consumed Room
  cursor only after the native Runtime accepts the turn; a failed cut therefore
  repeats context rather than skipping unseen history.
- The Bridge publishes only a deterministic hash of that Runtime scope. The
  Server keys result-evidence consumption by Task, Agent, and scope hash; no
  workspace path, native session ID, or local configuration crosses the wire.
- Workspace and Artifact references are identifiers and verification metadata,
  not a central shared filesystem or permission grant.
- Task clarification is missing domain context, not local authorization. Its
  answer is a Room Message; the Server owns no Runtime approval operation.

`TASK-003` stores immutable ArtifactRefs for commits, branches, files, patches,
test results, and documents. Member HTTP and authenticated manual-Agent MCP
writes use the same Task/Room authorization; an Agent may cite only a Run
assigned to itself. File-like references must be workspace-relative, commit
hashes and branches are syntactically bounded, and no Artifact operation reads
or transfers the referenced content. Each successful append advances one Task
artifact revision atomically.

`ADR-0015` extends that same canonical record; it does not add another Artifact
aggregate. Existing records have `contentMode=reference_only`. A new
content-bearing record has `contentMode=snapshot_blob` plus immutable
publication ID, content ID, size, media type, and SHA-256 metadata at insertion
time. A durable
publication operation and sealed Blob remain invisible until one immediate
transaction inserts the canonical Artifact, advances the existing Task artifact
revision, and marks the publication bound. An existing Artifact is never
mutated to attach later content.

Migration 0037 enforces both sides of that bind. A snapshot Artifact must name
one unique sealed publication with the same Task, Room, Run, Agent, Workspace,
type, file name, media type, size, digest, and Team-scoped content. The inverse
publication transition accepts only that exact canonical Artifact. Reference-
only Artifacts preserve their existing shape and cannot claim Blob metadata.

Migration 0038 makes Artifact lineage part of the same canonical append. A
newly produced Artifact may `derives_from`, `reviews`, or `verifies` an older
Artifact in the same Task and Room. Artifact B and its normalized, bounded
relations are inserted in one immediate transaction, so B still advances the
ordinary Task artifact revision exactly once and no observer can see B without
its lineage. Relation creator and timestamp equal B's creator and timestamp;
the source, target, type, scope, and provenance cannot be updated or deleted.
There is deliberately no post-hoc relation API and a text reply does not
substitute for the lineage record.

## Shared Memory

Room history and Task events are authoritative. Room and Task summaries are
bounded, rebuildable projections with a source cursor and revision; they never
replace Messages, Runs, decisions, or ArtifactRefs as evidence.

The `TASK-002` Context Planner builds an extractive baseline rather than
claiming inferred facts: each projection names its source cursor and up to 16
authoritative Message IDs, while the Task projection also carries the explicit
title, goal, and state. It selects at most 12 recent Room Messages and 18 recent
Task Messages, de-duplicates them in Room order, and keeps the current request
as the separate Run instruction. Identical inputs retain the same revision;
changed source or Task state advances it.

Canonical Room and Task projections advance only when their source cursor is
monotonic. Planning an older delayed Run produces an explicitly historical,
Run-local projection: it is delivered as quoted context but neither replaces
the canonical row nor advances the Bridge's consumed canonical revision.

`ADR-0014` adds a separate rolling layer without changing that extractive
contract. Immutable checkpoints prove only that contiguous Message input was
processed from sequence 1 through their cursor. A mutable per-Room scheduler row
owns enablement, backfill, latest and desired cursors, and an expiring worker
lease. Old Rooms remain disabled or backfilling until the checkpoint chain is
continuous; the existing extractive projection remains the fallback and never
masquerades as rolling coverage.

Reduction stays disabled unless the deployment supplies a
`MemoryReducerRunner`. `AGENT_ROOM_MEMORY_REDUCER=extractive-v1` opts into the
bounded extractive baseline: the Server enables Room scheduler rows, scans the
durable desired watermark, leases one Room at a time, redacts input before the
runner, and commits only contiguous validated output. The extractive baseline
is operational evidence for recovery and coverage, not a semantic-quality
claim; richer runners use the same port and must pass separate quality gates.

For a trigger at Room sequence `S`, the Server builds a session-independent
bundle from one checkpoint through `K`, raw context Messages `K+1..S-1`, and
the separate current request at `S`. The Bridge, which alone knows the local
native Session cursor and disposition, derives the actual consumption interval.
It either projects that interval completely or rejects the Run before Runtime
invocation. A successful local receipt advances only to the coverage accepted
by the provider, not blindly to the trigger sequence.

A Run captures Room/Task Memory, Artifact, Task-state, and Room-sequence fences
when its routing intent is created. Delayed planning selects only checkpoint and
revisioned context available at that fence. Evidence records remain
authoritative records of claims and events; an active Member-approved
`MemoryEntry` is the canonical shared assertion, while a rolling checkpoint is
always lossy non-authoritative context.

Migration 0032 adds a separate long-term provenance layer. Room entries are
typed as `decision`, `constraint`, `fact`, `open_question`, or `convention`;
Task entries are `goal`, `acceptance_criterion`, `plan`, `progress`, `blocker`,
`decision`, or `result`. Every entry requires at least one in-scope Message,
ArtifactRef, Run, or Discussion ID. Content and provenance are immutable;
Members may replace one active entry with a linked successor or retract it,
while the old record remains queryable as `superseded` or `retracted`. Runtime
or LLM output may suggest a candidate through normal Messages, but it does not
become shared truth without an authenticated Room Member promotion.

Migration 0034 stores those suggestions as non-authoritative candidates linked
to the producing rolling checkpoint and exact source interval digest. The
Server revalidates Room/Task scope, type, Message provenance, content bounds,
and redaction independently of the checkpoint commit. Exact reducer retries
deduplicate by a stable source fingerprint. Room Members may list, accept, or
reject a pending candidate; acceptance calls the same `LongTermMemoryService`
validation as a manual write and atomically records the resulting Memory ID.
Review is a one-way pending transition, so it cannot silently overwrite either
an accepted assertion or retained rejection evidence.

The Room UI presents pending candidates in a separate non-authoritative review
surface with scope, type, source Message IDs, and checkpoint provenance. A
candidate insert publishes a Room change hint so asynchronous reducer output
converges in open clients. Accept and reject controls use the transactional API
and remove a card only after the Server returns its reviewed state; review
failure reloads the pending list without disturbing the Room timeline.

Member-authorized Room and Task HTTP APIs expose revision-cursor reads,
creation, supersession, and retraction. Context planning selects at most 16
active entries per scope by stable type priority and revision, plus the newest
8 lifecycle tombstones. `activeComplete` says whether the active snapshot is
complete; when false, omitted entries may remain active and the prompt states
that explicitly. This is a bounded retrieval/compaction contract, not a free
text summary: users compact by superseding or retracting evidence, and the full
revisioned ledger remains available through the API.

A new native Session receives bounded Room memory, Task memory, relevant recent
events, result evidence, and the current request. A resumed Session receives
only Room events after its last consumed cursor, Task-memory/result revisions
it has not consumed, and the current request. The Bridge prompt labels every
projection and Message as quoted, untrusted collaboration context.
The Bridge independently tracks Room and Task long-term Memory scope revisions.
It projects changed snapshots with lifecycle and source IDs, labels them as
claims rather than instructions, and treats a complete active snapshot as the
replacement for previously projected Memory state.
On a new Runtime scope, the newest 20 ArtifactRefs form a bounded bootstrap
page in ascending artifact-revision order. After the Bridge confirms that page
in a Run status, later deliveries start strictly after the durable consumed
revision and carry at most 20 consecutive references plus `hasMore`. The Server
accepts only the exact `throughRevision` found in that Run's durable Delivery;
forged, skipped, stale-scope, and out-of-order acknowledgements cannot advance
the cursor. Artifact summaries are claims to verify against the named
workspace evidence, not proof that a commit, test, or file exists.
Each projected ArtifactRef includes its canonical relation IDs, closed type,
and target Artifact IDs. A relation may target evidence outside the current
bounded page; its opaque target ID preserves lineage without expanding or
silently reordering the result-evidence cursor.

For a content-bearing Artifact, Context Planner projects only the sealed content
identity already bound to the canonical record. Run Orchestration freezes that
identity, size, media type, and digest into the existing durable Delivery
payload when the target Agent supports isolated materialization. The descriptor
also contains an `artifact://<artifactId>/<safe-basename>` alias; the basename
is constrained at publication and never contains a source or staging path.
Live publication state is never resolved during a retry. A legacy target keeps
the same ArtifactRef without a content descriptor. The Bridge must stage
required content before invoking the Runtime, while the existing Runtime
acceptance receipt remains the result-evidence cursor advancement point.

## Human Clarification

A managed Runtime may end a bounded ordinary Run with one structured Task
clarification. The question becomes an Agent-authored Room Message and a
membership-authorized HTTP read exposes its `waiting` state. The Web renders
the question above the composer, labels it as Task information rather than
permission approval, and offers bounded choices or a free-form answer.

Answering appends one member Message under the question and creates one
continuation Run for the same Agent and Task. That Run resumes the existing
Task Session through the normal `resume_or_start` delivery contract. The
clarification record links both Runs and both Messages, so retries and recovery
retain evidence without pretending that one Run stayed alive across a human
pause.

A clarification remains `waiting` only while its requesting Run is
`input_required`, before that Run's deadline, and while its Task, Agent, Room
assignment, and question Message remain valid. Direct user cancellation closes
the Run without sending a redundant Runtime interrupt. Migration 0031 closes a
waiting record whenever its Run becomes terminal, and startup/list/answer
reconciliation expires deadlines or converges unavailable/orphaned scope to a
reasoned `canceled` record. A canceled question cannot create an answer Message
or continuation Run.

## Migration and Compatibility

Existing Runs and Discussions are assigned to one recoverable default Task per
Room. New Rooms receive the same default so older clients may continue sending
messages before they expose Task selection. Current clients send an explicit
Task for new work and allow users to create or select another Task.

Migration 0043 deterministically maps old lifecycle values, gives every Task a
Team-local presentation number and human Owner, creates initial immutable
definition/criteria revisions, migrates non-default primary Agents to explicit
assignments, turns old `blocked` into an active Task plus an open block record,
and backfills comparable Run-attempt/duration budget usage. A terminal
historical default is demoted without moving any Message, Run, Discussion, or
evidence; a new permanent active default is created for the Room. Database
triggers protect that default, validate Task Team/Room/Owner identity, and
account new Run attempts and terminal duration in the same Run transaction.

Migration 0045 implements Result authority as immutable Task-local versions,
closed exact source edges, criterion claims and evidence links, append-only
single review decisions, and Result-to-child Task source edges. Proposals and
reviews advance the Task revision exactly once; response-loss retries return
the original Result/version/review/task revision. Database triggers protect
proposal content, evidence, claims, decisions and child provenance from update
or deletion and reject stale/foreign completion references.

The old PATCH endpoint remains a bounded compatibility adapter over the same
repository transition and active-work fences. New definition, control, block,
and block-resolution endpoints require an explicit operation ID and expected
Task revision. Immediate response-loss retries converge without a second
mutation; a different stale operation conflicts. Non-default execution,
Discussion and handoff targets must be explicitly assigned, while the default
Task deliberately derives eligible Agents from the current Room roster.

Bridge Task Session fields roll out additively. During the transition, a new
Bridge accepts a legacy Room-scoped request and a new Server tolerates a Bridge
that does not report session disposition. A Task-scoped binding never falls
back to a previous Room-scoped native session, because that would reintroduce
cross-task context.

## Security and Verification

- Task reads require Room membership. Definition, lifecycle, scheduling and
  block mutations require the Task Owner or Team Owner, use revision CAS, and
  validate the human Owner and every assigned Agent against the current Room.
- Cross-Room parent Tasks, Agents, Runs, Discussions, and ArtifactRefs are
  rejected.
- Absolute host paths, parent traversal, credential-bearing repository URLs,
  malformed commit hashes, and invalid Git branch references are rejected
  before Artifact persistence.
- Existing migration data remains reachable and does not duplicate execution.
- Two Tasks in one Room and Agent resolve to different native Sessions.
- Runtime semantic configuration changes create a new native Session without
  deleting or exposing the old provider session.
- Cursor tests prove resumed prompts do not repeat already-consumed Room
  Messages and never skip a committed delta that is present in the delivery.
- Result-evidence tests prove bootstrap ordering, multi-page continuation,
  scope rollover, durable-delivery acknowledgement fencing, and Bridge-local
  rejection of a discontinuous page.
- Summary and Artifact consumers can trace claims back to authoritative source
  events or external workspace evidence.
- Long-term Memory tests prove an early decision survives beyond the recent
  Message window; cross-Task and provenance-free writes fail, supersession and
  retraction remain visible, and a truncated active selection is explicit.
- Candidate tests prove reducer retry dedupe, independent validation, Member-
  only review, redaction, atomic promotion through shared Memory validation,
  idempotent acceptance, and durable rejection without checkpoint rollback.
- Clarification answer retries converge on one Message and continuation Run;
  cancellation, deadline expiry, unavailable Agents, and orphaned scope close
  waiting records durably; Bridge restart replays only a still-valid question
  without re-executing the suspended Run.
- Permission-shaped fields are rejected by the wire contract, and interactive
  local Runtime requests never reach the clarification API.

## Task Mapping

`TASK-001` through `TASK-013` implement Task continuity, Memory/Artifact
evidence, versioned ownership, criteria, completion policy, scheduling,
assignment, budget, attention, and immutable Result submission/review.
`BRG-044` adds the managed Device-authenticated proposal transport; `MCP-006`
still owns the manual Agent proposal and assigned-work tools.
Wire and Runtime work remains in `CON-007`, `CON-009`, `ADP-012`, and `ADP-013`,
clarification in `RUN-009`/`RUN-010`, and structural cleanup only after those
behavioral milestones.

## Dependencies

Contracts, Team/Room, Registry, Persistence, Security, Workspace Coordination,
and Artifact Content Transport. Run and Discussion
Orchestration consume Task identity but keep ownership of execution state.
