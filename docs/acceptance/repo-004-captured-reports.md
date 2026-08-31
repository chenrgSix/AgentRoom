# REPO-004 Captured Document and Test-Report Outputs

Date: 2026-09-01. Scope: local sealed-output production and its actual
Go/Server/Git transport. This increment does not complete REPO-004, REPO-001 or
the software-team workstream. Delivery status remains solely in TASKS.

## Implemented Boundary

`CaptureOutputDescription.path` is an optional local selector, absent for patch
outputs. It selects only a regular blob from the retained immutable candidate
and must satisfy the manifest's frozen output scope. It is not an arbitrary
filesystem path, a new cross-Task permission or a source of Runtime authority.
The collector never reopens a report from the live working directory.

All selected slots are prepared before the first transport call: capture
identity, prepared scope, object-store identity/configuration, candidate tree,
snapshot inventory and Git integrity must agree. Each report rechecks its exact
Git blob identity and size, then receives its own SHA-256 content pin. Markdown
and JSON reports are UTF-8, non-empty and at most 4 MiB; JSON must parse. The wire
uses a slot-derived safe filename and existing canonical Artifact transport.
No new wire schema or alternate content store is introduced.

The local publication intent pins report paths as well as descriptions. A
different path with identical bytes is still a changed intent. Partial publication
retains the original selection, and an exact restart uses existing upload/bind
idempotency before sealing one checkpoint. Optional selector omission preserves
the previous patch-only serialization and digest. Shared candidate validation
is reused by capture and report reads rather than maintaining a second verifier.

Reports are content claims, not independent verification observations. A JSON
field claiming tests passed cannot create a VerificationReceipt, review a Result,
complete a Task or authorize integration. The enrolled host still owns capture
observation; local grants/stopped-Run fencing and production Runtime connection
remain separate requirements.

## No-Code-Delta Reports

A plan selecting only report outputs can publish an unchanged captured tree.
Selecting a required empty patch still fails before network access. Report-only
checkpoints with an empty patch can explicitly resume in a new attempt: the
zero-byte pin must carry the empty SHA-256 digest, no empty Git apply is invoked,
and the reconstructed candidate tree must match. Ordinary patch input validation
is unchanged and still rejects empty cross-Task patches. Current authorization,
fresh attempt identities and all existing resume compatibility checks remain.

## Focused Evidence and Review

- Real SHA-1/SHA-256 repositories publish three output kinds with distinct
  content pins, preserve late uncollected edits, reopen with no extra HTTP calls,
  and restore only the sealed report in a new attempt.
- Negative cases cover path traversal, absolute/metadata paths, extensions,
  missing/duplicate/required slots, unsupported commit output, empty/invalid UTF-8
  documents, invalid JSON and oversized reports. An unchanged oversized baseline
  file isolates the publication limit from the separate patch-size limit.
- Pre-existing symlinks, directories and out-of-scope source documents cannot
  become report outputs. Changed Git configuration, candidate identity or actual
  object bytes block transport. The corruption fixture first makes only its
  disposable object file writable; it does not weaken production permissions.
- A later invalid slot produces zero transport calls, not partial earlier
  uploads. A lost report response preserves frozen title/path choices, survives
  reopening, and permits later exact cleanup without losing sealed reports.
- Zero-delta report-only publication/resume/cleanup and required-empty-patch
  rejection run on both Git object formats. A nonempty digest cannot masquerade
  as an empty resume pin.

The actual HTTP fixture's response-loss scenario now publishes patch, document
and test-report Artifacts through separate Go processes. It reads canonical
Server-stored bytes with their per-slot hashes, rejects the late working edits,
checks unchanged Task acceptance/Run state, resumes from the Server checkpoint,
and retires the worktree while retaining two checkpoints and six outputs.
Its three other recovery scenarios remain patch-only compatibility checks.
An earlier test assumed the first output was a patch; the assertion now selects
by kind, because canonical plan slot ordering may put a document first.

These processes use explicit fixture output and synthetic future-admission
metadata. They are actual Git/Go/HTTP evidence, not a real Agent Runtime,
independent verifier, browser or production local-grant acceptance.

## Validation Record

Verified locally on macOS arm64 with Node 22.23.1 and Go 1.26.7:

- Six new top-level report tests and 26 named subcases pass with actual Git.
  The existing Windows-only symlink-privilege gate applies to that one native
  subcase; macOS runs it, and other source-selection cases are not skipped.
- Full Bridge tests pass: 343 top-level tests in 24 tested packages. Five
  opt-in process helpers skip as standalone entries; the operations package
  has no test files. Repository/Artifact race checks and full Bridge vet pass.
- Full `npm test` passes: Server 465, Web 252, Node contracts 78, Bridge UI 56,
  QA evidence 45, product experience 2 and site 15, including generated/type/Go
  contract checks. The actual Go/Server/Git fixture passes five Node cases.
- Seven deterministic compatibility E2Es pass. The separately opt-in live
  Codex/Pi scenario is skipped and is not claimed as new Runtime acceptance.
- All-workspace build and 11-schema/232-fixture validation pass. The existing
  Web chunk-size warning remains visible. Markdown lint checks 304 files and
  `git diff --check` passes.
- Native CLI build and Windows/Linux amd64 repository-test cross-compilation
  pass. These binaries were not run on physical Windows/Linux hosts.

## Remaining Work

Commit Artifact production remains unsupported and fails closed; checkpoint
commit metadata is not substituted for a commit output. EXEC-006 foundation
audit, owner-local production grants/cleanup, ordinary Run admission, graph
scheduling, trusted verification, all input gates, parallel integration, Web
flows, bounded autonomy and the complete-direction audit remain required.
