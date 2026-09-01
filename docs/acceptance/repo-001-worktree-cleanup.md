# REPO-001 Exact Worktree Cleanup Increment

## Scope and Authority

This increment implements the local worktree/branch retirement primitive. It
does not complete REPO-001, supply a production cleanup-grant or stopped-Run
adapter, expose an owner UI, start/settle a Runtime, or prove overall software-team
delivery. Current task state remains solely in TASKS.

The caller must provide synchronous `CleanupAuthority` for the exact scope. No
checkpoint, lease closure, filesystem observation or caller-supplied boolean is
treated as process-termination proof. The guard must hold current local cleanup
authority and the existing stopped-Run fence over the operation. The test guard
and future-admission metadata fixtures are explicitly not production authority.

## Implementation and Review Resolutions

- Shared confirmed-checkpoint history verifies the canonical receipt, proposal,
  publication intent, observation and retained actual patch. Resume uses that
  same validation instead of a second divergent history reader.
- Preview has no journal writes. It checks actual files twice against the sealed
  snapshot, index identity, observed HEAD, physical directory identities, exact
  owned branch and worktree registrations. Ignored/untracked changes are not
  hidden by Git status. Unexpected refs, worktrees, configuration or paths block
  cleanup.
- Confirmation binds a preview digest and exact checkpoint, not a filesystem
  path provided by the caller. State and current authority are checked again.
- Immutable intent and workspace retirement claim precede Git deletion. Once
  retirement starts, ordinary preparation cannot reopen the old workspace.
- Git removes the exact recorded worktree, and branch deletion compare-and-sets
  the recorded old commit. There is no broad prune, forced ref update or recursive
  deletion of a workspace root.
- Detached/ref-deleted step records and a tombstone support exact replay after
  response loss. Completed effects are inspected, not repeated blindly. Partial
  deletion, moved refs and conflicting step records retain an incomplete/unknown
  result. A historical completed replay cannot delete a recreated directory.
- Explicitly retained Git objects, scratch diagnostics and checkpoint bytes are
  shown in the preview. The operation is not a cache sweep or total disk purge;
  an authorized new attempt can still resume the checkpoint afterward.
- Missing, skipped, repeated or late authority callbacks fail closed; an adapter
  cannot hide a failed action by returning a successful outer result. Correct
  synchronous ownership/fencing remains the production adapter's responsibility.

## Actual Git and Process Checks

Local tests use actual temporary Git repositories for SHA-1 and SHA-256,
confirmed-capture fixture history, exact preview/confirmation, retirement and
post-retirement resume. They verify source preservation, retained scratch and
checkpoint content, read-only replay after process-owner reopening, and safe
handling of a recreated directory.

Negative checks cover uncollected tracked/untracked/ignored/deleted/staged
content; changed HEAD/branch/configuration; another ref/worktree or replacement
directory; missing confirmation or corrupt patch; unavailable authority;
wrong preview; canceled context; conflicting operation, preview, step and
workspace claims; and incomplete Git deletion after restart.

`TestCleanupFenceWaitsForActualProcessExit` starts an actual child process,
observes its ready output, rejects cleanup while its handle is live, and allows
the fixture authority only after `Wait` confirms clean exit. Every cleanup waits
for the process before removing its temporary fixture directories. This is real
process-lifecycle evidence for the adapter contract, not an actual Agent Runtime
or production grant implementation.

## Actual Server-Confirmed Checkpoint

The existing `repository-capture-go.test.ts` still runs all four response-loss
publication scenarios and checkpoint resume. Its extension starts three more Go
processes to preview, retire and replay an exact worktree using the actual
Server-confirmed checkpoint. The preceding writer fixture handles are already
terminal. Cleanup makes no HTTP writes, removes only the selected worktree/ref,
preserves the old uncollected worktree, and leaves Server checkpoint/Artifact
counts and Run state unchanged. The canonical checkpoint remains readable.

## Validation Record

Verified locally on macOS arm64 with Node 22.23.1, Go 1.26.7 and actual Git:

- Seven new top-level cleanup tests, including 29 named subcases, pass. The
  process helper is skipped as a standalone entry and runs through its parent
  test. The repeated-callback assertion also passes under the race detector.
- Full Bridge `go test -json ./...`: 337 top-level tests pass across 24 tested
  packages; five opt-in process helpers skip as standalone entries. The
  operations package has no test files.
- `go test -race ./internal/repository ./internal/artifact`, `go vet ./...` and
  the native Bridge CLI build pass. Windows/Linux amd64 repository test binaries
  cross-compile; they were not executed on those physical platforms.
- The actual Go/Server/Git publication fixture passes all four response-loss
  scenarios (five Node test cases including their parent), including the three
  added cleanup process invocations and preserved canonical checkpoint.
- `npm test` passes on the complete rerun: Server 465, Web 252, Node contracts
  78, embedded Bridge UI 56, QA evidence 45, product experience 2 and site 15;
  generated-contract/type/Go checks also pass.
- The first full npm run passed Server/Web but its code-generation test waited
  indefinitely on a live `gofmt` stdin read. After process-tree and one-second
  stack inspection, only that test child was terminated; the test recorded a
  failure and the complete run was repeated after the old process tree exited.
  The interrupted run is not counted as passing and no code-generation behavior
  was changed to bypass the check.
- All-workspace build, 303-file Markdown lint and `git diff --check` pass.
  Seven deterministic compatibility E2Es pass; the separately opt-in live
  Codex/Pi scenario remains skipped, not production Runtime acceptance.

## Remaining Product Work

The follow-up [BRG-071 production cleanup authority](brg-071-owner-visible-cleanup.md)
now connects this primitive to a separate owner-local grant, exact stopped-Run
fence, finished-process journal and CLI preview/confirmation flow without adding
a public cleanup capability. REPO-001 still requires the complete physical
Central/Bridge/Git lifecycle, owner console UX, recovery cuts and final
complete-design audit before it can close.
