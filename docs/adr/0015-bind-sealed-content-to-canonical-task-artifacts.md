# ADR-0015: Bind sealed content to canonical Task Artifacts

- Status: Accepted
- Date: 2026-08-25
- Supersedes: none

## Context

AgentRoom already stores immutable, revisioned `ArtifactRef` records and
delivers them by a strict Task result-evidence cursor. Those records are the
canonical Team evidence ledger, but file-like references do not prove that the
named bytes remain available to another Device. Creating a second Artifact
aggregate for uploaded content would split authority, revision ordering, Memory
provenance, and Runtime consumption.

Cross-Device content transfer also has two independent uncertain cuts. A Blob
may have been durably stored when the upload response is lost, and sealed bytes
may exist before the product Artifact is committed. Retrying either cut with a
new identity can duplicate evidence or silently orphan storage.

## Decision

`TaskArtifactRecord`, `task_artifact_refs`, and the Task `artifactRevision`
remain the only canonical Artifact authority. Existing records default to
`reference_only`. A content-bearing record is inserted once with
`contentMode=snapshot_blob`, a sealed `contentId`, the byte size, media type,
and SHA-256 digest. An existing immutable Artifact is never upgraded in place.
Later content is a new Artifact connected by an immutable relation.

The content path uses two state owners:

- Artifact Content Transport owns Blob upload, sealed content metadata,
  transport, retention, and delivery/materialization receipts. A sealed Blob is
  content-addressed storage, not Team evidence.
- Task Collaboration owns the publication operation that names the Task, source
  Run, creator, proposed Artifact metadata, and final canonical bind.

The publication state machine is:

```text
prepared -> receiving -> sealed -> bound
                 |          |
                 +----------+-> failed or expired before bind
```

`seal` is the byte-storage linearization point. It verifies the declared size
and SHA-256 digest, installs bytes under their content identity with an atomic
same-filesystem rename, and durably records sealed metadata. Repeating `seal`
with the same publication identity returns the same result. A conflicting
request fails closed.

`bind` is the product linearization point. One immediate SQLite transaction
verifies the sealed content and publication identity, inserts one canonical
Task Artifact, advances the Task artifact revision, and marks the publication
bound. Only a bound canonical Artifact is visible to the Web, Context Planner,
Memory provenance, or downstream Runs.

Every publication carries a client-generated idempotency key scoped to its
source Device. Status lookup by publication identity and idempotency key is the
only recovery mechanism for response loss. A reconciler may expire unsealed
uploads and retain sealed-but-unbound content for bounded recovery, but it may
not invent a new Artifact or guess that bind failed.

Run delivery pins the canonical Artifact identity, revision, content identity,
size, media type, and digest in the existing durable delivery payload. The
target Bridge downloads into a Bridge-owned Run staging directory, verifies
the bytes, atomically installs a non-executable file, and exposes only a logical
Artifact alias to the Runtime. Staging does not modify the configured
Workspace and therefore requires delivery authorization, not a Workspace write
lease. Applying content to a real Workspace is a later explicit operation.

An Agent that consumes Artifact A and produces a result publishes canonical
Artifact B. An immutable relation records `derives_from`, `reviews`, or
`verifies` from B to A. Text replies may describe the result but do not replace
that evidence lineage.

## Alternatives

- Add a separate uploaded Artifact aggregate: rejected because it would split
  Task revision and provenance authority.
- Store Blob bytes directly in SQLite: rejected because backup growth and large
  transactions would couple file transport to control-plane state.
- Mutate an existing reference-only Artifact after upload: rejected because it
  breaks the established immutable evidence contract.
- Materialize under `.agentroom/` in the configured Workspace: rejected because
  it can pollute Git state and expose untrusted content to unrelated Runs.
- Treat upload timeout as failure and retry with a new identity: rejected
  because the original seal or bind may already have committed.

## Consequences

- Task Collaboration gains optional immutable content fields and Artifact
  relations without replacing existing IDs, revisions, cursors, or APIs.
- The Server needs a bounded filesystem BlobStore first; object-store adapters
  remain behind the same seal/open/delete port.
- Sealed-but-unbound content requires retention and garbage collection.
- Runtime startup waits for required content staging. A failure before Runtime
  invocation is a deterministic delivery failure, not `outcome_unknown`.
- Same-user filesystem permissions make read-only staging a safety measure, not
  a sandbox claim. Strong isolation remains Runtime- and OS-owned.

## Compatibility and Security

All canonical Artifact content fields and Bridge capability fields are
additive. Old Artifacts remain `reference_only`; old Bridges receive metadata
but no content materialization. The Server never stores a source or target
absolute path. Device-authenticated content access is limited to the source Run
or a pinned target delivery.

The first release accepts only Patch, Markdown, and JSON test-result snapshots,
with a 4 MiB content limit and bounded chunks. It rejects traversal, symlinks,
directories, special files, executable inheritance, inconsistent file stats,
digest mismatch, MIME confusion, cross-Team content access, and quota excess.
Deduplication is scoped so content existence cannot be probed across Teams.
HTML rendering and archive extraction are outside this decision.

## Verification

- Exact prepare, chunk, seal, and bind retries return one publication, one
  content identity, and one Task artifact revision.
- Response loss at every state converges through status lookup without a second
  Artifact.
- Sealed-but-unbound content survives restart and can bind or expire safely.
- A bound Artifact cannot reference unsealed, mismatched, or cross-Team bytes.
- Delivery retries preserve identical Artifact content metadata.
- Target staging rejects traversal, symlinks, special files, digest mismatch,
  and unsupported content before Runtime invocation.
- Artifact B records immutable lineage to Artifact A and enters the existing
  result-evidence cursor.
- Deterministic two-Bridge recovery tests pass before separate physical-machine
  acceptance evidence is claimed.
