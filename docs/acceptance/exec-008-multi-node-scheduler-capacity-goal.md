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

## Implementation Checkpoint

`ExecutionNodeStateRepository.listCandidates()` now derives each current
candidate's ordinal from the validated approved topology and applies the frozen
approval-time, binary plan, topology and binary node tuple in process. SQL row
order is not observable authority. `ExecutionScheduler` freezes those ordered
candidates into per-plan queues, admits at most one winner per plan per round,
requeues a blocked candidate only for a later bounded round, and stops on a
complete no-progress round or its 256-evaluation ceiling. Every attempt still
calls the existing live readiness and transactional admission boundaries.

Focused scheduler tests prove stable output across input permutations, fair
`A1, B1, A2, B2` rounds, later-round release of a newly ready node, one-candidate
admission-fault isolation and the evaluation ceiling. Public Server, Bridge and
physical SQLite tests additionally prove:

- three independent Agents create exactly three topology-ordered generation-1
  intents, Runs and distinct isolated workspace leases at `maxConcurrency=3`;
- two approved two-node plans on one shared sweep retain physical intent order
  `A1, B1, A2, B2` using the documented plan tuple;
- two nodes assigned to one Agent serialize while a different Agent consumes
  remaining plan capacity;
- a two-source fan-in retains no destination intent after only one adopted
  predecessor, then freezes both exact input bindings and schedules once after
  the second adoption, including after Server restart;
- two Server schedulers with the same three live Agent capabilities converge on
  three unique intents, Runs, trace Messages and isolated workspace generations;
- the pre-existing readiness matrix and fault fixtures retain deterministic
  stale-plan, missing-adoption, budget, capability, grant and transactional
  admission blockers without partial side effects or automatic retry.

The complete governed-admission file and full Server workspace regression pass
under owned temporary roots. `EXEC-008` remains ACTIVE until the repository
build, deterministic E2E and required three-run physical zero-residue evidence
are recorded in this document and `docs/TASKS.md`.
