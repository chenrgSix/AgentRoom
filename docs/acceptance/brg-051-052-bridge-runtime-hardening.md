# BRG-051/BRG-052 Bridge runtime hardening acceptance

- Date: 2026-08-29
- Scope: deterministic local implementation evidence
- Result: PASS for implementation; native Windows execution remains separate

## Boundaries under test

A Device credential may be attached only to the exact Central HTTPS origin at
which it was issued. Public CA validity and a legacy leaf pin authenticate an
endpoint but do not authorize bearer continuity after a host or port change.
Only the already specified authenticated same-CA scoped-private hostname
migration may preserve the credential.

One Bridge process owns one resolved data directory. Stop, restart,
configuration replacement and application close must drain the previous worker
before another worker or process owns that state. Managed Runtime cancellation
must target the whole process tree, and durable state installation must include
the directory entry where the platform exposes that primitive.

This evidence does not publish a release, mutate a running user installation,
or claim native Windows or two-physical-machine acceptance.

## Implementation evidence

- `ValidateCredentialOrigin` runs before trust rotation, WebSocket dialing, or
  any authenticated HTTP request. Console connection editing rejects public-CA
  and legacy-pin cross-origin changes with an explicit re-pairing path; the
  scoped-private migration remains narrowly allowed.
- The Console holds one owner-only `.bridge-owner.lock` from construction to
  close. Direct core execution acquires the same operating-system lock; a core
  nested under the Console borrows only the matching owner. Staged re-enrollment
  owns its new data root before the active owner is transferred.
- Stop/start, hot replacement and close use an explicit worker completion
  channel. A successor starts only after the old worker returns; multiple
  updates while draining converge on the newest accepted configuration, and a
  closed service rejects restart.
- Unix uses `flock`; Windows uses `LockFileEx`. Lock files must be regular,
  owner-only objects and symlinks are rejected.
- Generic, structured Generic, Codex App Server and Pi all execute through one
  platform runtime-command owner. Windows starts suspended, assigns the process
  to a `KILL_ON_JOB_CLOSE` Job Object before resume, retains
  `CREATE_NO_WINDOW`, and closes or terminates the Job on every teardown path.
- Configuration, credential, identity, inbox, quarantine, connection-epoch,
  Runtime-session and macOS login-item mutations flush content before atomic
  install and sync the parent namespace on Unix-like systems. Windows retains
  flushed files plus atomic replacement because Go has no portable directory
  fsync API there.

## Negative regressions

- a mismatched public-CA or legacy-pinned origin fails before the replacement
  server receives a Device or Server credential;
- a second same-process or child-process owner cannot open the same data root;
- a symbolic owner lock is rejected and the lock remains held while a nested
  core borrows it;
- stop, explicit start, repeated hot update and close cannot overlap a draining
  worker or restart a closed service;
- Windows command configuration requires both `CREATE_NO_WINDOW` and
  `CREATE_SUSPENDED`; the native-only regression creates a parent, child and
  grandchild marker process and rejects a surviving grandchild after cancel;
- durable create, replace, delete and quarantine paths return a synchronization
  failure instead of acknowledging a weaker state boundary.

## Executed local gates

```text
go test ./...
PASS

go test -race ./...
PASS

go vet ./...
PASS

go test -tags desktop ./cmd/convenewire-bridge-desktop
PASS

GOOS=windows GOARCH=amd64 go vet ./...
PASS

Windows Runtime, ownership, Console, core and CLI test binaries
cross-compiled with GOOS=windows GOARCH=amd64
PASS

go mod tidy -diff
PASS
```

The macOS full/race gates execute the Unix lock and parent-directory barriers.
The Windows source is compiled against `LockFileEx`, Job Objects and the native
test harness, but this record deliberately does not mark that binary as
executed on Windows.

## Remaining boundaries

- Native Windows CI run `33292642155` on exact commit
  `ce7627a040d06d2aa4e16ebee535a8fdf3bcb5ca` forced
  `go test -count=1 ./... -run Windows -v` and explicitly passed both
  `TestConfigureWindowsRuntimeCommandSuppressesConsoleWindow` and
  `TestWindowsRuntimeJobTerminatesGrandchild`; the Job Object execution gate is
  closed without relying on a restored Go test result.
- Fresh `QA-002`, `QA-028`, and `QA-030` two-machine evidence remains a
  separate owner-authorized acceptance run; `BRG-046` has its own native and
  physical closure record.
- Release creation, tagging and publication remain outside this task.
