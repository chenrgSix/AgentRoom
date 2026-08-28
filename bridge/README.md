# ConveneWire Bridge

The Bridge is an optional local Go companion for managed Agents. It reads an
explicit JSON configuration and never accepts shell command strings. The
desktop GUI is the primary interactive client; CLI commands remain available
for headless environments and diagnostics.

## Install

End users download the archive matching their operating system and CPU from
[GitHub Releases](https://github.com/chenrgSix/AgentRoom/releases). macOS users
should choose `convenewire-bridge-desktop_*_darwin_arm64.zip` on Apple Silicon or
`convenewire-bridge-desktop_*_darwin_amd64.zip` on an Intel Mac. Extract it, move
**ConveneWire Bridge.app** to `/Applications`, and open it. Go, Node.js, and a
terminal session are not required. Windows users can run the current-user
`convenewire-bridge-desktop_*_windows_amd64_setup.exe` installer, or choose the
matching ZIP for a portable copy. Verify the selected package before opening
it:

```bash
# Linux
sha256sum -c SHA256SUMS --ignore-missing

# macOS (set this to the archive you downloaded)
ARCHIVE=convenewire-bridge-desktop_0.2.0-rc.4_darwin_arm64.zip
grep "  ${ARCHIVE}$" SHA256SUMS | shasum -a 256 -c -
```

The macOS desktop package is intentionally unsigned and not notarized. After
verifying the checksum, either approve the blocked app under **System Settings
→ Privacy & Security → Open Anyway**, or remove quarantine from this app only:

```bash
xattr -dr com.apple.quarantine "/Applications/ConveneWire Bridge.app"
```

Do not disable Gatekeeper globally. The project does not claim Apple
verification; users explicitly choose whether to trust the downloaded build.

The Windows desktop package is also unsigned. Microsoft Defender SmartScreen
may show an unknown-publisher warning; continue only after checking the
published SHA-256 value, and never disable SmartScreen or Defender globally.
The app uses the system Microsoft Edge WebView2 Runtime. The installer checks
for the Runtime and, when it is absent, can open Microsoft's official download
page; it does not download or execute the Runtime. The installer runs without
administrator access, creates current-user Start menu and uninstall entries,
and does not own or remove the upgrade-stable `%AppData%\agentroom`
configuration and credentials.
Windows login startup is not part of this preview, so the Settings page retains
an explicit manual-start notice. Updates remain manual on both platforms.

The portable CLI archives remain available. On macOS, double-click **Start
ConveneWire Bridge.command**; on Windows, double-click **Start ConveneWire
Bridge.cmd**; on Linux, run `./start-convenewire-bridge.sh`. Each launcher starts
the Bridge and opens the local configuration Console in the default browser.

The portable binaries are currently unsigned. macOS users may need to approve
the first launch in system security settings. The `go run` commands below are
developer alternatives.

ConveneWire is source-available under the ConveneWire Community License 1.0.
Release archives include `LICENSE`, `NOTICE`, `COMMERCIAL-LICENSE.md`, and
`TRADEMARKS.md`.
Commercial use, including SaaS or another paid hosted service, requires prior
written permission.

```bash
go run ./cmd/convenewire-bridge version
go run ./cmd/convenewire-bridge console
go run ./cmd/convenewire-bridge join --server http://127.0.0.1:3000 --server-token CENTRAL_SERVER_TOKEN
go run ./cmd/convenewire-bridge validate-config --config ./bridge.json
go run ./cmd/convenewire-bridge pair-device --config ./bridge.json --link 'convenewire://pair-device?...#claimSecret=...'
go run ./cmd/convenewire-bridge pair-device --config ./bridge.json --code BCDF-GHJK-MN
go run ./cmd/convenewire-bridge pair --config ./bridge.json --code ONE_TIME_CODE
go run ./cmd/convenewire-bridge result propose --help
go run ./cmd/convenewire-bridge run --config ./bridge.json
go test ./...
go build ./cmd/convenewire-bridge
go test -tags desktop ./cmd/convenewire-bridge-desktop
go build -tags desktop ./cmd/convenewire-bridge-desktop
```

`result propose` submits one explicit managed-Agent Result through the paired
Device credential. Select a configured Agent with `--agent`, its exact assigned
Run with `--run-id`, and pass the contract object directly with
`--proposal-json`. The JSON must pin Task, definition, criteria and Task
revisions and cite at least one persisted event from that Run. It may contain
only opaque Artifact, Run-event, Message, Memory or Discussion references; the
command deliberately has no proposal-file, Workspace-path, review or Task
completion option. A response-loss retry sends the same operation identity and
returns the existing immutable Result.

## Desktop GUI

The Wails desktop entry point uses the operating system WebView and the same
embedded configuration UI as `console`; it does not bundle Chromium or require
a browser tab. An existing paired Bridge starts automatically. Closing the
window hides it to the tray and keeps managed Agents online. The tray shows the
current phase and provides open, start, stop, and explicit quit actions.

Only one desktop instance may run. Launching the app again raises the existing
window. Installed macOS and Windows clients register `convenewire://` for the
Device pairing link encoded by the Owner Web QR and keep `agentroom://` as an
upgrade-compatible alias; the same local setup surface also accepts link paste
or a manual short code. The fragment claim proof is
cleared from the WebView URL immediately after prefill. The desktop binary is
built separately from the CGO-free CLI so
headless builds do not acquire GUI runtime requirements. Wails is pinned to
`v3.0.0-beta.12`; desktop tests compile with the explicit `desktop` build tag.

Current macOS desktop builds are unsigned and unnotarized by design. Apple
Silicon and Intel packages are built on native GitHub-hosted macOS runners and
published with the same `SHA256SUMS` file as the portable CLI archives. The
Windows amd64 preview is built and tested on a native GitHub-hosted Windows
runner, uses the system WebView2 Runtime, and ships as both an unsigned portable
ZIP and an unsigned current-user installer. Native CI performs an initial
install, in-place upgrade, and uninstall while proving owner configuration is
preserved. Windows login-startup integration remains unsupported.

`console` is the headless compatibility setup path. It opens the complete token-bearing
URL in the default browser and also prints it as a fallback. Pass `--no-open`
for a headless environment. The local page detects Codex and Pi, requests Team
enrollment, shows the Owner approval code, and manages Bridge start, stop, and
Agent configuration. It listens only on `127.0.0.1:3210` by default; static UI
assets are embedded in the Bridge binary.

```bash
convenewire-bridge console \
  --workspace /absolute/path/to/project \
  --config /absolute/path/to/bridge.json
```

An existing paired configuration starts automatically. Editing Agent presets
atomically updates the configuration and restarts the managed connection. The
Console never returns Device credentials or environment values to the browser.
The Settings page can also keep central Agent creation disabled, store a
reusable eight-digit fixed management code as a salted local hash, or display a
six-digit local code that rotates every five minutes. Fixed codes remain valid
for multiple creations until the local owner replaces or disables them; dynamic
codes are recommended when the Bridge is reachable through a public service.
The central service receives a code only in the individual provisioning
request and never receives the saved hash, rotating secret, Runtime command,
Workspace, environment, credential, tool, or permission configuration.
The configured-device view also exposes **连接设置** for changing the central
service URL, port, and HTTPS trust mode without rebuilding the Agent roster or
rewriting the Device credential. A running Bridge reconnects after save; a
manually stopped Bridge remains stopped. The replacement endpoint must be the
same central deployment and accept the existing credential.
Detected Codex and Pi executables are copied into a form only after an explicit
**使用检测值** action. **保存前预检** runs the same bounded safe probe against
the unsaved form without writing configuration or restarting the Bridge. An
active Team task or another Runtime probe blocks both preflight and save.

The status area distinguishes the local process from the central connection:
`stopped`, `connecting`, `online`, and `retrying` are not interchangeable. It
also reports bounded retry timing, executable readiness, and active Runtime
work. Each configured Codex or Pi row has an explicit **测试运行** action. It
runs one bounded local probe only when clicked, forces Codex to `read-only`,
keeps Pi in no-tool mode, and is disabled while that Runtime has an active Team
task. macOS users may opt into **登录时启动**; the user-scoped LaunchAgent stores
only the app path, `--background`, and non-secret config/data/workspace paths.
It never stores a Device credential, Console token, environment value, or
Runtime command.

**导出脱敏诊断包** writes an owner-only ZIP to Downloads. Its allowlist contains
only version, OS/architecture, bounded operational state, timestamps, Runtime
kind/readiness, and recent state transitions. It excludes credentials, Team /
Device / Agent IDs, prompts, replies, environment values, and absolute local
paths. **检查更新** is manual-only: it reads the official GitHub latest Release
metadata and may open that exact Release page, but never downloads, replaces,
executes, or restarts the unsigned Bridge.

`join` is the terminal-only managed setup alternative. It detects `codex` and
the current workspace, displays a short approval code, and waits for a Team
owner to enter that code in Web **Connect an Agent**. After approval it writes
the configuration and credential, publishes **Local Codex**, and stays online.
Use `--workspace`, `--agent-name`, `--device-name`, or `--codex` to override
detected values. Existing configuration or credential files are never
overwritten.

Managed Codex preset version 5 starts the customer's local
`codex app-server --listen stdio://` with the configured workspace and
`read-only` or `workspace-write` sandbox. Agent publication exposes only the
corresponding `filesystemAccess` enum; Pi and Generic publish `local-policy`.
It never publishes the Workspace path, command, environment variables, tools,
Provider, account, or credential as Runtime policy. The Bridge publishes bounded
`item/agentMessage/delta` previews and keeps the completed Agent message as the
authoritative Room reply. It never adds approval bypass flags. Official
reasoning-summary activity and allowlisted tool name/lifecycle may cross, while raw hidden
reasoning, structured commands, arguments, tool output, and interactive approval
requests remain local. One persisted App Server Thread is retained per Room,
Agent, and workspace; later Runs resume it, while a rejected stale binding is
replaced once with a fresh Thread. Opaque Thread bindings live under `dataDir`
with owner-only permissions.

`serverUrl` must use HTTPS except for loopback development. Each Agent declares
an adapter, argument-array command, absolute workspace, and environment variable
allowlist. Credentials, stable Agent identities, the durable Run inbox, and
replayable Runtime events are stored under `dataDir` with owner-only file modes.

Deployments may optionally require a 32–512 byte central `serverToken`. Enter it
next to the central address during Console setup, pass it to terminal enrollment
with `join --server-token`, or replace/clear it later under **连接设置**. Bridge
sends it as `X-AgentRoom-Server-Token` on join, claim, legacy pair, and WebSocket
requests. The Console returns only an “已配置/未配置” flag; it never returns the
stored value. This Token is a deployment access parameter and remains separate
from the per-Device bearer credential.

For normal public HTTPS, the default `system_ca` mode validates the certificate
chain, hostname, validity, and renewal through the operating-system trust store;
no fingerprint is required. Private deployments may explicitly choose
`--server-trust-mode pinned_sha256` together with a manually verified
`--server-certificate-sha256`. Existing fingerprint-only configurations remain
pinned for compatibility, while `system_ca` rejects a supplied fingerprint.

The accepted deployment target defaults external installs to public CA and
adds pairing-scoped private CA trust for one exact Central origin without an OS
root import. That target is tracked by `CON-014`, `OPS-009`, `SEC-009`,
`BRG-045`, and `WEB-048`; it is not implemented by the current CLI or Desktop
build. Until those tasks complete, `pinned_sha256` and manually installed
private roots are advanced compatibility/diagnostic choices, not the normal
no-manual-CA onboarding flow and not grounds to bypass TLS verification.
Enrollment stores `bridge.json` and `device-credential.json` with owner-only
permissions. The `pair` command remains available for legacy server-issued
invitations.
Stable Agent IDs are generated once into `agent-identities.json` and reused on
every reconnect; keep Agent configuration names stable when preserving identity.

Each managed Codex Agent also stores a local `codexSessionConflictPolicy`.
`preserve_and_retry` is the safe default: a recognized active-writer conflict
keeps the current Task Session binding and returns a retryable error. The
explicit `start_new` option preserves the old provider Thread itself but starts
and binds a new Thread after the conflict, replays the current Task bootstrap,
and trades native conversation continuity for immediate progress. Unknown
resume rejection never follows this option and still fails closed. The Bridge
Console exposes this choice beside the Codex sandbox and summarizes it on the
Agent card; the central service cannot change it.

Pi joins through the Generic CLI adapter in the same Bridge configuration. Use
the absolute path returned by `command -v pi`; the minimal managed command is:

```json
{
  "name": "Local Pi",
  "role": "Reviewer",
  "adapter": "generic",
  "runtimeKind": "pi",
  "presetVersion": 5,
  "command": [
    "/absolute/path/to/pi",
    "--mode",
    "json",
    "--print"
  ],
  "workspace": "/absolute/path/to/project",
  "envAllowlist": ["HOME", "PATH", "PI_CODING_AGENT_DIR"]
}
```

The top-level configuration uses `"schemaVersion": 4`; older files load with
central Agent provisioning disabled and retain their existing Runtime and
identity behavior. The local Console persists management-code material under
`agentProvisioning`; owner-only file permissions and the token-authenticated
Console remain the authority boundary. Version 3 and older files load with
`preserve_and_retry` for each Codex Agent and migrate in memory. Version 1 files
remain compatible without a central Token. Pi tools, extensions,
Skills, project context, approval, and provider settings follow the owner's
local Pi configuration. Owner-authored command arguments such as `--approve`,
`--tools`, or extension flags remain local and survive Agent edits. The central
service supplies only the bounded task instruction and cannot add permissions.
Legacy Console-created presets are migrated in memory when loaded; preset v2's
product-authored restrictions are removed, while other local Pi arguments and
the owner's names, roles, workspace, trust settings, and environment allowlist
remain intact. The next explicit save persists the new version.

This mode receives each bounded turn on stdin and exits after replying. The Pi
adapter reads its JSON event stream, publishes bounded assistant text previews
plus the final authoritative assistant reply. Explicit thinking/reasoning
summary deltas and tool name/lifecycle appear as safe activity; usage,
structured tool records, arguments/results, and provider protocol remain local. It fails safely
if a provider leaks raw tool-call markup. Explicit
Runtime self-tests temporarily disable Pi tools and project-local resources;
normal Team tasks retain the owner's policy and append to one native Pi session
per Room, Agent, and workspace through a stable `--session-id`. The probe alone adds
`--no-session`, so it remains ephemeral. Pi is remotely wakeable through the
Bridge and publishes persistent resume capability.
Add only the credential environment variable actually required by the selected
Pi provider; do not copy the full parent environment.

Owner-authored Generic Runtimes remain final-only unless they explicitly set
`"outputProtocol": "agentroom-jsonl-v1"`. In that mode stdout must contain one
JSON object per line using `assistant.delta` and one authoritative
`reply.final`; optional reasoning and tool lifecycle events use the documented
allowlist, and ordinary logs and terminal rendering do not belong on stdout.
The complete producer contract and example configuration are in
[`docs/generic-runtime-stream-contract.md`](../docs/generic-runtime-stream-contract.md).
