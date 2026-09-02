# EXEC-008 Multi-Node Scheduler Capacity Goal

Status: frozen and active on 2026-09-02. This document is the acceptance
authority for `EXEC-008`; `docs/TASKS.md` remains the sole delivery-state
register.

## Goal

Allow one deterministic scheduler sweep to make bounded progress across a
broader approved graph without changing who authorized the plan, evidence,
Run, retry, verifier or repository mutation.

The scheduler continues to consume approved topology and current readiness. It
does not become a planning Agent. It may fill available capacity with independent
ready nodes and may revisit newly unblocked nodes in a bounded pass, but it must
never infer retry or bypass a gate.

## Deterministic Selection

Candidate ordering is one documented tuple:

```text
plan approval time (binary), plan id (binary),
topological ordinal, node key (binary)
```

Each bounded round selects at most one candidate per plan before returning to
that plan, so a large graph cannot starve another approved plan. Within a plan,
the approved topological order wins; node labels, insertion order, SQL row order
and process timing are not authority.

The sweep freezes its candidate order, but every admission transaction rechecks
live plan, dependency, Task, Agent, grant/profile and capacity facts. A stale
candidate becomes a projected blocker and does not consume a slot.

## Capacity Rules

- Active Runs are counted from durable DispatchIntents joined to nonterminal
  Runs, never an in-memory counter.
- Plan `maxConcurrency` is a hard upper bound across concurrent Servers.
- One Agent still owns at most one active governed Run.
- Independent Agents may run in parallel up to remaining plan capacity.
- Plan attempt/duration and Task budgets are rechecked per winner.
- A sweep stops when no candidate was admitted in a complete round or when its
  bounded work budget is exhausted.
- A duplicate/restarted/concurrent sweep returns existing exact Runs or no new
  Run; it never creates a second DispatchIntent for a node generation.

## Non-Goals

This slice adds no manual/supervised/automatic mode. The existing scheduled
behavior remains the only mode. `EXEC-010` owns future persisted mode authority.
It also adds no automatic retry, plan supersession, new node kind, relaxed Agent
capacity, evidence adoption, verifier/integration authority or remote provider.

## Required Evidence

Physical SQLite and public scheduling tests must prove:

1. a fan-out graph fills exact `maxConcurrency` across independent Agents;
2. fan-in stays blocked until every exact gate materializes, then schedules
   once;
3. two approved plans make fair round-robin progress under a shared sweep;
4. node insertion and callback permutations produce the same selection order;
5. same-Agent nodes serialize while other Agents use remaining plan capacity;
6. concurrent scheduler instances cannot exceed plan/Agent capacity or create
   duplicate intent, Run, message, input binding or workspace generations;
7. restart between readiness projection, admission and dispatch recovers the
   exact winners without rescheduling terminal/proven nodes;
8. injected stale plan, revoked grant, vanished capability, missing adoption,
   exhausted budget and admission failure block only the affected candidate;
9. newly unblocked nodes can progress in a bounded later round without an
   unbounded loop;
10. Server regression/build, deterministic E2E and three isolated temporary
    runs pass with physical before/after zero-residue snapshots.

`EXEC-008` becomes `DONE` only when those facts exist. A passing unit test alone
is not capacity acceptance.
