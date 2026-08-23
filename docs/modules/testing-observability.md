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

The `QA-001` integration test exercises one authenticated user, one Team and
Room, two Fake Agents, stable-ID mentions, ordered Run events, Agent replies,
and SQLite reload through the public HTTP API. It is the central MVP gate; it
does not claim production Bridge, WebSocket, or browser automation coverage.

`QA-006` starts a real TCP server, builds and pairs the Go Bridge, publishes a
managed Generic CLI Agent, sends a structured Mention through the Web API, and
asserts the durable terminal Run and Agent reply. It proves the local
cross-process transport while keeping physical two-machine Codex acceptance as
a separate release check.

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
conclusion through the public HTTP API. `QA-007` remains the release-level live
Codex-Pi acceptance gate rather than being inferred from adapter tests.

## Required Scenarios

The release suite covers offline queueing, ACK loss, duplicate delivery,
out-of-order events, cancellation races, restart recovery, capability
downgrade, sensitive-output filtering, and the three-member handoff journey
defined by the architecture baseline. Discussion scenarios additionally cover
useful continuation, low-value repetition, unresolved high-priority issues,
missing usage telemetry, and optional Reviewer policies.

## Observability Contract

One `traceId` follows Message, Run, delivery, Bridge, and Runtime events.
Structured logs include stable identifiers, state transitions, latency, and
error codes but exclude secrets and full prompts. Metrics cover connection
health, queue depth, delivery age, retries, Run outcomes, and event lag.

Health endpoints distinguish process liveness, dependency readiness, and
degraded optional capabilities. Audit records are durable and access-controlled.

## Release Evidence

A task is `DONE` only when its completion evidence in `docs/TASKS.md` exists.
Release notes name migrations, compatibility changes, security impact, and the
exact checks run. Work is tracked by `QA-001` through `QA-007` and `OPS-001`
through `OPS-002`.

## Dependencies

All modules. Verification uses public contracts and avoids reaching through
ownership boundaries solely to make tests easier.
