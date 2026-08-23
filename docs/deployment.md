# Deployment Baseline

## Local Development

Local authentication is intentionally loopback-only. Build the React client
and run the Node service without exposing it to another machine:

```bash
npm ci
npm run build
AGENT_ROOM_WEB_ROOT="$PWD/apps/web/dist" \
AGENT_ROOM_DATABASE_PATH="$PWD/var/server.sqlite" \
AGENT_ROOM_HOST=127.0.0.1 \
npm run start --workspace @agent-room/server
```

The local `/api/bootstrap` flow is for one machine. The process refuses a
non-loopback listener in this mode.

## Trusted-Team Compose Profile

The supported small-team deployment runs one non-root, capability-free,
read-only Server container behind Caddy. Only Caddy publishes ports: 443 serves
the application, while 80 is limited to certificate issuance and HTTPS
redirects. Server port 3000, SQLite, secrets, and the backup volume stay on the
private Compose network. The public proxy rejects `/api/metrics` and preserves
WebSocket upgrades, MCP request bodies, and bearer authorization headers.

Prepare a public DNS name whose ports 80 and 443 reach the host, then create
the ignored configuration and recovery secret:

```bash
cp deploy/.env.example .env
mkdir -p deploy/secrets
umask 077
openssl rand -hex 32 > deploy/secrets/owner_recovery_token
```

Set the same HTTPS origin in `AGENT_ROOM_DOMAIN` and
`AGENT_ROOM_PUBLIC_ORIGIN`, then start and inspect the profile:

```bash
docker compose config
docker compose up -d --build
docker compose ps
curl --fail https://team.example.com/api/health/ready
```

Open the HTTPS origin. The first browser uses the recovery secret once to
adopt or create the Owner. Later Owner recovery uses the same file-backed
secret. Members join through 24-hour, one-time invitation links; the link token
is carried in the URL fragment and exchanged for an HttpOnly Cookie.

A short-lived, network-disabled initializer copies the host secret into a
private Docker volume with read-only permissions before the non-root Server
starts. This avoids relying on platform-specific Compose bind-mount ownership.
The recovery file remains ignored by Git and excluded from the Docker build
context. Do not expose Server port 3000 or place local auth mode behind a proxy.

## TLS and Bridge Trust

Caddy obtains and renews a public certificate automatically. Configure new
Bridges with `system_ca` trust so normal renewal does not require editing each
client. An internal CA is acceptable only after its root is installed on every
client. Legacy SHA-256 leaf pins remain a compatibility mode and must be
rotated when the certificate changes. Plain HTTP is limited to loopback.

## Operations and Recovery

Compose restarts both services and gives Server 30 seconds for graceful
shutdown. Server drops all Linux capabilities; Caddy keeps only
`NET_BIND_SERVICE`. Root filesystems are read-only, and only `/data`,
`/backups`, the prepared secret volume, Caddy state, and `/tmp` are writable.
Keep `.env`, recovery secrets, SQLite files, Bridge credentials, and exported
diagnostics out of source control.

Create a verified backup with `./scripts/compose-backup.sh`. Restore by staging
a backup under a new database name with `./scripts/compose-restore.sh`; never
overwrite a running SQLite file. Follow [Backup and Restore](backup-and-restore.md)
before upgrades and retain the previous database until health, history, Agent,
and MCP checks pass.
