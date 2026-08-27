# Persistence and Recovery

## Scope

- Prefix: `DATA`
- Planned location: `apps/server/`
- Owns: SQLite schema, repositories, transactions, backup and recovery

The server persistence layer owns durable Team, Room, explicit human and Agent
Room participation, Message, Agent projection, Run, delivery, Discussion Wave,
Agent Task, and audit records. SQLite is the MVP database for a single central
server instance.

Migration 0042 adds the nullable, bounded `workspace_alias` Agent projection.
Migration 0043 adds the versioned Task work aggregate, immutable definition and
criteria histories, current explicit assignments, blocks, comparable budget
ledger, mutation idempotency records, deterministic legacy mapping, and a
replacement rule for terminal historical default Tasks. Run insert/terminal
triggers account attempt and duration usage atomically with Run persistence;
they do not invent provider token or cost values.
It deliberately adds no Workspace root, command, environment, filesystem
policy, or network policy column; those remain Bridge-owned configuration.

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

The ADR-0022 target adds Task display allocation, aggregate revision, human
Owner, lifecycle/scheduling/completion policy, immutable criteria sets, explicit
Agent assignments, Message/Result Task-source edges, blocks, Task budget events,
Run-outcome acknowledgements, immutable Result submissions and
source/evidence/criterion edges, and append-only Result review decisions. These
are canonical rows behind the existing Task aggregate; the Team Workbench is a
rebuildable authorized projection.

Task creation allocates its Team display number, optional source edge, Owner,
lifecycle, completion policy, initial definition/criteria revisions,
assignments, and Task revision atomically. A goal edit advances definition and
Task revisions. A criteria edit also appends one complete immutable set and
advances the criteria revision in the same transaction. Run creation validates
expected Task revision, lifecycle, scheduling, budget and assignment; appends
budget admission and any required ambiguity acknowledgement; captures
Task/definition/criteria/context fences; and persists Run plus Delivery in one
transaction.

Result proposal inserts content, Task-local version, sources, criterion claims,
evidence references, and attention wakeup together under one operation identity.
Result review inserts at most one terminal decision and may assign the Task's
completion Result and complete it in the same transaction. Response-loss retry
returns the same source edge, definition/criteria revision, ambiguity
acknowledgement, Run attempt, Result version, decision, and Task revision rather
than creating a substitute identity.

Migration preserves every current Task, Run, Discussion, Artifact, Memory,
clarification, context, and Runtime Session identity. It deterministically
allocates Team display numbers, initializes definition/criteria revision zero,
maps eligible primary and historical participating Agents into assignments, and
maps existing Task states through the ADR table. It creates no fictional Result
and labels historical completion without accepted evidence as a compatibility
projection. A migrated block is explicit evidence; an old `blocked` enum is not
silently discarded.

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

`BRG-029` adds a durable local `preparing` state before any content-bearing Run
is acknowledged. Bounded range downloads fsync an owner-only partial file;
verified bytes are protected and atomically renamed before a path-free receipt
is installed. Restart leaves `preparing` unguessed so the pending Server
delivery re-enters the materializer at the exact local offset. A final file and
matching receipt are rehashed before returning `reused`; receipt, metadata,
permission, or digest drift fails closed. Runtime recovery revalidates receipts
before replaying sequence 1 and never advances result-evidence consumption at
this staging boundary. An active Run identity admits only one Bridge handler at
a time even when hello and Agent publication both trigger delivery. A persisted
terminal materialization failure replays its negative acknowledgement and
terminal event without re-downloading bytes or changing the established
outcome.

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

Migration 0033 adds immutable rolling Room checkpoints, one mutable scheduler
state row per enabled Room, and revision fences captured with each new Run.
Incremental checkpoint parents must remain in the same Room and their processed
intervals must be contiguous. The scheduler's latest cursor is monotonic, while
its desired cursor is a durable work watermark: losing a lease or rejecting a
stale commit cannot erase work when desired remains ahead of latest. Existing
extractive projection rows are neither copied nor reinterpreted as checkpoints.

Migration 0034 adds non-authoritative Memory candidates. Exact reducer retries
converge through a source fingerprint. Candidate acceptance, existing
LongTermMemory validation, formal Memory creation, and accepted-Memory linkage
share one transaction; rejection and invalid candidate output cannot affect a
valid checkpoint commit.

Migration 0036 adds immutable Team-scoped Blob content metadata and retained
Artifact publication operations. Ordered chunk progress, request fingerprints,
source Workspace lease scope, expiry, terminal failure, and the eventual bound
Artifact identity remain queryable after restart. Blob bytes stay in the
bounded local BlobStore; SQLite stores no file paths from a Bridge Workspace.

Migration 0037 adds the canonical Artifact side of the binding. One immediate
transaction inserts a content-bearing `task_artifact_refs` row, advances the
Task artifact revision, and changes its unique sealed publication to `bound`.
Reciprocal triggers require the exact Team/Task/Room/Run/Agent/Workspace and
content metadata on both records; any later mutation remains prohibited.

Migration 0038 adds immutable canonical Artifact relations and the retained
publication lineage request. A relation's source and older target must remain
in the same Task and Room, and its creator and timestamp must equal the source
Artifact. Artifact B, all requested relations, its Task revision increment,
and an optional publication bind share one immediate transaction. Database
triggers reject relation update/delete, cross-scope or forward targets, more
than 20 relations, and a bound publication whose retained request differs from
the canonical relation set. Response-loss recovery therefore returns B only
after exact lineage comparison; it never reconstructs or appends relations
later.

`ADR-0015` reserves two separate future linearization points for content-bearing
Task evidence. Blob seal fsyncs and atomically installs content before sealed
metadata commits. Canonical bind then uses one immediate SQLite transaction to
verify that sealed identity, append the immutable Task Artifact, advance its
artifact revision, and close the publication operation. A response-loss retry
queries the same publication identity; it never creates a replacement identity
or guesses whether either cut committed. Sealed-but-unbound content remains
recoverable until a bounded retention policy expires it.

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
Persistence work is tracked by `DATA-001` through `DATA-006`, `TASK-007`
through `TASK-009`, target Task/Result persistence by `TASK-012`/`TASK-013`, and
Artifact storage by `ART-001`; parallel recovery
is completed by `DISC-007` and `QA-010` in `docs/TASKS.md`.

## Dependencies

Contracts for persisted versions and domain modules for transaction invariants.
