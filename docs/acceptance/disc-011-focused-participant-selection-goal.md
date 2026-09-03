# DISC-011 Focused Discussion Participant Selection Goal

Status: accepted on 2026-09-03 against the goal frozen before implementation.
This document remains the implementation and acceptance authority for
`DISC-011`; `docs/TASKS.md` remains the sole delivery-state register.

## Goal

Allow a durable Discussion to narrow a later contribution Wave to the Agents
that are relevant to its highest-priority unresolved questions, without giving
an Agent authority to choose participants or weakening Room, Task, role,
budget, recovery, or human-control boundaries.

The Central Orchestrator remains the only selection authority. Selection is a
pure deterministic projection of frozen Discussion policy, current authorized
membership/assignment facts, the retained ProgressSnapshot and immutable prior
member assessments. It does not call a model.

## Frozen Policy

Every new Discussion freezes two additive policy fields:

```text
participantSelectionMode = all_eligible | question_focused
focusedParticipantLimit = 2..5
```

The default is `question_focused` with a limit of three. Existing persisted
Discussions are migrated to the compatibility value `all_eligible`, so a
software upgrade cannot silently change their participant topology. The
fields cannot be changed by goal adjustment, resume, an Agent assessment or a
later Wave.

`all_eligible` preserves the existing behavior. `question_focused` keeps the
first contribution Wave broad because no retained question exists yet. A later
Wave narrows only when the current highest-importance unresolved question set
has at least one deterministic match; absence of a match falls back to all
eligible participants rather than guessing.

## Eligibility and Role Boundary

A participant is eligible for a new Wave only while all of these remain true:

- the frozen participant belongs to the Discussion;
- the Room exists, is in the same Team, still permits Discussions and still
  contains the Agent;
- the owning Task exists in that Room and is not completed or canceled;
- a non-default Task still assigns the Agent; and
- the Agent is enabled and belongs to the Room Team.

Presence and remote-wake capability still do not alter eligibility. Eligibility
is rechecked before planning a new Wave and again before a planned member Run
is created. A revoked participant is failed inside the already frozen Wave; it
is never replaced in place.

Question focus uses only bounded, retained evidence. The selector first uses
the Agents whose prior assessments reported a current highest-priority open
question, then exact normalized terms from their current Agent role and Task
assignment role that occur in those questions. Scores are ordered by evidence
strength and frozen participant ordinal. Arbitrary prose similarity, an LLM
choice, presence, cost, owner identity, and callback arrival order are not
selection inputs.

A Discussion Reviewer is a required member of every focused contribution Wave
in `review` mode or when `requireReviewer` is true. The Reviewer consumes one
slot. If the frozen focused limit cannot retain both that required role and one
matched contributor, creation is rejected instead of silently weakening the
role policy. Finalization remains a separate one-member Wave and continues to
prefer the eligible Reviewer.

## Budget Boundary

Focused selection does not create or extend a lease. The existing deterministic
policy engine must first authorize another logical Wave. A focused Wave may
commit no more than `focusedParticipantLimit` member Run slots; the retained
budget ledger charges exactly the selected member count. Soft and hard logical
Wave limits, elapsed duration and the independent finalization reserve retain
their existing meaning.

## Durable Selection Snapshot

Every newly planned Wave retains one immutable versioned selection snapshot in
the same SQLite transaction as the Wave and its member Turns. It pins:

```text
strategy
focusQuestionIds in canonical order
eligibleAgentIds in frozen participant order
selectedAgentIds in Wave member order
requiredRoles
focusedParticipantLimit
selectionDigest
```

The digest covers every field except itself. The selected IDs must equal the
Wave's persisted Turns in member order, and all selected IDs must occur in the
eligible set. A duplicate or structurally inconsistent snapshot fails closed.

Recovery never recomputes a committed Wave selection. It reuses the persisted
member Turns and verifies them against the snapshot before binding or creating
Runs. Restart before a Wave is committed may deterministically recompute from
the last committed ProgressSnapshot; restart after commit must recover the
exact same members even if a different selection would now score higher.
Current authority is still rechecked, so frozen selection is not a capability
token.

## Public Projection

The existing Discussion read model exposes the additive selection snapshot on
each new Wave so Web and audit clients can explain why a subset was invited.
It exposes stable IDs, roles, strategy and digest, not local Runtime details or
credentials. No new mutation endpoint is added: policy remains part of the
existing Discussion creation command.

## Non-Goals

This slice adds no quorum sealing, late evidence, read-only Runtime capability,
new Agent persona, semantic model call, dynamic policy rewrite, automatic Task
assignment, Plan approval, Run retry, repository/Git authority, Remote Provider
access, or cross-Discussion global scheduler. `DISC-012` owns opt-in read-only
quorum and append-only late evidence.

## Required Evidence

`DISC-011` may become `DONE` only when code, physical SQLite and service tests
prove all of the following:

