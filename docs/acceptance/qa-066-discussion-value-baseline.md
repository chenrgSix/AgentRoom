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
