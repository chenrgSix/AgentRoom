# Local Bridge

[ADR-0036](../adr/0036-add-governed-software-team-execution.md) adds explicit
owner-local repository bindings and Task-scoped grants. Pairing does not opt
existing Agents into repository execution. Bridge keeps paths, commands,
credentials and enforcement local; Central receives bounded capabilities and
exact operation receipts. Repository preparation, verification and cleanup use
durable operation ownership and never add a second Runtime-start path.

`CON-021` adds the generated version-1 execution wire types but deliberately
does not advertise governed execution from the production Bridge. A governed
Context Manifest is rejected before inbox acceptance and again at direct
Runtime execution; it cannot fall back to an ordinary prompt. BRG-071/RUN-018
must replace this prerequisite with actual owner-local grant, preparation and
runtime admission. The Server keeps capabilities scoped to the current
authenticated connection epoch and does not send governed Runs to legacy or
observing-only connections. Capability metadata is not local authorization.

BRG-071 consumes the REPO-004 local primitives and owns the production local
binding/grant and cleanup adapters, including the owner-visible exact preview
and the existing stopped-Run fence. REPO-001 verifies that complete lifecycle
after RUN-018 connects ordinary Delivery; it is not an implementation prerequisite
of BRG-071. Foundation acceptance never enables a public governed capability.

## Explicit Local Repository Registration

The `repository bind`, `repository list` and `repository revoke` CLI subcommands
are the first owner setup entry for BRG-071. Bind requires an explicit selection,
allowed roots covering both checkout and Git metadata, exact repository/binding
IDs, a safe alias and `--confirm`. It inspects only that selection using the
existing bounded local Git adapter. It does not scan folders, run hooks, fetch,
create an Agent, start a Runtime or modify the source checkout. A local logical
repository ID does not prove Central authorization or cross-Device enrollment.

Registration is immutable under an exact paired Central/Team/Device/human-owner
namespace. Paths and physical directory pins remain under the Bridge data root;
the printed receipt contains IDs, alias, revision, fingerprint and timestamps,
not paths, credentials or a governed-execution capability. Exact same-ID replay
returns the original receipt; changed input conflicts. A moved/replaced physical
checkout cannot inherit consent, while ordinary Git commits retain its identity.

Revocation appends a revision-2 receipt bound to the original registration, never
removes Git data and cannot be undone by reusing the binding ID. It remains
available when Git, the selected checkout or a non-expired Device token is
unavailable, provided the retained paired identity can still be read. Expired
credentials cannot create new registrations. Invalid credential trust or a
different current Central fails closed rather than guessing the old identity.

Standalone administration uses the existing Bridge owner lock, so the running
CLI/Console/Desktop must be stopped first. The future Console integration must
share one store under its existing owner and connect in-flight revocation to
Runtime cancellation; this increment does not claim that behavior. Owner state
uses private Unix permissions, pinned directories and immutable fsynced files;
malformed, duplicate-key, linked or foreign records fail closed. Windows ACL and
native UI acceptance remain separate from cross-compilation.

The managed Bridge core now carries the exact acquired or shell-borrowed owner
in its derived process context for the full connection lifetime. Local stores
opened from that context can borrow the same OS lease without reacquiring or
releasing it, while another data directory still requires its own lock. This is
only lifecycle plumbing: the core does not yet open the governed stores or
construct the coordinator, and the production governed rejection is unchanged.

Local runtime/verifier profiles, enforced startup, owner UI, production cleanup
and RUN-018 delivery remain required. Registration alone is
not a grant and never replaces the existing governed no-start checks. See the
[local registration evidence](../acceptance/brg-071-local-repository-bindings.md).

## Explicit Local Task Consent

`repository grant issue --file /absolute/owner-reviewed-grant.json --confirm`
stores one local `TaskGrantSpec`; `repository grant list` displays its path-free
specification and generated `ExecutionGrantSummary`. Issuance requires the exact
paired Central/Team/Device/owner, a current local Device credential, a registered
physical repository and one existing configured Agent identity. Identity lookup
is read-only: this command cannot provision an Agent or repair an ambiguous
roster. A regular bounded JSON file is parsed strictly, without duplicate keys,
unknown/case-altered/omitted fields, trailing documents or replacement Unicode.

The specification contains these required fields:

| Fields | Meaning |
| --- | --- |
| `grantId`, `bindingId`, `bindingRevision`, `sourceFingerprint`, `repositoryId`, `baseCommit` | Exact new consent identity and reviewed registration/base pins |
| `planId`, `planRevision`, `planDigest`, `nodeKey`, `roomId`, `taskId`, `definitionRevision`, `criteriaRevision` | Exact compiled plan/node/Task definition and criteria |
| `agentId`, `expiresAt`, `operations` | One configured Agent, canonical UTC expiry and generated closed operation kinds |
| `runtimeProfile`, `verificationProfiles` | Exact generated profile ID/revision/digest pins; no command or environment |
| `scopePolicy`, `integrationTargets` | Generated path policy and target pins; arrays are explicit, including when empty |

Issue this consent after plan compilation exposes the canonical child Task IDs.
Draft/approval references express required grant IDs; approving a plan neither
creates local consent nor requires fabrication of not-yet-created Task IDs.
The Runtime profile pin must resolve during issuance to one current owner-local
immutable registration for that exact Agent and current execution-bearing local
configuration. A changed profile revision/digest, Agent identity, command,
sandbox, safe environment-name set or session conflict policy fails closed.
Verification profiles are rejected until VER-001 supplies their independent
registry and resolver. This issuance prerequisite still is not startup proof:
no grant is advertised until production admission reruns the physical boundary
and all remaining gates independently pass.

The immutable version-1 local record contains owner, normalized specification
and issuance time. Its wire-compatible canonical SHA-256 is the grant digest;
it does not hash a self-referential summary. Set-like arrays are sorted and
duplicates rejected. Reusing a grant ID with different scope, expiry or pins
conflicts. An exact valid retry returns the original bytes/time and repeats the
directory durability barrier. Expired grants are never extended by replay.

`repository grant revoke --grant-id ... --expected-revision 1 --expected-digest
... --confirm` retains a separate revision-2 tombstone tied to that exact digest.
The summary preserves the issuance digest and exposes revocation explicitly.
Revoke/list do not require Git, an existing checkout, Runtime executable or an
unexpired Device credential. They still require the retained exact paired owner
and the existing standalone process-owner lock. No record or checkout is deleted.

`CheckTaskGrant` validates current local consent against the generated frozen
manifest, exact plan/Task/Agent/base/profile pins, operation, time bounds, path
scope and physical binding. Narrower path access is allowed; parent-prefix
expansion, dropping overlapping denials or lowering a required preventive policy
is rejected. Read-only consent cannot become a writer. Only prepare/capture/verify
use this prerequisite; integration/external operations require their separate
admission and cannot use it as a generic permission check.

This check is not a complete admission transaction or a transferable permit.
The production caller must still validate current Central authority and profiles,
hold the existing Run/generation fence, enforce the local Runtime boundary and
recheck consent immediately before each effect. In-flight cancellation, owner UI,
just-in-time profile re-probe and full RUN-018 integration remain required. The existing governed
no-start fence is unchanged. See the [Task consent increment](../acceptance/brg-071-local-task-grants.md).

## Owner-Local Runtime Profile Registration

`repository profile register` accepts only an exact existing configured Agent,
new `profile_` identity, installed Codex permission-profile name and explicit
confirmation. It derives the execution configuration digest from that Agent; a
caller cannot supply or persist a command, path, environment value, executable
digest or claimed boundary. Only a safe environment-name allowlist is resolved
inside the store for the physical probe. Ordinary Agent display metadata and its
ordinary Workspace do not enter the digest because governed work will use a
separately prepared exact worktree.

The store creates unique owner-private probe roots below the canonical Bridge
data directory, invokes `ProbeCodexLocalBoundary`, verifies the exact probe time,
supported platform and closed filesystem/network boundary, then removes and
verifies both roots before writing an immutable registration. Any probe or
cleanup failure leaves no positive record. The retained receipt binds exact
Central/Team/Device/human owner, Agent, configuration/profile/executable digests,
boundary names, platform and registration time while exposing no command,
environment value, local path, listener or canary.

An exact replay reruns the physical probe and must reproduce the same immutable
intent and boundary. `repository profile list` is path-free;
`repository profile revoke` appends a revision-2 digest-bound tombstone and can
run with an expired Device credential. Registration needs a current credential.
Both reuse the existing Bridge process-owner fence, reject replaced private
directories and never start Run/inbox machinery.

