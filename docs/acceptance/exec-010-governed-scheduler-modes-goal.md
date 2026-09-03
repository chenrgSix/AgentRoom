# EXEC-010 Governed Scheduler Modes and Durable Fairness Goal

Status: frozen on 2026-09-03. This document is the implementation and
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

Manual and supervised commands use the authenticated Task Owner or Team Owner
as the requester. Automatic admission continues to use the exact human Plan
approval authority. All three paths recheck current Plan, Task, Agent,
capability, grant, dependency, input, budget and capacity facts in the same
admission transaction. Scheduler operations never authorize generation 2.

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
