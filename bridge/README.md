# Agent Room Bridge

The Bridge is an optional headless Go companion for managed Agents. It reads an
explicit JSON configuration and never accepts shell command strings.

```bash
go run ./cmd/agentroom-bridge version
go run ./cmd/agentroom-bridge validate-config --config ./bridge.json
go run ./cmd/agentroom-bridge pair --config ./bridge.json --code ONE_TIME_CODE
go run ./cmd/agentroom-bridge run --config ./bridge.json
go test ./...
go build ./cmd/agentroom-bridge
```

`serverUrl` must use HTTPS except for loopback development. Each Agent declares
an adapter, argument-array command, absolute workspace, and environment variable
allowlist. Credentials and delivery state are stored under `dataDir` by later
Bridge lifecycle tasks.

For HTTPS, `serverCertificateSha256` is mandatory and pins the manually verified
server certificate. Pairing stores `device-credential.json` under `dataDir`
with owner-only permissions and refuses to overwrite an existing identity.
Stable Agent IDs are generated once into `agent-identities.json` and reused on
every reconnect; keep Agent configuration names stable when preserving identity.
