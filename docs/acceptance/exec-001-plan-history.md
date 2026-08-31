# EXEC-001: Immutable Execution Plan History

Date: 2026-08-31. Baseline: `358209b`. Owning requirements: EX-01/EX-02,
ADR-0036 and the Execution module. Delivery state lives only in TASKS.
This evidence covers draft persistence, not approval or software delivery.

## Implemented Boundary

Migration 0058 adds plan identity, immutable proposal/revision links, decisions,
sealed source snapshots and operation receipts. It does not change any existing
Task/Run/Result authority or migration checksum. The composition root supplies
one shared transaction boundary, current authentication and a commit-only Room
change callback. Routes do not construct services or execute provider work.

Human create/revise requires the current root Task Owner or Team Owner, current
Room membership and an exact root revision. Current node identities, Task pins,
owners and assignments are checked in the same immediate transaction. Root
Tasks must be top-level, non-default and non-terminal. Alternative drafts may
coexist without compiling Tasks. Agent author fields cannot be supplied through
the human surface; their separately authenticated entry points remain distinct.

An operation fingerprint covers action, actor, target and normalized command.
An exact retry returns its original projection even after a newer revision or
process restart. A changed payload/actor/target conflicts. Authentication and
current authority are checked before reading the receipt; a revoked member or
archived Team cannot use replay as an access bypass.

Decision references freeze exact Message/Event sequences, Artifact revisions,
Memory lifecycle revisions, Discussion aggregate versions and immutable Result
versions. Result review/acceptance is not copied. Same-Room context references
do not issue a cross-Task Run read grant. Each bounded canonical JSON archive is
hashed, stored with its source pin and sealed when its proposal is inserted.
SQLite rejects rewriting, deleting or appending to sealed evidence. Closed
shared schemas/generated TypeScript and Go also cover archive/page responses.

## Reproducible Verification

Run from the repository root, with a task-owned temporary root for legacy tests
and an isolated Go cache. Remove only that owned root after all processes exit.

```sh
node --import tsx --test apps/server/test/execution-plan-history.test.ts
npm run test --workspace @convene-wire/server
npm run test --workspace @convene-wire/contracts
npm run validate
npm run build
npm run lint:docs
git diff --check
```

The 16 focused Server cases cover:

- attributed append-only decisions/plans and no Task/Run creation;
- normalized exact retry, changed-operation conflicts and database reopen;
- competing plan revisions and stale root pins;
- current human/Room/Team authority, including historical reads and replay;
- operation collisions across actors and plans;
- foreign/missing/stale sources and no partial records;
- mutable Memory retraction without historical source drift;
- malformed graphs, forged author/permission fields and no execution endpoint;
- non-default/top-level roots and existing Task revision fences;
- injected mid-transaction failure, complete rollback and safe errors;
- immutable SQL history, contiguous revisions and sealed source membership;
- actual Artifact/Result/Discussion/Run-event records, exact sequence lookup
  and no local Artifact path projection;
- bounded deterministic pagination and no-store errors;
- trusted Web Origin checks before replay;
- rejected nonexistent external snapshot inputs without a delivery grant;
- exactly one change notification per committed mutation, none for replay or
  rolled-back writes.

The final full Server suite passes 379 tests, including all 16 new cases. It
checks the existing Task, Result, Discussion, Bridge,
authentication, recovery and migration paths. The new migration was also
verified through legacy version-14/22/42/51 upgrade scenarios, foreign-key checks
and idempotent startup. Old migration fixture version lists were advanced to 58;
no historical migration was rewritten.

Contracts: 68 Node checks, 10 schemas, 189 shared schema fixtures and 11 generated
Go typed round-trips pass, including the three new response types. Generated
checks, TypeScript checks, generated Go compilation and the shared Go schema
suite pass. All-workspace build passes; the existing Web main-chunk warning
above 500 kB remains visible and was not suppressed.
Markdown lint passes for 292 maintained files; whitespace checks pass.

## Implementation Review

This is the implementing agent's review, not an independent audit. It identified
and repaired four boundary issues before this increment was admitted:

1. ID-only sources lose historical meaning when mutable records advance:
   persist exact-version, hashed source archives.
2. UPDATE/DELETE guards alone allow later source insertion: seal the set at
   proposal creation and validate exact source/revision membership in SQL.
3. Server-only source/page shapes drift from cross-language contracts: register
   the closed response schemas and generated types/fixtures.
4. Generic HTTP change publication duplicates the repository callback and
   wakes clients on retries: opt the new routes into commit-owned publication.

The source gateway is read-only. Local repository/grant/profile references are
requirements in a draft, not verified capabilities or permission. The mutation
service has no Task creation, Run creation/delivery, Result review, shell,
filesystem or remote-provider port. These exclusions were checked against the
accepted ownership map; they are deliberate prerequisites for later approval
and execution, not a claim that the overall workstream is complete.

No real model invocation, Git workspace mutation, independent verifier command,
browser acceptance, native Bridge acceptance, external provider operation,
deployment or Release was performed for this increment. The cumulative QA-052
through QA-055 requirements remain necessary for the final completion inventory.
