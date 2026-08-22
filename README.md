# Agent Room Network

Agent Room Network is a lightweight collaboration layer that organizes existing
AI coding runtimes into a centrally managed Team. The central Web service owns
Rooms, messages, mentions, routing, and history. A small, headless Bridge on
each participant machine receives routed work and invokes the local runtime.

MCP lets a running Agent use Team capabilities. WebSocket plus the Bridge lets
the Team wake a managed Agent.

## Status

The project is in the architecture-baseline phase. No executable application
has been scaffolded yet.

- Current baseline:
  [agent_room_network_design_v0.2.md](agent_room_network_design_v0.2.md)
- Historical baseline:
  [agent_room_network_design_v0.1.md](agent_room_network_design_v0.1.md)
- Contributor rules: [CONTRIBUTING.md](CONTRIBUTING.md)
- Architecture decisions: [docs/adr/README.md](docs/adr/README.md)

## Technology Baseline

| Component | Choice |
| --- | --- |
| Central Web | Node.js 22, TypeScript, Fastify, React, Vite |
| Team integration | Remote MCP Server |
| Push channel | Authenticated WebSocket |
| Local Bridge | Go, distributed as a headless binary |
| MVP persistence | SQLite |
| Web tests | Vitest and Playwright |
| Bridge tests | Go test |

The central Web service and Bridge exchange versioned JSON messages. JSON
Schema is the source of truth for cross-language wire contracts.

## Planned Layout

```text
apps/
  server/       Central APIs, MCP endpoint, routing, and Bridge WebSocket
  web/          Team and Room browser UI
packages/
  contracts/    JSON Schema and generated TypeScript types
bridge/         Go Bridge and runtime adapters
docs/adr/       Architecture decision records
tests/e2e/      Cross-process acceptance scenarios
```

Do not create these directories until the corresponding implementation
milestone starts.

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