1. the default first Wave is broad and a later highest-priority question
   deterministically narrows to its reporter/role matches within the frozen
   limit;
2. question and callback permutations produce the same ordered selection and
   digest, while no-match and `all_eligible` use the compatibility fallback;
3. Room removal, disabled Agent, wrong Team, closed Task, removed non-default
   Task assignment and disabled Room Discussion policy all prevent new
   selection or Run creation;
4. review mode and `requireReviewer` retain an eligible Reviewer, invalid
   selection modes/limits and an impossible Reviewer/limit policy are rejected;
5. budget events charge only selected member slots and no selection bypasses a
   lease, hard limit, duration limit or finalization reserve;
6. the Wave, snapshot and member Turns commit atomically; injected failure
   leaves none of them;
7. reopened-SQLite recovery after committed selection creates/binds only the
   frozen members, detects snapshot/Turn substitution, does not add a newly
   better match and remains idempotent under duplicate recovery;
8. migrations preserve existing Discussion behavior as `all_eligible`, and
   response/read projections preserve the immutable snapshot;
9. focused Server/migration/HTTP tests, full workspace build/regression,
   deterministic E2E, Bridge, docs and three isolated temporary-lifecycle
   rounds pass with physical before/after zero counts for all four historical
   temporary prefixes.

A green planner unit test alone is not acceptance. Final evidence must include
selected member IDs and selection digest from reopened SQLite, exact budget
slot counts, negative authority cases, duplicate recovery and physical
temporary-directory snapshots.

## Accepted Implementation

Migration 0084 preserves every pre-existing Discussion as `all_eligible` with
the compatibility limit of five, adds a nullable historic/new-required Wave
selection column and prevents later selection mutation. Every newly planned
Wave must carry a valid snapshot; historic Waves remain readable with `null`
selection rather than receiving invented evidence.

`discussion-participant-selector.ts` is the pure Central selector. It sorts by
frozen participant ordinal, considers only the highest-priority retained open
questions, gives retained reporters priority over exact normalized role-term
matches, retains the required Reviewer and falls back to all eligible members
when it has no deterministic match. The SHA-256 selection digest covers the
version, strategy, focused questions, eligible and selected IDs, required
roles and focused limit.

The Orchestrator rechecks current Room policy/roster, Team, Task lifecycle and
assignment, Agent enablement and Reviewer availability before each new Wave.
The repository validates and commits the Wave, snapshot and ordered member
Turns in one immediate transaction. Recovery validates the persisted digest
and exact Turn order before binding a Run and never reselects a committed Wave;
current authority can still stop a frozen member without replacing it.

## Acceptance Evidence

The accepted implementation is commits `8ba0d8f`, `dbad2ff` and `95aa51d` on
`main`. Verification on 2026-09-03 produced these results:

- 49 focused selector, Orchestrator, repository, migration and HTTP tests
  passed. The authority matrix covers foreign Team, Room removal, disabled
  Agent, closed Task, removed Task assignment, disabled Room Discussions and
  lost required Reviewer.
- The full Server suite passed 583 tests. `npm test` then passed every Server,
  Web, Contract, Bridge UI, QA evidence, product-experience, site and temporary-
  lifecycle workspace suite under one owned run root, which was removed.
- The reopened SQLite assertion retained selected IDs
  `agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W6` and
  `agent_01K4Z6J7Y8N9P0Q1R2S3T4V5W7` with exact digest
  `65e01c51f0c1f5d1dde8112a0fff886cead0beb39c15eb45f8e967337b70301c`.
  Separate restart tests retain the focused Backend/Reviewer subset after
  another Agent becomes a better role match, detect snapshot/Turn substitution
  and make duplicate recovery idempotent.
- A four-member first Wave charged four slots and its focused successor charged
  two; the retained budget metadata is exactly `[4, 2]` and total
  `agentRunsUsed` is six. Existing lease, duration, hard-limit and finalization-
  reserve regressions passed unchanged.
- `npm run test:e2e` passed nine deterministic scenarios and skipped only the
  explicit opt-in live-Runtime case. `npm run test:bridge` passed every Go
  Bridge package; it and E2E ran concurrently under different owned run IDs and
  each removed only its own root.
- `npm run validate` validated 14 schemas and 258 fixtures. `npm run build`
  built Server, Web and current generated contracts; Markdown lint checked 348
  files with zero issues.
- Three additional isolated `npm run test:temp-lifecycle` rounds each passed 24
  success, assertion/spawn failure, timeout, signal, nested and parallel
  cleanup checks. Before and after every round, physical counts for
  `agentroom-*`, `agent-room-*`, `convenewire-*` and `convene-wire-*` were all
  zero inside the private acceptance base, and the base itself was removed.

## Retained Boundaries

Focused selection is not model authority, a capability token, a lease or a
quorum. It creates no Task assignment, retry, repository/Git operation or
Remote Provider access. `DISC-012` remains the next Core task and separately
owns opt-in read-only quorum sealing and append-only late evidence.
