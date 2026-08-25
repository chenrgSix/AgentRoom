# Artifact Content Transport Module

- Prefix: `ART`
- Implementation: `apps/server/src/artifact/`, `apps/server/src/http/artifact-routes.ts`,
  `bridge/internal/artifact/`, and migrations 0036-0038
- Owns: Blob uploads, sealed content, content retention, authenticated transfer,
  and materialization receipts

## Purpose

Artifact Content Transport makes selected Task result evidence available across
Devices without becoming a second Artifact authority or a central filesystem.
It transports bytes identified by immutable size and digest; Task Collaboration
decides whether those bytes become canonical Team evidence.

## Ownership Boundaries

- Task Collaboration owns canonical Artifact identity, Task revision, creator,
  provenance, type, title, summary, and Artifact lineage.
- Artifact Content Transport owns upload progress, sealed Blob metadata, storage
  keys, retention, content download authorization, and materialization receipts.
- Workspace Coordination owns source access and later Workspace-write leases.
- Run Orchestration pins content-bearing Artifact metadata into one durable Run
  delivery.
- The Bridge owns source paths and Run-scoped staging paths. Neither crosses the
  Server boundary.

## State

| Entity | Required State |
| --- | --- |
| Blob upload | upload/publication identity, Team and Device scope, idempotency key, declared size/digest/media type, received offset, state, expiry |
| Artifact content | contentId, Team scope, SHA-256, size, storage key, sealed timestamp |
| Publication lineage request | bounded normalized relation type and older target Artifact ID pairs included in the prepare fingerprint |
| Materialization receipt | target Run/Device delivery scope, Artifact/content IDs, logical alias, media type, size, digest, and verified/reused state; no local path |

The first BlobStore is a bounded local-filesystem adapter. Temporary and sealed
files share a filesystem so seal can fsync and atomically rename. SQLite stores
metadata only. Migration 0036 retains immutable Team-scoped content rows and
durable publication operations; publication metadata carries the validated
Artifact type, file name, and media type until Task Collaboration binds it.
Migration 0037 then links exactly one sealed publication to one new canonical
Task Artifact without moving Artifact ownership into this module.
Migration 0038 retains the normalized lineage request on the publication and
requires a bound publication's canonical Artifact relations to match it
exactly. Task Collaboration still owns the relation records and their revision
semantics.

The first Bridge source client exposes an explicit `artifact publish` command.
It captures one allowlisted typed file, requests the assigned Run's lease over
the Device-authenticated HTTP boundary, and drives prepare, ordered chunks,
seal, and bind. Deterministic idempotency keys plus publication status lookup
recover response loss without inventing another Blob or Artifact identity.
Optional repeatable `--derives-from`, `--reviews`, and `--verifies` flags are
normalized into that same publication identity; changing lineage under an
existing idempotency key is a conflicting request rather than a retry.

## Publication and Bind

```text
prepare -> receive ordered bounded chunks -> seal bytes
        -> Task-owned transactional bind -> canonical Artifact becomes visible
```

Chunk append requires the exact current offset, bounded size, and publication
identity. Exact replay is idempotent; overlap, gap, conflicting digest, or quota
excess fails closed. Seal verifies the complete stream and records a
content-addressed identity. A missing temporary file plus a matching sealed Blob
is accepted only when that same publication already records its full declared
length, closing the rename-before-database crash window without allowing a
known digest to bypass upload. Bind inserts one immutable Task Artifact and
advances its revision in the same SQLite transaction that closes the
publication.
The bind transaction also appends the requested canonical relations. It rejects
unknown, duplicate, cross-Task, cross-Room, self, or non-older targets before B
becomes visible. A bound response-loss retry compares the requested relation
specification with B's retained canonical lineage and returns the existing
identity only on an exact match.

Only bound canonical Artifacts enter Context Planner, Web preview, Memory
provenance, or Run delivery. Sealed-but-unbound content is recoverable storage,
not a result.

## Delivery and Materialization

A durable Run payload pins Artifact ID/revision plus content ID, media type,
size, and digest. The authenticated target Device downloads only content named
by its pending or accepted delivery. The implemented content endpoint resolves
authorization from that frozen payload and verifies the immutable sealed Blob
before returning bytes; a same-Team source or sibling Device is not sufficient.
`BRG-029` writes those bytes in authenticated 256 KiB ranges to an owner-only
temporary file under a Bridge-owned Run/Artifact directory, checks the pinned
metadata, size, media type, and digest, fsyncs, atomically renames, and protects
the final file as read-only and non-executable. A path-free local receipt makes
rename-response loss and Bridge restart converge to `reused`. Existing
symlinks, special files, traversal-shaped identifiers, permission drift, and a
staging root inside the configured Workspace fail closed. No configured
Workspace file is created or replaced.

Completed `ADP-014` revalidates the staged bytes, receipt, and mode immediately
before Runtime admission, then gives Codex, Pi, or Generic a bounded local alias
manifest. The Runtime may read the staging path only under its existing local
sandbox policy. Exact paths never enter the wire or durable inbox: every
Runtime text boundary replaces them with the pinned logical alias, including
split streaming output. Result-evidence consumption advances only at the
existing durable Runtime acceptance point, and a delta cursor gap fails before
execution.

## Recovery Matrix

| Cut | Authoritative observation | Recovery |
| --- | --- | --- |
| before prepare commit | no publication | retry the same idempotency key |
| prepare response lost | publication lookup succeeds | reuse publication and offset |
| chunk response lost | durable offset is queried | resend only when offset did not advance |
| seal response lost | sealed content identity is queried | reuse the same content identity |
| sealed before bind | publication is sealed and unbound | retry exact bind or expire by policy |
| bind response lost | canonical Artifact ID is stored on publication | return the existing Artifact |
| Server or Bridge restart during download | Run delivery still pins content and `.part` retains its exact offset | target resumes authenticated ranges without accepting partial bytes |
| target rename response lost | local receipt and digest agree | return the existing alias |
| Runtime acceptance ambiguous | provider may have received prompt | do not advance result cursor or rerun blindly |

## Initial Bounds

The first slice supports Patch, Markdown document, and JSON test result content
up to 4 MiB. Chunks are ordered and bounded. Images, arbitrary files, archives,
directories, repositories, executables, HTML execution, and Workspace apply are
deferred.

## Security and Verification

All source reads require a current `read_source` lease and local path checks.
Content access is Team- and delivery-scoped. Deduplication never exposes
cross-Team content existence. Tests cover traversal, symlinks, special files,
changing source files, MIME mismatch, size/digest mismatch, quota, expiry,
duplicate and out-of-order chunks, response loss, restart, and unauthorized
download. Read-only mode is not presented as an OS sandbox guarantee.

## Task Mapping

`ART-001` owns durable upload and seal. `TASK-010` owns canonical bind,
`CON-010` the additive wire contract, completed `BRG-028` source publication,
completed `RUN-011`
pinned delivery, completed `BRG-029` isolated materialization, completed `ADP-014`
Runtime alias injection, completed `TASK-011` lineage, `WEB-040` preview, and `QA-020` the deterministic
two-Bridge recovery gate.

## Dependencies

Contracts, Workspace Coordination, Persistence, and Security. Task and Run
modules consume sealed content through explicit ports without transferring
canonical Artifact ownership.
