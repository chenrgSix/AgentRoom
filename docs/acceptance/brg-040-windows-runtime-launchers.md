# BRG-040: Windows Runtime launcher compatibility

Date: 2026-08-27.

## Root cause and repair

Runtime discovery and Console preflight both treated
`Mode().Perm() & 0111 != 0` as a cross-platform executable test. Windows does
not represent launchability through Unix execute bits, so ordinary native
executables and npm command shims such as `codex.cmd` were reported as missing
or rejected before a Runtime probe could start. The CLI enrollment path had the
same latent assumption.

All discovery, readiness, preflight, configuration, and CLI enrollment checks
now use one shared platform rule:

- Windows requires a regular file with a case-insensitive `.exe`, `.com`,
  `.bat`, or `.cmd` extension and does not inspect Unix execute bits.
- Unix-like platforms continue to require a regular file with at least one
  execute bit; the filename extension is irrelevant.
- PATH discovery remains delegated to `exec.LookPath`. Bounded known-directory
  discovery checks all four Windows launcher filenames and never executes a
  candidate merely to discover it.

The change does not broaden Runtime permissions, modify configured commands,
or probe a discovered file automatically.

## Executed verification

The following gates passed on the current macOS host:

- Focused `go test` for `internal/launchable`, `internal/console`, and the
  Bridge CLI.
- Full Bridge `go test ./...` and `go vet ./...`.
- Race-enabled `go test -race ./internal/launchable ./internal/console`.
- Documentation lint with zero issues.
- Windows/amd64 test-binary compilation for `internal/launchable`,
  `internal/console`, and the Bridge CLI. This includes the Windows-only
  end-to-end discovery and authenticated draft-preflight regression.

Portable tests execute the Windows rule against `.exe`, `.com`, `.bat`, and
`.cmd` files without execute bits, reject an executable-bit `.ps1`, retain the
Unix execute-bit boundary, and verify known-directory candidate expansion.

## Native Windows boundary

The Windows desktop CI job now runs `go test ./... -run Windows` before its
existing native desktop tests and packaging checks. That gate executes an
actual Windows-only regression which passes an npm-style `codex.cmd` through
PATH discovery and the authenticated Console preflight endpoint.

This local acceptance records successful portable execution and Windows test
binary compilation. It does not claim that the new CI gate has run remotely,
that a physical Windows UI was manually exercised, or that a live Codex process
was launched from the fixture.
