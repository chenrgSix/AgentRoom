# Source-Evidence Authority Design Review

Date: 2026-09-02. Scope: ADR-0038 and the GOV-026 owning-module updates,
checked against the accepted local materialization baseline through QA-052.
This is the implementing agent's explicit design review, not implementation,
provider or production acceptance. Delivery state exists only in
`docs/TASKS.md`.

## Review Method

Read the current accepted, verified and integrated materialization repository,
migrations 0060/0066/0068/0070/0073, dependency/input readers, materializers,
integration admission and the retained QA-052 physical evidence. Traced which
records own content, Result acceptance, independent verification, integration,
plan revision and downstream input authorization. Challenged remote producers,
replay, concurrency, supersession, migration and rollback separately.

## Findings and Resolutions

| Finding | Risk | Accepted resolution |
| --- | --- | --- |
| R1: every current gate row requires a Result | remote Git/CI must fabricate Task authority | closed `task_result` and `repository_commit` source kinds; no synthetic Result |
| R2: proof and content identity are conflated by a materialization row | a CI success or PR URL may be treated as candidate bytes | immutable SourceEvidence is separate from gate-specific proof; canonical sealed content is required before input delivery |
| R3: a proof may be reused under the wrong gate | Agent review, CI, verification or integration can escalate authority | closed gate/proof matrix; unknown or substituted proof kinds fail schema and domain checks |
| R4: global source-Result uniqueness blocks safe revision reuse | compatible plans rerun work or overwrite history | source identity is plan-independent; revision-local adoption has target uniqueness and no global source uniqueness |
| R5: matching node keys do not prove supersession compatibility | changed scope/input/policy silently consumes old evidence | explicit adoption plus exact node-contract and input-set digest equality for the first carry-forward implementation |
| R6: immutable historical evidence can outlive current access | revoked provider or Room scope becomes a durable grant | every new adoption and replay rechecks current actor/service and repository/provider authority |
| R7: nullable legacy fields would create ambiguous mixed readers | older code misreads remote evidence or bypasses joins | additive tables, local backfill/dual-write, shadow equality, reader cutover and versioned non-Result projection before constraint removal |
| R8: dual-write can become two sources of truth | recovery selects whichever row is convenient | one transactional materialization service; after cutover adoption is sole authority and legacy data is projection-only |
| R9: a remote commit hash alone appears content-addressed enough | wrong repository/object format or unavailable bytes reach a Bridge | logical repository, object format, commit/tree, authenticated origin and canonical content digest/artifacts are all pinned |
| R10: provider response loss invites blind repeat | duplicate PR/push/check effects gain evidence | stable intent and exact authenticated lookup; ambiguity stays unknown and cannot be adopted |

## Compatibility Audit

Existing local rows have enough retained data to derive the two selected source
kinds: accepted rows carry exact Results and artifacts; verified/integrated rows
carry the companion Result, checkpoint, repository candidate, input, Artifact
and proof pins. Backfill preserves that Result as a related `task_result` source
rather than discarding it merely because it is no longer universal. Current
local integration is exact fast-forward, so its resulting commit must equal the
repository evidence subject; a mismatch aborts backfill rather than being
normalized away.

The review rejects changing the meaning of the existing wire shape. A new
versioned projection must expose `sourceEvidence` for remote-only records.
Existing clients may continue to read their Result-bearing local projection
during migration. An older binary may roll back only before reader cutover or
against a verified pre-cutover database restore; it must never partially process
new remote-only records.

## Security Audit

- Agent/member payloads cannot select an evidence kind or mint a proof receipt.
- Provider identity comes only from an owner-configured binding and authenticated
  adapter observation; URL and display metadata are non-authoritative.
- Proof subject equality includes logical repository and exact commit/content,
  not only a provider check name.
- Adoption performs no Git, provider, verifier, Task-review or Run-start effect.
- Source reuse does not bypass current membership, revocation, plan approval or
  local grant checks.
- Unknown discriminators, missing canonical bytes, ambiguous provider effects,
  changed operation replay and competing target adoptions fail closed.

## Outcome

No unresolved design blocker remains for a later `REPO-003` implementation.
The selected model preserves existing local behavior and makes non-Agent remote
evidence possible without turning CI into Result, content owner or integration
authority. It deliberately chooses exact contract-digest equality for initial
carry-forward; broader semantic compatibility remains future design work.

GOV-026 acceptance authorizes only the documented architecture. `REPO-003`
still owns contracts, persistence, migration, provider adapters, negative tests,
real local HTTP fault injection and physical content/input evidence. No remote
capability may be advertised before those gates pass.

The task dependency review is acyclic at this boundary: completed REPO-002 and
QA-052 are the only GOV-026 prerequisites; REPO-003 depends on completed
REPO-002 and GOV-026; no source-evidence task depends back on REPO-003. The
decision therefore removes its design blocker without marking any provider
implementation complete.
