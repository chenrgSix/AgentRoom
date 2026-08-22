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

Important state transitions append versioned events containing
`schemaVersion`, `aggregateId`, `aggregateVersion`, `causationId`, `traceId`,
and idempotency fields. Query projections may be rebuilt from durable records;
the append log is not a substitute for explicit domain constraints.

## Transaction Boundaries

Creating a message and its routing intent is atomic. Creating a Run and its
first delivery is atomic. ACK, retry scheduling, cancellation, and terminal Run
updates use compare-and-set conditions so stale writers cannot overwrite newer
state.

The local Bridge inbox is owned by the Bridge module, although its recovery
contract is tested jointly with server delivery records.

## Recovery Policy

On startup, the server validates migrations, resumes expired leases, reconciles
unacknowledged deliveries, and preserves terminal outcomes. Unknown Runtime
execution is surfaced as `outcome_unknown`. Projection sequence numbers never
move backward.

Backups use SQLite-safe snapshot procedures and include schema metadata.
Restore verification checks integrity, migration compatibility, and a sample
projection rebuild before serving traffic.

## Verification and Tasks

Tests cover constraints, migration rollback behavior, crash points, delivery
recovery, backup, restore, and corrupted input rejection. Work is tracked by
`DATA-001` through `DATA-004` in `docs/TASKS.md`.

## Dependencies

Contracts for persisted versions and domain modules for transaction invariants.
