# Execution Product Loop Goal

Date: 2026-09-02

## Status and Authority

This document freezes the next governed software-team delivery program before
implementation. `docs/TASKS.md` remains the sole delivery-state register; this
record does not make a task `DONE`. Contract, ownership and acceptance changes
must continue to update the owning module documents and this record as evidence
is earned.

The program delivers one ordered product loop:

```text
Human intent
  -> structured Discussion finalization
  -> immutable DecisionRecord and PlanProposal
  -> assigned Tech Lead propose/read/revise
  -> human Web diff/edit/exact approval
  -> deterministic Execution DAG
  -> explicit human-supervised generation-2 recovery
  -> governed Bridge execution
  -> independent verification
  -> exact-target integration
  -> controlled single-repository acceptance
```

Work proceeds in task order. A later stage cannot be used to weaken an earlier
authority boundary or to claim product closure before its own evidence exists.

## Frozen Task Sequence

1. `EXEC-004` delivers explicit generation-2 ExecutionNode retry and control.
2. `DISC-010` publishes structured finalization decisions and plan proposals.
3. `MCP-007` gives only the assigned Tech Lead scoped plan propose/read/revise.
4. `WEB-063` exposes plan diff, edit and exact human approval.
5. `QA-052` proves the complete controlled single-repository product path.
6. `GOV-026` freezes the source-evidence authority before `REPO-003` may start.

`EXEC-008` separately owns explicit scheduler modes, broader multi-node
capacity and systematic graph fault injection. That work is not smuggled into
`EXEC-004` and does not block the first controlled product loop. `QA-053`, which
owns parallel coding and integration acceptance, depends on `EXEC-008`.

## EXEC-004 Generation-2 Boundary

The control action retries an ExecutionNode by authorizing a new generation; it
does not retry or mutate the old Run. Ordinary `/api/runs/:runId/retry` remains
invalid for an Execution-adopted Task because it cannot create the plan-owned
dispatch, frozen inputs, workspace generation and graph lineage.

| Fact | Sole owner |
| --- | --- |
| why another generation is permitted | immutable `ExecutionNodeRetryAuthorization` |
| new generation, Run ID, inputs, deadline and policy pins | immutable `DispatchIntent` |
| one Agent attempt and terminal facts | `Run` |
| isolated local writer generation | `WorkspaceLease` |
| accepted, verified or integrated downstream proof | gate-specific `NodeMaterialization` |
| current node projection | `ExecutionNodeState`, recomputed from retained facts |

The first retry increment is explicit human/supervised control only:

- A failed, canceled or expired current attempt may be retried by an authorized
  human. `outcome_unknown` additionally requires the existing exact ambiguity
  acknowledgement before another writer is possible.
- The request pins a stable operation ID, expected current plan revision and
  control revision, node key, previous generation, previous Run and reason.
- One immediate transaction retains the authorization, increments the node to
  generation 2, freezes a new input snapshot and deadline, creates a new
  DispatchIntent and governed Run, and binds a new workspace generation.
- The previous DispatchIntent, Run, workspace facts, Result, receipts and
  materializations remain immutable. A late generation-1 Result or receipt
  cannot replace the current generation or prove generation 2.
- Duplicate requests, restart replay and concurrent Servers return the one
  retained outcome or conflict; they never create generation 3 by accident.
- A completed attempt or a generation already carrying a retained gate
  materialization cannot be retried. Automatic retry remains fail-closed.
- Settlement, all three gate materializers, dependency resolution and input
  freezing must use the exact generation selected by retained authority; no SQL
  or type assertion may silently force generation 1.

`EXEC-004` is complete only when focused tests and physical SQLite/workspace
inspection prove success, failure, cancellation, timeout/expiry,
`outcome_unknown`, late old-generation evidence, duplicate/restart and
concurrent-retry behavior. Passing an endpoint test alone is insufficient.

### EXEC-004 Retained Acceptance

`EXEC-004` is complete. Migration 0073 preserves the three retained proof
tables while replacing the generation-1-only checks with positive generation
checks and latest-intent scope triggers. Settlement and accepted/verified
materializers select only the latest immutable DispatchIntent; integrated proof
inherits and rechecks that exact verified generation.

The Server regressions physically inspect two Build DispatchIntents, two Runs
and two isolated workspace leases, retain the failed generation-1 facts, and
reject a late generation-1 Result acceptance. They then prove generation 2 can
produce each of `accepted_result`, `verified_output` and `integrated_commit`,
that the materialization records pin generation 2 and its exact Run, and that a
downstream Run reads the expected sealed bytes. Separate cases cover failed,
canceled, expired and acknowledged `outcome_unknown` attempts, completed and
already-proven rejection, exact replay after restart, changed replay conflict
and one winner under concurrent retry controls. Foreign-key and immutable-proof
checks run against the rebuilt physical SQLite schema. Automatic retry is still
absent by design and is not implied by this completion.

