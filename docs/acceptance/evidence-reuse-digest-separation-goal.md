# Evidence Reuse Digest Separation Goal

Status: frozen and accepted on 2026-09-02. This document is the acceptance
authority for `CON-024` and `EXEC-011`; `docs/TASKS.md` remains the sole
delivery-state register.

## Problem

The version-1 `EvidenceAdoption` fields are exact execution identities:

- `resolvedInputSetDigest` hashes complete destination
  `ExecutionInputBinding` values, including Run, Device, binding and time pins;
- `nodeContractDigest` also pins plan identity, revision, plan digest and the
  approval operation.

Those meanings are correct for replaying and auditing one exact attempt. They
cannot also decide whether evidence remains semantically reusable by another
approved plan revision. No migration may reinterpret or rewrite the retained
version-1 fields.

## Goal

Add one immutable `EvidenceReuseContract` companion for every local
`EvidenceAdoption`. The companion separates four facts:

| Fact | Meaning |
| --- | --- |
| `runtimeInputBindingDigest` | Exact destination-attempt input bindings; byte-identical to the adoption's existing `resolvedInputSetDigest` |
| `reuseInputEvidenceDigest` | Ordered logical input evidence without destination attempt, Device, delivery or expiry identity |
| `nodeExecutionDigest` | Exact approved execution identity; byte-identical to the adoption's existing `nodeContractDigest` |
| `nodeReuseContractDigest` | Semantic node contract and logical inputs used by future explicit carry-forward admission |

`EvidenceAdoption` remains the current dependency authority. The new companion
does not carry evidence forward, approve a plan, create a Run or release a gate.

## Closed Reuse Input

`reuseInputs` is ordered by binary `inputSlot` and contains exactly one producer
per slot:

```text
graph producer:
  inputSlot, sourceOutputSlot, approved edge,
  sourceEvidenceId/sourceDigest, proofSetDigest,
  artifact contentDigest/kind

external producer:
  inputSlot, approved external-input declaration,
  review operation/digest,
  artifact contentDigest/kind
```

It excludes `bindingId`, destination Run/Task/Agent/Device, issue/expiry time,
delivery state and source transport timing. Graph inputs rejoin the exact
source adoption named by the retained binding and its approved edge. External
inputs rejoin the exact approved external-input declaration and human review.
Neither producer may be inferred from an Artifact or commit string alone.

`reuseInputEvidenceDigest` is the canonical execution digest of the ordered
`reuseInputs` array. `runtimeInputBindingDigest` is the canonical execution
digest of the complete, input-slot-ordered `ExecutionInputBinding` array.

## Node Digests

`nodeExecutionDigest` preserves the existing version-1 formula:

```text
digest({
  planId, planRevision, planDigest, approvalOperationId,
  node, task, resolvedInputSetDigest
})
```

`nodeReuseContractDigest` is the canonical digest of:

```text
{
  node: approved node execution definition without its planning-time Task directive,
  task: {
    taskId, roomId, parentTaskId, title, goal, ownerMemberId,
    completionPolicy, definitionRevision, criteriaRevision,
    criteria, assignments, budgetPolicy
  },
  integrationPolicy: {
    integration, requireHumanIntegrationApproval,
    integrationTargets for the node repository in binary target order
  },
  reuseInputEvidenceDigest
}
```

The reusable Task projection deliberately excludes mutable workflow state and
`taskRevision`, while retaining the definition/criteria revisions and the
actual criteria, assignment and budget contract. The digest excludes plan ID,
plan revision/digest, approval operation, destination attempt identity and
timestamps. Changes to the node, Task execution contract, repository/base,
scope, outputs, verifier requirements, integration policy or logical inputs
therefore change the reuse digest.

`contractDigest` covers every semantic/pin field in the companion except
`reuseContractId`, `contractDigest` and `createdAt`. The ID is derived from the
adoption ID plus `contractDigest`; replay must reproduce the exact record.

## Persistence And Migration

Migration is additive:

1. register the closed cross-language contract and semantic digest checks;
2. create one immutable companion table keyed one-to-one by `adoptionId`;
3. backfill every existing local adoption inside one immediate transaction;
4. dual-write adoption plus companion in the existing materialization
   transaction;
5. fail the whole transaction on missing producer authority, digest mismatch,
   insertion failure or count mismatch.

The table rejects update/delete and target/adoption scope mismatch. Startup may
run the deterministic backfill only when the companion migration is first
applied; ordinary runtime startup is not a repair loop.

## Required Evidence

Acceptance requires:

1. two attempts with different destination Run/Device/binding/time pins have
   different runtime-input digests and equal reuse-input digests;
2. different plan revision/approval identity changes the execution digest but
   not the reuse contract when the semantic node/Task/policy/inputs are equal;
3. criteria, base, scope, output, verification, integration, Agent/profile/grant
   or logical-input changes alter the reuse contract as applicable;
