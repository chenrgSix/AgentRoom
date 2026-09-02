# Source-Evidence Adoption Runtime Goal

Status: frozen and accepted on 2026-09-02. `CON-023` and `EXEC-009` are
complete. This document is their acceptance authority. ADR-0038 remains the
architecture decision; `docs/TASKS.md` remains the sole delivery-state
register.

## Goal

Replace the local execution graph's universal Result anchor with three exact,
separately owned facts while preserving every delivered local behavior:

```text
SourceEvidence + GateProofRef + EvidenceAdoption
                         |
                         v
              NodeMaterialization projection
                         |
                         v
          dependency and frozen input readers
```

The change must be additive and reversible until reader cutover. Existing
accepted, verified and integrated local rows remain immutable compatibility
projections. No remote provider, plan supersession or repository mutation is
authorized by this goal.

## Stable Work Split

- `CON-023` owns schema-v1 closed wire contracts, canonical identity rules,
  generated TypeScript/Go types and interoperability fixtures.
- `EXEC-009` owns append-only persistence, deterministic local backfill,
  transactional dual-write, shadow equality, adoption-authoritative readers
  and the versioned materialization/input projection.
- `REPO-003` starts only after `EXEC-009` is accepted and owns remote provider
  bindings and observations. It may not redefine the local evidence model.

## Contract Boundary

The first contract version has these closed discriminators:

- `SourceEvidence.kind`: `task_result | repository_commit`;
- `RepositoryCommitSource.origin.kind`:
  `local_checkpoint | remote_observation`;
- `GateProofRef.kind`:
  `result_review | verification_receipt | ci_observation_receipt |
  integration_receipt`;
- `EvidenceAdoption.gate`:
  `accepted_result | verified_output | integrated_commit`.

The schema enforces the ADR-0038 gate matrix. Unknown kinds, a proof for the
wrong gate, unordered/duplicate proof identities, nullable Result semantics,
paths, credentials, mutable refs and display-only remote identifiers fail
closed. Digests use the existing canonical execution JSON rules and exclude
`createdAt` from source identity.

`task_result` pins the exact Task, source Run/generation, Result ID/version and
ordered sealed Artifact pins. `repository_commit` pins the logical repository,
Git object format, exact commit/tree, canonical input/content identity, ordered
sealed Artifact pins and its closed origin. A local origin also pins checkpoint,
Device/binding/capture lineage and its companion task-result source. A remote
origin exists in the contract only; no local runtime may mint it in this goal.

An adoption pins one exact plan/revision/node/gate, source ID/digest, ordered
proof set/digest, dispatch lineage, approved node-contract digest, resolved
input-set digest, current authority pins, operation identity/digest and adoption
digest. Its authoritative uniqueness is target-local plus operation-local; no
source evidence is globally unique to one adoption.

## Migration Stages

### Stage A: additive persistence and backfill

Add immutable `execution_source_evidence`, `execution_gate_proof_refs` and
`execution_evidence_adoptions` tables without weakening legacy constraints.
Migration derives exact local evidence/adoptions for all retained legacy
materializations. It aborts on a missing join, malformed canonical JSON, digest
mismatch, proof substitution, integrated target mismatch or count mismatch.
Reopening the database repeats no facts and produces byte-identical digests.

Before cutover, an older application can use the unchanged legacy tables; the
new tables are ignored. Migration rollback evidence is a verified pre-cutover
database/application pair, never partial deletion from a live database.

### Stage B: transactional dual-write and shadow equality

Every new local accepted, verified or integrated materialization is produced by
one materialization transaction. The transaction retains source evidence,
proof references, adoption and the legacy projection, then compares their
normalized projections. Any mismatch rolls back all four facts. Replay and two
concurrent writers return the one identical winner.

Only owning services may mint evidence or adoption. Historical evidence is not
a bearer token: every new adoption and replay rejoins current plan, Task, Room,
Agent, grant/profile, repository and proof authority.

