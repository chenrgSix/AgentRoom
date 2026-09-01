# REPO-002 Exact-Target Integration Goal

Date: 2026-09-02

## Status and Authority

This document froze the bounded `REPO-002` delivery target before code was
changed. `docs/TASKS.md` remains the sole delivery-state register. The existing
CON-021 `RepositoryOperationRequest` with `action.kind = integrate` and
`RepositoryOperationReceipt` are the wire authority; this slice does not add a
second IntegrationReceipt schema. The target remains unchanged; delivery and
physical acceptance are recorded below.

The generic receipt is an IntegrationReceipt when `kind = integrate`. Central
retains its canonical bytes and digest as immutable evidence. A successful
receipt may create the separate `integrated_commit` NodeMaterialization. Neither
an Agent Result, an accepted Result, nor a verification claim can move a target
ref.

## Frozen Outcome

One human-approved, independently verified local candidate can advance one
owner-selected local Git target only when the target still equals the exact
commit that the human approved:

```text
verified_output NodeMaterialization
  -> exact human IntegrationApproval
  -> one serialized RepositoryOperation(kind=integrate)
  -> owner-local grant/binding/object recheck
  -> git update-ref target candidate expected
  -> immutable RepositoryOperationReceipt(kind=integrate)
  -> integrated_commit NodeMaterialization
  -> existing mechanical dependency resolver
```

The operation request pins the approved plan/revision, source node and Run,
logical repository and Device-local binding, owner-local grant snapshot,
candidate commit/tree/input digest, target ref/expected commit, exact required
verification IDs and the human integration-approval operation ID. The retained
approval additionally pins the verified materialization digest and verification
receipt digests.

## Ownership

- `ExecutionSettlementService` projects terminal Run facts into node runtime
  state and does not prove dependency gates.
- `ExecutionMaterializationService` reconciles durable evidence into one
  revision-local gate materialization through gate-specific materializers.
- `RepositoryIntegrationService` is the Central admission, serialization and
  receipt-retention authority. It never executes Git.
- The authenticated human owner or owning Task member supplies the separate
  exact candidate approval. Plan approval and Result acceptance are not merge
  approval.
- The selected Bridge rechecks the current local binding, unexpired/unrevoked
  `integrate` grant and exact allowed target immediately before local effect.
- The Bridge integration journal owns lookup-before-retry and crash/response-loss
  recovery for its operation. It never scans or deletes unrelated state.
- Git owns the atomic old-object compare-and-set. ConveneWire does not implement
  a read-then-write imitation of CAS.
- `ExecutionDependencyResolver` remains deliberately mechanical: load the
  materialization named by `edge.gate`, then map approved output slots.

## Exact-Target Rules

1. The target is a closed `refs/heads/...` value present in both the approved
   plan policy and the current owner-local grant.
2. The current target object must equal `target.expectedCommit` at the atomic
   update. A moved or missing target produces retained conflict evidence and
   does not move the target.
3. The candidate object and tree must exactly match the verified materialization
   and all required passed receipts. Verification for another tree, input,
   profile set, plan revision or candidate is unusable.
4. The candidate must be a strict fast-forward descendant of the expected
   target. This slice performs no merge commit construction, rebase, cherry-pick,
   force update or automatic conflict resolution.
5. Candidate objects may be imported from ConveneWire's sealed capture bundle,
   but no shared target ref is changed until every check passes. An imported
   unreachable object is not integration success.
6. A target currently checked out by any worktree fails closed before CAS. The
   slice will not make a checked-out index/worktree inconsistent or reset owner
   files as a side effect. Owners select an integration target not currently
   checked out for this local adapter.
7. Central permits at most one unsettled integration operation for one logical
   `repositoryId + targetRef`, including across Device bindings. An exact
   operation replay returns the original admission or receipt; changed bytes
   conflict.
8. A successful local CAS is separate from remote push, PR state, deployment,
   Result acceptance and Task completion.

## Failure and Recovery Semantics

- Missing/expired/revoked grant, foreign Device/binding, stale plan, absent
  approval, incomplete verification, changed candidate or corrupt evidence:
  reject before local mutation.
- Target moved: atomically fail the expected-old update, retain a deterministic
  conflict receipt, release the Central queue and require a new candidate plus
  new verification and human approval.
- Cancellation before CAS: retain canceled evidence and do not move the target.
  Cancellation racing a completed CAS cannot rewrite success.
- Local process failure before a trustworthy effect: retain failed evidence.
- A durable local receipt whose Central response is lost is looked up and
  replayed by exact operation ID; it is never executed again.
- If the Bridge journal proves the exact effect was attempted but the process
  stopped before recording a trustworthy local outcome, the Bridge inspects
  only that exact target. Candidate means the requested effect is confirmed;
  expected means it may be retried under the same operation; any other value is
  `outcome_unknown` and requires human attention.
- Central retains only authenticated receipts from the operation's selected
  Device. Failed, canceled, moved-target or unknown receipts never materialize
  `integrated_commit`.

## Materialization Refactor

Before adding the third proof type, accepted and verified proof SQL moves out of
`ExecutionSettlementService` into:

```text
apps/server/src/execution/materialization/
  accepted-result-materializer.ts
  verified-output-materializer.ts
  integrated-commit-materializer.ts
  execution-materialization-service.ts
```

