# EXEC-007 Accepted-Result Dependency Runtime

Date: 2026-09-01

This record freezes the smallest dependency-bearing Graph Runtime increment.
Delivery state remains authoritative only in `docs/TASKS.md`. The increment
composes the delivered portions of EXEC-006, RUN-018, REPO-004 and EXEC-004; it
does not close full EXEC-003, VER-001 or repository integration.

## Target Outcome

One approved two-node plan advances without a Message command:

```text
implementation A --accepted_result--> implementation B
```

The scheduler dispatches A. A completes and remains `awaiting_result`. Its
governed capture produces a canonical checkpoint Artifact, the exact managed
Run proposes a Result that cites that Artifact, and a current human Owner
accepts the Result without completing the Task. Central retains one immutable
accepted-result materialization. A thin dependency resolver then selects that
exact Result/Artifact for B, and the existing governed admission transaction
calls `ExecutionInputService.freezeForRun()` before sealing B's manifest and
creating its ordinary Run. B's Device-authenticated input read returns the
exact sealed A bytes.

The first end-to-end edge uses a `patch` output/input. This is the only input
kind the existing production Bridge preparer currently loads and applies. A
captured `commit` remains a canonical possible output, but making a downstream
workspace start from a commit bundle would change local Git preparation
semantics and is not smuggled into this thin resolver increment.

## No New Materialization Subsystem

`ExecutionDependencyResolver` is a read-only selection adapter. For a
destination node it:

1. reads the approved inbound edges in deterministic graph order;
2. finds the exact predecessor node and its retained accepted-result
   materialization;
3. maps each approved `outputSlot` to its canonical checkpoint Artifact pin;
4. returns the existing `Selection[]` shape of `inputSlot`, `sourceResultId`
   and `artifactId`.

It does not validate current Result review authority, Artifact bytes,
destination Run scope, expiry, plan pins or manifest identity. Those checks
remain in `ExecutionInputService.freezeForRun()`, including its all-or-nothing
savepoint. The resolver never writes an input binding, stages a workspace,
starts a Runtime or interprets independent verification/integration receipts.

The Scheduler performs a read-only resolution for diagnosis and repeats it in
the final immediate admission transaction. Only the latter selection is
passed to `freezeForRun()`. A source change between those cuts rolls back the
trace Message, DispatchIntent, Run, bindings, manifest and workspace lease.

## Immutable Materialization Evidence

`execution_node_materializations` is one retained evidence record per exact
plan revision, node and gate. This increment supports only `accepted_result`
and generation 1. The record pins:

- plan ID/revision and predecessor node key;
- source DispatchIntent generation and Run;
- accepted Result ID/version and human review operation;
- sorted canonical checkpoint Artifact pins with output slot, revision, kind,
  content digest and byte length;
- a canonical materialization digest and the review timestamp.

The database accepts that record only when the source is the exact completed
managed Run for the node, the Result was proposed by that Agent/Run, the review
is accepted, and every retained pin is both Result evidence and an output of
the exact canonical repository checkpoint. All output slots consumed by an
outgoing `accepted_result` edge must be present. Records are immutable and an
exact replay returns the original evidence.

An accepted governed Result is now permitted only through that same narrow
source shape. It must not set `completeTask`; it cannot claim verification or
integration. Foreign Runs, member-authored substitutes, missing canonical
checkpoint outputs and stale node/Task pins remain rejected by database
constraints in addition to service authorization.

## Projection Ownership

The implementation corrects the earlier contract/code mismatch:

| Component | Ownership |
| --- | --- |
| `ExecutionNodeStateRepository` | CRUD only; it owns no scheduling or settlement interpretation |
| `ExecutionNodeProjector` | sole application mutation path for `execution_node_states` |
| Scheduler | candidate order, readiness evaluation and admission; asks the Projector to record readiness |
| Settlement | interprets authoritative Run/Result/capture facts, retains materialization evidence and asks the Projector to record Run settlement |
| Dependency resolver | read-only materialization-to-selection mapping |

Node state does not gain `succeeded` or `materialized`. A completed source Run
stays `awaiting_result`; after acceptance its blocker clears and the separate
materialization record satisfies eligible downstream edges. This preserves the
difference between a transient graph projection and immutable evidence.

Settlement selects generation 1 explicitly. This increment does not introduce
generation 2, automatic retry or an ambiguous multi-attempt join. A future
retry contract must first define the current-attempt pointer.

