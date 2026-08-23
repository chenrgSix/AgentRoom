# QA-012 Room and Bridge UX Stabilization

## Result

- Date: 2026-08-24
- Result: **PASS**
- Scope commits: `02a8f99`, `f1c66bc`, and `77ac7a5`

This acceptance covers Room synchronization, safe failed-Run diagnostics, and
versioned Bridge Runtime presets with explicit local self-test. It does not
replace the two-physical-machine gate `QA-002` or credentialed live Runtime
execution.

## Behavior Evidence

- A 105-message Room opens on sequences 6 through 105. Its returned sync cursor
  fetches sequence 106 exactly once; cursor plus tail mode is rejected.
- Web synchronization de-duplicates cursor deltas, keeps the newest 500
  messages, uses a single in-flight poll, and never replaces the timeline with
  an older polling snapshot.
- Failed Run projection retains only error code, allowlisted category, exit
  code, and stderr-presence. Seeded stderr, local paths, messages, and unknown
  keys are absent from the browser model.
- Legacy Codex and Pi configurations migrate in memory to schema/preset version
  1. Pi's obsolete flags are replaced while names, roles, workspaces, trust,
  and environment allowlists remain unchanged; future versions fail closed.
- Runtime self-test is authenticated, manual-only, time-bounded, rejects active
  Team Runs and concurrent probes, forces Codex read-only, and retains Pi's
  no-tool preset. Success, failure, deadline, and secret-leakage tests pass.

## Verification

`npm run validate`, `npm run build`, `npm test`, `npm run test:e2e`, and
`npm run lint:docs` passed. Results include 90 Server tests, 11 Web tests, four
contract tests, seven schemas with 30 fixtures, and both deterministic E2E
flows; the opt-in live Codex/Pi E2E remained skipped.

From `bridge/`, `go test ./...`, `go vet ./...`, Desktop-tagged tests, and
Desktop-tagged vet passed. `git diff --check` passed before each code commit.
