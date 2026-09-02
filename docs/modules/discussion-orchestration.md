# Discussion Orchestration Module

[ADR-0036](../adr/0036-add-governed-software-team-execution.md) adds structured
decision/plan proposals without execution or Result acceptance authority.
Code review/test pipelines belong to Execution, not Wave semantics. Later
focused/read-only quorum modes require frozen participant selection, required
roles and separate append-only supplemental evidence; existing terminal Run
events remain immutable. All-settled remains the default.

## Scope

- Prefix: `DISC`
- Implementation: `apps/server/src/discussion/`
- Owns: bounded multi-Agent Discussions, durable Waves, progress projection,
  budget leases, orchestration decisions, and finalization

## Purpose

Discussion Orchestration makes Agent-to-Agent conversation visible in a Room
without allowing Agents or Bridges to route directly to one another. An
ordinary logical round is a durable bulk-synchronous **Wave**: every eligible
participant gets one member Turn and one normal managed or manual Run from the
same frozen input anchor. Replies remain normal Agent-authored Room Messages.
The central server is the only authority for opening and closing Waves.

A Discussion is not a Handoff. Handoff is a bounded delegation lineage that
rejects revisiting an Agent. Discussion may use the same participants again in
later Waves. A Reviewer contributes independently in the same ordinary Wave as
the other participants and cannot inspect peer replies that did not exist when
the Wave started. Its approval is evidence for a policy that requires review,
and the role is preferred when selecting the separate finalization member; it
does not create a serial review Wave.

## Authority Boundary

The control chain is:

```text
Agent Run Reports (untrusted evidence)
  -> durable all-settled Wave barrier
  -> Progress Evaluator (one versioned projection per Wave)
  -> Policy Engine (authoritative decision)
  -> Run Orchestration (durable parallel execution)
  -> Room Message (visible transcript)
```

Agents report observations and recommendations. They cannot set Discussion
state, grant budget, select unauthorized participants, or declare authoritative
completion. Users may request finish, pause, resume, or immediate cancellation.

Under
[ADR-0022](../adr/0022-make-task-run-and-result-the-primary-work-model.md), a
terminal Discussion finalization may propose one immutable Task Result using the
Discussion, its member Runs, final Message, and existing Artifacts as exact
sources. The Orchestrator cannot accept the Result or complete the Task. Result
proposal retry uses one stable operation identity and does not replace the
existing final answer, Wave result anchors, evidence service, or Discussion
budget ledger.

The Orchestrator is a deterministic state machine. The current
`SemanticEvaluator` is a standalone interface and output normalizer with
contract tests; it is not injected into Discussion Orchestration and no model is
called. A future integration may add normalized evidence or a recommendation
for novelty, disagreement, or goal coverage. That output remains evidence only:
it cannot select the next action, bypass policy, or mutate state.

The implementation keeps command coordination and aggregate transitions in
`discussion-orchestrator.ts`. Terminal Run projection is isolated in
`wave-settlement-service.ts`; canceled/restarted and deadline recovery is owned
by `discussion-recovery-service.ts`; bounded instructions, deterministic result
anchors, and fallback output are owned by `discussion-evidence-service.ts`.
Pure terminal/barrier transitions live in `discussion-state.ts`, while pure
Wave/finalizer planning lives in `discussion-wave-planner.ts`. Progress
evaluation, policy, semantic evidence, and budget arithmetic retain their
standalone units. The pure planners receive frozen aggregate inputs and return
values only; they do not read SQLite, create Runs, append Messages, or dispatch
Bridge deliveries.

The deterministic evaluator sorts successful reports by frozen participant
ordinal, normalizes and hashes visible replies, combines valid structured
question and evidence deltas, and treats missing or malformed assessment fields
as reply-only evidence. Callback arrival order cannot change the projection.

## Domain Model

| Entity | Required State |
| --- | --- |
| Discussion | ID, Room, Task, root Message, goal, participants, policy, execution model, current Wave, state, reason, version |
| DiscussionWave | ID, Discussion, ordinal, phase, frozen input Message, expected members, deadline, state, version |
| DiscussionTurn | ID, Wave, member ordinal, speaker, input Message, Run, output Message, terminal reason, assessment |
| ProgressSnapshot | version, goal coverage, open questions, decisions, evidence, disagreement, plateau count |
| BudgetLedger | limits, lease, logical Wave usage, committed member-slot usage, extensions, finalization reserve |
| OrchestrationDecision | action, reason, next Wave or finalizer, output mode, input projection version |

