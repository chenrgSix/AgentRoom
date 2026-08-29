# WEB-049 privacy and wait-amplification acceptance

- Date: 2026-08-29
- Scope: deterministic local implementation evidence
- Result: PASS

## Boundaries under test

Rendering untrusted Markdown must not contact an arbitrary third-party image
host merely because an Agent emitted image syntax. Authentication and long-poll
traffic must not amplify into synchronous SQLite writes/queries at heartbeat or
100-millisecond cadence while preserving expiry, authorization and live wakeups.

## Implementation evidence

- Markdown classifies image sources before creating an element. Relative and
  same-origin images may load lazily without a referrer; external images become
  explicit links requiring a user action. Central CSP independently limits
  `img-src` to same-origin/data/blob sources.
- Successful Web, Device and MCP credential activity updates are conditional
  and coalesced to one durable timestamp write per credential window. Expiry,
  revocation and current authorization are still checked on every request.
- `team.wait` captures the Team change cursor before its Room snapshot, performs
  one immediate reconciliation, then blocks on committed in-memory changes
  rather than polling SQLite. Run-only changes wake with an empty non-timeout
  result, irrelevant Rooms do not query, disconnect aborts the waiter, and an
  opaque process epoch makes old or prior-process cursors resynchronize once,
  including after a backup restore moves the durable Room sequence backward.
  Current-process forged-ahead cursors still fail closed.
- Message/Run repositories enqueue wakeups inside their shared transaction and
  publish them only after the outermost commit. Rollback discards the wakeup;
  message priority subsumes a Run-only hint for the same Room. HTTP and Bridge
  routes do not publish a second wakeup for those repository-owned commits, so
  one accepted Run event advances the Team cursor exactly once.

## Negative regressions

- external Markdown image syntax creates no implicit requestable image node;
- forged/revoked/expired credentials remain rejected during write coalescing;
- a rolled-back Message or Run mutation never wakes a waiter;
- one committed Bridge Run event cannot double-advance the Team cursor;
- a change between cursor capture and SQLite read is observed rather than lost;
- a Run change immediately before the next wait call survives in the returned
  composite cursor, including legacy-cursor, Server-restart and history-rollover
  cases;
- timeout and abort perform no repeated SQLite loop.

## Verification boundary

Focused Web component/security tests, Server repository and wait query-count
tests, builds and the repository-wide `QA-036` gates cover this implementation.
Browser network inspection and production load measurement remain operational
observations rather than claims made by unit tests.
