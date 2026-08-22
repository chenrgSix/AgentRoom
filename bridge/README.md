# Agent Room Bridge

The Bridge is an optional headless Go companion for managed Agents. It reads an
explicit JSON configuration and never accepts shell command strings.

```bash
go run ./cmd/agentroom-bridge version
go run ./cmd/agentroom-bridge validate-config --config ./bridge.json
go test ./...
go build ./cmd/agentroom-bridge
```

`serverUrl` must use HTTPS except for loopback development. Each Agent declares
an adapter, argument-array command, absolute workspace, and environment variable
allowlist. Credentials and delivery state are stored under `dataDir` by later
Bridge lifecycle tasks.
