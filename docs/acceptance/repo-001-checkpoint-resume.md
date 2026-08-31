# REPO-001 Explicit Checkpoint Resume Increment

## Scope

This increment implements owner-local code restoration into a new attempt from
an explicitly selected canonical checkpoint. It does not claim complete REPO-001,
production Run admission, actual Agent Runtime execution, independent verification,
cross-Bridge checkpoint import, owner-visible cleanup or completion of the
three-increment software-team design. Delivery state remains only in TASKS.

## Implementation and Review

- `PrepareFromCheckpoint` uses the generated prepare operation and validates its
  content digest, embedded manifest/input digests, complete scope, grant identity,
  workspace generation and deadline bounds. These checks prove content identity,
  not current local authorization or process termination.
- The selected checkpoint must match the retained confirmed canonical receipt,
  proposal, publication intent and actual sealed patch. No caller-supplied patch
  becomes a checkpoint merely because its checksum is well-formed.
- Resume retains the same approved plan/node/Task definition, criteria,
  Agent/Device, repository/base, runtime profile, output and verification policy.
  New Run/workspace/lease identities and an increasing dispatch generation are
  required. A changed repository binding or upstream receipt fails closed.
- Renewed input binding IDs and destination Run/validity intervals are distinct
  from stable upstream source identity. Comparing full old/new input digests
  would incorrectly reject legitimate retries; comparison instead freezes all
  source receipt/content/slot/order fields and validates the new byte bindings.
- Preparation applies the checkpoint patch after the approved upstream inputs
  and verifies the actual tree. It never reads the old working directory.
- The Runtime starting commit and cumulative output baseline are separate. This
  addresses the reviewed failure where a resumed attempt could publish only its
  new edits, silently dropping previously checkpointed Task work downstream.
- Version-3 resume intent and output-base pins preserve version-2 ordinary journal
  encoding. Exact replay restores missing ready receipts but never resets dirty
  work. Patch expansion remains bounded across normal inputs and checkpoint.

## Real Git and Local Journal Evidence

The new `bridge/internal/repository/resume_test.go` exercises actual temporary
Git repositories. Its local transport substitute supplies fixture Artifact IDs;
those local tests do not themselves prove Server acceptance.

Evidence includes SHA-1/SHA-256 with and without upstream patch inputs; two
consecutive resumes; renewed input grants and local grant identity; old dirty
files/index/HEAD preservation; clean exact candidate preparation; cumulative
patch application to an independent workspace; scoped output rejection; lost
ready receipts and sealed-before-checkout recovery after reopening; wrong-tree
rejection; cumulative resource limits; and original journal encoding.

Negative tests reject changed approved context, omitted checkpoint selection,
wire/digest/scope/generation/deadline substitution, foreign or changed
checkpoint identities, missing confirmation, corrupt retained bytes, foreign
source bindings and mismatched upstream bytes before a new attempt is created.

## Actual Server and Separate Go Processes

`apps/server/test/repository-capture-go.test.ts` retains all four existing
response-loss scenarios and extends the first with checkpoint resume. The old Go
processes have observed terminal `close` before the new attempt is prepared.
There is no Agent Runtime in this fixture. Future Run admission/settlement and
connection capability metadata are explicit test-only setup; production
governed-admission guards are not removed by this feature.

The extension consumes a real Server-confirmed checkpoint, leaves the old dirty
worktree unchanged, creates another independent Go-owned worktree, and publishes
new canonical Artifact/revision/checkpoint records through actual HTTP. The
Server's stored cumulative patch includes both attempts' changes and excludes
later uncollected edits. Applying it to a separate clone reproduces the actual
new candidate tree. Another Go process replays the confirmed receipt without
additional HTTP operations. Source HEAD/status, exact row counts, new Run state
and absence of local paths on the wire are asserted.

## Validation Record

- Final full Bridge run: 330 passing top-level tests across 24 tested packages,
  including nine new groups and 54 subcases for resume/ordinary-journal checks.
  Four opt-in process helpers skip in a standalone Go run; the capture helper
  is actually invoked by the Server integration fixture, not counted as a fake
  standalone pass. One operations package has no tests.
- Full `npm test`: 465 Server, 252 Web, 78 Node contract, 56 Bridge UI, 45 QA
  evidence, two product-experience and 15 site tests pass. Generated-contract and
  contract Go checks in the same command pass.
- Extended actual Go/HTTP test passes again on the final code: four fault modes
  plus parent, with 18 separate Go fixture invocations including new-attempt
  resume and confirmed resumed-publication replay.
- `go vet ./...` and repository/artifact `go test -race` pass. Final focused
  resume race checks include the new immutable input-grant and ordering cases.
- All workspace builds, 302-file Markdown lint and `git diff --check` pass.
  Web build retains its existing large-chunk warning; it is not a test failure.
- Native Bridge CLI build and Windows/Linux amd64 repository-test compilation
  pass. These are not physical-platform Runtime or filesystem acceptance.
- Compatibility E2E: seven pass; the explicitly opt-in live Codex/Pi scenario
  is skipped. It is not evidence of governed Runtime admission.

## Remaining Boundaries

The primitive is deliberately not a public resume API or Runtime launcher.
BRG-071/RUN-018 must enforce current owner-local grants, the existing stopped-Run
and explicit-retry fence, capability negotiation and durable Runtime startup.
Checkpoint identity alone is never authority to resume an unknown writer or to
delete its directory. Exact-owned cleanup, other output producers, full graph
scheduling, verification, integration and the final direction audit remain open.
