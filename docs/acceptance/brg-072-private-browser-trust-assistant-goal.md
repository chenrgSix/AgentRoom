# BRG-072 Private Browser Trust Assistant

Date: 2026-09-04

Status: goal and acceptance criteria frozen before implementation. Delivery
state lives only in `docs/TASKS.md`.

## Goal

Make cross-machine browser entry practical for an explicitly private-CA
Central without weakening TLS identity or asking an Owner to locate and
transfer a certificate file manually.

For an already paired private-scoped installation, the local Bridge/Desktop
Console will present an optional browser-trust assistant. It will derive one
self-contained Windows PowerShell command from the exact public CA certificate
already authenticated and retained by that Bridge. The command installs only
that certificate in the invoking Windows user's root store after verifying its
full SHA-256 digest, removes its owned temporary file in every exit path, and
does not require administrator authority.

Public-CA deployment remains the zero-setup default. The assistant is an
explicit compatibility action for trusted private-LAN installations, not a
certificate-warning bypass or a new Central authority.

## Authority And Safety Boundary

- Bridge may project the current public CA certificate, full canonical DER
  digest and a deterministic setup command only after its existing
  private-scoped trust validation succeeds.
- The Console never runs the command, writes another machine's trust store,
  downloads a certificate over an unauthenticated channel or claims that a
  browser trusts the CA. The human must deliberately copy and run it in the
  intended Windows account.
- The command contains no CA private key, Device or Server token, pairing
  secret, client-entry ticket, Team/Room/member identity, repository data,
  local Bridge path or Runtime configuration.
- The command verifies the embedded DER bytes against the displayed full
  SHA-256 digest before invoking the current-user trust-store operation. It
  creates one random temporary certificate file and removes only that file in
  a `finally` path.
- A trust epoch or Central identity change invalidates the displayed setup
  projection. The UI closes and clears stale command text instead of keeping a
  previously rendered certificate.
- Installing a root is persistent trust for certificates issued by that CA,
  not a one-Room login. The UI says so, explains how to remove it, and directs
  the user to fully restart the browser before requesting a fresh one-use
  client-entry ticket.
- The existing one-use entry ticket remains independently generated only when
  the Owner clicks **进入 Team** or **打开房间**. It is never embedded in,
  copied with or retained by the trust assistant.

## Acceptance

Focused Go tests must prove:

1. public-CA, absent, malformed, non-CA and digest-mismatched credentials
   expose no assistant;
2. a valid private-scoped credential projects the exact full digest and a
   command whose embedded DER bytes decode to the retained certificate;
3. the command verifies SHA-256, uses the Windows current-user root store,
   checks the external command exit code and removes only its generated
   temporary file; and
4. the projection and command contain none of the prohibited authorities or
   local paths.

Embedded UI tests must prove:

1. the assistant is hidden by default and opens only by an explicit action;
2. opening or copying it never requests a client-entry ticket or performs a
   network request;
3. a scope/trust change closes the assistant and clears stale certificate and
   command text;
4. copy success and failure are honestly presented; and
5. the displayed warning, full fingerprint, restart and removal guidance stay
   present.

The focused Console and embedded UI suites, full Bridge tests, `go vet`, native
Desktop compile/tests, Markdown lint and whitespace checks must pass. Windows
trust-store success is not claimed without native physical evidence; the
regression contract covers command content, safety and presentation only.
