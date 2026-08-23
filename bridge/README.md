# Agent Room Bridge

The Bridge is an optional headless Go companion for managed Agents. It reads an
explicit JSON configuration and never accepts shell command strings.

```bash
go run ./cmd/agentroom-bridge version
go run ./cmd/agentroom-bridge join --server http://127.0.0.1:3000
go run ./cmd/agentroom-bridge validate-config --config ./bridge.json
go run ./cmd/agentroom-bridge pair --config ./bridge.json --code ONE_TIME_CODE
go run ./cmd/agentroom-bridge run --config ./bridge.json
go test ./...
go build ./cmd/agentroom-bridge
```

`join` is the normal managed setup path. It detects `codex` and the current
workspace, displays a short approval code, and waits for a Team owner to enter
that code in Web **Connect an Agent**. After approval it writes the configuration
and credential, publishes **Local Codex**, and stays online. Use `--workspace`,
`--agent-name`, `--device-name`, or `--codex` to override detected values.
Existing configuration or credential files are never overwritten.

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
