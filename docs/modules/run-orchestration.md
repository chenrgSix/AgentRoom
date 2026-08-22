# Run Orchestration Module

- Prefix: `RUN`
- Planned location: `apps/server/`
- Owns: Run lifecycle, durable delivery, status sequencing, cancellation,
  offline queue, handoff

## Purpose

Run Orchestration converts an authorized structured Agent Mention into one
bounded unit of work. It is the only component allowed to route work between
Agents; Agents and Bridges never route directly to one another.

## Responsibilities

- Create one Run per valid target Mention.
- Persist delivery before pushing to a Bridge.
- Retry unacknowledged delivery with the same Run ID.
- Apply sequenced Bridge status and reply events.
- Manage cancellation, expiry, offline queue, and terminal outcomes.
- Validate and create child Runs for handoff.
- Publish Run projections for Web and MCP.

## State Machine

```text
queued
  → delivered
  → working
      ├── input_required
      ├── completed
      ├── failed
      ├── canceled
      ├── expired
      └── outcome_unknown
```

`transport_lost` is connection metadata, not a Run state. Terminal states do
not transition. A Runtime that may have executed but lacks a trustworthy
outcome becomes `outcome_unknown` and is never automatically rerun.

Offline managed Runs remain `queued` and are delivered when the target Device
publishes or heartbeats. A queued Run that reaches its persisted deadline moves
to terminal `expired` and is never delivered on a later reconnect.

## Delivery Contract

1. Persist Run and delivery record.
2. Select the currently active target Bridge connection.
3. Send `run.requested` with Run ID and delivery attempt ID.
4. Bridge durably records Run ID before returning `run.accepted`.
5. Retry on missing ACK without changing Run ID.
6. Stop retrying after acceptance, cancellation, expiry, or Agent revocation.

Delivery is at least once; execution is idempotent through the Bridge inbox.

The server persists one Delivery payload per managed Run before the first send.
Retries increment `sendCount` but preserve the attempt ID, idempotency key, and
payload bytes. A valid `run.accepted` sequence 1 moves the Run to `delivered`;
duplicate ACKs are idempotent.

## Event Ordering

Each accepted Run has a Bridge-generated monotonic `sequence`. The server
persists an event only when its sequence is greater than the last accepted
value. Duplicate and stale events are acknowledged but do not alter state.

The server accepts contiguous `run.status` and `run.reply` events only from the
Device that owns the target Agent. Events persist in `run_events`; an applied
reply also appends one Agent-authored Room Message linked to its trigger.
Duplicate events do not create duplicate replies, and the first terminal state
remains authoritative.

The Bridge also stores emitted event envelopes in its durable inbox before
network send. Reconnect replays these envelopes idempotently; a Bridge process
restart converts any unfinished local execution to `outcome_unknown` before
replay, so the central projection cannot remain falsely `working`.

## Handoff

A handoff request contains parent Run, target Agent, summary, and optional
context references. The server validates Room access, target availability,
lineage, maximum depth 4, maximum unique Agents 5, and maximum Run duration
20 minutes before creating a child Run.

The MCP caller must be the parent Run's target Agent. Child Runs inherit the
root trigger and deadline, use a new durable Run ID, and cannot revisit an Agent
already present in their lineage.

## Cancellation Races

- A queued Run cancels without delivery.
- An accepted Run sends one interrupt request.
- The Bridge persists and reports its first terminal outcome; the server accepts
  the first valid terminal event for the Run.
- A later conflicting terminal event is retained as diagnostic evidence but
  cannot replace the result.

## Verification

- ACK loss and reconnect never execute a Run twice.
- Out-of-order events never regress state.
- Offline delivery runs once after reconnect.
- Cancellation and completion races are deterministic.
- Handoff loop, depth, and unique-Agent limits are enforced.

## Task Mapping

`RUN-001` through `RUN-006`, plus the in-process harness `QA-001` and recovery
tasks `DATA-003` and `QA-004`.

## Dependencies

Contracts, Team/Room, Registry, Bridge delivery, Persistence, and Security.
