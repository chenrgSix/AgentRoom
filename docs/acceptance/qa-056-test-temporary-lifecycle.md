# QA-056 Test temporary lifecycle

## Scope

QA-056 repairs test-owned temporary directories and caches. It does not delete
pre-existing artifacts, introduce a global sweeper, change production storage
or claim that `SIGKILL` can be trapped.

The accepted architecture is ADR-0037. Completion requires both behavioral
tests and physical directory evidence.

## Pre-implementation inventory

| Entry class | Current evidence | Required repair |
| --- | --- | --- |
| Repository test commands | Root and workspace scripts directly invoke npm, Node, tsx and Go tests | One outer owner with nested-root reuse |
| Node temporary directories | 110 `mkdtemp` call sites in 79 files | Contain below the run root; fixture creators immediately register cleanup |
| Go test directories | 282 `t.TempDir` calls in 59 files | Retain Go cleanup and inherit the run root for process cancellation |
| Go/npm/Node caches | No repository lifecycle owner; retained roots contain independent caches | One cache set below the run root with `-modcacherw` |
| E2E child processes | Some processes are registered only after readiness or lack forced termination/exit observation | Immediate ownership and bounded stop escalation |
| Shell temporary roots | Five `mktemp -d` scripts trap only `EXIT`; one installs the trap late | Immediate `EXIT INT TERM` ownership |

The direct current-checkout prefixes are predominantly `convene-wire-*`.
Acceptance retains all four historical/current patterns:

- `agentroom-*`
- `agent-room-*`
- `convenewire-*`
- `convene-wire-*`

## Controlled reproduction

Before implementation, a unique repository-local outer directory was assigned
to `TMPDIR`, `TEMP` and `TMP`, and only `apps/server/test/app.test.ts` was run.
The test passed, but the outer directory still contained:

- `convene-wire-api-yt7TlV/server.sqlite` and `artifact-blobs/`;
- 120 compiled entries below `tsx-501/`; and
- 3.4 MiB total retained bytes.

The exact outer reproduction root was then removed and verified absent. No
global temporary directory was scanned or deleted as part of reproduction.

## Required regression matrix

| Scenario | Required terminal evidence | Required physical evidence |
| --- | --- | --- |
| Success | child exit 0 is preserved | exact run root is absent |
| Assertion failure | expected non-zero exit is preserved | exact run root is absent |
| Spawn failure | runner reports missing executable | exact run root is absent |
| Timeout | child tree is terminated and timeout is reported | exact run root is absent |
| Cancellation | `SIGINT` and `SIGTERM` settle the owned child tree | exact run root is absent |
| Parallel owners | unique roots and no cross-run deletion | terminating one leaves the other root intact until its owner exits |
| Foreign sibling | unrelated directory is never selected | sentinel remains byte-for-byte intact |
| Three consecutive runs | all three invocations meet their exit contract | no new four-pattern directory in the isolated or real-location snapshots |

## Implementation evidence

| Leak entry | Owning repair |
| --- | --- |
| Root `test:*`, E2E, QA, site, Bridge UI and disposable preview commands | `scripts/test/run-with-temp-root.mjs` creates or validates one owner; root and workspace `package.json` entrypoints reuse it |
| Per-test SQLite/workspace directories | All 110 Node call sites inherit `TMPDIR` below the run root; `scripts/test/resources.mjs` additionally owns helper-created directories and runs LIFO cleanup before checking physical absence |
| Server fixture helpers that returned unowned paths | Hosted Agent registry/migration/configuration, migration runner, Team/Room, auth, repository, device revocation, Run consistency, cancellation, Artifact publication, Bridge WebSocket, Discussion orchestration and Task Result fixtures now accept `TestContext` and register database/app/socket cleanup at creation |
| QA evidence fixture | `scripts/qa/capture-two-machine-onboarding-evidence.test.mjs` uses the shared resource owner |
| E2E directories, Bridge processes, Console and fault proxy | All six files below `tests/e2e/` use `createTestResources`; `scripts/test/child-process.mjs` owns the POSIX process group or Windows process tree before readiness and escalates `SIGTERM` to forced termination |
| Raw Go test paths outside inherited `TMPDIR` | Darwin IPC/native URL fixtures and the Artifact materializer non-regular-file fixture now use short names below inherited `os.TempDir()` with `t.Cleanup` |
| Go, module, npm and Node compile caches | One `cache/{go-build,go-mod,npm,node-compile}` set is exported per outer run; nested runners reuse it; `GOFLAGS` preserves existing flags and adds `-modcacherw` once |
| Release verification/package, Central image and Compose backup shell temporary resources | Six scripts install exact-path `EXIT`, `INT` and `TERM` cleanup before `mktemp`; cleanup failure changes an otherwise successful result to failure |
| Disposable product preview | Signal handlers are installed before its directory is created, app close and directory removal are idempotent, and the public command runs under the owner so `tsx-*` is also reclaimed |
| Lifecycle regression processes themselves | Runner-under-test processes use the same resource/process owners, so a regression assertion cannot strand its own child |

The outer owner records root real path, device, inode and an unpredictable token
in `.owner.json`. Cleanup revalidates all four values and deletes that exact
path only. There is no prefix discovery, startup scan, age-based selection,
timer or global `chmod`.

## Verification evidence

### Focused lifecycle matrix

`npm run test:temp-lifecycle` passes 24 tests. The suite physically verifies:

