# Central Service Deployment

## Supported Boundary

The supported Compose profile runs one AgentRoom Server and Web UI behind
Caddy on a single trusted-team host. SQLite, the prepared Owner recovery
secret, backups, and Caddy state use private named volumes. Only Caddy publishes
ports: 9443 serves the application by default, while 80 is limited to ACME and
an exact-origin HTTPS redirect. Server port 3000 and `/api/metrics` are not
public.

This is a small-team, single-instance deployment. It is not a high-availability
or internet-scale identity service. Member offboarding and immediate Web
session revocation are not yet exposed to the Owner; do not use this baseline
where that control is mandatory.

## Host Requirements

The host needs:

- Git and a dedicated clean AgentRoom checkout;
- Docker Engine or Docker Desktop with Compose v2;
- OpenSSL to generate the Owner recovery secret;
- curl for health verification;
- a public DNS A/AAAA record pointing to the host;
- inbound TCP 80/9443 and outbound access required for ACME.

Node.js and Go are not required on a Compose host. Ensure no other service owns
ports 80 or 9443. Put another reverse proxy in front only after reproducing the
same HTTPS, WebSocket, MCP body, and Authorization-header behavior.

## Prepare the Release

Use a reviewed release tag or commit rather than an unrecorded moving branch.
The current preview can be cloned from the repository, but record the exact
revision before deployment:

```bash
git clone https://github.com/chenrgSix/AgentRoom.git
cd AgentRoom
git rev-parse HEAD
cp deploy/.env.example .env
mkdir -p deploy/secrets
umask 077
openssl rand -hex 32 > deploy/secrets/owner_recovery_token
```

Edit `.env` before starting:

| Variable | Required value |
| --- | --- |
| `AGENT_ROOM_DOMAIN` | Host name only, such as `team.example.com` |
| `AGENT_ROOM_PUBLIC_ORIGIN` | Exact HTTPS origin, including a non-default port, such as `https://team.example.com:9443` |
| `AGENT_ROOM_HTTP_PORT` | `80` for public certificate issuance and redirect |
| `AGENT_ROOM_HTTPS_PORT` | External application port, default `9443`; it must match `AGENT_ROOM_PUBLIC_ORIGIN` |
| `AGENT_ROOM_IMAGE_TAG` | Local image label aligned with the checked-out release |
| `AGENT_ROOM_DATABASE_PATH` | Container path under `/data`, normally `/data/agent-room.sqlite` |
| `AGENT_ROOM_OWNER_RECOVERY_TOKEN_FILE` | Host path to the generated secret file |
| `AGENT_ROOM_LOG_MAX_SIZE` | Per-file Docker log limit, default `10m` |
| `AGENT_ROOM_LOG_MAX_FILES` | Retained Docker log files, default `5` |

`AGENT_ROOM_IMAGE_TAG` is a local label, not a pulled immutable digest. The
checked-out Git tag is the source version. Never put a host absolute database
path in `AGENT_ROOM_DATABASE_PATH`; only `/data` is persisted by the
`agentroom_data` volume.

## Start and Verify

Render the configuration before creating containers:

```bash
docker compose config --quiet
docker compose build --pull agentroom
docker compose up -d
docker compose ps --all
```

Expected state:

- `secret-init` is `Exited (0)` after copying the validated secret into a
  private volume;
- `agentroom` is running and healthy;
- `caddy` is running after AgentRoom becomes ready.

Check logs and the public readiness endpoint:

```bash
docker compose logs --tail=100 secret-init agentroom caddy
docker compose logs -f agentroom caddy
curl --fail https://team.example.com:9443/api/health/ready
```

The initializer is network-disabled and short-lived. Server and Caddy use
read-only root filesystems, no-new-privileges, bounded Docker logs, and only the
documented writable volumes. Server runs as the non-root `node` user and drops
all Linux capabilities; Caddy keeps only `NET_BIND_SERVICE`.

