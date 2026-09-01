# ADR-0037: Own test temporary resources by run

- Status: Accepted
- Date: 2026-09-01
- Supersedes: none

## Context

ConveneWire tests create SQLite databases, Bridge data roots, repository
fixtures, generated binaries and build caches below `os.tmpdir()`. The current
top-level npm commands directly compose workspace, Go and E2E test commands.
They do not create or own one temporary root for the complete invocation.

The current checkout contains 110 JavaScript or TypeScript `mkdtemp` call sites
across 79 test files and 282 Go `t.TempDir` calls across 59 test files. Go
normally removes `t.TempDir` paths when its process exits normally. Many Node
fixtures, however, close their database or Server without deleting the
directory, and some helpers return a path without registering cleanup. Several
E2E helpers also register a child process only after asynchronous startup has
completed. Assertion, setup, spawn and timeout failures can therefore bypass
the cleanup owner.

Physical inspection found repeated `agentroom-*`, `agent-room-*`,
`convenewire-*` and `convene-wire-*` directories in both macOS temporary
locations. One retained invocation root contained 417 per-test directories and
separate Go, npm and Node compile caches. Manual deletion recovers space but
does not repair this ownership defect.

The repair must not scan or delete global temporary locations. Concurrent test
invocations and unrelated user data must remain independent.

## Decision

### One owner and one root

Every supported repository test command enters a shared Node runner. The
outermost runner creates exactly one unique root with `mkdtemp` below the
explicit caller base, or below `/private/tmp` on Darwin so Unix-domain socket
fixtures remain within `sun_path` while still belonging to the run. It records
an unpredictable owner token and the created directory identity before
starting any child process.

The root layout is:

```text
convene-wire-test-run-<unique>/
  .owner.json
  tmp/
  cache/
    go-build/
    go-mod/
    npm/
    node-compile/
```

The owner exports the exact root and token to descendants. A nested repository
test command validates both against `.owner.json`, reuses the existing root and
never deletes it. An invalid or incomplete inherited identity fails closed
instead of accepting an arbitrary path.

Only the process that successfully created the root may remove it. Before
removal it verifies the original real path and filesystem identity. Cleanup
uses the exact in-memory path; it never discovers targets with a glob, prefix
scan, age test or startup sweep. A sibling directory, including a similarly
named one, is never a cleanup target.

### Cache containment

The owner sets `TMPDIR`, `TEMP` and `TMP` to `tmp/`, and sets `GOCACHE`,
`GOMODCACHE`, `npm_config_cache` and `NODE_COMPILE_CACHE` below `cache/`.
Existing `GOFLAGS` are preserved and `-modcacherw` is appended exactly once so
the owned module cache remains removable without changing permissions on any
shared user cache.

All descendants inherit these values. Nested workspace commands must not
allocate another Go or npm cache. Direct raw tooling outside the supported
repository commands retains the tool's normal behavior and is not authority
for deleting global caches.

### Runner lifecycle

The outer runner owns one child process group on POSIX and one process tree on
Windows. Nested runners remain inside that group rather than creating detached
groups. The owner installs signal handlers before spawning the command.

For normal success, non-zero exit, spawn failure, configured timeout, `SIGINT`
or `SIGTERM`, the owner:

1. stops accepting a second terminal transition;
2. sends a graceful termination to the owned child tree;
3. waits for a bounded grace period;
4. force-terminates remaining owned children and observes their exit;
5. removes the exact run root;
6. verifies that the root no longer exists; and
7. preserves the child's exit status or the terminating signal semantics.

No process can execute cleanup after it receives `SIGKILL`. The supported
contract therefore keeps all test state under the outer owner and tests
catchable termination and parent-driven forced child termination. It does not
claim that an uncontained process can trap `SIGKILL`.

### Test fixture ownership

A shared Node test-resource helper creates temporary subdirectories and
registers `TestContext.after` immediately, before migrations, listeners or
other fallible setup. A helper that creates a directory must accept the test
context or an explicit resource owner and register its own cleanup. It may not
return an unowned path and rely on every caller to remember `rm`.

Cleanup is last-created, first-removed: child processes and sockets stop first,
then applications and databases close, then the directory is recursively
removed and its absence is checked. Direct per-test subdirectories may coexist
inside the single run root, but may not outlive their test when the helper owns
them.

