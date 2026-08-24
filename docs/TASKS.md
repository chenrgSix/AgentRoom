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
preserve the P0-P9 roadmap defined by the v0.2 architecture baseline:

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
| P9 | Adaptive Agent Discussion reaches a governed conclusion | DISC-006, WEB-017, QA-007 |

## Milestone G0: Governance and Architecture

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| GOV-001 | DONE | Initialize Git repository | none | `main` exists with clean history |
| GOV-002 | DONE | Establish v0.2 architecture baseline | GOV-001 | v0.2 document committed |
| GOV-003 | DONE | Define repository standards | GOV-002 | README, contributing, lint, ADR rules |
| GOV-004 | DONE | Split architecture into module documents | GOV-003 | module index and task register committed |
| GOV-005 | DONE | Define adaptive Discussion orchestration baseline | GOV-004 | accepted ADR, module boundary, state machine, budget, and verification matrix agree |
| GOV-006 | DONE | Adopt noncommercial source-available licensing | GOV-003 | standard license, Required Notice, commercial policy, contribution boundary, metadata, and release packaging agree |
| GOV-007 | DONE | Publish installation and usage quick start | GOV-003, BRG-008, MCP-005 | README guides a clean clone through Team setup, Bridge and MCP enrollment, Agent invocation, Discussion controls, production deployment, and diagnostics |

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
| ROOM-004 | DONE | Add Room-scoped human and Agent participation | ROOM-003, REG-002, SEC-002 | migrations preserve existing Room access; only assigned humans can discover and use a Room, only assigned Agents can be mentioned or join Discussions, and Owner-managed roster updates keep history intact |
| ROOM-005 | DONE | Add recoverable Team and Room lifecycle controls | ROOM-004, SEC-005 | migration 0017 plus `team-room-service.test.ts` prove Owner-only rename and archive/restore preserve history and stable IDs; archived resources disappear from ordinary navigation, reject new work, and active Runs or Discussions fence archival without physical deletion |
| REG-001 | DONE | Implement Member and Device registry | DATA-002, SEC-001 | membership and device ownership persist |
| REG-002 | DONE | Implement Agent publication and capability validation | REG-001, CON-003 | managed/manual agents publish correctly |
| REG-003 | DONE | Implement Presence TTL and derived status | REG-002 | ready, busy, degraded, manual, offline verified |
| REG-004 | DONE | Add recoverable Agent enablement controls | REG-003, ROOM-004, RUN-003 | `agent-service.test.ts` and `team-room-service.test.ts` prove Owner-only disable/enable preserves stable identity and Room assignment, rejects active work, and cannot be undone by managed Bridge republication |
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
| BRG-007 | DONE | Add local Bridge configuration Console | BRG-006, ADP-005 | token-authenticated loopback UI configures enrollment, Codex/Pi presets, status, and fenced restart with Go and browser acceptance |
| BRG-008 | DONE | Publish standalone Bridge release artifacts | BRG-007 | published GitHub Release builds five CGO-free archives with OS launchers, injected tag version, browser-open Console, and SHA-256 checksums |
| BRG-009 | DONE | Extract reusable Bridge lifecycle controller | BRG-007 | CLI Console and desktop shell share tested start, stop, restart, configuration, enrollment, and shutdown operations |
| BRG-010 | DONE | Add lightweight Bridge desktop GUI | BRG-009 | native WebView and tagged tests pass; visual acceptance proves one process, close-to-tray continuity, second-launch restore, and tray lifecycle controls without a terminal |
| BRG-011 | DONE | Publish unsigned macOS desktop Bridge packages | BRG-010 | native arm64/amd64 GUI ZIPs pass GitHub-hosted builds, join the release checksum manifest, document app-scoped user trust, and retain all five CLI archives |
| BRG-012 | DONE | Expose Bridge operational status and renewable HTTPS trust | BRG-010 | GUI distinguishes process and connection states; retry projection and `system_ca`/legacy pin compatibility tests pass |
| BRG-013 | ACTIVE | Add opt-in macOS login startup | BRG-012 | owner-scoped LaunchAgent tests and a real login restart preserve one desktop instance without credentials in the plist |
| BRG-014 | DONE | Export a redacted Bridge diagnostic bundle | BRG-012 | bounded diagnostic export contains only allowlisted operational fields and seeded secrets, paths, prompts, replies, and stable IDs are absent |
| BRG-015 | DONE | Add manual Bridge update checks | BRG-011, BRG-012 | explicit user action compares stable versions and opens only the official Release page without downloading, replacing, or executing code |
| BRG-016 | DONE | Isolate incompatible terminal Bridge inbox records | BRG-005, OPS-001, OPS-002 | terminal records with incompatible trace metadata are isolated without replay; active records fail closed without being discarded; Run events require a matching trace ID; malformed, rejected, and failed processing paths are safely distinguished |
| BRG-017 | DONE | Classify Generic Runtime process failures safely | ADP-005, BRG-014 | start failures and nonzero exits expose only stable category, exit code, and stderr-presence metadata; seeded stderr content never crosses the Bridge boundary |
| BRG-018 | DONE | Preserve safe Runtime failure metadata centrally | BRG-017, RUN-003 | Codex and Generic exit metadata survives authenticated WebSocket ingestion and Run-event persistence; only allowlisted category, exit code, and stderr-presence fields survive, while raw stderr and unknown keys are rejected |
| BRG-019 | DONE | Version Bridge Runtime presets and add local self-test | BRG-018, BRG-007 | Go migration tests preserve owner fields while replacing legacy Pi flags and rejecting future versions; authenticated Console tests prove manual-only, active-Run-fenced, bounded Codex/Pi probes with safe result projection |
| BRG-020 | DONE | Isolate concurrent managed Agent execution | BRG-005, BRG-016 | race-tested Bridge coverage proves durable acceptance, same-Agent FIFO, cross-Agent overlap, duplicate bypass, queued cancel without Runtime start, explicit cancel causality, and deterministic disconnect recovery |
| BRG-021 | DONE | Manage Bridge Agents individually | BRG-007, BRG-019, BRG-020 | authenticated Console tests prove multiple Codex/Pi Agents can be added and one selected Agent can be edited in a modal without changing its stable identity, replacing sibling configuration, or interrupting active work |
| BRG-022 | DONE | Preflight Bridge Runtime configuration before save | BRG-019, BRG-021 | token-authenticated Console coverage proves detected paths populate enrollment and one-Agent modal drafts only on explicit action; bounded Codex/Pi preflight leaves configuration and Bridge lifecycle untouched while concurrent preflight, Runtime self-test, enrollment/save, and active Team work are fenced |
| ADP-002 | DONE | Implement Runtime Adapter interface | ADP-001, BRG-001 | Fake Adapter runs behind production interface |
| ADP-003 | DONE | Spike Codex machine-protocol lifecycle | ADP-002 | start, events, interrupt, and exit documented |
| ADP-004 | DONE | Implement managed Codex Team Session | ADP-003, BRG-005 | Bridge completes one remote Codex run |
| ADP-005 | DONE | Implement Generic CLI fallback | ADP-002 | stdout, exit, timeout, and cancel verified |
| ADP-006 | DONE | Add structured Pi output boundary | ADP-005, BRG-019 | preset v2 emits Pi JSON events; the dedicated adapter exposes only the final assistant reply and fails closed on malformed streams or leaked provider tool protocol |
| ADP-007 | ACTIVE | Follow owner-controlled local Pi permissions | ADP-006, BRG-022 | preset v3 keeps only Bridge-owned JSON/print/session lifecycle flags, preserves owner-authored Pi permission arguments during legacy migration, and parser/Console tests prove local tool events remain private while the final assistant reply is delivered |

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
| WEB-013 | DONE | Expand Room participants to the full context sidebar | WEB-012 | participant roster fills the remaining column without a nested card or fixed-height list |
| WEB-014 | DONE | Replace Mention selection with inline `@` suggestions | WEB-003, WEB-013 | typing `@` opens a keyboard-accessible Agent list and selection still submits a stable Agent ID |
| WEB-015 | DONE | Add persistent light and dark themes | WEB-009, WEB-014 | desktop and mobile theme actions update the full Web shell and persist the local preference |
| WEB-016 | DONE | Resolve timeline sender display names | WEB-003, WEB-011 | Agent and member messages render the registered sender name resolved from the stable sender ID |
| WEB-018 | DONE | Add trusted-team setup, invitation, and session screens | SEC-005, WEB-009 | Chinese-first setup/recovery, fragment invitation claim, session restore/logout, and Owner invite controls pass component and public API acceptance |
| WEB-019 | DONE | Unify Room message and Discussion composer | WEB-014, WEB-017 | no separate Discussion entry remains; tests cover 0, 1, and 2-5 structured Mention routing, token identity synchronization, and competing Discussion rejection |
| WEB-023 | DONE | Dock Room composition and Discussion status | WEB-019, WEB-022 | desktop and narrow-screen component coverage proves the timeline owns scrolling and the dynamically sized Discussion status and composer never overlay Room messages |
| WEB-024 | DONE | Expose persistent Team creation entry | WEB-007, WEB-018 | desktop rail and mobile navigation open an accessible Team creation modal and switch to the created Team |
| WEB-025 | DONE | Manage Room participants from the Room context | ROOM-004, WEB-013, WEB-014 | Owner-only participant controls update humans and Agents independently; sidebar and Mention suggestions render only the selected Room roster |
| WEB-026 | DONE | Replace broad Room polling with event-driven reconciliation | WEB-021, OPS-002 | `team-change-service.test.ts`, the Web application tests, and Server/Web builds prove authorized monotonic Team change cursors wake selected-Room reconciliation promptly; reconnect, server restart, hidden tabs, and stream failure retain bounded HTTP fallback without a healthy two-second full refresh |
| WEB-027 | DONE | Make Room message submission recoverable | WEB-019, WEB-026, ROOM-002 | migration 0018, Message/API regressions, the outbox unit test, onboarding component test, and Server/Web builds prove client Message IDs deduplicate ambiguous retries; pending and failed rows remain visible with same-ID retry, while message, Team, participant, and lifecycle operations use independent pending state |
| WEB-028 | DONE | Expose recoverable Team, Room, and Agent lifecycle controls | ROOM-005, REG-004, WEB-024, WEB-025 | the onboarding component regression and Web build prove accessible Owner controls rename and archive/restore Teams and Rooms and disable/enable Agents; ordinary navigation excludes archived resources while the recovery modal retains access without deleting history |

