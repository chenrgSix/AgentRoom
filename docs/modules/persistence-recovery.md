# Persistence and Recovery

## Scope

- Prefix: `DATA`
- Planned location: `apps/server/`
- Owns: SQLite schema, repositories, transactions, backup and recovery

The server persistence layer owns durable Team, Room, explicit human and Agent
Room participation, Message, Agent projection, Run, delivery, Discussion Wave,
Agent Task, Central Hosted Runtime Profile/credential envelope/invocation
intent, and audit records. SQLite is the MVP database for a single central
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

Migration 0044 adds a unique monotonic Task-local attempt number, optional
same-Task retry lineage, immutable redacted Context Manifest, idempotent retry
operation record, and append-only ambiguous-outcome acknowledgement. Existing
Runs receive deterministic attempt numbers and retain a missing manifest as a
legacy `not_recorded` condition; no historical execution context is invented.
New Runs capture their manifest after the existing context-fence trigger and
before any managed Delivery can be emitted.

Migration 0052 plus corrective Migration 0053 add the ADR-0026 `hosted` Agent
integration mode, versioned Hosted Runtime Profiles, authenticated
provider-credential envelopes, safe connection-test observations, and one
unique Hosted invocation intent per Run. Migration 0052 remains byte-for-byte
identical to its initially applied history; Migration 0053 alone replaces the
invocation state trigger so equal timestamps within one clock tick are valid
while time reversal and invalid lifecycle transitions remain rejected. They add
no local path, command, environment, Workspace, Docker, desktop, Bridge,
provider-response body, plaintext credential, or duplicate prompt column.
Existing Agents and Runs retain their exact integration and delivery semantics;
no Hosted row is synthesized during migration.

ADR-0027 adds a dedicated `web_member_recoveries` table through an additive
migration. It retains only the random capability hash, exact issuing/target
identities, expiry and consumed/revoked state. Replacement, consumption and
session replacement are immediate transactions; applied migration checksums
remain immutable. Recovery never creates a replacement User or Member.

## Storage Model

Migration 0056 adds `web_owner_recovery_credentials`, a singleton hash-only
login verifier with revision and update time (ADR-0032). No row means legacy
deployment-file login; replacement and other-Owner-session revocation share
one immediate transaction. Backups preserve the verifier version and never
contain its plaintext key. Hosted roots/envelopes remain unchanged. Restore
requires the login key corresponding to the restored snapshot; reverting to a
pre-0056 binary after rotation is not a supported credential-security rollback.

Repositories expose domain operations rather than raw SQL to other modules.
Schema migrations are ordered, transactional where SQLite permits, and tested
against both an empty database and the previous supported version.

The Room-participant migration backfills every existing Team Member and enabled
Agent into each existing Team Room. Roster replacement updates both participant
tables in one immediate transaction; removing a participant never cascades into
Message, Run, or Discussion history.

The Node.js server uses `better-sqlite3`. The database location resolves from
`CONVENE_WIRE_DATABASE_PATH`, then `CONVENE_WIRE_DATA_DIR`, then the local
`var/agent-room.sqlite` upgrade-stable default. Applied migration filenames and SHA-256 values
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

Migrations 0043 through 0045 add Task display allocation, aggregate revision, human
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
Task/definition/criteria/context fences; and persists the Run attempt plus its
budget admission atomically. Managed Delivery is persisted separately before
network send, carrying the exact already-frozen Context Manifest.

Result proposal inserts content, Task-local version, sources, criterion claims,
evidence references, and attention wakeup together under one operation identity.
Result review inserts at most one terminal decision and may assign the Task's
completion Result and complete it in the same transaction. Response-loss retry
returns the same source edge, definition/criteria revision, ambiguity
acknowledgement, Run attempt, Result version, decision, and Task revision rather
than creating a substitute identity.

