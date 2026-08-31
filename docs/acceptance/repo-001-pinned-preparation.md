# REPO-001 Pinned Repository Preparation Evidence

Date: 2026-08-31. Scope: the owner-local preparation portion of ADR-0036.
Delivery state remains solely in [TASKS](../TASKS.md). This evidence is not
acceptance of the complete repository lifecycle or governed coding product.

## Implemented Boundary

The actual Go `repository.Preparer` reads explicitly selected temporary source
repositories and creates independent Git stores, branches and worktrees. Each
request pins the source identity, full base object, Run, operation, workspace,
generation, manifest digest and exact ordered patch inputs. Durable exclusive
claims reject identity reuse with different content. A prepared record is local
only and is not a canonical Artifact or `RepositoryCheckpoint`.

No production caller or advertised Bridge capability was added. Existing
governed-delivery rejection remains in place. Local grant enrollment/enforcement,
shared-request admission, Runtime invocation, output capture/publication,
checkpoint selection, exact-owned cleanup, scheduler integration and independent
verification still have to close their own required boundaries.

## Actual Observations

- Real Git SHA-1 and SHA-256 fixtures select an older approved commit with an
  ancestor, while the source has newer committed and uncommitted changes.
  Prepared content matches the exact approved tree; the ancestor is absent from
  the independent shallow store. Source status, refs and registered worktrees
  remain unchanged.
- Two attempts have different working directories and Git common directories.
  Writing one does not change the other or the source. Ordered upstream patches
  produce the selected candidate; real Git binary delta output is reproduced.
- Closing/reopening the owner reuses the exact prepared identity. Removing only
  the final receipt in a fault fixture recovers it from the sealed candidate and
  inspected workspace. A sealed pre-checkout candidate can finish checkout.
  An unsealed partial/conflicting attempt is retained, not blindly rerun.
- Reused operation, Run or workspace identities with changed manifests,
  generations or inputs fail. Incorrect input digests fail before state claims.
  Tracked/untracked/ignored changes, moved branches/configuration, replaced
  directories and retargeted `.git` files fail without resetting anything.
- Index `assume-unchanged` and `skip-worktree` deliberately hide modified files
  from ordinary Git status in the fixtures. Independent blob hashing still
  rejects reuse. Owned checkout attributes preserve raw committed bytes despite
  repository filter/encoding/EOL instructions.
- Executable trap fixtures prove source hooks, smudge/clean/process filters,
  fsmonitor and inherited Git configuration/trace/index/SSH/askpass overrides
  are not executed by preparation. Replacement refs are ignored. Missing
  promisor objects are not fetched; alternate object stores are rejected.
- Symlink targets remain links without modifying outside content, executable
  bits are preserved on macOS, and gitlinks remain empty. Portable paths,
  repeated-blob checkout budgets, entry limits, binary literal/delta expansion,
  output limits and cancellation have negative coverage.
- Eight simultaneous exact calls receive the same workspace. A separate actual
  OS process holds the owner lock behind a stdout/stdin barrier; the parent is
  excluded until that process exits, then prepares successfully.
- Immutable record installation rejects replacement, torn records fail closed,
  and completed operations leave no pending journal files. Private state roots
  cannot silently adopt source repositories or replaced journal directories.

## Verification

Commands run on macOS arm64 with Go 1.26.7, Node 22.23.1 and Git 2.50.1,
using a dedicated temporary root and Go cache:

```sh
go test -json ./internal/repository -count=1
go test ./...
go test -race ./internal/repository ./internal/ownership ./internal/delivery
go vet ./...
GOOS=windows GOARCH=amd64 go test -c ./internal/repository
GOOS=linux GOARCH=amd64 go test -c ./internal/repository
go build ./cmd/convenewire-bridge
```

The focused suite contains 26 top-level tests, including one subprocess helper,
and 20 named subtests (46 passing Go test records). The complete Bridge suite,
focused race suites, vet and CLI build pass. Repository documentation lint checks
297 Markdown files with zero issues; `git diff --check` also passes. All compiled
outputs use explicit paths in the dedicated temporary root. Cross-built executables
are temporary outputs, not native Windows/Linux execution. Existing Bridge
tests include the governed-execution no-start guard; no live model, real user
repository, external Git provider, PR or deployment was invoked. Browser UI and
full governed execution end-to-end acceptance are not covered by this increment.

Implementation choices were checked against the official
[Git object packing](https://git-scm.com/docs/git-pack-objects),
[worktree lifecycle](https://git-scm.com/docs/git-worktree),
[Git environment controls](https://git-scm.com/docs/git) and
[Windows file-flush requirements](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers).
These references explain mechanisms, not substitute for execution evidence.
