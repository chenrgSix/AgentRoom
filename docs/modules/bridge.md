# Local Bridge

## Scope

- Prefix: `BRG`
- Planned location: `bridge/` and the server Bridge endpoint
- Owns: outbound connection, local delivery inbox, connection epoch

The Go Bridge is an optional local companion for managed Agents. It maintains
one outbound connection to the central server and adapts accepted Run commands
to local Runtime Adapters.

## Responsibilities

- Request Team enrollment, store the approved credential, and establish the
  outbound channel.
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

## Managed Enrollment

The primary setup begins on the client with
`agentroom-bridge join --server <url>`. The Bridge detects the local Codex
executable and workspace, submits Device and Agent metadata, and displays a
ten-minute short code. A Team owner enters that code in Web. The Bridge polls
with a separate high-entropy token, claims the approved identity, atomically
writes owner-only configuration and credentials, and immediately connects and
publishes the Agent.

The client never needs a credential copied from the server. Existing config or
credential files stop enrollment before a request is created. Server-issued
single-use invitations remain supported by `pair` for compatibility, but are
not the normal onboarding flow.

## Local Configuration Console

`agentroom-bridge console` starts the recommended client setup surface on
`127.0.0.1:3210`, opens and prints a one-time random Console URL, and
automatically runs an existing paired Bridge. `--no-open` supports headless
environments. Static assets are embedded in the Go binary, so no Node.js
process or separate UI service is required on the client.

The Console can discover Codex and Pi, create the first enrollment request,
show the short Owner approval code, start or stop the Bridge, edit the central
service URL and HTTPS trust in a connection-settings modal, add multiple Codex
or Pi Agents, and edit one selected Agent in a modal. Connection editing mutates
only the outbound endpoint fields and never rebuilds the Agent roster. Each
configured Agent card owns its edit action; the browser sends a single-Agent
request instead of rebuilding the sibling roster. An immutable `agentId`
selects the record, and the local identity map binds a renamed display name
back to that ID so a rename does not register a new central Agent. Agent
deletion is outside this task.

Configuration updates are atomically persisted. A running managed connection
restarts with an epoch fence so a late old process cannot overwrite new state;
a deliberately stopped Bridge remains stopped. Agent and connection mutations
fail while enrollment, Runtime probing, or any local Agent's Team work is
active. The configuration's central service URL is the authoritative outbound
endpoint and may be changed after pairing, including a port change. The Device
credential remains unchanged: the replacement endpoint must belong to the same
central deployment and accept that credential, otherwise the normal
authenticated connection fails visibly without silently enrolling elsewhere.

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
AgentRoom Task, Run, and native Codex session semantics; explains the exact
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
versioned hello containing its device identity, connection epoch, Agents, and
capabilities. The server either accepts the session or returns a structured
incompatibility or revocation error.

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
closed without updating Presence.

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
`BRG-001` through `BRG-027`
in `docs/TASKS.md`.

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

The tray exposes status, open, start, stop, and quit actions. Configuration,
Team enrollment, Codex/Pi discovery, and Owner approval remain available in
the main window. The `console`, `join`, `run`, and diagnostic CLI commands stay
supported as a headless fallback and do not depend on desktop libraries.

macOS desktop packages are intentionally unsigned and unnotarized. Release
notes state that users verify the published SHA-256 checksum and explicitly
trust the app on first launch. Apple Developer ID signing and notarization are
outside the accepted distribution boundary; the GUI must not claim that Apple
verified the package or recommend disabling Gatekeeper globally.

Wails is pinned to `v3.0.0-beta.12` behind the `desktop` Go build tag. Ordinary
CGO-free CLI tests and builds do not compile the desktop package. Desktop tests
compile the native shell explicitly, while visual acceptance verifies the
native WebView, close-to-tray behavior, and second-instance window restore.

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
ZIPs for Apple Silicon and Intel. The Release tag is injected into each binary;
all archives and one `SHA256SUMS` file are attached to the Release.

Each archive contains the binary, client README, and an OS-specific launcher.
The macOS `.command` and Windows `.cmd` launchers are directly clickable; Linux
ships an executable shell launcher. The launchers start `console`, which opens
the token-authenticated loopback UI without requiring terminal configuration.
The GUI archive contains **AgentRoom Bridge.app** and its license material; it
does not contain or require an Apple signature or notarization ticket.

The first release artifacts are unsigned portable binaries. Desktop packages
remain unsigned by product decision and rely on checksum verification plus
explicit user trust. Login startup remains opt-in, and update checks remain
manual-only; neither capability installs or executes downloaded code.

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

## Dependencies

Contracts, Registry publication, Security pairing, and Runtime Adapters.
