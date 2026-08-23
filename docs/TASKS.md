# Project Task Register

This is the single authoritative delivery checklist. Module documents define
behavior; this file records what is planned, ready, active, or complete.

## Maintenance Rules

- Allowed states: `DONE`, `READY`, `ACTIVE`, `PLANNED`, `BLOCKED`.
- A task has one stable ID. Never rename or reuse an ID after merge.
- Mark a task `DONE` only when its stated evidence exists and relevant checks
  pass.
- A commit that starts or completes work must update the task state in this
  file.
- Scope or acceptance changes must update the owning module document in the
  same commit.
- Keep only one `ACTIVE` task per implementation stream unless parallel work
  is explicitly coordinated.
- `BLOCKED` requires a written reason and the dependency or decision needed.
- New work must be assigned to a module prefix before implementation.

## Architecture Roadmap Traceability

Task dependencies, not table order, control implementation. These exit tasks
preserve the P0-P8 roadmap defined by the v0.2 architecture baseline:

| Phase | Baseline Outcome | Exit Tasks |
| --- | --- | --- |
| P0 | Web creates a Room and simulates two Agents | WEB-001, QA-001 |
| P1 | Structured Mention creates an observable Run | ROOM-003, RUN-001, WEB-003 |
| P2 | Paired Go Bridge publishes Agent and Presence | BRG-002, BRG-004, REG-003 |
| P3 | Mention starts a managed Codex Team Session | ADP-004 |
| P4 | Web streams Run status and reply | RUN-003, WEB-005 |
| P5 | MCP client reads, replies, and requests handoff | MCP-003, MCP-005 |
| P6 | Reconnect, redelivery, and server restart recover | DATA-003, QA-004 |
| P7 | Three Agents complete a guarded handoff | RUN-006, QA-003 |
| P8 | A second Runtime mode joins the Team | ADP-005 |

## Milestone G0: Governance and Architecture

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| GOV-001 | DONE | Initialize Git repository | none | `main` exists with clean history |
| GOV-002 | DONE | Establish v0.2 architecture baseline | GOV-001 | v0.2 document committed |
| GOV-003 | DONE | Define repository standards | GOV-002 | README, contributing, lint, ADR rules |
| GOV-004 | DONE | Split architecture into module documents | GOV-003 | module index and task register committed |

## Workstream F0: Contracts and Fake System

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| CON-001 | DONE | Scaffold JSON Schema contract package | GOV-004 | package builds and validates schemas |
| CON-002 | DONE | Define IDs, timestamps, versions, and error envelope | CON-001 | common schemas and positive/negative fixtures pass |
| CON-003 | DONE | Define Bridge message schemas | CON-002 | hello, heartbeat, publish, and run schemas validate |
| CON-004 | DONE | Generate TypeScript and Go contract types | CON-003, Go toolchain | generation is deterministic and both languages agree on fixtures |
| DATA-001 | DONE | Add SQLite migration runner and database location | GOV-004 | empty database migrates from zero |
| DATA-002 | DONE | Add Team, Room, Message, and registry tables | DATA-001, CON-002 | repository tests persist and reload entities |
| ADP-001 | DONE | Implement deterministic Fake Runtime Adapter | CON-002 | scripted events exercise success and failure |
| QA-001 | DONE | Build in-process Fake Bridge and acceptance harness | CON-004, ADP-001, WEB-001 | Web Room simulates two Agents end to end |

