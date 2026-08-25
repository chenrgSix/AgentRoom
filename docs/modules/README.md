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
| TASK | [Task Collaboration](task-collaboration.md) | Task, shared memory, result evidence | `apps/server/` | CON, ROOM, REG, DATA, SEC |
| REG | [Registry and Presence](agent-registry.md) | Member, Device, Agent, Presence | `apps/server/` | CON, DATA, SEC |
| RUN | [Run Orchestration](run-orchestration.md) | Run, delivery, handoff | `apps/server/` | CON, ROOM, REG, BRG, DATA |
| DISC | [Discussion Orchestration](discussion-orchestration.md) | Discussion, progress, budget, policy | `apps/server/src/discussion/` | CON, ROOM, RUN, ADP, DATA, SEC |
| MCP | [MCP Server](mcp-server.md) | MCP auth and Team tools | `apps/server/` | CON, ROOM, RUN, SEC |
| BRG | [Bridge](bridge.md) | Connection and local delivery state | `bridge/`, `apps/server/` | CON, REG, SEC |
| ADP | [Runtime Adapters](runtime-adapters.md) | Runtime process and Team Session | `bridge/internal/runtime/` | CON, BRG |
| WEB | [Web UI](web-ui.md) | Browser presentation state | `apps/web/` | ROOM, REG, RUN, BRG, SEC |
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
          ├── TASK
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
