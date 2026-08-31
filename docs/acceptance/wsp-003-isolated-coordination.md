# WSP-003: Isolated Attempt Coordination

Date: 2026-08-31. Scope: the central workspace coordination portion of ADR-0036
EX-06, not actual local worktree creation or Runtime enforcement. Delivery state
remains solely in `docs/TASKS.md`.

## Implemented Boundary

Migration 0061 and `IsolatedWorkspaceLeaseService` provide internal admission
and Repository-operation ports. Each ordinary Run and each plan revision/node/
dispatch generation can reserve only one immutable path-free attempt identity.
The identity is distinct from the Agent's configured source workspace and is
never reassigned after expiry, release or revocation. Reservation must share the
caller's Run-admission transaction and binds the exact generated execution
manifest, plan approval, repository, scope, profiles, outputs and grant snapshot.

Admission checks current Room/Team, root/child Task ownership, Agent assignment,
Device ownership, Run state/deadline and the active Bridge connection capability.
Preventive per-path requirements cannot fall back to a workspace-only boundary.
Use requires the exact frozen canonical Run manifest and current authorization.

The reservation is immutable. Generation advance and lease closure use an
append-only operation log with actor/payload fingerprints, monotonic revisions,
expected-generation CAS and original response-loss receipts. An earlier
generation cannot be reused. Revocation and release cannot be undone. These
operations neither change Run state nor acknowledge ambiguous execution, free
Run capacity, grant local permissions or authorize deleting a worktree.

## Verification

Executed from the repository root with a task-owned `TMPDIR` and `GOCACHE`:

```sh
node --import tsx --test --test-reporter=spec --test-concurrency=2 \
  apps/server/test/isolated-workspace-lease.test.ts \
  apps/server/test/execution-input-binding.test.ts \
  apps/server/test/migration-runner.test.ts \
  apps/server/test/hosted-agent-migration.test.ts
npm run test --workspace @convene-wire/server
npm run test:e2e
npm run build
npm run validate
npm run lint:docs
git diff --check
```

The combined focused run passes 48 tests: 15 new isolated-coordination tests,
23 input/provenance tests and 10 migration tests. Full Server regression passes
439 tests. The final Server suite also covers the added old-operation replay
assertion after a subsequent generation has committed. Seven deterministic
cross-process E2Es pass; the live Codex/Pi case is explicitly skipped.
All-workspace build and 11-schema/232-fixture validation pass. The existing Web
bundle-size warning is unchanged.

The new tests prove immutable identity and reopen, transactional reservation
rollback, exact plan/scope/grant/time pins, current capability downgrade and
unsupported operations, preventive-path rejection, unique dispatch generation
and different-attempt workspace identities, exact CAS/replay and ABA rejection,
current archived Room/Team, removed participant and changed Task definition,
irreversible release/revocation, expiry/foreign/revoked Device denial, and
preservation of `outcome_unknown`.

Concurrency is not a pair of synchronous calls labeled parallel. Two independent
Node processes open the same real SQLite database, wait behind a parent barrier,
and compete to advance the same lease revision. Exactly one commits revision 2;
the other receives `WORKSPACE_GENERATION_CONFLICT`. Both processes exit before
fixture cleanup; failure cleanup is registered before database cleanup and the
test has a bounded timeout.

## Implementation Review

This is the implementing agent's review, not independent review. It checked
that fixed identity and live generation are separate, original receipts survive
later operations, expired/revoked leases cannot be revived, generation reuse
cannot defeat stale-operation fencing, and a closed lease is not evidence of a
stopped process. Attempt-number uniqueness and active-Task lifecycle rules were
preserved while correcting test setup: later fixture Runs get a new canonical
attempt number, and definition drift is tested through the actual definition
API instead of pretending an active Task can be canceled directly.

The owning task now explicitly depends on exact plan approval because reservation
validates its persisted approval and compiled Task pins. No dependency or
acceptance gate for local isolation has been removed.

## Limits and Downstream Integration

These tests use actual Server approval/Task APIs, SQLite and competing OS
processes. A queued governed Run and the Bridge capability are explicit future
admission-state fixtures. The production Run prerequisite is restored inside
the test transaction; the production Bridge still advertises no unfinished
governed execution capability.

The internal ports are not yet called by a production governed scheduler or
Repository adapter. Their hookup belongs to RUN-018/EXEC-004 and REPO-001.
There is no new public lease-minting/generation API, Git worktree, local grant
enrollment, OS sandbox, provider invocation, artifact apply or cleanup operation
in this component. Local grant authentication/revocation and enforcement remain
mandatory in BRG-071. Actual Git, Runtime, cross-Bridge, browser and provider
acceptance remains required by the cumulative QA-052 through QA-055 gates.
