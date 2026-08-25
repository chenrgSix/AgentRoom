# Persistence and Recovery

## Scope

- Prefix: `DATA`
- Planned location: `apps/server/`
- Owns: SQLite schema, repositories, transactions, backup and recovery

The server persistence layer owns durable Team, Room, explicit human and Agent
Room participation, Message, Agent projection, Run, delivery, Discussion Wave,
Agent Task, and audit records. SQLite is the MVP database for a single central
server instance.

## Storage Model

Repositories expose domain operations rather than raw SQL to other modules.
Schema migrations are ordered, transactional where SQLite permits, and tested
against both an empty database and the previous supported version.

The Room-participant migration backfills every existing Team Member and enabled
Agent into each existing Team Room. Roster replacement updates both participant
tables in one immediate transaction; removing a participant never cascades into
Message, Run, or Discussion history.

The Node.js server uses `better-sqlite3`. The database location resolves from
`AGENT_ROOM_DATABASE_PATH`, then `AGENT_ROOM_DATA_DIR`, then the local
`var/agent-room.sqlite` default. Applied migration filenames and SHA-256 values
are immutable; startup rejects missing, reordered, or changed history.

Run transitions append contiguous `run_events`; deliveries persist their stable
attempt ID, idempotency key, payload hash, payload bytes, send count, and ACK.
Schema constraints remain authoritative even when a projection is rebuilt.

Discussion persistence stores one open Wave at most per Discussion. Each Wave
freezes its phase, input Message, deadline, expected member count, and member
Turns. Member identity is unique within the Wave. Run `orchestrationKey` is a
unique nullable recovery key; Discussion member Runs use their `turnId`.
Existing sequential Turns migrate to singleton Waves before new parallel Waves
are scheduled.

Migration 0024 creates one default Agent Task per existing Room and adds Task
identity to existing Messages, Runs, and Discussions. Triggers reject
cross-Room references, and a partial unique index enforces one active
Discussion per Task rather than per Room.

Migration 0025 adds the closed logical Runtime Session status object to durable
Run events. The Server validates disposition and bounds the reported cursor by
the triggering Message sequence, advances the Task's monotonic Room cursor,
and never stores a provider-native session ID.

Migration 0026 adds Room memory projections and Task summary revision,
source-sequence, provenance, and fingerprint metadata. These records are
derived caches: identical inputs keep their revision, changed authoritative
Messages or Task state advance it, and every claim remains traceable to the
stored Message log or explicit Task fields. Rebuilding a projection cannot
replace or delete its source history.

Migration 0027 adds immutable Task ArtifactRefs and a monotonic artifact
revision on Agent Tasks. Artifact insert and revision advance share one
immediate transaction. Composite Task/Room references and a source-Run trigger
prevent evidence from crossing Task history; exactly one authenticated Member
or Agent creator is retained for attribution.

After an ordinary Wave settles, Discussion Orchestration appends an idempotent
`wave_result` system Message with an ID derived from the Wave ID. This Message is
the next Wave's stable input anchor. It is deliberately written before the
barrier-close transaction; a retry observes the same ID instead of appending a
second anchor.

## Transaction Boundaries

The Server composition root creates one `SqliteTransactionBoundary` for the
Team/Room, Message, Agent/Device, Artifact, and Task-clarification repositories.
`CoreRepository` remains a compatibility facade for services, but it owns no
aggregate SQL: `team-room-repository.ts`, `message-repository.ts`, and
`agent-device-repository.ts` own those statements and receive the same boundary.
`AgentTaskRepository` remains the Task aggregate owner. Nested repository calls
therefore join the outer `better-sqlite3` transaction/savepoint rather than
opening unrelated connections or inventing cross-database coordination.

Message append, Run batch creation, Delivery creation, ACK, and each event
application have explicit SQLite transactions. Opening a Discussion Wave writes
the decision, Wave, and all planned member Turns atomically before member Runs
are created. Closing its all-settled barrier atomically fences the Wave state,
one budget event, one ProgressSnapshot, the authoritative decision, and any
next Wave by aggregate version.

The separately idempotent `wave_result` Message is not part of that aggregate
transaction. Its deterministic identity closes the crash window between Message
append and barrier commit without claiming a cross-aggregate transaction.

Sequence and terminal guards prevent stale writers from overwriting newer Run
state; Bridge inbox writes are fsynced before acceptance or event send.

The local Bridge inbox is owned by the Bridge module, although its recovery
contract is tested jointly with server delivery records.

## Recovery Policy

On startup, the server validates migrations and preserves queued deliveries and
terminal outcomes. Bridge reconnect dispatches queued work, while Bridge
restart replays durable events or reports an unfinished Runtime as
`outcome_unknown`. Projection sequence numbers never move backward.

Discussion reconciliation covers three explicit cut points:

1. a planned Wave before some or all member Runs exist: bind an existing Run by
   `orchestrationKey`, or create one keyed Run when no identity exists;
2. an open Wave with only some terminal members: preserve settled members;
   queued managed work is retried when its Bridge reconnects, while accepted or
   working members await durable inbox replay or their Wave deadline;
3. a closed barrier whose next Wave is already committed: dispatch only its
   missing member Runs and do not repeat projection, budget, or policy writes.

Duplicate terminal callbacks may update no state after the first successful
barrier close. Partial success remains recoverable because every member outcome
and terminal reason is durable; all-member failure converges to
`waiting_human` instead of automatically rerunning unknown work. A persisted
`input_required` member is represented as a terminal unknown outcome with its
reason, so it cannot leave the recovered barrier permanently open.

An ordinary Task clarification uses migration 0028 to persist the sequenced
Run event, Agent question Message, and waiting clarification in one SQLite
transaction. The Bridge stores `input_required` as a replayable local terminal
boundary rather than an unfinished process. An authorized answer transaction
appends one idempotent member Message, closes the old Run, creates one queued
same-Task continuation, and links those identities before commit. Answer retry
returns the existing continuation, while normal queued-delivery recovery sends
it after Bridge reconnect.

Migration 0031 adds durable clarification resolution reasons and a database
trigger that closes every still-waiting clarification in the same transaction
as its requesting Run's terminal transition. Startup reconciliation handles
preexisting deadline, Agent-assignment, Task, and question-scope invalidation;
it never revives or silently deletes the evidence record.

Migration 0032 adds immutable Room/Task Memory entries and monotonic scope
revision counters. Supersession allocates one revision for the old entry's
terminal state and one for its successor; retraction allocates one new revision.
Unique scope revisions make cursor reads lossless, while delete and evidence
mutation triggers keep historical provenance recoverable after restart.

Backups use the SQLite backup API, include schema metadata, refuse overwrite,
and pass `quick_check`. Restore and forward-only migration rollback procedure is
documented in `docs/backup-and-restore.md`. The Compose workflow installs host
backups atomically without overwrite, streams restore hashes, stages a new
database filename, removes only a rejected new target, and never changes the
selected live database in place.

## Verification and Tasks

Tests cover constraints, migration rollback behavior, Wave backfill,
atomic planning and closure, callback duplication, ordinary reconciliation,
delivery recovery, backup, restore, and corrupted input rejection. `QA-010`
reopens SQLite at planned-member, partially settled barrier, and
committed-next-Wave cut points, and verifies deterministic-anchor retry.
Persistence work is tracked by `DATA-001` through `DATA-006`; parallel recovery
is completed by `DISC-007` and `QA-010` in `docs/TASKS.md`.

## Dependencies

Contracts for persisted versions and domain modules for transaction invariants.
