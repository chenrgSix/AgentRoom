# EXEC-003: Accepted-Result Input Binding Increment

Date: 2026-08-31. Scope: the accepted-result branch of ADR-0036 EX-04.
This is partial execution-input evidence, not completion of EXEC-003 or the
software-team workstream. Delivery state remains solely in `docs/TASKS.md`.

## Implemented Boundary

Migration 0060 records immutable input bindings that pin an approved plan,
edge/output slot or exact external input, accepted source Result/review and
sealed Artifact, and the destination Task/Run/Agent/Device. Input freezing is
internal to the future admission transaction; its savepoint prevents a caught
later insert failure from leaving a partial binding set. Exact retries preserve
the original binding and issue time. Frozen manifests cannot acquire new grants.

The Device-authenticated content endpoint requires the exact active destination
Run and Device, current unarchived Room/Team, current ownership and assignment,
matching plan/source versions, expiry, and identical complete Run/Delivery
manifests with valid input and manifest digests. It verifies sealed content
bytes before returning them. Public responses contain no storage keys or paths.
There is no public grant-minting API and no expansion of ordinary Artifact reads.

Initial destination Artifact binding atomically records the supplied input
bindings with the canonical Artifact and sealed publication. These records are
immutable and cannot be added after bind. They identify supplied inputs, not
verified consumption or correctness. Destination Results and Artifact relations
still reject foreign-Task evidence; source acceptance is never copied.

## Verification

Run from the repository root, with task-owned `TMPDIR` and writable `GOCACHE`:

```sh
node --import tsx --test --test-reporter=spec --test-concurrency=2 \
  apps/server/test/execution-input-binding.test.ts \
  apps/server/test/migration-runner.test.ts \
  apps/server/test/hosted-agent-migration.test.ts
npm test
npm run build
npm run validate
npm run test:e2e
npm run lint:docs
git diff --check
```

The focused command passes 33 tests: 23 input/provenance cases and 10 migration
cases. The full root test command passes, including 424 Server tests, 252 Web
tests, 72 Node contract checks, generated/type consistency, Go contracts and the
repository's Bridge UI, QA-evidence, product-experience and site suites.
All-workspace build and validation pass for 11 schemas and 232 fixtures.
The existing 639.60 kB Web chunk warning is retained, not suppressed.
Markdown lint passes for 295 maintained files, and whitespace checks pass.

Deterministic cross-process acceptance passes seven cases with one explicitly
skipped live Codex/Pi case. These E2Es verify existing Server/Go Bridge
compatibility; they are not new governed execution or two-Bridge input staging
acceptance.

The new focused cases cover exact response replay/reopen; invalid selection and
source/control pins; external input selection; unavailable independent gates;
post-freeze grant rejection; substituted inner and outer manifests; legacy
Mention admission denial; unchanged ordinary content authorization; corrupt
sealed bytes; expiry, revoked Device and removed Room participant; archived
Room/Team; terminal Run; atomic multi-input rollback; destination-owned Artifact
provenance and bind replay; SQL immutability; preserved same-Task Result and
Artifact relations; and rollback/retry after canonical provenance failure.

## Review Findings and Repairs

This is the implementing agent's review, not independent review.

- Full outer Context Manifest equality is checked, not only its execution field.
- Direct Device input access now rejects archived Room and Team scopes; Device
  credential authentication alone does not establish active Room authorization.
- The Artifact rollback test originally installed a connection-private TEMP
  trigger. The HTTP application uses a separate connection, so no fault was
  injected. A durable trigger in the disposable database now exercises the real
  HTTP transaction; the test proves no canonical Artifact survives the failure
  and that the same sealed publication can subsequently bind once.
- The first root test invocation reached Go contracts but could not use the
  sandbox-protected shared Go build cache. A task-scoped cache was used for the
  complete successful rerun; no shared cache ownership or permissions changed.

## Acceptance Limits

Tests use real temporary SQLite, HTTP routes, source upload/seal/bind and human
Result acceptance. The destination Run is explicitly constructed as a future
admission-state fixture: only its insertion temporarily removes and restores
the production prerequisite trigger within one test transaction. No production
admission guard is weakened, no Runtime starts, and no unfinished capability is
advertised. Two authenticated Device identities are not two running Bridges.

Independent `verified_output` and `integrated_commit` gate resolvers require
VER-001 and REPO-002 and currently fail closed. Real Bridge input materialization,
isolated worktrees/local grants, governed Run dispatch, verification commands,
integration, product Web flows and QA-052 through QA-055 remain required. There
is no live provider, physical-platform, browser, CI/PR, deployment or Release
acceptance in this increment.