## Product-Entry Boundaries

`DISC-010` translates one real finalization into immutable structured domain
content through a stable operation identity. Missing or malformed structure
keeps the existing final Message and creates no proposal. It grants no plan
approval, Task completion, repository or local Runtime authority.

The bounded payload is the closed shared `discussionPlanProposalDraft`, carried
only in one exact final-line `<convenewire-plan-proposal>` envelope for a
`decision_record` finalization. It omits root identity, sources, revisions,
author and operation ID; the Server pins the terminal Discussion and immutable
final Message and derives stable attribution. Finalization closure and valid
draft persistence are atomic. Invalid topology or references are treated as an
invalid draft rather than as authority to block the already-visible conclusion.

Completion evidence is the generated TypeScript/Go contract, strict final-line
parser, Discussion proposal adapter and real SQLite orchestration regression.
The positive case freezes exactly the terminal Discussion version and immutable
final Message sequence, retains one `draft` authored by the Discussion, leaves
approval and compiled-node tables empty, and adds no work Run. Missing,
duplicate, trailing, oversized, malformed, authority-shaped and domain-invalid
payloads create no proposal. An injected proposal insert failure leaves the
Discussion `finalizing` and Wave open; recovery after removing the fault closes
both and retains one draft. A separate database connection replays the same
Turn-derived operation without duplication. The full Server suite passes 517
tests, the shared contract suite passes 81 tests, both builds pass, and the
isolated test runner reports physical removal of its owned temporary roots.

`MCP-007` may let an Agent propose, read and revise only plans within its exact
assigned Tech Lead Run/context. A role label is not authority. The MCP surface
cannot approve a plan, dispatch work, review Results, verify candidates or
integrate repository state.

`WEB-063` is the human control surface for Server-backed proposal inspection,
dependency and policy blockers, version diff/edit and exact approval. Approval
must bind the exact proposal/revision/digest and expose an immutable receipt;
stale or changed bytes fail closed. Keyboard, localization and real browser
evidence are required at 1280, 720 and 390 pixel widths.

`QA-052` must traverse the real product entry and the existing governed local
execution path with actual Server, Go Bridge, Git, verification, Result and
integration facts. It must include interruption and response-loss cuts,
physical artifact/repository/worktree inspection, legacy-flow regressions and
explicit live-provider limits. Existing component acceptances are prerequisites,
not substitutes for this end-to-end evidence.

## Source-Evidence Decision Gate

Current local materializations remain intentionally anchored to an Agent
Result and its exact version. Before remote PR, Git or CI observations are
implemented, `GOV-026` must accept an ADR that decides whether a proof source is
a closed evidence-anchor union, a source proof plus revision-local adoption, or
another equally explicit authority. The decision must preserve provenance,
digest/CAS behavior, replay, supersession compatibility and no-authority
escalation.

`REPO-003` may not force CI or another external producer to manufacture a fake
Agent Result merely to satisfy the current local schema. This program freezes
the decision requirement only; it performs no source-anchor migration and
implements no remote provider adapter.

## Non-goals

- automatic generation retry or unattended retry policy;
- manual/supervised/automatic scheduler-mode implementation in `EXEC-004`;
- broad multi-node capacity or `QA-053` parallel-coding acceptance;
- plan supersession, dynamic replanning or `EXEC-005`;
- remote Git, PR or CI implementation and `WEB-064`;
- unrestricted Agent approval, verification or integration authority;
- a claim of multiple physical computers or live provider execution unless a
  later acceptance records that evidence explicitly.

The already accepted physical baseline is two real Bridge processes, distinct
Device/owner state, real Git/process/SQLite effects and isolated worktrees on
one macOS host. Documentation must keep that boundary visible.

## Program Completion Evidence

Each task keeps its own focused acceptance record and commit. The program is
complete only when:

1. `EXEC-004`, `DISC-010`, `MCP-007`, `WEB-063` and `QA-052` are individually
   `DONE` with their listed evidence.
2. the ordered human-to-integration flow is exercised without hidden Message,
   Agent, Result or repository authority;
3. failure, cancellation, response loss, stale state and restart retain one
   trustworthy outcome and never silently advance the graph;
4. physical repository bytes, worktrees, SQLite records and owned temporary
   roots are inspected in addition to test exit status;
5. `GOV-026` accepts the source-evidence ADR and `REPO-003` remains blocked on
   it until then;
6. all affected workspace, contract, Bridge, browser, E2E, documentation and
   temporary-lifecycle gates pass, with any live-provider or physical-platform
   omission reported separately.
