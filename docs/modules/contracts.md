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
  schemas/
    common/
    bridge/
    room/
    run/
    registry/
  fixtures/
  generated/typescript/
  generated/go/
```

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

IDs are opaque strings. Timestamps use RFC 3339 UTC. Unknown message types are
rejected. Unknown optional fields are ignored and preserved only when the
owning module explicitly supports round trips.

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
- Round-trip fixtures through both languages.
- Reject malformed IDs, timestamps, envelopes, and incompatible versions.
- Fuzz Bridge envelope decoding at the trust boundary.

## Task Mapping

`CON-001` through `CON-004`, plus cross-language portions of `QA-001`.

## Dependencies

None. Every other module consumes these contracts.
