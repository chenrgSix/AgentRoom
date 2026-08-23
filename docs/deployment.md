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

## Trusted-Team Container Profile

The v0.2 trusted-team profile runs one non-root Server container behind one
Caddy HTTPS entry point. Only Caddy publishes host ports; Server port 3000 and
the SQLite volume remain internal. `/api/metrics` is not exposed by the public
route. Caddy preserves WebSocket upgrades, MCP authorization headers, and
request bodies.

Trusted-team mode requires `AGENT_ROOM_PUBLIC_ORIGIN` and an Owner recovery
token mounted as a read-only secret file. The application refuses to start
without them. Public-CA domains pair with Bridge `system_ca` mode so normal
certificate renewal does not require editing every client. An internal CA may
use `system_ca` only after its root is installed on every client; an explicit
leaf pin remains a short-lived compatibility choice.

The Compose profile uses restart and graceful-stop policies but does not hide
backup semantics. Backups call the existing SQLite online backup API, create a
new UTC-named file, run `quick_check`, and print a SHA-256 digest. They never
copy a live WAL by hand, overwrite an existing backup, delete retention data,
or restore over a running database.

Keep SQLite, WAL/SHM files, backups, Bridge configuration, credentials, and
durable inbox directories readable only by their service accounts. Follow
`docs/backup-and-restore.md` before upgrades.