TaskGrant issuance now resolves its exact Runtime profile reference against the
current configured Agent before retaining consent. This closes fabricated/stale
profile pins at setup time, but it deliberately does not turn the record into a
bearer permit. The future just-in-time admission transaction must resolve it
again, rerun the physical probe against the prepared worktree, hold current
grant/Run/generation authority and recheck immediately before startup/effects.
See the [profile registration evidence](../acceptance/brg-071-runtime-profile-registry.md).

The internal `ProbeCodexRuntime` now implements that transient physical recheck
primitive. It accepts the exact registered reference, current configured Agent
and caller-derived prepared workspace, while the Profile store alone creates the
private outside root and resolves safe environment values. It requires the live
probe to reproduce the registered executable/profile/platform and both boundary
names, removes the outside fixture, then resolves the record again before
returning. It persists no workspace or fresh evidence. The primitive is not yet
wired to production delivery. The internal admission coordinator below now
joins it to the durable start-intent/no-duplicate journal and the other local
prerequisites, but the production Handler still rejects governed execution.

## Durable Runtime Possible-Start Fence

The internal `RuntimeFenceStore` is the next BRG-071 prerequisite. It does not
accept a path, command or ad hoc permission. `NewRuntimeAdmissionSpec` first
validates the generated manifest and both of its canonical digests, then joins
its exact Plan/Task/Run/Device/grant/repository/lease/profile pins to one
`PreparedWorkspace` and one unrevoked `RuntimeProfileView`. Preparation must
match the Run, isolated-worktree reference, generation and base commit. The
retained specification replaces the raw filesystem identity with a digest and
omits the worktree path, Git path, branch, command and environment.

The delivery and repository schemas generate different Go types for the same
execution value. `DecodeGovernedManifest` therefore performs the conversion
only after schema and canonical digest validation, and joins it to the outer
delivery Run/Room/Task/Agent/deadline plus the frozen Context Manifest's
Run/Task revisions, Agent/Device target, version and record time. The current
local path accepts only a Codex target because BRG-071 has no other physical
Runtime profile implementation. An internally valid manifest attached to a
different delivery fails before local admission or inbox acceptance.

`Claim` appends an owner-namespaced version-1 record only while the workspace,
grant and deadline are current. Exact replay returns the original record, while
another Run cannot reuse the same workspace generation, preparation operation
or prepared physical identity. A changed same-Run input conflicts. The store
uses the existing Bridge owner lock, private pinned directories, canonical
strict reads, exclusive fsynced writes and bounded inventory. This claim is
still not startup authority.

`Start` requires the caller's expected admission digest and a mandatory
current-authority callback. The internal `GovernedAdmissionCoordinator` now
builds that callback from one re-decoded frozen delivery and repeats the exact
Task grant, ordered patch-input binding, repository source, deterministic
worktree preparation and physical Runtime-profile probe. The authenticated
Server Run/generation/cancellation observation is the final callback step. Any
changed input bytes, prepared identity, profile or returned Server view fails
closed before the possible-start write. Unsupported commit inputs and any
independent verification profile remain closed rather than being silently
ignored.

The coordinator then delegates the sole possible-start decision to
`RuntimeFenceStore.Start`; it cannot start a process or perform another
irreversible effect. Its transient ticket keeps input bytes and local paths out
of the durable record, and the worktree path is returned only to the sole
`invoke=true` caller and is absent from JSON. After a successful callback the
store checks time and immutable state again, durably appends version-2
start-intent, and returns `invoke=true` only to the writer of that first record.
Every `starting` or `stopped` replay returns `invoke=false` without calling the
callback. Therefore the persisted `starting` state means the Runtime may have
started, including a crash after the append but before the caller invokes it;
recovery never guesses that it is safe to invoke again.

The internal `RuntimeAuthorityClient` now supplies the Central half of that
callback. It posts only the exact Run, manifest, isolated lease,
workspace reference and generation to the Device-authenticated, no-store
authority endpoint, then requires the response to reproduce every value, the
initial lease revision and expiry. A changed or malformed response, rejected
scope, unavailable Server, mismatched credential origin or missing credential
fails closed. The observation creates, extends and caches no authority. It is
composed only in the internal coordinator; no production delivery, Handler,
Runtime executor or capability-advertisement path constructs or calls that
coordinator yet, so it cannot enable a Runtime.

The internal `ExecutionInputClient` now supplies the coordinator's concrete
input-loader implementation. Before making any request it validates the exact
manifest/input digests, paired Device, destination Plan/Task/Run/Agent/Device,
repository identity, unique binding IDs, patch kind and 4 MiB per-input bound.
It then downloads sequentially in manifest order from the authenticated Server
origin with redirects forbidden. Status, cache/sniffing/media headers, binding
ID, declared length, digest header and actual body SHA-256 must all match. A
bad later binding cannot cause an earlier partial download because the whole
intent is preflighted first. The client retains no cache or file; production
still does not construct the coordinator.

`Stop` appends one exact version-3 closed local outcome bound to both admission
and start digests. It does not create a Task Result, verification receipt or
completion decision. `RecoverUnknown` converts unresolved possible-start
records to `outcome_unknown` only after its future production caller has fenced
or terminated any surviving process; claim-only records remain claim-only.
That explicit surviving-process cleanup, inbox/cancellation integration,
production store/coordinator construction, capability advertisement and real
Runtime evidence remain open. The production
governed no-start rejection is unchanged. See the
[possible-start evidence](../acceptance/brg-071-runtime-start-fence.md).

## Codex Local Boundary Probe

The internal macOS `ProbeCodexLocalBoundary` primitive checks one
exact installed App Server executable and named profile without a model turn. It
requires a closed profile definition, verifies workspace write, denies an actual
read and write in separate Bridge-owned private scratch, preserves a random
canary, accepts only an explicit `codex app-server` standard-I/O command, bounds
protocol output, and removes only its generated fixtures. It also proves a fixed
native netcat command can reach an ephemeral IPv4 loopback listener as a host
control, requires the tool's help command to run inside the profile, then
requires the connect to fail with no listener-side connection. No DNS or
external endpoint is used. Unsafe environment variables, inherited sandbox
markers, symlinked/overlapping roots, profile inheritance and widened
configuration fail closed.

A successful simulated fixture proves the detector and registration logic, not
the installed Runtime. The current installed Codex named profile fails the
physical outside read/write check before a combined positive result, so this
host has no positive profile record or governed capability. One loopback denial does not sample every route, and
the probe does not establish resource limits, Windows or Linux. Production
admission must rerun all supported physical checks against the exact governed
workspace while holding current grant and Run authority. See the
[local boundary evidence](../acceptance/brg-071-codex-filesystem-probe.md).

## Scope

- Prefix: `BRG`
- Planned location: `bridge/` and the server Bridge endpoint
- Owns: outbound connection, local delivery inbox, connection epoch

The Go Bridge is an optional local companion for managed Agents. It maintains
one outbound connection to the central server and adapts accepted Run commands
to local Runtime Adapters.

## Responsibilities

- Claim an Owner-created Device pairing session, store the approved credential,
  and establish the outbound channel.
- Publish local Agents and Runtime capabilities.
- Publish one path-free Workspace identity and observed generation for Agents
  that support source-read leases.
- Maintain heartbeat, connection epoch, and reconnect backoff.
- Persist incoming deliveries before acknowledging them.
- Deduplicate deliveries and forward each accepted Run exactly once locally.
- Stream sequenced status, safe Runtime activity, text replies, and handoff
  requests to the server.
- Serve an optional token-authenticated loopback Console for local enrollment,
  Runtime preset configuration, status, and process control.

The Bridge does not store Team history, choose target Agents, authorize
cross-member actions, or provide Room conversation UI. Its local Console owns
only this machine's Bridge configuration and lifecycle.

The Go 1.26.7 process accepts a strict JSON configuration. Runtime commands are
argument arrays, workspaces are absolute paths, environment propagation is an
allowlist, and non-loopback server URLs must use HTTPS. A deployment may also
configure an opaque central Server Token. Bridge HTTP and WebSocket requests
pass it in the dedicated `X-AgentRoom-Server-Token` header; it is access input,
not a replacement for the per-Device bearer credential.

## Managed Enrollment Compatibility

The legacy client-created setup begins with
`convenewire-bridge join --server <url>`. The Bridge detects the local Codex
executable and workspace, submits Device and Agent metadata, and displays a
ten-minute short code. A Team owner enters that code in Web. The Bridge polls
with a separate high-entropy token, claims the approved identity, atomically
writes owner-only configuration and credentials, and immediately connects and
publishes the Agent.

