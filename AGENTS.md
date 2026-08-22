# Repository Guidelines

## Project Structure & Module Organization

The implementation baseline is `agent_room_network_design_v0.2.md`;
`agent_room_network_design_v0.1.md` is immutable historical context. Repository
policy lives in `CONTRIBUTING.md`, and architecture decisions belong in
`docs/adr/`.

The planned modules are `apps/server/` for Team state, MCP, and routing;
`apps/web/` for the browser UI; `packages/contracts/` for authoritative JSON
Schema; `bridge/` for the Go runtime bridge; and `tests/e2e/` for black-box
scenarios. Do not scaffold a module before its milestone starts.

## Build, Test, and Development Commands

No application build exists yet. For documentation changes, run:

- `rg '^#' agent_room_network_design_v0.2.md` — review heading hierarchy.
- `npx markdownlint-cli2 "**/*.md"` — lint maintained Markdown.

When adding a module, document its build, run, format, and test commands here in
the same commit. Use `nvm use22` when Node 22 is not active.

## Coding Style & Naming Conventions

Follow `.editorconfig`. TypeScript uses strict mode and two spaces; Go uses
`gofmt`. Use PascalCase for domain types, camelCase for JSON fields,
lowercase dot-separated event names, and lowercase namespaced MCP tools.
JSON Schema is the cross-language wire source of truth.

## Testing Guidelines

Behavioral changes require focused regression tests. Protocol changes require
TypeScript and Go contract tests plus interoperability coverage. Routing tests
must cover offline, retry, duplicate, cancellation, and out-of-order events.
Security changes require a negative test.

## Commit & Pull Request Guidelines

Use short, imperative Conventional Commit subjects such as
`feat: route structured agent mentions`. Keep commits single-purpose and
never bypass hooks with `--no-verify`.

Pull requests state the problem, ownership boundary, compatibility and security
impact, and verification. Link the issue or ADR; include screenshots for UI
changes and example payloads for protocol changes.