## Workstream F4: MCP Team Participation

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| MCP-001 | DONE | Expose authenticated Remote MCP endpoint | SEC-001, CON-004 | unauthorized clients receive no Team data |
| MCP-002 | DONE | Implement context, messages, send, and reply tools | MCP-001, ROOM-002 | tool contract and authorization tests pass |
| MCP-003 | DONE | Implement mentions, Run, and handoff tools | MCP-002, RUN-006 | manual Agent can complete a Team Run |
| MCP-004 | DONE | Implement `team.wait`, Room, and inbox resources | MCP-001, ROOM-002 | bounded wait resumes by cursor and respects membership |
| MCP-005 | DONE | Publish client-neutral setup and Skill guidance | MCP-003 | fresh client can join without source changes |

## Workstream F5: Adaptive Agent Discussion

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| DISC-001 | DONE | Add Discussion, turn, progress, decision, and budget contracts and persistence | CON-004, ROOM-002, DATA-003 | migration and repository tests preserve aggregate versions and unique turn ordinals |
| DISC-002 | DONE | Implement deterministic progress projection and plateau evidence | DISC-001 | structured deltas, priority-aware plateau, and reply-only downgrade tests pass |
| DISC-003 | DONE | Implement budget ledger, leases, telemetry downgrade, and finalization reserve | DISC-001 | turns, tokens, duration, cost, extensions, unknown usage, and reserve invariants pass |
| DISC-004 | DONE | Implement authoritative policy engine and Discussion state machine | DISC-002, DISC-003, RUN-004 | policy precedence, decision priority, stale fencing, and user control races are deterministic |
| DISC-005 | DONE | Build bounded Discussion context and Runtime assessment adapters | DISC-004, ADP-004, ADP-005 | Codex and Generic Runtime receive named context and capability downgrade is explicit |
| DISC-006 | DONE | Implement durable turn scheduling and finalization outputs | DISC-004, DISC-005, RUN-003 | routing intent recovers once and final answer, decision record, and unresolved issues persist |
| DISC-007 | DONE | Orchestrate durable parallel Discussion Waves | DISC-006, RUN-004, DATA-003 | one atomic Wave fans out to Agents that exist, are enabled, and belong to the Room Team; all-settled creates one deterministic `wave_result` anchor, builds the next bounded transcript in participant order, records one logical Wave plus committed member execution slots, and advances exactly once across duplicate callbacks, partial failure, cancellation, and restart; the optional semantic evaluator remains a standalone evidence contract until separately integrated |
| WEB-017 | DONE | Add Discussion composer, progress, extension, and stop controls | DISC-004, DISC-006, WEB-016 | component coverage and live browser acceptance prove start, inspect, continue, adjust, finish, pause, and cancel without exposed turn targets |
| WEB-020 | DONE | Show parallel Wave progress and member outcomes | DISC-007, WEB-019 | component tests show one logical round, every parallel Agent Run, barrier progress, partial/all-failed state, Wave-boundary controls, and finalization without presenting Agent jobs as separate rounds |
| WEB-021 | DONE | Make Room timeline tail-aware and incrementally synchronized | WEB-020, ROOM-002 | MessageService and Web tests prove a newest-100 tail snapshot, resumable cursor delta, duplicate suppression, bounded history, and single-flight refresh without stale snapshot replacement |
| WEB-022 | DONE | Show safe Runtime failure diagnostics in Room | WEB-021, BRG-018 | failed Run cards fetch authorized events once and render localized allowlisted code, category, exit code, and guidance; projection tests prove raw stderr, local paths, error messages, and unknown keys never enter the view model |
| QA-007 | DONE | Verify adaptive Codex-Pi Discussion end to end | DISC-006, WEB-017, QA-006 | live Codex-to-Pi review and finalization pass; deterministic tests cover early finish, extension, plateau, user finish, and hard-stop finalization |
| QA-010 | DONE | Verify parallel Wave scheduling and recovery | DISC-007, WEB-020, QA-004 | callback permutations, duplicate terminals, deterministic `wave_result` retry, participant-ordered 24-message context, Reviewer semantics, member-slot accounting, mixed outcomes, cancel-all, three reopened-SQLite recovery cut points, public API fan-out, Web barrier rendering, and a live parallel Codex-Pi finalization pass |