## Workstream F1: Team, Room, and Registry

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| SEC-001 | DONE | Define Web user, member, and device credential model | CON-002 | threat cases and auth contract tests pass |
| ROOM-001 | DONE | Implement Team and Room repositories and services | DATA-002, SEC-001 | create, read, and authorization tests pass |
| ROOM-002 | DONE | Implement Message persistence and pagination | ROOM-001 | stable cursor ordering survives restart |
| ROOM-003 | DONE | Validate structured Mention references | ROOM-002, REG-002 | invalid or unauthorized mentions are rejected |
| REG-001 | DONE | Implement Member and Device registry | DATA-002, SEC-001 | membership and device ownership persist |
| REG-002 | DONE | Implement Agent publication and capability validation | REG-001, CON-003 | managed/manual agents publish correctly |
| REG-003 | DONE | Implement Presence TTL and derived status | REG-002 | ready, busy, degraded, manual, offline verified |
| WEB-001 | DONE | Scaffold Web shell and basic Team management | ROOM-001, REG-001 | user creates Team, Room, Member, and fake Agent |

## Workstream F2: Bridge and Managed Runtime

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| BRG-001 | DONE | Scaffold Go Bridge process and configuration | CON-004, SEC-001 | binary starts with validated config |
| BRG-002 | DONE | Implement invitation pairing and credential storage | BRG-001, REG-001 | one-time invitation cannot be replayed |
| BRG-003 | DONE | Implement authenticated WebSocket and heartbeat | BRG-002, CON-003 | reconnect and TTL tests pass |
| BRG-004 | DONE | Publish local Agents and capabilities | BRG-003, REG-002 | server registry converges after reconnect |
| BRG-005 | DONE | Add durable run inbox and deduplication | BRG-003, DATA-001 | repeated run ID executes at most once |
| BRG-006 | DONE | Add client-initiated managed Agent enrollment | BRG-002, BRG-004, SEC-002 | client join code, Owner approval, automatic config, and Agent publication pass |
| ADP-002 | DONE | Implement Runtime Adapter interface | ADP-001, BRG-001 | Fake Adapter runs behind production interface |
| ADP-003 | DONE | Spike Codex machine-protocol lifecycle | ADP-002 | start, events, interrupt, and exit documented |
| ADP-004 | DONE | Implement managed Codex Team Session | ADP-003, BRG-005 | Bridge completes one remote Codex run |
| ADP-005 | DONE | Implement Generic CLI fallback | ADP-002 | stdout, exit, timeout, and cancel verified |

## Workstream F3: Run Orchestration and Web Experience

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| RUN-001 | DONE | Create Run from a valid Mention | ROOM-003, REG-003 | one message creates the intended target Run |
| RUN-002 | DONE | Implement durable delivery and acceptance | RUN-001, BRG-005 | ACK loss retries without duplicate execution |
| RUN-003 | DONE | Apply sequenced status and reply events | RUN-002 | stale events cannot regress Run state |
| RUN-004 | DONE | Implement cancellation and terminal-state races | RUN-003 | first persisted terminal state wins |
| RUN-005 | DONE | Implement offline queue and expiry | RUN-002, REG-003 | reconnect delivers queued work once |
| RUN-006 | DONE | Implement guarded handoff | RUN-003 | depth, loop, and unique-agent limits pass |
| WEB-002 | DONE | Implement Team Room message timeline | WEB-001, ROOM-002 | reload preserves ordered history |
| WEB-003 | DONE | Implement structured Mention composer | WEB-002, ROOM-003 | display labels resolve to stable Agent IDs |
| WEB-004 | DONE | Implement Agent presence panel | WEB-001, REG-003 | all integration modes render accurately |
| WEB-005 | DONE | Implement Run card and live updates | WEB-002, RUN-003 | queued through terminal states are visible |
| WEB-006 | DONE | Implement pairing and revoke screens | WEB-001, BRG-002 | user can pair and revoke a Device |
| WEB-007 | DONE | Add guided Team onboarding and actionable empty states | WEB-001, WEB-006 | component interaction test and live browser flow reach Room setup |
| WEB-008 | DONE | Add dedicated Agent management control plane | WEB-004, WEB-006, BRG-006 | Agent roster, connection approval, integration setup, and Device controls are discoverable and component-tested |
| WEB-009 | DONE | Add Chinese-first Web localization | WEB-008 | Simplified Chinese is the default, English remains selectable, and locale persistence is component-tested |
| WEB-010 | DONE | Fix bodyless Device revoke requests | WEB-006 | Device DELETE omits JSON content type and the Web state converges to revoked |
| WEB-011 | DONE | Reorganize Agent management navigation and Room participants | WEB-008, WEB-009 | rail action opens management and sidebar shows Team members plus visible Agents for the selected Room |
| WEB-012 | DONE | Flatten the Room sidebar after its participant roster | WEB-011 | no modules follow Room participants; Room switching, creation, and locale controls remain available in the workspace header |

