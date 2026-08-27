# QA-029 Result-gated Completion and Recovery Acceptance

## Result

- Date: 2026-08-28
- Result: **PASS**
- Scope: deterministic local Server, SQLite, HTTP/MCP, paired Go Bridge and
  physical managed Runtime process

This acceptance closes the P19 release gate for Task-, Run- and Result-led
work. It proves the bounded product loop from old-client quick work through
formal evidence-gated completion without treating a Message, Run reply,
Workbench projection or Result proposal as completion authority.

This is not production admission, a two-physical-machine result, a credentialed
Codex/Pi provider run, or evidence for network/firewall, installer, signing or
notarization behavior. The physical Runtime gate uses an isolated real local
process behind a separately paired real Go Bridge; it is not the Fake Runtime.

## Committed Matrix

| Boundary | Committed evidence | Result |
| --- | --- | --- |
| migration and default compatibility | the migration regression preserves legacy Task/Run identity, maps legacy states, keeps historical terminal Tasks without synthetic Results, allocates a replacement permanent default Task and rejects its terminal mutation; paired-Bridge E2E omits `taskId` and asserts routing to that default | pass |
| definition, criteria and ownership | Task aggregate tests preserve immutable definition/criteria revisions, reject stale and unauthorized commands, enforce scheduling and completion policy, and reopen the stored revision history | pass |
| Agent assignment | formal Task routing rejects an unassigned managed Agent in paired-Bridge E2E; MCP and managed proposal tests also bind current integration mode, Room, assignment, exact Run and one persisted own-Run event | pass |
| simultaneous attention | Workbench integration derives `blocked` and `paused` together, preserves their precedence, filters only authorized Rooms and rebuilds the byte-equivalent projection after reopening SQLite | pass |
| retry and ambiguity | Run integration retains one Delivery retry, blocks semantic retry and terminal Task state for unacknowledged `outcome_unknown`, idempotently records the human acknowledgement, creates a new linked Run/trigger/Delivery identity and freezes a new manifest from the current revision | pass |
| frozen Context Manifest | the original Run manifest remains unchanged after definition/criteria edits and restart-oriented repository reads; closed omissions exclude local paths, commands, environment values, credentials, provider sessions, hidden reasoning and tool payloads | pass |
| manual Agent proposal | deterministic three-Agent MCP E2E completes a guarded handoff, explicitly proposes and exactly replays one immutable manual-Agent Result from the assigned root Run | pass |
| Result correction and review | Result integration preserves five typed source kinds, immutable superseded versions, append-only review, child provenance and stale-definition rejection; a concurrent accept-and-complete versus definition edit permits exactly one revision-consistent winner and reopens to the same state | pass |
| required evidence and response loss | a satisfied text claim or Run event cannot substitute for same-Task Artifact evidence; exact proposal and accept-and-complete operation replay return the original Result, decision and completed Task | pass |
| managed physical loop | each reasoning-policy variant starts a real Server, paired Go Bridge and local managed Runtime, routes an assigned formal Task, publishes a verified patch through the Artifact CLI, proposes it through the Device-authenticated Result CLI, cancels active work, then accepts and completes exactly once | pass |
| authorized product surfaces | WEB-046/047 Server, component and isolated 1280/390 px browser acceptance expose Work, Task, frozen Run and immutable Result state with keyboard access, stale-CAS recovery, no horizontal page overflow and no copied Result body or local detail in Room Chat | pass |

## Recovery and Authority Observations

The review-versus-definition test sends both commands from the same Task
revision. SQLite serialization is not itself the assertion: the test requires
one `200`, one stale/terminal rejection, then closes and reopens the Server and
compares the authoritative Task and Result projections. The winning review may
atomically accept and complete, or the winning definition edit may leave the
old Result proposed and stale; no mixed state is accepted.

The managed E2E keeps three authorities separate. The Runtime process produces
work, the paired Bridge publishes the bounded Artifact and Result proposal, and
only the human Web principal reviews and completes the Task after active work
ends. Replaying the exact proposal and review operation models loss of either
success response and creates no second Result, decision or Task revision.

Room system summaries contain only the Result version/state, opaque Task link
and optional completion fact. They do not copy Result content, review reasons,
Runtime output, Artifact bytes, credentials or local paths.

## Verification

- `npm run validate` passes deterministic generation and validation for 9
  JSON Schemas and 98 positive/negative fixtures plus generated Go checks.
- `npm test` passes 148 Server, 60 Web, 4 Contracts and 26 embedded Bridge UI
  checks, with strict TypeScript included by the workspaces.
- `npm run test:e2e` passes four deterministic scenarios, including manual MCP
  Result proposal and two paired-Bridge managed Result policy variants; the
  explicitly opt-in credentialed Codex/Pi scenario remains skipped.
- `go test ./...` and `go vet ./...` pass the complete Bridge module.
- `npm run build`, `npm run test:compose`, `npm run lint:docs` and
  `git diff --check` pass.
