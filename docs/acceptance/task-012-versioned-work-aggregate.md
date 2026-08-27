# TASK-012 versioned Task work aggregate acceptance

Date: 2026-08-28

## Delivered boundary

Migration 0043 extends the existing `agent_tasks` aggregate in place. It keeps
all Task IDs and existing Message/Run/Discussion/Artifact/Memory bindings while
adding a human Owner, Team-local display number, authoritative lifecycle and
independent scheduling state, completion policy, priority/due date,
Task/definition/criteria revisions, budget policy/usage, and a future
completion-Result reference.

Definition and criteria history is append-only. Criteria edits append one full
ordered revision with stable criterion keys. Current non-default Product-Task
assignments are explicit, audited, Room-scoped, unique by Agent and limited to
one primary. Default Tasks intentionally retain Room-roster compatibility and
cannot be paused, completed, canceled, demoted, or deleted.

Definition, lifecycle, scheduling, block and block-resolution commands require
the Task Owner or Team Owner. New commands carry an operation ID and expected
Task revision; a repeated operation converges and a different stale operation
conflicts. Terminal transitions fence active Runs, Discussions and
clarifications. `accepted_result_required` cannot be completed through the
compatibility lifecycle endpoint.

Attention is a derived ordered set rather than a mutable badge. The implemented
sources cover open clarification, ambiguous Run outcome, explicit block,
overdue, paused scheduling, exhausted comparable budget and unavailable
assigned Runtime. Multiple reasons remain visible and the next action is
derived from the highest-priority source.

Run attempt count and terminal wall-clock duration are persisted in a Task
budget ledger by database triggers in the same transaction as Run insertion or
terminal state change. Provider tokens and cost remain explicitly unknown and
are not admission units.

## Migration and compatibility evidence

The focused migration test builds a real version-42 database, creates ready,
working, blocked and terminal-default legacy state, and then applies migration
0043. It proves deterministic lifecycle mapping, an explicit migrated block,
unique display numbers, preservation of the terminal default as ordinary
history, creation of one replacement active default, trigger-level default
protection, and one initial definition history row per Task.

The existing PATCH shape remains available for rolling clients but goes through
the same repository lifecycle and active-work fences. New routing rejects
draft, paused, budget-exhausted and terminal Tasks. Non-default Message Runs,
Discussion participants and handoff targets require explicit Task assignment;
the default Task continues to use the authorized Room roster.

## Verification

- `npx tsx --test apps/server/test/migration-runner.test.ts
  apps/server/test/task-work-aggregate.test.ts
  apps/server/test/run-service.test.ts` passes eight focused cases.
- `npm run build --workspace @agent-room/server` passes strict TypeScript build.
- `npm test --workspace @agent-room/server` passes 141 Server tests after the
  compatibility expectation is updated from old default `open` to its mapped
  `working` projection.
- `npm run lint:docs` passes the maintained Markdown corpus.

This closes TASK-012, not the whole ADR-0022 feature. RUN-012 must still store
frozen Context Manifests and explicit retry lineage; TASK-013 must add immutable
Result submission/review and accepted completion; MCP/Bridge/Web tasks must add
their authorized transports and user surfaces before QA-029 can close the
end-to-end work model.
