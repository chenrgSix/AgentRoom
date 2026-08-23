# Agent Room Bridge

The Bridge is an optional local Go companion for managed Agents. It reads an
explicit JSON configuration and never accepts shell command strings. The
desktop GUI is the primary interactive client; CLI commands remain available
for headless environments and diagnostics.

## Install

End users download the archive matching their operating system and CPU from
[GitHub Releases](https://github.com/chenrgSix/AgentRoom/releases). macOS users
should choose `agentroom-bridge-desktop_*_darwin_arm64.zip` on Apple Silicon or
`agentroom-bridge-desktop_*_darwin_amd64.zip` on an Intel Mac. Extract it, move
**AgentRoom Bridge.app** to `/Applications`, and open it. Go, Node.js, and a
terminal session are not required. Verify the archive before extraction:

```bash
# Linux
sha256sum -c SHA256SUMS --ignore-missing

# macOS
shasum -a 256 -c SHA256SUMS
```

The macOS desktop package is intentionally unsigned and not notarized. After
verifying the checksum, either approve the blocked app under **System Settings
→ Privacy & Security → Open Anyway**, or remove quarantine from this app only:

```bash
xattr -dr com.apple.quarantine "/Applications/AgentRoom Bridge.app"
```

Do not disable Gatekeeper globally. The project does not claim Apple
verification; users explicitly choose whether to trust the downloaded build.

The portable CLI archives remain available. On macOS, double-click **Start
AgentRoom Bridge.command**; on Windows, double-click **Start AgentRoom
Bridge.cmd**; on Linux, run `./start-agentroom-bridge.sh`. Each launcher starts
the Bridge and opens the local configuration Console in the default browser.

The portable binaries are currently unsigned. macOS users may need to approve
the first launch in system security settings. The `go run` commands below are
developer alternatives.

AgentRoom is source-available under the PolyForm Noncommercial License 1.0.0.
Release archives include `LICENSE`, `NOTICE`, and `COMMERCIAL-LICENSE.md`.
Commercial use, including SaaS or another paid hosted service, requires prior
written permission.

```bash
go run ./cmd/agentroom-bridge version
go run ./cmd/agentroom-bridge console
go run ./cmd/agentroom-bridge join --server http://127.0.0.1:3000
go run ./cmd/agentroom-bridge validate-config --config ./bridge.json
go run ./cmd/agentroom-bridge pair --config ./bridge.json --code ONE_TIME_CODE
go run ./cmd/agentroom-bridge run --config ./bridge.json
go test ./...
go build ./cmd/agentroom-bridge
go test -tags desktop ./cmd/agentroom-bridge-desktop
go build -tags desktop ./cmd/agentroom-bridge-desktop
```

## Desktop GUI

The Wails desktop entry point uses the operating system WebView and the same
embedded configuration UI as `console`; it does not bundle Chromium or require
a browser tab. An existing paired Bridge starts automatically. Closing the
window hides it to the tray and keeps managed Agents online. The tray shows the
current phase and provides open, start, stop, and explicit quit actions.

Only one desktop instance may run. Launching the app again raises the existing
window. The desktop binary is built separately from the CGO-free CLI so
headless builds do not acquire GUI runtime requirements. Wails is pinned to
`v3.0.0-beta.12`; desktop tests compile with the explicit `desktop` build tag.

Current macOS desktop builds are unsigned and unnotarized by design. Apple
Silicon and Intel packages are built on native GitHub-hosted macOS runners and
published with the same `SHA256SUMS` file as the portable CLI archives.

`console` is the headless compatibility setup path. It opens the complete token-bearing
URL in the default browser and also prints it as a fallback. Pass `--no-open`
for a headless environment. The local page detects Codex and Pi, requests Team
enrollment, shows the Owner approval code, and manages Bridge start, stop, and
Agent configuration. It listens only on `127.0.0.1:3210` by default; static UI
assets are embedded in the Bridge binary.

```bash
agentroom-bridge console \
  --workspace /absolute/path/to/project \
  --config /absolute/path/to/bridge.json
```

An existing paired configuration starts automatically. Editing Agent presets
atomically updates the configuration and restarts the managed connection. The
Console never returns Device credentials or environment values to the browser.

`join` is the terminal-only managed setup alternative. It detects `codex` and
the current workspace, displays a short approval code, and waits for a Team
owner to enter that code in Web **Connect an Agent**. After approval it writes
the configuration and credential, publishes **Local Codex**, and stays online.
Use `--workspace`, `--agent-name`, `--device-name`, or `--codex` to override
detected values. Existing configuration or credential files are never
overwritten.

`serverUrl` must use HTTPS except for loopback development. Each Agent declares
an adapter, argument-array command, absolute workspace, and environment variable
allowlist. Credentials, stable Agent identities, the durable Run inbox, and
replayable Runtime events are stored under `dataDir` with owner-only file modes.

For HTTPS, `--server-certificate-sha256` is mandatory and pins the manually
verified server certificate. Enrollment stores `bridge.json` and
`device-credential.json` with owner-only permissions. The `pair` command remains
available for legacy server-issued invitations.
Stable Agent IDs are generated once into `agent-identities.json` and reused on
every reconnect; keep Agent configuration names stable when preserving identity.

Pi joins through the Generic CLI adapter in the same Bridge configuration. Use
the absolute path returned by `command -v pi`; the minimal managed command is:

```json
{
  "name": "Local Pi",
  "role": "Reviewer",
  "adapter": "generic",
  "command": [
    "/absolute/path/to/pi",
    "--print",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-context-files",
    "--no-session"
  ],
  "workspace": "/absolute/path/to/project",
  "envAllowlist": ["HOME", "PATH", "PI_CODING_AGENT_DIR"]
}
```

This mode receives each bounded turn on stdin and exits after replying. It is
remotely wakeable through the Bridge but does not claim persistent Pi session
resume. Add only the credential environment variable actually required by the
selected Pi provider; do not copy the full parent environment.
