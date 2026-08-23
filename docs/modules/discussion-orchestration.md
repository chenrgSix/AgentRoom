# Discussion Orchestration Module

## Scope

- Prefix: `DISC`
- Implementation: `apps/server/src/discussion/`
- Owns: bounded multi-Agent discussions, progress projection, budget leases,
  orchestration decisions, and finalization

## Purpose

Discussion Orchestration makes Agent-to-Agent conversation visible in a Room
without allowing Agents or Bridges to route directly to one another. Every turn
is a normal Agent-authored Room Message backed by one managed or manual Run.
The central server remains the only authority for scheduling the next turn.

A Discussion is not a Handoff. Handoff is a bounded delegation lineage that
rejects revisiting an Agent. Discussion deliberately permits repeated speakers
such as `Coder -> Reviewer -> Coder`, under a separate policy and budget.

## Authority Boundary

The control chain is:

```text
Agent Turn Report (untrusted evidence)
  -> Progress Evaluator (versioned projection)
  -> Policy Engine (authoritative decision)
  -> Run Orchestration (durable execution)
  -> Room Message (visible transcript)
```

Agents report observations and recommendations. They cannot directly set a
Discussion state, grant more budget, select an unauthorized participant, or
declare an authoritative completion. Users may request finish, pause, resume,
or immediate cancellation at any time.

The Orchestrator is primarily a deterministic state machine. An optional
semantic evaluator may produce additional evidence for novelty, disagreement,
or goal coverage, but it cannot bypass policy or mutate state directly.

## Domain Model

| Entity | Required State |
| --- | --- |
| Discussion | ID, Room, root Message, goal, mode, participants, policy snapshot, state, reason, version |
| DiscussionTurn | ID, Discussion, ordinal, speaker, targets, input Messages, Run, output Message, assessment |
| ProgressSnapshot | version, goal coverage, open questions, decisions, evidence, disagreement, plateau count |
| BudgetLedger | limits, current lease, usage, extensions, finalization reserve |
| OrchestrationDecision | action, reason, next speaker, output mode, input projection version |

`DiscussionTurn` has a unique `(discussionId, ordinal)` key. A decision records
the exact Discussion aggregate version and ProgressSnapshot version it used, so
duplicate workers or stale evaluators cannot schedule two next turns.

## Agent Turn Report

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
malformed, or unsupported assessment fields degrade to reply-only evidence and
must not be interpreted as completion.

## Progress Evaluation

The Progress Evaluator combines:

1. deterministic facts such as tests, Artifacts, resolved question IDs, and
   authoritative budget usage;
2. Agent assessments and recommendations;
3. optional semantic evaluation for novelty, repetition, and disagreement.

Plateau detection uses a policy window over structured deltas. A typical window
requires no newly resolved important question, no new evidence, no changed
decision, and no reduction in disagreement across consecutive turns.

A plateau with no important unresolved issue may finalize automatically. A
plateau with a high-priority unresolved issue moves to `waiting_human` and
offers a strategy or participant change; it must not silently claim success.

## Discussion Budget

Budget is multi-dimensional:

```text
turns + input/output tokens + elapsed duration + estimated cost
```

The server grants a bounded lease instead of promising a fixed number of turns.
At lease exhaustion it evaluates progress and may renew automatically within
the policy's automatic boundary. Crossing a soft boundary moves to
`awaiting_extension`; crossing a hard boundary terminates execution.

The BudgetLedger is central and append-only. Agent estimates do not change it.
Missing Runtime token or cost telemetry is recorded as unknown, never zero, and
causes the policy to rely on available turn and duration limits.

Finalization has a separate reserve that ordinary turns cannot consume. This
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
implementation completion. Reviewer approval applies only when the resolved
policy requires it.

The authoritative action is one of:

- `continue` — schedule the next eligible speaker;
- `wait_human` — preserve state until required input arrives;
- `pause` — stop scheduling without canceling the active transcript;
- `finalize` — produce the configured terminal output;
- `cancel` — interrupt immediately when possible;
- `terminate` — stop because a hard policy boundary was reached.

Final output is an independent dimension: `none`, `summary`, `final_answer`,
`artifact`, `decision_record`, or `unresolved_issues`.

Decision priority is deterministic: immediate user cancellation; security and
hard-budget gates; required human input; user finish requests; completion
policy; plateau policy; soft-budget extension; otherwise continue.

## State Machine

```text
active
  |-- stop requested ------> stop_requested --+
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

Every turn receives a bounded, named context containing the Discussion goal,
speaker identity, participant roster, target audience, progress snapshot,
important unresolved questions, recent transcript, checkpoint summary, and
remaining lease. Runtime Adapters must consume this context rather than sending
only the triggering instruction.

Managed adapters should emit structured assessments when supported. Generic or
manual participants may emit reply-only output; the central evaluator and
policy must continue safely under that capability downgrade.

## User Experience

The composer distinguishes a one-shot multi-Mention from **Start Discussion**.
The Room shows `Discussing - turn 7`, never `7 / 12`, because a soft boundary is
not a completion target.

Primary control is **Finish and generate conclusion**. Secondary controls are
**Stop after this turn**, **Pause**, and an overflow **Stop immediately**.
At a soft boundary the UI explains resolved and unresolved goals and offers
**Continue solving**, **Finish with current conclusion**, or **Adjust goal**.
Advanced users may inspect or override the next budget lease when policy allows.

## Recovery and Security

- Persist a decision and its next-turn routing intent atomically before
  delivery.
- Reconciliation may recreate a missing Run from routing intent but cannot
  advance the Discussion twice.
- Only Room-visible, enabled participants may be scheduled.
- Agent-proposed targets, evidence references, and Artifacts are authorized and
  validated before projection.
- Redaction runs before Discussion context leaves the central service.
- Immediate stop preserves committed Messages and records whether an active
  Runtime outcome is unknown.

## Verification and Tasks

Tests cover early completion, useful automatic lease renewal, soft-boundary
extension, hard-budget termination with reserved finalization, user stop modes,
stale decisions, duplicate scheduling, plateau with low- and high-priority open
issues, policy precedence, Reviewer-optional modes, missing usage telemetry,
restart recovery, and Generic Adapter capability downgrade.

Implementation is tracked by `DISC-001` through `DISC-006`, `WEB-017`, and
`QA-007` in `docs/TASKS.md`.

## Dependencies

Contracts, Team/Room, Run Orchestration, Runtime Adapters, Persistence,
Security, Web UI, and Testing/Observability.
