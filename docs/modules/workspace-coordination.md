# Workspace Coordination Module

- Prefix: `WSP`
- Planned implementation: `apps/server/src/workspace/` and
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

## Main Flows

For source publication, the Bridge derives its opaque identity and generation,
validates and opens one file within the configured Workspace, and requests a
`read_source` lease for the assigned Run. The Server validates Run/Task/Agent/
Device scope before issuing a bounded lease. Artifact Content Transport accepts
only that lease and still verifies the final content digest.

For a future Workspace apply operation, `write_apply` uses compare-and-set
against the current generation. `isolated_worktree` names a Bridge-created
worktree bound to one Task and Run. These write modes are not prerequisites for
Bridge-owned Artifact staging.

## Failure and Recovery

- An exact lease retry returns the existing identity.
- Expiry and release are terminal for new operations.
- A terminal Run or revoked Device/Agent invalidates further use even if the
  stored expiry is later.
- Generation mismatch fails before a write operation starts; it never silently
  refreshes the requested generation.
- The Server may reconstruct active coordination from durable rows after
  restart, while the Bridge revalidates every local precondition.

## Security and Verification

Opaque references are bounded and path-free. Device authentication, assignment,
Room membership, active Run state, Task scope, mode, expiry, and generation are
negative-tested. Symlinks, traversal, special files, and file replacement cuts
are rejected locally. Logs expose only lease and opaque scope IDs.

## Task Mapping

`WSP-001` defines and implements the first `read_source` lease. Write and
worktree modes remain contract-reserved until a later Scheduler milestone.

## Dependencies

Contracts, Registry, Persistence, and Security. Task and Run application
services must authorize their aggregate scope before requesting a lease.
