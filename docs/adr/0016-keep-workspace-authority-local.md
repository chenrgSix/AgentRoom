# ADR-0016: Keep Workspace authority local with scoped leases

- Status: Accepted
- Date: 2026-08-25
- Supersedes: none

## Context

The central Server currently stores only opaque Workspace references. Absolute
paths, filesystem permissions, Runtime configuration, and provider sessions
remain owner-local on the Bridge. Artifact publication needs permission to read
one source file, while future automated scheduling and Artifact application need
coordination against concurrent Workspace changes.

A central lease cannot create an operating-system permission that the Bridge or
Runtime does not have. Conversely, local path access alone must not authorize a
Device to publish evidence for an unrelated Team, Task, Agent, or Run.

## Decision

Workspace Coordination owns only opaque identity, generation, and coordination
leases. The Bridge owns the absolute path, canonicalization, local policy, and
the final filesystem operation.

A `workspaceRef` is a Bridge-derived opaque identifier for one configured
Workspace. A `workspaceGeneration` is an opaque comparison token derived from
the Bridge-observed snapshot. Neither value contains a path, branch name,
credential, or file content. The Server compares generations for equality but
does not interpret them.

A Workspace lease binds:

```text
leaseId
+ Run / Task / Agent / Device
+ workspaceRef / workspaceGeneration
+ mode
+ issuedAt / expiresAt / releasedAt
```

Initial modes are:

- `read_source`: authorize the assigned source Bridge to publish a named file
  after local path validation;
- `write_apply`: coordinate an explicit operation that changes the configured
  Workspace;
- `isolated_worktree`: coordinate a Bridge-created Task/Run worktree.

The application service requesting a lease must first prove that the Run belongs
to the Task, targets the Agent, and the Agent is managed by the authenticated
Device. Workspace Coordination persists the resulting authorized claim and
uses compare-and-set rules for generation-sensitive write modes. The lease is
not a delegated shell, filesystem, Runtime, tool, or provider permission.

Artifact publication requires a current `read_source` lease. Before requesting
it, the Bridge resolves the configured Workspace and source path without
following a final symlink, rejects traversal and special files, and opens the
file under local owner policy. It hashes the opened stream and rejects a file
whose identity or size changes during capture.

Downloading a pinned Artifact into a Bridge-owned Run staging directory does
not require a Workspace lease because it does not read or modify the configured
Workspace. Copying, applying, merging, or checking out staged content into a
Workspace requires a later explicit `write_apply` or `isolated_worktree` lease.

## Alternatives

- Require a Workspace lease for all Artifact downloads: rejected because
  Bridge-owned staging is not Workspace access and would make content delivery
  depend on future write coordination.
- Let the Server store and select absolute paths: rejected because it violates
  the local authority and privacy boundary.
- Treat a Server lease as permission to bypass local policy: rejected because
  the Server cannot grant capabilities it does not own.
- Use the Runtime scope hash as Workspace identity: rejected because semantic
  Runtime configuration changes independently of the Workspace.

## Consequences

- Bridge publication gains a stable opaque Workspace identity distinct from the
  existing Runtime session scope.
- Read leases provide attribution and revocation but do not serialize unrelated
  read-only Runs. Write modes may be exclusive per Workspace generation.
- Future scheduling can depend on the same lease contract without changing
  Artifact transport semantics.
- Physical path diagnostics remain local and redacted.

## Compatibility and Security

Workspace identity and lease capability publication are additive. An old Bridge
cannot receive a lease and therefore cannot publish snapshot content or apply
it to a Workspace; it continues using reference-only Artifacts.

Lease issuance requires an active Device credential, enabled Agent assignment,
active Run and Task scope, exact Workspace identity, bounded expiry, and an
unexpired local request. Revocation, terminal Run state, Agent disablement,
Device revocation, or generation conflict prevents new filesystem operations.
An already opened file is still guarded by final identity, size, and digest
checks before seal.

## Verification

- Cross-Team, cross-Task, cross-Agent, foreign-Device, terminal-Run, expired,
  and stale-generation requests fail.
- A read lease cannot authorize Workspace mutation.
- Bridge logs, Server state, Web responses, and wire messages contain no
  absolute Workspace path.
- Target staging succeeds without a Workspace lease and cannot apply content to
  the Workspace.
- Write modes serialize shared Workspace changes and reject stale generations
  before they are used by an automatic scheduler.