### Stage C: adoption-authoritative readers

After deterministic shadow equality succeeds, dependency resolution, retry
fencing, integration admission and input binding select only a current
`EvidenceAdoption` and its joined source/proof records. Legacy rows remain
write-only compatibility projections during this release and cannot release a
dependency on their own. Deleting or corrupting an adoption in a fault-injected
fixture must fail closed even when a valid legacy row remains.

A versioned projection exposes generalized source evidence without emitting
`sourceResultId: null`. Version 1 retains the exact Result-bearing local shape;
version 2 carries source-evidence/adoption identity and an optional companion
Result only when one exists. Existing local clients receive byte-equivalent
content and provenance.

## Required Tests and Evidence

`CON-023` is complete only when:

1. schema validation, deterministic generation and generated-tree cleanliness
   pass;
2. TypeScript and Go round-trip every closed positive variant;
3. both languages reject unknown kinds, wrong-gate proofs, duplicate/unordered
   proof sets, malformed digests, paths, credentials and nullable fake Results;
4. canonical digest fixtures agree byte-for-byte across languages.

`EXEC-009` is complete only when physical SQLite tests prove:

1. empty, accepted-only, verified and integrated databases backfill exact
   counts/digests and reopen idempotently;
2. a deliberately broken join/digest/subject/count aborts without a partial
   adoption;
3. accepted, verified and integrated success paths dual-write equal facts;
4. assertion/fault injection between each write rolls the whole transaction
   back;
5. response loss, restart and concurrent writers return one source/adoption;
6. foreign plan/Task/Room/Run/Result/checkpoint/repository/proof, stale current
   authority and substituted proof kinds fail closed;
7. adoption-only dependency and input readers deliver the same physical bytes;
8. a legacy-only row cannot advance the graph after cutover;
9. version-1 local and version-2 generalized projections are both valid, while
   a non-Result source never fabricates a Result;
10. migration, backup/reopen, Server build, full regression and three isolated
    temporary-root runs leave no owned directory behind.

Completion does not claim remote Git/PR/CI, live providers, semantic
carry-forward, plan supersession, removal of legacy tables, scheduler modes or
multi-machine physical acceptance.

## CON-023 Acceptance Checkpoint

The contract increment adds schema 12 and brings the shared corpus to 257
fixtures. Eight positive evidence variants cover Task Result, local and remote-
origin repository commits, all four gate proofs and accepted adoption; schema
and semantic negatives cover unknown source, nullable fake Result, injected
provider URL/credential material and a substituted proof gate. Focused Node
tests additionally reseal and reject source/proof ordering, duplicate output or
proof identities, Git object-format mismatch and source/proof-set/operation/
adoption digest changes.

Deterministic generation exposes `SourceEvidence`, `GateProofRef` and
`EvidenceAdoption` in both TypeScript and Go. The Go raw validator uses the same
canonical semantic rules and its tests independently reseal a valid multi-proof
adoption before rejecting reversed, duplicate and tampered variants. All 84
Node checks, strict generated types, generated-tree comparison and Go package
tests pass. The owned contract-test roots were physically removed. No Server
table, materializer, reader or remote-provider capability changed in this
checkpoint.

## EXEC-009 Stage-A Checkpoint

Migration 0074 additively creates immutable local `SourceEvidence`,
`GateProofRef` and `EvidenceAdoption` storage plus an unchanged-legacy union
view. A migration-owned, immediate transaction deterministically reconstructs
every retained accepted, verified and integrated materialization; it rejoins
the approved node, dispatch/admission, Result, checkpoint and exact proof rows,
validates generated contracts and canonical digests, and requires the adoption
count to equal the legacy projection count. Reopen repeats no row and compares
the byte-canonical retained content.

