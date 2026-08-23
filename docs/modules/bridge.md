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
show the short Owner approval code, start or stop the Bridge, and edit existing
Agent presets. Configuration updates are atomically persisted and restart the
managed connection with an epoch fence so a late old process cannot overwrite
new state. A paired server URL cannot be changed through configuration editing;
joining another server requires a new Device enrollment.

The HTTP listener rejects non-loopback addresses. Every API call requires a
32-byte random Bearer token that is removed from browser history and kept only
in tab session storage. Public state omits Console tokens, Device credentials,
and environment values. The UI accepts `codex` and `pi` presets rather than
arbitrary command strings; Pi may add one validated credential environment
variable name, never its value.

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

## Local Safety

Device credentials use OS-protected storage when available. The Bridge starts
only Runtime configurations explicitly published by the owner and never
bypasses the Runtime's command, file, network, or approval policy. Logs exclude
tokens, credentials, sensitive local paths, and full environment snapshots.

## Verification and Tasks

Tests cover client enrollment, pairing, reconnect, epoch replacement, ACK loss,
duplicate delivery, restart recovery, revoked devices, Console authentication,
strict Runtime presets, configuration replacement, and lifecycle fencing.
Browser acceptance covers first setup, Runtime discovery, adding Pi to an
existing Bridge, and status rendering. Work is tracked by `BRG-001` through
`BRG-015` in `docs/TASKS.md`.

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

## Dependencies

Contracts, Registry publication, Security pairing, and Runtime Adapters.