## Initialize the Owner

Open the configured HTTPS origin in a browser. On first use, the Chinese-first
setup screen displays **设置 Team Owner**. Enter an Owner display name and paste
the contents of `deploy/secrets/owner_recovery_token` into **恢复密钥**. Do not
paste the filename, put the secret in a URL, or send it to a member.

Successful setup opens the Team UI and creates the authenticated Owner Cookie.
Keep the host secret permission-restricted and copy it to secure offline-capable
storage: it is also the explicit Owner recovery credential. Team members should
join only through Owner-created 24-hour, one-time invitation links.

## TLS and Bridge Trust

Caddy obtains and renews a public certificate automatically. Configure new
Bridges with `system_ca` trust so renewal needs no client edit. An internal CA
is acceptable only after installing its root on every client. Legacy SHA-256
leaf pins remain a compatibility mode and must be rotated with the certificate.
Application content is HTTPS-only; public HTTP exists solely for ACME and
redirects, while direct plain HTTP application access remains loopback-only.

## Troubleshooting

| Symptom | Inspect | Likely boundary |
| --- | --- | --- |
| `secret-init` is not `Exited (0)` | `docker compose logs secret-init` | missing, unreadable, or invalid-length recovery file |
| `agentroom` is unhealthy | `docker compose logs agentroom` | database path, migration, secret, or public-origin validation |
| Caddy cannot obtain a certificate | `docker compose logs caddy` | DNS, ports 80/9443, firewall, or ACME egress |
| Browser works but Bridge does not connect | Caddy and AgentRoom logs | public URL, system trust, WebSocket, or Device credential |
| `/api/metrics` returns `404` publicly | expected | metrics are intentionally hidden by Caddy |

Do not publish Server port 3000 or switch a public deployment to local auth
mode. Runtime output, Room messages, recovery secrets, and Bearer credentials
must never be copied into issue reports or shared logs.

## Backup, Upgrade, and Rollback

Before every upgrade, create a verified backup and copy it to another host or
storage system:

```bash
./scripts/compose-backup.sh
git status --short  # This must print nothing before continuing.
git fetch --tags
TARGET_RELEASE_TAG=REPLACE_WITH_REVIEWED_TAG
git checkout "$TARGET_RELEASE_TAG"
git describe --tags --exact-match
# Set AGENT_ROOM_IMAGE_TAG in .env to the same target release.
docker compose build --pull agentroom
docker compose up -d
docker compose ps --all
```

If `git status --short` prints any line, stop and use a separate clean checkout;
do not mix local tracked changes with a deployment build. Preserve the backup's
reported SHA-256 separately from the database file and verify it again before
any restore.

Startup applies forward migrations automatically. Verify readiness, Team/Room
history, one Agent connection, and one read-only MCP call before accepting the
upgrade.

A database rollback must also use the source/image version that owns that
schema. Restoring a pre-migration database and immediately starting the newer
image only reapplies the newer migrations. If rollback is required:

1. Stop Caddy and AgentRoom.
2. Stage the verified backup under a new `/data` filename with
   `compose-restore.sh`.
3. Set `.env` to the printed `AGENT_ROOM_DATABASE_PATH`.
4. Check out the previous release and align `AGENT_ROOM_IMAGE_TAG`.
5. Rebuild, start, and repeat health/history/Agent/MCP checks.

Keep the old and restored database files until the selected version is fully
verified. See [Backup and Restore](backup-and-restore.md) for exact commands.

## Stop or Remove Containers

Use the least destructive command that matches the intent:

```bash
docker compose stop   # Keep containers, network, and every named volume.
docker compose down   # Remove containers/network; keep named volumes.
```

Do not run `docker compose down -v` during normal operation. It removes the
SQLite data, prepared recovery secret, backup volume, and Caddy certificate
state. Before any deliberate uninstall, create and export a verified backup and
preserve the original Owner recovery file.

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