The local repository-commit source uses the checkpoint's own retained timestamp
and therefore remains one source when both verified and integrated gates adopt
it. Current runtime persistence rejects remote origins and CI proof refs even
though those closed contract variants are reserved for `REPO-003`. Physical
SQLite coverage proves empty migration, accepted-only reconstruction, shared
verified/integrated source identity, exact row counts, foreign-key integrity,
reopen idempotence and an injected adoption failure that rolls the source,
proof and adoption writes back together. Legacy readers and writers are still
unchanged at this checkpoint; Stage B dual-write is the next authority change.

## EXEC-009 Stage-B Checkpoint

The shared `ExecutionNodeMaterializationRepository` now dual-writes every new
accepted, verified and integrated local gate inside the materializer's existing
transaction. Replays reconstruct the same generalized facts instead of trusting
the legacy row alone. Before return, the repository compares the adoption
target and dispatch lineage, source Artifact pins and Result/checkpoint/commit
identity, plus the gate-specific review, verification or integration proof
projection against the retained legacy materialization.

The additive Stage-A backfill uses an explicit legacy-only read path, so later
reader cutover cannot make migration circular. Focused physical SQLite tests
prove all three successful materializers retain adoptions, concurrent verified
reconciliation converges, response-loss/restart replay is idempotent, and an
injected adoption insert failure rolls back the legacy materialization, source,
proof and adoption together. Runtime dependency and input readers still use
legacy projections until Stage C.

## EXEC-009 Stage-C Implementation Checkpoint

Migration 0075 exposes only legacy rows that have an exact joined adoption and
source-evidence record, and replaces the frozen-input scope trigger so every
graph edge uses that adopted view. `ExecutionNodeMaterializationRepository`
now treats a shadow-equal adoption as mandatory; dependency resolution,
accepted/verified/integrated input freezing and reads, retry fencing, and both
integration approval and Bridge admission therefore fail closed when only the
legacy row remains. External approved Result inputs keep their separate direct
Result authority and cannot masquerade as graph edges.

Backfill now runs as migration-74 data work, not as a startup repair loop. An
already migrated runtime cannot recreate a deliberately missing adoption from
the compatibility row. Physical SQLite fault fixtures retain the legacy row
while removing only the owned adoption and prove that integration admission,
dependency readiness and already-frozen byte delivery are denied. The normal
accepted path still delivers byte-identical sealed content.

The materialization reader also provides two explicit projections. Version 1
retains the local Result-bearing compatibility shape. Version 2 carries source
evidence, proof and adoption identities and includes a `companionResult` only
when an actual Task Result source exists; a contract-valid remote repository
source produces no nullable or fabricated Result field. Focused migration,
projection, input-binding and accepted/integrated generation-2 tests pass under
owned temporary roots.

## EXEC-009 Final Acceptance

The final 2026-09-02 run proves all three migration stages together. Physical
SQLite migration tests cover empty, accepted, verified and integrated backfill,
byte-stable reopen, broken-join rollback and exact counts. Materializer tests
cover the three gate dual-writes, concurrent/replayed writers and injected
mid-transaction failure. Adoption-authoritative dependency, integration, retry
and input tests remove only the owned adoption in a fault fixture and prove the
legacy compatibility row cannot release graph authority or physical bytes.
Projection tests retain the Result-bearing version 1 shape and prove version 2
does not fabricate or emit a nullable Result for repository evidence.

`npm run validate`, `npm run build`, `npm test`, `npm run test:e2e`,
`npm run test:bridge` and `npm run lint:docs` all exited successfully. The
contract catalog remained 12 schemas and 257 fixtures and generated TypeScript
and Go trees were current. Full workspace, E2E and Bridge roots each reported
their exact owned cleanup. A separate isolated-base acceptance then ran the
temporary lifecycle suite three times; all three 24-test rounds passed and the
four-prefix directory snapshots were `0` before and `0` after every round. The
isolated base was also physically removed.

This accepts `EXEC-009`. Legacy tables remain immutable compatibility
projections for this release. No remote Git/PR/CI producer, live provider,
semantic carry-forward, plan supersession, scheduler mode, legacy-table removal
or multi-computer physical acceptance is claimed.
