# QA-019 Rolling Room Context and Memory Review Acceptance

## Result

- Date: 2026-08-25
- Result: **PASS**
- Scope: `TASK-007`, `CON-009`, `ADP-013`, `TASK-008`, `TASK-009`, and
  `WEB-039`

This acceptance closes the local deterministic implementation scope for
versioned Room context coverage, rolling checkpoints, and Member-reviewed
long-term Memory candidates. It does not claim credentialed Runtime operation,
semantic summarizer quality, a production deployment, or release admission.

## Checkpoint and Recovery Evidence

Server regressions create a 40-Message Room and drain it through contiguous
`1..32` and `33..40` incremental checkpoints. They then rebase `1..45`, leave a
lease as if a worker crashed, advance the clock beyond lease expiry, and prove
that another sweep commits Message 46 without cursor regression. Reducer input
is byte/message bounded and redacted before the configured runner is called.
Candidate rejection is isolated after checkpoint commit.

Repository tests additionally prove desired-watermark persistence, generation
compare-and-swap, stale worker rejection, checkpoint immutability, historical
checkpoint selection, restart recovery, and monotonic cursors. Migration tests
prove existing Rooms start disabled with no fabricated checkpoint and legacy
Runs receive explicit historical fences.

## Context Coverage and Provider Evidence

Context-planner tests select only checkpoint, Room/Task Memory, Task state, and
Artifacts available at the Run's captured fence. Delivery tests reject a
Bridge receipt whose checkpoint or interval differs from the durable Delivery.

Bridge tests prove exact `started`, `resumed`, and `recreated` interval
selection, including a resumed long-idle Session whose cursor predates the
available raw tail and therefore receives the checkpoint replacement. Gap,
overlap, truncation, byte-count, trigger duplication, and future checkpoint
inputs fail before Runtime invocation. Codex persists coverage after provider
acceptance, including an accepted-turn timeout; Pi's ambiguous timeout does not
advance its coverage cursor.

## Candidate Review and Browser Evidence

Migration 0034 and Server tests prove stable source-fingerprint deduplication,
independent Room/Task/type/provenance validation, redaction, Member-only access,
one-way review state, and atomic promotion through the same
`LongTermMemoryService` used for manual Memory writes. Acceptance retries return
the same Memory ID. Rejection remains durable and cannot roll back a committed
checkpoint.

The Web component suite proves provenance display and post-review convergence.
A real local browser acceptance used a configured candidate-producing runner,
created a Room Message, observed two explicitly non-authoritative candidates,
expanded their Message/checkpoint provenance, accepted one, rejected the other,
and observed the pending surface disappear. At a `390 x 844` viewport both
cards were 336 pixels wide within a 366-pixel review surface, actions remained
two columns, and the document had no horizontal overflow.

## Quality Boundary

Checkpoint interval correctness and semantic quality are separate gates. A
fixed evaluator records claim recall, forbidden-claim count, and provenance
recall without changing checkpoint readiness. Its adversarial regression
deliberately produces `claimRecall: 0`, `falseClaimCount: 0`, and
`provenanceRecall: 1` while the contiguous checkpoint remains ready. The
shipped `extractive-v1` runner is explicit opt-in through
`AGENT_ROOM_MEMORY_REDUCER=extractive-v1`; it is bounded and produces no
automatic candidates. A future semantic runner must pass its own fixed quality
thresholds through the same runner port.

## Full Gates

- `GOCACHE=/private/tmp/agentroom-go-cache npm test` passed all 119 Server, 23
  Web, 4 contract-generation/schema-fixture Node tests, generated type checks,
  and Go contract tests.
- `GOCACHE=/private/tmp/agentroom-go-cache npm run test:e2e` passed the guarded
  three-Agent handoff and paired real Go Bridge/Pi protocol scenarios. The
  credentialed Codex/Pi scenario was explicitly skipped as designed.
- `GOCACHE=/private/tmp/agentroom-go-cache go test ./...` passed all ordinary
  Bridge packages. The desktop-tagged package passed with only the existing
  macOS deployment-target linker warnings.
- Race-detector tests passed for Runtime, Delivery, and Connection; `go vet
  ./...` passed.
- `npm run validate` validated 7 schemas and 46 fixtures. `npm run build` and
  `npm run lint:docs` passed with generated TypeScript and Go contracts current.

The first unqualified root/E2E invocations reached successful Node assertions
but could not initialize Go's user cache under the managed filesystem. The
same gates were rerun with an isolated temporary `GOCACHE` and exited
successfully; this was an execution-environment constraint, not a product-code
retry or relaxed assertion.

## Remaining Physical Gates

`npm run test:e2e:live` remains operator-controlled because it invokes real
credentialed Codex and Pi installations. Production semantic-reducer selection,
quality thresholds and evaluation corpus, capacity/retention tuning, release
packaging, and deployment admission remain separate work. No production-ready
or credentialed-provider claim is implied by this acceptance.
