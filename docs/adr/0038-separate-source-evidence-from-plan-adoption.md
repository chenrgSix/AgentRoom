# ADR-0038: Separate source evidence from plan adoption

- Status: Accepted
- Date: 2026-09-02
- Supersedes: none; refines ADR-0036 source materialization

## Context

ADR-0036 correctly separates `accepted_result`, `verified_output` and
`integrated_commit` gates. The delivered local implementation retains immutable
gate-specific materializations and exact proof receipts. Its first bounded
producer is always a governed Agent Run, so every materialization also pins
`sourceResultId` and `sourceResultVersion`.

That pin is useful provenance for the local slice but is not a universal source
identity. A future authenticated remote Git or pull-request candidate may be an
exact repository commit without an Agent Result. A remote CI check may verify
that commit without owning its content or human acceptance. Requiring either
producer to manufacture a Result would create false authority. Making the
current Result fields nullable without replacing their semantics would instead
create ambiguous records and weaken SQL invariants.

Plan supersession exposes a second issue. Source evidence can remain valid when
a compatible plan revision is approved, but current global source-Result
uniqueness makes materialization look revision-local. Copying or rerunning the
evidence would lose provenance; treating it as automatically valid in a new
revision would bypass the new approval and current authorization.

This decision closes the model before `REPO-003` adds any remote provider. It
does not implement a contract, migration, adapter or plan supersession.

## Decision

### Three separate facts

Execution progression uses three immutable facts with different owners:

```text
SourceEvidence
  identifies exact content and its producer provenance

GateProof
  proves why that content satisfies one gate

EvidenceAdoption
  authorizes that evidence/proof pair for one plan revision, node and gate
```

`NodeMaterialization` remains the gate-ready read model consumed by the
dependency resolver. In the generalized model it is a deterministic projection
of one `EvidenceAdoption`, its `SourceEvidence` and its closed proof set. It is
not a fourth authority and cannot be written independently.

An immutable source may have several adoptions. An adoption belongs to exactly
one `planId`, `planRevision`, `nodeKey` and gate. Evidence retention alone never
makes another revision ready.

### Closed SourceEvidence union

The first generalized schema has exactly two source kinds:

| Kind | Owning mint authority | Required subject |
| --- | --- | --- |
| `task_result` | existing Task Result/materialization adapter | exact Task, source Run, Result ID/version and canonical selected Artifact pins |
| `repository_commit` | Repository evidence service after local checkpoint or authenticated remote import | logical repository, object format, exact commit/tree, canonical content/input digest and sealed Artifact pins |

`repository_commit.origin` is a second closed discriminator:

- `local_checkpoint` pins checkpoint ID/digest, source Run/generation, Device,
  owner-local binding, canonical capture identities and the companion
  `task_result` source ID/digest retained by the current governed path; or
- `remote_observation` pins the owner-configured provider binding, provider
  repository identity, immutable observation ID/digest and imported commit
  bundle identity.

A URL, branch label, PR number, status string, Agent claim or unsealed remote
object ID cannot mint `repository_commit` evidence. The Repository service must
authenticate the configured provider observation, join its logical repository
identity and import or otherwise prove the exact canonical commit content before
the source exists. Canonical input delivery remains unavailable until the
sealed bytes are retained.

Verification receipts, CI checks, reviews and integration receipts are proofs,
not source kinds. Additional source kinds require a later contract version and
ADR review; unknown discriminators fail closed.

Every source record contains:

- `sourceEvidenceId`, schema version, kind and immutable producer identity;
- exact subject fields listed above and a producer-version or receipt pin;
- ordered canonical Artifact/content pins where the kind carries bytes;
- `sourceDigest`, computed from the closed normalized payload; and
- `createdAt`, which is retained but excluded from identity decisions unless the
  shared canonical contract explicitly includes it.

The source digest does not include a target plan revision. Repository names,
paths, mutable refs, display labels and provider URLs do not enter identity.

### GateProof remains gate-specific

Proof references form a closed union and retain the proof record's own digest.
The approved plan fixes which profiles/checks are required and how a complete
proof set is ordered.

| Gate | Only gate authority | Admissible source |
| --- | --- | --- |
| `accepted_result` | one accepted human `ResultReview` operation for the exact Result/version | `task_result` only |
| `verified_output` | all required independent local `VerificationReceipt` records or future authenticated CI observation receipts for the exact repository subject | `repository_commit` only in the first generalized remote slice |
| `integrated_commit` | one successful immutable `IntegrationReceipt` for the exact target/resulting commit | `repository_commit` naming the resulting integrated content |