- success and expected assertion failure remove the exact root;
- a missing executable reports spawn failure and removes the exact root;
- timeout kills the parent and grandchild before root removal;
- `SIGINT` and `SIGTERM` remove both process trees and shell roots;
- a `SIGTERM`-ignoring tree is escalated to `SIGKILL` and awaited;
- a grandchild is removed even after its original parent exits;
- two parallel owners retain distinct roots and cannot delete each other;
- an unowned sibling sentinel remains unchanged; and
- helper and explicit cleanup are idempotent and ordered before directory
  removal.

One first acceptance attempt exposed a partial-JSON read race in the regression
harness. The outer runner still removed
`/private/tmp/convene-wire-test-run-Mdx7Lo`; the harness was then repaired to
wait for complete JSON and to own its runner-under-test process. The completed
acceptance count restarted after that repair.

Three subsequent, consecutive invocations exited 0 and physically removed:

- `/private/tmp/convene-wire-test-run-AFFzUd`;
- `/private/tmp/convene-wire-test-run-17wpJH`; and
- `/private/tmp/convene-wire-test-run-9PBaXh`.

A 2026-09-01 revalidation exposed one additional macOS process-group edge. The
first two outer lifecycle invocations passed, while the third received
`EPERM` from `kill(-pgid, 0)` after the original process-group leader exited.
POSIX uses that result to report that the group still exists but cannot be
probed; treating it as a cleanup exception skipped the remaining forced-stop
path. The outer owner still removed its exact run root, so this failure left no
physical residue. The process helper now treats only this zero-signal `EPERM`
as existence and continues the existing owned `SIGTERM`/`SIGKILL` convergence;
it never selects another PID or path.

After that repair, a fresh acceptance count passed all 24 lifecycle tests three
consecutive times and physically removed the exact roots ending `f8uyqW`,
`MYbyvw` and `JqbBde`. The dedicated acceptance base was empty after every run
and removed by its `EXIT INT TERM` trap. Read-only before/after snapshots of
both `/private/tmp` and the canonical macOS user temporary directory remained
at zero entries for all four accepted prefixes.

### Focused and full gates

| Command | Result | Physical evidence |
| --- | --- | --- |
| `npm run test --workspace @convene-wire/server` | 477 passed | `convene-wire-test-run-JpRUmH` removed |
| `npm run test:e2e` | 7 passed, live Runtime test skipped by its explicit opt-in | `convene-wire-test-run-un5oeO` removed; Bridge, Console and proxy processes settled |
| `npm run test:bridge` | all Bridge packages passed, including the current admission/repository worktree | `convene-wire-test-run-BkwHNC` removed |
| owner-wrapped focused Artifact test | passed | `convene-wire-test-run-SKMWh2` removed |
| owner-wrapped desktop-tag Go test | passed | `convene-wire-test-run-1SgRb7` removed |
| `npm test` | Server, Web, contracts, Bridge UI, QA evidence, product experience, site and 24 lifecycle tests passed | outer `convene-wire-test-run-hSmiCy` removed after all nested commands reused it |
| isolated `preview:product-experience`, then `SIGINT` | both loopback servers started; signal cleanup completed | isolated base empty; inner `convene-wire-test-run-hmsVco`, preview SQLite directory and `tsx-501` absent |
| `bash -n` on all six changed shell scripts | passed | dynamic shell tests also proved success, failure, `SIGINT` and `SIGTERM` absence |

### Real-location before/after snapshot

Immediately before final acceptance, a read-only top-level snapshot recorded
196 matching entries in `/private/tmp` and 545 in the canonical macOS user
temporary directory. After three lifecycle runs, `npm test`, deterministic E2E
and the full Bridge suite, the exact sets were unchanged:

| Location | Before | After | Added | Removed |
| --- | ---: | ---: | ---: | ---: |
| `/private/tmp` | 196 | 196 | 0 | 0 |
| macOS user temporary directory | 545 | 545 | 0 | 0 |

The snapshot matched all four prefixes. No existing entry was deleted, and no
accepted command left a physical run root or cache directory.

## Direction audit

| Requirement | Final evidence |
| --- | --- |
| No global sweeper | No cleanup code enumerates `/private/tmp`; the only enumeration is the read-only acceptance snapshot |
| One run root and one cache set | Owner environment and nested marker validation are regression-tested; `npm test` demonstrates nested reuse |
| Go cleanup conventions | Existing `t.TempDir`/`t.Cleanup` remain; three fixed short-path tests no longer bypass inherited `TMPDIR`; production `MkdirTemp` flows retain immediate defers/owned closers |
| Directory-creating helpers own cleanup | Shared helper requires `TestContext`; migrated fixture and E2E helpers register cleanup before fallible setup/readiness |
| Shell `EXIT INT TERM` | All six production scripts are statically checked and the common behavior is physically exercised for all terminal classes |
| Failure, timeout and cancellation | Assertion, spawn failure, timeout, `SIGINT`, `SIGTERM`, forced kill and orphaned-descendant cases all assert absence |
| Shared removable caches | Every supported public test entry exports run-local cache paths and `-modcacherw`; no shared cache permission is changed |
| Parallel isolation | Two owners have different roots; terminating one preserves the other's root and live process |
| Exact deletion authority | Node owners verify path, token, device and inode; shell scripts use only their exact assigned variable; foreign sentinel survives |
| Physical, not exit-only, completion | Every scenario checks `ENOENT`; real-location set difference is zero after full acceptance |

The implementation remains a test/QA lifecycle change. It does not alter
Discussion/Wave semantics, wire contracts, production storage or Runtime
authority. No requirement was weakened to a green exit code alone.
