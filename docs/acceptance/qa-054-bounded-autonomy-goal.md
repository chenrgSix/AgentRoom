# QA-054 Bounded-autonomy Product Acceptance Goal

Status: planned and frozen on 2026-09-03. This document is the future
acceptance authority for `QA-054`; `docs/TASKS.md` remains the sole delivery-
state register. It may become active only after `DISC-012` is accepted.

## Goal

Prove the complete bounded-autonomy product path without transferring human,
repository or proof authority to an Agent or Discussion quorum:

```text
read-only Discussion -> structured Plan proposal -> assigned Tech Lead revision
-> exact human approval -> governed dispatch -> bounded delegated supersession
-> compatible evidence carry-forward -> continued deterministic execution
```

The acceptance must also prove the negative path: any expansion of Task set,
scope, Agent/repository authority, verification floor, integration target,
budget, concurrency or acceptance criteria stops at explicit human review.

## Required Product Scenarios

1. One real Server-backed read-only Discussion uses a focused Wave and a quorum
   seal, retains late supplemental evidence, finalizes a structured Plan draft
   and never treats quorum as Plan approval.
2. An exactly assigned Tech Lead reads and revises that draft through the real
   MCP authority checks; another Agent and a stale/foreign Run cannot.
3. A human owner reviews and approves the exact initial Plan revision before
   any governed work dispatches.
4. A bounded, one-shot, unexpired delegation activates one compatible low-risk
   revision, carries only digest-equal revision-local evidence and allows the
   deterministic scheduler to continue.
5. A broader candidate returns `EXECUTION_HUMAN_REVIEW_REQUIRED` with no Plan,
   claim, adoption, delegation-consumption, Run, workspace or repository side
   effect; exact human activation remains available afterward.
6. Restart, response-loss and duplicate-operation cuts retain one Discussion
   seal, one Plan revision, one delegation consumption, one carry-forward set
   and one dispatch intent.
7. Discussion replies, quorum seals and supplemental records cannot satisfy an
   accepted-result, verified-output or integrated-commit gate; code review and
   verification remain independent graph proof authorities.
8. Existing Rooms/default Tasks, ordinary Runs, human Result review, scheduler
   modes, Client-owned Git boundaries and Optional Remote Evidence tests remain
   unchanged.

## Acceptance Boundary

Use actual HTTP/MCP/service boundaries, persisted SQLite facts and the ordinary
Run scheduler. Deterministic local/fake Runtime output is allowed; a live model,
live Remote Provider, multiple physical computers, deployment and Release are
not claimed. Every synthetic seam must be named in the final evidence.

`QA-054` may become `DONE` only after focused acceptance, full Server/Web/
Contract/Bridge regression, deterministic E2E, builds, schema generation,
documentation and isolated temporary-lifecycle verification pass. Physical
database assertions, not green HTTP responses alone, must prove the authority
and no-side-effect claims.
