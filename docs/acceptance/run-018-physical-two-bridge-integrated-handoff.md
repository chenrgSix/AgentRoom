# RUN-018 Physical Two-Bridge Integrated Handoff

Date: 2026-09-02

## Verdict

The frozen
[RUN-018 physical two-Bridge goal](run-018-physical-two-bridge-integrated-handoff-goal.md)
is accepted on native macOS arm64. One real Central process and two real Go
Bridge processes completed the exact local proof-carrying dependency chain:

```text
Bridge A governed Run
  -> isolated Git worktree
  -> canonical candidate checkpoint and proposed Result
  -> independent verification receipt
  -> exact-target Git compare-and-set
  -> immutable IntegrationReceipt
  -> integrated_commit NodeMaterialization
  -> exact destination input binding
  -> Bridge B governed Run with the integrated bytes
  -> downstream checkpoint and proposed Result
  -> owner-confirmed exact worktree cleanup
```

This evidence closes `RUN-018`, `EXEC-003`, `BRG-071` and `REPO-001`. It does
not close `EXEC-004`, `QA-052`, `QA-053` or start `REPO-003`.

## Delivered Boundary

The delivery is the combined result of commits `739e691`, `2594dee`,
`2122b1e`, `442aacb`, `4782cf1`, `eaaccb2`, `0a6734f`, `9e38a2e`, `a9fb27d`,
`d44d2aa`, `91fbae8`, `1ee89a8` and `91726e4`.

- Required predecessor bytes are frozen at governed preparation and repeated
  unchanged at the possible-start check. A changed, missing or reordered input
  cannot reach Runtime invocation.
- Managed Codex execution starts a fresh native thread in the exact prepared
  worktree. It does not borrow an ordinary Task conversation or silently fall
  back to a source checkout.
- Bridge capability and delivery identity use the canonical
  `execution_scheduler` wire sender. A migration removes only pending legacy
  scheduler projections; terminal history is retained.
- A separate exact owner-local `integrate` grant authorizes only its reviewed
  repository, binding, target ref, expected commit and verification profile.
- The loopback owner Console exposes only path-free governed inventory. Exact
  Task-grant revocation drains the managed worker and fences its process group
  before retaining the irreversible tombstone, then re-inspects authority
  before any restart.
- Cleanup has a distinct local grant, path-free preview digest and exact
  stopped-Run/process/checkpoint/binding join. It deletes only the owned
  worktree and ref, retains a replay-safe receipt and never scans by a global
  prefix.
- Governed grant timestamps remain exact wire strings. Generated Go Bridge
  capability types no longer normalize fractional UTC precision through
  `time.Time` serialization.

The timestamp correction was required by physical acceptance. Before the fix,
a grant retained as `2026-09-02T01:52:25.250Z` was advertised as
`2026-09-02T01:52:25.25Z`. Both strings denote the same instant, but the
execution identity intentionally binds exact approved bytes, so Bridge A
correctly rejected the changed grant with `GOVERNED_ADMISSION_DENIED`. The
physical test now deliberately uses a `.250Z` grant and passes only when that
exact string survives the generated Bridge capability round trip.

## Physical Success Evidence

`tests/e2e/governed-two-bridge-integration.test.ts` creates one disposable real
topology under the owned test root:

- one Central process with an actual SQLite database;
- two Bridge binaries, Device identities, data roots, Agents, repository
  bindings, Runtime profiles and grants;
- two independent source checkouts and Bridge-owned isolated worktrees; and
- one actual Git repository, candidate object graph and owner-selected
  `refs/heads/integrated` target.

The test physically observes all of the following:

1. Bridge A completes its governed Run and produces one canonical candidate
   checkpoint and one proposed Result.
2. An independent verifier produces a passed receipt. Central restart retains
   the same `verified_output` materialization digest.
3. Exact human integration approval and the separate integration grant permit
   one atomic target update from the approved base to the verified candidate.
4. The source checkout `HEAD`, tree, file bytes and clean status remain at the
   base; only the selected target ref advances.
5. Central retains exactly two DispatchIntents, two completed Runs, two
   proposed Results, two passed verification receipts, one successful
   IntegrationReceipt, one `integrated_commit` materialization and one exact
   destination input binding, with no foreign-key violations.
6. Bridge B receives the frozen integrated bytes, proves their exact content,
   writes its downstream output, captures a second checkpoint and proposes its
   Result.
7. Each owner previews and confirms only its own stopped worktree. Both paths
   disappear physically; exact replay returns the original cleanup receipt.
   Both source checkouts and their original file bytes remain clean and intact.

The complete deterministic E2E suite passed eight cases with one explicit
live-provider case skipped. The physical integrated dependency is therefore
part of the ordinary deterministic suite, not a manually interpreted fixture.

## Failure and Recovery Evidence

The physical success path is backed by production-boundary regressions for the
required cuts:

