# Workspace Coordination Module

- Prefix: `WSP`
- Implementation: `apps/server/src/workspace/`, migration 0035, and
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
against the current generation. `isolated_worktree` names a Bridge-created
worktree bound to one Task and Run. These write modes are not prerequisites for
Bridge-owned Artifact staging.

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
ADR-0021 without changing lease authority. Write and
worktree modes remain contract-reserved until a later Scheduler milestone.

## Dependencies

Contracts, Registry, Persistence, and Security. Task and Run application
services must authorize their aggregate scope before requesting a lease.
