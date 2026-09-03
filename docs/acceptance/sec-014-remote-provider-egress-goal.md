# SEC-014 Remote Provider Egress Goal

Status: frozen and accepted on 2026-09-03. `docs/TASKS.md` remains the sole
delivery-state register. REPO-003's accepted provider binding, runtime-only
credential and authenticated lookup-before-create protocol remain
authoritative; SEC-010's fixed-origin, credential-redaction and
no-provider-proxy boundaries remain unchanged.

Classification: retained Optional Remote Evidence Extension security boundary
under ADR-0039. Its implementation, tests and `DONE` state remain valid whenever
the extension is enabled; it is not a Core completion gate.

## Goal

Put every production remote-provider connection behind one Server-owned
outbound policy before its runtime credential can cross the network:

```text
immutable metadata-only ProviderBinding
  -> current Server-local runtime credential
  -> exact fixed HTTPS origin
  -> one bounded DNS resolution for this connection
  -> reject the complete answer set if any address is unsafe
  -> pin one validated address into the native direct connection
  -> preserve the original hostname for Host, TLS SNI and certificate checks
  -> recheck the connected peer against the pinned address before HTTP bytes
  -> reject redirects and retain the existing bounded provider protocol
```

The policy is transport admission, not evidence authority. It creates no new
Team, repository, Result, verification, adoption, Git or remote-mutation
permission.

## Threat Model

The untrusted inputs are a Team Owner-supplied provider origin, DNS answers and
changes between answers, provider responses, ambient proxy variables, and
network routing that might connect somewhere other than the reviewed address.
An attacker may use IPv4, IPv6, IPv4-mapped IPv6, mixed public/private answers,
CNAME indirection, rebinding, redirects or metadata aliases to try to reach a
Server-local, Team-local, cloud-control or otherwise non-public endpoint. A
credential-bearing request must not become an SSRF primitive or disclose its
Bearer value, origin, resolved address or provider response through a safe
error or log.

Admission therefore requires public global-unicast addresses. The policy
denies private/unique-local, loopback, link-local, unspecified, multicast,
carrier-grade/shared, documentation, benchmarking, reserved and known metadata
addresses, including mapped and transition-prefix bypasses. One unsafe member
rejects the entire DNS answer set; selecting a public sibling is not allowed.
Resolution failure, an empty or malformed answer, and a connected peer that
does not equal the pin fail closed.

## Authority Boundary

- The Server process owns the egress implementation and its resolver/connector.
  Provider bindings retain only metadata; no request, Team Owner field, database
  row or environment variable may disable the policy or select a proxy.
- Credentials remain resolved only at request time after REPO-003 authority
  checks. The egress policy never persists, returns or logs the credential.
- Production accepts only the existing canonical HTTPS origin. The original
  hostname remains the HTTP Host and TLS verification/SNI identity even though
  the socket connects to the pinned address. Certificate validation remains
  enabled.
- Native direct HTTP(S) connection code ignores `HTTP_PROXY`, `HTTPS_PROXY`,
  `ALL_PROXY` and related ambient routing. Redirects are never followed.
- Deterministic tests may use the existing injected remote-provider fetch seam
  to opt into literal loopback. The opt-in is carried by the Server-owned test
  transport itself, is not serialized, has no environment/config-file switch,
  and cannot be selected by a Team Owner or ordinary provider binding.
- Every request, including lookup, create and bundle retrieval, resolves and
  pins a fresh connection. Connections are not pooled across operations.

## Compatibility

Wire schemas, stored provider bindings, operation identities, credential
resolution, authenticated lookup-before-create, response bounds, remote source
evidence, CI proofs, explicit adoption and downstream sealed bytes do not
change. Existing persisted loopback bindings can still be read but production
I/O through them fails closed; only the marked deterministic test transport may
exercise them. Existing HTTPS bindings whose complete DNS answer set is public
global unicast continue to use their original hostname and certificate rules.

No migration, Bridge, Web, MCP, Hosted-Agent, deployment variable, generic
network proxy or provider-specific GitHub/GitLab adapter is added. SEC-014
hardens the provider-neutral REPO-003 transport; a later live provider adapter
must use this same path and earn separate provider evidence.

## Required Acceptance

Completion requires focused evidence for all of the following:

1. IPv4 and IPv6 tables reject private/unique-local, loopback, link-local,
   unspecified, multicast, shared, reserved, metadata, documentation and
   mapped/transition bypass targets while admitting representative public
   global-unicast addresses.
2. A literal unsafe origin, any unsafe member of a mixed DNS answer, CNAME-like
   final unsafe answer, empty/malformed answer and rebinding to unsafe data fail
   before a credential-bearing HTTP request.
3. One resolution is pinned for one connection; a second DNS value cannot win a
   TOCTOU race, and the actual connected peer is revalidated against that pin.
4. A deterministic HTTPS server proves the original hostname is retained for
   Host and SNI, the reviewed test CA and matching hostname succeed, and an
   untrusted or wrong-host certificate fails without a verification bypass.
5. Redirects are rejected, ambient proxy variables are ignored, no connection
   is reused, and connection/DNS/TLS failure returns only closed safe codes.
6. The existing remote-provider fetch seam must explicitly carry loopback test
   admission. Default Server startup, an unmarked injected fetch, a Team Owner
   and a stored binding cannot enable it.
