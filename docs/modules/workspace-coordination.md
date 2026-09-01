# Workspace Coordination Module

[ADR-0036](../adr/0036-add-governed-software-team-execution.md) defines the next
write/worktree milestone. It requires explicit owner-local repository bindings
and grants, unique isolated attempts, actual runtime enforcement capability and
generation fencing before governed coding starts. A central lease remains
coordination, never an OS permission. Source-read and isolated-attempt leases
have separate modes and admission rules; neither silently upgrades the other.

- Prefix: `WSP`
- Implementation: `apps/server/src/workspace/`, migrations 0035, 0042, 0061-0062, and
  `bridge/internal/workspace/`
- Owns: opaque Workspace identity, generation snapshots, and Run-scoped access
  leases

## Purpose

Workspace Coordination lets the control plane coordinate local work without
turning the Server into a filesystem authority. It proves which active Run may
request one bounded local operation and which Workspace generation that
operation observed.

## State and Ownership

| Entity | Required State |
| --- | --- |
| Workspace identity | workspaceRef, Device, Agent, latest generation, capability flags, timestamps |
| Workspace lease | leaseId, Run, Task, Agent, Device, workspaceRef, generation, mode, state, expiry, timestamps |

The Server owns the opaque lease record. The Bridge owns the absolute path,
path canonicalization, local policy, filesystem handle, repository inspection,
and operation result. A lease authorizes coordination only; it cannot grant a
local permission or prove that a command is safe.

Under
[ADR-0021](../adr/0021-unify-central-installation-and-device-onboarding.md),
onboarding names the owner-local configuration a **Workspace binding**, not a
central Workspace grant. The binding may contain a display alias, absolute root,
per-Agent selection, filesystem policy, and network policy. The Bridge is its
only authority. The Server may receive an opaque `workspaceRef`, generation,
capability flags, a locally allowed alias, and the existing closed Runtime
policy summary; none of those values creates an operating-system permission.

Device pairing creates no binding and discovers no path. Adding an Agent or
Workspace locally requires an explicit owner save. Runtime preflight and
self-test may inspect only the local draft under their existing bounded rules
and cannot publish or persist a broader central authority.

`WSP-002` implements that boundary. Bridge configuration schema version 5
stores one optional owner-facing alias beside each absolute local root and
derives a safe directory-name alias when migrating older files. The local
Console exposes the alias, absolute root, per-Agent selection, derived
filesystem policy, and Runtime-managed network policy; only the alias is new
wire data. Migration 0042 persists that alias in the Agent projection. It does
not persist a root, command, environment, or mutable filesystem/network policy.

## Main Flows

For source publication, the Bridge derives its opaque identity and generation
and validates metadata for one file within the configured Workspace without
opening or reading it. It then requests a `read_source` lease for the assigned
Run. The Server validates Run/Task/Agent/Device scope before issuing a bounded
lease. Only after the accepted lease does the Bridge open and double-read the
file; Artifact Content Transport accepts only that lease and still verifies the
final content digest.

The implemented Device-authenticated snapshot endpoints expose only the active
Run's current opaque Agent generation. When local metadata has advanced, the
Bridge revalidates its unopened source observation and compare-and-sets that
generation without reconnecting. The Device-authenticated lease endpoint then
accepts only the refreshed Workspace identity and generation. The Bridge keeps
the configured root and source path local, rechecks the Workspace generation
across a double-read capture, and sends only a basename plus immutable byte
metadata downstream.

For a future Workspace apply operation, `write_apply` uses compare-and-set
against the current generation. `isolated_worktree` identifies one isolated
attempt whose actual worktree is created by the Bridge Repository adapter.
Neither mode is a prerequisite for ordinary Bridge-owned Artifact staging.

## Isolated Attempt Coordination

`IsolatedWorkspaceLeaseService` is an internal Run-admission and authenticated
Repository-operation port. Migration 0061 preserves a unique reservation per
Run and per plan revision/node/dispatch generation. Deterministic path-free
lease/workspace identities are distinct from an Agent's configured source root.
Every new attempt receives a distinct identity, including after expiry or
revocation. Old identities are never reassigned to another writer.

