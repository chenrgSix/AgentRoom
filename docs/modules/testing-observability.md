# Testing and Observability

## Scope

- Prefixes: `QA` and `OPS`
- Planned location: tests beside modules plus `tests/e2e/`
- Owns: shared fixtures, E2E evidence, telemetry and release gates

This module defines repository-wide verification, operational signals, and
release evidence.

## Test Layers

- Unit tests verify domain transitions, validation, and policy decisions.
- Contract tests verify JSON Schema in TypeScript, Go, and each adapter.
- Integration tests exercise SQLite, WebSocket, MCP, Bridge, and recovery seams.
- E2E tests run public API-to-server-to-real Bridge process workflows.
- Security tests prove unauthorized and unsafe operations are rejected.

Every behavioral fix adds a focused regression. Protocol changes require
cross-language compatibility tests. The deterministic FakeAdapter is the
default for races, disconnects, duplicate delivery, and timeout scenarios.

Every push to `main` and every pull request runs schema validation, generated
contract checks, Node builds and tests, deterministic cross-process E2E,
Markdown lint, Go tests and vet, plus a native macOS desktop compile. Release
workflows do not replace this gate.

The `QA-001` integration test exercises one authenticated user, one Team and
Room, two Fake Agents, stable-ID mentions, ordered Run events, Agent replies,
and SQLite reload through the public HTTP API. It is the central MVP gate; it
does not claim production Bridge, WebSocket, or browser automation coverage.

`QA-006` starts a real TCP server, builds and pairs the Go Bridge, publishes a
managed Generic CLI Agent, sends a structured Mention through the Web API, and
asserts the durable terminal Run and Agent reply. It proves the local
cross-process transport while keeping physical two-machine Codex acceptance as
a separate release check.

The physical `QA-002` procedure is maintained in
`docs/acceptance/qa-002-two-machine-managed-agent.md`. It requires two real
machines, HTTPS and fingerprint verification, a released Bridge archive, local
Codex, online execution, offline queue/reconnect, one trace reconstruction, and
a sanitized committed PASS record. Local processes and containers cannot close
this task.

`QA-003` uses only public Web and Remote MCP endpoints. A Team Owner assigns a
root Run to Alice Agent, Alice hands off to Bob Agent, and Bob hands off to
Carol Agent. All three Agents claim and complete their Runs; the test verifies
parent lineage, one shared trace, ordered Room replies, and rejection when
Carol attempts to revisit Alice.

The recovery matrix combines server restart persistence for Run, Delivery, and
event sequence; Bridge durable inbox restart to `outcome_unknown`; duplicate
ACK and event idempotency; offline reconnect delivery; expiry; and a real
cross-process cancellation. Each case has a deterministic regression test.

Discussion verification uses a deterministic evaluator fixture and fake usage
telemetry. It covers early completion, multi-dimensional lease renewal,
plateau detection, policy precedence, reserved finalization, stale decision
fencing, all user stop modes, restart recovery, optional assessment transport,
and reply-only Codex/Generic CLI downgrade without calling a model. A browser
acceptance run proves that two Fake Agents alternate and persist a final
conclusion through the public HTTP API.

`QA-007` runs only when explicitly requested with `npm run test:e2e:live`.
The verified 2026-08-23 run used Codex CLI `0.149.0-alpha.4.1` as a read-only
Solver and Pi `0.84.2` as a no-tools Generic CLI Reviewer. A temporary server,
SQLite database, Bridge identity, and inbox proved Codex-to-Pi scheduling,
structured assessment transport, one useful automatic lease extension, the
soft boundary, user-requested finish, Pi finalization, and cleanup. Deterministic
Orchestrator tests remain the stable evidence for early finish, plateau, and
hard-budget reserved finalization.

## Required Scenarios

The release suite covers offline queueing, ACK loss, duplicate delivery,
out-of-order events, cancellation races, restart recovery, capability
downgrade, sensitive-output filtering, and the three-member handoff journey
defined by the architecture baseline. Discussion scenarios additionally cover
useful continuation, low-value repetition, unresolved high-priority issues,
missing usage telemetry, and optional Reviewer policies.

