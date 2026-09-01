# EXEC-004 Graph Runtime Scheduler Increment

Date: 2026-09-01

This record freezes the first implementable EXEC-004 vertical slice. Delivery
state remains authoritative only in `docs/TASKS.md`; this file defines the
scope, ownership, failure semantics and decisive evidence for the increment.

## Target Outcome

An approved Execution Plan can advance one dependency-free `implementation`
node without treating a human Message as a command. Central derives a durable
node projection, evaluates readiness deterministically, and atomically creates
one immutable DispatchIntent plus the existing ordinary governed Run. After
commit, the Run uses the existing RUN-018 Delivery and Bridge inbox path. A
restart or duplicate scheduler wakeup recovers the same Run identity instead of
creating another attempt.

This increment is complete only when physical SQLite evidence proves the
DispatchIntent, Run and sealed manifest share the exact plan revision, node,
generation and Agent; success, failure, cancellation and ambiguous Run states
settle only the node projection; and concurrent/restarted schedulers never
create a second Run.

## Authority Boundaries

| Owner | Fact written in this increment | Facts it must not write |
| --- | --- | --- |
| Execution node-state repository | Derived readiness, active attempt and last settled Run projection | Task lifecycle, Run outcome, Result review, verification or repository refs |
| DispatchIntent repository | One plan revision/node/generation to one Run and operation digest | Transport acceptance, Runtime start or Agent success |
| Readiness evaluator | Pure decision from an immutable snapshot | No database, network, filesystem or clock mutation |
| Settlement service | Recomputable node projection from Run/Result facts | No Run event, Result acceptance, Task completion or integration mutation |
| Scheduler | Deterministic candidate order and atomic admission request | No second Runtime/start path and no LLM decision |
| Existing Run/Delivery | One Agent attempt and transport state | No graph success inference |

`ExecutionNodeState` is deliberately a projection, not an
`ExecutionNodeRuntime`: Codex/Pi Runtime authority stays on the Bridge and one
`Run` continues to own one Agent attempt. Settlement is the sole writer of this
projection, not a universal state-transition authority.

## Persisted Model

`execution_node_states` has one current row per compiled plan revision/node.
Its states are:

- `blocked`: no attempt exists and one explicit readiness blocker is present;
- `ready`: every admission prerequisite supported by this increment is true;
- `dispatched`: the unique Run is queued or delivered;
- `working`: the Run is working or requires input;
- `awaiting_result`: the Run completed, but no independent accepted Result
  proves node success;
- `failed`, `canceled`, or `outcome_unknown`: the exact Run settled that way.

The row pins the active generation/Run, last Run state, blocker code, monotonic
projection revision and update time. It never overwrites immutable source
records. `run.completed` maps to `awaiting_result`, never `succeeded`, because
VER-001 still blocks verified governed Result admission.

`execution_dispatch_intents` is immutable and unique on
`(plan_id, plan_revision, node_key, dispatch_generation)` and on `run_id`. It
pins the plan/control/approval identities, Task, Agent, Device, Run, compatibility
trace Message, exact request digest and creation time. Generation 1 is the only
automatic generation in this slice. Failed, canceled and ambiguous attempts do
not auto-retry; a later explicit retry contract must create a new generation.

The existing `runs.trigger_message_id` foreign key is retained for compatibility
with Context Manifest and reply projections. Scheduler admission creates one
zero-mention `system` trace Message in the same transaction. That Message is a
human-visible audit projection, is never passed through Message routing, and is
not the dispatch authority; the DispatchIntent is. Its content is not used as
the Run instruction, which comes from the approved/current Task goal.

## Readiness and Admission

The scheduler scans active approved/running plans in binary `plan_id`, then
compiled nodes in approved topological order with binary `nodeKey` tie-breaking.
The readiness evaluator receives a frozen snapshot and returns exactly one
state/blocker. It admits only when all of the following hold:

1. the current revision/digest/control revision still matches the approved plan;
2. the node is a dependency-free `implementation` node with no required inputs;
3. Task definition/criteria/assignment pins and scheduling/lifecycle state are
   current, and both Task and plan attempt/duration budgets remain available;
4. plan `maxConcurrency`, one active governed attempt per Agent and isolated
   workspace capacity are available;
5. the managed Agent, Device, connection-epoch capability and one exact current
   unexpired owner-local grant still match the approved repository/scope/profile;
6. the existing RUN-018 output/capture and manifest admission checks pass.

Incoming dependency edges, review/verification nodes, required inputs and any
unsupported gate fail closed with durable diagnostic blockers. They are not
silently treated as ready. The final admission rechecks every mutable fact in a
single `BEGIN IMMEDIATE` transaction, reserves generation 1, appends the system
trace Message, inserts the DispatchIntent/admission, creates the ordinary Run,
freezes its manifest/inputs and reserves the isolated workspace. Any failure
rolls all of those writes back.

## Settlement, Recovery and Delivery

Settlement is idempotent and recomputes each row from the current approved plan,
its immutable DispatchIntent and authoritative Run/Result records. Out-of-order
or repeated wakeups cannot regress a terminal projection. `outcome_unknown`
blocks automatic retry even after restart. Cancellation prevents a new attempt
and settles only after the existing Run records its terminal state.

Startup performs settlement before admission, then returns committed nonterminal
Runs for ordinary Delivery replay. Bounded periodic wakeups cover approval,
Task-control, capability/grant publication and terminal events without requiring
each producer to own scheduler logic. Only one sweep is in flight per Server.
SQLite immediate transactions plus unique intent/Run constraints arbitrate
multiple Server schedulers; a loser rereads and returns the winner's Run.

| Failure cut | Required physical result |
| --- | --- |
| readiness or admission error | no trace Message, intent, Run, manifest, input grant or workspace lease |
| process dies before transaction commit | none of the admission records exist |
| commit succeeds before Delivery | one intent and queued Run remain; recovery resends that Run |
| duplicate or concurrent sweep | exactly one generation-1 intent and one Run |
| Run fails or is canceled | the same intent remains and node settles terminal; no generation 2 |
| Run becomes outcome unknown | the same Run blocks retry until a future explicit acknowledgement/retry contract |

## Decisive Evidence

Focused tests must prove automatic delivery without a member Message command,
atomic rollback on startup/admission failure, exact manifest/intent joins,
duplicate and concurrent sweep idempotency, offline blocking then reconnect,
plan/Task budget and concurrency blocking, restart replay, cancellation,
out-of-order terminal settlement and unknown-outcome no-retry. Assertions inspect
physical table counts and identities, not only returned status.

The relevant Server build and full Server test suite must pass. The repository
temp-lifecycle suite runs in an isolated owned `TMPDIR`; before/after snapshots
must show no new `agentroom-*`, `agent-room-*`, `convenewire-*` or
`convene-wire-*` directories.

## Explicit Remainder

This increment does not claim dependency input materialization (EXEC-003),
review/verification admission or receipts (VER-001), Result publication closure,
repository integration (REPO-002), explicit retry/control APIs, scheduler modes,
plan supersession, Web UX or a real multi-node/two-Bridge acceptance. EXEC-004
therefore remains `ACTIVE` after this bounded slice until its full task evidence
exists.
