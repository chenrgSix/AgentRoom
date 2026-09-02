# QA-052 Controlled Single-Repository Product Loop Goal

Date: 2026-09-02

Status: accepted on 2026-09-02. `QA-052` is complete at the bounded topology
and non-goals recorded below.

## Goal

Join the accepted product-entry authorities to the accepted RUN-018 physical
execution chain in one deterministic cross-process acceptance:

```text
Human root Task
  -> decision_record Discussion through real Bridge delivery
  -> immutable Discussion-authored plan revision 1
  -> assigned manual Tech Lead Run and Remote MCP revision 2
  -> exact human plan approval and compiled execution graph
  -> Bridge A governed implementation in an isolated worktree
  -> canonical Result/checkpoint and independent verification
  -> exact-target compare-and-set integration
  -> integrated_commit materialization and sealed dependency input
  -> Bridge B governed implementation from those exact bytes
  -> downstream Result/checkpoint and owner-confirmed cleanup
```

The test proves that accepted component boundaries compose. It does not move
Discussion, Agent text, the browser or an Agent role label into execution,
verification or repository authority.

## Required Topology

One owned run root contains:

- one actual Central child process and SQLite database;
- two actual Go Bridge processes with distinct Devices, data roots, Agents,
  repository bindings, grants and Runtime/verifier profiles;
- two independent source checkouts and only Bridge-owned isolated worktrees;
- one actual Git object graph and owner-selected integration ref;
- one separate manual Agent credential and primary root-Task assignment for the
  Tech Lead MCP step; and
- one deterministic local Codex app-server fixture. It crosses the production
  Bridge protocol and process boundaries but has no network/model credential
  and is not live-provider evidence.

All paths, build/module caches, process groups and databases belong to the
outer task-scoped temporary runner. The acceptance never inspects or deletes a
global temporary prefix.

## Product-Entry Authority

The physical test must prove all of these facts in order:

1. The Owner creates one root Task, gives one manual Agent the current primary
   assignment and admits the two Bridge Agents to the same Room.
2. A real `decision_record` Discussion sends at least one ordinary Wave through
   the authenticated Bridge delivery/Runtime path. Explicit human `finish`
   starts the finalization Run; only its exact final-line closed envelope may
   retain the immutable Discussion-authored draft.
3. The draft has revision 1, Discussion/final-Message source pins, no approval,
   no compiled execution node and no repository effect.
4. A separate Message creates the assigned manual Tech Lead's own Run. The
   Agent claims it through Remote MCP, reads the Discussion plan and revises it
   through `team.propose_plan_revision` using the exact current Run manifest,
   root revision and source context. Replaying the same operation returns the
   same revision; a role label or another Run is not used.
5. The Owner submits the same digest/revision/root-pinned command exposed by the
   accepted Web surface. The first response is deliberately discarded and an
   exact retry returns one immutable approval receipt and one compiled graph.
   No browser-side projection is treated as authority.

The test reads the Task-scoped plan list and approval history from the public
Server surfaces after these operations. Direct repository calls or SQLite
writes may inspect evidence, but they cannot create or advance the product
facts under test.

## Physical Execution Authority

After exact approval, the existing RUN-018 production path remains intact:

- Scheduler/Settlement admit Bridge A only after the current repository grant,
  Runtime profile, plan, Task and workspace generation rejoin.
- Bridge A changes only its isolated worktree, publishes a canonical candidate
  and proposed Result, and an independent verifier produces the only
  `verified_output` authority.
- Human integration approval plus a distinct owner-local integration grant
  permit one target update only when the selected ref still equals its approved
  expected commit. No merge, rebase, reset, push or source-checkout mutation is
  allowed.
- The immutable IntegrationReceipt produces the only `integrated_commit`
  materialization. Bridge B starts only from the exact sealed binding and
  proves the integrated bytes before extending them.
- Both source checkouts remain at their original `HEAD`, tree, content and clean
  status. Owner-confirmed cleanup removes only each stopped worktree/ref and
  exact replay returns the retained cleanup receipt.

## Interruption, Response-Loss and Replay Cuts

The same product E2E includes these cuts rather than relying only on component
tests:

| Cut | Required observation |
| --- | --- |
| Tech Lead revision response loss | exact MCP operation replay returns revision 2; no revision 3 |
| human plan-approval response loss | exact command replay returns one receipt and one compiled graph |
| Central restart after verification | identical retained verified materialization is recovered before integration |
| integration response loss | repeated exact Bridge execute returns the same successful receipt and does not move the ref twice |
| cleanup response replay | repeated exact cleanup commands return the retained receipts after both paths are physically absent |

Focused Server/Go regressions remain responsible for malformed envelopes,
foreign/stale Tech Lead authority, failed verifier/spawn/timeout/cancel,
moved-target CAS conflict, concurrent integration, revocation, possible-start
ambiguity and process-group fencing. The full workspace and E2E suites keep
ordinary Message, default Task, human Result review, Hosted and existing Bridge
flows in regression scope.