The client never needs a credential copied from the server. Existing config or
credential files stop enrollment before a request is created. Server-issued
single-use invitations remain supported by `pair` for compatibility, but are
not the normal onboarding flow.

### Hub-created Device pairing

[ADR-0021](../adr/0021-unify-central-installation-and-device-onboarding.md)
defines the recommended Hub-created session while retaining the Bridge-created
join request for compatibility. A deep link or QR carries only the
public origin, pairing-session identity, one-time fragment claim secret, and
expiry in the current implementation. Manual short code is a rate-limited
locator plus Owner confirmation, not a credential.

[ADR-0023](../adr/0023-default-public-ca-and-scope-private-bridge-trust.md)
adds a target-only trust descriptor for an explicitly private-scoped origin.
Public-CA links remain unchanged. Private-scoped first pairing requires the
canonical link or QR because a short code alone cannot prove Server identity;
short-code recovery remains valid only after this Bridge already trusts the
exact origin.

The Bridge verifies the HTTPS origin, generates a stable pairing-attempt ID and
high-entropy poll secret locally, and claims the session with safe Device name,
platform, and Bridge version. It sends no Agent roster, Runtime kind, command,
environment, provider identity, absolute path, or Workspace content before
approval. The same transcript-derived verification phrase appears locally and
on the Owner surface.

Owner approval promotes the already-local poll secret to the Device Bearer
credential. The Bridge can therefore recover a lost approval or poll response
by presenting the same attempt and secret; the Server never needs to return or
retain credential plaintext. After terminal consumption the Bridge atomically
writes the same owner-only configuration and starts the existing authenticated
connection and Agent publication flow.

Pairing establishes Device trust only. Runtime discovery remains an explicit,
bounded, non-executing local refresh; Runtime preflight and self-test remain
explicit local actions; Agent save remains the point that persists local
configuration. One paired Bridge may add, edit, or disable multiple Agent
profiles without creating a new Device.

`BRG-043` implements the local half of this flow. The desktop app, loopback
Console, and headless `pair-device` CLI accept the canonical fragment-bearing
link or a manual short code. The installed macOS app and Windows current-user
installer register `convenewire://`; a QR encodes that same link, while portable
clients retain paste and short-code fallback. The desktop nests the link only
inside the authenticated WebView URL fragment and clears it after local
prefill. Claim and poll retries preserve one attempt, operation, and poll
secret; neither anonymous request sends a central Server Token.

The Console requires explicit local configuration confirmation before
claiming. It persists the exact local Agent profiles and promoted poll-secret
credential only after terminal consumption, displays the non-secret
verification phrase during approval, and uses the existing enrollment epoch
to fence cancellation and late callbacks. Pairing state blocks configuration edits, Runtime preflight,
self-test, and Bridge start just like legacy enrollment. No local path, command,
environment variable, Runtime kind, Workspace policy, or Agent roster crosses
the Device claim boundary.

`BRG-049` makes the canonical link authoritative for the first Central address
instead of asking the operator to copy information already present in the
link. Installed protocol launch and manual link paste project one strictly
parsed HTTPS origin into the local form. The authenticated Console backend then
independently parses the complete link with the Go pairing validator and derives
the Server URL before configuration validation, so missing or stale form state
cannot redirect the claim. This projection never imports a CA, reveals the
fragment claim secret, or weakens the later exact-origin scoped-private trust
bootstrap. Manual short-code recovery still requires an already supplied and
trusted Central address because the short code intentionally contains no
origin.

`BRG-050` keeps installed Device-pairing links usable after local
initialization. A configured but not yet paired Bridge presents an explicit
continuation confirmation and reuses its saved local Runtime, Workspace and
privacy settings. A Bridge that already owns a Device presents a replacement
confirmation bound to the displayed `expectedDeviceId`; it must be stopped and
fully drained. Same-Central links reuse the saved connection settings; a different
origin requires the separate `BRG-069` switch confirmation described below.
The authenticated `POST /api/device-pairing/restart` route then reuses the
existing isolated re-enrollment transaction: the old identity and data remain
active until Owner approval returns a complete new identity and the owner-only
sibling data directory is atomically selected. Failure and cancellation keep
the old pairing usable. A different-Central link cannot overwrite connection
settings or carry the old Server Token elsewhere without the explicit switch
flow, which discards old-origin credentials and trust. Closing the confirmation
discards the pending fragment proof from the WebView state.

`BRG-053` makes OS protocol activation a convenience rather than the only
discoverable configured-client path. **Settings → Pairing and recovery → Use
pairing link** accepts one complete canonical link inside the local WebView,
projects only its exact origin, and then enters the `BRG-050` re-pairing or
`BRG-069` Central-switch confirmation. Invalid, ambiguous or concurrent attempts
cannot continue. A running idle Bridge still requires the explicit
stop action, active Runs remain fenced, and the authenticated Go backend parses
the complete link again before starting the isolated replacement transaction.
Canceling either dialog clears the fragment proof; no credential, Runtime,
Workspace or privacy setting is projected into or changed by this entry step.

`BRG-069` ([ADR-0033](../adr/0033-explicit-client-central-switch.md)) allows an
already configured client to switch Central, including IP-to-domain changes,
through **Settings → Central connection → Switch Central** and a complete new
pairing link. The confirmation names both the current and
target origins. Its local request includes `confirmCentralSwitch: true` and
`expectedServerUrl`; paired clients additionally confirm a new Device and supply
`expectedDeviceId`. Stale confirmation cannot replace a newer binding. Configured
clients without credentials use the same staged selection when switching. Merely
pasting a link or loading a desktop deep link never commits a switch.

The stopped-and-drained Bridge claims the target session with no old Server Token,
Device token or private CA; legacy pins, reasoning-sharing consent and remote Agent
provisioning codes are reset. System CA validation or the new link's independently
verified scoped CA establishes target trust. Complete local Agent, Runtime and
Workspace profiles are retained. Approval state names the target while the active
configuration still names the old Central. Only approval plus successful isolated
staging and atomic configuration replacement selects the new Central and starts
its Bridge. Failure, cancellation or external file changes do not overwrite the
old selection. Old data and `previous-bridge.json` remain for recovery; Team history,
Runtime sessions and remote Device revocation are not migrated. This is fresh
pairing, distinct from same-installation hostname migration that preserves identity.

## Local Configuration Console

`convenewire-bridge console` starts the recommended client setup surface on
`127.0.0.1:3210`, opens and prints a one-time random Console URL, and
automatically runs an existing paired Bridge. `--no-open` supports headless
environments. Static assets are embedded in the Go binary, so no Node.js
process or separate UI service is required on the client.

The Console can discover Codex and Pi, accept an Owner-created Device pairing
link during first setup or from the configured Settings page, claim its session,
show the matching verification phrase, start or stop the Bridge, edit the central
service URL and HTTPS trust in a connection-settings modal, add multiple Codex
or Pi Agents, and edit one selected Agent in a modal. Connection editing mutates
only the outbound endpoint fields and never rebuilds the Agent roster. Each
configured Agent card owns its edit action; the browser sends a single-Agent
request instead of rebuilding the sibling roster. An immutable `agentId`
selects the record, and the local identity map binds a renamed display name
back to that ID so a rename does not register a new central Agent. Agent
deletion is outside this task.

[ADR-0029](../adr/0029-preserve-bridge-results-configuration-and-instance-ownership.md)
binds ordinary edits to the saved Runtime kind. Generic CLI metadata edits
preserve the full owner-authored command, arguments, environment allowlist,
output protocol and Runtime policy instead of constructing a preset. Discovery
and Codex/Pi probes do not apply to Generic profiles. Cross-kind edits fail
closed; Runtime conversion needs a separate explicit operation and is not part
of this editor. New supported profiles can still choose Codex or Pi.

[ADR-0031](../adr/0031-preserve-cross-layer-bridge-recovery.md) extends full
metadata-edit preservation to Codex and Pi. Explicit changes patch the saved
profile rather than reconstructing it. New-Agent allocation distinguishes
historical display-name aliases from active identities; two configured Agents
cannot share an ID. Existing ambiguous rosters fail closed for owner repair.

Configuration updates are atomically persisted. A running managed connection
restarts with an epoch fence so a late old process cannot overwrite new state;
a deliberately stopped Bridge remains stopped. Agent and connection mutations
fail while enrollment, Runtime probing, or any local Agent's Team work is
active. The configuration's central service URL is the authoritative outbound
endpoint and may be changed after pairing, including a port change. The Device
credential remains unchanged: the replacement endpoint must belong to the same
central deployment and accept that credential, otherwise the normal
authenticated connection fails visibly without silently enrolling elsewhere.