7. Credentials and Authorization headers do not appear in thrown errors, HTTP
   responses, logs, diagnostics, metrics, evidence views or SQLite. The
   existing binding origin remains intentional REPO-003 metadata, while
   resolved addresses, ambient proxy values and provider bodies do not enter
   egress failure detail or new persistence.
8. Concurrent calls resolve and pin independently; restart reconstructs the
   production policy, preserves no stale DNS pin and does not create a bypass.
9. Existing REPO-003 response-loss, timeout, revocation, replay, bounded-body,
   Git import, adoption, downstream-byte and temporary-root assertions pass.
10. Focused Server tests, the full Server suite, workspace build, schema,
    deterministic E2E, documentation lint and whitespace checks pass. Any live
    public DNS/provider, packet-level or physical-platform limit is reported
    separately rather than inferred from deterministic loopback tests.

## Explicit Non-goals

This task does not store or let Team Owners configure provider credentials,
add a proxy, add an allowlist UI, permit arbitrary HTTP, weaken fixed origins or
TLS, scan the network, share DNS pins across calls, retry ambiguous provider
effects, implement GitHub/GitLab behavior, mutate a remote repository, accept
webhooks, alter Hosted Agent transport, deploy the Server, publish a Release or
claim live Internet/provider acceptance.

## Delivery Evidence

The implementation is split into independently reversible commits:

- `3314f61` freezes the threat model, authority, compatibility and acceptance;
- `e80b76d` corrects the evidence text to preserve REPO-003's intentional
  provider-origin metadata while keeping credentials and resolution detail out;
- `5a3b2b4` adds and wires the direct pinned transport, production/test binding
  gate, closed errors and deterministic HTTP/HTTPS security matrix;
- `8afb7d6` makes the transport overwrite any caller-supplied Host header with
  the exact original URL authority.

Production remote-provider calls no longer use global `fetch`. The Server
resolves all final addresses for each request, rejects the complete set if any
answer is non-public, opens a new socket to the selected pin without an ambient
proxy, checks the actual peer, and only then constructs HTTP. HTTPS completes
normal certificate validation under the original hostname/SNI before the
credential-bearing request exists. Redirect locations are never followed and
connections are not pooled. The existing injected fetch seam can carry a
WeakSet-held loopback marker only when created by the deterministic egress test
factory; no binding, request field, database fact or environment variable can
set or persist it.

The seven focused tests prove IPv4/IPv6 and mapped/transition address tables,
mixed-answer and CNAME-like final-answer rejection, literal handling, exact
peer comparison, per-connection rebinding, redirect/proxy/Host handling,
closed connection failure, eight concurrent independent sockets and Server
restart. A real loopback HTTPS server with a fixed `provider.test` test CA
observes the original Host and SNI; a missing CA and wrong hostname both fail.
An authenticated lookup receives `404`, DNS changes to private before create,
and zero POST reaches the provider. Default and arbitrary unmarked injected
fetches cannot admit a loopback binding, while the marked deterministic
transport loses that capability on ordinary restart. Error inspection contains
only a closed code, not the credential, provider hostname or resolved address.

Final verification on Node.js 22.23.1 and macOS arm64:

- `node --import tsx --test
  apps/server/test/remote-provider-egress-policy.test.ts` — 7/7 pass;
- focused remote-provider boundary/binding/evidence tests — 16/16 pass;
- `npm test --workspace @convene-wire/server` — 562/562 pass and the exact
  `/private/tmp/convene-wire-test-run-tgTjTQ` root is removed;
- `npm run validate` — 14 schemas and 258 fixtures pass;
- `npm run build` — Server, Web and generated Contracts build; Vite reports
  only its existing bundle-size warning;
- `npm run test:e2e` — nine deterministic tests pass, the explicitly opt-in
  live Codex/Pi test skips, and the exact
  `/private/tmp/convene-wire-test-run-H9IOzS` root is removed;
- `npm run lint:docs` — 232 maintained Markdown files pass;
- `git diff --check` — no whitespace errors.

This evidence uses deterministic local DNS seams and loopback HTTP/HTTPS. It
does not exercise public recursive DNS, a live GitHub/GitLab/provider account,
packet-level routing or proxy appliances, a deployed container/network policy,
Linux/Windows sockets, native CA stores, NAT64 infrastructure or a physical
second machine. No provider credential, production database, deployment,
Bridge binary, remote repository or Release was changed.

## Mainline Integration Revalidation

After local merge commits `efa9ca8` and `7b3d30b`, one SEC-014 pinned transport
backs the shared `RemoteProviderClient` used by REPO-003 observations and
REPO-005 input attestations. This removes the branch-local fallback to global
`fetch` without duplicating credentials, DNS authority or retry state. The
combined provider suite passed 16 tests, including attestation response loss,
timeout and exact retry lookup through the governed test seam.

The merged `main` also passed 14-schema/258-fixture validation, all builds, 563
Server tests, 268 Web tests, 97 Contract tests, nine deterministic E2Es with
only the explicit live Codex/Pi scenario skipped, every Go Bridge package and
345-file docs lint. The Bridge repository package took 241.594 seconds and all
top-level test roots were removed. Three additional private lifecycle rounds
each passed 24 tests with zero entries after every round; the exact owning base
was physically absent afterward.

The three-round global observation stayed `/private/tmp=3/3` and macOS user
temporary directory `=212/212`. Two completed SEC-014-owned npm/node-gyp cache
directories totaling 122 MiB were then removed by exact path. The only
remaining `/private/tmp` match is an older unowned test root still held open by
two Node processes, so this integration did not delete it.