## Workstream F6: Recovery, Security, and Release Evidence

| ID | State | Task | Depends On | Completion Evidence |
| --- | --- | --- | --- | --- |
| DATA-003 | DONE | Persist Run, delivery, and event sequence state | RUN-003 | restart resumes without state regression |
| DATA-004 | DONE | Add backup, restore, and migration rollback procedure | DATA-003 | tested backup restores acceptance fixture |
| SEC-002 | DONE | Enforce Team, Room, Agent, and Run authorization | ROOM-003, RUN-002 | cross-Team and cross-Owner negative tests pass |
| SEC-003 | DONE | Add credential rotation and Device revoke propagation | BRG-003, SEC-002 | revoked Bridge cannot reconnect or receive Runs |
| SEC-004 | DONE | Add message and log redaction boundary | MCP-002, BRG-004 | seeded secrets never enter persisted output |
| SEC-005 | DONE | Add trusted-team Web identity and recovery | SEC-001, OPS-003 | trusted mode disables public bootstrap; secure Cookie setup/recovery, Origin checks, hashed one-time member invitations, expiry, replay, and non-owner tests pass |
| OPS-001 | DONE | Propagate trace IDs through message, Run, Bridge, runtime | RUN-003 | one authorized query reconstructs persisted Message, Run, Delivery, and Runtime event entries; cross-process E2E verifies one trace |
| OPS-002 | DONE | Add structured logs, metrics, and health endpoints | OPS-001 | safe HTTP/Bridge/Run logs, Prometheus metrics, live/ready/degraded health, and tested failure signals |
| OPS-003 | DONE | Document and configure deployable listener topology | BRG-003, MCP-001 | loopback, proxy, and trusted-LAN modes are explicit |
| OPS-004 | DONE | Package a trusted-team single-host deployment | OPS-003, SEC-005, DATA-004 | non-root Server plus Caddy Compose serves the app only over HTTPS, limits port 80 to ACME/redirect, hides metrics, preserves WebSocket/MCP headers, and passes graceful health checks |
| DATA-005 | DONE | Add container backup and restore workflow | DATA-004, OPS-004 | timestamped native SQLite backup and streamed restore pass `quick_check`, SHA-256, no-overwrite, invalid-input, and 67 MB fixture acceptance |
| OPS-005 | DONE | Make central Compose operations self-contained | OPS-004, DATA-005, QA-008 | environment template, CI config validation, bounded container logs, and operator runbooks cover first setup, health, troubleshooting, upgrades, safe stop, backup, restore, and rollback boundaries |
| QA-002 | READY | Verify two-machine managed Agent flow | ADP-004, WEB-005 | two-physical-machine HTTPS runbook is executable; DONE requires committed PASS evidence for online and offline/reconnect Codex Runs |
| QA-003 | DONE | Verify three-Agent guarded handoff | MCP-003, RUN-006 | public Web and Remote MCP E2E completes Alice → Bob → Carol Runs with shared trace and rejects a lineage loop |
| QA-004 | DONE | Verify restart, reconnect, duplicate, and cancellation | DATA-003, RUN-005 | recovery matrix passes repeatedly |
| QA-005 | DONE | Run security and clean-room release audit | SEC-004, QA-004 | committed audit records zero open critical findings, remediated npm advisory, zero Go findings, and clean-tree build/test/five-target packaging |
| QA-006 | DONE | Verify local cross-process managed flow | BRG-005, ADP-005, RUN-003 | real server, Go Bridge, and Generic Runtime reply passes |
| QA-008 | DONE | Add continuous repository quality gates | QA-005 | every main push and pull request validates contracts, Node builds/tests/E2E/docs, Go tests/vet, and native desktop compilation |
| QA-009 | DONE | Publish and verify the v0.2 release candidate | BRG-011, BRG-015, SEC-005, OPS-004, QA-008 | tag-pinned, no-clobber draft-to-prerelease workflow publishes exactly seven archives, checksums, and license assets; clean downloads pass the same verifier |
| QA-011 | DONE | Publish and verify v0.2.0-rc.2 | QA-009, QA-010, BRG-018, OPS-005 | exact tagged source passes main CI; the no-clobber workflow uploads and verifies five CLI archives, two macOS desktop archives, checksums, and license assets; the published prerelease passes a clean-download verification |
| QA-012 | DONE | Verify Room and Bridge UX stabilization | WEB-021, WEB-022, BRG-019 | `docs/acceptance/qa-012-room-bridge-ux.md` records passing Node, Go, Desktop, E2E, docs, 101-plus-message, safe diagnostic, preset migration, bounded probe, and secret-leakage evidence |
| QA-013 | DONE | Verify managed Agent concurrency isolation | BRG-020, QA-004 | `docs/acceptance/qa-013-agent-concurrency-isolation.md` records passing race, FIFO, cross-Agent overlap, duplicate, queued-cancel, reconnect, full Go/Desktop, Node, and deterministic E2E evidence |
| QA-014 | DONE | Publish and verify v0.2.0-rc.3 | QA-012, QA-013 | `docs/acceptance/qa-014-v0.2.0-rc.3.md` records exact-tag CI, seven verified archives, public prerelease publication, and an independent 11-asset clean-download verification |
| QA-015 | DONE | Publish and verify v0.2.0-rc.4 | WEB-026, WEB-027, WEB-028, BRG-022, QA-008 | `docs/acceptance/qa-015-v0.2.0-rc.4.md` records exact-tag CI, seven verified archives, public prerelease publication, and an independent 11-asset clean-download verification while retaining the separate physical gates |

## Deferred Beyond MVP

| ID | State | Task | Trigger |
| --- | --- | --- | --- |
| FUT-001 | PLANNED | PostgreSQL and multi-instance central service | SQLite or single-instance limits are measured |
| FUT-002 | PLANNED | Slack, Feishu, or Discord human entry | Web Room MVP is validated |
| FUT-003 | PLANNED | A2A interoperability | External Agent interop is required |
| FUT-004 | PLANNED | Artifact and structured-result transport | Message-only collaboration is insufficient |
| FUT-005 | PLANNED | Attach to an existing visible Runtime Session | Runtime exposes a stable supported contract |