### Locally authorized central provisioning

`BRG-042` follows
[ADR-0020](../adr/0020-authorize-central-agent-provisioning-locally.md). The
paired Console Settings surface lets the local owner disable provisioning,
save a reusable eight-digit fixed code, or display a locally generated
six-digit code that rotates every five minutes. Code configuration is local and
token-authenticated; only the current rotating code is projected to that local
Console. Saved hash/secret material is omitted from Console state and
diagnostics, and changes are fenced while enrollment, probes, or Team work is
active.

An authenticated central request names an existing Agent on the same Device as
its template. The Bridge resolves that stable identity, validates the local
mode and code, clones the complete local Agent configuration with only the new
name and role, binds the Server-reserved Agent identity, atomically replaces
the configuration, and rebuilds the connection. No request may supply or
override a command, Workspace, environment, Runtime credential, Provider,
sandbox, tool, or permission field. Rejection returns only a closed reason and
never the code or local mismatch detail.

The managed connection advertises central-provisioning support explicitly.
After a failed config replacement, `configuration_failed` preserves the local
reserved identity so the exact request can be retried; a new Agent ID must not
claim that name. After a successful replacement, the Bridge reconnects and
publishes the configured Agent even if its acceptance result was lost. The
Server treats that exact authenticated publication as recovery evidence.

The HTTP listener rejects non-loopback addresses. Every API call requires a
32-byte random Bearer token that is removed from browser history and kept only
in tab session storage. Public state omits Console tokens, Device credentials,
and environment values. The UI accepts `codex` and `pi` presets rather than
arbitrary command strings; Pi may add one validated credential environment
variable name, never its value.

The per-Agent modal may populate the executable and workspace from bounded
local discovery and may run the existing safe Codex/Pi probe against the draft
before save. Preflight is explicit, token-authenticated, does not persist or
restart the Bridge, and is fenced against every active Team Run or concurrent
Runtime probe.

The ADR-0021 implementation presents each configured Workspace as a
Bridge-owned binding with a user-facing alias. Absolute path, canonicalization,
filesystem/network policy, and the final operation remain local. Only the
existing opaque Workspace identity, generation, capability flags, locally
allowed alias, and closed Runtime policy summary may be published. A central
Owner cannot use Device approval or Agent provisioning to broaden that binding.
Older configurations derive their alias locally from the directory name during
in-memory migration; loading alone does not rewrite the file. The Console shows
the absolute root only on loopback, labels both local policy summaries, and
publishes neither those values nor Runtime commands or environment fields.

Both first-enrollment and per-Agent Codex configuration disclose the local
multi-client ownership boundary. Codex Desktop/CLI and Bridge currently run
separate App Server processes. If another local client owns the same Thread,
Bridge preserves the Task Session binding, returns retryable
`CODEX_SESSION_IN_USE`, and does not create a replacement Thread. The Console
instructs the owner to release that client, including fully exiting Desktop
when necessary, before retrying. This Codex-specific warning is visually and
programmatically removed from the active description when Codex is disabled or
the per-Agent Runtime is Pi; the Pi permission policy becomes the only
description associated with that selector.

`BRG-035` keeps the configuration warning concise and adds an embedded,
always-available Codex Task Session guide to the Console. The guide separates
ConveneWire Task, Run, and native Codex session semantics; explains the exact
reuse and recreation boundaries; provides recovery steps for retryable
`CODEX_SESSION_IN_USE` and `CODEX_SESSION_RESUME_FAILED`; and explicitly states
that shared App Server daemon operation is not enabled by the current Bridge.
The same modal is reachable from the Console header and both Codex
configuration warnings without discarding an in-progress Agent form. Opening
the guide moves focus to its close control, native modal semantics keep the
background inert, and closing it restores focus to the exact entry point.

`BRG-037` presents that material through the broader **使用说明** entry. The
dialog first explains what Bridge controls and where owners find Overview,
Agents, and Settings, then retains the Codex Task, Run, native session, recovery,
and separate-App-Server guidance as an explicit **Codex 会话说明** section.
Codex-specific inline warnings still open the same dialog without changing the
current Agent draft, selection-scoped accessibility description, or focus
restoration behavior.

Runtime path discovery follows
[ADR-0019](../adr/0019-bounded-local-runtime-discovery.md): PATH first, then
known app bundles and common installation locations, with no shell startup,
recursive scan, install, or automatic probe. Authenticated explicit
`GET /api/runtime-discovery` refreshes path/source results; ordinary state
polling does not repeat discovery. Missing-result guidance explains terminal
lookup and full executable paths, and never clears an existing form draft.

## Connection Lifecycle

### Explicit GUI pairing recovery

`BRG-030` follows [ADR-0017](../adr/0017-isolate-explicit-bridge-reenrollment.md).
The local GUI keeps Team binding and recovery guidance visible after pairing.
An approval code is a short-lived request, not a reusable Device credential.
An online Bridge whose Agents are missing in Web requires checking the Web
user and Team first; re-enrollment does not restore access to old Team history.

`POST /api/enrollment/restart` requires the local bearer token, explicit
`confirmNewDevice: true`, and the displayed `expectedDeviceId`. It only runs
after the Bridge and its workers stop, with no Runtime probe or active work.
Cancellation fences late results. On approval a fresh owner-only sibling data
directory contains new credentials and Agent identities plus
`previous-bridge.json`; the active config atomically switches to that directory.
Runtime settings and all previous data remain intact. Old central Devices and
Agents are not migrated or revoked, and old inbox/session state is not replayed
under the new identity. Staging failures leave the old binding usable.

### Transport

The initial transport is `/ws/bridge`. After TLS connection, the Bridge sends a
versioned hello containing its Device identity, connection epoch, canonical
semantic Bridge build version, and capabilities before publishing Agents. New
Bridges remove the release tag's leading `v`; the Server accepts that legacy
prefix only during the documented rolling window and persists the normalized
current version separately from the immutable initial pairing version. The
server either accepts the session or returns a structured incompatibility or
revocation error.

`REG-005` adds an optional safe `runtimePolicy` projection to managed Agent
publication. Its only field is `filesystemAccess`: Codex reports `read-only`
or `workspace-write`, while Pi and Generic report `local-policy` because their
actual tool and permission decisions remain local. The projection never
contains a Workspace path, command, argument, environment variable, tool,
Provider, account, or credential. Older Bridges omit it and the Server clears
the displayed value to unreported rather than retaining a stale policy.

Only the newest authenticated epoch may deliver work. Reconnect uses capped
exponential backoff with jitter, republishes capabilities, and resumes from the
last acknowledged server cursor.

For `WSP-001`, each managed Agent also publishes a stable opaque Workspace
identity, an observed generation digest, and an additive Workspace-lease
capability. The absolute configured Workspace remains local. The generation is
attribution for the initial read-source lease; it is not yet the stronger Git or
worktree CAS required for future automated writes.

For `BRG-028`, a managed Agent also advertises Artifact publication support.
The explicit `artifact publish` command selects one configured Agent and active
assigned Run, captures one Workspace-relative Patch, Markdown document, or JSON
test result up to 4 MiB, then drives the Device-authenticated lease, resumable
upload, seal, and canonical bind APIs. Source traversal, symbolic links, special
files, changing bytes or Workspace generation, mismatched type/extension, and
digest drift fail locally. Output and server responses contain only opaque
identities, basename, size, media type, and digest; configured paths, storage
keys, credentials, and file contents are not logged.
For `TASK-011`, repeatable `--derives-from`, `--reviews`, and `--verifies`
flags attach bounded older canonical Artifact targets to the new publication.
The Bridge sorts and de-duplicates the closed relation set and includes it in
the deterministic publication key and prepare request, so retry cannot silently
change Artifact B's lineage.

`BRG-044` implements an explicit managed Result proposal that selects one configured Agent
and its assigned Run, accepts only bounded contract-valid structured fields and
opaque source/evidence identities, and sends them through Device-authenticated
HTTP with a stable operation identity. A proposal must cite an already persisted
event from that exact Run. The Bridge may preflight current Task definition and
criteria revisions for authoring, but the Server remains final authority and may
classify a raced proposal as stale. Exact retry returns the same Result. The
Bridge never derives a Result from final prose, reads a Workspace file for this
command, accepts a local path as evidence, or gains Result review and Task
completion authority.

The headless `result propose` command accepts the proposal as inline JSON rather
than a local file. Its generated-contract validator rejects unknown or
kind-mismatched fields before transport and requires the selected Run's event.
The Device-authenticated HTTP route then rebinds Device, managed Agent, current
assignment, exact Run, Task revisions and every source against central state.
The command retries an uncertain response with byte-equivalent structured input;
the operation ID returns the existing Result instead of allocating a version.