`DiscussionWave` is unique by `(discussionId, ordinal)`, and only one Wave may
be open for a Discussion. Member Turns are unique by `(waveId, memberOrdinal)`
and `(waveId, speakerAgentId)`. A decision records the exact Discussion and
ProgressSnapshot versions it used. This fences duplicate workers and stale
evaluators from closing a barrier or scheduling the next Wave twice.

Only one nonterminal Discussion may exist per Task. Independent Tasks in the
same Room may have active Discussions concurrently; their root Messages,
member Runs, result anchors, and finalization remain within the owning Task.

Discussion creation coordinates its root Message, initial budget, participants,
first Wave and ordinary Runs in one managed immediate transaction. A rejected
Task/execution admission or a failed initial Wave leaves no orphan root Message,
partial Discussion or consumed budget. Notifications and external delivery occur
only after commit; this boundary does not add execution authority to Discussion.

## Agent Run Report

Runtime output contains a visible reply and optional structured evidence:

```json
{
  "reply": "The delivery path still needs a cancellation fence.",
  "assessment": {
    "goalSatisfied": false,
    "confidence": 0.82,
    "resolvedQuestionIds": ["question_delivery"],
    "addedQuestionIds": ["question_cancel_race"],
    "newEvidenceRefs": ["artifact_patch_1"],
    "disagreementRemaining": "low"
  },
  "recommendation": "continue"
}
```

Self-reported booleans and confidence are never authoritative. Unknown,
malformed, or unsupported fields degrade to reply-only evidence and are not
interpreted as completion.

## Wave Execution and Progress Evaluation

Opening an ordinary Wave atomically persists the Wave and one planned member
Turn per eligible participant. MVP eligibility means the Agent exists, is
enabled, and belongs to the same Team as the Room. It does not require a ready
presence, a particular Owner, or remote-wake capability. All members share one
input Message and deadline, and their Runs may start concurrently. Replies
appear as they arrive, but no ProgressSnapshot or next action is committed until
every member is terminal or the deadline resolves missing members.

The ordinary Wave deadline is the earlier of the Discussion deadline and
`waveTimeoutSeconds`. A queued member becomes `expired` when it passes; an
accepted or working member becomes `outcome_unknown` because execution may have
started. An `input_required` Run is terminalized as `outcome_unknown` with a
durable `input_required` reason because the Wave cannot resume it in place. The
Discussion remains at the open barrier until all other members settle, then
policy applies that reason under the normal priority rules.

The all-settled result is deterministic:

- all members succeed: close the Wave as `completed`;
- at least one member succeeds: close it as `partial` and evaluate only
  successful reports in participant order;
- no member succeeds because execution failed or expired: close it as `failed`
  and enter `waiting_human` rather than inventing progress;
- every member is canceled by an immediate user stop: close it as `canceled`
  and keep the Discussion terminally `canceled`.

A finalization Wave contains only the first eligible Reviewer, or the first
eligible participant when no Reviewer remains. The Reviewer may already have
contributed in the preceding ordinary parallel Wave; only the finalization Wave
itself is single-member.

The MVP Progress Evaluator combines deterministic facts and Agent assessments.
It writes one aggregate version per closed Wave. The standalone semantic
contract is not consumed on this path. Plateau detection therefore compares
Wave aggregates, not callback order. A typical plateau has no newly resolved
important question, new evidence, changed decision, or reduced disagreement
across consecutive Waves.

A plateau with no important unresolved issue may finalize automatically. A
plateau with a high-priority unresolved issue moves to `waiting_human` and
offers a strategy or participant change; it must not claim success silently.

## Discussion Budget

Budget separates logical coordination from committed execution capacity:

```text
logical Waves + committed member execution slots + input/output tokens + elapsed duration + cost
```

