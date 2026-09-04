# OPS-016 LAN browser HTTP goal and acceptance

- State: Frozen implementation goal
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

`OPS-016` may be marked `DONE` only after implementation, focused negative
tests, full relevant regressions, Caddy validation, build/vet/race gates,
documentation lint, whitespace checks, and physical temporary-directory
snapshots are recorded here. Release publication and physical Windows use remain
separate admission evidence.
