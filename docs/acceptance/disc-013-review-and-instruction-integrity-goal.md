# DISC-013 Review and Instruction Integrity Goal

Status: accepted on 2026-09-05 against the goal frozen before implementation.
This document remains the implementation and acceptance authority for
`DISC-013`; `docs/TASKS.md` remains the sole delivery-state register.

## Goal

Keep a required Discussion review current and preserve the instructions that
make every bounded Agent contribution interpretable. An explicit Reviewer
opinion in the current settled Wave replaces the prior approval value; a Wave
without an explicit successful Reviewer opinion retains the prior value. Every
Run instruction remains within 20,000 Unicode code points while retaining the
Discussion goal and progress sections, current Agent identity and Discussion
role, exact current Task, complete assessment guidance and any structured
finalization rules.

These changes improve Discussion evidence and prompting only. Reviewer output
remains untrusted evidence for the deterministic policy engine. It does not
approve a Task Result or execution Plan, grant budget, select participants, or
create repository, verification, integration or Runtime authority.

## Frozen Semantics

- Successful current-Wave Reviewer assessments with an explicit
  `reviewerApproved` value replace the prior ProgressSnapshot value. Missing,
  malformed or failed Reviewer assessments do not invent a new opinion.
- The projection remains independent of callback arrival order. Although the
  current product creates one Reviewer, aggregation fails conservatively if a
  historical or malformed cohort contains conflicting explicit Reviewer
  opinions.
- The instruction builder reserves invariant content before admitting bounded
  goal, progress and recent-transcript text. It never truncates the final
  assessment envelope or the `decision_record` plan-proposal rules.
- Goal, progress and transcript truncation is Unicode-code-point safe and
  visibly marked. The transcript remains limited to the newest 24 accepted
  messages and additionally receives only the remaining character budget.
- Assessment guidance documents every currently supported optional field,
  tells Agents to report only justified values and requires the designated
  Reviewer to emit an explicit approval opinion.

## Public and Web Boundary

The existing Discussion HTTP projection, policy inputs and Web progress model
do not change. No new user decision or visible state is introduced, so this
slice requires no Web implementation. The Server-authored Run instruction and
the internal aggregation rule are the only behavioral surfaces.

## Non-Goals

This slice does not validate `newEvidenceRefs`, change plateau novelty,
introduce semantic or embedding calls, alter finalizer or participant
selection, add policy presets, or change quorum and late-evidence semantics.
`DISC-014` owns evidence verification and lexical near-duplicate handling.

## Required Evidence

`DISC-013` may become `DONE` only when focused tests prove:

1. a current explicit Reviewer rejection revokes prior approval, a current
   approval can replace rejection, and absence of an explicit current opinion
   retains the previous value;
2. callback permutations produce the same review projection;
3. maximum-size goal/progress/transcript inputs keep the instruction within the
   code-point boundary without splitting Unicode characters;
4. contribution and finalization instructions retain current identity, Task,
   every assessment field, Reviewer guidance and the complete structured plan
   proposal tail;
5. existing participant-ordered and quorum-filtered transcript behavior,
   Discussion policy, Server build and maintained documentation remain valid.

## Accepted Implementation and Evidence

The deterministic progress evaluator now collects explicit successful current-
Wave Reviewer opinions in frozen participant order. No opinion preserves the
previous value, one current opinion replaces it, and conflicting historical
opinions require unanimous approval rather than allowing arrival order or one
positive report to win.

The evidence service now reserves the current Task, Agent identity and
Discussion role, `Your Task`, complete optional assessment example, Reviewer
requirement and structured plan-proposal rules. Goal and Progress receive
independent bounded sections; the newest accepted transcript lines consume only
the remaining budget. Every truncation is Unicode-code-point safe and visibly
marked, and the final invariant rejects an oversized required frame instead of
silently dropping its tail.

Verification on 2026-09-05 produced:

- 47 focused progress and orchestration tests passed, including stale approval
  replacement, conservative conflicting opinions, an astral Unicode goal,
  long contribution replies and a retained decision-record finalization tail;
- the full Server suite passed 600 tests and removed its owned temporary root;
- the Server production TypeScript build passed;
- Markdown lint checked 379 maintained files with zero issues, and
  `git diff --check` reported no whitespace errors.

No HTTP response, Web model, user control or policy input changed, so no Web
implementation or browser acceptance was required for this slice.
