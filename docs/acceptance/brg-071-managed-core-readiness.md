# BRG-071 Managed-Core Readiness Evidence

## Scope

This increment connects the previously isolated governed admission components
to the production Bridge core without claiming complete governed delivery. It
owns startup recovery, production Handler injection, exact Agent readiness and
truthful capability publication. Repository capture, Result publication,
in-flight revocation, owner-visible setup/cleanup and real positive host Runtime
acceptance remain open under BRG-071, RUN-018 and REPO-001.

## Reviewed Startup Order

The production sequence is closed and fail-safe:

1. Open the governed Inbox, admission fence and process inventory even when Git
   is missing or no Agent is configured.
2. Fence every nonterminal process record, then recover governed Inbox/admission
   state before ordinary replay.
3. Validate the complete local grant, profile and repository inventories.
4. Derive ready Agent IDs from the current configured Agent, unexpired and
   unrevoked Task grant containing `prepare`, supported exact Runtime profile,
   repository binding and physical Git source.
5. Replace the Handler's ready-Agent set and only then permit network dialing.
6. Publish the same prepare-only declaration in `bridge.hello` and each ready
   Agent's authenticated capability record; flush recovered events afterward.
   A new hello starts with an empty current-epoch Agent set, so queued governed
   delivery waits for that connection's exact Agent publication.

Any recovery/readiness error prevents connection and publication. Missing Git or
Agents leaves the recovery layer active while new governed admission stays off.
Per-Run delivery rechecks the exact grant, prepared workspace, profile and
current Server authority and cannot rely on startup readiness as permission.

## Capability Review and Repair

The initial implementation direction risked declaring the complete version-1
capability when only safe preparation was connected. The wire contract permits
governed transport only when both `prepare` and `capture` exist, so the reviewed
implementation publishes only the operation actually available: `prepare`.

Central now stores a governed capability only through the owning authenticated
Bridge. A managed Agent's declaration must be a subset of the current Device
hello for version, workspace boundary, preventive enforcement and operations.
It is also retained in the in-memory connection epoch only after the Agent
publication transaction succeeds. A new hello, replacement or disconnect drops
that current Agent set. Governed send and workspace admission require both
`prepare` and `capture` on the current Device, current exact Agent publication
and matching persisted Agent projection. Web, hosted and manual publication
cannot forge it, and malformed persisted JSON fails closed. Consequently this
increment exposes truthful readiness but cannot route a governed Run.

The Handler also checks the exact ready-Agent set before Inbox mutation. This
prevents a Device-level declaration or another ready Agent from authorizing the
wrong Agent and preserves ordinary delivery behavior.

Compatibility E2E review found that macOS temporary roots can use the standard
`/var` parent alias for the same physical `/private/var` directory. The first
resource composition rejected that safe parent alias and prevented ordinary
Bridge startup. The repaired resolver still requires an absolute clean path, a
private non-symlink leaf and a canonical private target, while normalizing only
the parent path before all stores reuse the same physical owner lock. A dedicated
test accepts a parent alias and rejects a symlinked data-directory leaf.

## Focused Verification

- `npm run build --workspace @convene-wire/server`
- `node --import tsx --test apps/server/test/agent-service.test.ts apps/server/test/bridge-connection-registry.test.ts apps/server/test/bridge-websocket.test.ts apps/server/test/isolated-workspace-lease.test.ts`
- `GOCACHE=/private/tmp/convenewire-go-cache-managed-core go test ./internal/admission ./internal/connection ./internal/delivery ./internal/bridgecore`
- `GOCACHE=/private/tmp/convenewire-go-cache-managed-core go test -race ./internal/admission ./internal/connection ./internal/delivery ./internal/bridgecore`
- `GOCACHE=/private/tmp/convenewire-go-cache-managed-core go test ./...`
- `GOCACHE=/private/tmp/convenewire-go-cache-managed-core go vet ./...`
- `GOCACHE=/private/tmp/convenewire-go-cache-managed-core npm test --workspace @convene-wire/server`
- `npm run build`
- `GOCACHE=/private/tmp/convenewire-go-cache-managed-core npm run test:e2e`

The regressions cover recovery-before-network, zero requests after recovery
failure, prepare-only hello and Agent publication, replay after publication,
unknown-Agent rejection, exact Agent readiness changes after grant expiry or
revocation, recovery-only construction without Agents or Git, and no Inbox,
admission or Runtime side effect for a non-ready Agent. Server negatives cover
forged manual capability, Device/Agent mismatch, exact Agent omission,
prepare-only admission, current-epoch reset/downgrade and
preventive-enforcement mismatch. The full Server suite has 477 passing tests;
the compatibility E2E suite has seven deterministic passes and one explicit
live-Runtime skip. Windows amd64 and Linux amd64 Bridge CLI cross-builds pass.

## Direction Audit

This increment remains on the accepted ADR-0036 path:

- Discussion/Wave and the existing Task/Run/Result lifecycle are unchanged.
- Central coordinates and authenticates bounded metadata; it receives no local
  repository path, Runtime command, environment value or grant secret.
- Bridge remains the sole local repository, profile, process and grant authority.
- Recovery precedes advertising, capability is an intersection rather than an
  authorization union, and partial implementation remains visibly closed.
- One Inbox, per-Agent execution gate, cancellation tombstone, event sequence and
  terminal replay path are reused; no second Runtime-start path was introduced.

This is implementation, regression and ordinary compatibility E2E evidence,
not real positive governed Codex execution, governed product E2E, physical
Windows acceptance or production release admission.
