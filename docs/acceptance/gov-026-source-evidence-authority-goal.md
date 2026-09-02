# GOV-026 Source-Evidence Authority Goal

Date: 2026-09-02

Status: accepted on 2026-09-02. `GOV-026` is complete as an architecture
decision; it grants no remote-provider or migration capability.

## Goal

Decide the evidence identity consumed by future remote Git, pull-request and CI
observations before `REPO-003` adds provider behavior. The design must remove
the accidental assumption that every candidate was produced by an Agent Result
without weakening the three existing gate authorities or changing delivered
local behavior.

The intended separation is:

```text
immutable source evidence
  + exact gate proof
  + explicit plan-revision adoption
  -> one gate-specific NodeMaterialization
```

Source evidence identifies exact content and provenance. Gate proof answers why
that evidence satisfies one approved gate. Adoption answers why the same
historical evidence is usable by one exact plan revision and node. None of the
three may infer another's authority.

## Questions the ADR Must Close

1. Which closed source-evidence kinds exist, and which owning service may mint
   each kind?
2. Which exact content, producer, repository and provenance pins enter each
   source digest?
3. Which proof kinds may satisfy `accepted_result`, `verified_output` and
   `integrated_commit`, and which substitutions are forbidden?
4. How does one immutable source become usable by an exact plan revision without
   making the source itself revision-local?
5. What normalized payloads, unique keys and compare-and-set checks govern
   creation, replay and concurrent adoption?
6. When may a later plan revision carry evidence forward, and which contract,
   input, policy, authorization or revocation changes force a new proof?
7. How are existing `sourceResultId`/`sourceResultVersion` materializations
   migrated without breaking current local execution or fabricating records?
8. What additional contracts, migrations and negative tests must `REPO-003`
   implement before a provider observation can affect readiness?

## Frozen Invariants

- ResultReview remains the only `accepted_result` authority.
- VerificationReceipt remains the local independent `verified_output`
  authority; any future CI proof needs separately authenticated provider
  authority over the exact candidate.
- IntegrationReceipt remains the only `integrated_commit` authority.
- An Agent Result, repository checkpoint, CI status, PR URL or provider text is
  never silently promoted into another proof kind.
- Evidence and proof records are immutable. Reuse across plan revisions requires
  a new revision-local adoption receipt; matching `nodeKey` or commit text is
  insufficient.
- Historical retention does not grant current Team/Room, repository, provider,
  local Runtime or integration authority. Adoption rechecks current authority.
- A remote commit identifier without authenticated repository identity and
  exact canonical content availability cannot become a downstream input.
- Operation replay returns the original receipt only for the identical actor,
  target and normalized payload. Changed reuse conflicts.
- Concurrent tasks may adopt the same immutable evidence but cannot overwrite
  another plan/node/gate adoption or delete its records.
- No migration globally changes user caches, repository permissions, Git refs or
  existing Result history.

## Required Deliverables

- one accepted ADR following the repository ADR template;
- one explicit design review containing resolved findings and no hidden
  implementation claim;
- consistent Execution, Repository and Testing module ownership/acceptance
  updates;
- an updated `REPO-003` prerequisite and completion boundary in `docs/TASKS.md`;
  and
- documentation lint and whitespace-clean evidence.

The ADR must define the target persisted concepts and migration sequence closely
enough that a later contract/migration task does not have to rediscover
authority. It must not prematurely claim those schemas or migrations exist.

## Acceptance

`GOV-026` is complete when the review proves that the selected design:

- supports current local Agent-produced evidence and a future non-Agent remote
  candidate without fake Results;
- keeps content identity, gate proof and plan adoption separate;
- permits explicit compatible carry-forward without global source uniqueness;
- fails closed on foreign producer, changed candidate, proof-kind substitution,
  stale plan/contract, changed operation replay, revoked authority and ambiguous
  provider effects;
- provides an additive, rollback-safe compatibility path from existing
  materializations; and
- leaves `REPO-003` blocked on implementing the accepted contracts, persistence,
  adapters and tests.

## Non-goals

- no schema, migration, Server, Bridge, Web or provider implementation;
- no GitHub or other provider selection, credential, webhook or live network;
- no new graph gate, automatic retry, scheduler mode or plan supersession;
- no rewrite of current Result, checkpoint, VerificationReceipt or
  IntegrationReceipt records; and
- no claim that design acceptance is runtime, E2E, provider or production
  acceptance.

## Accepted Outcome

[ADR-0038](../adr/0038-separate-source-evidence-from-plan-adoption.md)
selects the closed `task_result`/`repository_commit` source union, closed
gate-proof matrix and revision-local `EvidenceAdoption`. The initial
carry-forward rule is exact node-contract and resolved-input-set digest equality,
not semantic guessing. Source identity has no global adoption uniqueness;
target plan/revision/node/gate and operation identities remain unique.

The [explicit design review](../reviews/0038-source-evidence-authority-review.md)
resolved ten authority, provenance, replay, concurrency, migration and provider
findings against current materialization persistence and readers. Execution,
Repository and Testing modules now assign the additive contract/migration,
shadow-equality, versioned projection, provider HTTP and physical input evidence
to `REPO-003`. Documentation lint and whitespace checks pass. No runtime code,
database, wire contract, provider or repository state changed.
