# Module Architecture Index

This directory turns the v0.2 architecture baseline into implementation-sized
modules. The baseline defines product boundaries; these documents define module
ownership, interfaces, dependencies, failure behavior, and verification.

## Source-of-Truth Order

When documents disagree, use this order:

1. Accepted ADRs in `docs/adr/`;
2. `agent_room_network_design_v0.2.md`;
3. module documents in this directory;
4. `docs/TASKS.md` for delivery status, never for architecture;
5. code and generated API documentation.

An implementation change that alters a module contract must update its module
document and the task list in the same commit.

## Module Map

| Prefix | Module | State Owner | Planned Code | Depends On |
| --- | --- | --- | --- | --- |
| CON | [Contracts](contracts.md) | Wire schemas and compatibility | `packages/contracts/` | none |
| ROOM | [Team and Room](team-room.md) | Team, Room, Message | `apps/server/` | CON, DATA, SEC, REG |
| WSP | [Workspace Coordination](workspace-coordination.md) | Opaque Workspace identity, generation, leases | Server and Bridge | CON, REG, DATA, SEC |
| ART | [Artifact Content Transport](artifact-content-transport.md) | Sealed Blob storage and transport | Server and Bridge | CON, WSP, DATA, SEC |
| TASK | [Task Collaboration](task-collaboration.md) | Task, criteria, shared memory, Result review, result evidence | `apps/server/` | CON, ROOM, REG, WSP, ART, DATA, SEC |
| REG | [Registry and Presence](agent-registry.md) | Member, Device, Agent, Presence | `apps/server/` | CON, DATA, SEC |
| RUN | [Run Orchestration](run-orchestration.md) | Run, delivery, handoff | `apps/server/` | CON, ROOM, REG, BRG, TASK, ART, DATA |
| DISC | [Discussion Orchestration](discussion-orchestration.md) | Discussion, progress, budget, policy | `apps/server/src/discussion/` | CON, ROOM, RUN, ADP, DATA, SEC |
| MCP | [MCP Server](mcp-server.md) | MCP auth and Team tools | `apps/server/` | CON, ROOM, TASK, RUN, SEC |
| BRG | [Bridge](bridge.md) | Connection and local delivery state | `bridge/`, `apps/server/` | CON, REG, SEC |
| ADP | [Runtime Adapters](runtime-adapters.md) | Runtime process and Team Session | `bridge/internal/runtime/` | CON, BRG |
| WEB | [Web UI](web-ui.md) | Browser presentation state | `apps/web/` | ROOM, REG, TASK, RUN, BRG, SEC |
| DATA | [Persistence and Recovery](persistence-recovery.md) | Database and projection durability | `apps/server/` | CON |
| SEC | [Security and Authentication](security-auth.md) | Identity, credentials, authorization | server and Bridge | CON |
| QA/OPS | [Testing and Observability](testing-observability.md) | Evidence, telemetry, release gates | `tests/` and all modules | all |

## Dependency Flow

```text
CON
├── DATA
├── SEC
├── ROOM
├── REG
└── BRG
    └── ADP

ROOM + REG + BRG + DATA
          ├── WSP
          │   └── ART
          ├── TASK ← ART
          │   └── RUN
          └── RUN
              ├── MCP
              ├── DISC
              │   └── WEB
              └── WEB

QA/OPS verifies every layer.
```

Dependencies describe contract order, not necessarily delivery order. Fake
implementations may stand in for an unfinished dependency during a milestone.

## Server Composition Boundary

`apps/server/src/app.ts` is the Server composition root. It opens the database,
constructs shared repositories and services, installs process-wide hooks, owns
startup recovery and timers, and passes an explicit `ServerRouteContext` to
feature route registrars under `apps/server/src/http/`. Route registrars may
bind HTTP, WebSocket, or MCP transport behavior for their feature, but they do
not construct repositories, services, timers, or other cross-module state.
Shared request parsing and cookie helpers remain transport utilities and own no
domain state.

This boundary keeps dependency construction and lifecycle authority visible in
one place while allowing Auth, Team/Room, Registry, Message, Task, Discussion,
Run, Bridge, MCP, and system routes to evolve behind their existing public
contracts. Moving behavior between registrars does not change the state owner
listed in the module map.

## Standard Module Document

Every module document contains:

- purpose and ownership;
- responsibilities and explicit exclusions;
- public contracts;
- state and main flows;
- failure and security behavior;
- tests and acceptance;
- dependencies and task IDs.

Do not add a new large module without updating this index and
`docs/TASKS.md`.