## Workstream F4: MCP Team Participation

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| MCP-001 | DONE | Expose authenticated Remote MCP endpoint | SEC-001, CON-004 | unauthorized clients receive no Team data |
| MCP-002 | DONE | Implement context, messages, send, and reply tools | MCP-001, ROOM-002 | tool contract and authorization tests pass |
| MCP-003 | DONE | Implement mentions, Run, and handoff tools | MCP-002, RUN-006 | manual Agent can complete a Team Run |
| MCP-004 | DONE | Implement `team.wait`, Room, and inbox resources | MCP-001, ROOM-002 | bounded wait resumes by cursor and respects membership |
| MCP-005 | DONE | Publish client-neutral setup and Skill guidance | MCP-003 | fresh client can join without source changes |

## Workstream F5: Recovery, Security, and Release Evidence

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| DATA-003 | DONE | Persist Run, delivery, and event sequence state | RUN-003 | restart resumes without state regression |
| DATA-004 | DONE | Add backup, restore, and migration rollback procedure | DATA-003 | tested backup restores acceptance fixture |
| SEC-002 | DONE | Enforce Team, Room, Agent, and Run authorization | ROOM-003, RUN-002 | cross-Team and cross-Owner negative tests pass |
| SEC-003 | DONE | Add credential rotation and Device revoke propagation | BRG-003, SEC-002 | revoked Bridge cannot reconnect or receive Runs |
| SEC-004 | DONE | Add message and log redaction boundary | MCP-002, BRG-004 | seeded secrets never enter persisted output |
| OPS-001 | PLANNED | Propagate trace IDs through message, Run, Bridge, runtime | RUN-003 | one query reconstructs the full path |
| OPS-002 | PLANNED | Add structured logs, metrics, and health endpoints | OPS-001 | failure dashboard signals defined scenarios |
| OPS-003 | DONE | Document and configure deployable listener topology | BRG-003, MCP-001 | loopback, proxy, and trusted-LAN modes are explicit |
| QA-002 | PLANNED | Verify two-machine managed Agent flow | ADP-004, WEB-005 | Alice Web to Bob Codex reply passes |
| QA-003 | PLANNED | Verify three-Agent guarded handoff | MCP-003, RUN-006 | Alice, Bob, Carol chain completes |
| QA-004 | DONE | Verify restart, reconnect, duplicate, and cancellation | DATA-003, RUN-005 | recovery matrix passes repeatedly |
| QA-005 | PLANNED | Run security and clean-room release audit | SEC-004, QA-004 | audit report has no open critical finding |
| QA-006 | DONE | Verify local cross-process managed flow | BRG-005, ADP-005, RUN-003 | real server, Go Bridge, and Generic Runtime reply passes |

## Deferred Beyond MVP

| ID | State | Task | Trigger |
| --- | --- | --- | --- |
| FUT-001 | PLANNED | PostgreSQL and multi-instance central service | SQLite or single-instance limits are measured |
| FUT-002 | PLANNED | Slack, Feishu, or Discord human entry | Web Room MVP is validated |
| FUT-003 | PLANNED | A2A interoperability | External Agent interop is required |
| FUT-004 | PLANNED | Artifact and structured-result transport | Message-only collaboration is insufficient |
| FUT-005 | PLANNED | Attach to an existing visible Runtime Session | Runtime exposes a stable supported contract |
