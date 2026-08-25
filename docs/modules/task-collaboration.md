# Task Collaboration Module

- Prefix: `TASK`
- Implementation: `apps/server/src/task/`, migration 0024, and the Web Room
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
| AgentTask | taskId, roomId, parentTaskId, title, goal, state, primaryAgentId, workspaceRef, summary, lastRoomSequence, creator, timestamps |
| Logical Task Session | taskId, agentId, runtime kind, workspace fingerprint, config fingerprint, schema version |
| Task memory projection | taskId, source Room cursor, summary revision, provenance |
| ArtifactRef | taskId, type, workspaceRef, repository/path/commit/branch metadata, title, summary |

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
- Workspace and Artifact references are identifiers and verification metadata,
  not a central shared filesystem or permission grant.

## Shared Memory

Room history and Task events are authoritative. Room and Task summaries are
bounded, rebuildable projections with a source cursor and revision; they never
replace Messages, Runs, decisions, or ArtifactRefs as evidence.

A new native Session receives bounded Room memory, Task memory, relevant recent
events, result evidence, and the current request. A resumed Session receives
only Room events after its last consumed cursor, Task-memory/result revisions
it has not consumed, and the current request. Context construction fails closed
to a bounded recent projection when a summary is unavailable or stale.

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
- Existing migration data remains reachable and does not duplicate execution.
- Two Tasks in one Room and Agent resolve to different native Sessions.
- Runtime semantic configuration changes create a new native Session without
  deleting or exposing the old provider session.
- Cursor tests prove resumed prompts do not repeat already-consumed Room
  Messages and never skip a committed delta that is present in the delivery.
- Summary and Artifact consumers can trace claims back to authoritative source
  events or external workspace evidence.

## Task Mapping

`TASK-001` through `TASK-003`, with wire and Runtime work in `CON-007` and
`ADP-012`, clarification in `RUN-009`, and structural cleanup only after those
behavioral milestones.

## Dependencies

Contracts, Team/Room, Registry, Persistence, and Security. Run and Discussion
Orchestration consume Task identity but keep ownership of execution state.
