# Agent Room Network

> “有什么事跟我的Codex说去吧。”

Agent Room Network is a lightweight collaboration layer that organizes existing
AI coding runtimes into a centrally managed Team. The central Web service owns
Rooms, messages, mentions, routing, and history. A small, headless Bridge on
each participant machine receives routed work and invokes the local runtime.

MCP lets a running Agent use Team capabilities. WebSocket plus the Bridge lets
the Team wake a managed Agent.

## Status

The central Team MVP is runnable: the Fastify API and React UI persist Teams,
Rooms, Agents, messages, structured mentions, Runs, ordered Run events, and
Agent replies in SQLite. Adaptive Discussions centrally schedule multiple
Agents under progress and budget policy. Remote MCP supports pull participants,
while the headless Go Bridge can wake configured Codex or Generic CLI runtimes.

- Current baseline:
  [agent_room_network_design_v0.2.md](agent_room_network_design_v0.2.md)
- Stable release:
  [AgentRoom v0.2.0](https://github.com/chenrgSix/AgentRoom/releases/tag/v0.2.0)
- Historical baseline:
  [agent_room_network_design_v0.1.md](agent_room_network_design_v0.1.md)
- Contributor rules: [CONTRIBUTING.md](CONTRIBUTING.md)
- Module architecture: [docs/modules/README.md](docs/modules/README.md)
- Authoritative task register: [docs/TASKS.md](docs/TASKS.md)
- Architecture decisions: [docs/adr/README.md](docs/adr/README.md)
- Two-machine acceptance:
  [docs/acceptance/qa-002-two-machine-managed-agent.md](docs/acceptance/qa-002-two-machine-managed-agent.md)
- Security and clean-room audit:
  [docs/acceptance/qa-005-security-clean-room-audit.md](docs/acceptance/qa-005-security-clean-room-audit.md)

## Technology Baseline

| Component | Choice |
| --- | --- |
| Central Web | Node.js 22, TypeScript, Fastify, React, Vite |
| Team integration | Remote MCP Server |
| Push channel | Authenticated WebSocket |
| Local Bridge | Go 1.26.7, distributed as a macOS GUI or headless binary |
| MVP persistence | SQLite |
| Server and Web tests | Node test runner and TypeScript build |
| Bridge tests | Go test |

The central Web service and Bridge exchange versioned JSON messages. JSON
Schema is the source of truth for cross-language wire contracts.

## Planned Layout

```text
apps/
  server/       Central APIs, MCP endpoint, routing, and Bridge WebSocket
  web/          Team and Room browser UI
packages/
  contracts/    JSON Schema and generated TypeScript/Go types
bridge/         Go Bridge and runtime adapters
docs/modules/   Module ownership, contracts, and acceptance boundaries
docs/adr/       Architecture decision records
docs/TASKS.md   Authoritative milestones and delivery state
tests/e2e/      Cross-process acceptance scenarios
```

Do not create an unstarted directory until its corresponding task becomes
active. The contracts package and server data layer are currently implemented.

## Installation and Quick Start

Source development requires Node.js 22 and npm; Go is required only when
developing the Bridge. A production Compose host does not need either runtime
because the image builds them inside Docker. Clone and start a local development
instance:

```bash
git clone https://github.com/chenrgSix/AgentRoom.git
cd AgentRoom
nvm use 22                       # optional when Node 22 is already active
npm ci
npm run db:migrate
```

Start the API and Web UI in two terminals:

```bash
npm run dev:server               # http://127.0.0.1:3000
npm run dev:web                  # http://127.0.0.1:5173
```

Open `http://127.0.0.1:5173`. On first use:

1. Create a Team, then create its first Room.
2. Open **智能体管理** (Agent Management).
3. Add two **演示智能体** to verify both Runs and collaboration without a
   local AI runtime.
4. Return to the Room, type `@`, select one Agent for a normal Run or multiple
   Agents for an adaptive discussion, enter a message, and send.

A message without a structured `@Agent` mention is stored in the Room but does
not wake an Agent.

### Connect local Codex or Pi with the Bridge

The managed Bridge lets the central service wake a local runtime. Client
machines do not need Go or Node.js:

1. Download the archive for the client's OS and CPU from
   [GitHub Releases](https://github.com/chenrgSix/AgentRoom/releases). On macOS,
   choose the `agentroom-bridge-desktop` ZIP for Apple Silicon (`arm64`) or
   Intel (`amd64`), then move **AgentRoom Bridge.app** to `/Applications`. On
   64-bit Windows, use the `agentroom-bridge-desktop` executable ending in
   `windows_amd64_setup.exe` for a current-user installation, or choose the ZIP
   ending in `windows_amd64` for a portable copy.
2. Download `SHA256SUMS`, verify the archive, and extract it. Desktop packages
   are intentionally unsigned. The macOS app is also unnotarized; approve it
   under **Privacy & Security**, or remove quarantine from that app only after
   verification:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/AgentRoom Bridge.app"
   ```

   Windows may show a Microsoft Defender SmartScreen warning for the unsigned
   executable. Continue only after verifying the checksum; do not disable
   SmartScreen or Defender globally. The Windows app uses Microsoft Edge
   WebView2. The installer detects a missing Runtime and can open Microsoft's
   official download page; it never downloads or runs the Runtime by itself.
   Installation needs no administrator access, creates a current-user Start
   menu entry and uninstaller, and leaves Bridge configuration and credentials
   under the user's application-data directory untouched during upgrades and
   uninstall.
3. Open the desktop app. For a headless system, use the portable CLI archive
   and its launcher, or run:

   ```bash
   agentroom-bridge console --workspace /absolute/path/to/project
   ```

4. In the local Console, enter the central server URL and select the detected
   Codex or Pi preset. The Bridge displays a short approval code.
5. In the central Web UI, open **智能体管理 → 托管 Codex**, enter that code,
   and approve the Device. Keep the Bridge running; the Agent should become
   **就绪** before it is mentioned.
6. In the local Bridge window, click **测试运行** on each Codex or Pi row to
   verify its login, model access, and managed preset before sending Team work.

Codex must already be installed and signed in on the client. Pi is started by
the Generic CLI adapter. Remote servers require HTTPS. Public certificates use
normal `system_ca` validation and renew without client edits; an independently
verified SHA-256 pin remains available for private/legacy deployments. See the
complete [Bridge guide](bridge/README.md).

### Connect an already-running Agent through MCP

MCP is the lightweight pull mode: it lets an existing Codex conversation join
the Team, but MCP alone cannot wake an idle client.

1. Open **智能体管理 → MCP 客户端**, name the Agent, and create its one-time
   token.
2. Store the displayed token in the client environment and register the MCP
   endpoint:

   ```bash
   export AGENT_ROOM_MCP_TOKEN='paste-the-one-time-token'
   codex mcp add agent-room \
     --url https://team.example.com/mcp \
     --bearer-token-env-var AGENT_ROOM_MCP_TOKEN
   codex mcp get agent-room
   ```

3. Ask the running client to call `team.whoami`, then use `team.wait` or
   `team.get_mentions` to receive work.

Loopback development may use `http://127.0.0.1:3000/mcp`. Remote clients must
use HTTPS. See [MCP client setup](docs/mcp-client-setup.md) for the participant
instructions and supported tools.

### Use Rooms and Agent discussions

- Send without a structured mention to add a normal Room message.
- Type `@` and choose one ready Agent to create a normal managed Run.
- Mention two to five ready Agents in the same message to start an orchestrated
  Team discussion automatically; there is no separate discussion mode.
- Use **结束并生成结论**, **本轮后停止**, pause, continue, or cancel controls
  while a discussion is active. The orchestrator, not a fixed visible turn
  count, decides whether another turn has useful value.
- Open **智能体管理** to inspect Agent presence, approve or revoke Bridge
  Devices, and create MCP credentials.

If an Agent does not reply, confirm that it was selected from the `@` list, its
status is **就绪**, the Bridge is running, and the local runtime executable and
login work. Server health is available at `/api/health`; production Caddy
intentionally hides `/api/metrics` from the public network.

## Production Deployment

For a trusted small Team, use the included non-root Server and Caddy Compose
profile. The host needs Git, Docker Engine or Docker Desktop with Compose v2,
OpenSSL, and curl; it does not need Node.js or Go. Point a public DNS A/AAAA
record at the host, allow inbound TCP 80/9443 and outbound ACME traffic, and
ensure no other process owns those ports.

A private-LAN deployment may use a stable IP or internal host name instead of
public DNS. Keep `:9443` in `AGENT_ROOM_PUBLIC_ORIGIN`, export Caddy's local CA
root, verify it independently, and trust that root on each Bridge machine.

Use a dedicated, clean checkout and record the exact source revision. Prefer a
reviewed release tag when it contains the desired deployment changes. Then
prepare the ignored settings and file-backed Owner recovery secret:

```bash
git clone https://github.com/chenrgSix/AgentRoom.git
cd AgentRoom
git rev-parse HEAD                 # Record the exact deployed source revision.
cp deploy/.env.example .env
mkdir -p deploy/secrets
umask 077
openssl rand -hex 32 > deploy/secrets/owner_recovery_token
openssl rand -hex 32                    # Paste as AGENT_ROOM_BRIDGE_SERVER_TOKEN.
# Edit AGENT_ROOM_DOMAIN, AGENT_ROOM_PUBLIC_ORIGIN, and the Bridge Token in .env.
docker compose config --quiet
docker compose build --pull agentroom
docker compose up -d
docker compose ps --all
curl --fail https://team.example.com:9443/api/health/ready
```

The application is served only over HTTPS and defaults to external port 9443;
port 80 exists solely for certificate issuance and an exact-origin redirect.
`secret-init` should show `Exited (0)`, while `agentroom` and `caddy` should be
running. Open the configured HTTPS origin, enter an Owner
display name, and paste the recovery **file contents**, not its path. Keep that
file offline-capable for later Owner recovery; members join through short-lived,
one-time invitation links.

Use `docker compose logs --tail=100 secret-init agentroom caddy` when startup
fails. Run `./scripts/compose-backup.sh` for a verified online backup and copy
the resulting file to another host or storage system. `docker compose stop`
preserves the deployment, and `docker compose down` preserves named volumes;
never use `docker compose down -v` unless you deliberately intend to erase the
database, private backup volume, prepared recovery secret, and Caddy state. Read
[Central Deployment](docs/deployment.md) and
[Backup and Restore](docs/backup-and-restore.md) before exposing, restoring, or
upgrading a server.

## Development and Verification

From the repository root:

```bash
npm run validate
npm run build
npm test
npm run test:e2e
cd bridge && go test ./... && go build ./cmd/agentroom-bridge
```

`npm run test:e2e:live` explicitly invokes local Codex and Pi with bounded
read-only/no-tools settings against an isolated temporary Team. Ordinary test
runs do not use local model credentials.

## Delivery Workflow

Start work from a stable task ID in `docs/TASKS.md`. Update its state and
completion evidence in the same commit as the implementation. If a change
alters module ownership, interfaces, or acceptance criteria, update the owning
document under `docs/modules/` as well.

## Documentation Checks

```bash
npx markdownlint-cli2 "**/*.md"
```

The v0.1 document is excluded because it is retained as an immutable historical
artifact.

## License

AgentRoom is source-available under the
[AgentRoom Community License 1.0](LICENSE). It permits commercial and
noncommercial use inside one organization, any number of Team and Room records,
source modification, self-hosting, product integrations, and one dedicated
deployment for one customer. A separate commercial license is required for
multi-customer hosted services, a competing standalone resale, or external
white-label distribution without the required attribution.

See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) for a practical use-case
summary, [TRADEMARKS.md](TRADEMARKS.md) for brand usage, [NOTICE](NOTICE) for
the required copyright notice, and
[CONTRIBUTOR-LICENSE-AGREEMENT.md](CONTRIBUTOR-LICENSE-AGREEMENT.md) for the
contribution grant. Because the license restricts specific hosted and
white-label uses, it is source-available rather than OSI-approved open source.
Third-party dependencies retain their own licenses. Released versions remain
under the license shipped with that version.