## Failure and Recovery Cuts

| Cut | Required result |
| --- | --- |
| A completed before Result acceptance | A is `awaiting_result`; B remains blocked; no materialization/input/Run for B |
| Result lacks the exact checkpoint Artifact | acceptance is rejected; no materialization or B admission |
| acceptance committed before reconciliation | restart derives one materialization and one B Run |
| materialization committed before B admission | restart reuses it and creates one B generation-1 intent |
| B admission fails after dependency selection | no B trace Message, intent, Run, input binding, manifest or lease |
| B intent committed before Delivery | restart replays the same B Run and frozen binding |
| repeated/concurrent schedulers | one materialization, one B input binding and one B Run |

## Decisive Evidence

The focused two-node acceptance must inspect physical SQLite rows and prove:

1. A is the only initial automatic Run and B is dependency-blocked.
2. A completion alone does not release B.
3. exact canonical capture, managed Result proposal and human acceptance retain
   one immutable materialization without completing A's Task.
4. B receives one system-traced DispatchIntent and a sealed manifest containing
   one exact `ExecutionInputBinding` whose provenance joins back through A's
   Result, checkpoint Artifact, Run and plan edge.
5. the Device-authenticated B input endpoint returns A's exact bytes and rejects
   a foreign Device/Run.
6. restart after acceptance, after materialization, after B intent and before B
   Delivery never duplicates A, B, materialization or input binding.
7. missing/stale/forged evidence, unsupported gates and an injected B admission
   failure remain fail-closed.

The relevant Server and Bridge input-client tests, full Server suite, workspace
build, schema validation and deterministic E2E suite must pass. Three isolated
temp-lifecycle runs must leave no new `agentroom-*`, `agent-room-*`,
`convenewire-*` or `convene-wire-*` directory.

## Completion Evidence

Migration 0066 and the focused Server acceptance now retain and inspect the
physical A-to-B chain. The test observes A as the only initial Run, keeps B on
`EXECUTION_DEPENDENCY_NOT_MATERIALIZED`, rejects acceptance without the exact
checkpoint Artifact, and then joins the accepted managed Result and human
review to one immutable materialization. It injects an input-binding failure
and proves that B has no Message, intent, Run or binding, then separately
injects a Delivery failure after B's intent and frozen binding commit. Restart
replays that same B Run, whose sealed manifest pins the exact edge, slots,
Result, Artifact revision, digest and byte length. The Device endpoint returns
the captured patch bytes byte-for-byte and rejects the wrong Run and an invalid
Device credential. Final SQLite counts remain one materialization, one B
intent and one input binding; the source Task has no completion Result.

The following final gates passed on 2026-09-01:

- `npm test --workspace @convene-wire/server`: 495 passed, zero failed; the
  owned `/private/tmp/convene-wire-test-run-9v64sV` root was deleted.
- `node --import tsx --test ...governed-run-admission.test.ts`: the focused
  accepted-result chain and unsupported `verified_output` resolver boundary
  passed, including immutable-row and physical-byte assertions.
- `go test ./internal/admission ./internal/repository` under the shared owned
  runner: both Bridge packages passed and
  `/private/tmp/convene-wire-test-run-baUCiQ` was deleted.
- `npm run validate && npm run build`: 11 schemas and 243 fixtures validated;
  Server, Web and generated contract builds passed.
- `npm run test:e2e`: seven deterministic scenarios passed, zero failed, and
  the explicitly live Codex/Pi scenario was skipped; its owned run root was
  deleted.
- `npm run test:temp-lifecycle` ran three times with
  `CONVENE_WIRE_TEST_RUN_BASE=/private/tmp/exec007-isolated-PVbF1KyZ`;
  each run passed 24 assertions including success, assertion failure, spawn
  error, timeout, signals, nesting and parallel ownership. The final physical
  snapshot of that isolated base was empty before the base itself was removed.

No result above claims independent verification, repository integration,
commit-bundle preparation, live-model acceptance or a physical two-Bridge
accepted-result handoff.

## Explicit Remainder

This increment does not implement `verified_output`, `integrated_commit`,
VerificationReceipt, repository integration, commit-bundle input preparation,
generation 2, scheduler modes, plan supersession, Web graph UX, a live model or
a physical two-Bridge Git acceptance. EXEC-003 remains blocked on its complete
multi-gate/two-Bridge outcome even when this bounded accepted-result branch is
done.
