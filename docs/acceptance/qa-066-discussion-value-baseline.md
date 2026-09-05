# QA-066 Discussion value baseline

## Frozen goal

The Owner authorized this iteration on 2026-09-05 and selected code review,
problem diagnosis and solution comparison for the real-task sample.
[ADR-0042](../adr/0042-explain-and-measure-discussion-selection.md) owns the
decision and compatibility boundary; delivery state lives only in TASKS.md.

## Acceptance criteria

- The actual finalization path selects eligible Reviewer, Task primary, then
  frozen ordinal, including unavailable and reassigned participants. Existing
  committed Waves recover their exact members and digest.
- Version 2 snapshots explain each selected member using frozen facts. Version
  1 digests remain identical and legacy records never gain fabricated reasons.
  Explicit all-member, no-question and no-match fallback remain unchanged.
- Usage distinguishes actual distinct Runs, lifecycle outcomes, unbound member
  slots and budget slots. Wall time freezes at Discussion termination; missing
  token/currency telemetry remains unknown. Late quorum work stays visible.
- Chinese and English Web views present reasons and usage with legacy fallback,
  readable desktop/mobile layout and no authority controls added.
- Three predeclared tasks compare one ordinary Agent Run against a two-member
  Discussion plus finalizer: at most 12 Runs, no retries, a 300-second ceiling
  per Run and 20-minute ceiling for model work. Both arms use the same executable,
  explicit model and input. Record source/input identity, raw answers, actual
  elapsed time, outcomes and manual rubric decisions. Failure and missing usage
  remain visible; no fabricated benchmark or cost estimate is accepted.
- Focused regressions, relevant complete suites, build/schema/docs gates,
  deterministic cross-process checks and actual built-page inspection pass.
  Owned temporary databases, credentials and processes are removed.

This freezes additional routing architecture for this iteration. It does not
claim statistical superiority, production readiness, physical-platform
acceptance, a Release or deployment.

## Selection evidence

DISC-015 passes 67 focused checks spanning selection, planning, populated SQLite
migration, repository recovery and the actual Orchestrator. The primary is
intentionally later in frozen order in the real finalization regression.
Reviewer and missing-primary fallbacks, preserved broad policies, frozen match
facts and explanation tampering are covered. Migration 0087 preserves all v1
Wave bytes and child Turns, checks foreign keys and restores immutability;
the existing hard-coded v1 digest remains exact. Server TypeScript build passes.
All focused runner roots were physically removed.

## Observed usage evidence

DISC-016 passes 48 usage and real Orchestrator checks plus Server build. The
projection counts distinct bound Runs with matching Room, Task, Agent and
trigger Message, reports unavailable bindings separately, and ignores budget
slot debits. All nine lifecycle states, duplicate input, unbound member slots,
terminal wall-time freezing and late working-to-completed transitions are
covered. The real finalizer view observes two completed Runs and one queued
Run. Tokens and currency remain null; no execution-time or cost inference is
made from Run creation or Discussion duration.

## Web evidence

WEB-072 passes nine focused Discussion UI checks and all 307 Web checks.
Actual built trusted-Team pages retain v2 reasons and the expandable digest,
show five actual Runs with three completed and two expired, and keep budget
slots and missing token/cost telemetry separate. Chinese/English and dark/light
views were inspected at 1280, 720 and 390 pixels with no horizontal document
overflow or browser warning/error. The new explanations and usage copy have
larger text and explicit light-theme contrast. Screenshots are retained locally
under ignored `var/qa-066-discussion/desktop.png` and `mobile-light.png`.
The preview uses only synthetic Team data and simulated responses.

## Combined verification and real comparison

The complete `npm test` gate passes 1,177 Node checks (615 Server, 307 Web,
101 contracts, 61 Bridge UI, 47 QA evidence, three product seeds, 15 site,
25 temporary-lifecycle and three benchmark checks), plus contracts Go.
Full workspace build, 14 schemas/258 fixtures, 389 maintained Markdown files
and whitespace checks pass. Nine deterministic cross-process E2Es pass;
the separately opted-in Codex/Pi test is skipped. Web retains the existing
large-bundle advisory. No cross-language wire envelope changed.

The final benchmark runner additionally passes four focused adapter/integration
checks after adding source hashes, partial-attempt reporting and a shared
atomic 12-invocation cap. The cap regression proves that an exhausted quota
starts no provider process.
Twelve synthetic Runs are not twelve real model calls and do not supply a
quality, model latency or monetary-cost result. The
[review packet](qa-065-discussion-benchmark.md) contains exact fixed task text,
manual rubrics, requested model, data boundary and caps. Automatic approval
initially rejected the live invocation before it ran. The Owner then explicitly
confirmed the payload, OpenAI destination and quota; the subsequent authorized
invocation completed all six arms and 12 real Runs without retries.

The [reviewed real evidence](evidence/qa-065-discussion-benchmark-2026-09-05.json)
binds clean source `24cbc83755a5c786b4fbb3134a7d566a18bd5921`, CLI `0.153.3`,
requested `gpt-5.4-mini` at low reasoning effort and unchanged benchmark hashes.
Three ordinary Runs took 55.181 seconds in total; three two-member Discussions
with Reviewer finalizers used nine Runs and 110.569 seconds. Both arms satisfy
five of nine predeclared rubric items and neither fully satisfies a task's
three composite items. The task agent reviewed every final answer with explicit
evidence; this is not independent human or blind review. The small closed-input
sample shows no rubric coverage gain and cannot establish general superiority,
production-user success rates or monetary ROI. Provider model attestation,
tokens and currency remain unknown. The primary-fallback behavior is verified
by regression tests, not by this Reviewer-present live sample.

The live runner exited successfully in 176 seconds including setup. Its exact
owned temporary root was physically absent after completion, and a read-only
process check found no remaining benchmark process. Original and reviewed
answer reports remain available without retaining fixture credentials or Team
data. QA-065 and QA-066 completion evidence is now present in the sole task
register. Discussion v1 scope remains frozen under ADR-0042.

The actual preview was signed out and stopped. Physical checks confirm that
its owned root and the full-test, deterministic-E2E and final synthetic-benchmark
roots no longer exist; no global temporary-directory scan or deletion was used.
The actual preview tab is closed. An empty browser error tab from an initial
invalid-port navigation could not be closed through Browser Use because its
internal data URL is rejected by that tool's URL policy; it contains no Team
session or data and is not a running preview process.
