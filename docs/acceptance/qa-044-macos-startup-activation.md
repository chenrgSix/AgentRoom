# QA-044: Acknowledged macOS startup activation

- Date: 2026-08-31
- Baseline: `f3f91ea`; decision: ADR-0030 (`cb1edce`)
- Implementation: `a676a02`, `0e68e47`
- Scope: BRG-057, BRG-058 and BRG-059
- Host: macOS 26.6.2 arm64, Go 1.26.7, Node 22.23.1
- Result: local native-process regression and build acceptance passed

## Repaired boundary

The Wails beta.12 `New`-to-`Run` notification gap recorded in QA-043 no longer
controls macOS secondary activation. The primary owns a stable flock lease
and opens a private Unix socket before constructing either Wails or Console.
A secondary waits for the listener, validates its effective user and sends one
bounded activation. Success requires an acknowledgement from the receiver.
It never constructs Console or becomes a fallback worker after forwarding
fails. An absent acknowledgement after a write remains uncertain and is not
automatically retried.

The acknowledgement covers admission into the in-memory UI intent queue,
not completion of pairing or rendering. The first launch's explicit pairing
link is reserved in that same queue before the listener is published. A wake
or exact duplicate cannot erase it; a different pending pairing is rejected.
The initial WebView carries no independent pairing fragment, and the shared
main-thread dispatcher delivers the reserved intent. A normal background
launch does not enqueue a wake.

The receiver verifies real Darwin peer credentials on both ends, limits frame
size, connection count and I/O lifetime, and rejects unsafe paths. It derives
its rendezvous from the OS temporary directory rather than `TMPDIR`. A sender
waits until the socket exists and has private permissions before dialing.
Shutdown drains the receiver and closes clients before releasing ownership;
only the same socket inode may be removed. The stable lease inode is retained.
No pairing-proof file, HTTP port, provider call or installed service was added.

## Native evidence

The macOS tests use isolated identities, real subprocesses, flock, Unix sockets
and kernel peer credentials, not just mock transport callbacks.

- A primary subprocess holds its lease while an explicit gate delays listener
  creation. A real secondary waits, then receives an acknowledgement while the
  UI dispatcher is still delayed. The primary retains exclusive ownership of
  a real temporary Console; secondary arbitration never invokes its Console
  constructor. Duplicate/wake requests coalesce, a conflicting pairing is
  rejected, and readiness delivers the reserved pairing exactly once.
- A first-launch pairing A is reserved before publishing the receiver. A
  conflicting B is sent before any duplicate A and is rejected, so the test
  cannot accidentally seed an empty queue with that duplicate. A real
  secondary's duplicate A and a wake are accepted. After A dispatches, B may
  be admitted normally.
- A receiver accepts a complete request but closes without acknowledging.
  The sender reports uncertainty, establishes no second connection and leaves
  exactly one accepted intent. Slow/incomplete clients cannot block shutdown.
- Abrupt subprocess exit leaves a stale socket. A subsequent primary safely
  reclaims it, retains the stable lease inode and can reopen Console ownership.
  Normal close preserves a replacement endpoint it did not create.
- Negative cases cover malformed/oversized/partial frames, symlink and hardlink
  leases, wrong modes, non-owned identity expectations, public or replaced
  endpoints and legacy ownership. A symlink to another same-user listener
  receives no connection or proof. The socket's bind-to-chmod window is tested
  separately: no connection before private permissions, success afterwards.
- A helper enters Cocoa on the original OS main thread. It sends a real
  self-targeted `kAEGetURL` AppleEvent, captures it through the native handler,
  forwards it to the primary socket and receives acknowledgement. Pairing and
  no-link wake pass; invalid and oversized URLs do not reach the receiver.
  Background-thread and unbounded-capture attempts are rejected. An existing
  alternative `TMPDIR` does not change the OS-selected rendezvous root.

The peer negatives compare real kernel credentials against a deliberately
wrong expected UID. They do not claim execution under a second OS account.
Fixtures assert that synthetic pairing proof is absent from files and errors.

## Executed verification

Go commands used a task-scoped `GOCACHE` and `TMPDIR`, the existing read-only
module cache and `GOPROXY=off`. Native executables and cross-compiled test
binaries were written only into the task's disposable directory.

| Gate | Result |
| --- | --- |
| Full Bridge `go test ./...` | Pass |
| Full Bridge `go test -race ./...` and `go vet ./...` | Pass |
| Native `go test -tags desktop ./cmd/convenewire-bridge-desktop -count=1` | 33 top-level tests pass; one subprocess-only helper skips in the parent suite |
| Complete desktop suite with `-race -count=1` | Pass, 18.415 seconds |
| Eight startup/URL/crash/ACK/close scenarios with `-race -count=3` | Pass, 31.210 seconds |
| Native desktop `go vet -tags desktop` and `go build -tags desktop` | Pass |
| Windows amd64 desktop `go test -c -tags desktop` and `go vet -tags desktop` | Pass; not executed on Windows |
| `npm run test:bridge-ui` | 48 pass |
| `npm run lint:docs` and `git diff --check` | Pass |

The repeated selection was
`^TestDarwin(NativeSecondary|NativeCrash|NativeAppleEvent|InitialPairing|LostAcknowledgement|Shutdown|SenderWaits|ReceiverClose)`.
The normal suite skips only its helper entry point; parent tests execute that
entry point in actual subprocesses.

Independent read-only review found the first-launch queue bypass and the
missing-socket-to-dial publication window. Both were corrected before final
tests and re-reviewed with no further definite defect found in scope.

## Limits and cleanup

- The real self-targeted AppleEvent test is not packaged LaunchServices or
  installed custom-protocol acceptance. No installer, user protocol
  registration, hosted CI, Release or production deployment was changed.
- Windows compatibility was cross-compiled and vetted on macOS. This is not
  native Windows execution, nor acceptance on older macOS versions. Native
  linking retains the local SDK 26 versus deployment-target 11 warnings.
- A released older primary without the new handshake fails explicitly and
  must be closed before using the new executable. Its lock remains a guard,
  not a retroactive reliable transport for old senders. The Console data lock
  remains the final worker boundary in mixed-version operation.
- Full JS/TS, central E2E and product/browser gates from QA-043 remain historical
  evidence; they were not rerun or relabeled as current native activation
  acceptance. No live model, real pairing, user database or configuration was
  accessed by these fixtures.

All subprocesses and short socket fixtures terminated and removed their owned
data. After confirming no open files under the disposable task directory,
its approximately 633-MB build cache, logs and generated binaries were removed.
They can be reproduced from the committed tests; pre-existing caches and user
installations were preserved.
