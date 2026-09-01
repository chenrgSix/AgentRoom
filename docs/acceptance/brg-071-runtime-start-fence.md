# BRG-071 Durable Runtime Possible-Start Fence Evidence

Status: prerequisite increment implemented; production governed execution is
still disabled.

## Accepted boundary

This increment closes the local duplicate-start/restart ambiguity in isolation.
It does not connect governed delivery, advertise a capability, start Codex,
clean a surviving process, resolve independent verification profiles or prove a
positive host sandbox.

The reviewed design keeps three append-only facts distinct:

1. `claimed` binds one exact frozen manifest to one prepared worktree identity
   and one owner-local Runtime profile. It proves no startup authority.
2. `starting` is written only after a caller-supplied current-authority check.
   Once it exists the process may have started, so no replay may invoke again.
3. `stopped` binds a closed local process outcome to the exact claim and start
   digests. It is not verification or Task completion.

This is intentionally conservative at the write/invoke crash cut. Losing the
response or crashing after `starting` produces an ambiguous possible start, not
permission to retry.

## Implemented evidence

- `NewRuntimeAdmissionSpec` validates the generated version-1 execution
  manifest and canonical manifest/input digests. It retains exact Plan control,
  Task definition/criteria, Run, dispatch generation, Device, grant,
  repository, isolated workspace lease, Runtime profile and prepared Git pins.
- `DecodeGovernedManifest` separately validates the delivery representation and
  joins it to the outer Run/Room/Task/Agent/deadline and frozen Context Manifest
  version, revisions, target Agent/Device and record time before conversion to
  the repository representation. Cross-delivery substitution fails before any
  durable local admission state.
- The prepared Run, workspace reference/generation and base commit must match
  the manifest. The profile must be unrevoked and match its Agent and exact
  manifest ID/digest. SHA-1 and SHA-256 prepared object identities remain
  distinct and length-consistent.
- Persisted/view data contains no worktree path, Git path, branch, raw physical
  identity, command or environment value. Only the prepared physical identity's
  SHA-256 is retained.
- Claims are immutable and owner-namespaced. Exact same-Run replay returns the
  original bytes; changed same-Run input and cross-Run reuse of a workspace
  generation, preparation operation or physical identity fail closed.
- `Start` requires an expected admission digest and non-nil authority callback,
  rechecks immutable state and all local expiry ceilings after callback return,
  then fsyncs start-intent before returning the sole `invoke=true` decision.
- Competing starts can perform read-only authority checks, but only the first
  durable start writer can invoke. Started/stopped replay bypasses the callback
  and always returns `invoke=false`.
- Stop receipts require exact admission/start digests and one closed outcome.
  Exact replay is stable; changed outcomes conflict. Restart retains the same
  state.
- Recovery closes only unresolved `starting` records as `outcome_unknown` and
  leaves claim-only records untouched. Its API explicitly requires the caller
  to fence or terminate a surviving process first.
- The Server now exposes a Device-authenticated, no-store, read-only authority
  observation for the exact Run/manifest/lease/workspace generation. It reuses
  current scope, frozen-manifest, capability, Device, Run-state, cancellation
  and expiry validation and records no lease operation.
- Both request and response are closed definitions in the authoritative
  execution-runtime JSON Schema, generated into TypeScript and Go and admitted
  through the shared strict raw-wire validators before business use.
- `RuntimeAuthorityClient` binds that response to the exact local admission,
  revision-1 lease and original expiry. Malformed, stale, foreign-origin,
  unauthorized and unavailable observations all fail closed. This client is
  now used only by the internal admission coordinator, so it changes no
  production capability.
- `GovernedAdmissionCoordinator.Prepare` freezes the typed outer delivery,
  re-decodes its exact governed manifest, checks current Task consent, binds
  exact ordered patch bytes, resolves the registered repository, deterministically
  prepares the isolated worktree, physically re-probes the exact Codex profile
  and records the path-free claim. Verification profiles and non-patch inputs
  stay explicitly unsupported.
- `GovernedAdmissionCoordinator.Start` repeats every mutable local prerequisite
  inside the fence callback and performs the authenticated Server observation
  last. It exact-compares input bytes, prepared workspace identity, profile,
  rebuilt admission and Server response before the possible-start append. The
  transient worktree path is returned only with the sole `invoke=true` decision
  and is never serialized.
- The coordinator still invokes no Runtime, emits no event, retains no process
  handle and advertises no capability. No production Handler or inbox path
  constructs it, and its input loader remains an injected internal boundary.
- `ExecutionInputClient` is the concrete implementation of that boundary. It
  validates the paired Device and entire manifest before networking, forbids
  redirects, preserves exact input order and accepts only unique repository
  patch inputs within the Server's 4 MiB limit. Each bounded response must
  reproduce the no-cache/sniffing/media, binding, length and digest metadata;
  the actual bytes are SHA-256 checked and never cached.
- Orphan stages, malformed/linked/permissive records, directory replacement,
  non-canonical records and inventory overflow fail closed through the shared
  strict owner-state primitives.

## Focused verification

The focused suite covers exact outer-delivery joins, manifest digest drift,
exact prerequisite joins and drift, path-free durable claims, expiry, immutable
replay/collision, callback denial, concurrent start, post-callback expiry, exact
stop/reopen, ambiguous recovery, orphan stage and directory replacement. It
passes normally and under Go's race detector; Go vet also passes for the
admission package.

The current increment adds 40 focused Server lease/capture cases, including the
authenticated HTTP surface, no-store response, exact replay, generation drift,
foreign credentials, terminal Run and pending cancellation. The complete
Server suite passes 477/477 and its production TypeScript build passes.

The coordinator-focused suite proves exact prepare/recheck/Server-observation
order, caller-input and Agent-config freezing, cancellation before preparation
or possible start, path-free serialization, one invoke decision and replay
without a second authority callback. It also covers grant denial, unsupported
verification authority, input binding/kind/length/digest drift, prepared
identity drift, Runtime-profile drift and rejected/changed Server authority.
The input-client cases add exact ordered success plus zero-request invalid
manifest/device/origin/duplicate/destination/kind/limit negatives. Response
status, redirect, metadata, media, length and actual-content drift all fail
closed. The review caught and repaired a partial-read ordering bug by moving
whole-manifest preflight before the first HTTP request.

The contract package passes 78 Node checks, generated/current TypeScript, Go
round trips and 243 shared positive/negative fixtures. The Bridge admission
package passes normally, under the race detector and under vet; all 26 Bridge
packages pass. Native macOS and Windows/Linux amd64 CLI builds plus both
cross-compiled admission tests pass. Seven deterministic compatibility E2Es
pass and the explicitly live provider case is skipped. Markdown lint covers 312
files and the final diff has no whitespace errors. These checks validate this
primitive; they do not substitute for production Server/Bridge/Runtime
acceptance.

## Remaining BRG-071 gates

- wire the exact governed manifest through the existing inbox without opening a
  second Runtime-start path;
- construct the reviewed coordinator under the Bridge process-owner context
  and route only exact governed delivery into it;
- retain/terminate the process handle and connect stopped-Run, revocation and
  owner-visible cleanup;
- expose owner setup/state without leaking local details;
- obtain actual no-start and positive-start evidence before advertising the
  governed capability.
