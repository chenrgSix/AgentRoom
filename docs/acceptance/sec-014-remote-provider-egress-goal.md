# SEC-014 Remote Provider Egress Goal

Status: frozen on 2026-09-03. `docs/TASKS.md` remains the sole delivery-state
register. REPO-003's accepted provider binding, runtime-only credential and
authenticated lookup-before-create protocol remain authoritative; SEC-010's
fixed-origin, credential-redaction and no-provider-proxy boundaries remain
unchanged.

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
