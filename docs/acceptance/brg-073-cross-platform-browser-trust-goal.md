# BRG-073 Cross-Platform Private Browser Trust Guidance

Date: 2026-09-04

Status: goal frozen before implementation. Delivery state lives only in
`docs/TASKS.md`.

## Problem

The accepted BRG-072 implementation safely prepares a Windows browser, but its
main Console action says **Prepare another Windows browser**. On a macOS Bridge
this can imply that private-CA browser access is a Windows-only limitation or
that non-Windows computers do not participate in ConveneWire.

The actual boundary is operating-system independent: any browser on any other
computer that does not already trust the private Central CA can reject the
HTTPS connection. Public-CA Central installations remain zero-setup on normal
browsers. Private-CA installations require one explicit trust action per
computer/user and again after CA rotation.

## Goal

Make the local Bridge/Desktop entry platform-neutral and provide exact,
digest-bound preparation commands for both Windows and macOS without weakening
the BRG-072 authority boundary.

- Rename the primary action and dialog to **Prepare another computer's
  browser**.
- State before opening the dialog that Windows, macOS and Linux browsers may
  require trust when using a private CA; do not imply that one operating system
  is uniquely unsupported.
- Keep the existing current-user Windows PowerShell install/removal commands.
- Add macOS Terminal install/removal commands for the invoking user's login
  keychain. They must verify the exact canonical DER SHA-256, create one
  randomized temporary directory, register `EXIT`, `INT` and `TERM` cleanup,
  remove only that owned directory and never use `sudo` or the system keychain.
- Explain that Linux trust stores differ by distribution and browser. Do not
  generate a misleading universal command; retain the exact displayed
  fingerprint and direct the Owner to the browser/distribution trust procedure.
- Present Windows and macOS as explicit choices in one dialog. Switching or
  copying commands remains local and creates no Central request or entry
  ticket.

## Authority And Safety Boundary

- Commands derive only from the current, exact, validated
  `private_scoped_ca` public certificate already retained by Bridge.
- Bridge never executes either command, writes an OS trust store, requests
  administrator authority, exports a private key or treats copied text as proof
  of installation.
- The macOS command may mutate only the invoking user's login keychain. The
  removal command must identify the exact certificate by its full SHA-256 and
  remove its user trust settings with the certificate.
- The projection contains no Device/Server token, pairing proof, client-entry
  ticket, Team/Room/member identity, repository value, Runtime configuration,
  Central URL or Bridge-local path.
- Existing trust/scope invalidation clears all Windows and macOS command text.
  A client-entry ticket remains a separate explicit action after the target
  browser is fully restarted.

## Acceptance

Focused Go regressions must prove the macOS command embeds the same DER bytes,
checks the full SHA-256, targets only the user login keychain, uses an owned
random directory with `EXIT INT TERM` cleanup, and contains neither `sudo` nor
prohibited authority values. Its removal command must target the exact SHA-256
and user keychain.

Embedded UI regressions must prove the neutral wording, Windows/macOS choice,
correct per-platform copy, Linux limitation, no network/ticket activity,
clipboard failure honesty, and complete clearing of every command when trust
identity changes.

The focused and full Bridge suites, `go vet`, Console/pairing race coverage,
native macOS Desktop tests/build, Windows amd64 Desktop cross-build, Bridge UI,
documentation and whitespace gates must pass. A real embedded production page
must be inspected at desktop and narrow viewport sizes. No physical Windows or
second-macOS trust-store mutation is claimed by this task.