For each ordinary Wave, closure advances the compatibility field `turnsUsed`
once and `agentRunsUsed` by the persisted expected-member count. The latter is a
committed execution-slot counter, not proof that every slot started a physical
Runtime process. Lease and hard boundaries use logical Wave usage. MVP token and
cost telemetry is not aggregated from Wave members, so missing values remain
unknown. Two planned members in one Wave are one policy round and two committed
execution slots.

The server grants a bounded lease instead of promising a fixed number of Waves.
At lease exhaustion it may renew within the automatic boundary. Crossing a
soft boundary moves to `awaiting_extension`; crossing a hard boundary stops new
ordinary Waves. Missing Runtime token or cost telemetry is unknown, never zero.

Finalization has a separate reserve that ordinary Waves cannot consume. This
allows a hard-budget stop to still produce the best available conclusion,
unresolved issues, and evidence references.

## Policy and Decision

Policy is resolved in descending authority:

```text
Team safety limits
  -> Room policy
  -> Discussion template
  -> permitted user options
```

Templates may define brainstorming, architecture review, debate, or
implementation completion. Reviewer approval applies only when required by the
resolved policy.

The authoritative action is one of:

- `continue` — atomically plan the next eligible Wave;
- `wait_human` — preserve state until required input arrives;
- `pause` — stop scheduling without canceling the transcript;
- `finalize` — produce the configured terminal output;
- `cancel` — interrupt all active members when possible;
- `terminate` — stop because a hard policy boundary was reached.

Final output is independent: `none`, `summary`, `final_answer`, `artifact`,
`decision_record`, or `unresolved_issues`. Decision priority is deterministic:
immediate user cancellation; security and hard-budget gates; required human
input; user finish; completion; plateau; soft-budget extension; continue.

## State Machine

```text
active
  |-- stop after Wave -----> stop_requested --+
  |-- input required ------> waiting_human ----+--> active
  |-- lease not extended --> awaiting_extension+
  |-- operator pause ------> paused -----------+
  |-- finish decision -----> finalizing -------> completed
  |-- immediate stop ------> canceled
  `-- hard boundary -------> finalizing -------> terminated