Migration 0045 leaves all historical Tasks unchanged and creates no fictional
Result. New Result rows use a Task-local version and retain exact definition,
criteria and proposal-time Task revisions. Artifact, Run-event sequence,
Message, Memory and Discussion sources remain foreign-keyed to their original
authorities; claims only reference evidence IDs in the same immutable Result.
Accept-and-complete verifies current revisions, no active work or unresolved
ambiguity/block, a completable outcome, and Artifact evidence for every required
criterion before one transaction appends the review and completes the Task.

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

### Central Hosted storage

A Hosted Runtime Profile is Team-scoped, bound to exactly one immutable Hosted
Agent identity, and revisioned across provider/model/limit changes. Its current
credential reference identifies one immutable encrypted version; rotation
creates a new version and revocation is retained rather than deleted. Agent and
profile constraints reject a Device binding, managed Workspace projection, or
conversion of an existing managed/manual Agent.

The credential row stores authenticated ciphertext, nonce/tag, algorithm and
key version, creation/revocation metadata, and a stable non-secret identity.
Authenticated read repositories never return those storage fields to ordinary
Agent/Profile DTOs. Trusted-team wrapping derives from existing recovery
authority; local loopback wrapping material may live in a separately scoped
SQLite row. Backups deliberately contain the envelope and required wrapping
metadata so restore preserves configured Hosted Agents, but verification and
operator output never decrypt or print the provider key.

Migration 0054 permits only the one-way local-to-trusted keyring upgrade in
addition to the existing one-time retirement. On trusted-team adoption, startup
atomically rewraps every local keyring under the existing Owner recovery root,
including retired versions, without changing its data key or credential
envelopes. It verifies all versions before commit. A durable cleanup marker,
`secure_delete`, `VACUUM`, and a truncated WAL remove old local-root copies from
the active database before startup succeeds. Interrupted cleanup remains marked
and resumes on the next startup; failure closes the database and refuses to
claim a completed upgrade. Previously exported backups and filesystem snapshots
cannot be retroactively scrubbed and are not deleted by this operation.

An incompatible mode or wrong recovery root makes Hosted credentials unavailable
and Hosted Presence degraded; ordinary Central health, authentication and Team
operations remain usable. No fallback silently trusts a database-contained root
in trusted-team mode. Restoring the correct recovery authority requires restart.
Database, WAL, SHM, rollback-journal, and direct-backup files use mode `0600` on
POSIX systems, including existing database files opened by migration or startup.
New data and backup directories use `0700`; an explicitly selected pre-existing
parent directory is not chmodded. Backups reserve an exclusive private file
before copying credential-bearing pages and never overwrite an existing target.

One Hosted invocation intent freezes Run, Agent, profile and credential
versions, provider/model identifiers, prompt digest, deadline, and operation
identity. A unique Run foreign key permits one automatic outbound attempt. The
Run/Message/Context Manifest remain the prompt authorities, so the intent stores
neither plaintext prompt nor provider response. Closed states distinguish
`prepared`, `dispatching`, `streaming`, and terminal completion/failure/unknown
for recovery; state never moves backward.

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

`RUN-014` narrows two former multi-transaction paths. A browser Member Message,
its structured Mentions and every mentioned Run commit in one immediate
transaction before dispatch. An applied reply event, handoff-routing intent,
Agent Room Message and immutable `(run_id, reply_sequence, message_id)` mapping
also commit together for managed, manual and in-process execution. Injected
failure at either the Message or mapping insert rolls the Run sequence and all
related rows back.

For `RUN-015`, creation of a Hosted invocation intent and its `prepared` state
commits before execution. The transition to `dispatching` commits before the
first provider byte may leave Central. Applying output uses the existing
contiguous Run-event transaction; applying the final reply uses the same
`RUN-014` event/Room Message/projection transaction and closes the invocation
intent consistently with the Run. Credential rotation or revocation never
rewrites the version frozen by an existing intent.

The separately idempotent `wave_result` Message is not part of that aggregate
transaction. Its deterministic identity closes the crash window between Message
append and barrier commit without claiming a cross-aggregate transaction.

Sequence and terminal guards prevent stale writers from overwriting newer Run
state; Bridge inbox writes are fsynced before acceptance or event send.

