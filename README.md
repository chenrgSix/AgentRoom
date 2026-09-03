# ConveneWire

> “有什么事跟我的Codex说去吧。”

ConveneWire is a self-hosted workspace for people and AI Agents. The central
Web service brings Rooms, tasks, execution history and delivery evidence into
one Team. Use an optional Central Agent for HTTP model calls, or connect a
Bridge on an execution machine for local Runtime and Workspace capabilities.

MCP lets a running Agent use Team capabilities. WebSocket plus the Bridge lets
the Team wake a managed Agent.

[Product website](https://chenrgsix.github.io/ConveneWire/) ·
[Getting started](https://chenrgsix.github.io/ConveneWire/guide/)

## Status

The central Team MVP is runnable: the Fastify API and React UI persist Teams,
Rooms, Agents, messages, structured mentions, Runs, ordered Run events, and
Agent replies in SQLite. Adaptive Discussions centrally schedule multiple
Agents under progress and budget policy. Remote MCP supports pull participants,
while the headless Go Bridge can wake configured Codex or Generic CLI runtimes.

- Current baseline:
  [convenewire_network_design_v0.2.md](convenewire_network_design_v0.2.md)
- Stable release:
  [ConveneWire v0.4.2](https://github.com/chenrgSix/ConveneWire/releases/tag/v0.4.2)
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

Current source includes Central HTTP Agents and the
[product experience iteration](docs/acceptance/qa-040-product-experience.md).
These capabilities are included in the v0.4.2 stable packages. Read the
[upgrade and verification notes](docs/releases/v0.4.2.md) and back up Central
before upgrading. Website publication is not an application Release.

Current unreleased source also includes
[client owner collaboration entry](docs/adr/0035-connect-client-owners-to-team-collaboration.md).
Use an updated Central, Web and Bridge together; v0.4.2 packages do not include
this flow.

The unreleased governed software-team execution route has completed its
bounded-autonomy product acceptance and
[final Core audit](docs/acceptance/qa-055-final-core-audit-goal.md). This source
status is not a packaged Release claim.

## Repository Ownership

Your repository stays on the client machine and remains under its owner's
control. The local Bridge, not Central, owns repository paths, Git remotes,
Git/SSH credentials, fetch/pull/push, worktrees and every Git command. Central
governs Plans, scheduling, bounded authorization, evidence adoption and
operation receipts; it cannot browse a checkout, obtain Git credentials or run
repository commands by itself. Remote Provider support is an optional,
credential-free-by-default evidence extension, not a Core requirement or a
grant of repository authority.

## Client Owner Entry

In **设备 → 配对新设备**, keep **同时确认成员归属并启用客户端入口**
selected. Choose the actual client owner: yourself, an existing ordinary Team
member, or a new member. Select the initial Rooms, share the complete pairing
link, then approve the matching verification phrase. Approval binds both the
person and Device; another Device can reuse the same member identity.

The paired client offers **进入 Team** and **选择房间 → 打开房间**. The browser
shows the member identity and destination before confirmation. This entry has
ordinary-member authority in that Team, even when the client owner is a Team
Owner. Full administrator login remains separate. Browser certificate trust
is still required when Central uses a private CA.

Adding an Agent in Room settings also selects its owner by default. Uncheck
that person for Agent-only access. Removing the person remains effective after
Agent reconnects; removing an Agent does not automatically remove the person.
Existing members keep their previously granted Rooms.

Existing Device credentials are never converted into human login credentials.
For an old client, update it and have the administrator confirm the actual
owner through a new member pairing link. The configured client uses its
explicit re-pairing flow, preserving local Runtime/Workspace configuration and
historical Device attribution. A stale, used or revoked entry requires a fresh
click from the client; it is never automatically replayed.

## Technology Baseline

| Component | Choice |
| --- | --- |
| Central Web | Node.js 22, TypeScript, Fastify, React, Vite |
| Team integration | Remote MCP Server |
| Push channel | Authenticated WebSocket |
| Local Bridge | Go 1.26.7, distributed as a macOS GUI or headless binary |
| Central controller | Go 1.26.7, distributed for Linux and macOS |
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
ops/            Central release verification and lifecycle controller
site/           Static product website and getting-started guide
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
git clone https://github.com/chenrgSix/ConveneWire.git
cd ConveneWire
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
2. Choose **创建中央 Agent** (Create a Central Agent), **连接本机 Agent**
   (Connect a local Agent), or **先体验演示** (Try a demo).
3. For a Central Agent, the Team Owner fills in a model and API key, explicitly
   selects Rooms, then chooses **验证并创建** (Validate and create). For a demo,
   add a demonstration Agent without a model or key.
4. Return to the Room, type `@`, select one Agent for a normal Run or multiple
   Agents for an adaptive discussion, enter a message, and send.

A message without a structured `@Agent` mention is stored in the Room but does
not wake an Agent.

Central Agents currently use the fixed OpenAI Responses HTTPS endpoint. They
do not install Codex/Pi, add another service, access a computer, read files or
execute tools. Configuration is optional and happens in the Web UI after
startup; provider keys are encrypted in the existing database. Validation and
execution may incur provider usage and send authorized Room context to that
provider. Formal Result review/completion remains a separate governed action.

An existing trusted-Team member who loses their session should ask the Owner
for a 15-minute recovery code in **Team 成员**, then use **成员重新登录** on the
sign-in page. A new invitation creates another identity; recovery preserves the
existing member. This path only supports ordinary single-Team members.

### Connect local Codex or Pi with the Bridge

The managed Bridge lets the central service wake a local runtime. Client
machines do not need Go or Node.js:

1. Download the archive for the client's OS and CPU from
   [GitHub Releases](https://github.com/chenrgSix/ConveneWire/releases). On macOS,
   choose the `convenewire-bridge-desktop` ZIP for Apple Silicon (`arm64`) or
   Intel (`amd64`), then move **ConveneWire Bridge.app** to `/Applications`. On
   64-bit Windows, use the `convenewire-bridge-desktop` executable ending in
   `windows_amd64_setup.exe` for a current-user installation, or choose the ZIP
   ending in `windows_amd64` for a portable copy.
2. Download `SHA256SUMS`, verify the archive, and extract it. Desktop packages
   are intentionally unsigned. The macOS app is also unnotarized; approve it
   under **Privacy & Security**, or remove quarantine from that app only after
   verification:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/ConveneWire Bridge.app"
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
   convenewire-bridge console --workspace /absolute/path/to/project
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
   export CONVENE_WIRE_MCP_TOKEN='paste-the-one-time-token'
   codex mcp add convene-wire \
     --url https://team.example.com/mcp \
     --bearer-token-env-var CONVENE_WIRE_MCP_TOKEN
   codex mcp get convene-wire
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

For a trusted small Team, use the checksum-pinned Central archive matching the
host's OS and CPU. The host needs Docker Engine 24 or newer with Compose 2.20
or newer; it does not need Git, Node.js, Go, OpenSSL, or manual `.env` editing.
When a release includes `convenewire-central` assets, verify the matching archive
with the outer Release `SHA256SUMS`, extract it, and retain the matching
`*.SHA256SUMS.sha256` asset as the separately published pin for the archive's
internal file manifest.

Run the shipped controller from the extracted root:

```bash
archive=convenewire-central_0.4.0-rc.1_linux_amd64.tar.gz
pin_asset=${archive%.tar.gz}.SHA256SUMS.sha256
release_dir=${archive%.tar.gz}
tar -xzf "${archive}"
pin=$(awk '{print $1}' "${pin_asset}")
cd "${release_dir}"
./bin/convenewirectl install \
  --release-dir "$PWD" \
  --checksums-sha256 "${pin}" \
  --data-root /absolute/persistent/convenewire-central \
  --mode direct_https \
  --domain team.example.com \
  --origin https://team.example.com:9443
./bin/convenewirectl doctor \
  --data-root /absolute/persistent/convenewire-central
```

Point public DNS at the host, allow the selected inbound ports and outbound
ACME traffic, and ensure no other process owns those ports. For loopback-only
use, select `--mode local`, `--domain localhost`, and a matching localhost
origin. The controller delegates startup migrations, backup, staged restore,
upgrade and non-purging uninstall to the repository-owned paths while keeping
the generated secrets out of its manifest and output.

Public DNS and a publicly trusted Caddy certificate are the accepted default.
[ADR-0023](docs/adr/0023-default-public-ca-and-scope-private-bridge-trust.md)
defines the private-LAN alternative: the pairing link pins the private CA to one
exact Bridge origin without installing an OS root. The source implementation is
complete under `CON-014`, `OPS-009`, `SEC-009`, `BRG-045`, and `WEB-048`; use an
exact release containing those tasks, because the earlier `v0.4.0-qa028.1`
Draft candidate predates the completed path. Exporting and installing Caddy's
local root or manually entering a leaf fingerprint remains advanced
compatibility only and cannot close `QA-030`.

The source-checkout Compose path remains available to maintainers and older
releases. Use a dedicated, clean checkout and record the exact source revision,
then prepare the ignored settings and file-backed Owner recovery secret:

```bash
git clone https://github.com/chenrgSix/ConveneWire.git
cd ConveneWire
git rev-parse HEAD                 # Record the exact deployed source revision.
cp deploy/.env.example .env
mkdir -p deploy/secrets
umask 077
openssl rand -hex 32 > deploy/secrets/owner_recovery_token
openssl rand -hex 32                    # Paste as CONVENE_WIRE_BRIDGE_SERVER_TOKEN.
# Edit CONVENE_WIRE_DOMAIN, CONVENE_WIRE_PUBLIC_ORIGIN, and the Bridge Token in .env.
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
file offline-capable: it protects Hosted credentials even after you replace the
login key. Builds implementing ADR-0032 expose **恢复密钥** in the authenticated
installation Owner's header. Save the newly generated key before confirming;
it replaces login recovery only, without changing Docker configuration or
Agent credentials. Released v0.4.2 predates this setting. Members join through
short-lived, one-time invitation links. See [Owner recovery](docs/deployment.md#owner-login-recovery)
if both the saved key and Owner sessions are lost.

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
cd bridge && go test ./... && go build ./cmd/convenewire-bridge
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

ConveneWire is source-available under the
[ConveneWire Community License 1.0](LICENSE). It permits commercial and
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
