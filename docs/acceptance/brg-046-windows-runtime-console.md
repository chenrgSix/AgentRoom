# BRG-046 Windows Runtime Console Suppression

## Scope

This acceptance record covers the Windows process-creation boundary used by
managed Codex, Pi, and Generic Runtime commands. It does not change Runtime
arguments, environment allowlists, standard-stream ownership, cancellation,
session behavior, login state, or any central protocol.

The reported failure was an empty console window appearing for each Codex Run
started by the installed Windows Desktop Bridge. The packaged parent process is
a Windows GUI executable, but its managed console-subsystem child lacked an
explicit no-console creation policy. Bridge-owned stdin/stdout/stderr pipes made
that newly allocated window empty.

## Implementation evidence

- `bridge/internal/runtime/process_windows.go` applies `CREATE_NO_WINDOW` and a
  hidden startup window to every managed Runtime child before it starts.
- The existing 250 ms `WaitDelay` remains unchanged, and all adapter-specific
  stdin/stdout/stderr and cancellation paths remain at their existing owners.
- `bridge/internal/runtime/process_windows_test.go` is compiled only for
  Windows and asserts both window-suppression settings plus the preserved wait
  delay. Its name matches the existing native Windows CI `-run Windows` gate.
- The change does not invoke `cmd.exe`, wrap the configured executable in a
  shell, or special-case the npm `codex.cmd` launcher.

## Deterministic verification

On 2026-08-28, the implementation passed:

- `go test ./...`
- `go test -race ./...`
- `go vet ./...`
- `GOOS=windows GOARCH=amd64 go test -c ./internal/runtime`
- `go test -tags desktop ./cmd/convenewire-bridge-desktop`
- `go vet -tags desktop ./cmd/convenewire-bridge-desktop`
- `go build -tags desktop ./cmd/convenewire-bridge-desktop`
- `npm run lint:docs`

The Go commands used task-scoped build and module caches because the execution
sandbox cannot write the shared user caches. The macOS desktop link emitted the
existing deployment-target warnings and completed successfully.

## Exact-candidate native evidence

Annotated tag `v0.4.0-qa031.1` resolves to
`32de89e882938eb045e884ada71b018068ae4f9e`. On that exact commit,
[main CI run 33189418576](https://github.com/chenrgSix/ConveneWire/actions/runs/33189418576)
passed its native Windows Desktop job, including the Windows-specific Runtime
process regression selected by `go test ./... -run Windows`.

[Release run 33190256156](https://github.com/chenrgSix/ConveneWire/actions/runs/33190256156)
then passed tag-pinned Windows Desktop tests and vet, built the native portable
archive and current-user installer, and passed install, in-place upgrade,
uninstall, protocol-registration, and owner-state preservation checks. The
closed 22-asset verifier passed before and after Draft upload, followed by a
separate authenticated clean-download verification. Detailed hashes and the
release boundary are recorded in
[`v0.4.0-qa031.1`](../releases/v0.4.0-qa031.1.md).

## Physical Windows acceptance

On 2026-08-29 (UTC+08:00), the operator upgraded the installed Windows Desktop
Bridge to `v0.4.0-qa031.1` and started a credentialed managed Codex Run. The
operator confirmed that no empty console window appeared.

A read-only Central cross-check bound that observation to the active package
and completed execution without exposing a Device credential, local path,
prompt, output, or reply:

- the authenticated Bridge hello observed version `0.4.0-qa031.1` at
  `2026-08-28T17:44:20.314Z` on the current connection epoch;
- the Device reported an available adapter and a fresh heartbeat at
  `2026-08-28T17:46:10.347Z`; and
- the managed `Local Codex` Run started at `2026-08-28T17:45:06.981Z`, reached
  `completed` at `2026-08-28T17:45:14.494Z`, and persisted one output event,
  one reply event, and three status events.

This completes the physical window-manager condition as well as the previously
completed exact-commit native Windows condition. `BRG-046` is `DONE`.

This bounded record proves the Windows Runtime console behavior only. It is not
a schema-v4 two-machine acceptance record and does not close `QA-002`,
`QA-028`, or `QA-030`.
