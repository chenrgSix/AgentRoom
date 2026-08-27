# Repository Guidelines

## Project Structure & Module Organization

The implementation baseline is `agent_room_network_design_v0.2.md`;
`agent_room_network_design_v0.1.md` is immutable historical context. Repository
policy lives in `CONTRIBUTING.md`, and architecture decisions belong in
`docs/adr/`. Module boundaries live in `docs/modules/`, and delivery state is
tracked only in `docs/TASKS.md`.

The planned modules are `apps/server/` for Team state, MCP, and routing;
`apps/web/` for the browser UI; `packages/contracts/` for authoritative JSON
Schema; `bridge/` for the Go runtime bridge; and `tests/e2e/` for black-box
scenarios. Do not scaffold a module before its milestone starts.

## Task Register Workflow

Before implementation, select or add a stable task ID in `docs/TASKS.md` and
verify its dependencies. A commit that starts or completes work must update the
task state in the same commit. Mark work `DONE` only when its listed completion
evidence exists. Contract, scope, ownership, or acceptance changes also update
the owning file under `docs/modules/`. Never track delivery state in a second
checklist.

## Build, Test, and Development Commands

Node.js 22 and Go 1.26.7 are required. Repository commands are:

- `npm ci` — install locked workspace dependencies.
- `npm run validate` — validate all registered JSON Schemas.
- `npm run build` — build every implemented workspace.
- `npm test` — run implemented workspace tests.
- `npm run test:bridge-ui` — test the embedded Bridge GUI's pairing state projection.
- `npm run test:compose` — verify the default/custom central HTTPS ports and validate the Caddy configuration.
- `npm run test:e2e` — run deterministic cross-process acceptance tests.
- `npm run test:e2e:live` — explicitly invoke local Codex and Pi against an isolated temporary Team.
- `npm run db:migrate` — migrate the configured central SQLite database.
- `npm run dev:server` — run the Fastify API on port 3000.
- `npm run dev:web` — run the Vite browser UI with an API proxy.
- `go run ./cmd/agentroom-bridge console` from `bridge/` — run the token-authenticated local client setup UI.
- `go run ./cmd/agentroom-bridge artifact publish --config /path/bridge.json --agent Builder --run-id run_... --type patch --file change.patch --title "Verified patch" --summary "What changed"` from `bridge/` — publish one bounded Workspace-relative snapshot for an active assigned Run.
- `go build -tags desktop ./cmd/agentroom-bridge-desktop` from `bridge/` — build the native Wails Bridge GUI for the current platform.
- `go test -tags desktop ./cmd/agentroom-bridge-desktop` from `bridge/` — verify desktop-only state mapping and compile its native shell.
- `go test ./... && go vet ./... && go build ./cmd/agentroomctl` from `ops/agentroomctl/` — verify and build the central lifecycle controller.
- `RELEASE_TAG=v0.4.0-rc.1 SOURCE_REF=HEAD GOOS=linux GOARCH=amd64 ./scripts/package-central-release.sh` from `ops/agentroomctl/` — package one exact-commit, checksum-pinned Central archive.
- `RELEASE_TAG=v0.2.0-rc.3 GOOS=linux GOARCH=amd64 ./scripts/package-release.sh` from `bridge/` — build one portable Bridge archive.
- `RELEASE_TAG=v0.2.0-rc.3 GOARCH=arm64 ./scripts/package-desktop-darwin.sh` from `bridge/` — build one unsigned native macOS GUI archive.
- `pwsh -File ./scripts/package-desktop-windows.ps1 -ReleaseTag v0.2.0-rc.3 -GoArch amd64` from `bridge/` on native Windows with Inno Setup — build one unsigned Windows GUI archive and current-user installer.
- `pwsh -File ./scripts/verify-desktop-windows-installer.ps1 -ReleaseTag v0.2.0-rc.3 -InstallerPath /path/to/setup.exe` from `bridge/` on native Windows — smoke-test install, in-place upgrade, uninstall, and owner-state preservation.
- Dispatching the AgentRoom Release workflow for an empty draft Release builds and verifies five Bridge CLI archives, two macOS GUI archives, one Windows GUI archive, one Windows installer, four Central archives with separate internal-checksum pins, the outer checksums, and license assets.
- `docker compose up -d --build` — run the trusted-team Server and Caddy profile.
- `./scripts/compose-backup.sh` — create and copy a verified online SQLite backup.
- `./scripts/compose-restore.sh /absolute/backup.sqlite` — stage a verified restore under a new database name while Server is stopped.
- `npm run generate --workspace @agent-room/contracts` — regenerate wire types.
- `rg '^#' agent_room_network_design_v0.2.md` — review heading hierarchy.
- `npm run lint:docs` — lint maintained Markdown.
- `rg '^\| [A-Z]+-[0-9]+' docs/TASKS.md` — review registered task IDs.

When adding a module, document its build, run, format, and test commands here in
the same commit. Use `nvm use22` when Node 22 is not active. The contracts Go
module pins the selected Go toolchain.

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
