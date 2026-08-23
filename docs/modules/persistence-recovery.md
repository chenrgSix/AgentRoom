# Persistence and Recovery

## Scope

- Prefix: `DATA`
- Planned location: `apps/server/`
- Owns: SQLite schema, repositories, transactions, backup and recovery

The server persistence layer owns durable Team, Room, Message, Agent projection,
Run, delivery, and audit records. SQLite is the MVP database for a single
central server instance.

## Storage Model

Repositories expose domain operations rather than raw SQL to other modules.
Schema migrations are ordered, transactional where SQLite permits, and tested
against both an empty database and the previous supported version.

The Node.js server uses `better-sqlite3`. The database location resolves from
`AGENT_ROOM_DATABASE_PATH`, then `AGENT_ROOM_DATA_DIR`, then the local
`var/agent-room.sqlite` default. Applied migration filenames and SHA-256 values
are immutable; startup rejects missing, reordered, or changed history.

Run transitions append contiguous `run_events`; deliveries persist their stable
attempt ID, idempotency key, payload hash, payload bytes, send count, and ACK.
Schema constraints remain authoritative even when a projection is rebuilt.

## Transaction Boundaries

Message append, Run batch creation, Delivery creation, ACK, and each event
application have explicit SQLite transactions. Sequence and terminal guards
prevent stale writers from overwriting newer Run state; Bridge inbox writes are
fsynced before acceptance or event send.

The local Bridge inbox is owned by the Bridge module, although its recovery
contract is tested jointly with server delivery records.

## Recovery Policy

On startup, the server validates migrations and preserves queued deliveries and
terminal outcomes. Bridge reconnect dispatches queued work, while Bridge
restart replays durable events or reports an unfinished Runtime as
`outcome_unknown`. Projection sequence numbers never move backward.

Backups use the SQLite backup API, include schema metadata, refuse overwrite,
and pass `quick_check`. Restore and forward-only migration rollback procedure is
documented in `docs/backup-and-restore.md`. The Compose workflow installs host
backups atomically without overwrite, streams restore hashes, stages a new
database filename, removes only a rejected new target, and never changes the
selected live database in place.

## Verification and Tasks

Tests cover constraints, migration rollback behavior, crash points, delivery
recovery, backup, restore, and corrupted input rejection. Work is tracked by
`DATA-001` through `DATA-005` in `docs/TASKS.md`.

## Dependencies

Contracts for persisted versions and domain modules for transaction invariants.
