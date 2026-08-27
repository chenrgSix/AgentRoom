# Contributing

## Before Making Changes

Read the current architecture baseline and check the working tree before
editing. Keep unrelated user changes intact. Changes to trust boundaries,
wire protocols, persistence ownership, runtime lifecycle, or public APIs
require an ADR before implementation.

Do not copy Hermes Studio source, assets, schemas, or tests. Public behavior
and open standards may inform an independently designed implementation.

## Task Register

`docs/TASKS.md` is the only delivery checklist. Before implementation, select
an existing task whose dependencies are satisfied or add a new stable ID under
the owning module prefix. A change that starts or completes work updates the
task state in the same commit. `DONE` requires the listed completion evidence
and successful relevant checks.

If work changes module scope, ownership, public contracts, or acceptance
criteria, update the corresponding file in `docs/modules/`. Architectural
decisions that change trust, state authority, or protocol compatibility still
require an ADR.

## Repository Ownership

- `apps/server/`: Team state, Room APIs, MCP, routing, and Bridge connections.
- `apps/web/`: browser-only presentation and user interaction.
- `packages/contracts/`: authoritative JSON Schema for cross-language messages.
- `bridge/`: local runtime discovery, invocation, and server transport.
- `ops/agentroomctl/`: central-host release verification and lifecycle
  orchestration over the repository-owned Compose, backup, and restore paths.
- `tests/e2e/`: black-box scenarios spanning server and Bridge.

The complete ownership and dependency map is maintained in
`docs/modules/README.md`.

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

The central installation controller uses Go 1.26.7. From
`ops/agentroomctl/`, run `gofmt -w .`, `go test ./...`, `go vet ./...`, and
`go build ./cmd/agentroomctl`. Its tests do not start Docker or mutate a real
installation; live Compose and physical-host evidence remains in the OPS/QA
acceptance gates.
Use `scripts/package-central-release.sh` only with an exact `SOURCE_REF`, then
run `scripts/verify-central-release.sh` over all four supported archives and
their separately published internal-checksum pins.

## Pull Requests

Explain the problem, affected ownership boundary, compatibility impact,
security impact, and verification. Link the issue or ADR. Include screenshots
for Web UI changes and example payloads for protocol changes.

## Contribution Licensing

The repository is source-available under the AgentRoom Community License 1.0
and may also be offered under separate commercial terms. Issues and design
discussions are welcome. Before submitting code, documentation, or assets,
contact the maintainer: external contributions require an executed
[AgentRoom Contributor License Agreement](CONTRIBUTOR-LICENSE-AGREEMENT.md).
It grants the Project Owner the rights needed to publish contributions under
the community license, commercial licenses, and hosted AgentRoom offerings
while contributors retain ownership of their work. A pull request alone does
not execute the agreement.
