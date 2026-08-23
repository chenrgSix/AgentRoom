# ADR-0012: Run Discussion participants in durable parallel Waves

- Status: Accepted
- Date: 2026-08-23

## Context

A Room submission may mention two to five Agents with the expectation that they
start together. The original scheduler created one Turn and waited for it to
finish before creating the next. That serialized independent analysis, exposed
implementation ordering in the UI, and let one failed Turn strand a resumed
Discussion.

Simply creating several Runs in a loop is unsafe. The first terminal callback
could advance policy before slower participants reply, callback arrival order
could change the conclusion, and restart recovery could recreate only part of
the group.

## Decision

Use bulk-synchronous **Discussion Waves**. Every ordinary Wave freezes one
input anchor and atomically persists one member Turn per eligible Agent. For the
MVP, eligible means that the Agent exists, is enabled, and belongs to the same
Team as the Room. Presence, owner identity, and remote-wake capability do not
change this eligibility rule. All member Runs may execute concurrently. Members
cannot see replies from their own Wave.

After an ordinary Wave settles, the server idempotently writes a deterministic
`wave_result` system Message derived from the Wave ID. It contains member
terminal states in frozen participant order and becomes the next Wave's input
anchor. The next Run instruction separately reconstructs a bounded transcript
of at most 24 prior Messages, ordering successful Agent outputs by Wave and
participant ordinal. Room Messages remain visible in durable arrival order;
the UI does not rewrite their sequence to match evaluation order.

A durable all-settled barrier closes only after every member is terminal or its
deadline is resolved. Successful results are aggregated in participant order,
independent of callback arrival. Partial success may advance when at least one
participant replied; all-member failure enters `waiting_human`. Finalization is
a single-member Wave that prefers the eligible Reviewer and otherwise uses the
first eligible participant. A Reviewer is still an independent member of every
ordinary parallel Wave. Its approval is untrusted evidence for policies that
require review; the role does not create a serial review Wave.

An ordinary Wave deadline is the earlier of the Discussion deadline and its
configured Wave timeout. At expiry, a queued member becomes `expired`, while an
accepted or working member becomes `outcome_unknown`. `input_required` is
converted to a terminal unknown outcome with a durable `input_required` reason;
the Discussion waits for the remaining members before policy selects
`waiting_human` under the normal priority rules.

Wave closure, progress and budget projection, the authoritative decision, and
any next Wave are fenced by Discussion version. Duplicate callbacks cannot
record usage or plan work twice. Immediate cancellation targets every active
member; stop-after-turn means stop after the current Wave.

Budgets count logical Waves and separately record committed member execution
slots. This counter is capacity accounting for persisted Wave membership, not a
claim that every slot started a physical Runtime process. Hard policy, duration,
and finalization reserve remain authoritative.

The repository includes a standalone semantic-evaluator contract and output
normalizer. It is not injected into the MVP Orchestrator and no model is called.
A future integration may add normalized evidence, but the deterministic Policy
Engine alone changes state.

Existing Turn rows are migrated as singleton Waves. New ordinary Waves fan out
to all eligible same-Team participants without changing the central trust
boundary or the Bridge protocol.

## Consequences

- The Room shows replies as they arrive while progress waits for the barrier.
- A Wave needs explicit persistence, member outcomes, deadline, and recovery.
- A Reviewer contributes independently in the same ordinary Wave, may supply
  approval evidence, and is preferred for the separate finalization Wave.
- Fan-out increases potential Runtime calls, so observability distinguishes
  logical Waves, committed member slots, and ordinary Run counters.

## Verification

- Every callback permutation produces the same progress and decision.
- Duplicate final callbacks create one next Wave and one usage event.
- Partial failure, all failure, timeout, stop-after-Wave, and cancel-all have
  deterministic outcomes.
- Review mode keeps the Reviewer in the ordinary cohort, accepts approval only
  as evidence, and prefers that Agent for finalization.
- `QA-010` reopens SQLite before Run binding, during a partial Wave, and after
  barrier closure; all three cut points converge without duplicate execution.
