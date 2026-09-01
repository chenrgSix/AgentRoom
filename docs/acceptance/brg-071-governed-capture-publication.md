# BRG-071 Governed Capture Publication Evidence

Date: 2026-09-01

## Scope

This increment connects the frozen RUN-018 capture intent to the existing local
Git capture and canonical Artifact/checkpoint publication path. It does not open
governed transport: the Bridge continues to publish only `prepare` until Server
plan-to-manifest validation and the full Device/Agent declaration are reviewed.
It also does not infer a Result, verify code, accept a Task or authorize cleanup.

## Reviewed Runtime Order

For the first successful Runtime terminal, the production Bridge now enforces:

1. The governed adapter has returned and the process journal proves the exact
   Run/admission/start process tree is absent with a durable `finished` record.
2. The admission fence still reproduces the exact `starting` decision; an
   abandoned prepared-only process or changed identity fails closed.
3. The current owner-local Task grant is rechecked for `capture`.
4. The Bridge derives the signed capture request and output selection only from
   the digest-covered manifest, then seals local Git output and publishes the
   exact canonical `RepositoryCheckpoint`.
5. The local admission records the observed Runtime outcome as stopped.
6. Only then is the buffered terminal status sent through the existing Inbox
   event/sequence/replay path.

Failed, canceled and input-required Runtime terminals skip capture. Missing or
post-terminal events remain protocol failures and cannot capture. If local
capture or canonical publication cannot be confirmed, the Bridge retains the
workspace/journal and sends the safe terminal `outcome_unknown` with code
`GOVERNED_CAPTURE_OUTCOME_UNKNOWN`; it does not send a false completion.

## Authority and Data Boundary

- `GovernedCaptureCoordinator` is the only production join. It cannot start a
  Runtime, propose a Result, verify code or clean a workspace.
- The capture operation ID, root Task, output slots, titles, summaries and
  optional portable report selectors come from the frozen manifest. Required
  slots, output kind/path rules and canonical request digest are validated
  before local capture.
- Local paths remain transient. Capture transport receives sealed bytes and
  bounded metadata through the existing Device-authenticated Artifact client.
- `RepositoryCheckpoint` remains an immutable observation. Explicit
  `result propose`, independent verification and human acceptance retain their
  existing separate authorities.

## Verification

- `npm run test:bridge` passed every Bridge package.
- The affected admission, repository, Artifact and Bridge-core packages passed
  `go test -race` through the run-scoped temporary-root runner.
- `go vet ./...` and `go build ./cmd/convenewire-bridge` passed through the same
  isolated runner.
- `npm test --workspace @convene-wire/contracts` passed all 79 Node checks,
  deterministic generation, strict TypeScript checks and the embedded Go wire
  tests.
- `npm test --workspace @convene-wire/server` passed 477 tests, including real
  Go capture publication, response-loss/restart recovery and current capability
  authorization coverage.
- `git diff --check`

Every verification command owned one run-scoped temporary root and printed its
exact cleanup. The focused Bridge root was also checked after exit and was
physically absent.

The focused regressions cover exact frozen request derivation/digest, required
output validation, current capture-grant denial, changed admission, unfinished
or abandoned process identity, success/capture/stop/terminal order, capture
uncertainty downgrade, non-success terminal exclusion, post-terminal protocol
failure and terminal delivery failure.

Server-side manifest derivation, capability opening, real governed product E2E,
owner-visible cleanup and physical-platform acceptance remain explicit later
gates. Full cross-platform race and native acceptance remain separate from the
focused race and local build evidence above.