Reservation requires a caller-owned transaction so the scheduler can create the
Run, reserve its workspace and freeze the manifest atomically. It validates the
complete manifest and digest, exact approved repository/scope/output/profile
pins, current plan/Task/Room/Team/Device/Agent authority, Task assignments, grant
snapshot expiry, Run deadline and current Bridge connection capability.
An advertised workspace boundary does not satisfy a preventive per-path
requirement. Unsupported or stale capabilities fail before reservation. The
lease is usable only after the canonical Run manifest is frozen and matches it.

The initial reservation remains immutable. Generation advances, revocation and
release are append-only operations with exact actor/payload replay identities,
monotonic revisions and expected-generation compare-and-set. Concurrent
processes cannot both advance the same revision. Returning to an earlier
generation is forbidden, including returning to the initial generation; this
prevents a stale operation from matching after an intervening change.

Fresh use rechecks current scope, the frozen manifest, capability and expiry.
Closing a lease only reduces coordination authority and is irreversible. It
does not mark a Run terminal, acknowledge `outcome_unknown`, free scheduler
capacity, attest that a process stopped, or authorize filesystem cleanup.
Historical Repository receipts remain owned by Repository Execution; a delayed
receipt is not permission to start a new operation under an expired lease.

The Device-authenticated `POST /api/bridge/governed-runtime-authority` endpoint
is the read-only just-in-time projection of that existing check. Its closed
request must match the exact Run, manifest digest, isolated lease, workspace
reference and current generation. The response repeats those pins with the
current lease revision, original expiry and observation time under `no-store`.
It rejects changed Device ownership, terminal Run state, inactive/advanced
leases, a pending or resolved cancellation intent, scope drift and malformed
extensions, and it appends no operation.
This endpoint neither grants local filesystem/process authority nor proves that
the Bridge performed its other local admission checks.

These internal ports expose no Agent-controlled shell, path, public lease mint
or generation-write endpoint. Local repository enrollment, grant authentication,
actual worktree creation, runtime enforcement and cleanup stay with REPO-001,
BRG-071 and RUN-018. The production Bridge now advertises `prepare` plus
`capture` only after recovery and attaches path-free current grant summaries to
the same-epoch exact-Agent publication. This coordination layer still does not
derive a manifest or treat that summary as authority. Governed coding remains
closed until RUN-018 validates an approved plan, freezes the exact capture
intent and matches the manifest to one current summary.

Repository Capture derives a separate `read_capture` content lease from one
authenticated capture operation and its frozen isolated generation. Migration
0062 preserves existing source leases/publications while adding that explicit
mode. The derived lease grants neither filesystem access nor a new writer;
Repository rechecks its parent and capture lifecycle on new content effects.
It does not publish or refresh the Agent's default Workspace identity. A closed
capture or inactive parent cannot be used to mint further canonical output.

## Failure and Recovery

- An exact lease retry returns the existing identity.
- Expiry and release are terminal for new operations.
- A terminal Run or revoked Device/Agent invalidates further use even if the
  stored expiry is later.
- New Artifact observations and descriptions derive distinct lease attempt
  identities, so expiry of one operation cannot prevent later publication by
  the same active Run and Workspace generation.
- Source snapshot refresh is explicit, active-Run-scoped, and compare-and-set;
  a conflict is read and rejected rather than overwritten.
- Generation mismatch fails before a write operation starts; source-read
  refresh does not weaken future write-mode compare-and-set rules.
- The Server may reconstruct active coordination from durable rows after
  restart, while the Bridge revalidates every local precondition.

## Security and Verification

Opaque references are bounded and path-free. Device authentication, assignment,
Room membership, active Run state, Task scope, mode, expiry, and generation are
negative-tested. Symlinks, traversal, special files, and file replacement cuts
are rejected locally. Logs expose only lease and opaque scope IDs.

## Task Mapping

`WSP-001` implements the first `read_source` lease. `WSP-002` productizes the
Bridge-owned Workspace binding and path-free central projection required by
ADR-0021 without changing lease authority. `WSP-003` owns isolated-attempt
reservation and generation/lifecycle coordination. Actual local operations and
their hookup to existing Run delivery are separate Repository/Bridge/Run tasks.

## Dependencies

Contracts, Registry, Persistence, Security and exact Execution Plan approval.
Task and Run application services must authorize their aggregate scope before
requesting a lease; local enforcement remains the Bridge's responsibility.
