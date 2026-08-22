# Contributing

## Before Making Changes

Read the current architecture baseline and check the working tree before
editing. Keep unrelated user changes intact. Changes to trust boundaries,
wire protocols, persistence ownership, runtime lifecycle, or public APIs
require an ADR before implementation.

Do not copy Hermes Studio source, assets, schemas, or tests. Public behavior
and open standards may inform an independently designed implementation.

## Repository Ownership

- `apps/server/`: Team state, Room APIs, MCP, routing, and Bridge connections.
- `apps/web/`: browser-only presentation and user interaction.
- `packages/contracts/`: authoritative JSON Schema for cross-language messages.
- `bridge/`: local runtime discovery, invocation, and server transport.
- `tests/e2e/`: black-box scenarios spanning server and Bridge.

The server owns Team, Room, Message, and Run state. The Bridge owns local
runtime process state. Do not duplicate either authority.

## Branches and Commits

Use branches such as `feat/mention-routing`, `fix/bridge-reconnect`, or
`docs/runtime-contract`. Commit one logical change at a time with an
imperative Conventional Commit subject:

```text
feat: route structured agent mentions
fix: deduplicate bridge run delivery
docs: record runtime session ownership
```

Never bypass hooks with `--no-verify`.

## Code and Contract Standards

- TypeScript uses strict mode, two-space indentation, and explicit boundary
  validation.
- Go uses `gofmt`, package names in lowercase, and errors with actionable
  context.
- Cross-language messages include `protocolVersion`, `messageId`, and
  `timestamp`.
- Generate language types from JSON Schema; do not maintain parallel handwritten
  wire models.
- New protocol fields are optional during rolling upgrades. Breaking changes
  require a protocol version and compatibility notes.
- Secrets, tokens, local paths, and raw credentials must not enter Room messages
  or logs.

## Testing

Every behavioral change needs a focused regression test. Protocol changes
require TypeScript and Go contract tests plus an interoperability scenario.
Routing and delivery changes must cover offline, retry, duplicate, cancellation,
and out-of-order events. Security-sensitive changes must include a negative test.

Before opening a pull request, run the relevant formatter, unit tests, contract
tests, and Markdown checks. Record commands and results in the PR description.

## Pull Requests

Explain the problem, affected ownership boundary, compatibility impact,
security impact, and verification. Link the issue or ADR. Include screenshots
for Web UI changes and example payloads for protocol changes.
