# ADR-0040: Separate LAN browser and Bridge transports

- Status: Accepted
- Date: 2026-09-04
- Supersedes: none
- Amends: ADR-0023 browser-access guidance

## Context

ADR-0023 removed operating-system CA installation from ordinary Bridge pairing
by pinning a private Central CA inside Bridge. It did not remove that ceremony
from a second computer's Web browser. A `private_scoped_ca` Central currently
publishes one HTTPS origin for both Bridge and browser traffic, so a browser on
another Windows, macOS, or Linux computer must trust the private root before it
can open a Room.

Physical Windows use exposed another compatibility problem: a correctly
installed Caddy private root can still be rejected by strict Schannel
revocation policy because the private chain publishes no usable CRL or OCSP
service. Asking a trusted-LAN user to install a root, restart the browser, and
weaken revocation policy is disproportionate to the common small-Team journey.

Plain HTTP is not equivalent to HTTPS merely because an address is private.
Another LAN device, a compromised endpoint, a hostile guest network, or local
ARP/DNS interference can observe or modify browser traffic. The product must
make that tradeoff explicit and must not weaken the machine execution channel
just to remove browser ceremony.

## Decision

### Deployment profiles

ConveneWire supports three user-visible deployment choices:

| Choice | Browser transport | Bridge transport | Intended use |
| --- | --- | --- | --- |
| LAN convenient | exact non-loopback HTTP origin | exact private-CA HTTPS origin pinned inside Bridge | explicitly trusted private LAN |
| Public secure | publicly trusted HTTPS origin | same publicly trusted HTTPS origin | owned public DNS or internet-reachable deployment |
| Private HTTPS advanced | operator-trusted private HTTPS origin | exact private-CA HTTPS origin pinned inside Bridge | enterprise/private encrypted browser traffic |

The controller network mode for the first choice is `lan_http`. Existing
`local` and `direct_https` modes retain their meanings. No existing installation
is silently downgraded, and a public-CA or manual-CA deployment never falls back
to HTTP after certificate, DNS, ACME, or readiness failure.

### Two exact origins

`CONVENE_WIRE_PUBLIC_ORIGIN` and the installation manifest's `publicOrigin`
remain the exact HTTPS machine/control origin. This preserves current Bridge
configuration, Device credentials, private trust descriptors, CA rotation,
WebSocket transport, repository authority, and operation receipts.

The Server gains `CONVENE_WIRE_BROWSER_ORIGIN`. Its absence means the historical
single-origin model. In `lan_http`, the controller derives the browser origin
deterministically from the recorded domain and HTTP port; it is not a second
operator-supplied hostname and requires no manifest-schema field. The only
permitted split is:

```text
bridge origin  = https://same-host:https-port
browser origin = http://same-host:http-port
```

Caddy serves the same Web/API application on the LAN HTTP listener while
retaining private HTTPS for Bridge HTTP and WebSocket traffic. `direct_https`
continues to redirect HTTP to the exact HTTPS origin.

### Browser sessions and entry

Trusted Web origin checks use the exact browser origin. HTTPS deployments retain
the released `__Host-agentroom_session` Cookie with `Secure`, `HttpOnly`, and
`SameSite=Strict`. LAN HTTP uses a distinct host-only Cookie name without the
reserved `__Host-` prefix or `Secure`, while retaining `HttpOnly`,
`SameSite=Strict`, exact-Origin mutation checks, expiry, revocation, and current
membership checks. Secure and insecure Cookies are never accepted
interchangeably.

The Device asks for a one-use client-entry ticket over authenticated HTTPS. A
new Server returns the exact browser origin in an authenticated response header;
a new Bridge accepts only the same HTTPS origin or an HTTP origin with the
identical hostname. An older Server omits the header and a new Bridge keeps the
historical origin. An older Bridge ignores the header and continues to open
HTTPS, so the change is rolling-compatible and adds no unknown JSON field to the
closed ticket contract.

### Lifecycle

