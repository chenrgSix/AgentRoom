# QA-054 Bounded-autonomy Product Acceptance Goal

Status: accepted on 2026-09-03. This document was frozen before implementation
and is the implementation and acceptance authority for `QA-054`;
`docs/TASKS.md` remains the sole delivery-state register.

## Goal

Prove the complete bounded-autonomy product path without transferring human,
repository or proof authority to an Agent or Discussion quorum:

```text
read-only Discussion -> structured Plan proposal -> assigned Tech Lead revision
-> exact human approval -> governed dispatch -> bounded delegated supersession
-> compatible evidence carry-forward -> continued deterministic execution
```

The acceptance must also prove the negative path: any expansion of Task set,
scope, Agent/repository authority, verification floor, integration target,
budget, concurrency or acceptance criteria stops at explicit human review.

## Required Product Scenarios

1. One real Server-backed read-only Discussion uses a focused Wave and a quorum
   seal, retains late supplemental evidence, finalizes a structured Plan draft
   and never treats quorum as Plan approval.
2. An exactly assigned Tech Lead reads and revises that draft through the real
   MCP authority checks; another Agent and a stale/foreign Run cannot.
3. A human owner reviews and approves the exact initial Plan revision before
   any governed work dispatches.
4. A bounded, one-shot, unexpired delegation activates one compatible low-risk
   revision, carries only digest-equal revision-local evidence and allows the
   deterministic scheduler to continue.
5. A broader candidate returns `EXECUTION_HUMAN_REVIEW_REQUIRED` with no Plan,
   claim, adoption, delegation-consumption, Run, workspace or repository side
   effect; exact human activation remains available afterward.
6. Restart, response-loss and duplicate-operation cuts retain one Discussion
   seal, one Plan revision, one delegation consumption, one carry-forward set
   and one dispatch intent.
7. Discussion replies, quorum seals and supplemental records cannot satisfy an
   accepted-result, verified-output or integrated-commit gate; code review and
   verification remain independent graph proof authorities.
8. Existing Rooms/default Tasks, ordinary Runs, human Result review, scheduler
   modes, Client-owned Git boundaries and Optional Remote Evidence tests remain
   unchanged.

## Acceptance Boundary

Use actual HTTP/MCP/service boundaries, persisted SQLite facts and the ordinary
Run scheduler. Deterministic local/fake Runtime output is allowed; a live model,
live Remote Provider, multiple physical computers, deployment and Release are
not claimed. Every synthetic seam must be named in the final evidence.

`QA-054` may become `DONE` only after focused acceptance, full Server/Web/
Contract/Bridge regression, deterministic E2E, builds, schema generation,
documentation and isolated temporary-lifecycle verification pass. Physical
database assertions, not green HTTP responses alone, must prove the authority
and no-side-effect claims.

## Accepted Implementation

The focused product acceptance composes three retained real boundaries. The
existing controlled-product E2E supplies the continuous Discussion draft,
assigned Tech Lead MCP revision, exact human approval and governed two-Bridge
dispatch path. The new read-only quorum scenario uses the real Discussion
Orchestrator, persisted SQLite, managed read-only Agent and Device authority,
frozen Delivery offers and final Plan writer. It seals a partial Wave after the
soft deadline, selects the focused successor by its retained question and
Reviewer role, creates one unapproved Discussion-authored Plan and later
retains the excluded Security reply only as supplemental evidence.

The supersession scenario now starts from a real accepted-result adoption,
claims an exact assigned Tech Lead Run through MCP, proposes and activates a
compatible next revision with one one-shot delegation, reopens the database,
acknowledges the prior ambiguous Run and proves the scheduler creates exactly
one downstream revision-2 DispatchIntent. Omitted and mismatched carry pins
fail before activation. A broader Plan-budget candidate returns
`EXECUTION_HUMAN_REVIEW_REQUIRED`; physical counts across Plan, approval,
claim, adoption, delegation consumption, dispatch, workspace, repository and
Run tables remain byte-for-byte unchanged and the delegation remains usable.

That end-to-end consumption exposed one blocking implementation defect that
older resolver-only tests could not see: carried `accepted_result` evidence
projected its carry operation as though it were a second ResultReview, so the
downstream input reader rejected otherwise ready revision-2 work. Migration
0086 and the input service now keep the original ResultReview operation as the
gate proof while treating the revision-local carried adoption and digest as
the consumption authority. Local original accepted-result projections retain
their compatibility digest. Carried and Optional Remote adoptions are detected
by their complete Plan/revision/node/adoption identity rather than an ID alone.

## Acceptance Evidence

The accepted implementation is commits `d2382b6` and `0c34a5e` on `main`.
Verification on 2026-09-03 produced these results:

- the focused quorum-to-proposal and delegated supersession cases passed both
  alone and in the complete 594-test Server suite; the latter physically
  reopened SQLite, retained one activation, one delegation consumption and one
  carried adoption, then emitted one revision-2 downstream dispatch;
- the broader delegated budget expansion returned the closed human-review
  error with an exact 13-table no-side-effect snapshot, while Discussion seal
  and late-evidence facts left Plan approvals, compiled nodes, dispatch intents
  and execution adoptions at zero;
- `npm test` passed 594 Server, 268 Web and 101 Contract tests plus Bridge UI,
  QA evidence, product-experience, site and all 24 temporary-lifecycle checks;
  its owned outer and nested run roots were physically removed;
- `npm run validate` validated 14 schemas and 258 fixtures, and `npm run build`
  completed the Server, Web and generated TypeScript/Go contract builds;
- `npm run test:e2e` passed nine deterministic scenarios and skipped only the
  explicit live-Runtime case. The retained controlled-product scenario covers
  the continuous Discussion, exact Tech Lead, human approval and physical
  integrated dependency path; parallel CAS/fan-in also remained green; and
- `npm run test:bridge` passed every Bridge package, including the real local
  repository, Runtime, verification and workspace suites. Both Bridge and E2E
  used distinct run IDs and deleted only their own temporary roots.

The quorum test deterministically stages canonical Run events instead of
invoking a live model or separate Bridge process. The supersession test uses
real HTTP/MCP/service and SQLite boundaries but fixture-produced accepted
evidence. Those seams are paired with the unchanged physical two-Bridge E2E;
no live-model quality, multiple physical computers, live Remote Provider,
deployment or Release claim is made.

## Retained Authority Boundaries

Quorum remains read-only Discussion progress, not Plan approval or proof.
Delegation is one-shot and permits only deterministic no-broadening activation.
Central still cannot own repository paths, Git credentials, worktrees or Git
commands, and Optional Remote Evidence remains outside the Core exit path.
`QA-055` is the final Core gate and audits every EX-01 through EX-14 claim
against current implementation and physical evidence.
