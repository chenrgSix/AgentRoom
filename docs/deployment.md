# Central Service Deployment

## Supported Boundary

The supported Compose profile runs one ConveneWire Server and Web UI behind
Caddy on a single trusted-team host. SQLite, the prepared Owner recovery
secret, backups, and Caddy state use private named volumes in the manual profile
and owner-selected bind directories under `convenewirectl`. Only Caddy publishes
ports: 9443 serves the application by default, while 80 is limited to ACME and
an exact-origin HTTPS redirect. Server port 3000 and `/api/metrics` are not
public.

This is a small-team, single-instance deployment. It is not a high-availability
or internet-scale identity service. Member offboarding and immediate Web
session revocation are not yet exposed to the Owner; do not use this baseline
where that control is mandatory.

[ADR-0023](adr/0023-default-public-ca-and-scope-private-bridge-trust.md)
accepts public-CA HTTPS as the default external deployment and origin-scoped
private CA trust as the no-manual-CA Bridge alternative. The source path is
complete under `CON-014`, `OPS-009`, `SEC-009`, `BRG-045`, and `WEB-048`, but
the earlier `v0.4.0-qa028.1` Draft candidate predates those completed commits.
Use a newer exact release for private-LAN pairing. The old candidate's manual
CA import proves only reachability and cannot close normal onboarding.

## Host Requirements

The host needs:

- Git and a dedicated clean ConveneWire checkout;
- Docker Engine or Docker Desktop with Compose v2;
- OpenSSL to generate the Owner recovery secret;
- curl for health verification;
- a stable public DNS name for the default public-CA path, or an explicitly
  selected private DNS name/LAN IP with `private_scoped_ca`;
- inbound TCP 80/9443 and outbound ACME access for the default public-CA path.

Node.js and Go are not required on a Compose host. Ensure no other service owns
ports 80 or 9443. Put another reverse proxy in front only after reproducing the
same HTTPS, WebSocket, MCP body, and Authorization-header behavior.

## Prepare the Release

Use a reviewed release tag or commit rather than an unrecorded moving branch.
The current preview can be cloned from the repository, but record the exact
revision before deployment:

```bash
git clone https://github.com/chenrgSix/ConveneWire.git
cd ConveneWire
git rev-parse HEAD
cp deploy/.env.example .env
mkdir -p deploy/secrets
umask 077
openssl rand -hex 32 > deploy/secrets/owner_recovery_token
```

Edit `.env` before starting:

| Variable | Required value |
| --- | --- |
| `CONVENE_WIRE_DOMAIN` | Stable host name or LAN IP, such as `team.example.com` or `192.168.1.132` |
| `CONVENE_WIRE_PUBLIC_ORIGIN` | Exact HTTPS origin, including a non-default port, such as `https://team.example.com:9443` |
| `CONVENE_WIRE_HTTP_PORT` | `80` for public certificate issuance and redirect |
| `CONVENE_WIRE_HTTPS_PORT` | External application port, default `9443`; it must match `CONVENE_WIRE_PUBLIC_ORIGIN` |
| `CONVENE_WIRE_BIND_ADDRESS` | Ingress bind address; manual direct HTTPS defaults to `0.0.0.0`, while controller local mode uses `127.0.0.1` |
| `CONVENE_WIRE_IMAGE_TAG` | Local image label aligned with the checked-out release |
| `CONVENE_WIRE_DATABASE_PATH` | Container path under `/data`, normally the upgrade-stable `/data/agent-room.sqlite` |
| `CONVENE_WIRE_OWNER_RECOVERY_TOKEN_FILE` | Host path to the generated secret file |
| `CONVENE_WIRE_LOG_MAX_SIZE` | Per-file Docker log limit, default `10m` |
| `CONVENE_WIRE_LOG_MAX_FILES` | Retained Docker log files, default `5` |

`CONVENE_WIRE_IMAGE_TAG` is a local label, not a pulled immutable digest. The
checked-out Git tag is the source version. Never put a host absolute database
path in `CONVENE_WIRE_DATABASE_PATH`; only `/data` is persisted by the
upgrade-stable `agentroom_data` volume.

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
- `data-init` is `Exited (0)` after assigning the private database/backup
  mounts to the image's non-root `node` account;
- `agentroom` is running and healthy (the service name is retained for
  in-place Compose upgrades);
- `caddy` is running after ConveneWire becomes ready.

Check logs and the public readiness endpoint:

```bash
docker compose logs --tail=100 secret-init agentroom caddy
docker compose logs -f agentroom caddy
curl --fail https://team.example.com:9443/api/health/ready
```

Both initializers are network-disabled and short-lived. `data-init` retains
only the bounded ownership capabilities needed for the database and backup
mounts; it does not run migrations or application logic. Server and Caddy use
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

Account login and Device credentials authenticate a principal only after TLS
has authenticated the Central. They never replace certificate validation.
Application content is HTTPS-only; public HTTP exists solely for ACME and the
exact-origin redirect, while direct plain HTTP application access remains
loopback-only.

The accepted `direct_https` TLS profiles are:

| Profile | Behavior | Use |
| --- | --- | --- |
| `public_ca` | Caddy obtains/renews a publicly trusted certificate; Bridge uses normal system chain, hostname and validity checks | default and recommended |
| `private_scoped_ca` | pairing link/QR pins the Caddy public CA to the exact Central origin inside Bridge only; no OS root install | explicit private-network alternative |
| `manual_ca` | operator manages OS or enterprise trust; ConveneWire never installs it | advanced compatibility only |

A new external installation that omits the profile must select `public_ca`.
DNS, ACME, hostname, or public-chain failure is a failed install with actionable
guidance; it must not silently fall back to Caddy local CA, a leaf pin, trust on
first use, or disabled verification.

In `private_scoped_ca`, the pairing fragment carries only the exact origin,
stable non-secret installation ID, monotonic trust epoch, and canonical CA DER
SHA-256. Before sending any pairing or Device secret, Bridge retrieves one
bounded public CA certificate from
`/.well-known/convenewire/bridge-ca.pem`, verifies that digest and CA constraints,
then reconnects with a private certificate pool scoped to that exact scheme,
hostname, and port. It never changes Windows, macOS, or Linux trust stores.
Public-CA pairing carries no trust override and remains on `system_ca`.

This scoped trust affects Bridge only. An arbitrary browser does not inherit
Bridge trust. Cross-machine Web without manual CA installation therefore uses a
publicly trusted hostname or an operator-managed enterprise trust channel; do
not click through certificate warnings. A private deployment may keep the Owner
browser on the Central host or another already managed browser and pair the
remote Bridge through the scoped link.

The controller and Caddy publish the deployment-owned well-known CA and
descriptor in explicit `private_scoped_ca` mode. Server projection, Web link
encoding, Bridge bootstrap/persistence and authenticated two-CA rotation are
implemented under `SEC-009`, `WEB-048`, and `BRG-045`. `QA-030` still owns the
clean packaged cross-host proof; deterministic local evidence alone must not be
reported as physical no-manual-CA acceptance.

### Advanced current compatibility: manual CA

For a private LAN IP, include the external port in the origin:

```dotenv
CONVENE_WIRE_DOMAIN=192.168.1.132
CONVENE_WIRE_PUBLIC_ORIGIN=https://192.168.1.132:9443
CONVENE_WIRE_HTTPS_PORT=9443
```

Caddy uses its local CA for an IP certificate and renews the leaf certificate
automatically. Export the stable root certificate after first startup:

```bash
docker compose cp \
  caddy:/data/caddy/pki/authorities/local/root.crt \
  deploy/secrets/caddy-local-root.crt
openssl x509 -in deploy/secrets/caddy-local-root.crt \
  -noout -fingerprint -sha256
```

Transfer the root certificate through an independently verified channel,
confirm its SHA-256 value, install it in each client operating system's trusted
root store, and keep Bridge on `system_ca` only when an operator explicitly
chooses the advanced `manual_ca` compatibility path. This changes trust outside
ConveneWire and is not the default, not required by the target private-scoped
flow, and not valid evidence for `QA-030`, `QA-002`, or `QA-028`. Pinning the
short-lived leaf certificate is likewise suitable only for bounded legacy
diagnostics because renewal changes that fingerprint.

## Troubleshooting

| Symptom | Inspect | Likely boundary |
| --- | --- | --- |
| `secret-init` is not `Exited (0)` | `docker compose logs secret-init` | missing, unreadable, or invalid-length recovery file |
| `convenewirectl doctor` reports `SECRET_INVALID` or upgrade reports `UPGRADE_SECRET_INVALID` | mode and bounded format of the recorded recovery file | restore the exact original mode-`0600` credential from authorized recovery storage; never generate a new value for an existing Owner |
| `data-init` is not `Exited (0)` | `docker compose logs data-init` | database/backup mount ownership or image account mismatch |
| `agentroom` is unhealthy | `docker compose logs agentroom` | stable compatibility service name; check database path, migration, secret, or public-origin validation |
| Caddy cannot obtain a public certificate | `docker compose logs caddy` | DNS, ports 80/9443, firewall, or ACME egress; do not accept silent local-CA fallback |
| Browser works but Bridge does not connect | Caddy and ConveneWire logs | public URL, system trust, WebSocket, or Device credential |
| Private scoped pairing is unavailable | exact release tag and `convenewirectl status` | the installed release predates completed `OPS-009`/`BRG-045`, or the deployment did not select `private_scoped_ca`; manual CA is not a fallback |
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
# Set CONVENE_WIRE_IMAGE_TAG in .env to the same target release.
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

1. Stop Caddy and ConveneWire.
2. Stage the verified backup under a new `/data` filename with
   `compose-restore.sh`.
3. Set `.env` to the printed `CONVENE_WIRE_DATABASE_PATH`.
4. Check out the previous release and align `CONVENE_WIRE_IMAGE_TAG`.
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
CONVENE_WIRE_WEB_ROOT="$PWD/apps/web/dist" \
CONVENE_WIRE_DATABASE_PATH="$PWD/var/server.sqlite" \
CONVENE_WIRE_HOST=127.0.0.1 \
npm run start --workspace @convene-wire/server
```

The local `/api/bootstrap` flow is for one machine. The process refuses a
non-loopback listener in this mode.
