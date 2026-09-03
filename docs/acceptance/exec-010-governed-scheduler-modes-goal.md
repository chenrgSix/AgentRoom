# EXEC-010 Governed Scheduler Modes and Durable Fairness Goal

Status: accepted on 2026-09-03. This document is the implementation and
acceptance authority for `EXEC-010`; `docs/TASKS.md` remains the sole
delivery-state register.

## Goal

Make scheduler autonomy an explicit, persisted Plan-local control while
preserving the already-approved execution topology and every existing proof
authority. Add durable shared-Agent rotation so a restart or competing Server
cannot repeatedly reset selection to the oldest Plan.

This slice answers two questions only:

1. who may cause a new generation-1 node admission; and
2. which eligible Plan gets the next use of a shared Agent.

It does not decide what work exists, retry a failed generation, adopt evidence,
verify a candidate, integrate a repository or supersede a Plan.

## Independent Control Identity

Every Plan owns one persisted scheduler control:

```text
planId
mode = manual | supervised | automatic
modeRevision
lastOperationId?
updatedByMemberId?
reason
updatedAt
```

Existing and newly created Plans begin in `automatic` mode to preserve the
approved-plan behavior delivered before `EXEC-010`. A Task Owner or Team Owner
may change the mode with one closed command that pins the exact Plan revision,
Plan digest, Plan control revision and scheduler mode revision. The command and
receipt are immutable and replayable by exact operation ID and request digest.

`modeRevision` is deliberately separate from `ExecutionPlan.controlRevision`.
A mode change governs only future scheduler admission; it must not invalidate
an already frozen Run manifest, VerificationReceipt or pending exact-target
integration operation. A mode change never cancels or rewrites an existing
Run, DispatchIntent, workspace or proof.

## Mode Semantics

The three modes are exclusive for scheduler-selected generation-1 admission:

- `manual`: background selection and supervised advance are disabled. A Task
  Owner or Team Owner may submit one exact-node dispatch command. It pins the
  current node projection revision and either admits that one ready node or
  fails without another candidate being substituted.
- `supervised`: background selection is disabled. A Task Owner or Team Owner
  may submit one Plan-level advance command. One invocation evaluates the
  current deterministic order and admits at most one ready node. A successful
  replay returns the same receipt; a no-progress invocation is also an
  immutable receipt and cannot later acquire authority when facts change.
- `automatic`: startup and timer sweeps may admit ready nodes using the existing
  bounded scheduler. Manual message admission remains an explicit human-owned
  compatibility path rather than scheduler authority; it does not make a
  `manual` or `supervised` Plan background-runnable.

Manual and supervised command operations retain the authenticated Task Owner
or Team Owner as their actor. The admitted Run remains Plan-owned and keeps the
exact approval reviewer as its requester, just like automatic admission. All
three paths recheck current Plan, Task, Agent, capability, grant, dependency,
input, budget and capacity facts in the same admission transaction. Scheduler
operations never authorize generation 2.

## Durable Shared-Agent Rotation

Fairness is an Agent-local persisted fact, not a random seed, SQL row order or
process-local index. Every newly retained governed admission advances one
cursor and appends one immutable history row in the same immediate transaction
as its DispatchIntent, Run admission, frozen inputs and workspace reservation:

```text
agentId + cursorRevision
previous selected Plan identity
selected planId / planRevision / nodeKey
dispatchIntentId / runId
source and optional scheduler operation
admittedAt
```

Automatic selection keeps the `EXEC-008` approval-time/Plan/topology/node base
order. When the next candidates of two or more Plans target the same Agent, it
cyclically starts after that Agent cursor's last selected Plan and then wraps
to the base order. Plans targeting different Agents retain the base order.
Only a committed new admission advances the cursor. A readiness failure,
capacity blocker, duplicate replay or rolled-back transaction does not.