For `BRG-029`, a managed Runtime Agent also advertises isolated Artifact
materialization. Before sending `run.accepted` or invoking a Runtime, the Bridge
downloads every pinned content descriptor through the exact target Device/Run
authorization, resumes an owner-only `.part` file by bounded byte ranges,
verifies all response metadata plus final size and SHA-256, then fsyncs and
atomically installs one read-only non-executable file under
`dataDir/materializations/<run>/<artifact>/`. A closed local receipt contains
only pinned identities and metadata; a configured Workspace is never a staging
root and is never written. A retryable transport failure leaves the inbox in
`preparing` without ACK so redelivery resumes it. A deterministic verification
failure sends the bounded negative acknowledgement and sequence 2 `failed`
without starting a Runtime.

`GET /ws/bridge` authenticates the Device bearer credential before upgrade.
Every connection must start with protocol `1.0` `bridge.hello`; a newer epoch
closes the old socket, while stale epochs and identity-mismatched heartbeats are
closed without updating Presence or the current Bridge-version observation.
Heartbeats preserve the version accepted from that connection's hello.

The Bridge explicitly accepts authenticated inbound WebSocket messages up to
16 MiB. This is a transport trust-boundary limit, not a 32 KiB product message
limit: it covers the protocol-defined Run instruction plus fifty context
messages after UTF-8 and JSON encoding, with expansion room for compatible
fields. Larger artifacts require a separately bounded transfer protocol rather
than an unbounded WebSocket allocation.

## Durable Inbox and ACK

The Bridge writes `deliveryAttemptId`, `idempotencyKey`, payload hash, and local
status before ACK. Content-bearing Runs add the durable local `preparing` cut;
recovery does not reinterpret it as Runtime acceptance and waits for the same
Server delivery to resume materialization. A duplicate returns verified or
reused receipts and cannot start a second Runtime process. If recovery cannot
determine whether a process finished after acceptance, the Bridge reports
`outcome_unknown` rather than guessing.

A failed terminal-event send is delivery failure, not execution uncertainty.
If the terminal state or `input_required` boundary was durably appended, retain
its exact sequence and events; reconnect and duplicate delivery replay it
without another Runtime invocation. Infer `outcome_unknown` only while the
durable record remains unfinished. Keep cancellation fences until replay or
delivery succeeds.

The MVP inbox uses one owner-only, fsynced JSON record per Run under `dataDir`.
Acceptance is serialized, verifies both idempotency key and payload hash, and
survives process restart before the Bridge sends `run.accepted` sequence 1.

Inbox records created before authoritative trace propagation are not compatible
with recovery. A terminal record whose request or persisted events lack the
same valid `traceId` is isolated locally and is never acknowledged or replayed.
An incompatible `accepted` or `working` record instead fails recovery explicitly
and remains in place; the Bridge must not silently abandon a possibly active
central Run. Every recoverable record and every outbound ACK, status, and reply
must carry the same trace ID supplied by the server; absent, invalid, or
mismatched values are rejected rather than inferred or migrated.

## Local Safety

### Single state owner and drained lifecycle

`BRG-052` gives one process exclusive ownership of each resolved Bridge data
directory. The desktop/Console shell keeps that owner from construction until
`Close`; direct CLI/core execution acquires the same lock, while a core called
by the shell borrows only that exact owner. A second process, a symlinked lock,
or a configuration change racing lock acquisition fails before inbox, identity,
session, trust-epoch, or credential state opens. Re-enrollment first owns its
staged data root and transfers ownership only after activation succeeds.

Stop, explicit start, hot configuration replacement, and close cancel the old
worker and wait for its completion channel before a successor can start or the
lock can be released. Repeated updates while a worker drains collapse to one
restart using the newest accepted configuration; a closed service cannot be
restarted. Durable local mutations flush replacement content and sync the
parent directory after create, rename, move, or delete on Unix-like systems,
including the inbox, configuration, credentials, identities, Runtime sessions,
connection epoch, quarantine and macOS login item. Windows retains file flush
plus atomic replacement because Go exposes no portable directory-fsync
primitive there.

### Reasoning-summary consent

Following [ADR-0018](../adr/0018-local-reasoning-summary-consent.md), the local
`shareReasoningSummaries` setting defaults to false, including for existing
configurations. It grants only sharing of Runtime-provided public summaries
with the configured central service; it is not TLS trust or permission to
access commands, files, raw hidden reasoning, or tool inputs/outputs. Replies,
status, and allowlisted tool-name lifecycle continue to work when disabled.

New unconsented reasoning events are discarded before sequence allocation and
outbox persistence. Recovery masks old reasoning content with privacy-only
placeholders while retaining contiguous sequences. Local records are retained;
already uploaded content cannot be recalled. Changing this permission requires
the Bridge and all workers to be stopped, with probes and work idle. Changing
the server URL clears consent unless the local owner explicitly grants it
again; unrelated config edits preserve it.

`BRG-047` makes that stopped-and-drained boundary actionable from the Privacy
card after setup. A running idle Bridge offers an explicit stop action without
changing consent. Its dedicated local endpoint checks pairing, probes, and
active Runs under the lifecycle lock before stopping, so a Run arriving at the
UI boundary cannot be interrupted by this privacy action. While the connection
worker drains, editing remains disabled. Once the local backend reports the
boundary ready, **Change consent** opens and focuses the existing
connection-scoped checkbox, preserving one authenticated consent-mutation owner
and the server-origin reset rule.

### Existing safety boundaries

Device credentials use OS-protected storage when available. The Bridge starts
only Runtime configurations explicitly published by the owner and never
bypasses the Runtime's command, file, network, or approval policy. Logs exclude
tokens, credentials, sensitive local paths, and full environment snapshots.
Codex and Generic Runtime failures preserve only a stable category, process
exit code, and whether bounded stderr existed. Raw stderr remains local because
it may
contain prompts, provider responses, credentials, or absolute paths.

`run.activity` follows the same persist-before-send and sequenced replay rules
as other Run events. Adapters may expose only an official reasoning-summary
stream and allowlisted tool display name/lifecycle. A 64-rune unpublished tail
plus whole-summary redaction prevents a credential split across Runtime
fragments from crossing the connection. Raw hidden reasoning, structured
commands, arguments, tool input/output, and approval requests stay local.

A valid Task clarification is also persisted before send, but it closes the
local execution attempt in `input_required` rather than holding a Runtime
process open. Recovery replays the same safe question. The eventual answer
arrives only inside a new same-Task Run; it never answers a provider-native
interactive request. Codex interactive requests still receive a protocol
error, and the central Server has no filesystem, shell, network, tool, sandbox,
or Runtime approval command.

## Verification and Tasks

Tests cover client enrollment, pairing, reconnect, epoch replacement, ACK loss,
duplicate delivery, restart recovery, revoked devices, Console authentication,
strict Runtime presets, configuration replacement, and lifecycle fencing.
Console coverage verifies first setup, Runtime discovery, multiple same-kind
Agents, per-Agent modal/API ownership, rename-stable identity, active-work
fencing, draft Runtime preflight, connection-only mutation and lifecycle
preservation, status rendering, and acceptance of a Run envelope above the
WebSocket library's hidden 32 KiB default without reconnect. Work is tracked by
`BRG-001` through `BRG-027` plus `BRG-051` and `BRG-052`
in `docs/TASKS.md`.

The `BRG-051`/`BRG-052` local evidence is recorded in
[Bridge runtime hardening acceptance](../acceptance/brg-051-052-bridge-runtime-hardening.md).
Native Windows CI run `33292642155` executed the uncached Job Object
parent/child/grandchild regression, and the later reviewed
[schema-v4 physical record](../acceptance/evidence/qa-002-20260830-schema-v4.md)
closed the distinct two-machine gate. `QA-036` records both results separately;
cross-compilation alone is not reported as native platform evidence.

`BRG-027` adds durable `run.activity` envelopes without making local execution
internals public. The Runtime executor persists each redacted activity before
send and replays it with the same Run sequence rules as status, output, and
reply events. Small reasoning fragments are coalesced before persistence while
tool lifecycle remains immediate and completion flushes the unpublished tail.

`BRG-026` replaces the WebSocket library's default 32 KiB read ceiling with the
explicit 16 MiB Bridge transport boundary. A real client/server regression uses
multibyte Discussion context to prove the Bridge accepts the oversized Run on
one connection instead of reconnecting until its deadline expires.

