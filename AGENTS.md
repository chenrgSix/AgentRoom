# Repository Guidelines

## Project Structure & Module Organization

The implementation baseline is `convenewire_network_design_v0.2.md`;
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
- `npm run build:site` — build the credential-free product website for the `/ConveneWire/` GitHub Pages base.
- `npm run test:site` — verify static routes, metadata, capability boundaries, copy controls and isolated preview responses with Node.js only.
- `npm run preview:site` — build and serve the product website on a printed loopback-only URL.
- `git diff --check -- site` — check the website's `.editorconfig`-aligned HTML/CSS/JavaScript edits for whitespace errors; no generated `site/dist/` files are committed.
- `npm test` — run implemented workspace tests.
- `npm run test:bridge-ui` — test the embedded Bridge GUI's pairing state projection.
- `npm run test:qa-evidence` — test the sanitized two-machine acceptance evidence verifier.
- `npm run test:product-experience` — verify disposable local/trusted product acceptance fixtures with real sealed evidence.
- `CONVENE_WIRE_PRODUCT_PREVIEW=1 npm run preview:product-experience` — serve the built Web UI on two isolated loopback QA servers, with synthetic model responses and temporary data removed on shutdown; never use for deployment.
- `npm run capture:qa-002 -- --input /path/input.json --database /path/agent-room.sqlite --metrics /path/metrics.txt --bridge-installer /path/convenewire-bridge-desktop_VERSION_windows_amd64_setup.exe --bridge-desktop-archive /path/convenewire-bridge-desktop_VERSION_windows_amd64.zip --release-checksums /path/SHA256SUMS --output /path/evidence.md` — compute both Windows candidate digests, safely bind the packaged executable and authenticated Bridge/Central build observations to one reviewed two-machine record, and render no secrets or local paths.
- `npm run test:compose` — verify the default/custom central HTTPS ports and validate the Caddy configuration.
- `npm run test:e2e` — run deterministic cross-process acceptance tests.
- `npm run test:e2e:live` — explicitly invoke local Codex and Pi against an isolated temporary Team.
- `npm run db:migrate` — migrate the configured central SQLite database.
- `npm run dev:server` — run the Fastify API on port 3000.
- `npm run dev:web` — run the Vite browser UI with an API proxy.
- `go run ./cmd/convenewire-bridge console` from `bridge/` — run the token-authenticated local client setup UI.
- `go run ./cmd/convenewire-bridge artifact publish --config /path/bridge.json --agent Builder --run-id run_... --type patch --file change.patch --title "Verified patch" --summary "What changed"` from `bridge/` — publish one bounded Workspace-relative snapshot for an active assigned Run.
- `go run ./cmd/convenewire-bridge result propose --help` from `bridge/` — submit one inline, contract-valid immutable Result for a configured Agent and exact assigned Run; the command never accepts a proposal file or review/completion action.
- `go run ./cmd/convenewire-bridge repository bind --config /path/bridge.json --binding-id repobind_example001 --repository-id repo_example001 --alias Project --workspace /absolute/repository --allowed-root /absolute/repository --confirm` from `bridge/` — explicitly register one owner-selected local Git checkout; this grants no Runtime, Task, verification, integration or remote authority.
- `go run ./cmd/convenewire-bridge repository list --config /path/bridge.json` and `go run ./cmd/convenewire-bridge repository revoke --config /path/bridge.json --binding-id repobind_example001 --expected-revision 1 --confirm` from `bridge/` — inspect path-free local registration receipts or retain an irreversible revocation; standalone commands require the Bridge/Console owner lock to be available and never remove Git data.
- `go build -tags desktop ./cmd/convenewire-bridge-desktop` from `bridge/` — build the native Wails Bridge GUI for the current platform.
- `go test -tags desktop ./cmd/convenewire-bridge-desktop` from `bridge/` — verify desktop-only state mapping and compile its native shell.
- `go run -gcflags=github.com/srwiley/rasterx=-d=fmahash=qn . -root ../../.. -mode generate` from `bridge/tools/windows-resources/` — regenerate the checked-in Windows PNG, multi-size ICO and amd64 resource object from the product SVG using pinned non-fused arithmetic.
- `go test -gcflags=github.com/srwiley/rasterx=-d=fmahash=qn ./... && go vet ./... && go run -gcflags=github.com/srwiley/rasterx=-d=fmahash=qn . -root ../../.. -mode check` from `bridge/tools/windows-resources/` — verify the isolated icon tool and deterministic generated resources; format its Go source with `gofmt -w *.go`.
- `go run -gcflags=github.com/srwiley/rasterx=-d=fmahash=qn . -root ../../.. -mode verify -exe /absolute/path/to/ConveneWire-Bridge.exe` from `bridge/tools/windows-resources/` — inspect the actual Windows PE icon group and image resources rather than a generic Shell fallback.
- `go test ./... && go vet ./... && go build ./cmd/convenewirectl` from `ops/convenewirectl/` — verify and build the central lifecycle controller.
- `convenewirectl trust-rotation prepare --data-root /path --overlap 24h` followed by `convenewirectl trust-rotation activate --data-root /path` — stage an authenticated two-CA Bridge overlap, wait for every eligible Device acknowledgement, and switch the private Caddy authority with rollback-safe readiness.
- `convenewirectl migrate-public-ca --data-root /path` — explicitly relabel only a legacy direct-HTTPS installation whose existing origin passes system-only public-CA readiness before and after migration.
- `convenewirectl migrate-private-hostname --data-root /path --hostname central.local` — move one ready scoped-private literal-IP Central to a stable private hostname while preserving its CA, installation identity, data and Device credentials through rollback-safe exact-host readiness.
- `RELEASE_TAG=v0.4.0-rc.1 SOURCE_REF=HEAD GOARCH=amd64 ./scripts/build-central-image.sh` from `ops/convenewirectl/` — build the once-per-architecture Server+Caddy OCI bundle with SPDX SBOMs and SLSA provenance.
- `RELEASE_TAG=v0.4.0-rc.1 SOURCE_REF=HEAD GOARCH=amd64 CENTRAL_IMAGE_BUNDLE_DIR=/path/to/image-bundle ./scripts/verify-central-image-docker.sh` from `ops/convenewirectl/` — prove a clean Docker daemon can load the final multi-image OCI archive and execute both exact digest references without pulling or building.
- `RELEASE_TAG=v0.4.0-rc.1 SOURCE_REF=HEAD GOOS=linux GOARCH=amd64 CENTRAL_IMAGE_BUNDLE_DIR=/path/to/image-bundle ./scripts/package-central-release.sh` from `ops/convenewirectl/` — embed one verified once-built OCI bundle in an exact-commit, checksum-pinned Central archive; set `CENTRAL_RELEASE_SCHEMA=1` only for the legacy source-build compatibility gate.
- `RELEASE_TAG=v0.2.0-rc.3 GOOS=linux GOARCH=amd64 ./scripts/package-release.sh` from `bridge/` — build one portable Bridge archive.
- `RELEASE_TAG=v0.2.0-rc.3 GOARCH=arm64 ./scripts/package-desktop-darwin.sh` from `bridge/` — build one unsigned native macOS GUI archive.
- `pwsh -File ./scripts/package-desktop-windows.ps1 -ReleaseTag v0.2.0-rc.3 -GoArch amd64` from `bridge/` on native Windows with Inno Setup — build one unsigned Windows GUI archive and current-user installer.
- `pwsh -File ./scripts/verify-desktop-windows-installer.ps1 -PreviousReleaseTag v0.4.0 -PreviousInstallerPath /path/to/previous_setup.exe -ReleaseTag v0.4.1-rc.1 -CandidateArchivePath /path/to/candidate.zip -CandidateExecutablePath '/path/to/ConveneWire Bridge.exe' -InstallerPath /path/to/candidate_setup.exe` from `bridge/` on native Windows — install the previous stable package, preserve representative owner state through the strictly newer candidate in-place upgrade, then verify uninstall ownership.
- Dispatching the ConveneWire Release workflow for an empty draft Release builds and verifies five Bridge CLI archives, two macOS GUI archives, one Windows GUI archive, one Windows installer, two once-built Central OCI bundles embedded across four Central archives with separate internal-checksum pins, the outer checksums, and license assets.
- `docker compose up -d --build` — run the trusted-team Server and Caddy profile.
- `./scripts/compose-backup.sh` — create and copy a verified online SQLite backup.
- `./scripts/compose-restore.sh /absolute/backup.sqlite` — stage a verified restore under a new database name while Server is stopped.
- `npm run generate --workspace @convene-wire/contracts` — regenerate wire types.
- `rg '^#' convenewire_network_design_v0.2.md` — review heading hierarchy.
- `npm run lint:docs` — lint maintained Markdown.
- `rg '^\| [A-Z]+-[0-9]+' docs/TASKS.md` — review registered task IDs.

When adding a module, document its build, run, format, and test commands here in
the same commit. Use `nvm use22` when Node 22 is not active. The contracts Go
module pins the selected Go toolchain.

Governed Execution, Repository and Verification modules use the existing
`npm run dev:server`, `npm run build --workspace @convene-wire/server`,
`npm run test --workspace @convene-wire/server` and `npm run test:e2e`
commands. Bridge repository operations use `gofmt`, `go test ./...` and
`go vet ./...` from `bridge/`; concurrency-sensitive packages also require
`go test -race`. These modules follow ADR-0036 and must not advertise unfinished
capabilities or treat generated contracts as runtime acceptance.

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
