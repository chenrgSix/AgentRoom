# Agent Room Network

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
- Historical baseline:
  [agent_room_network_design_v0.1.md](agent_room_network_design_v0.1.md)
- Contributor rules: [CONTRIBUTING.md](CONTRIBUTING.md)
- Module architecture: [docs/modules/README.md](docs/modules/README.md)
- Authoritative task register: [docs/TASKS.md](docs/TASKS.md)
- Architecture decisions: [docs/adr/README.md](docs/adr/README.md)

## Technology Baseline

| Component | Choice |
| --- | --- |
| Central Web | Node.js 22, TypeScript, Fastify, React, Vite |
| Team integration | Remote MCP Server |
| Push channel | Authenticated WebSocket |
| Local Bridge | Go 1.26.7, distributed as a headless binary |
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

## Build and Test

Node.js 22 and Go 1.26.7 are required. From the repository root:

```bash
npm install
npm run validate
npm run build
npm test
npm run test:e2e
npm run db:migrate
npm run dev:server
npm run dev:web
cd bridge && go test ./... && go build ./cmd/agentroom-bridge
```

`npm run test:e2e:live` is an explicit, credential-using acceptance command.
It invokes local Codex and Pi with bounded read-only/no-tools settings against
a temporary server and cleans up its database and Bridge state. Ordinary test
runs skip this live model scenario.

Run the two development commands in separate terminals, then open
`http://127.0.0.1:5173`. Create a Team, Room, and one or more Fake Agents;
select an Agent in the composer to create and execute a structured Run.

Use the Web **Connect an Agent** panel for a one-time MCP token. For a managed
local Codex or Pi, run `agentroom-bridge console` on its machine, open the
printed local URL, and approve the displayed code in the central Web panel.
The terminal-only `join` command remains available. See
[docs/mcp-client-setup.md](docs/mcp-client-setup.md) and
[bridge/README.md](bridge/README.md) for client and headless Bridge setup.

The migration command uses `AGENT_ROOM_DATABASE_PATH`,
`AGENT_ROOM_DATA_DIR`, or the server workspace's local `var/` directory.
Additional module commands must be added when those modules are scaffolded.

For cross-machine use, keep the server on loopback behind an HTTPS reverse
proxy, or explicitly set `AGENT_ROOM_HOST` for a trusted LAN test. Read
[docs/deployment.md](docs/deployment.md) before exposing any endpoint.

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

No project license has been selected. Do not publish or redistribute the
repository as open source until maintainers make an explicit licensing
decision.