A future CI observation is accepted only from the configured provider adapter
and pins provider binding, logical repository, check/workflow identity, attempt,
candidate commit, terminal conclusion and observation digest. It may satisfy
only the verification requirement named by the approved plan. A successful CI
string, PR approval or Agent-authored report is not equivalent.

The IntegrationReceipt continues to pin its independent human integration
approval and verified prerequisite. Those supporting pins do not turn that
approval or verification receipt into the `integrated_commit` authority.
Likewise, independent verification does not accept a Task Result.

### Revision-local EvidenceAdoption

An adoption freezes at least:

- `adoptionId`, `operationId` and normalized `operationDigest`;
- exact target `planId`, `planRevision`, `nodeKey` and gate;
- source evidence ID and digest;
- source execution/generation lineage when the producer belongs to a plan node;
- ordered proof references and `proofSetDigest`;
- target `nodeContractDigest` and exact resolved-input-set digest;
- actor/service authority and the current authorization revisions it rejoined;
- `adoptionDigest` and `createdAt`.

The version-1 `nodeContractDigest` and `resolvedInputSetDigest` are exact
execution identities. They include plan/approval identity and complete
destination-attempt bindings respectively, so they are correct for replay and
audit but cannot define cross-revision reuse equality. Their meaning and every
retained value remain unchanged.

CON-024 adds an immutable companion `EvidenceReuseContract` with
`nodeExecutionDigest`/`runtimeInputBindingDigest` aliases of those exact facts
and separately defined `nodeReuseContractDigest`/`reuseInputEvidenceDigest`
facts. The companion excludes plan revision, approval and destination-attempt
identity only from reuse equality while retaining Task criteria, Agent/profile/
grant, repository/base, scope, output, verification/integration and logical
input evidence. Its frozen formula is
[`evidence-reuse-digest-separation-goal.md`](../acceptance/evidence-reuse-digest-separation-goal.md).

Adoption is one transaction. Before insertion the owning materialization service
rechecks the approved plan revision, node contract, current Team/Room/Task and
repository/provider authority, source digest, proof digests, proof subjects and
required proof completeness. Historical evidence remains diagnosable after
revocation, but revocation or stale scope blocks a new adoption.

The authoritative uniqueness rules are:

```text
UNIQUE(plan_id, plan_revision, node_key, gate)
UNIQUE(operation_id)
```

Source evidence has its own kind-specific identity uniqueness. There is no
global uniqueness from source Result or source evidence to adoption. Concurrent
plans may explicitly adopt the same immutable source without overwriting each
other. Competing adoptions for one target have one winner.

An exact replay first proves the same current caller/service authorization and
then matches the operation digest. Identical actor, target and normalized
payload return the original adoption. Reusing an operation ID with another
source, proof, target, actor or contract is a conflict. Replay performs no
provider call, verification command or repository mutation.

### Plan supersession and carry-forward

Plan supersession never copies a materialization row implicitly. A later plan
revision submits a new adoption operation referencing the old immutable source
and proof records. Initial carry-forward requires all of:

1. exact `nodeReuseContractDigest` and `reuseInputEvidenceDigest` equality from
   retained companion facts;
2. the same logical repository/content subject and complete gate proof under the
   new revision's policy;
3. current authorization and non-revoked provider/local authority;
4. no ambiguous or superseded proof outcome; and
5. proof-specific freshness rules, when the approved profile explicitly has
   them.

The version-1 `nodeContractDigest` and `resolvedInputSetDigest` are deliberately
not reuse comparisons. Matching node keys, Task labels, Result IDs or commit IDs
alone is insufficient.
A changed base, input, scope, output contract, required check, integration
target, Agent/grant/profile pin or Task criterion blocks carry-forward. The old
adoption and source stay immutable; a human may revise the plan or produce new
evidence, but cannot relabel the old proof.

### Additive compatibility and migration sequence

The contract/migration implementation required before remote provider work is
phased:

1. Add closed `SourceEvidence`, `GateProofRef` and `EvidenceAdoption` contracts
   plus append-only source/adoption tables. Do not relax current constraints.
2. Backfill existing `accepted_result` rows as `task_result` evidence. For each
   verified/integrated row, retain the same companion `task_result` evidence and
   backfill `repository_commit` evidence with `local_checkpoint` origin plus its
   current receipt proof set. Preserve each old materialization and digest
   unchanged.