## Observability Contract

One `traceId` follows Message, Run, delivery, Bridge, and Runtime events.
The central service creates the opaque `trace_...` identity when a root Message
is persisted. Replies, child Runs, durable delivery payloads, and sequenced Run
events inherit it. New Bridges echo it on ACK, status, reply, and handoff
events; a mismatched value is rejected. For v0.1 Bridge compatibility, an
omitted event `traceId` is resolved from the authoritative Run rather than
breaking an existing connection.

`GET /api/traces/{traceId}` executes one ordered SQL query across persisted
Message, Run, Delivery, and Run Event metadata. The caller must be a member of
the owning Room, and the response deliberately excludes prompts, replies,
credentials, and local paths.

Structured logs include stable identifiers, state transitions, latency, and
error codes but exclude secrets and full prompts. Metrics cover connection
health, queue depth, delivery age, retries, Run outcomes, and event lag.

Health endpoints distinguish process liveness, dependency readiness, and
degraded optional capabilities. Audit records are durable and access-controlled.

`OPS-001` is verified by contract fixtures, migration tests, forged-trace
negative tests, restart persistence tests, and the real Server-to-Go-Bridge
Generic Runtime E2E.

`OPS-002` exposes the following operational surfaces without prompts, reply
content, credentials, headers, request bodies, or local paths:

- `GET /api/health/live` proves the process event loop is responding.
- `GET /api/health/ready` returns `503` when SQLite is unavailable.
- `GET /api/health` reports `ready`, `degraded`, or `unavailable`; an enabled
  managed Agent with no active Bridge is degraded, while no managed Agent is
  `not_configured` rather than unhealthy.
- `GET /api/metrics` emits Prometheus text for HTTP status classes, active
  Bridges, enabled managed Agents, queued Runs, pending delivery age, retries,
  Run outcomes, Agent Presence, and active Run event lag.

HTTP completion/rejection, Bridge connect/disconnect, Delivery ACK, Run state,
and Run reply processing emit structured JSON fields. Runtime output and error
messages are never log fields.

| Failure | Dashboard signal | Default interpretation |
| --- | --- | --- |
| Database unavailable | readiness `503`, `agentroom_up 0` | page immediately |
| Managed Bridge absent | health `degraded`, zero Bridge connections | investigate connectivity |
| Queue not draining | queue depth plus oldest delivery age rising | investigate routing/Bridge |
| Delivery instability | delivery retry total rising | investigate ACK/network loss |
| Runtime failures | `failed` or `outcome_unknown` Run totals rising | inspect trace metadata |
| Active Run stalled | Run event lag rising | inspect Runtime and cancellation |
| Request rejection burst | HTTP `4xx`/`5xx` counters rising | inspect auth/client/server errors |

## Release Evidence

A task is `DONE` only when its completion evidence in `docs/TASKS.md` exists.
Release notes name migrations, compatibility changes, security impact, and the
exact checks run. Work is tracked by `QA-001` through `QA-009` and `OPS-001`
through `OPS-004`.

The current security and exported-tree evidence is recorded in
`docs/acceptance/qa-005-security-clean-room-audit.md`. Its PASS applies only to
the documented trusted Owner deployment boundary and lists remaining release
constraints explicitly.

The trusted-team container, proxy, backup, and restore acceptance is recorded
in `docs/acceptance/ops-004-data-005-compose.md`. It separates local TLS smoke
evidence from public certificate issuance and records the exact negative and
large-database recovery checks.

A Bridge release begins as an immutable draft candidate. The workflow requires
the exact five CLI archives, two native macOS GUI archives, one checksum file,
and three top-level license files. It verifies names, versions, archive layouts,
launchers, licenses, and checksums before upload, then downloads the candidate
and repeats the same verifier. Existing assets are never silently replaced.

## Dependencies

All modules. Verification uses public contracts and avoids reaching through
ownership boundaries solely to make tests easier.
