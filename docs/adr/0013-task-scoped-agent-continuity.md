# ADR-0013: Scope long-lived Agent continuity to a Task

- Status: Accepted
- Date: 2026-08-25
- Supersedes: none

## Context

Managed Codex and Pi adapters currently resume one native session for a Runtime,
Room, Agent, and workspace. This preserves useful continuity, but unrelated
work in the same Room shares private Runtime history. Every resumed prompt also
projects the newest Room window, so already-consumed Messages are repeatedly
injected into that persistent history.

The central model has bounded Runs and governed Discussions, but no durable
identity for a goal spanning several Runs. A native session therefore carries
more long-lived meaning than the control plane that requested it. A first-time
Agent also sees only recent Room context and cannot reconstruct older shared
decisions known by another Agent's private session.

## Decision

Introduce `AgentTask` as a first-class Room aggregate. Every Run and Discussion
belongs to one Task, while Run remains one bounded delivery/execution attempt.
Handoffs and Discussion Waves inherit Task identity. The active-Discussion fence
moves from Room scope to Task scope.

The Server sends a logical Task Session scope with managed Run delivery. The
Bridge keys resumable native sessions by Runtime kind, Agent ID, Task ID,
workspace fingerprint, Runtime semantic-config fingerprint, and session schema
version. It may also retain Room ID as a defensive binding check. Native Codex
Thread and Pi session IDs remain local and are never returned to the Server.

Each local binding records the last Room sequence consumed and the last Run ID.
Deliveries carry ordered context sequence values and an inclusive cursor. A new
native Session receives a bounded bootstrap; an existing Session receives only
Messages newer than its saved cursor plus the current request. The Bridge may
report only `started`, `resumed`, or `recreated` and the safe consumed cursor.

Shared Room and Task summaries are derived projections with source provenance,
not new authorities. Structured ArtifactRefs describe results without moving
workspace contents or local permissions into the Server.

Permission approval and Task clarification remain different protocols. The
Server may later suspend a Task for an authorized human clarification and
resume the same logical Session. It may never answer a local filesystem, shell,
network, tool, or provider approval request on the user's behalf.

## Alternatives

- Keep Room-scoped native sessions: simplest, but unrelated work contaminates
  the same context and the Server cannot reason about long-lived work.
- Start a fresh native session for every Run: avoids contamination but discards
  the existing durable continuity and repeats exploration.
- Add only rolling Room summaries: helps new participants but does not identify
  a long-lived goal or stop duplicate context injection into resumed sessions.
- Store native session IDs centrally: improves visibility but violates the
  local Runtime ownership and privacy boundary without being required for
  orchestration.

## Consequences

- Users can keep independent long-lived work in one Room, with explicit Task
  selection and recovery.
- A Runtime config or workspace semantic change intentionally starts a new
  native session.
- Migration creates a default Task for existing Room work. Old Room-scoped
  bindings are not reused for Task-scoped execution.
- Delivery and context planning gain cursor/revision state and need crash-cut
  tests; duplicate suppression remains at-least-once rather than claiming
  impossible exactly-once provider input.
- Task, memory, Artifact, clarification, and structural refactors remain
  separate delivery tasks and commits.

## Compatibility and Security

Wire fields are introduced additively before they become mandatory in a future
protocol version. New Bridges retain a bounded legacy Room-scope fallback only
for genuinely legacy requests; a request carrying Task scope never resumes an
old Room binding. Unknown session disposition is tolerated during mixed-version
deployment.

Fingerprints are one-way hashes of the canonical workspace identity and only
configuration fields that affect session semantics. Raw local paths, commands,
environment values, native IDs, prompts, and replies are not added to central
session metadata.

## Verification

- Migration assigns every historical Run and Discussion to exactly one default
  Task without changing IDs or delivery payloads already persisted.
- One Agent working on two Tasks in one Room uses different native sessions;
  later Runs on the same Task resume the same session.
- Workspace, model/preset, sandbox, command, or session-schema changes roll to
  a new binding.
- Resumed prompts include only committed Room Messages after the saved cursor;
  new-session prompts retain a bounded bootstrap.
- Restart, invalid native session recreation, duplicate delivery, cancellation,
  and Agent FIFO/cross-Agent concurrency tests continue to pass.
- No central response can approve an interactive local Runtime permission.
