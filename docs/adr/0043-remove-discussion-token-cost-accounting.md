# ADR-0043: Remove Discussion token and cost accounting

- Status: Accepted
- Date: 2026-09-05
- Amends: ADR-0042 observed usage and Discussion budget accounting

## Decision

The Owner requested removal of token and monetary-cost metrics after reviewing
QA-065. Discussion no longer accepts, accumulates, projects or displays those
metrics, including null placeholders and telemetry-availability flags. Budget
accounting keeps logical Waves, committed member slots, elapsed duration,
leases and extensions. Observed usage keeps actual Run lifecycle counts,
unbound slots, unavailable records and terminal-bounded wall time.

The Server removes token/cost fields from budget snapshots, budget-event
projections and observed usage. New budget events omit the legacy nullable
SQLite columns and telemetry flags. Reads explicitly select the supported
budget fields so old JSON cannot reintroduce removed metrics. Lease boundaries,
finalization reserve, selection and execution authority are unchanged.

The Web removes the metrics and placeholder copy in both languages. Generated
Discussion instructions describe only the remaining Wave lease. New benchmark
reports use version 2 and omit top-level token/cost placeholders. Existing fixed
task payloads and reviewed version 1 benchmark evidence retain their original
bytes and historical meaning; no real model rerun is required for this removal.

## Compatibility

SQLite migrations and historical rows remain unchanged. The retired columns
are nullable and default to null for new events. Historical event metadata
remains audit evidence; new events do not produce token/cost flags. This is a
read/write projection change, not a destructive data migration.

No Bridge envelope or cross-language schema contains these Discussion metrics.
Clients consuming the removed Server read fields must tolerate absence; the
bundled Web consumes only the retained counters and works with either Server
shape. It also ignores retired fields supplied by an older Server.

## Verification

Focused tests cover legacy persisted budgets, removed projections and new event
storage, retained budget boundaries, generated prompts, both Web locales and
the synthetic Server/Bridge benchmark report. Server/Web builds and maintained
documentation checks must pass. Delivery state is tracked only as DISC-017 in
TASKS.md.