The local Bridge inbox is owned by the Bridge module, although its recovery
contract is tested jointly with server delivery records.

`BRG-052` extends that local boundary from file-content flush to namespace
durability. Configuration, Device credentials, Agent identities, inbox records
and quarantine moves, connection epochs, Runtime session bindings, and macOS
login-item changes sync the containing directory after their atomic create,
rename, move, or delete on Unix-like systems. A process-level data-root owner
also prevents a CLI, desktop shell, or second Bridge from acknowledging work
against overlapping local state. Windows uses the strongest portable boundary
available to this implementation—flushed files and atomic replacement—while
native directory fsync remains unavailable through Go.

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

Migration 0049 supplies compatibility recovery for rows written before the
`RUN-014` transaction boundary. Startup scans Member Messages with Mentions and
no Runs, preserves the original creation time and 20-minute deadline, and
creates the complete batch only while current scope remains authorized. A row
already past its original deadline is restored directly as `expired`, never
executed. Invalid scope, Task or target state fails closed and remains visible
in structured startup diagnostics.

Historical reply events are matched only by exact Run trace, Room, nullable
Task, Agent sender, trigger parent, content and timestamp. One exact legacy
Message receives the immutable mapping; no exact candidate creates one Message
at the event timestamp. Multiple exact candidates, a mapping already owned by a
different event, timestamp drift or an invalid reply event writes an immutable
unreconciled-failure row. Repeated startup reconciliation is idempotent and
never guesses which history row was intended.

On startup, the server validates migrations and preserves queued deliveries and
terminal outcomes. Bridge reconnect dispatches queued work, while Bridge
restart replays durable events or reports an unfinished Runtime as
`outcome_unknown`. Projection sequence numbers never move backward.

Hosted startup recovery first completes any already-transactional terminal Run
projection. A `prepared` intent that has never crossed the durable dispatch
fence may be scheduled once. Any `dispatching` or later nonterminal intent is
terminalized with its Run as `outcome_unknown`; startup never opens a provider
request for it, reconstructs missing deltas, or invents a final reply. Repeated
recovery is idempotent. The existing audited ambiguity acknowledgement is
required before a different Run may retry that Task attempt.

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

Hosted profile, envelope, revocation, and invocation rows participate in that
same online SQLite backup. Backup verification proves structural presence and
referential integrity without decrypting a key or contacting a provider.

Migration 0048 adds one current `device_bridge_observations` row per Device.
It records only the authenticated connection epoch, canonical semantic Bridge
version, and observation time. The original pairing-session version remains
immutable historical identity. Hello Presence and the version observation are
written in one immediate transaction; stale epochs and a version change within
one epoch fail closed, while a newer epoch supports an in-place package upgrade
without replacing the Device credential. Ordinary heartbeats update Presence
but never rewrite this build observation.

## Verification and Tasks

Tests cover constraints, migration rollback behavior, Wave backfill,
atomic planning and closure, callback duplication, ordinary reconciliation,
delivery recovery, backup, restore, and corrupted input rejection. `QA-010`
reopens SQLite at planned-member, partially settled barrier, and
committed-next-Wave cut points, and verifies deterministic-anchor retry.
Persistence work is tracked by `DATA-001` through `DATA-006`, `TASK-007`
through `TASK-009`, target Task/Result persistence by `TASK-012`/`TASK-013`, and
Artifact storage by `ART-001`; local Bridge state ownership/durability by
`BRG-052`; ADR-0026 Hosted storage and recovery by `DATA-007`; parallel recovery
is completed by `DISC-007` and `QA-010` in `docs/TASKS.md`.

## Dependencies

Contracts for persisted versions and domain modules for transaction invariants.

## Client owner access persistence

ADR-0035 adds optional pairing binding metadata, independent hashed client grants, hashed short-lived tickets, Device initial Room defaults and derived Web session lineage. Approval and ticket consumption use immediate SQLite transactions. Migration creates no grants for existing Devices; restart must preserve consumed-ticket and revoked-grant state without retaining secret plaintext.
