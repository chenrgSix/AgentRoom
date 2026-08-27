# BRG-043: Local Device onboarding

Date: 2026-08-28.

## Accepted behavior

The Bridge now implements the client half of ADR-0021 Device pairing without
changing the ownership of Runtime or Workspace configuration.

- The desktop app and Console accept one canonical fragment-bearing link or
  one manual short code. The CLI exposes the same flow through `pair-device`.
- The installed macOS app and Windows current-user installer register the
  `agentroom://` scheme used by the Owner Web QR. Portable clients retain link
  paste and short-code fallback.
- The claim carries only Device display name, platform and Bridge version. It
  omits the central Server Token, Agent roster, Runtime kind, command,
  environment, absolute path and Workspace policy.
- One locally generated operation ID, pairing-attempt ID and poll secret are
  retained across recoverable claim and poll response loss. Terminal
  consumption promotes that exact poll secret to the Device bearer credential.
- The Console displays the matching verification phrase, persists the exact
  local multi-Agent configuration and credential only after consumption, then
  starts the existing managed Bridge lifecycle.
- Pairing shares the existing enrollment epoch and mutation fence. Canceling
  clears local approval state, and a late callback cannot save configuration,
  start a Runtime or replace the current attempt.
- Runtime discovery remains read-only and explicit. Draft preflight, saved
  Runtime self-test, Agent editing and Workspace persistence remain separate
  local actions.

## Security and recovery evidence

Focused Go regressions simulate malformed successful responses after the
Server has processed both claim and terminal poll. The client retries the same
JSON proof, obtains one Device identity and saves the original poll secret.
The tests also reject non-canonical links, remote HTTP origins, ambiguous link
and short-code input, incomplete terminal identities and stale post-cancel
callbacks.

Console regressions hold the flow at the approval boundary to prove that the
verification phrase is projected while link claim proof and Device credential
are absent. A two-Agent Codex/Pi fixture proves both Workspace aliases and
local profiles survive the explicit save boundary. Embedded UI tests keep
pairing behind one explicit action and retain explicit Runtime preflight and
self-test actions.

Desktop regressions prove a validated pairing link is nested only in the local
WebView fragment, launch ambiguity is rejected, and both package definitions
contain the `agentroom://` registration without claiming owner application
state. The macOS metadata passes `plutil`. The Windows native installer smoke
script now verifies protocol installation, upgrade retention, uninstall
removal and owner-state preservation; that script still requires its existing
native Windows CI or physical-host gate.

## Executed gates

The following gates passed on the current macOS host:

- `go test ./...` and `go vet ./...` from `bridge/`.
- `go test -race ./internal/pairing ./internal/console`.
- `go test -tags desktop ./cmd/agentroom-bridge-desktop`.
- CLI and desktop `go build` commands.
- Windows/amd64 test-binary compilation for pairing, Console and CLI packages.
- `npm run test:bridge-ui`: 26 tests.
- `plutil -lint bridge/desktop/darwin/Info.plist`.
- `npm run lint:docs`: zero issues.

## Remaining product boundary

This acceptance completes `BRG-043`; it does not complete the Owner Web client
in `WEB-045`, unified installer delivery in `OPS-008`, or physical two-machine
acceptance in `QA-028`. QR generation belongs to the Owner Web surface; the
Bridge accepts the same registered link encoded by that QR. Native Windows
installer execution remains evidence for the later release/physical gate, not
a claim made by this macOS acceptance.