4. accepted, verified and integrated local adoptions each retain exactly one
   valid companion;
5. pre-existing adoptions backfill exactly once and reopen idempotently;
6. update/delete, substituted producer/proof/artifact and malformed ordering or
   digest fail closed;
7. injected companion insertion failure rolls back source, proof, adoption,
   legacy materialization and companion facts together;
8. contract validation/code generation, full Server regression/build,
   deterministic E2E, Bridge tests and isolated physical zero-residue checks
   pass.

## Explicit Boundaries

This slice does not perform plan supersession or evidence carry-forward. Future
`EXEC-005` must compare `nodeReuseContractDigest` and
`reuseInputEvidenceDigest`, then retain a new revision-local adoption after
current authorization and proof-policy checks. It must not compare the old
execution-identity fields as reuse equivalence.

This slice also does not add remote Git/PR/CI evidence, weaken any gate, infer a
Result for a non-Agent producer, change scheduler mode or claim cross-sweep
fairness.

## Contract Checkpoint

`CON-024` is accepted. Schema 12 now defines the closed
`EvidenceReuseContract`, graph/external producer union, normalized execution
node/Task/integration policy and the four distinct digest facts. The generated
TypeScript and Go types plus both runtimes enforce input ordering, node/edge/
external/artifact joins, canonical digest and derived-ID equality. The 258
shared fixtures and 86 Node checks include exact attempt-versus-reuse identity,
revision stability, semantic contract drift and substitution negatives; Go
round-trip and semantic tests consume the same valid fixture. This checkpoint
adds no persistence or carry-forward authority; those remain `EXEC-011` and
`EXEC-005` respectively.

## Persistence Checkpoint

Migration 0076 adds one immutable `execution_evidence_reuse_contracts` row for
each local adoption. Its primary and foreign keys make the relationship
one-to-one; scope triggers rejoin the exact adoption, plan node, Task and
integration policy, while update and delete triggers preserve retained proof.
Migration-time backfill derives every companion inside one immediate
transaction and checks the final row count. It executes only when 0076 is first
applied. Ordinary startup and reads fail closed when a companion is missing and
do not repair authority state.

`ExecutionEvidenceAdoptionRepository` now derives the companion from the exact
accepted, verified or integrated source/proof/adoption projection. New local
materialization retains source, proof, adoption, legacy projection and reuse
contract in the existing transaction. Stable operation replay requires the
byte-identical companion. Injected failures prove both migration backfill and
new dual-write roll back without partial source, proof, adoption,
materialization or reuse rows.

The retained aliases are checked directly:

```text
runtimeInputBindingDigest == EvidenceAdoption.resolvedInputSetDigest
nodeExecutionDigest       == EvidenceAdoption.nodeContractDigest
```

The independent reuse digests are recomputed from the normalized logical
inputs and semantic node/Task/integration contract. Dependency, input, retry
and integration readers remain adoption-authoritative; the companion grants no
current graph-progression or carry-forward authority.

## Final Acceptance

The final 2026-09-02 acceptance recorded these independent gates:

- focused persistence tests passed 41 cases covering all three gates,
  attempt-versus-reuse equality, immutable rows, missing-companion failure,
  idempotent reopen/backfill and injected migration/dual-write rollback;
- migration compatibility tests passed 11 cases from empty, version-14,
  version-22, version-42 and version-51 databases through migration 0076;
- `npm run validate` accepted 12 schemas and 258 shared fixtures, while the
  contract suite passed all 86 checks and generated TypeScript/Go remained
  current;
- `npm run build` compiled every workspace, and `npm test` completed every
  registered Server, Web, contract, Bridge UI, QA evidence, product, site and
  lifecycle suite before physically removing its owned cache-bearing run root;
- `npm run test:e2e` passed all eight deterministic scenarios, including the
  controlled physical `integrated_commit` loop and two-Bridge recovery cuts;
  only the explicitly live-provider scenario was skipped, and the run root was
  removed;
- `npm run test:bridge` passed every Go package, including the 225-second real
  repository package, and removed its owned Go/npm cache-bearing run root;
- one newly owned isolated base contained zero matching directories before the
  test and after each of three consecutive `npm run test:temp-lifecycle` runs.
  Every round passed 24 success, assertion-failure, spawn-failure, timeout,
  cancellation, descendant and parallel-owner checks. Physical snapshots were
  `before=0`, `after_round_1=0`, `after_round_2=0` and `after_round_3=0`; the
  isolated base itself was then removed.

This accepts `CON-024` and `EXEC-011`. It does not accept plan supersession,
evidence carry-forward, remote CI/PR evidence, scheduler modes or durable
cross-sweep shared-Agent fairness. Those remain separately owned by
`EXEC-005`, `REPO-003` and `EXEC-010`.
