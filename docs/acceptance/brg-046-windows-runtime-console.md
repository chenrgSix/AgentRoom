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
- `go test -tags desktop ./cmd/agentroom-bridge-desktop`
- `go vet -tags desktop ./cmd/agentroom-bridge-desktop`
- `go build -tags desktop ./cmd/agentroom-bridge-desktop`
- `npm run lint:docs`

The Go commands used task-scoped build and module caches because the execution
sandbox cannot write the shared user caches. The macOS desktop link emitted the
existing deployment-target warnings and completed successfully.

## Remaining native acceptance

`BRG-046` remains `ACTIVE` until both conditions are recorded:

1. Native Windows CI passes the Windows-specific process regression for the
   exact commit.
2. An installed Windows Desktop Bridge starts a credentialed Codex Run without
   opening a console window, while the Run still streams and terminates
   normally.

Cross-compilation proves the Windows source and test compile; it does not by
itself prove physical Windows window-manager behavior.