`BRG-025` adds an optional central Server Token to the owner-only Bridge
configuration and the paired connection-settings form. Public Console state
exposes only whether a Token is configured. Join, claim, legacy pair, and
WebSocket requests pass the Token as a dedicated header; deployments without a
configured Token retain the local-development compatibility path.

`BRG-024` adds a dedicated connection-settings mutation instead of reusing the
legacy full-config form. It validates the central service URL and HTTPS trust,
preserves Device credentials and every Agent field, applies the same active-work
fence as Agent editing, and reconnects only when the Bridge was already running.

`BRG-019` introduced configuration schema version one and Runtime preset
version one. `BRG-025` advances only the configuration schema to version two for the
optional central Server Token; version 1 remains a token-free compatibility
input and migrates in memory.
Recognized legacy Codex and Pi presets migrate in memory before validation,
while owner-controlled names, roles, workspaces, trust, and environment
allowlists remain intact; unknown future versions fail closed. The Console
exposes a user-triggered, bounded Runtime self-test only for managed Codex and
Pi presets. Codex is forced to `read-only`, Pi temporarily uses a no-tool,
no-project-resource command for the probe, active Team Runs fence the probe,
and only allowlisted status and failure metadata return to the UI.

`BRG-022` adds an explicit detected-path action and a token-authenticated draft
preflight for both enrollment and the per-Agent modal. It validates the current
unsaved preset with the bounded safe probe, never persists configuration or
restarts the managed connection, and uses the same lifecycle fence as Agent
mutation: enrollment, active Team work, and concurrent Runtime probes cannot
overlap it.

`ADP-006` advances managed Runtime presets to version 2. Existing Pi presets
are normalized to `--mode json` in memory and routed through the dedicated Pi
event parser. Provider tool-call markup and malformed event streams become a
safe `RUNTIME_PROTOCOL_INVALID` failure instead of a completed Room reply.

`ADP-007` advances managed Runtime presets to version 3. Normal Pi Runs inherit
the owner's local tools, extensions, Skills, project context, approval, and
other local arguments; the Bridge owns only JSON output, non-interactive print,
and no-session lifecycle flags. Agent edits retain those local arguments; tool
arguments/results and provider protocol remain on the client, and explicit
self-tests still replace
the command temporarily with a no-tool, no-project-resource probe.

`ADP-008` advances managed Runtime presets to version 4. Codex presets migrate
from one-shot `exec --json` to the local App Server JSONL stdio protocol while
preserving the owner-selected sandbox in an explicit configuration field. The
Bridge never adds approval bypass flags: normal Runs use the configured
`read-only` or `workspace-write` sandbox and reject interactive escalation.
Bounded assistant deltas, official reasoning-summary activity, allowlisted tool
name/lifecycle, and the final completed Agent message cross the Bridge boundary;
raw hidden reasoning, structured commands, arguments, tool output, and approval
requests remain local. Pi version 3 presets receive only the shared version
marker update and retain their owner-controlled command arguments.

`ADP-011` advances managed Runtime presets to version 5. Codex now stores one
opaque App Server Thread binding per Room, Agent, and workspace under `dataDir`
and resumes it on later Runs; a stale binding falls back once to a fresh persisted
Thread. Pi removes `--no-session` and conflicting session selectors from the
managed preset, then receives a stable Room-Agent-workspace `--session-id` and bounded local
display name at execution. Runtime probes remain explicitly ephemeral. The
Bridge publishes `supportsResume` only for these managed adapters, while the
central service still cannot alter local tools, approval, or sandbox policy.

`ADP-012` replaces Room-scoped continuation with a schema-versioned local
binding keyed by Runtime kind, Room, Task, Agent, workspace fingerprint, and
semantic configuration fingerprint. Codex and Pi persist the native session ID
plus last consumed Room sequence and Room/Task memory and result-evidence
revisions under owner-only permissions; resumed Runs receive only newer Room
deltas and projection revisions. Task, workspace, configuration, or explicit
start-new changes cannot reuse another binding. Legacy requests use a separate
Room key and can never alias a Task-scoped session. The Bridge reports only
`started`, `resumed`, or `recreated` with the consumed cursor; native IDs and
raw workspace paths never cross the connection.

`ADP-017` adds an owner-selected Codex active-writer conflict policy per local
Agent. `preserve_and_retry` remains the migrated and new-Agent default and keeps
the existing binding for later retry. `start_new` applies only to a recognized
active-writer conflict: Bridge requests a fresh persisted Thread with the full
Task bootstrap and replaces its local binding only after Codex accepts the new
Thread. It does not delete the old provider Thread. Unclassified resume errors
still preserve the binding and fail closed. The Console shows the policy beside
the sandbox and in the Agent summary; no central command can change it or use it
to widen filesystem, tool, network, or approval authority.

`TASK-005` derives and publishes one opaque Runtime scope hash from the same
local Runtime kind, workspace/configuration fingerprints, and schema version.
The Server uses that safe identifier only to isolate Task result-evidence
consumption. A resumed binding retains an evidence page only when its
`fromRevision` exactly equals the locally consumed revision; a gap is dropped
without advancing the binding. Accepted status events report the scope and
exact consumed `throughRevision`, which the Server fences against the durable
Run Delivery before moving its cursor.

`TASK-006` extends the owner-only binding with independent Room and Task
long-term Memory revisions. Changed snapshots project structured lifecycle and
Message/Artifact/Run/Discussion provenance into Codex and Pi prompts; unchanged
scopes are filtered locally. The Bridge cannot create or mutate central Memory
entries and receives no additional filesystem authority from their evidence
references.

`ADP-009` adds an optional `outputProtocol` field only for owner-authored
Generic Runtime configurations. Omitting it preserves bounded, final-only
stdout behavior. Selecting `agentroom-jsonl-v1` opts the Runtime into the
documented assistant-delta/final-reply JSONL contract and publishes streaming
capability; unknown protocol names and attempts to attach the protocol to Codex
or Pi fail configuration validation.

`BRG-020` adds a lightweight per-Agent execution gate after durable inbox
acceptance. Different Agent identities on one Bridge keep independent slots and
may execute concurrently; Runs targeting one Agent wait in FIFO order with a
default concurrency of one. Duplicate delivery only replays persisted events.
An explicit cancellation while queued persists and reports `canceled` without
invoking the Runtime. This scheduling boundary prevents one Agent configuration
from concurrently sharing its session and workspace; per-Run Git worktrees
remain a separate opt-in isolation layer. If the Bridge connection disappears
while a Run is queued, the durable accepted record is retained and converges to
`outcome_unknown` during the existing restart recovery path; it is never
silently started after losing its cancellation channel.

## Desktop Client

The browser Console is a compatibility surface, not the final end-user shell.
`BRG-009` through `BRG-011` replace its launcher-first experience with a
lightweight Wails v3 desktop application while preserving the Bridge protocol,
configuration format, credentials, durable inbox, and Runtime adapters.

The desktop application and CLI Console share one lifecycle controller. The
desktop shell serves the existing embedded HTML/CSS/JavaScript through the
native WebView rather than opening the system browser. It owns one Bridge
process, prevents duplicate desktop instances, and starts an already-paired
Bridge automatically. Closing the window hides it to the system tray; it does
not disconnect managed Agents. An explicit tray **Quit** action gracefully
stops enrollment and Bridge work before terminating the process.

Desktop primary/secondary arbitration must happen before Console construction
or data-root ownership. A secondary launch forwards its validated pairing link
or wake request to the original window and never starts another worker. A
bounded in-memory activation pending window readiness preserves events accepted
by the transport. Windows uses bounded readiness waiting and acknowledgement.
The macOS transport in
[ADR-0030](../adr/0030-acknowledge-macos-desktop-activation-before-console-startup.md)
opens an acknowledged Unix-domain receiver before Console/Wails startup,
with stable instance ownership, private OS-selected rendezvous paths and
same-effective-user peer verification before proof is sent. Bounded admission
and I/O reject uncertain or malformed forwarding without starting another
Console. Native secondary AppleEvent capture preserves URL activation; primary
URL events retain the existing handler. Wakes cannot erase a pending pairing
intent, and conflicting pending pairing links are rejected rather than silently
overwritten. The first launch's explicit pairing link enters this same queue
before the receiver is published; the initial WebView loads without a pairing
fragment and receives the reserved link only through the UI dispatcher. A plain
background launch does not create a wake. Old primaries without the new
handshake fail explicitly instead of using Wails' unacknowledged notification
fallback. This does not relax the Console/CLI data-root lock or introduce a
second Bridge lifecycle manager. Native Windows activation evidence remains
distinct from cross-compilation.

