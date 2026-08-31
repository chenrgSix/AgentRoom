# EXEC-002: Exact Plan Approval and Canonical Task Compilation

Date: 2026-08-31. Scope: ADR-0036 EX-02/EX-03 and the prerequisite legacy
admission fences. Delivery state remains solely in `docs/TASKS.md`.

## Delivered Boundary

The authenticated human approval endpoint binds the exact immutable plan
revision/digest, root Task revision, actor and operation fingerprint. One
managed immediate transaction creates or adopts ordinary Tasks, records frozen
node/edge snapshots and exclusive Task claims, advances the canonical root
revision, persists an immutable review/response receipt and changes plan state.
Rejection records one decision without creating Tasks or advancing the root;
another review requires a new plan revision. Exact retries return the original
receipt after restart; changed actor/target/content conflicts and current
authorization is always checked first.

New Tasks retain canonical human ownership, criteria, Agent assignments, budget
and `accepted_result_required` policy, and begin in `draft`. Existing Tasks keep
their identity, parent and definition and require current Owner authority,
matching pins, no active/unknown work and no other plan claim. Accepted root
Result actions use the existing Result-to-child provenance port; they never
copy evidence acceptance into a new Task. SQL seals compiled history and
approval records. Human definition/assignment/owner changes or pause/cancel
pause affected plans and record drift without rewriting approval history.

Approval is not local permission or execution. Until the later governed
manifest, scheduler and verifier gates exist, new Runs and accepted Results or
Task completion fail closed on governed nodes. RUN-018, EXEC-004 and VER-001
must replace these prerequisites with exact governed admission before product
execution is enabled. Ordinary Tasks remain unchanged.

## Verification

Run from the repository root with task-owned `TMPDIR` and `GOCACHE` directories:

```sh
node --import tsx --test --test-concurrency=2 --test-reporter=spec \
  apps/server/test/execution-plan-approval.test.ts \
  apps/server/test/execution-plan-history.test.ts \
  apps/server/test/migration-runner.test.ts \
  apps/server/test/hosted-agent-migration.test.ts
npm run test --workspace @convene-wire/server
npm run test --workspace @convene-wire/contracts
npm run validate
npm run build
npm run lint:docs
git diff --check
```

The focused command passes 46 cases: 20 approval cases, 16 existing history
cases and 10 migration cases. The full Server invocation uses the repository's
two-worker policy and passes 399 tests. It covers the ordinary Discussion,
Task, Result, handoff, Hosted, Bridge, security and recovery regressions, not
only the new approval surface. Migration tests include clean/idempotent startup
and legacy upgrades through version 59, with foreign-key integrity preserved.

The approval cases prove:

- exact atomic compilation, normal child definitions, no Run startup, history
  pagination and original receipts after database reopen;
- rejection without compilation, later revised approval and one review per
  revision;
- stale revision/digest/root pins, mandatory unresolved questions, forged
  authority and blank-reason rejection;
- operation identity conflicts across payloads, actors, plans and draft APIs;
- current Task/Team Owner, Room, Agent availability and source-retraction checks;
- competing alternative/same-plan approvals and revise-versus-review races;
- injected second-child, edge and receipt failures with full rollback and no
  leaked SQLite diagnostics;
- canonical text equality, preventing silent Task-service trimming under an
  already reviewed digest;
- adopted Task identity, exclusive claims, active/unknown work rejection and
  linked Task ownership independent of root ownership;
- valid two-Agent Discussion, direct Mention, retry and reply-handoff admission
  denial, with no orphan Messages or partial orchestration;
- completion-policy downgrade rejection, pre-existing Result acceptance denial
  and preserved human Result rejection;
- immutable SQL approvals/nodes/edges, sealed insertion, approval-state guards
  and active-claim release/retarget rejection;
- definition, assignment, root Owner and scheduling drift with frozen histories;
- canonical accepted next-action provenance, unaccepted/mismatched-action and
  derived-operation-collision rejection;
- exact trusted Origin, bounded no-store history and commit-only notifications
  with no notification on retry or rollback.

Contracts pass 69 Node checks, 201 shared fixtures (82 valid, 119 invalid),
generated/type consistency, Go shared-schema verification and 17 generated Go
typed round-trips. The 12 new fixtures cover source actions and approval
records/receipts/pages, including authority, canonical-key, criteria-pin and
missing-envelope/cursor negatives. All-workspace build passes. The existing
639.60 kB Web chunk warning remains visible; it was not suppressed.
Markdown lint passes for 293 maintained files, and whitespace checks pass.

## Implementation Review and Repair

This is the implementing agent's review, not an independent reviewer.

The real two-participant legacy Discussion negative exposed a partial-write
gap: its root Message committed before initial Run admission. Rejection then
left an orphan Message. Discussion creation now coordinates the root Message,
initial budget, participants, first Wave and Runs in one managed transaction.
The regression proves rollback; the full suite verifies ordinary orchestration
still works. The initial one-participant negative alone would not have proved
this boundary, so it is not used as the admission evidence.

The review also checked canonical Task text, explicit source-action provenance,
cross-domain operation collisions, linked Task authority, root revision fencing,
immutable history versus current claims, and drift behavior. The temporary
admission guards are limited to governed work; a global assignment-retarget
guard was narrowed to those scopes. No Issue/TaskAttempt/TaskEvidence store or
second Runtime path was introduced.

## Limits

This increment does not implement dispatch, local grants, OS enforcement,
worktrees, verification commands, repository integration, plan Web UI or Agent
proposal tools. No real provider, physical Bridge, browser, CI/PR, deployment or
Release acceptance is claimed. QA-052 through QA-055 remain required for the
complete cumulative design and final completion inventory.
