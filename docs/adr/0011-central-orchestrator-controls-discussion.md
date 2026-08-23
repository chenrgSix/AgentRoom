# ADR-0011: Central Orchestrator controls Agent discussions

- Status: Accepted
- Date: 2026-08-23
- Supersedes: none

## Context

Agent Room needs visible Agent-to-Agent discussion while preserving a light
client integration and the central Room as the collaboration authority. A fixed
turn count cannot express completion: simple goals may finish early, while
complex goals may need more work. Allowing Agents to decide their own next
actions makes them both participants and process authorities and can create
premature completion, polite repetition, or unbounded loops.

Existing Handoff semantics cannot represent discussion because delegation
lineage intentionally rejects revisiting an Agent. Discussion needs repeated
speakers, progress evaluation, adaptive resource budgets, and user controls.

## Decision

Introduce a central Discussion aggregate separate from Handoff. Agents emit a
visible reply, structured assessment, and non-authoritative recommendation. A
versioned Progress Evaluator projects goal coverage, unresolved questions,
evidence, disagreement, and plateau signals. A deterministic Policy Engine owns
the authoritative continue, wait, pause, finalize, cancel, or terminate action.

Budgets cover turns, tokens, elapsed time, and cost. They are granted as leases
with soft and hard policy boundaries. Finalization uses a protected reserve.
State is separate from the reason for completion or termination.

Users may finish with a conclusion, stop after the current turn, pause, resume,
or immediately cancel. Team safety limits override Room policy, which overrides
Discussion templates and permitted per-Discussion options.

## Alternatives

- Direct Bridge-to-Bridge messaging was rejected because it duplicates trust,
  routing, history, and recovery outside the central authority.
- Reusing Handoff was rejected because its no-revisit lineage is a necessary
  delegation loop guard.
- Fixed turn limits were rejected as completion criteria; they remain one
  resource budget dimension.
- Agent-owned `nextAction` was rejected because Agent output is untrusted
  evidence, not workflow authority.
- An LLM-only moderator was rejected as the primary Orchestrator because its
  decisions would be costly, opaque, and difficult to reproduce.

## Consequences

The existing Message and Run models remain reusable, but new Discussion,
DiscussionTurn, progress, decision, and budget persistence is required. Runtime
Adapters must receive bounded named context and should emit structured
assessments when capable. The Web gains explicit Discussion lifecycle and user
control surfaces.

Policy evaluation becomes testable and replayable. Semantic plateau evaluation
remains optional and must be versioned when used. Runtime usage telemetry gaps
must be represented explicitly rather than treated as zero consumption.

## Compatibility and Security

Discussion is an additive capability. Clients without assessment support remain
reply-only participants and cannot claim authoritative completion. Existing
Mention, Run, and Handoff behavior is unchanged.

All routing remains central. Participant visibility, Room access, budget
extensions, evidence references, and final outputs are authorized server-side.
Discussion context is bounded and redacted before delivery.

## Verification

- A two-turn goal may complete without consuming its remaining lease.
- Useful progress renews a lease within policy; a soft boundary waits for user
  extension and a hard boundary terminates with reserved finalization.
- Repeated low-value turns trigger plateau policy without trusting a single
  Agent's self-assessment.
- User finish, stop-after-turn, pause, and immediate cancellation are
  deterministic under concurrent Run completion.
- Duplicate or stale decisions cannot create duplicate next turns.
- Restart reconstructs the same Discussion state and budget usage.