A fresh `lan_http` installation automatically selects
`private_scoped_ca` for the Bridge channel; the operator does not select or
install that CA for browser use. Reentry, upgrade, status, doctor, backup, and
restore preserve the selected mode.

The controller provides an explicit, lock-protected browser-transport migration
between `direct_https/private_scoped_ca` and `lan_http`. It verifies the exact
installed release and current lifecycle authority, stages and validates the
candidate Compose configuration, starts the candidate, verifies both HTTPS
Bridge ingress and selected browser ingress, and only then commits the manifest.
Failure restores the previous configuration and running topology. Installation
identity, private CA, trust epoch, Owner authority, database, Device credentials,
and Team state remain unchanged. Browser sessions are not promoted across Cookie
names; the Owner or member signs in again.

## Ownership

| Fact or operation | Authority |
| --- | --- |
| network mode, HTTPS Bridge origin, derived browser origin and ports | `convenewirectl` lifecycle |
| HTTP application/HTTPS redirect and HTTPS termination | Caddy configuration selected by Operations |
| exact browser Origin, Cookie policy and session authentication | Server/Security |
| exact HTTPS Device transport and private CA pin | Bridge |
| LAN convenience versus encrypted browser traffic | installation operator |
| router, firewall, VLAN, Wi-Fi, DNS and public exposure | machine/network owner |

## Alternatives

- Make every LAN transport HTTP: rejected because Bridge bearer credentials,
  execution messages, evidence and receipts can retain automatic encryption
  without browser ceremony.
- Keep private CA installation as the ordinary browser path: retained only as
  an advanced encrypted option because cross-platform trust and revocation
  behavior is too fragile for the default small-Team journey.
- Disable Windows revocation checking: rejected because ConveneWire must not
  require a machine-wide security downgrade.
- Silently fall back from HTTPS to HTTP: rejected because network failure must
  not broaden exposure or change session transport authority.
- Put the browser origin in ticket JSON: rejected because released Bridges
  strictly reject unknown fields; an authenticated response header is additive.

## Consequences

- A second browser on an explicitly trusted LAN can enter a Team or Room without
  copying or installing a CA certificate.
- Bridge and governed execution traffic remains HTTPS and exact-origin pinned.
- LAN browser traffic, including Web session Cookies and Team content, is
  observable and mutable by an on-path LAN attacker. Product copy must state
  this plainly and must never call the mode secure.
- Public deployment continues to require public HTTPS and does not use the LAN
  mode as a certificate workaround.
- Browser transport becomes an explicit compatibility and release dimension.

## Compatibility and Security

Existing manifests and environments omit the browser origin and keep historical
HTTPS behavior. Existing `direct_https` installations are not rewritten by
upgrade. A mode change requires an explicit lifecycle command and invalidates
effective browser login continuity by changing the accepted Cookie name and
Origin; it does not revoke or rewrite Device credentials.

The HTTP listener exposes the same browser-authorized API surface because the
browser UI is same-origin. It does not expose Server port 3000, private CA keys,
Bridge credentials, repository paths, Runtime configuration, or extra authority.
Exact Origin and `SameSite=Strict` reduce cross-site request risk but cannot
protect against an on-path attacker. Operators must switch back to HTTPS before
port forwarding, reverse proxying, publishing DNS, or otherwise exposing the
browser listener outside the trusted LAN.

## Verification

- Controller tests distinguish `local`, `lan_http`, and `direct_https` across
  normalization, manifest validation, reentry, upgrade and status.
- Caddy validation proves LAN HTTP application service plus private HTTPS Bridge
  ingress, while HTTPS modes still redirect.
- Server tests prove exact split-origin admission, distinct Cookie attributes,
  cross-origin rejection, and no secure/insecure Cookie confusion.
- Bridge tests prove the authenticated browser-origin header opens exact
  same-host HTTP, rejects another host, and preserves old-Server behavior.
- Lifecycle fault tests cover validation, startup, both readiness paths,
  rollback, restart, and response loss without changing identity, CA or data.
- A disposable packaged Central plus a second physical browser proves Room entry
  without CA installation and confirms Bridge traffic remains TLS verified.
