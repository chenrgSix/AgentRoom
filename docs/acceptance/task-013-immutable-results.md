# TASK-013 immutable Result acceptance

Date: 2026-08-28

## Delivered boundary

Migration 0045 adds immutable Task-local Result versions without fabricating
history for existing Tasks. Every proposal pins its operation ID, Task,
definition/criteria/proposal-time Task revisions, outcome, summary, risks,
questions, next actions, proposer and timestamp. A correction creates a new
version that supersedes one proposed or rejected Result; accepted Results and
all proposal content remain unchanged.

Sources are closed references to one exact Artifact, Run-event sequence,
Message, Room/Task Memory entry or Discussion in the same Task scope. Criterion
claims bind only criteria from the pinned immutable revision and only evidence
IDs in the same Result. The Result stores no copied Artifact bytes, Message
body, Memory body, Run output, Discussion output, path, credential or local
Runtime state.

Only an active/review Task accepts proposals. A human proposal requires the
Task Owner or Team Owner. Manual/managed Agent service calls bind the declared
actor kind to the current Agent integration mode, Team, assignment and exact
target Run, and require at least one persisted event from that Run. Discussion
Orchestration binds its own same-Task Discussion source. These proposal actors
receive no review or Task-completion method.

One Result accepts one append-only human `accepted` or `rejected` decision.
Accepting a stale Result is rejected. Accept-and-complete additionally fences
active Runs, Discussions and clarifications, unacknowledged ambiguous outcomes,
open blocks, permanent default Tasks, and non-completable outcomes. Every
required current criterion must have a satisfied claim linked to an existing
same-Task Artifact. The review, accepted Result state, completion Result ID,
Task lifecycle and one Task revision advance commit in one transaction.

An accepted Result next action creates one same-Room draft child Task under one
idempotent operation. Only the source Result ID and stable next-action key cross
that edge; criteria, assignments, evidence, acceptance and completion state are
not copied.

## Recovery and negative evidence

Focused HTTP/repository tests prove proposal response-loss replay, immutable
payload and review triggers, cross-Task Artifact rejection, definition/criteria
drift, typed five-kind source round-trip, correction supersession, Agent actor
mode/Run binding, review response-loss replay, exact accepted completion after
restart, and idempotent child provenance. A negative completion case proves a
satisfied text claim and Run event cannot substitute for required Artifact
evidence.

Legacy migration tests apply through version 45 without creating Result rows or
changing prior Task/Run identity. Database triggers reject mutation/deletion of
Result content, evidence, claims, decisions and child source edges, and reject
stale or invalid Task completion references even outside the HTTP service.

## Verification

- `npx tsx --test apps/server/test/migration-runner.test.ts
  apps/server/test/task-result-service.test.ts
  apps/server/test/task-work-aggregate.test.ts` passes 10 focused cases.
- `npm run build --workspace @agent-room/server` passes strict TypeScript.
- `npm test --workspace @agent-room/server` passes 145 Server tests.
- `npm run lint:docs` passes the maintained Markdown corpus.

This closes central TASK-013 only. `BRG-044` and `MCP-006` must expose the
managed/manual Agent proposal transports, `WEB-046`/`WEB-047` must expose the
authorized work surfaces, and QA-029 must prove the deterministic cross-process
and physical managed-Runtime path before the product loop is complete.
