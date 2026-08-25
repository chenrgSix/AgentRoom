# ADR-0014: Version and acknowledge Room context coverage

- Status: Accepted
- Date: 2026-08-25
- Supersedes: none

## Context

The current Room memory row is a bounded extractive projection. Its
`source_sequence` marks the boundary used to construct recent context; it does
not prove that every Message from sequence 1 through that value was processed.
Reinterpreting the column as complete rolling coverage would silently turn old
partial projections into false coverage claims.

Task-scoped native Sessions also retain only one local Room cursor. The Server
currently plans a bounded context before the Bridge knows whether the native
Session will be started, resumed, or recreated. The Bridge then filters that
payload using owner-local state. A Server plan therefore cannot truthfully
contain the previous consumed cursor, and advancing directly to the trigger
sequence can skip context that was truncated before the Runtime saw it.

There are three distinct authority concerns:

- Messages, Runs, Discussions, and ArtifactRefs are authoritative records that
  an event or claim was recorded; their content is not automatically true.
- Member-approved active `MemoryEntry` records are the canonical shared
  assertions and constraints for their scope.
- Rolling summaries are lossy, non-authoritative context derived from evidence.

## Decision

Keep `room_memory_projections` and its `source_sequence` semantics unchanged.
Add immutable, versioned `rolling_room_checkpoints` plus one mutable
`rolling_room_state` scheduler row per enabled Room. A ready checkpoint chain
must begin at sequence 1 and contain contiguous processed input intervals.
Existing Rooms start disabled or backfilling and do not claim rolling coverage
until that invariant is proven.

The Server owns canonical checkpoint scheduling, leases, validation, and
commit. Reduction executes behind a `MemoryReducerRunner` port. A deployment
may explicitly configure a Server-hosted runner or delegate a bounded request
to an owner-authorized Bridge worker. Delegated execution is not inferred from
an ordinary Coding Agent connection: worker selection, data exposure, quota,
revocation, and failover are explicit configuration. No configured runner
means rolling reduction remains disabled while the extractive projection stays
available.

The Server sends a session-independent `RoomContextBundle`, not a claim about
local consumption. For trigger Message sequence `S`, the bundle contains:

```text
checkpoint processing 1..K
+ raw context Messages K+1..S-1
+ the separate current request at S
= processed input coverage through S
```

The Bridge looks up the local Task Session and derives a
`RoomContextConsumption` receipt. For a started or recreated Session it accepts
the checkpoint and complete raw tail. For a resumed Session at local cursor
`L`, it may omit a checkpoint only when `K <= L` and may omit raw Messages only
through `L`. When `K > L`, the checkpoint is a replacement bootstrap through
`K` and the raw tail begins immediately after it. The Bridge either projects
the complete validated interval or rejects the Run before starting the Runtime;
coverage-bearing data is never silently truncated.

The local cursor advances to the accepted `coverageThroughSequence`, never
blindly to the trigger sequence. Each Runtime Adapter defines its durable prompt
acceptance point. An ambiguous acceptance does not advance the cursor and is
reported without pretending the provider did not possibly receive the turn.

Runs capture a `ContextFence` when their routing intent is created. The fence
limits delayed delivery to the trigger Room sequence and the then-current Room
Memory, Task Memory, Task result-evidence, and Task-state revisions. Historical
planning selects the newest checkpoint at or before the fence and cannot read a
newer current snapshot.

Checkpoint cursors prove processed input intervals, not semantic completeness.
Summary quality is evaluated separately with fixed recall, conflict,
attribution, provenance, and false-fact fixtures. Incremental checkpoints retain
their immutable parents and input digests; later rebase checkpoints may rebuild
from independent source segments to control recursive drift.

Automatic Memory candidates are machine suggestions. Candidate persistence and
summary persistence validate and commit independently. Candidate acceptance
uses the existing Member-authorized `LongTermMemoryService` inside the same
transaction, records the resulting Memory ID, and is idempotent under retry.

## Alternatives

- Reinterpret the current projection row: rejected because existing rows never
  proved contiguous processing from sequence 1.
- Let the Server guess a Bridge-local consumed cursor: rejected because native
  Session identity and disposition are deliberately owner-local.
- Always run reduction on an arbitrary connected Bridge: rejected because it
  silently assigns Room-wide data exposure, cost, and canonical output to one
  Member's provider.
- Call semantic summary quality a consistency guarantee: rejected because an
  LLM summary is lossy even when every input interval was processed.
- Resend all Room Messages forever: rejected because transport and Runtime
  context limits grow without bound.

## Consequences

- Persistence gains immutable checkpoint history, scheduler state, leases, and
  a recoverable desired watermark.
- Contracts distinguish a Server context bundle from a Bridge consumption
  receipt and keep the trigger request separate from the raw tail.
- Bridge prompts need a fail-closed coverage path independent of the legacy
  recent-message truncation path.
- Delayed Runs gain revision fences beyond the existing Room projection fence.
- Rolling context can remain safely disabled during mixed-version rollout and
  backfill.
- A delegated reducer requires an explicit trust and quota configuration but
  does not expose provider credentials to the Server.

## Compatibility and Security

All new wire fields are additive during the rollout. A Server sends coverage
bundles only to a Bridge that publishes the capability; older peers continue to
receive the bounded extractive plan and make no rolling-coverage claim. A new
Bridge accepts legacy payloads under the old bounded semantics but never maps a
legacy context cursor to a coverage receipt.

Reducer input is bounded, redacted, and treated as untrusted history. A
delegated worker uses a dedicated no-tools, no-workspace invocation rather than
the Coding Task Session. Checkpoint summaries, candidate content, provider
errors, and persisted diagnostics are length-bounded and redacted. Raw provider
credentials, native Session IDs, workspace paths, and prompts remain local.

## Verification

- Existing extractive rows never appear as rolling checkpoints.
- Backfill cannot enter `ready` unless the committed chain covers sequence 1
  through its latest cursor without a gap.
- Bundle validation proves checkpoint, raw tail, and current request are
  contiguous through the trigger sequence.
- The Bridge rejects malformed, oversized, discontinuous, or truncated coverage
  before invoking the Runtime.
- Started, resumed, recreated, failed, and ambiguous provider cuts advance only
  the accepted local cursor.
- Historical Runs cannot observe checkpoint or revisioned context newer than
  their captured fence.
- A stale reducer cannot move the latest cursor backward, and a desired cursor
  ahead of latest remains recoverable work.
- Candidate rejection cannot block a valid checkpoint; duplicate acceptance
  creates one MemoryEntry.
- Fixed summary-quality fixtures report quality separately from interval
  correctness.