The scheduler snapshots the cursor revision used for selection. Admission
rechecks that revision and the exact scheduler mode revision inside its
transaction. Competing Servers therefore have one winner; a stale selector
fails closed and must take a new snapshot. Migration reconstructs history and
the latest cursor from retained DispatchIntents, so an upgrade or restart does
not erase known prior Agent use.

## Persistence and Recovery

The additive migration owns:

- one mutable, CAS-protected scheduler control per Plan;
- immutable scheduler commands and receipts;
- one CAS-protected current fairness cursor per Agent;
- immutable cursor history bound to exact DispatchIntent and Run facts; and
- the scheduler-operation pin on new scheduler-created DispatchIntents.

Database triggers reject detached actors, wrong mode/revision, rewritten
commands or receipts, cursor skips, history without an exact admission and
manual/supervised scheduler intents without their owning command. Runtime
startup does not heal missing control, receipt, history or cursor authority.

Queued/delivered/working Runs recover and dispatch independently of the current
mode because their authority already exists. Changing to a less autonomous mode
only prevents new scheduler-selected generation-1 admissions.

## Non-Goals

This slice adds no automatic retry, generation-2 inference, Plan supersession,
evidence carry-forward, remote input attestation, verifier admission,
integration approval, repository mutation, conflict resolution, Agent persona,
Discussion autonomy or Web graph redesign. It does not reinterpret the legacy
member Message as a scheduler command.

## Required Evidence

`EXEC-010` may become `DONE` only when physical SQLite and public HTTP evidence
proves all of the following:

1. migration backfills every existing Plan as automatic without changing Plan
   control revision and reconstructs the last retained Agent cursor;
2. new Plans receive exactly one automatic revision-1 scheduler control;
3. exact Owner mode changes persist, replay after restart and reject stale
   revision/digest/control/mode pins, unauthorized members and reused operation
   IDs with different payloads;
4. manual mode admits only its exact pinned ready node and rejects stale node
   projection, blocked nodes and automatic/supervised selection without partial
   command, Message, intent, Run, input or workspace facts;
5. supervised mode admits at most one deterministic ready candidate per exact
   command, retains an immutable no-progress receipt and rejects background and
   manual-mode advance;
6. automatic mode retains the existing bounded fan-out/fan-in and per-sweep
   Plan fairness behavior, while manual and supervised Plans remain absent from
   startup/timer candidate sets;
7. after Plan A uses a shared Agent and its Run becomes terminal, a later sweep
   selects eligible Plan B before Plan A again; the rotation survives Server
   restart;
8. two concurrent Servers using the same cursor snapshot retain one cursor
   revision and one history row per actual admission, without duplicate intent,
   Run, Message, input or workspace facts;
9. failed readiness, admission rollback and duplicate recovery do not advance
   fairness, while explicit manual, supervised, automatic, legacy manual and
   retry admissions each retain their truthful source when they create a Run;
10. closed TypeScript/Go contracts, schema fixtures, full Server/build/E2E/
    Bridge/docs gates and three isolated temporary-lifecycle runs pass, with
    physical before/after counts remaining zero for all four historical temp
    prefixes.

A passing scheduler unit test alone is not acceptance. Final evidence must
include the exact database rows, restart/concurrency outcomes and physical
temporary-directory snapshots.

## Implementation Checkpoint

The closed scheduler contracts now expose one named
`ExecutionSchedulerMode` plus exact control, mode-transition, manual-dispatch,
supervised-advance and immutable receipt shapes. The same roots are compiled
into the TypeScript validator, generated TypeScript/Go types and the actual Go
Runtime validator. Unknown fields, invalid revisions, unsupported modes and
ambiguous selections fail before service admission.

Migration `0081_governed_scheduler_modes.sql` additively retains:

- one automatic revision-1 control for every existing and new Plan;
- immutable scheduler operations and receipts with Plan, mode, actor and node
  scope triggers;
- the owning scheduler operation on manual/supervised DispatchIntents; and
- immutable per-Agent fairness history plus a CAS-protected latest cursor.

