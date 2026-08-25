# Run Orchestration Module

- Prefix: `RUN`
- Planned location: `apps/server/`
- Owns: Run lifecycle, durable delivery, status sequencing, cancellation,
  offline queue, handoff

## Purpose

Run Orchestration converts an authorized structured Agent Mention into one
bounded unit of work. It is the only component allowed to route work between
Agents; Agents and Bridges never route directly to one another.

Run Orchestration executes one bounded unit of work. Multi-Agent progress,
budgets, Wave barriers, and next-Wave decisions belong to Discussion
Orchestration. One ordinary Discussion Wave may request one Run per member, but
it cannot bypass Run delivery, idempotency, or cancellation rules.

Every Run belongs to one durable Agent Task. Task Collaboration owns the
long-lived goal and shared result state; Run Orchestration continues to own only
the bounded attempt, delivery, event sequence, and terminal result.

## Responsibilities

- Create one Run per valid target Mention on the normal message path, or per
  persisted Discussion member Turn on the Wave path.
- Persist delivery before pushing to a Bridge.
- Retry unacknowledged delivery with the same Run ID.
- Apply sequenced Bridge status, output, activity, and reply events.
- Manage cancellation, expiry, offline queue, and terminal outcomes.
- Validate and create child Runs for handoff.
- Publish Run projections for Web and MCP.
- Bind an optional `orchestrationKey` to one Run for aggregate-owned recovery.
- Preserve the authoritative `taskId` across Mention routing, Discussion Waves,
  handoff, retry, and recovery.
- Persist safe Task clarification requests and create one authorized
  continuation Run after a Room answer.

## State Machine

```text
queued
  → delivered
  → working
      ├── input_required
      ├── completed
      ├── failed
      ├── canceled
      ├── expired
      └── outcome_unknown
```

`transport_lost` is connection metadata, not a Run state. Terminal states do
not transition. A Runtime that may have executed but lacks a trustworthy
outcome becomes `outcome_unknown` and is never automatically rerun.

Offline managed Runs remain `queued` and are delivered when the target Device
publishes or heartbeats. A queued Run that reaches its persisted deadline moves
to terminal `expired` and is never delivered on a later reconnect.

## Delivery Contract

1. Persist Run and delivery record.
2. Select the currently active target Bridge connection.
3. Send `run.requested` with Run ID and delivery attempt ID.
4. Bridge durably records Run ID before returning `run.accepted`.
5. Retry on missing ACK without changing Run ID.
6. Stop retrying after acceptance, cancellation, expiry, or Agent revocation.

Delivery is at least once; execution is idempotent through the Bridge inbox.

The triggering Message creates the authoritative `traceId`. The Run, Delivery,
Bridge request, Runtime events, projected Agent reply, and any child handoff
Run inherit it. Bridge-supplied trace values cannot replace this authority.

The server persists one Delivery payload per managed Run before the first send.
Retries increment `sendCount` but preserve the attempt ID, idempotency key, and
payload bytes. A valid `run.accepted` sequence 1 moves the Run to `delivered`;
duplicate ACKs are idempotent.

Discussion member Turns use their stable `turnId` as `orchestrationKey`. The
key is unique independently of `(triggerMessageId, targetAgentId)`, so recovery
finds the exact Run even when several Wave members share one input Message or a
later Wave reuses a participant. Creating the same keyed Run returns its
existing identity instead of starting another Runtime.

An ordinary Discussion Run inherits the Wave deadline, which is the earlier of
the Discussion deadline and `waveTimeoutSeconds`. At the deadline, a queued Run
becomes `expired`; a delivered, working, or otherwise accepted Run becomes
`outcome_unknown` because the Runtime may have executed. Finalization uses its
separate bounded reserve deadline.

## Event Ordering

Each accepted Run has a Bridge-generated monotonic `sequence`. The server
persists an event only when its sequence is greater than the last accepted
value. Duplicate and stale events are acknowledged but do not alter state.

The server accepts contiguous `run.status`, `run.output_delta`, `run.activity`,
and `run.reply` events only from the Device that owns the target Agent. Events
persist in `run_events`; output and activity advance the Run sequence without
changing its state or appending a Room Message. An applied reply appends one Agent-authored
Room Message linked to its trigger. Duplicate events do not create duplicate
output or replies, and the first terminal state remains authoritative. A
terminal Run rejects later output exactly as it rejects any other late event.

Authorized Room members may read persisted Run events after a sequence cursor
to reconstruct provisional output and activity after refresh or reconnect.
Applying either wakes the existing Team change channel with the owning Room ID;
the browser then fetches only unseen events. Reset deltas replace the provisional text before their content is
appended. Seeing a final reply discards the provisional projection, while the
durable Room Message remains the only completed conversation entry.

The Bridge also stores emitted event envelopes in its durable inbox before
network send. Reconnect replays these envelopes idempotently; a Bridge process
restart converts any unfinished local execution to `outcome_unknown` before
replay, so the central projection cannot remain falsely `working`.