Activation delivery waits for the first actual WebView page load, not the
application-started notification. The final page consumes the same supported
custom and HTTP(S) pairing link forms as the Go validator, with bounds that
allow the complete encoded nested fragment. Native prerequisite dialogs remain
suppressible in unattended installation. Packaging resolves output paths once,
and macOS metadata and compiler deployment targets share the supported minimum.
The pinned Go 1.26 desktop build requires macOS 12.0 or later. Bundle metadata
is the packaging target source; CGO and the final external linker receive that
target, and packaging rejects a Mach-O whose platform/minimum differs. A
toolchain upgrade must re-evaluate the supported minimum, not just the plist.
Native test exit codes must fail CI/Release immediately.

The tray exposes status, open, start, stop, and quit actions. Configuration,
Device pairing, legacy Team enrollment, Codex/Pi discovery, and Owner approval
remain available in the main window. The `console`, `pair-device`, `join`,
`run`, and diagnostic CLI commands stay
supported as a headless fallback and do not depend on desktop libraries.

macOS desktop packages are intentionally unsigned and unnotarized. Release
notes state that users verify the published SHA-256 checksum and explicitly
trust the app on first launch. Apple Developer ID signing and notarization are
outside the accepted distribution boundary; the GUI must not claim that Apple
verified the package or recommend disabling Gatekeeper globally.

The Windows amd64 desktop preview ships as both an unsigned portable ZIP and an
unsigned current-user installer built on a native Windows runner. The installer
uses a stable application identity, installs under LocalAppData without
elevation, registers a personal Start menu shortcut, uninstaller, and the
`convenewire://` Device pairing protocol, and offers an optional desktop shortcut.
Upgrade and uninstall own program files and protocol registration only;
configuration and credentials under the user's application-data directory or a
configured external DataDir remain outside installer ownership.

Windows desktop builds embed the existing product mark as a multi-size icon
resource in the executable, under the window and class identifiers expected by
Wails. Both identifiers share the same image payloads. The
installer, shortcuts, protocol registration, window and tray use the same mark.
The generated PNG, ICO and architecture-specific resource object are checked
against their SVG source by the isolated `bridge/tools/windows-resources`
module. Its pinned Go 1.26.7 build disables fused multiply-add only in rasterx
with `-gcflags=github.com/srwiley/rasterx=-d=fmahash=qn`; otherwise arm64 fusion
can round an SVG path differently from amd64 before fixed-point conversion.
The checked-in byte comparison runs on both architectures. This compiler
setting is build-tool-only, must be reverified when changing Go/rasterx, and
does not apply to the shipped Bridge. Packaging verifies the actual executable's
icon resource tree and
rejects missing, corrupt or different icons before distribution. Native Windows
checks additionally extract the installer and installed executable icons and
verify shortcut icon targets. These presentation resources do not alter the
application manifest, privileges, pairing protocol or installer data ownership.

The app uses the installed Microsoft Edge WebView2 Runtime and may trigger an
unknown-publisher SmartScreen warning. The installer checks Microsoft's
documented per-machine and per-user Runtime registrations. If WebView2 is
missing, it explains the prerequisite and may open Microsoft's official
download page only after an explicit user choice; it never downloads or runs a
Runtime installer. Documentation requires checksum verification and must not
recommend disabling SmartScreen or Defender. The preview has no code-signing
claim, automatic updater, or Windows login-startup integration; unsupported
login startup remains visible in local Settings instead of appearing as a
working toggle.

`BRG-046` keeps every managed Windows Runtime process non-interactive at the
operating-system window boundary. The Bridge starts Codex, Pi, Generic Runtime
executables, and command shims with `CREATE_NO_WINDOW` plus a hidden startup
window while retaining its existing stdin/stdout/stderr pipes, bounded output,
deadline cancellation, and wait delay. This prevents the unsigned Desktop GUI
from opening an empty console for each Run; it does not wrap commands in a
shell, change Runtime arguments or environment, or grant new process authority.
Exact-commit native Windows CI and the `v0.4.0-qa031.1` tag-pinned installer
lifecycle pass. A physical installed-Windows Codex Run on that Bridge version
produced output and a reply, completed normally, and opened no empty console,
closing the window-manager acceptance boundary without changing Runtime or
protocol ownership.

Wails is pinned to `v3.0.0-beta.12` behind the `desktop` Go build tag. Ordinary
CGO-free CLI tests and builds do not compile the desktop package. Desktop tests
compile the native shell explicitly on macOS and Windows, while platform
acceptance verifies the native WebView, close-to-tray behavior, and
second-instance window restore.

### Productized desktop information architecture

`BRG-036` replaces the configured Console's engineering-dashboard layout with
an Agent-first desktop shell. The paired application has three destinations:
Overview for the current connection and next action, Agents for local Runtime
availability and policy, and Settings for connection, privacy, startup,
updates, diagnostics, identity detail, and re-enrollment. First configuration
and pending Owner approval remain focused step flows outside that navigation.

The default paired view answers whether the Bridge is connected, which local
Agents can work, and what the owner should do next. Raw Team and Device IDs,
configuration paths, retry counters, and transport errors remain locally
available under explicit technical detail or settings disclosure; they do not
compete with the ordinary status summary. A stable presentation mapper turns
known connection failures into owner guidance while retaining the unmodified
local error only inside the collapsed detail. This presentation layer cannot
rewrite lifecycle state, suppress an unknown failure, or treat reconnecting as
online.

Agent cards show only owner-safe local facts already available to the Console:
name, role, Runtime kind, availability, active-work state, Workspace basename,
and read-only, Workspace-write, or local-policy filesystem authority. Full
paths and commands stay in the authenticated edit flow. Test, edit, start,
stop, pairing, privacy-consent, and recovery mutations retain their existing
active-work fences and authenticated API handlers.

The shell follows system color preference, uses one restrained accent, keeps
the connection summary and configured Agent list visible in the native 980 by
780 initial viewport, and preserves keyboard navigation, modal focus return,
responsive layout, loopback authentication, secret omission, and manual-only
update behavior. `BRG-036` changes embedded presentation assets and pure view
models; it does not add a central wire field, automatic updater, shared Codex
daemon, Room conversation surface, or new local permission.

Local acceptance is recorded in
`docs/acceptance/brg-036-productized-bridge-shell.md`. Isolated configured and
first-run browser fixtures cover the native starting viewport and narrow
layout, while a temporary packaged macOS app covers the real Wails WebView,
local configuration projection, human-readable connection refusal, and Agent
page navigation. This is implementation acceptance, not a new release or
signed/notarized distribution claim.

## Distribution

End users install a prebuilt Bridge and do not need Go or Node.js. Publishing a
GitHub Release triggers `.github/workflows/release-bridge.yml`, which tests and
cross-compiles CGO-free CLI archives for macOS amd64/arm64, Windows amd64, and
Linux amd64/arm64. Native macOS runners additionally build unsigned Wails GUI
ZIPs for Apple Silicon and Intel, and a native Windows runner builds the
unsigned Windows amd64 GUI archive and current-user installer. Native Windows
CI additionally smoke-tests initial installation, in-place upgrade, uninstall,
Start menu, uninstaller and Device pairing protocol registration, and
owner-state preservation. The
Release tag is injected into each binary; all Bridge packages share the outer
Release `SHA256SUMS` with the separately owned Central packages. The combined
release verifier keeps the Bridge and deployment asset sets closed without
moving Central lifecycle ownership into the Bridge.

Each archive contains the binary, client README, and an OS-specific launcher.
The macOS `.command` and Windows `.cmd` launchers are directly clickable; Linux
ships an executable shell launcher. The launchers start `console`, which opens
the token-authenticated loopback UI without requiring terminal configuration.
The GUI archive contains **ConveneWire Bridge.app** and its license material; it
does not contain or require an Apple signature or notarization ticket.

The first release artifacts are unsigned. Desktop packages remain unsigned by
product decision and rely on checksum verification plus explicit user trust.
The Windows installer changes only current-user program files, shortcuts, and
its uninstall registration; it does not fetch dependencies or claim publisher
verification. Login startup remains opt-in on macOS and unsupported on Windows;
update checks remain manual-only. Neither capability downloads or executes
update code.

The canonical release host is `github.com/chenrgSix/ConveneWire`. The manual
checker calls only that repository's GitHub Releases API and accepts only an
exact HTTPS release URL under the same owner/repository/tag path. The former
`chenrgSix/AgentRoom` path may redirect historical browser links, but it is not
accepted as current update metadata after the hosting migration.

