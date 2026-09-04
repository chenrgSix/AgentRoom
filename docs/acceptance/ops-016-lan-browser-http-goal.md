# OPS-016 LAN browser HTTP goal and acceptance

- Scope: deterministic local implementation evidence
- Result: PASS
- Date: 2026-09-04
- Owner: Operations, with Security, Bridge and Web compatibility work
- Decision: [ADR-0040](../adr/0040-separate-lan-browser-and-bridge-transports.md)

## Goal

Deliver one explicit `lan_http` Central mode in which another computer's
ordinary browser can enter ConveneWire without installing a private CA, while
all Bridge, Device and execution traffic continues to use the existing
exact-origin private-CA HTTPS channel.

## Required behavior

1. `convenewirectl install --mode lan_http` records a non-loopback HTTPS
   `publicOrigin`, derives an exact same-host HTTP browser origin from
   `--http-port`, selects `private_scoped_ca` without an operator TLS choice,
   and rejects incompatible TLS profiles or loopback/public fallback.
2. Existing `local` and `direct_https` manifests, reentry and upgrades retain
   byte-equivalent network behavior when no browser-origin environment value is
   present.
3. Caddy serves the Web/API application on HTTP only in `lan_http`; HTTPS modes
   retain the exact redirect. HTTPS remains live in `lan_http` for Bridge
   HTTP/WebSocket and private trust.
4. Trusted Web Security accepts exactly the configured browser origin. HTTPS
   uses the released secure `__Host-` Cookie; HTTP uses a distinct host-only
   `HttpOnly; SameSite=Strict` Cookie and never accepts the secure Cookie as a
   substitute. Unsafe requests retain exact-Origin enforcement.
5. The authenticated Device ticket response advertises the exact browser origin
   in an additive header. Bridge accepts same-host HTTP, rejects host changes,
   preserves old-Server behavior when absent, and opens no browser before all
   ticket identity and expiry checks pass.
6. An explicit lifecycle migration switches only
   `direct_https/private_scoped_ca <-> lan_http`, under the existing lifecycle
   lock and exact release, secret and trust checks. It stages Compose, proves
   selected HTTP/HTTPS readiness, commits last, and restores the prior files and
   topology on every injected failure.
7. Status, doctor, install output, deployment docs and user-facing copy identify
   LAN browser HTTP as convenient but unencrypted. They never instruct users to
   disable revocation checking or imply private networks prevent on-path attacks.

## Compatibility and non-goals

- No existing installation is automatically migrated or downgraded.
- No Bridge bearer, WebSocket, Runtime, Evidence, repository or operation
  receipt crosses plain HTTP.
- No CA is installed, removed or globally trusted by Central.
- No public HTTP mode, certificate-warning bypass, revocation-policy change,
  relay, tunnel, firewall or router management is added.
- BRG-072/BRG-073 private-browser trust remains available for advanced private
  HTTPS and its accepted history is unchanged.
- This task does not publish a Release or claim physical Windows acceptance.

## Acceptance matrix

| Area | Positive evidence | Required negative evidence |
| --- | --- | --- |
| Controller | fresh/reentrant LAN mode, derived origin, upgrade preservation | TLS override, loopback, changed reentry and malformed mode rejected |
| Caddy | real config plus HTTP app/HTTPS Bridge probes | HTTPS modes still redirect; Server port and metrics stay hidden |
| Server | HTTP setup/recovery/member/client-entry sessions and exact Origin | wrong Origin/Cookie, secure-Cookie substitution and split host rejected |
| Bridge | same-host HTTP client entry from authenticated header | foreign host/scheme/path/userinfo, stale ticket and pairing change rejected |
| Migration | both directions preserve installation/CA/data and commit last | validation/start/HTTP/HTTPS/manifest faults roll back exactly |
| Regression | workspace/Bridge/controller builds and tests | public/private/local trust, rotation and entry remain unchanged |
| Cleanup | isolated success and fault roots disappear | no global prefix deletion or unrelated installation mutation |

## Completion evidence

### Implemented boundary

- The Server admits one optional same-host HTTP browser origin, gives it a
  distinct non-`Secure` host-only session Cookie, keeps exact-Origin mutation
  checks, and rejects Bridge bearer, legacy Server-token and Bridge WebSocket
  authority on proxied HTTP.
- The authenticated Device client-entry response advertises the exact browser
  origin. Bridge accepts only its configured HTTPS origin or same-host HTTP,
  retains old-Server fallback, and opens nothing before ticket and pairing
  checks pass.
- `convenewirectl install --mode lan_http` derives the browser origin, retains
  private-CA HTTPS for Bridge traffic and selects the Caddy HTTP application
  profile. Existing `local` and `direct_https` behavior remains unchanged.
- `migrate-browser-transport` is exact-release and lifecycle-lock protected,
  proves current and candidate readiness, commits the manifest last, and
  restores the exact prior environment, override, topology and readiness on
  every injected failure.
- README, Operations documentation and Bridge UI distinguish ordinary
  zero-CA LAN browser access from advanced private-browser HTTPS and explicitly
  call LAN HTTP unencrypted.

### Executed gates

```text
npm test --workspace @convene-wire/server
PASS: 598 tests; 0 failed

npm test --workspace @convene-wire/web
PASS: 277 tests; 0 failed; TypeScript check passed

npm test --workspace @convene-wire/contracts
PASS: 101 tests; generated output, strict types and Go contracts passed

npm run test:bridge
PASS: every Bridge Go package

(cd bridge && go vet ./...)
PASS

(cd bridge && go test -race ./internal/browserlaunch ./internal/console)
PASS

(cd ops/convenewirectl && go test ./... && go vet ./... &&
  go build ./cmd/convenewirectl)
PASS

npm run test:bridge-ui
PASS: 61 tests; 0 failed

npm run test:compose
PASS: Docker Compose interpolation and all Caddy profiles valid

npm run validate
PASS: 14 schemas and 258 fixtures

npm run build
PASS: Server, Web and Contracts workspaces

npm run test:temp-lifecycle
PASS: 25 tests; success, assertion failure, spawn failure, timeout, signal,
      nested and parallel cleanup plus three consecutive runs

npm run lint:docs
PASS: 371 maintained Markdown files including this acceptance update

git diff --check
PASS
```

The first full Bridge regression was run concurrently with a resource-heavy
Server suite and hit its existing package timeouts. No owned root remained.
The same complete Bridge command then passed in isolation; this acceptance uses
that isolated result rather than hiding the earlier resource-contention run.

### Physical residue check

Before the isolated acceptance loop, exact top-level enumeration of both
`/private/tmp` and the macOS user temporary directory returned no
`agentroom-*`, `agent-room-*`, `convenewire-*` or `convene-wire-*` directory.
Three consecutive iterations ran the focused Server split-origin tests, Bridge
browser-entry/Console tests and complete controller package tests under one
fresh isolated `TMPDIR`. Every child runner reported deletion, the parent was
empty before its exact `rmdir`, and the same real-directory enumeration after
the loop again returned no matching directory. No glob deletion or cleanup of
another process's path was used.

### Separate release and physical gates

This evidence does not publish a Release, migrate the currently installed
Central, update an installed Bridge/Desktop application, or claim packaged
physical Windows browser acceptance. A Windows machine receives the no-CA LAN
journey only after a future Release containing both the new Central controller
and Bridge behavior is explicitly deployed and the installation is explicitly
installed or migrated to `lan_http`.
