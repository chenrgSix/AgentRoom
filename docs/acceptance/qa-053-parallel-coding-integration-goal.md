# QA-053 Parallel Coding And Integration Goal

Date: 2026-09-03

Status: frozen before implementation. `docs/TASKS.md` is the sole delivery-
state register.

## Goal

Prove that the accepted plan-owned scheduler, local execution, evidence and
repository authorities compose under actual parallel coding rather than only
under the sequential QA-052 chain:

```text
                         /-> Bridge A: BuildA -> verified -> integrated --\
approved four-node DAG                                              Join
                         \-> Bridge B: BuildB -> verified ------------/
                                               \-> integration conflict
                                                              \-> ConflictSink blocked
```

`BuildA` and `BuildB` start in distinct Bridge-owned worktrees from the same
approved base and physically overlap. They produce disjoint candidate patches
and independent verification receipts. Exact-target CAS integrates `BuildA`.
The target movement makes the separately approved `BuildB` integration fail
closed; no merge, rebase, reset or inferred retry resolves it. `Join` starts
only after consuming the exact adopted `integrated_commit` evidence from
`BuildA` and `verified_output` evidence from `BuildB`, then produces its own
verified candidate from both exact byte sets.

This is an acceptance task. It may repair composition defects found by the
test, but it does not add another scheduler, proof type, repository mutation
path or remote authority.

## Frozen Topology And Authority

One owned run root contains:

- one actual Central process and SQLite database;
- two actual authenticated Go Bridge processes with distinct Devices, data
  roots, stable Agents, local repository bindings and Runtime/verifier grants;
- one owner-selected source checkout addressed by two distinct Bridge-local
  bindings, one untouched observer clone, and three Bridge-owned isolated
  attempt worktrees;
- one approved four-node plan with `maxConcurrency = 2`;
- `BuildA -> Join` gated by `integrated_commit` and
  `BuildB -> Join` gated by `verified_output`, plus
  `BuildB -> ConflictSink` gated by `integrated_commit`; and
- one exact integration target whose approved expected commit is the common
  base.

The two root Runs must rendezvous from their separate Runtime processes before
either can finish. Database timestamps alone are supporting evidence, not the
only proof of overlap. Agent capacity still permits only one active governed
Run per Agent, so `Join` reuses Bridge A only after `BuildA` is terminal.

Every executed node has its own immutable Task, grant, DispatchIntent, Run,
workspace generation, checkpoint, Result and verification receipt. The
compiled `ConflictSink` never receives a grant, DispatchIntent or Run because
its required integrated proof never exists. Reusing an Agent, binding or
verifier profile does not permit reusing a node's grant or attempt identity.

## Repository And Dependency Evidence

The acceptance must prove all of these physical facts:

1. `BuildA` and `BuildB` begin at the same exact base in different worktrees,
   overlap, and change disjoint allowed paths.
2. Both candidates are canonical commit/patch Artifacts with independent
   passed verification receipts and `verified_output` adoptions.
3. Two human integration approvals pin the same expected target commit and
   their own candidate/materialization/receipt sets.
4. Bridge A moves the target from the approved base to candidate A exactly
   once. Bridge B then retains `failed / INTEGRATION_TARGET_MOVED`, does not
   move the target and never receives an `integrated_commit` adoption.
5. The conflict does not invalidate B's already retained verified evidence.
   `Join` receives two ordered immutable input bindings: A from the integrated
   adoption and B from the verified adoption.
6. The Join worktree contains both exact disjoint changes before its Runtime
   writes the combined output, and its independent verifier passes.
7. The shared source checkout's `HEAD`, worktree bytes and clean status remain
   unchanged; only the approved target ref changes. The observer clone remains
   byte- and ref-stable, proving that local CAS does not imply a push.
8. Owner-confirmed cleanup removes all three exact stopped attempt worktrees,
   and exact cleanup replay returns retained receipts without scanning any
   prefix.
9. SQLite counts, adoption/proof identities, Git objects/refs, Artifact bytes,
   runtime overlap markers and `PRAGMA foreign_key_check = []` agree.

## Simulated Provider Fault Evidence

QA-053 also reruns the accepted REPO-003 real-loopback provider boundary as a
fault gate. The provider must retain a commit/CI effect before one response is
lost, and the Server must reconcile by exact operation lookup without a blind
second POST or duplicate import. Timeout/revocation/identity faults retain no
usable source, adoption or dependency authority, and temporary Git import
directories disappear.

This provider gate does not make the parallel local nodes remote producers and
does not relax the current input-free remote-node rule. `REPO-005` still owns
remote input attestation; Git ancestry alone is not accepted as incoming-edge
provenance.

## Required Regression And Physical Cleanup

Completion requires:

- a retained deterministic cross-process QA-053 test for the complete physical
  topology and conflict path;
- focused scheduler/readiness/materialization/integration/input tests for every
  defect discovered while composing it;
- the authenticated real-loopback provider observation and fault tests;
- full contracts, Server, Web, Bridge, product-experience, deterministic E2E,
  schema, workspace build and documentation gates; and
- three consecutive focused QA-053 runs under one private
  `CONVENE_WIRE_TEST_RUN_BASE`, with four-prefix and total-entry counts at zero
  before and after every run.

The four watched prefixes are `agentroom-*`, `agent-room-*`, `convenewire-*`
and `convene-wire-*`. The acceptance may inspect and delete only the exact
owned run roots created beneath its private base.

## Explicit Non-goals

This goal adds no automatic retry, scheduler mode, cross-sweep fairness cursor,
plan supersession, evidence carry-forward, remote input attestation, owner-
configured provider credentials, GitHub/GitLab adapter, push, pull request,
webhook, automatic conflict resolution, multi-computer claim, Windows/Linux
physical acceptance or live paid provider. `EXEC-010`, `REPO-005`, `SEC-014`
and `EXEC-005` retain those independent boundaries.