Before delivery, the server resolves each context sender's current display
name and includes enabled peer Agents assigned to the Room. These names help a
Runtime emit complete exact `@Agent name` commands, but the stable IDs and
Room policy used by the server remain authoritative. Bridge adapters bound the
prompt projection independently of the larger transport allowance.

For a Discussion Wave, `input_required` is an intermediate Run report rather
than an immediately resumable barrier state. The Orchestrator writes a terminal
unknown outcome with durable reason `input_required`, waits for the other Wave
members, and only then applies Discussion policy. This preserves the all-settled
rule and prevents restart from stranding the barrier.

For an ordinary Task Run, `input_required` may carry a closed Task
clarification. The Server atomically persists the status, an Agent-authored
question Message, and a `waiting` clarification record. The Bridge treats that
event as a durable local execution boundary and replays it after reconnect or
restart without starting the Runtime again. It does not keep a process waiting
for a remote answer.

The first authorized Room answer appends one idempotent member Message in the
same Task, terminalizes the requesting Run as `outcome_unknown` with reason
`TASK_CLARIFICATION_CONTINUED`, and creates one new bounded continuation Run
for the same Agent. The continuation has a new Run ID but the same `taskId`, so
the Task-scoped Bridge binding resumes the same logical/native Session. A
repeated answer returns the existing Message and continuation; it cannot create
a second Run. Discussion Runs retain the Wave behavior above and cannot open
this ordinary-Run clarification flow.

Clarification answers are collaboration context only. They cannot approve a
filesystem, shell, network, tool, sandbox, or Runtime request. Codex App Server
interactive requests still receive a local protocol error, and all Runtime
permission policy stays on the Bridge host.

## Handoff

A handoff request contains parent Run, target Agent, summary, and optional
context references. The server validates Room access, target availability,
lineage, the Room's configured maximum depth from 1 through 4, maximum unique
Agents 5, and maximum Run duration 20 minutes before creating a child Run.
`allowAgentMentions=false` rejects both explicit MCP handoffs and automatic
reply routing before a child Run is created.

After an ordinary Run persists its Agent reply, the Server parses the content
as exact commands against current Room Agent names. A complete `@Agent name`
may create one child handoff, and exact `@all` may fan out to the remaining
eligible Agents only when the Room allows it. Prefix, substring, ambiguous
same-name, source-Agent, disabled, unassigned, over-depth, and lineage-revisit
targets do not route. Reply parsing is best effort after the parent result is
durable: one rejected candidate cannot erase the reply or cancel valid sibling
handoffs. Replies owned by a structured Discussion do not enter this parser,
because the Discussion Orchestrator alone schedules its next Wave.

The MCP caller must be the parent Run's target Agent. Child Runs inherit the
root trigger and deadline, use a new durable Run ID, and cannot revisit an Agent
already present in their lineage.

Handoff remains a delegation DAG. Its no-revisit rule must not be relaxed to
model `Agent A -> Agent B -> Agent A`; that interaction is a Discussion with
separate loop, progress, and budget controls.

## Cancellation Races

- A queued Run cancels without delivery.
- An accepted Run sends one interrupt request.
- The Bridge persists and reports its first terminal outcome; the server accepts
  the first valid terminal event for the Run.
- A later conflicting terminal event is retained as diagnostic evidence but
  cannot replace the result.

Discussion controls operate at the Wave boundary. Stop-after-Wave, finish, and
pause allow every active member to settle before policy advances. Immediate
cancellation requests an interrupt for every active member Run; each Run still
resolves its own first-terminal race under the rules above.

## Verification

- ACK loss and reconnect never execute a Run twice.
- Out-of-order events never regress state.
- Offline delivery runs once after reconnect.
- Cancellation and completion races are deterministic.
- Handoff loop, depth, and unique-Agent limits are enforced.
- Room policy rejects disabled handoffs, applies the configured depth, and
  exact reply parsing never routes fuzzy or ambiguous Agent names.
- A Discussion Wave fans out all planned member Runs without serial dispatch.
- `orchestrationKey` recovery recreates neither duplicate Runs nor duplicate
  Runtime executions.
- Cancel-all and mixed terminal outcomes preserve each Run independently for
  the Discussion all-settled barrier.
- Deadline tests distinguish queued `expired` from accepted
  `outcome_unknown`; `input_required` does not advance policy before the
  barrier.
- Task clarification recovery replays one question, accepts one Room-authorized
  answer, closes the original Run, and creates one same-Task continuation Run.

## Task Mapping

`RUN-001` through `RUN-009`, plus the in-process harness `QA-001`, recovery
tasks `DATA-003` and `QA-004`, and parallel Wave verification `QA-010`.

## Dependencies

Contracts, Team/Room, Registry, Bridge delivery, Persistence, and Security.
Discussion Orchestration consumes Runs through this public boundary.
