# REPO-005 Remote Input Attestation Goal

Status: frozen on 2026-09-03. Delivery state exists only in
`docs/TASKS.md`. ADR-0038, the accepted `EvidenceReuseContract`, REPO-003 and
EXEC-009 remain authoritative; this goal closes remote-producer input
provenance without reinterpreting their retained facts.

## Goal

Admit a remote-produced repository commit with declared graph inputs only when
an owner-configured, authenticated provider attests the complete ordered input
set and Central rejoins every pin to the current approved graph:

```text
approved incoming edge + adopted SourceEvidence/GateProof + sealed Artifact
  -> ordered planned ReuseInput projection
  -> authenticated provider RemoteInputAttestation observation
  -> immutable retained attestation companion
  -> remoteInputEvidenceDigest == planned reuseInputEvidenceDigest
  -> exact adoption/source/proof/Artifact/edge join
  -> revision-local remote verified_output adoption
```

The attestation proves only the provider's input-provenance observation for one
exact remote commit/tree. It does not accept content, satisfy CI, approve a
plan, create a Run, mutate a repository or carry evidence to another revision.
Git ancestry or equality with `baseCommit` is never input provenance.

## Closed Contract And Authority Boundary

`ProviderInputAttestation` is the authenticated provider observation. It pins
the stable operation, provider repository, candidate commit/tree, ordered
attested inputs, logical input digest, provider digest and timestamp.
`RemoteInputAttestation` is the Central-retained companion. In addition it pins
the provider binding, logical repository, exact plan/revision/node, remote
commit `SourceEvidence` ID/digest and the source observation identity/digest.

Each ordered attested entry contains:

- `adoptionId` and `adoptionDigest`, used only to rejoin current evidence
  authority; and
- one unchanged `ReuseInput` projection. For the v1 remote slice its producer
  must be `adopted_evidence`, which pins the approved edge,
  `sourceEvidenceId`/`sourceDigest`, `proofSetDigest`, input/output slot mapping
  and Artifact `kind`/`contentDigest`.

Entries are strictly ordered by binary `inputSlot` with no duplicate slot,
adoption, source or edge binding. `remoteInputEvidenceDigest` is the canonical
execution digest of the ordered inner `ReuseInput` array. It deliberately
excludes attestation/adoption IDs while the retained companion still pins them
for authority. Its only equality use is:

```text
RemoteInputAttestation.remoteInputEvidenceDigest
  == planned EvidenceReuseContract.reuseInputEvidenceDigest
```

The existing adoption-specific `operationDigest`, `adoptionDigest`,
`nodeContractDigest`, `resolvedInputSetDigest`, reuse `contractDigest` and
`nodeExecutionDigest` are not semantic input equality. A remote producer has
no destination Run bindings, so its exact runtime-input digest remains the
canonical empty array; its logical inputs live in the companion and the remote
reuse contract without weakening the local runtime-binding invariant.

Central derives the expected projection from the current approved plan and
the adoption-first materialization view. Caller JSON and provider JSON cannot
choose a different edge, source authority, proof set or Artifact. The provider
must echo the exact expected projection for the exact commit/tree. A current
Team Owner initiates observation; credentials remain runtime-only and are
resolved by binding ID. Historical attestation is retained evidence, never a
bearer capability; adoption and replay recheck current plan, Room, Task,
binding, source, proof and revocation authority.

## Admission And Negative Boundary

The first version accepts only an implementation node whose every declared
input slot is required and is bound exactly once by an incoming graph edge to
one current adopted source Artifact of the same kind. It does not accept
external-input declarations, optional or unbound slots, more than one producer
for a slot, gate-only edges or a source lacking a complete adoption/proof join.

A remote node with any declared input or incoming edge remains fail closed
until the exact retained attestation exists and validates. Missing, extra,
duplicated, reordered or substituted slots; source/adoption/proof/edge/Artifact
drift; stale plan/control; foreign Team/repository/binding; changed commit/tree;
revocation; missing sealed bytes; legacy-only materialization; or digest
mismatch blocks adoption. A descendant commit, matching tree, patch contents,
provider status string, PR metadata or CI pass cannot replace the attestation.

Observation is read-only. It does not add remote push, PR create/update/merge,
webhook, provider-credential persistence, arbitrary URL, scheduler mode,
automatic retry, local verification/integration replacement or plan
supersession authority. SEC-014 still gates production provider credentials and
live public adapters.

## Provider Retry And Persistence Model

The provider-neutral v1 client adds a fixed `input-attestations` resource under
the configured binding origin. It authenticates an exact-operation `GET`
before a missing authenticated `404` permits one idempotent `POST`. Timeout,
reset, malformed response or uncertain POST outcome is retained as
`outcome_unknown`; an explicit retry starts at `GET`. Redirects, oversized or
wrong-content-type bodies and identity substitutions fail closed.

Migration is additive:

1. retain a separate immutable input-attestation operation journal, so the
   existing commit/CI operation union and authority are not widened;
2. retain immutable `RemoteInputAttestation` rows with target/source uniqueness
   and update/delete denial;
3. retain one immutable remote `EvidenceReuseContract` companion per remote
   adoption without rebuilding the local companion table;
4. require the attestation and remote reuse companion in the adopted remote
   materialization view whenever the approved node declares an input; and
5. preserve historical input-free REPO-003 observations/adoptions exactly.
   Migration creates no synthetic provider attestation. It deterministically
   backfills only their empty remote reuse companion and proves byte-stable
   reopen; input-bearing historical records cannot exist under the old SQL
   scope trigger.

Attestation and remote adoption/reuse writes use immediate transactions,
target-local uniqueness and canonical replay comparison. Competing identical
operations converge; an operation ID reused with another actor, plan, source,
commit, input or provider conflicts. A fault between any companion writes
rolls back the whole adoption transaction. Startup after migration is not a
repair loop.

## Required Physical Acceptance

Completion requires evidence beyond mocks:

1. TypeScript and Go validate and round-trip both attestation contracts and
   agree on provider, attestation and logical input digests;
2. contract negatives reject unknown fields/kinds, unordered/duplicate inputs,
   external producers, tampered adoption/source/proof/edge/Artifact pins and
   mismatched commit/tree or digest;
3. a real loopback provider exercises authenticated lookup-before-create,
   success, response loss, retry lookup, timeout, malformed/oversized response,
   changed replay and concurrent exact calls;
4. physical SQLite rows prove canonical JSON, uniqueness, CAS/replay,
   immutability, rollback, restart and additive migration from an REPO-003
   input-free database;
5. adoption-first resolution rejects a legacy-only/deleted/tampered
   attestation or upstream adoption even when Git ancestry and CI remain valid;
6. a valid remote input producer retains one attestation and remote reuse
   companion, adopts once, and releases its own exact sealed output to the next
   downstream input reader;
7. physical Artifact bytes for every attested upstream input and the remote
   output match retained digests before and after restart;
8. missing/reordered/substituted inputs, provider faults and injected
   persistence faults retain no partial usable authority;
9. schema generation, TypeScript/Go interoperability, migration, Server/full
   workspace regressions, deterministic E2E, Bridge, build and docs gates pass;
10. three isolated `TMPDIR` lifecycle rounds leave zero `agentroom-*`,
    `agent-room-*`, `convenewire-*` or `convene-wire-*` directories and every
    operation-owned path is physically absent.

## Honest Non-Claims

This goal does not prove a live public provider, cryptographic truth against a
compromised configured provider, multiple physical computers or production
egress policy. It does not support external Result inputs for remote producers;
those remain fail closed until a later contract gives their independent review
authority an equally explicit attestation representation.
