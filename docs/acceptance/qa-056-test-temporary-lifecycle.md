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

Pending implementation-start capture. The reproduction will run one known
leaking Server test below a unique repository-local outer `TMPDIR`, record the
remaining directory and remove only that exact owned outer root.

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

Pending reviewed implementation.

## Verification evidence

Pending focused, full-suite and physical-directory acceptance.

## Direction audit

Pending requirement-by-requirement post-implementation review.