| Cut | Physical fact or focused regression | Accepted result |
| --- | --- | --- |
| Grant revoked after preparation | `TestGovernedCoordinatorFailsClosedBeforePossibleStart/grant revoked after preparation` | `invoke=false`, no possible start and no Runtime process authority |
| In-flight owner revocation | `TestGovernedOwnerConsoleProjectsPathFreeStateAndStopsBeforeIrreversibleRevocation` and `TestGovernedProcessStoreFencesLiveInheritedProcessGroupAfterRestart` | worker/process group stops before tombstone; revoked grant cannot authorize a replacement writer |
| Moved or invalid target | `TestIntegrateExactTargetFailsClosedWithoutMovingRef` | selected and unrelated refs and owner checkout remain physically unchanged |
| Concurrent target attempts | `TestIntegrateExactTargetConcurrentAttemptsCannotOverwrite` | exactly one atomic winner; no overwrite |
| Cancellation before CAS | `TestIntegrateExactTargetCanceledBeforeCASLeavesTargetUntouched` | target remains at the expected commit |
| Lost integration response | `TestClientGetsExactAdmissionAndRecoversLostReceiptResponse` | exact receipt lookup; no second CAS |
| Bridge restart after intent/effect | `TestIntegrationJournalRetainsExactIntentAndReceiptAcrossRestart` and `TestGovernedIntegrationCoordinatorRecoversExactIntentWithoutBlindRetry` | candidate, expected and third-object observations classify success, retryable or `outcome_unknown` without guessing |
| Possible-start restart | `TestGovernedRecoveryFencesPossibleStartBeforeClosingInboxUnknown` and `TestGovernedRecoveryNeverClosesFenceUntilProcessAbsenceIsProved` | process absence is proved before durable unknown settlement |
| Runtime cancellation | `TestHandlerCancelsDuringPreparationWithoutRuntimeOrVerifiedReceipt` and cancellation-replay regressions | no Runtime/capture proof is fabricated; exact tombstone survives retry |
| Verifier failure, timeout, cancel and spawn error | `TestRunnerClassifiesPassFailureTimeoutAndCleansOwnedRoot`, `TestRunnerCancellationCannotPass` and `TestRunnerSpawnFailureRetainsFailureEvidenceAndCleansOwnedRoot` | no passed receipt; owned verifier root is removed |
| Parallel owners | `TestHandlerSerializesOneAgentWhileOtherAgentsRemainParallel` and repository owner-exclusion tests | one Agent is serialized while distinct owners remain independent |
| Cleanup replay/restart/live writer | repository cleanup and cleanup-authority suites | only the exact stopped worktree/ref is retired; changed or live state fails closed |

The admission, repository, integration, Console and delivery packages all pass
under Go's race detector. This includes the actual Unix inherited process-group
fence and real Git repository tests.

## Temporary-Directory Evidence

Three consecutive physical handoffs ran beneath one isolated parent:
`/private/tmp/run018-three-run.BGEObo`. Every run used a distinct owned
`convene-wire-test-run-*` directory and emitted its matching cleanup record.

| Run | Before | Test | After |
| --- | ---: | --- | ---: |
| 1 | 0 | passed in 25.45 s | 0 |
| 2 | 0 | passed in 25.18 s | 0 |
| 3 | 0 | passed in 26.69 s | 0 |

The counts include all four historical prefixes:
`agentroom-*`, `agent-room-*`, `convenewire-*` and `convene-wire-*`. The final
isolated-parent listing was empty. The parent itself was then removed by its
own `EXIT INT TERM` trap.

The ordinary lifecycle suite also passed all 24 assertions covering success,
assertion failure, child startup failure, timeout, `SIGINT`, `SIGTERM`, orphaned
process groups, nested runners, parallel owners and three consecutive
four-prefix runs. These tests use isolated temporary bases and never inspect or
delete unrelated user `/private/tmp` content.

## Final Commands and Results

Tested host: macOS 26.6.2, Darwin 25.6.0, arm64, Node.js 22.23.1 and Go 1.26.7.

- `npm test` passed the complete workspace matrix. Server passed 504/504; Web,
  Bridge UI, QA evidence, product experience, site and all 24 temporary
  lifecycle assertions passed. The owned root printed its matching cleanup.
- `npm run test:e2e` passed 8 deterministic cases with 1 explicit live-provider
  skip. Its owned root printed its matching cleanup.
- `npm run test:bridge` passed every Bridge package with one invocation-scoped
  Go cache/module cache root and a matching cleanup record.
- `go test -race ./internal/admission ./internal/repository
  ./internal/integration ./internal/console ./internal/delivery` passed all five
  concurrency-sensitive packages.
- `go vet ./...` passed for the Bridge module using a disposable writable module
  cache with `GOFLAGS=-modcacherw`.
- `npm test --workspace @convene-wire/contracts` passed 80/80 Node contract
  tests plus the generated Go tests, including exact fractional UTC round trip.
- `npm run validate` validated 11 schemas and 243 fixtures.
- `npm run build` built Server and Web and confirmed generated TypeScript/Go
  contracts are current.
- `npm run lint:docs` reported 0 issues; `git diff --check` passed.

## Honest Boundary

This acceptance does not claim native Windows or Linux physical execution,
multiple physical computers, a live Codex/Pi provider call, remote Git fetch or
push, pull requests, provider webhooks, remote CI, generation-2 retry, plan
supersession, scheduler autonomy modes or `sourceEvidenceAnchor`
generalization. The tested two-Bridge topology uses two independent real Bridge
processes and Device/data/worktree owners on one native macOS host.

`REPO-003` remains deferred. Before remote CI or PR observations are admitted,
the repository still needs the planned source-evidence authority decision so a
CI producer is not forced to fabricate an Agent Result.
