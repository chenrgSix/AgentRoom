# RUN-018 Physical Two-Bridge Integrated Handoff Goal

Date: 2026-09-02

## Frozen Goal

Prove one complete owner-local software-delivery dependency across a real
Central and two independently configured Go Bridge processes:

```text
Bridge A governed implementation Run
  -> canonical candidate checkpoint
  -> independent verification receipt
  -> exact-target local integration receipt
  -> integrated_commit NodeMaterialization
  -> immutable destination input binding
  -> Bridge B governed implementation Run
  -> exact integrated bytes applied in its isolated worktree
  -> canonical downstream checkpoint and Result proposal
```

This is the next product-closure target. `REPO-003` remote Git, pull request and
CI observations do not start until this local authority chain is physically
accepted.

## Ownership and Delivery Order

The goal is RUN-018-first at the product level, but its implementation order is
constrained by existing ownership:

1. `BRG-071` supplies the production Bridge boundary for exact required inputs,
   Runtime start/revocation, capture, Result proposal and stopped-Run cleanup.
2. `RUN-018` carries the frozen integrated predecessor selection through the
   ordinary durable Delivery and two independent Bridge inboxes.
3. `REPO-001` exposes and proves the owner-visible lifecycle of both exact
   worktrees without mutating either source checkout or another active writer.
4. `EXEC-003` closes only after the physical two-Task/two-Bridge transfer proves
   that the destination consumes the exact materialized commit and bytes.

No new aggregate owns these facts. Runtime state remains owned by Run and the
execution node projection; capture, verification and integration remain
separate immutable proof authorities. The scheduler consumes retained
gate-specific NodeMaterializations rather than trusting Agent text.

## Required Physical Topology

Acceptance uses one disposable run root containing:

- one actual Central Server process and SQLite database;
- two actual Go Bridge processes with distinct Device identities, data roots,
  Agent identities, repository bindings, grants and Runtime profiles;
- two source checkouts and only Bridge-owned isolated worktrees;
- an actual temporary Git repository and refs; and
- one run-scoped Go/npm cache set owned and removed by the outer runner.

The Bridges must communicate through the production authenticated connection,
Delivery, input-download, admission, Runtime, capture, verification and
integration adapters. Direct calls to repositories or in-memory handler fakes
may support focused tests but cannot satisfy this goal.

## Acceptance Matrix

### Successful dependency

- Bridge A starts only after the exact current grant and workspace authority
  checks, writes only inside its allowed isolated worktree and stops before
  capture.
- The captured candidate is independently verified and integrated only when
  the current target equals the approved expected target.
- Central retains an immutable IntegrationReceipt and `integrated_commit`
  materialization for the exact plan revision, node, Result, checkpoint,
  candidate tree and resulting commit.
- Bridge B receives one ordered input selection whose binding, artifact digest,
  byte length, source proof and destination Run all match the frozen manifest.
- The bytes applied in Bridge B reconstruct the exact integrated candidate; its
  Runtime continues from that content and publishes its own canonical checkpoint
  and Result proposal.

### Failure and recovery cuts

- A moved target yields conflict/attention, never a target mutation or Bridge B
  dispatch.
- Revocation before either possible-start callback prevents process creation;
  revocation after a start is requested follows the explicit in-flight policy
  and cannot authorize a replacement writer.
- Lost responses and Bridge/Central restart reconcile the exact durable
  operation; they do not create a second Run, Runtime process, worktree,
  verification, target update, materialization or input binding.
- Cancellation and timeout stop the exact process group before capture or
  cleanup. An unresolved possible start or target mutation remains
  `outcome_unknown` and retains diagnostics rather than guessing success.
- Bridge A and Bridge B may run concurrently under distinct owners and cannot
  inspect, clean or mutate each other's paths.

### Physical cleanup

- Owner-visible preview names the exact worktree/ref, retained checkpoint and
  diagnostics before confirmation.
- Cleanup requires the current local cleanup grant, exact stopped-Run proof and
  preview digest; it deletes only the owned worktree/ref and records replay-safe
  retirement.
- Source checkouts, canonical evidence and unrelated worktrees remain intact.
- On success, assertion failure, spawn failure, cancellation, timeout and
  parent termination, the outer acceptance runner removes only its own run
  root. Three consecutive runs leave no newly created `agentroom-*`,
  `agent-room-*`, `convenewire-*` or `convene-wire-*` directory in the isolated
  `TMPDIR`.

## Completion Evidence

RUN-018 and EXEC-003 may be marked `DONE` only when the repository contains:

- focused Server and Go regressions for every failure cut above;
- a deterministic cross-process acceptance that starts the real Central and
  both real Bridges and inspects Git, SQLite and exact content physically;
- three consecutive isolated lifecycle runs with before/after directory
  snapshots and matching owned-root cleanup records;
- full relevant workspace, Bridge, race, vet, schema, build and deterministic
  E2E results; and
- an evidence record that names the tested platform and explicitly excludes
  untested physical platforms and live remote providers.

`BRG-071` and `REPO-001` retain their own broader completion criteria. This
goal cannot mark either task complete merely because the dependency happy path
passes.

## Explicit Non-goals

- remote Git fetch/push, pull requests, provider webhooks or remote CI;
- `sourceEvidenceAnchor` generalization or migration of existing Result-backed
  materializations;
- generation 2, automatic retry, plan supersession or scheduler autonomy modes;
- Discussion proposal, MCP planning or Web graph/recovery UX; and
- release publication or untested physical-machine claims.

Before `REPO-003` starts, an ADR must decide whether a future materialization
anchors a Result, repository checkpoint, external commit observation or an
explicit adopted source-evidence identity. CI observations must never fabricate
an Agent Result merely to satisfy the current local schema.
