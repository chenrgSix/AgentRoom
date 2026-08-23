# Contracts Module

- Prefix: `CON`
- Planned location: `packages/contracts/`
- Owns: cross-language wire schemas and compatibility policy

## Purpose

Contracts provide one versioned language-neutral definition for data exchanged
between the TypeScript central service, browser, Go Bridge, MCP clients, and
test fixtures. JSON Schema is authoritative; generated TypeScript and Go types
are build artifacts.

## Responsibilities

- Define shared scalar formats for IDs, UTC timestamps, versions, and cursors.
- Define Bridge envelopes, commands, events, acknowledgments, and errors.
- Define public HTTP payloads reused by Web and MCP adapters.
- Publish deterministic TypeScript and Go type generation.
- Maintain golden fixtures for valid, invalid, old, and forward-compatible data.
- Document protocol-version negotiation and compatibility windows.

## Exclusions

- Business authorization belongs to Security.
- State transitions belong to the owning domain module.
- Persistence schemas are not wire schemas and belong to DATA.
- Generated types must not contain hand-written business logic.

## Contract Layout

```text
packages/contracts/
  catalog.json
  schemas/
    common/
    bridge/
    room/
    run/
    registry/
  fixtures/
  generated/typescript/
  generated/go/
  scripts/
  src/
  test/
```

`CON-001` established the catalog and validator, `CON-002` added common schemas
and fixtures, and `CON-003` added Bridge messages. `CON-004` checks in generated
TypeScript and Go types, rejects generation drift, and runs the same fixture
suite through Ajv and the Go Draft 2020-12 validator.

## Common Envelope

```json
{
  "protocolVersion": "1.0",
  "messageId": "msg_...",
  "timestamp": "2026-08-22T10:00:00Z",
  "type": "run.requested",
  "payload": {}
}
```

IDs are opaque strings with a lowercase type prefix such as `team_`, `agent_`,
or `run_`; the suffix carries no business meaning. Timestamps use RFC 3339 and
must be normalized to an uppercase `Z` UTC suffix. Protocol versions use
`major.minor` without a `v` prefix. Unknown message types are rejected by the
owning message schema. Unknown optional fields are ignored and preserved only
when the owning module explicitly supports round trips.

## Bridge Message Contract

`schemas/bridge/messages.schema.json` defines `bridge.hello`, heartbeat, Agent
publication/status, and the Run request, acceptance, status, reply, cancel, and
handoff messages. Payloads carry immutable entity IDs, and every Bridge Run
event starts with sequence 1. `run.cancel_requested` is the server-to-Bridge
interrupt command required by the documented cancellation flow.

`run.reply` has an additive optional `assessment` object for Discussion
evidence: goal satisfaction, confidence, question/evidence deltas,
disagreement, Reviewer approval, and a recommendation. Clients that omit the
field remain fully compatible and are evaluated as reply-only participants.

Every `run.requested` carries a stable `deliveryAttemptId` and
`idempotencyKey`, plus the central `traceId`. Retries preserve these fields so
the Bridge can compare the persisted payload hash and acknowledge without
starting a second Runtime. New Bridges echo `traceId` on Run events. It remains
optional on Bridge-to-server events within protocol 1.0 so released v0.1
Bridges remain compatible; when present, the server verifies it against the
authoritative Run.

## Versioning Rules

- Additive optional fields are backward compatible within a major version.
- Removing, renaming, or changing meaning requires a new major version.
- A Bridge declares its supported version range during `bridge.hello`.
- The server selects one mutually supported version or closes with a structured
  incompatibility error.
- Rolling upgrades must tolerate one previous minor version.
- Compatibility behavior requires fixtures and release notes.

## Error Envelope

Errors contain stable `code`, safe `message`, optional `details`, and
`retryable`. Messages never contain credentials, raw local paths, stack
traces, or internal database errors.

## Verification

- Validate every golden fixture against JSON Schema.
- Generate TypeScript and Go types twice and require no diff.
- Round-trip fixtures through both language validators.
- Reject malformed IDs, timestamps, envelopes, and incompatible versions.
- Fuzz Bridge envelope decoding at the trust boundary.

## Task Mapping

`CON-001` through `CON-004`, plus cross-language portions of `QA-001`.

## Dependencies

None. Every other module consumes these contracts.
