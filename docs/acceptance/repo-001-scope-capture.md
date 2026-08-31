# REPO-001 Frozen Scope and Local Capture Evidence

Date: 2026-09-01. Scope: real local change capture after pinned preparation.
Delivery state remains in [TASKS](../TASKS.md). This increment is not formal
Artifact/checkpoint publication, Runtime admission or software-team acceptance.

## Implemented Behavior

Preparation now freezes the generated scope policy in local journal version 2.
Capture reads exact recorded identities rather than accepting caller-selected
paths or a changed scope. Files, modes and head/index observations produce a
separate immutable Git candidate and bounded full-index binary patch. The Agent
worktree/index/branch and original source are not updated.

The local record explicitly separates code collection from canonical Artifact
publication. Existing Artifact publishing uses a different source lease and is
not bypassed. A formal checkpoint must name real published outputs; this
increment does not fabricate those IDs or activate a governed Bridge capability.
The caller still has to prove current local authorization and stopped-attempt
ownership through the existing Run/inbox lifecycle before invoking capture.

## Real Git Evidence

- SHA-1 and SHA-256 fixtures capture modified and untracked content into an
  independent candidate. Agent HEAD and index bytes and original source content
  remain unchanged.
- An upstream patch outside the downstream node's allowed write prefix is part
  of its prepared baseline, not misattributed downstream output. The exported
  patch contains only the node's own permitted change.
- Forbidden paths win; forbidden edits/deletes, rename source paths, sibling
  prefix tricks and ignored output are rejected without a sealed capture.
  A changed caller policy cannot alter a prepared Run's frozen scope.
- Committed work and `assume-unchanged`/`skip-worktree` fixtures deliberately
  appear clean to ordinary Git status, but actual changed bytes are captured.
- Binary content, deletion and executable-mode changes produce a real patch;
  applying that patch to a second independently prepared worktree reconstructs
  the exact candidate tree.
- Read-only writes, changed symlinks, new index/committed gitlinks, unresolved
  index stages, changed branch/configuration/grafts/shallow boundaries and stale
  generation/operation identities fail closed. Runtime-writable Git metadata
  cannot redirect the helper through symlinks or intermediate linked directories.
- Exact replay after owner reopen returns the original capture even after later
  uncollected edits. A fault fixture removes only the final receipt and rebuilds
  that identical receipt from the sealed candidate. Different captures cannot
  overwrite the same prepared generation.
- Corrupted patch bytes are neither returned nor overwritten. Snapshot byte
  limits, canceled contexts and a real incompressible binary patch exceeding the
  current 4-MiB transport ceiling reject publication and retain diagnostics.

## Verification Scope

On macOS arm64 with Node 22.23.1, Go 1.26.7 and Apple Git 2.50.1, using a
task-specific temporary directory/cache:

- `go test -json ./internal/repository -count=1`: 42 top-level tests and 80
  passing test records, including the previous preparation regression suite.
- `go test ./...`, `go vet ./...` and a temporary-output Bridge CLI build pass.
- `go test -race ./internal/repository ./internal/ownership ./internal/delivery`
  passes.
- Repository test binaries cross-compile for Windows amd64 and Linux amd64.
- `npm run lint:docs` and `git diff --check` pass.

No live model, user repository, remote provider, PR, release or deployment is
used. Cross-compilation does not prove native Windows/Linux behavior, and these
tests do not prove that an independently running Runtime cannot write. Formal
published checkpoints, explicit checkpoint retries, exact-owned worktree
cleanup and the actual guarded Runtime/Server pipeline remain separate work.

The implementation uses the documented
[Git index-info interface](https://git-scm.com/docs/git-update-index),
[unfiltered object hashing](https://git-scm.com/docs/git-hash-object) and
[binary diff format](https://git-scm.com/docs/git-diff). These explain the
mechanisms; the temporary Git round trip is the executable evidence.
