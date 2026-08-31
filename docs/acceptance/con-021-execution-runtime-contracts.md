# CON-021: Governed Execution Runtime Contracts

Date: 2026-08-31. Scope: the additive execution wire boundary in ADR-0036,
including compatibility prerequisites. Delivery state remains in `docs/TASKS.md`.

## Delivered Boundary

The registered `work/execution-runtime.schema.json` defines version-1 manifests,
input bindings, capabilities, repository bindings, grant summaries, six closed
repository operations, operation receipts, checkpoints and verification receipts.
TypeScript and Go types plus executable validators are generated from that
schema. The existing Run Context Manifest carries one optional `execution`
snapshot; ordinary Run identity and delivery remain authoritative.

Operation payloads are discriminated nested objects. This resolves a generated
Go round-trip failure where flattened union variants emitted unrelated nullable
properties. Required nullable pins remain present inside their own variant;
exact comparison checks all six typed request round trips and governed wire
decoding/re-encoding, rather than accepting a merely schema-valid lossy result.

Authenticated hello capability metadata is bound to the current connection
epoch and copied on input/output. Transport requires prepare and capture for a
governed Run; observing-only or legacy connections do not receive it. Invalid
versions, unenforced workspace claims and malformed declarations cannot replace
the active connection. Current production Bridges advertise no governed
execution capability. Their handler rejects governed manifests before inbox
acceptance and direct Runtime execution also rejects them before invocation.
Later local admission work must replace these prerequisites, not remove them
without implementing the actual grant/preparation checks.

Both raw Bridge decoders now reject duplicate decoded object keys, including
escaped and astral equivalents and opaque extensions. This fixes last-wins
ambiguity before a grant/generation field can be overwritten. Separate objects
may still use identical keys. Existing unambiguous protocol-1.0 frames preserve
their shape and semantics; ambiguous frames receive the normal stable schema
rejection without payload disclosure.

## Verification

Commands ran on macOS arm64 with Node 22.23.1 and Go 1.26.7. Test-owned temporary
and Go cache directories isolated generated fixtures from user repositories.

```sh
npm run validate
npm run build
npm test
npm run test:e2e
npm run test --workspace @convene-wire/contracts
node --import tsx --test --test-reporter=spec --test-concurrency=2 \
  apps/server/test/bridge-connection-registry.test.ts \
  apps/server/test/bridge-websocket.test.ts
```

From `bridge/`:

```sh
go test ./...
go vet ./...
go test -race ./internal/delivery ./internal/connection
```

Observed results:

- 11 registered schemas and 232 schema fixtures pass: 99 valid, 133 invalid.
  The new runtime corpus contributes 31 cases, including 17 valid and 14 invalid.
- The contracts suite passes 72 Node tests, current-generation checks, strict
  TypeScript checks and all Go contract tests. The shared admission port covers
  every new runtime shape, with 24 isolated command/cross-kind injection mutations
  derived from six valid operation requests.
- 32 exact generated execution-type round trips pass. Actual TS and Go Bridge
  decoders accept/re-encode governed Run and capability hello fixtures and reject
  unknown versions, noncanonical fields, unsafe integers, injected commands and
  duplicate generations.
- Both languages exercise 57 shared raw-wire fixtures, including eight new
  duplicate/escaped-key and noncollision cases. The other exact-number, Unicode,
  resource-limit and closed-envelope cases remain passing.
- 36 focused Server registry/WebSocket tests pass. Actual authenticated sockets
  reject malformed/unknown execution capabilities without replacing a live
  epoch; capable and later legacy reconnects succeed. Registry tests additionally
  reject unsupported transport and prove metadata cannot be mutated by alias.
- Root `npm test` passes all implemented workspace suites, Bridge UI, QA evidence,
  product-experience fixtures and website checks. Go tests/vet and focused race
  tests pass. All workspace builds pass; the existing Web 639.60-kB chunk warning
  remains unchanged.
- Seven deterministic cross-process E2Es pass, including actual Go Bridges,
  Artifact handoff recovery, managed Results, pairing, Remote MCP and Hosted HTTP.
  The opt-in live Codex/Pi test is explicitly skipped, not a live-provider pass.
- The pre-CON-021 embedded Bridge schema at commit `458b5a9` was compiled against
  the new governed Run fixture and its ordinary copy: it accepts the ordinary
  copy and rejects the unknown execution manifest. This is a legacy schema check,
  not acceptance of a previously packaged physical Bridge.
- Maintained Markdown lint and `git diff --check` pass.

## Direction and Remaining Gates

These checks prove structural contracts, exact serialization and compatibility
prerequisites. They do not prove that an enrolled verifier executed a command,
that a grant is current, or that input/digest/scope relationships are valid.
Those domain checks remain owned by EXEC-003, WSP-003, REPO-001, BRG-071,
RUN-018, EXEC-004 and VER-001. No repository registration, coding worktree,
governed scheduler, merge, PR or deployment is enabled by this change.

Approval and ordinary Result acceptance remain human-owned; uploaded claims
cannot mint verifier authority. Final product acceptance still requires the
three cumulative increments and QA-052 through QA-055, including actual governed
Git/Runtime/verifier and browser flows. Native Windows, live remote providers,
packaged upgrades and release publication were not performed here.