The populated migration regression physically removes and reapplies only
migration 0081, then proves that the Plan control revision is unchanged, the
old automatic DispatchIntent is reconstructed as cursor revision 1, every
foreign key is valid and a second migration run is idempotent. Runtime startup
does not backfill or heal these authority facts.

`ExecutionSchedulerControlService` now provides authenticated GET,
mode-transition, exact manual-dispatch and supervised-advance HTTP boundaries.
Mode commands reject stale Plan revision, digest, Plan control revision and
mode revision, preserve operation replay across restart and allow one winner
under competing transitions. Direct SQL cannot manufacture a non-owner
operation or mutate retained operations, receipts, fairness history or the
current cursor.

Automatic sweeps query only automatic Plans. Supervised sweeps are Plan-local
and admit at most one candidate for one operation; manual admission names one
exact node projection and never substitutes another candidate. Real timer
tests prove that both manual and supervised Plans remain undispatched until
their correct owner command. A supervised no-progress receipt stays empty
after a previously active Run becomes terminal, while a fresh operation can
then select the next deterministic node.

Every newly created automatic, supervised, manual, member-Message and
generation-2 retry admission writes its truthful fairness source in the same
transaction as the DispatchIntent, Run authority, frozen inputs and workspace
lease. Rollback and exact replay leave cursor counts unchanged. A physical
two-Plan shared-Agent test fails the first selected Run, restarts the Server and
proves that the next sweep selects the other Plan at cursor revision 2. Two
concurrent Server schedulers retain one generation-1 winner, one history row
and one cursor advance per actual admission without duplicate Messages, Runs,
inputs or workspaces.

## Final Acceptance

The final 2026-09-03 acceptance ran from commits `9273fc8` and `c4b86ea` and
recorded these independent gates:

- `npm run validate`: 14 schemas and 258 fixtures passed;
- `npm run build`: strict Server TypeScript, the Web production bundle and
  generated TypeScript/Go contracts passed;
- `npm test`: all registered workspace, Bridge UI, QA evidence, product,
  site and lifecycle suites passed, including 96 Contracts, 555 Server and
  268 Web tests, and the top-level owned root was removed;
- `npm run test:e2e`: nine deterministic scenarios passed, including physical
  two-Bridge handoff, `integrated_commit`, concurrent CAS conflict and fan-in;
  only the explicitly credentialed live Codex/Pi scenario was skipped, and the
  E2E root was removed;
- `npm run test:bridge`: every Go Bridge package passed, including the
  209-second repository package, and its cache-bearing run root was removed;
- `npm run lint:docs`: 343 maintained Markdown files had zero issues; and
- `git diff --check`: passed before each implementation commit.

The required cleanup acceptance used the newly owned private base
`/private/tmp/exec010-owned-base.pblVwa` through
`CONVENE_WIRE_TEST_RUN_BASE`. Three consecutive
`npm run test:temp-lifecycle` invocations each passed 24 tests covering normal
success, assertion failure, spawn failure, timeout, SIGINT, SIGTERM, nested and
parallel ownership. Physical total-entry snapshots were `before=0`,
`after-1=0`, `after-2=0` and `after-3=0`; every child root and the private base
itself were then absent.

A separate read-only global observation found one pre-existing
`/private/tmp/convene-wire-test-run-*` directory and 212 pre-existing
`convene-wire-*` directories in the macOS user temporary directory. Their
latest modification time was 2026-09-02, before this acceptance. The counts
remained exactly `1` and `212` after all current gates, proving no new global
prefix leak. They were deliberately not deleted because this process did not
create or own them.

This accepts `EXEC-010` for explicit persisted scheduler modes and durable
cross-sweep shared-Agent fairness. It does not claim automatic retry, Plan
supersession, evidence carry-forward, remote input attestation, outbound
provider egress policy or multi-computer physical acceptance.