3. In one transaction, dual-write new local materializations through the shared
   materialization service and compare the legacy and generalized projections.
   Any missing join, digest mismatch, non-fast-forward integrated subject or
   count mismatch aborts migration.
4. Switch all dependency, retry, integration and input-binding readers to the
   adoption authority only after deterministic shadow-read equality and restart
   tests pass. At that cutover the new tables become the single source of truth;
   legacy rows are compatibility projections, not alternate writers.
5. Introduce a versioned input-binding/materialization projection for non-Result
   sources. Do not emit `sourceResultId: null` through a schema whose semantics
   require a Result, and never synthesize a Result. Existing clients continue to
   receive their current exact local projection during the compatibility window.
6. Only a later cleanup migration may rebuild the legacy tables and remove their
   global `source_result_id` uniqueness after backup/restore, full migration,
   rollback and mixed-version gates prove it safe.

Before the reader cutover, rollback ignores the additive records and uses the
unchanged legacy authority. After cutover, rollback means restoring the verified
pre-cutover database/application pair; an older binary must not partially read
new remote-only adoptions.

### REPO-003 implementation boundary

This ADR does not enable remote behavior. `REPO-003` must implement the shared
contracts, migrations and generalized materialization/input readers before its
first remote-only evidence path. It must then add owner-configured provider
bindings, authenticated observations, canonical commit import, exact remote
identity lookup before retry and bounded receipt persistence.

Provider PR state is provenance or review evidence only. Provider CI can become
a verification proof only through the configured closed check policy. Remote
push, PR creation, merge and observation remain distinct intents/effects. An
ambiguous provider effect stays `outcome_unknown` and cannot be adopted.

## Alternatives

### Keep Result as the universal anchor

Rejected. It forces non-Agent producers to create a false Task/Run/Result
history and lets an administrative compatibility record appear to carry human
review authority.

### Make source Result fields nullable

Rejected. Nullability removes an invariant without supplying a replacement
identity, producer authority, digest or replay model.

### Use proof receipts themselves as source evidence

Rejected. A verifier or CI check observes a subject; it does not own the
candidate bytes. Integration proves a target mutation; it does not replace the
content's provenance.

### Copy materializations into every new plan revision

Rejected. Blind copies bypass the new revision's contract and authorization;
rerunning work destroys useful immutable provenance.

### Generalize to an open string-key evidence registry

Rejected. Open kinds and arbitrary IDs make proof substitution and authority
escalation difficult to reject at schema, SQL and service boundaries.

## Consequences

The model gains two persisted concepts and a compatibility projection. Remote
integration cannot be a small nullable-field patch, and plan carry-forward
requires an explicit service operation. In exchange, content provenance, trust
proof and plan authorization remain auditable and independently replaceable.

Current local flows do not change until the additive implementation is accepted.
Existing Result identities remain first-class provenance, while exact evidence
can later be reused across compatible revisions without global uniqueness or
duplicate external work.

## Compatibility and Security

All unions are closed and versioned. Only owning services mint records; Agent,
member and provider text is untrusted data. Digests use the existing canonical
JSON rules, binary ordering and bounded fields. SQL foreign keys and immutable
update/delete triggers enforce exact typed joins in addition to service checks.

Adoption rechecks current authorization before replay, so retained evidence does
not become a durable access token. Remote credentials and local paths remain at
the owning adapter. Central retains opaque binding identities, exact repository
subjects and sanitized receipts only. No evidence adoption mutates a Git ref,
accepts a Result, starts a Run or invokes a verifier.

## Verification

The explicit [design review](../reviews/0038-source-evidence-authority-review.md)
checks authority substitution, remote provenance, carry-forward, migration and
replay. Owning requirements are recorded in
[Execution Coordination](../modules/execution-coordination.md),
[Repository Execution](../modules/repository-execution.md) and
[Testing and Observability](../modules/testing-observability.md).

Design acceptance requires documentation lint, whitespace checks and a
consistent task dependency review. Runtime completion remains `REPO-003` work
and must add closed-schema/digest fixtures, migration/backfill/reopen/rollback,
current local shadow equality, foreign/stale/substituted proof negatives,
concurrent adoption, response-loss, authenticated provider HTTP and physical
canonical-content/input tests. Live-provider evidence remains separate.
