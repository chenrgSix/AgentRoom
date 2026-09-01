# QA-057 Verification Success Race Timeout

Date: 2026-09-02

## Problem and scope

The full admission/repository race gate failed twice in
`TestGovernedVerificationCoordinatorRetainsPassAndNeverRerunsJournal`. Its
success-only helper inherited a one-second profile timeout. Race instrumentation
made the test executable startup take about 1.003 seconds, so the real runner
correctly retained `timed_out` while the assertion expected `passed`.

This is a test-fixture stabilization only. Production verification timeout
handling, registered profile values, the explicit timeout/cancel/spawn/failure
cases and receipt semantics are unchanged.

## Resolution and evidence

The success-only helper budget is five seconds. The assertion still requires a
real child process, `passed`, exact journal/receipt retention, one process run,
no temporary directory residue and read-only response-loss replay.

After the change, the focused test passes ten consecutive times under the race
detector and the complete admission/repository race invocation passes through
the repository-owned temporary-root runner. Each runner prints the exact owned
root and matching `cleaned` record. The final RUN-018 acceptance will repeat the
full gate with the complete two-Bridge change set.
