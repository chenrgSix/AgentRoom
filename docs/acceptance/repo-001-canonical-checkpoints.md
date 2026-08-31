# REPO-001 Canonical Capture Publication Evidence

Date: 2026-09-01. Scope: Server authorization, canonical content publication and
immutable checkpoint receipts. Delivery state remains only in [TASKS](../TASKS.md).

## Implemented Boundary

An authenticated generated `RepositoryOperationRequest` with capture action
must match the frozen Run manifest, exact approved plan/scope/grant/repository,
current isolated generation and expiry. Its immutable operation journal issues
one derived `read_capture` lease. The default Agent `read_source` route rejects
governed output; the new lease does not pretend to identify that default root.

Existing Artifact prepare/chunk/seal/bind endpoints carry actual bytes.
Capture authority and each new canonical write share a SQLite write transaction.
Binding retains exact cross-Task input provenance and does not weaken ordinary
same-Task Artifact relations. No new Blob/Artifact identity authority is added.

Checkpoint sealing accepts the generated `RepositoryCheckpoint` shape, verifies
its canonical digest and exact manifest/operation pins, requires approved output
slots and real same-operation bound Artifact IDs/revisions, and hashes the
stored Blob bytes. It inserts immutable checkpoint/output evidence atomically.
An existing checkpoint prevents new writes under that capture. Exact checkpoint
response-loss replay returns the original receipt, including after lease closure;
it does not authorize a new capture, settle a Run, verify code or accept a Result.

Migration 0062 extends the source-lease table without changing existing records,
retains Artifact foreign keys, and uses the existing transactional rebuild
mechanism with foreign-key verification. Applied migrations are not rewritten.

## Evidence Cases

- Device-authenticated HTTP capture, byte upload/seal/bind, checkpoint submission,
  exact replay, operation lookup and database reopen use actual SQLite and Blob
  storage. Canonical Artifact revision and Run state are checked independently.
- Twenty checkpoint cases cover changed request/scope/grant/deadline, competing
  capture identities, default-source bypass, wrong credentials, required and
  duplicate/unapproved output slots, forged Artifact ID/revision/digest/size,
  code/input/workspace pin drift, unbound content, corrupted stored bytes,
  transaction rollback, generation changes, unknown Runs, membership/capability
  loss, expiry, revocation at every content stage and post-seal write rejection.
  A second capture cannot borrow another attempt's real Artifact even when the
  Task and bytes are identical.
- Three existing derived-output tests now use the actual capture authorization
  path while retaining their input provenance, rollback and cross-Task relation
  rejection assertions. The entire 23-case input-binding suite passes.
- A populated version-61 fixture publishes and binds real legacy content before
  upgrading. Lease/publication/content/Artifact rows and Blob bytes survive
  version 62, foreign-key checks pass, enforcement is restored, and immutable
  lease guards remain active. The five Artifact publication cases pass.

## Verification and Limits

On macOS arm64 with task-scoped temporary storage and build cache:

- Focused checkpoint/input-binding/Artifact publication suites: 48 passed.
- `npm test --workspace @convene-wire/server`: 460 passed, zero failures/skips.
- `npm run build`: all implemented workspaces passed; generated contracts remain
  current (11 schemas, 232 fixtures). The existing Web chunk-size advisory is
  non-fatal.
- `npm run test:e2e`: seven deterministic compatibility scenarios passed; the
  explicitly opt-in live Codex/Pi scenario was skipped, not claimed as evidence.
- `npm run lint:docs`: 299 files, zero issues; `git diff --check` passed.

The HTTP fixture uses a synthetic Bridge protocol peer and future-admission Run
records, with the production insertion guard restored transactionally. It does
not invoke a Runtime or prove filesystem enforcement. Candidate Git IDs are
declared fixture metadata here; actual local Git tree capture and patch round
trips are covered separately in [scope capture](repo-001-scope-capture.md).

The enrolled Bridge remains the code-observation authority; Central does not
deduce a Git tree or successful verification from patch bytes. The Go adapter
joining local capture to these publication/checkpoint endpoints, explicit
checkpoint retries, exact-owned cleanup, local grants, Runtime admission and
the full software-team E2E flow remain required. No user repository, provider,
PR, Release, deployment or production Bridge capability was changed.
