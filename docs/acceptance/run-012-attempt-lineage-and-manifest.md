# RUN-012 attempt lineage and Context Manifest acceptance

Date: 2026-08-28

## Delivered boundary

Migration 0044 assigns every Run a positive Task-local `attemptNumber` and an
optional same-Task, same-Room, same-Agent `retryOfRunId`. Existing Runs receive
deterministic numbers ordered by creation time and opaque Run ID. A semantic
retry always creates a new Run, trigger Message, Delivery identity and Context
Manifest; an unaccepted Delivery retry continues to reuse its existing Run and
Delivery identities.

An `outcome_unknown` Run cannot be retried and its Task cannot become terminal
until the Task Owner or Team Owner records one reasoned acknowledgement. The
acknowledgement advances the Task revision, is immutable and idempotent by
operation ID, and does not rewrite the Run or claim whether an external side
effect happened. Retry admission rechecks Task lifecycle, scheduling, current
Agent assignment, comparable attempt budget and expected Task revision.

Each new Run captures one immutable Context Manifest after its existing context
fence. It records the frozen Task, definition and criteria revisions and
content, safe target identity and Workspace alias, source IDs/revisions,
closed permission summaries, and explicit omitted categories. It contains no
local path, command, environment value, provider credential/session ID, hidden
reasoning or tool payload. Values unavailable to the Server remain
`not_recorded`; the Server does not infer current local policy.

The Bridge message contract adds the Manifest as an optional rolling-compatible
`run.requested` field. Current managed Deliveries always carry the exact object
already stored against the Run. Current Bridges project its frozen goal,
criteria, permission summary and omission list into the Runtime request while
preserving local authority over filesystem, network and approval decisions.

## Recovery and compatibility evidence

The focused HTTP regression proves first-attempt identity, immutable reread
after Task definition/criteria edits, rejection before ambiguity
acknowledgement, acknowledgement response-loss replay, a new linked retry Run,
retry response-loss replay, and a retry Manifest frozen from the newer Task
revision. Migration regression proves the legacy upgrade through version 44,
deterministic attempt backfill, and the new tables,
columns, indexes and immutable triggers. Delivery regression compares the
wire Manifest object with the repository projection.

Legacy Runs retain deterministic attempt numbers and a missing Manifest rather
than invented historical context. The additive optional Bridge field preserves
old sender/receiver compatibility. No endpoint grants a Device or Agent the
human acknowledgement or retry authority.

## Verification

- `env GOCACHE=/private/tmp/agentroom-go-build npm test --workspace
  @agent-room/contracts` validates nine schemas, 98 golden fixtures,
  deterministic generated Go/TypeScript, strict TypeScript and Go fixtures.
- Focused Server tests cover Run attempts, Delivery payload equality, Bridge
  WebSocket compatibility, restart recovery and migration from version 43.
- `npm run build --workspace @agent-room/server` passes strict TypeScript.
- `npm test --workspace @agent-room/server` passes the full Server suite.
- `env GOCACHE=/private/tmp/agentroom-go-build go test ./...` from `bridge/`
  passes the full Go Bridge suite, including frozen Manifest prompt projection.
- `npm run lint:docs` passes the maintained Markdown corpus.

This closes RUN-012 only. Result persistence/review, Agent proposal transports,
Workbench/Task/Run/Result browser surfaces and QA-029 remain separate dependent
work with their own evidence.
