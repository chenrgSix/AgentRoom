# BRG-071 Owner-Local Runtime Profile Registry Increment

Date: 2026-09-01. Scope: owner-local Codex profile registration, immutable
inventory/revocation and exact Runtime-profile resolution before TaskGrant
issuance. Delivery state remains only in TASKS; this increment does not complete
BRG-071, advertise a governed capability or start a Runtime.

## Implemented Behavior

- `repository profile register/list/revoke` uses the existing Bridge process
  owner and exact paired Central/Team/Device/human-owner namespace. Registration
  requires a current Device credential, one existing stable configured Agent,
  a new profile identity, exact permission-profile name and `--confirm`.
  List/revoke remain available with an expired credential and start no Run
  machinery.
- Registration derives an immutable configuration digest from the selected
  Agent's stable identity, Codex runtime/adapter/preset, command, workspace-write
  sandbox, resolved session-conflict policy, safe environment names and
  permission profile. It excludes display metadata and the ordinary Workspace;
  no environment value, command or path is retained in the profile record or
  printed view.
- The store, not the caller, creates unique private workspace/outside roots
  beneath an owner-specific probe directory. It resolves only the safe local
  environment names and invokes the real `ProbeCodexLocalBoundary`. Exact probe
  time, native macOS platform, executable/profile digests, workspace-write plus
  outside-deny boundary and verified IPv4 loopback denial must all agree.
- Probe roots are removed and their absence verified before an immutable record
  is written. A failed physical probe or cleanup writes nothing. Exact replay
  reruns the probe and must reproduce the same intent/boundary while returning
  the original digest and registration time.
- The path-free inventory exposes only the profile specification, digests,
  named boundaries, platform and time. A revision-2 tombstone requires the exact
  reviewed revision-1 digest, is replayable and cannot restore authority.
  Corrupt, foreign, orphan-revocation, unsafe-permission or replaced-directory
  state fails closed.
- `repository grant issue` now resolves the exact Runtime profile revision and
  digest against the selected stable Agent and its current execution-bearing
  configuration before retaining consent. A missing/revoked/stale profile,
  Agent mismatch or configuration drift rejects. Nonempty verification profiles
  reject until VER-001 provides their independent registry and resolver.
- `ProbeCodexRuntime` provides a transient just-in-time recheck for an exact
  caller-derived prepared workspace. It creates its own private outside root,
  resolves the same safe environment names, reruns the real physical detector,
  requires the registered executable/profile/platform/boundaries to match,
  removes the root and re-resolves current profile authority before returning.

## Review Resolutions

The first implementation shape would have let the CLI construct probe paths and
pass independently derived execution values to the registry. Review moved both
scratch-root ownership and command/environment resolution into the store, so the
mutation API accepts one configured Agent and cannot persist caller assertions as
physical evidence. Cleanup was moved before immutable record creation, and exact
replay was kept as a fresh physical probe rather than a database-only lookup.

Review also added strict persisted-record inspection, exact probe-time binding,
actual pinned-directory replacement coverage, unsafe secret-environment rejection
and negative resolution matrices for revision, digest, Agent and configuration
drift. During CLI integration, a branch-local error variable could hide an
immutable TaskGrant conflict behind zero-value output; distinct error variables
and the changed-consent regression now prove propagation.

Verification profiles are not treated as optional decoration. Their presence
fails closed until the independent verifier authority exists. This avoids
creating apparently complete consent that later silently skips an unavailable
gate.

## Authority Boundary and Remaining Work

A registration is durable historical evidence for one physical probe, not a
bearer permit or current startup fact. Environment values can change without
changing the names-only configuration digest, the executable can be replaced,
and a previously valid boundary can regress. The new transient API now resolves
and reruns that profile against an exact prepared workspace, but production
admission must invoke it while holding current owner grant, authoritative Run and
write generation. A durable start-intent/no-duplicate journal must still fence
the gap before process invocation; authority must be rechecked before startup and
each effect, and cancellation or revocation must stop in-flight authority.

The current installed Codex on this host still fails outside filesystem denial,
so no positive real-host profile record is claimed. The simulated App Server
fixture proves detector/registry plumbing only. Windows/Linux native sandbox and
ACL behavior, resource isolation, owner Console/Web setup, controlled worktree
startup, stopped-Run cleanup, independent verification and real Server/Bridge
delivery remain separate gates. Existing governed manifests still fail the
production no-start fence.

## Validation Record

- Focused ordinary and race suites pass for the new admission package and
  production CLI handler. They cover immutable replay/reopen, physical escape,
  scratch cleanup, raw-record privacy, exact resolution drift, owner/record
  corruption, actual directory replacement, concurrent replay, offline
  revocation and no Run machinery.
- CLI integration uses the real local boundary probe with a controlled App
  Server test process. It proves a safe profile can register and re-probe a
  separate prepared-worktree fixture, a loopback escape leaves no record,
  TaskGrant issuance requires the exact current profile and unresolved verifier
  references fail closed. No model/provider turn runs.
- Full Bridge regression, vet, native CLI build/version, Windows/Linux CLI
  cross-builds, deterministic compatibility E2E, Markdown lint and whitespace
  results are recorded by the BRG-071 task row. Cross-builds do not establish
  native sandbox behavior.

No source repository, external service, release, push or deployment is mutated
by this increment. BRG-071 remains `ACTIVE`.