## Physical Evidence and Completion

`QA-052` may become `DONE` only when the retained test inspects, at minimum:

- one completed Discussion with one finalization Message and exactly one plan;
- two plan revisions, one human approval and the expected compiled node/edge
  graph;
- two governed DispatchIntents, two completed governed implementation Runs and
  two proposed Results, separately from Discussion and Tech Lead Runs;
- the expected passed VerificationReceipts, one successful
  IntegrationReceipt, one `integrated_commit` materialization and one exact
  Bridge-B input binding;
- exact candidate/integrated/downstream file bytes, source checkout identities,
  target ref and `PRAGMA foreign_key_check = []`; and
- both worktree paths and the outer run root physically absent after shutdown.

The focused QA-052 test runs three consecutive times under an isolated
`CONVENE_WIRE_TEST_RUN_BASE`; each owned run then sets its child `TMPDIR` below
that exact run root. Before and after each run, the isolated base contains no
newly retained `agentroom-*`, `agent-room-*`, `convenewire-*` or
`convene-wire-*` directory. Full Server/Web/contracts/Bridge tests,
deterministic E2E, schema validation, builds, Go race/vet, documentation lint
and `git diff --check` remain final gates.

## Non-goals and Honest Boundary

- no paid or live Codex/Pi/provider call;
- no multiple physical computers, native Windows/Linux execution or Release
  admission;
- no remote Git fetch/push, pull request, webhook or remote CI observation;
- no `sourceEvidenceAnchor` generalization; `GOV-026` follows this acceptance;
- no automatic scheduler mode, automatic retry, broader graph capacity,
  parallel-coding claim, plan supersession or dynamic replanning; and
- no claim that HTTP automation is browser acceptance. WEB-063 separately
  owns and has retained the real production-browser control-surface evidence.

The accurate claim on completion is a full controlled product loop using one
native macOS host, one real Central, two real Bridge processes, distinct local
owners/worktrees, real Git/SQLite/process effects and a deterministic synthetic
Runtime provider.

## Retained Acceptance Evidence

The retained cross-process test is
`tests/e2e/governed-two-bridge-integration.test.ts`. It starts one actual
Central and two actual Go Bridges, runs one ordinary two-Agent Discussion Wave
plus finalization, resumes the selected Agent's retained Codex logical thread,
and accepts only a compact single-line plan envelope. It then executes the
assigned manual Tech Lead MCP Run, exact human approval, both governed
implementation Runs, independent verification, exact-target CAS integration,
sealed downstream input and owner-confirmed cleanup.

The final SQLite inspection retained exactly:

- one completed Discussion and three completed Discussion/finalization Turns;
- two plan revisions, one approval, two compiled nodes and one compiled edge;
- one completed Tech Lead Run, two DispatchIntents, two completed governed
  implementation Runs and two proposed Results;
- two passed VerificationReceipts, one successful IntegrationReceipt, one
  integrated materialization and one destination input binding; and
- an empty `PRAGMA foreign_key_check` result.

The same test verifies both cleanup execute replays after the two worktree paths
are already absent. Both source checkouts retain their original commit, clean
status and original dependency bytes; Bridge B observes the integrated bytes
only inside its isolated worktree before producing the downstream file.

The completion audit reran the focused test three consecutive times with
`CONVENE_WIRE_TEST_RUN_BASE=/private/tmp/qa052-goal-audit.I4Np0T`. The actual
owned roots were therefore created inside that private base as
`convene-wire-test-run-LRsqFA`, `convene-wire-test-run-Prr9Vb` and
`convene-wire-test-run-ykVNgD`; their child temporary/cache paths stayed below
those roots. Before and after every run the four-prefix count and the total
remaining-entry count were both `0`; run durations were 39.5, 27.5 and 41.2
seconds. Every root was reported cleaned, and an independent post-command check
proved the isolated parent itself absent after its trap.

Final repository gates passed:

- deterministic E2E: eight passed and the explicit live-provider case skipped;
- `npm test`: 525 Server, 264 Web, 81 contract, 58 Bridge UI, 45 QA evidence,
  two product-experience, 15 site and 24 temporary-lifecycle tests passed;
- all Bridge packages passed; the focused admission/repository/integration/
  console/delivery race run passed; `go vet ./...` passed;
- schema validation covered 11 schemas and 245 fixtures; workspace builds,
  generated-contract checks and documentation lint passed; and
- every observed full-suite, E2E, Bridge, race and vet run root was physically
  removed. The production Web build retains its pre-existing large-chunk
  advisory only.

No live provider, second physical machine, remote Git/CI, scheduler-mode,
parallel-coding, Release or deployment claim follows from this acceptance.
