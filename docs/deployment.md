# Deployment Baseline

## Recommended Topology

Run one Node server and SQLite database on the Coordinator machine. Build the
React project and let the server serve it, then place an HTTPS reverse proxy in
front of the loopback listener:

```bash
npm run build
AGENT_ROOM_WEB_ROOT="$PWD/apps/web/dist" \
AGENT_ROOM_DATABASE_PATH="/srv/agent-room/server.sqlite" \
AGENT_ROOM_HOST="127.0.0.1" \
AGENT_ROOM_PORT="3000" \
npm run start --workspace @agent-room/server
```

The proxy must preserve WebSocket upgrades for `/ws/bridge`, request bodies for
`POST /mcp`, and bearer `Authorization` headers. Remote Bridge and MCP clients
connect only to the proxy's HTTPS origin. Bridge configuration pins the proxy
certificate SHA-256 fingerprint.

For a trusted LAN test without a local proxy, `AGENT_ROOM_HOST=0.0.0.0` exposes
the HTTP listener. Do not use that mode across an untrusted network; non-loopback
Bridge configuration already refuses plain HTTP.

## Current Security Boundary

The MVP Web bootstrap is a local Owner administration flow, not a public
password or SSO login system. Protect Web and browser API routes at the reverse
proxy and restrict them to the Team owner. MCP and Bridge routes retain their
own per-Agent and per-Device bearer authentication. Native multi-user Web login
is a post-MVP requirement.

Keep SQLite, WAL/SHM files, backups, Bridge configuration, credentials, and
durable inbox directories readable only by their service accounts. Follow
`docs/backup-and-restore.md` before upgrades.
