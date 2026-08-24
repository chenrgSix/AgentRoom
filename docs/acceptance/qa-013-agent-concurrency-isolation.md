# QA-013 Managed Agent Concurrency Isolation

## Result

- Date: 2026-08-24
- Result: **PASS**
- Implementation commit: `fc1438d`

This acceptance covers lightweight scheduling isolation inside one managed
Bridge. It does not claim per-Run Git worktree or operating-system sandbox
isolation.

## Behavioral Evidence

- A Run is written to the durable inbox and acknowledged before it waits for an
  execution slot.
- Runs targeting one Agent acquire one FIFO slot. The second and third Runs do
  not start until the preceding holder releases it.
- A Run for another Agent starts while the first Agent remains occupied,
  preserving parallel Discussion Waves across distinct participants.
- A duplicate delivery receives another acceptance but bypasses scheduling and
  does not start a second Runtime invocation.
- An explicit cancellation removes a queued waiter, persists sequence 2 as
  `canceled`, and lets the next waiter advance without invoking the canceled
  Runtime.
- Connection loss removes a queued waiter without starting it. Existing restart
  recovery deterministically projects its durable accepted record to
  `outcome_unknown` rather than guessing that execution occurred.
- The WebSocket client distinguishes an explicit Run cancellation cause from
  parent connection shutdown, so only user cancellation emits queued
  `canceled`.

## Verification

`go test -race ./internal/delivery ./internal/connection`, `go test ./...`,
`go vet ./...`, Desktop-tagged tests, and Desktop-tagged vet passed from
`bridge/`.

Repository validation also passed `npm run validate`, `npm run build`,
`npm test`, `npm run test:e2e`, and `npm run lint:docs`. Results include 90
Server tests, 11 Web tests, four contract tests, seven schemas with 30 fixtures,
and both deterministic E2E flows. The credentialed live Codex/Pi E2E remained
explicitly skipped.