This first refactor is behavior-preserving: accepted-result and verified-output
digests, database rows, scheduler order and node projections remain byte-for-byte
compatible. Scheduler reconciliation runs materialization before settlement,
readiness and dispatch so newly available gate proof can release work in the
same sweep.

## Required Physical Acceptance

Focused Server and Bridge tests must prove database rows and real Git refs, not
only return values:

- exact human approval cannot be replayed with changed candidate, target,
  materialization or verification pins;
- missing/failed/forged/incomplete verification cannot enter the queue;
- success advances the exact target from expected to candidate, retains one
  immutable receipt and one `integrated_commit` materialization, and releases an
  exact downstream commit input;
- target movement retains conflict evidence while candidate/target refs remain
  physically unchanged by ConveneWire;
- checked-out target, non-fast-forward candidate, wrong tree, foreign Device,
  revoked/expired grant, cancellation and spawn/Git failure do not move the ref;
- response loss and restart return the same receipt without a second CAS;
- concurrent same-target operations serialize, while distinct repository/ref
  operations do not delete or overwrite each other's journals;
- success, failure, cancellation and concurrency leave no run-scoped temporary
  roots; three isolated full runs add none of `agentroom-*`, `agent-room-*`,
  `convenewire-*` or `convene-wire-*`.

Completion evidence records the focused commands, full Server/Bridge/schema/
build/E2E gates, exact before/after ref values, SQLite receipt/materialization
rows and isolated temporary-directory snapshots.

## Delivery Evidence

REPO-002 is delivered by commits `bbcc251`, `b00e7dd`, `4bb8cbe`, `f745b5d`,
`c3bd675`, `67c5c26`, `c589c98`, `48e34b8`, `5029f9a`, `e9938c0` and
`d6532dd`. Together they separate gate materialization from Run settlement,
retain exact human integration approvals and serialized Central operations,
enforce a distinct owner-local integration grant, execute atomic Git old-object
CAS, recover durable local outcomes, retain immutable IntegrationReceipts and
derive revision-local `integrated_commit` materialization for the existing
mechanical dependency resolver.

The successful Server acceptance starts with a `verified_output`
materialization, retains one exact approval and operation, authenticates one
successful receipt, restarts reconciliation and physically observes one
immutable integrated materialization. The downstream Run is scheduled only
then, and its Device-authenticated input endpoint returns the exact sealed bytes.
Changed approval content conflicts; SQL update/delete attempts fail; failed,
canceled and `outcome_unknown` receipts remain blocked across restart.

The real Git acceptance imports the sealed candidate without moving any shared
ref, validates its exact tree and strict fast-forward ancestry, rejects targets
checked out in any worktree, then uses `git update-ref <target> <candidate>
<expected>`. One verbose acceptance run recorded:

- SHA-1 `refs/heads/release`:
  `b594a9570d112d0033dad1c5d796d102ac8aef89` to
  `316761e97027d0f5df43f1eeffd7b347f9fff07e`, tree
  `490c3f5f4aede04069729baa7ac853a6215449d1`;
- SHA-256 `refs/heads/release`:
  `099d85e09a82304672363e34140dfb8fea4d189d5b05f806d50893f449fc3025`
  to
  `872036696664f25b0001f1ab2995b19c13bb0a7b474d6bb7950d1430c28f4dfb`,
  tree
  `266d2810a8fe5437ce523a73c7f324646fdae1c75466e8b1b23e4e5d7eda9eb7`.

Moved-target, non-fast-forward, wrong-tree, checked-out-target and canceled
cases leave the target and owner checkout unchanged. Two concurrent attempts
produce exactly one success and one moved-target result. A durable intent with a
lost Central response is looked up and replayed without a second CAS; restart
classifies exact candidate as success, exact expected as retryable and any third
object as `outcome_unknown`.

The final commands and results were:

- `npm test --workspace @convene-wire/server` — 503 tests passed, including
  physical SQLite/materialization/input-byte assertions.
- `npm run test:bridge` — every Bridge package passed, including real SHA-1 and
  SHA-256 repository integration and durable recovery.
- focused `go test -race` — repository integration, integration coordinator and
  integration admission passed; `go vet ./...` passed.
- `npm run test:e2e` — seven deterministic E2E cases passed; the opt-in live
  model case remained skipped and is not claimed.
- `npm run validate` — 11 schemas and 243 fixtures passed.
- `npm run build` — Server, Web and generated contract checks passed.
- `npm run test:temp-lifecycle` passed three consecutive outer runs, each with
  24 tests covering success, assertion failure, spawn failure, timeout, signals
  and parallel owners. Every owned run root printed a matching `cleaned` line.
- Read-only snapshots across `/private/tmp` and the macOS user temporary
  directory contained 64 pre-existing four-prefix directories both before and
  after acceptance: `added=[]`, `removed=[]`. REPO-002 did not scan, glob-delete
  or modify those unrelated paths.

This evidence closes owner-local exact-target integration and its
`integrated_commit` dependency proof. It does not claim remote publication or a
physical two-Bridge Git chain.

## Explicit Non-goals

This slice does not implement remote Git, push, pull requests, CI observation,
deployment, generation 2, plan supersession, automatic merge/rebase/conflict
resolution, scheduler autonomy modes, Web graph UX, physical two-Bridge Git
handoff or `sourceEvidenceAnchor` generalization. Those remain owned by
`REPO-003`, `QA-052`/`QA-053`, `EXEC-005` and later product work.