Go tests continue to prefer `t.TempDir` and `t.Cleanup`. Non-test Go flows use
an immediate `defer os.RemoveAll` or an owned closer. The run owner contains
their temporary state when the complete Go test process is canceled.
Darwin socket fixtures and the Unix non-regular-file fixture use short prefixes
below inherited `os.TempDir()` rather than bypassing the owner with hard-coded
`/private/tmp` or `/tmp` paths.

### Child process ownership

Test helpers register a spawned process immediately after `spawn` returns,
before awaiting readiness. Startup failure, assertion failure and timeout use
the same idempotent stop operation. Stop escalates from graceful termination to
forced termination and always waits for the terminal process event. A helper
must not make process ownership conditional on successful readiness.

### Shell ownership

Shell scripts install `EXIT`, `INT` and `TERM` cleanup before invoking `mktemp`
and remove only the exact path assigned by that invocation. Signal handlers
retain a non-successful outcome and must not clear or scan `/private/tmp`.

## Alternatives

### Sweep matching names at startup or on a timer

Rejected. Prefixes do not prove ownership, concurrent tasks may be active, and
the sweep could delete another user's data while leaving the lifecycle defect
unchanged.

### Give every test case independent Go and npm caches

Rejected. It multiplies hundreds of megabytes per case and makes cleanup depend
on every assertion path. Per-test work directories remain allowed below the
single run root, but heavyweight caches are shared for the invocation.

### Rely only on `t.after`, `t.Cleanup` or `finally`

Rejected as the outer boundary. These mechanisms are required for prompt local
cleanup but cannot run after the complete test process is terminated. The
run-scoped owner is the process-level fallback.

### Reuse the user's normal Go and npm caches

Rejected for repository acceptance. It avoids temporary cache growth but makes
tests mutate shared user state and prevents proving that this invocation owns
and removes all generated cache bytes.

## Design Review

The pre-implementation review found and resolved these issues:

1. **Nested npm recursion could create many roots.** Nested runners now validate
   and reuse one inherited owner root.
2. **Detached nested runners could escape cancellation.** Only the outer owner
   creates a process group; nested commands remain descendants.
3. **A path string alone is unsafe deletion authority.** Cleanup also verifies
   the creator token, real path and original directory identity, and never uses
   a prefix glob.
4. **A late signal trap leaves an initialization gap.** Runner and shell signal
   handlers are installed before fallible child setup.
5. **Go module files may be read-only.** The owned invocation uses
   `GOFLAGS=-modcacherw`; no global cache permission is changed.
6. **A green test does not prove reclamation.** Acceptance checks physical
   absence after success, expected assertion failure, spawn failure, timeout,
   cancellation and parallel runs.
7. **Global before/after counts can be polluted by unrelated work.** Regression
   tests use a private outer `TMPDIR`, while a separate read-only name snapshot
   proves that this test invocation added nothing to either real macOS temporary
   location.

No unresolved design blocker remains. Implementation must preserve these
decisions rather than weakening the acceptance to exit codes alone.

## Consequences

Repository test commands become slightly more verbose internally and cold Go
module caches can make a fully isolated run slower. In exchange, every run has
one auditable owner, cache growth is bounded to that run, failure behavior is
deterministic and concurrent runs cannot delete one another.

Tests may still create many lightweight SQLite subdirectories during a run.
Fixture cleanup limits peak space, and the outer owner guarantees final
reclamation even when one fixture misses a normal terminal path.

## Compatibility and Security

This decision changes only development and acceptance tooling. It changes no
wire schema, persisted product state, production startup behavior or local
repository grant.

The deletion boundary is narrower than the current behavior: only a directory
created and identified by the current runner can be removed. No elevated
permission, global `chmod`, user-cache deletion or cross-run discovery is
introduced.

## Verification

- A controlled pre-change test leaves a known directory inside an isolated
  outer `TMPDIR`, establishing reproduction without touching global temp data.
- Runner tests cover success, assertion failure, missing executable, timeout,
  `SIGINT`/`SIGTERM`, descendant escalation and two parallel owners.
- Every case asserts the exact run root is physically absent and an unowned
  sibling sentinel remains.
- The regression suite runs at least three consecutive times in an isolated
  `TMPDIR`; each run leaves zero new `agentroom-*`, `agent-room-*`,
  `convenewire-*` or `convene-wire-*` directories.
- Focused Server, Web, contracts, Bridge, QA, site and deterministic E2E gates
  run through the owner where applicable.
- Before/after read-only snapshots of both macOS temporary locations contain no
  path created by the accepted runs.
