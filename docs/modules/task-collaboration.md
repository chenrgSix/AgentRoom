# Task Collaboration Module

- Prefix: `TASK`
- Implementation: `apps/server/src/task/`, migrations 0024/0026/0027/0028/0029/0030/0031/0032/0033/0034, and the Web Room
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
| AgentTask | taskId, roomId, parentTaskId, title, goal, state, primaryAgentId, workspaceRef, summary, memory/artifact revisions, lastRoomSequence, creator, timestamps |
| Logical Task Session | taskId, agentId, Runtime scope ID derived from runtime kind/workspace/config fingerprints/schema version, acknowledged consumed cursors |
| Task memory projection | taskId, source Room cursor, summary revision, provenance |
| Rolling Room checkpoint | immutable parent, contiguous input interval, through sequence, summary, provenance/digest, prompt/model version, build kind |
| Rolling Room state | mode, latest and desired through sequences, latest checkpoint, generation, lease, bounded failure projection |
| Long-term MemoryEntry | memoryId, Room/Task scope, typed content, active/superseded/retracted state, scope revision, supersession link, Message/Artifact/Run/Discussion provenance, Member author, timestamps |
| ArtifactRef | artifactId, taskId, artifactRevision, type, workspaceRef, repository/path/commit/branch metadata, title, summary, creator, optional sourceRunId, timestamp |
| TaskClarification | clarificationId, taskId, requestingRunId, targetAgentId, question/choices, question and answer Message IDs, continuationRunId, state, terminal reason, timestamps |

Task state is `open`, `working`, `blocked`, `review`, `completed`, or
`canceled`. A Task state is explicit aggregate state; one successful Run does
not automatically complete a Task. Parent Tasks provide hierarchy without
changing Run or delivery semantics.

The Server exposes membership-authorized Room Task list/create operations and
an update operation by Task ID. Every Room has one non-removable default Task
for backward compatibility. A Task cannot enter a terminal state while it has
an active Run or Discussion, and new routed Messages are rejected atomically
when their Task is already terminal.

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

Bridge Task Session fields roll out additively. During the transition, a new
Bridge accepts a legacy Room-scoped request and a new Server tolerates a Bridge
that does not report session disposition. A Task-scoped binding never falls
back to a previous Room-scoped native session, because that would reintroduce
cross-task context.

## Security and Verification

- Task reads and writes require Room membership; Task creation records the
  authenticated Member and validates primary Agent membership.
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
- Clarification answer retries converge on one Message and continuation Run;
  cancellation, deadline expiry, unavailable Agents, and orphaned scope close
  waiting records durably; Bridge restart replays only a still-valid question
  without re-executing the suspended Run.
- Permission-shaped fields are rejected by the wire contract, and interactive
  local Runtime requests never reach the clarification API.

## Task Mapping

`TASK-001` through `TASK-009`, with wire and Runtime work in `CON-007`,
`CON-009`, `ADP-012`, and `ADP-013`, clarification in `RUN-009`/`RUN-010`, and structural cleanup only after those
behavioral milestones.

## Dependencies

Contracts, Team/Room, Registry, Persistence, and Security. Run and Discussion
Orchestration consume Task identity but keep ownership of execution state.