```

State and reason are separate. Reasons include `goal_satisfied`,
`user_requested_finish`, `discussion_plateau`, `soft_budget_exhausted`,
`hard_budget_exhausted`, `policy_violation`, and `runtime_failure`.

## Runtime Context

Every Wave member receives a bounded, named context containing the goal,
speaker identity, participant roster, target audience, progress snapshot,
important unresolved questions, recent transcript, checkpoint summary, and
remaining lease. Members in one ordinary Wave receive the same frozen
transcript anchor and cannot see peer replies from that Wave.

When an ordinary Wave settles, the server idempotently appends a deterministic
`wave_result` system Message whose ID is derived from the Wave ID. Its member
status lines use frozen participant order, and it becomes the next Wave's input
anchor. The next instruction separately reconstructs successful prior replies
in Wave/member ordinal order. Room Messages retain durable arrival order, so the
visible timeline may differ from evaluation and instruction order.

The server serializes this context into the Run instruction so existing managed
and pull adapters participate without a client rewrite. It limits recent
transcript to 24 Room Messages and retains the 20,000-character instruction
boundary.

Managed adapters should emit structured assessments when supported. Generic or
manual participants may emit reply-only output; policy remains safe under that
capability downgrade. Codex and Generic CLI may append a final
`<agentroom-assessment>{...}</agentroom-assessment>` envelope. The Bridge removes
a valid envelope from the visible reply and sends it as optional assessment
data. Invalid or missing envelopes remain reply-only output.

MVP finalization persists summaries, final answers, decision records, and
unresolved issues as Messages. Selecting `artifact` asks the finalizer for a
message representation; binary Artifact transport remains owned by `FUT-004`.

### Structured Execution Proposal Finalization

`DISC-010` adds one bounded adapter only when the frozen output mode is
`decision_record`. The finalizer's visible conclusion remains the ordinary
Agent reply Message. A proposal is considered only when that Message ends with
exactly one final line of this form:

```text
<convenewire-plan-proposal>{"schemaVersion":"1.0",...}</convenewire-plan-proposal>
```

The JSON body must satisfy the closed shared `discussionPlanProposalDraft`
schema. It contains title, decision summary/items/questions, nodes, edges,
external inputs and policy. It cannot supply root Task identity, evidence
sources, source revisions, author, operation identity, approval or execution
state. The adapter never extracts a plan from prose, Markdown or a near-match.
Missing, duplicate, oversized, malformed, trailing or schema-invalid envelopes
leave the final Message intact and create no DecisionRecord or PlanProposal.

The Server binds the draft to the Discussion's exact top-level Task and adds
only two authoritative decision sources: the immutable final reply Message at
its Room sequence and the terminal Discussion at its aggregate version. The
author is `{ kind: "discussion", discussionId }`; the stable operation identity
is derived by the Server from the finalization Turn. All ordinary graph,
Task/Agent/repository reference, source-freeze and external-input validation
still applies. A structurally valid draft that fails any domain check creates no
plan and cannot prevent the Discussion and visible conclusion from finishing.

Final Discussion closure and valid draft persistence share one immediate
transaction. A crash cannot retain only one side. Reconciliation after restart
recomputes the same operation and returns the one existing draft rather than
creating another. The resulting plan remains `draft`: finalization cannot
approve it, compile child Tasks, dispatch Runs, review Results, verify code,
integrate repositories, enlarge budgets or grant local Runtime authority.

## User Experience

The Room uses one composer. Two to five distinct structured Agent Mentions
create a Discussion; the body becomes its goal. The root Message retains those
Mentions, but no independent fan-out bypasses Discussion control. There is no
separate **Start Discussion** mode.

The Room shows a logical round without a hard-limit denominator. While a Wave
is active it shows barrier progress such as `1/2 已结束` and one state chip
per member Run; Agent jobs are not separate rounds. Replies appear immediately,
and finalization is a separate single-Agent phase.

Primary control is **Finish and generate conclusion**. Secondary controls are
**Stop after this round**, **Pause**, and **Stop immediately**. Finish,
stop-after-round, and pause take effect after the current Wave barrier;
immediate stop cancels every active member Run. At a soft boundary the UI
offers **Continue solving**, **Finish with current conclusion**, or **Adjust
goal**, without asking users to allocate internal rounds.

## Recovery and Security

- Persist a decision, Wave, and all member Turn intents atomically before Run
  creation or delivery.
- A Room has at most one non-terminal Discussion. Competing creation requests
  receive a conflict.
- Each member Run uses its member `turnId` as a unique `orchestrationKey`.
  Reconciliation first binds an existing keyed Run and creates one only when no
  keyed identity exists, without guessing from Message and Agent identity.
- Wave closure, one budget event, one progress projection, the authoritative
  decision, and any next Wave are aggregate-version fenced.
- The deterministic `wave_result` ID makes a crash after anchor append and
  before barrier closure idempotently retryable.
- `QA-010` reopens SQLite and rebuilds repositories at planned-member,
  partially settled barrier, and committed-next-Wave cut points. Stable
  `orchestrationKey` identities prevent duplicate execution.
- Only existing, enabled Agents from the Room's Team may be scheduled. Proposed
  evidence and Artifacts are authorized and validated before projection.
- Redaction runs before Discussion context leaves the central service.
- Immediate stop preserves committed Messages and records unknown Runtime
  outcomes where necessary.

## Verification and Tasks

Deterministic tests cover callback permutations, duplicate terminals,
all-success, partial-success, all-failed, deadline, `input_required`, cancel-all,
early completion, lease renewal, boundary-aligned user controls, stale
decisions, plateau policies, Runtime capability downgrade, deterministic
anchors, participant-ordered bounded context, and three reopened-SQLite
recovery cut points. A live Codex-Pi run proves one parallel contribution Wave
and Reviewer finalization through the Go Bridge.

Sequential orchestration is tracked by `DISC-001` through `DISC-006`; parallel
Wave delivery, presentation, and acceptance are completed by `DISC-007`,
`WEB-020`, and `QA-010`. Lifecycle service extraction is tracked by `DISC-008`
and `DISC-009` in `docs/TASKS.md`.

## Dependencies

Contracts, Team/Room, Run Orchestration, Runtime Adapters, Persistence,
Security, Web UI, and Testing/Observability.
