# Repository Guidelines

## Project Structure & Module Organization

The current implementation-ready architecture baseline is `agent_room_network_design_v0.2.md`; `agent_room_network_design_v0.1.md` is retained as historical context. Treat v0.2 as the source of truth for the central Web Team Hub, Remote MCP Server, lightweight Bridge, runtime-adapter, security, and MVP boundaries. Keep new architecture decisions in v0.2 or add focused ADRs under `docs/adr/` when implementation begins.

There is no application source tree yet. When adding code, group it by deployable responsibility rather than protocol vocabulary alone; suitable top-level modules include `coordinator/`, `gateway/`, `runtime-adapters/`, and `ui/`. Place tests beside their module or in a clearly mirrored `tests/` tree. Store diagrams and other documentation assets under `docs/assets/`.

## Build, Test, and Development Commands

No build system or automated test command is configured. For documentation changes, use lightweight checks:

- `rg '^#' agent_room_network_design_v0.2.md` — review heading hierarchy.
- `rg 'Room|MCP|Bridge|Runtime' agent_room_network_design_v0.2.md` — check terminology consistency.
- `npx markdownlint-cli2 '*.md'` — lint Markdown when Node.js and the package are available; use `nvm use22` if the local Node version is incompatible.

When introducing executable modules, add their canonical build, run, lint, and test commands to this file in the same change.

## Coding Style & Naming Conventions

Use UTF-8 Markdown, ATX headings, concise paragraphs, and fenced code blocks with language tags. Preserve the document's Chinese prose and established English domain terms. Use PascalCase for domain entities (`Agent`, `Task`, `Artifact`), camelCase for fields (`ownerMemberId`, `baseRevision`), lowercase dot-separated event names (`task.created`), and lowercase namespaced MCP operations (`room.publish_artifact`). Do not redefine terms that already have a documented contract.

## Testing Guidelines

Documentation changes require a rendered-preview check plus validation of headings, tables, links, and code blocks. Architecture changes must update the test matrix or acceptance criteria when behavior changes. Future implementation tests should cover the failure paths listed in section 21, especially offline recovery, duplicate events, approval ownership, path traversal, and artifact hash mismatch.

## Commit & Pull Request Guidelines

No Git history is available in this workspace, so no existing commit convention can be inferred. Use short, imperative, scope-focused subjects such as `docs: clarify gateway trust boundary`. Keep commits single-purpose and never bypass hooks with `--no-verify`.

Pull requests should state the problem, affected contracts, compatibility or security impact, and verification performed. Link the relevant issue or ADR. Include screenshots only for rendered-document or UI changes, and call out any departure from the clean-room strategy.
