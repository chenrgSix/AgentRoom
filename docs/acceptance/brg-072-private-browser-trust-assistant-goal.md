# BRG-072 Private Browser Trust Assistant

Date: 2026-09-04

Status: accepted on 2026-09-04. Delivery state lives only in
`docs/TASKS.md`.

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

## Implemented Result

The Console state now derives `browserTrustSetup` on demand from the active
Device credential. It reuses the Bridge transport validator, including exact
origin, trust mode, installation identity, epoch, certificate lifetime,
single-CA shape and canonical DER digest. Invalid or unavailable trust produces
no setup projection.

The projected Windows install command embeds only the validated public DER
certificate. It verifies the in-memory bytes and randomly named temporary file
against the full SHA-256 digest, resolves the system `certutil.exe`, installs
into `CurrentUser` Root, checks the process exit code and removes only its
owned temporary file in a `finally` block. A separate exact-thumbprint removal
command is included so the user can revoke that persistent current-user trust.

The Bridge/Desktop Console exposes this only behind **准备另一台 Windows
浏览器**. Opening or copying is local and performs no request. The dialog
shows the complete fingerprint, persistent-trust warning, browser-restart and
fresh-entry instructions, and exact removal path. Re-pairing, Central changes,
trust epoch changes and CA digest changes close the dialog and clear its
rendered commands.

## Acceptance Evidence

Implementation commits:

- `a79ab3d` freezes the goal, authority and acceptance boundaries before code.
- `6da2f39` implements the validated projection, Console interaction, safety
  regressions and opt-in visual fixture.

Verified commands and observations:

```text
node --test bridge/internal/console/client-entry.test.mjs
# 5 passed

npm run test:bridge-ui
# 61 passed; owned runner root removed

GOCACHE=<owned>/go-build GOMODCACHE=<owned>/go-mod GOFLAGS=-modcacherw go test ./...
GOCACHE=<owned>/go-build GOMODCACHE=<owned>/go-mod GOFLAGS=-modcacherw go vet ./...
GOCACHE=<owned>/go-build GOMODCACHE=<owned>/go-mod GOFLAGS=-modcacherw go test -race ./internal/console ./internal/pairing
GOCACHE=<owned>/go-build GOMODCACHE=<owned>/go-mod GOFLAGS=-modcacherw go test -tags desktop ./cmd/convenewire-bridge-desktop
GOCACHE=<owned>/go-build GOMODCACHE=<owned>/go-mod GOFLAGS=-modcacherw go build -tags desktop -o <owned>/convenewire-bridge-desktop ./cmd/convenewire-bridge-desktop
GOOS=windows GOARCH=amd64 GOCACHE=<owned>/go-build GOMODCACHE=<owned>/go-mod GOFLAGS=-modcacherw go build -tags desktop -o <owned>/convenewire-bridge-desktop.exe ./cmd/convenewire-bridge-desktop
# all passed; /private/tmp/convenewire-brg072-gates.j3W3zs physically absent after exit

npm run lint:docs
git diff --check
# 365 Markdown files, zero findings; whitespace clean
```

An isolated real Console fixture was inspected in the production embedded page
at the default desktop viewport and at `390x844`. Both rendered the complete
fingerprint, warning, command, restart and removal flow without clipping or
obscured controls. The fixture performed no Central request or trust-store
mutation and its owned process/root were closed afterward.

No native Windows trust-store command was executed during this acceptance.
Therefore this record proves command construction, certificate identity,
fail-closed presentation and both Darwin/Windows compilation, but does not
claim physical Windows policy or browser-store success.
