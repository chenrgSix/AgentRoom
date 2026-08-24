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
- Maintain heartbeat, connection epoch, and reconnect backoff.
- Persist incoming deliveries before acknowledging them.
- Deduplicate deliveries and forward each accepted Run exactly once locally.
- Stream sequenced status, text replies, and handoff requests to the server.
- Serve an optional token-authenticated loopback Console for local enrollment,
  Runtime preset configuration, status, and process control.

The Bridge does not store Team history, choose target Agents, authorize
cross-member actions, or provide Room conversation UI. Its local Console owns
only this machine's Bridge configuration and lifecycle.

The Go 1.26.7 process accepts a strict JSON configuration. Runtime commands are
argument arrays, workspaces are absolute paths, environment propagation is an
allowlist, and non-loopback server URLs must use HTTPS.

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

## Connection Lifecycle

The initial transport is `/ws/bridge`. After TLS connection, the Bridge sends a
versioned hello containing its device identity, connection epoch, Agents, and
capabilities. The server either accepts the session or returns a structured
incompatibility or revocation error.

Only the newest authenticated epoch may deliver work. Reconnect uses capped
exponential backoff with jitter, republishes capabilities, and resumes from the
last acknowledged server cursor.

`GET /ws/bridge` authenticates the Device bearer credential before upgrade.
Every connection must start with protocol `1.0` `bridge.hello`; a newer epoch
closes the old socket, while stale epochs and identity-mismatched heartbeats are
closed without updating Presence.

## Durable Inbox and ACK

The Bridge writes `deliveryAttemptId`, `idempotencyKey`, payload hash, and local
status before ACK. A duplicate returns the existing acceptance and cannot start
a second Runtime process. If recovery cannot determine whether a process
finished, the Bridge reports `outcome_unknown` rather than guessing.

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

Device credentials use OS-protected storage when available. The Bridge starts
only Runtime configurations explicitly published by the owner and never
bypasses the Runtime's command, file, network, or approval policy. Logs exclude
tokens, credentials, sensitive local paths, and full environment snapshots.
Codex and Generic Runtime failures preserve only a stable category, process
exit code, and whether bounded stderr existed. Raw stderr remains local because
it may
contain prompts, provider responses, credentials, or absolute paths.

## Verification and Tasks

Tests cover client enrollment, pairing, reconnect, epoch replacement, ACK loss,
duplicate delivery, restart recovery, revoked devices, Console authentication,
strict Runtime presets, configuration replacement, and lifecycle fencing.
Console coverage verifies first setup, Runtime discovery, multiple same-kind
Agents, per-Agent modal/API ownership, rename-stable identity, active-work
fencing, draft Runtime preflight, connection-only mutation and lifecycle
preservation, and status rendering. Work is tracked by
`BRG-001` through `BRG-024`
in `docs/TASKS.md`.

`BRG-024` adds a dedicated connection-settings mutation instead of reusing the
legacy full-config form. It validates the central service URL and HTTPS trust,
preserves Device credentials and every Agent field, applies the same active-work
fence as Agent editing, and reconnects only when the Bridge was already running.

`BRG-019` adds configuration schema version 1 and Runtime preset version 1.
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
and no-session lifecycle flags. Agent edits retain those local arguments, tool
lifecycle events remain on the client, and explicit self-tests still replace
the command temporarily with a no-tool, no-project-resource probe.

`ADP-008` advances managed Runtime presets to version 4. Codex presets migrate
from one-shot `exec --json` to the local App Server JSONL stdio protocol while
preserving the owner-selected sandbox in an explicit configuration field. The
Bridge never adds approval bypass flags: normal Runs use the configured
`read-only` or `workspace-write` sandbox and reject interactive escalation.
Only bounded assistant deltas and the final completed Agent message cross the
Bridge boundary; reasoning, tool lifecycle, command output, and approval
requests remain local. Pi version 3 presets receive only the shared version
marker update and retain their owner-controlled command arguments.

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

## Dependencies

Contracts, Registry publication, Security pairing, and Runtime Adapters.
