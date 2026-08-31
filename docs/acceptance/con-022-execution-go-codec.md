# CON-022: Exact Go Execution Wire Codec

Date: 2026-09-01. Scope: the Go codec prerequisite for governed repository
publication under ADR-0036. Delivery state remains in `docs/TASKS.md`.

## Failure and Repair

Generated `time.Time` fields changed valid `.000Z` execution timestamps to `Z`
when marshaled. Those strings name the same time, but the frozen manifest and
operation digests bind their exact JSON values. A valid Server manifest could
therefore fail its digest after a Go typed round trip.

Code generation now preserves date-time strings throughout the standalone Go
execution types and the nested Bridge execution subtree. Ordinary Bridge
envelope/context timestamps keep their existing Go types. JSON shapes, UTC
format validation and protocol version are unchanged; consumers of the new Go
execution types must explicitly parse strings when comparing times.

A generated offline Go runtime bundle validates the nine execution-runtime
shapes before typed decoding. Its canonical encoder preserves strings and JSON
escaping, sorts keys by UTF-16 units and normalizes exact safe integers without
float rounding. It rejects duplicate/case-aliased/unknown properties through
raw and schema validation, malformed Unicode and bounded-resource violations.
Raw and canonical output each have a 512-KiB ceiling; compact exponent notation
cannot expand past that ceiling. Shared Bridge raw parser limits remain in
force as documented by the Contracts module.

## Verification

Commands ran on macOS arm64, Node 22.23.1 and Go 1.26.7, with task-owned
temporary and Go cache directories. No live business repository was used.

```sh
npm run generate --workspace @convene-wire/contracts
npm test --workspace @convene-wire/contracts
npm run validate
npm run build
npm test
npm run test:e2e
```

From `packages/contracts/`:

```sh
go test -race ./test/go
go vet ./generated/go/... ./test/go
```

From `bridge/`:

```sh
go test -json ./...
go vet ./...
```

Observed results:

- 78 Node contract tests, all Go contract tests, generation drift and strict
  TypeScript checks pass; 11 registered schemas and 232 schema fixtures pass.
- Six shared Node/Go canonical byte/digest cases cover numeric normalization,
  safe integer bounds, UTF-16 key ordering, literal versus escaped Unicode,
  fractional UTC precision and a schema-valid frozen manifest. The latter also
  proves its Node-generated manifest digest survives Go typed decoding/marshal.
- The new standalone Go validator checks 28 existing runtime fixtures: 15 valid
  and 13 invalid. Additional raw negatives cover duplicate/escaped duplicate
  keys, case aliases, unknown properties/kinds, unsafe/lossy numbers, invalid
  Unicode, excessive depth and raw/canonical byte limits.
- Four typed fractional-UTC regressions cover governed Bridge delivery,
  standalone manifest, capture operation and checkpoint. The numeric boundary
  test accepts an exactly 512-KiB canonical string and rejects short numbers
  whose canonical expansion would exceed that limit.
- Root tests pass: 460 Server, 252 Web, 78 Contracts, 56 embedded Bridge UI,
  45 QA evidence, two product-experience fixture and 15 website tests.
- All 317 top-level Go Bridge tests across 24 tested packages pass, as do Bridge
  and Contracts vet and the Go contract race suite. All workspace builds pass;
  the existing Web chunk-size warning is not changed by this codec repair.
- Seven deterministic cross-process E2Es pass. The opt-in live Codex/Pi case
  remains explicitly skipped. These are compatibility E2Es, not governed
  execution acceptance.
- The Bridge CLI builds natively and cross-compiles for Windows/Linux amd64.
  Cross-compilation is not native Windows/Linux execution evidence. All 300
  maintained Markdown files lint cleanly and `git diff --check` passes.

## Direction and Limits

Schema validity and matching digest do not establish current authority, actual
Git provenance, Runtime execution or trusted verification. The Go capture-to-
publication adapter, local grants, scheduler, verification and full product
acceptance remain separate required work. Existing governed Run rejection stays
in force. No provider invocation, deployment, Release or external Git write was
performed by this change.