`v0.2.0-rc.1` predates `BRG-016` and cannot repair an incompatible inbox by
itself. For a strict central-service deployment, replace the Bridge first and
let it inspect local recovery records before deploying the matching Server;
mixing the old prerelease Bridge with the strict Server is unsupported.

`BRG-012` through `BRG-015` close the desktop operations gap. Process state and
central connection state are separate: a running local goroutine may still be
connecting or retrying. The GUI projects bounded retry information, last
connection time, executable readiness, and active Runtime work without
including prompts or replies.

HTTPS supports `system_ca` and `pinned_sha256`. New public-CA deployments use
normal certificate-chain, hostname, validity, and renewal verification. An old
configuration with a fingerprint and no explicit mode remains pinned. A
configuration may not silently provide both a system-CA mode and a fingerprint.

`BRG-045` adds the separate `private_scoped_ca` target. The implemented
bootstrap consumes the closed pairing-fragment descriptor only after checking
the exact HTTPS origin, then uses a bootstrap-only no-secret client to retrieve
one bounded public CA certificate from the fixed well-known path. It accepts no
redirect, enforces media type and size, checks certificate count, CA constraints,
validity and canonical DER SHA-256, and builds a private pool that still performs
normal hostname, chain, validity and EKU verification. A verified readiness
request completes before any claim proof is generated. The permissive bootstrap
transport cannot be reused for claim, poll, WebSocket or authenticated HTTP
traffic.

After successful consumption, Bridge stores origin, installation ID, trust
epoch, public CA and digest with the Device credential under owner-only
permissions and applies them only to the exact scheme, hostname and port for
WebSocket, artifact and Result traffic. It never installs an OS root or treats
an account, claim secret, Device credential, matching phrase or first-seen peer
as TLS authority. Public links omit the descriptor and remain `system_ca`. The
first private claim advertises the scoped-trust capability and echoes the exact
public descriptor after TLS validation so the Server can match it and bind the
verification phrase; it never uploads the CA certificate or changes
installation state. Console state and diagnostic export include only active
mode, epoch and a 12-character digest prefix; the full digest and certificate
remain out of those projections. Connection settings cannot silently move a
scoped credential to another origin.

`BRG-051` applies the same exact-origin fence to every trust mode. Before any
WebSocket or authenticated HTTP request is constructed, the active Server URL
must match the origin recorded with the Device credential. Public-CA and
legacy-pinned credentials therefore stop locally when a user edits the host or
port; public PKI for the new endpoint does not establish continuity with the
Central that issued the bearer. The authenticated same-CA scoped-private
migration below is the sole in-place exception. All other moves require a new
pairing and never attach either the Device token or optional Server Token to a
probe of the replacement origin.

`BRG-048` adds the explicit exception for a stable-hostname migration. While
the existing configuration-mutation fence is clear and no CA rotation is in
progress, Bridge may update a scoped credential to another exact HTTPS origin
only after a secret-free bounded bootstrap returns the already pinned CA and a
second request passes normal target-hostname readiness through that CA. The
local replacement keeps the Device credential, installation ID, epoch, Agents
and policy unchanged and rolls the credential back if the configuration write
fails. A different CA, legacy fingerprint, trust-mode change, redirect,
unverified target or active work remains rejected.

Rotation accepts at most one strictly newer CA over the existing pin-valid,
Device-authenticated channel. Bridge persists current plus next before sending
one stable idempotent acknowledgement, rebuilds every authenticated client after
credential change, and defers heartbeat rotation while a Run is active. It
removes the old root only after a response verifies through the acknowledged new
root; a lost offer or expired overlap then fails closed. An older pin-valid
Central may omit the endpoint only before any overlap is staged. Redirect,
malformed/multiple/non-CA certificate, digest/origin/install mismatch, epoch
downgrade, lost overlap, or unsupported legacy link also fails closed. The
current `pinned_sha256` leaf mode and OS-installed private roots remain explicit
advanced compatibility and are never an automatic fallback.

macOS login startup is opt-in and user-scoped. Its LaunchAgent contains the
installed executable path, a background flag, and only the non-secret config,
data, and workspace path arguments required to reconstruct the same local
instance; it contains no token, credential, environment value, or Runtime
command. Disabling it does not kill the current Bridge. Diagnostic export is
allowlist-based and excludes absolute home/workspace paths, stable
Team/Device/Agent IDs, credentials, prompts, and replies. Update checks happen
only after an explicit click and may open the exact official GitHub Release
page, but never download, replace, execute, or restart an unsigned binary.

Release `v0.1.0` is the BRG-008 CLI acceptance baseline. GitHub Actions run
`32626555064` passed the Bridge test, all five build jobs, checksum generation,
and asset publication. A clean download verified every entry in `SHA256SUMS`,
both launcher layouts, executable permissions, and the reported `v0.1.0`
version.

Release `v0.2.0-rc.1` closes `BRG-011` and `BRG-015`. GitHub Actions run
`32638769625` passed both native macOS GUI jobs, all five CLI jobs, pre-upload
verification, publication, and post-upload verification. A second clean
download independently passed the committed verifier for all 11 assets. The
candidate remains unsigned, manual-update-only, and subject to the separate
real-login `BRG-013` gate. Full evidence is recorded in
`docs/acceptance/qa-009-v0.2.0-rc.1.md`.

Release `v0.2.0-rc.2` is the first Bridge package containing strict inbox
recovery fencing and safe Codex/Generic failure metadata. GitHub Actions run
`32653022605` built and verified all seven archives from the exact tag, and an
independent public download passed the same 11-asset verifier. Full evidence is
recorded in `docs/acceptance/qa-011-v0.2.0-rc.2.md`.

Release `v0.2.0-rc.3` adds Runtime self-test diagnostics, per-Agent execution
isolation, queued cancellation, and bounded Runtime process-tree termination.
GitHub Actions run `32682673642` built and verified all seven archives from the
exact tag, and an independent public download passed the same 11-asset
verifier. Full evidence is recorded in
`docs/acceptance/qa-014-v0.2.0-rc.3.md`.

Release `v0.2.0-rc.4` adds independent Agent configuration, detected-path
application, and draft Runtime preflight without persistence or managed Bridge
restart. GitHub Actions run `32698124280` built and verified all seven archives
from the exact tag, and an independent public download passed the same 11-asset
verifier. Full evidence is recorded in
`docs/acceptance/qa-015-v0.2.0-rc.4.md`.

Release `v0.2.0-rc.5` adds owner-controlled local Pi permissions and resumable
safe output streaming for Pi, managed Codex, and Generic Runtime adapters.
GitHub Actions run `32723421229` built and verified all seven archives from the
exact tag, and an independent public download passed the same 11-asset
verifier. Full evidence is recorded in
`docs/acceptance/qa-017-v0.2.0-rc.5.md`.

Release `v0.2.0` is the stable trusted-small-Team baseline. It adds Task-scoped
managed Runtime continuity, acknowledged rolling Room context, reviewed Memory,
and verified cross-Bridge Artifact publication, isolated materialization,
Runtime alias injection, lineage, and safe preview. GitHub Actions run
`32880452367` built and verified all seven archives from exact tag commit
`77c11bf617f43b63c47264afe0aac8032fb9ba65`; an independent public download
passed the same 11-asset verifier. The packages remain unsigned and
manual-update-only, while `BRG-013` stays active as post-release real-login
evidence. Full evidence is recorded in `docs/acceptance/qa-021-v0.2.0.md`.

Release `v0.4.0` supersedes that baseline with the ConveneWire product and
repository identity, one-install Central lifecycle control, canonical one-time
Device pairing, public-CA default deployment, exact-origin scoped private
trust, Windows Desktop and current-user installer packages, and the complete
Task/Run/Result/Artifact work surfaces. Release workflow `33231262442` built
and verified the closed 22-asset matrix from the exact tag, and an independent
anonymous public download passed the same committed verifier. The packages
remain unsigned and manual-update-only; the open schema-v4 two-machine tasks
remain post-release evidence rather than hidden stable claims. Full evidence is
recorded in `docs/acceptance/qa-033-v0.4.0.md`.

## Dependencies

Contracts, Registry publication, Security pairing, and Runtime Adapters.

## Client owner collaboration entry

ADR-0035 adds explicit Team/Room entry to the authenticated local Console. Its independent human-access key lives in a separate owner-only file and never enters Runtime inputs, Device credential serialization, diagnostics or status. Entry uses a one-use fragment ticket and does not bypass browser TLS. Existing ownership is confirmed through deliberate re-pairing; canceled or superseded pairing and Central switching cannot carry human grants across identities.
