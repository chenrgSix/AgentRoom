# RUN-018 Frozen Capture Intent

Date: 2026-09-01

This increment adds only the frozen, path-safe capture intent needed by the
later production delivery adapter. The later
[capability readiness increment](brg-071-governed-capability-readiness.md) now
truthfully advertises `prepare` plus `capture`, but neither increment creates a
Run, starts a Runtime, reads a repository, publishes an Artifact, proposes a
Result or makes a workspace eligible for cleanup.

## Delivered boundary

- `execution-runtime.schema.json` accepts an optional digest-covered `capture`
  object with one stable operation identity, the approved root Task identity,
  and 1-32 bounded output descriptions.
- Output selectors carry either a portable repository-relative path or `null`;
  absolute paths, backslashes, commands, missing identities and empty output
  sets fail schema admission.
- Deterministic TypeScript, Go and standalone validators expose the same
  additive shape through the existing frozen Context Manifest. Older manifests
  remain structurally compatible and do not thereby gain capture capability.
- The shared valid manifest fixture includes the new intent and a recomputed
  canonical manifest digest, so later Bridge/Server tests consume exact bytes.

## Verification

- `npm test --workspace @convene-wire/contracts` originally passed all 79 Node contract
  checks, deterministic generation and strict TypeScript checks. Its embedded Go
  step was rerun with task-scoped `GOCACHE` because the macOS shared cache is not
  writable in this environment.
- `GOCACHE=/private/tmp/convenewire-go-cache-run018 go test ./generated/go/... ./test/go`
  passed from `packages/contracts`.
- `git diff --check` passed.

Production Bridge capture composition, finished-process fencing and canonical
checkpoint publication are now covered by
[BRG-071 governed capture evidence](brg-071-governed-capture-publication.md).
Server plan-to-manifest validation, exact summary matching, prompt scope
projection and the initial approved zero-input implementation delivery are now
covered by [RUN-018 governed delivery evidence](run-018-governed-capture-delivery.md).
Required predecessor input selection, owner cleanup and a real same-Run
Server/Go Bridge/Runtime acceptance remain explicit open gates. Full capability
publication is recorded separately in
[BRG-071 readiness evidence](brg-071-governed-capability-readiness.md).
