# RUN-014 transactional Run projection acceptance

- Date: 2026-08-29
- Scope: deterministic local implementation evidence
- Result: PASS

## Boundaries under test

A browser Member Message with structured Agent Mentions must not become durable
without its complete Run batch. An applied managed, manual or in-process reply
event must not become durable without its single Agent-authored Room Message and
an exact mapping between those identities.

Migration compatibility may repair historical partial rows, but it may not
invent a new deadline, execute stale work, choose between ambiguous history or
duplicate an already projected reply. Managed cancellation delivery is owned by
`CON-016` and is not claimed by this result.

## Implementation evidence

- `MemberMessageRunService` joins Message/Mention persistence and mentioned Run
  creation under the shared immediate transaction. A stable
  `clientMessageId` retry returns the same Message and Runs, including repair of
  a historical Message that lacks its Run batch.
- `RunRepository.applyReply` owns the sequenced reply event, handoff-routing
  intent, Room sequence allocation, Agent Message and immutable projection row
  in one immediate transaction. Bridge, manual MCP and in-process Runtime paths
  no longer append that Message outside the repository boundary.
- Migration 0049 adds a unique `(run_id, reply_sequence) → message_id` mapping,
  a mutually exclusive unreconciled-failure table, scan indexes and triggers
  that validate exact event/Run/Message scope and freeze reconciled identity.
- Startup reconciliation uses the original Member Message time. Fresh work
  retains its original deadline; stale work is materialized only as an expired
  Run at that deadline. Current Task/Member/Agent constraints fence fresh work.
- Historical replies match exact trace, Room, nullable Task, Agent, parent,
  content and timestamp. Zero matches creates one missing Message; exactly one
  match records the mapping; ambiguity or drift records a closed failure.

## Negative regressions

- an injected Run insert failure leaves no Message, Mention, Room sequence or
  Run;
- injected reply Message and projection-mapping failures leave the Run sequence,
  event log and Room history unchanged;
- an injected manual terminal-status failure also rolls back claim, reply,
  Message and projection;
- a fresh orphan whose Task is temporarily not runnable is not executed and can
  be reconciled later before its original deadline;
- ambiguous historical Messages and timestamp mismatches remain unprojected and
  gain one immutable failure record;
- a second startup pass creates no additional Run, Message or mapping.

## Executed gates

```text
npm run build --workspace @convene-wire/server
PASS

npm run test --workspace @convene-wire/server
PASS: 170/170

focused migration, Bridge reply fault and reopened-SQLite tests
PASS: 12/12

git diff --check
PASS
```

## Remaining boundaries

- `CON-016` owns durable cancellation intent delivery and acknowledgement.
- Unreconciled historical failures are durable and observable in logs but have
  no mutation/rebinding API; operator remediation requires a separate contract.
- Hosted CI, publication and fresh physical-machine acceptance remain separate
  gates.
