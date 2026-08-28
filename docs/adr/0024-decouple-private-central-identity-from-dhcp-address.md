# ADR-0024: Decouple private Central identity from its DHCP address

- Status: Accepted
- Date: 2026-08-28
- Supersedes: none
- Amends: ADR-0023 exact-origin private trust and OPS-009 lifecycle ownership

## Context

A private `direct_https` installation may use a literal LAN IP as its exact
origin. That is secure while the address remains assigned, but it makes an
ordinary DHCP lease look like permanent Central identity: a lease change leaves
Caddy listening on every interface while its leaf certificate, generated
pairing links, Server Origin policy and Bridge configuration still name the old
IP.

Central needs a stable authenticated origin; it does not need a permanently
assigned interface address. Treating those as the same value is unsuitable for
local self-hosting and roaming between ordinary private networks.

## Decision

### Stable identity and replaceable transport address

The installation ID, scoped private CA, trust epoch and Device credential remain
the Central identity. A private DNS or mDNS hostname is the exact HTTPS origin;
its resolved interface address may change without changing that origin.

New private-LAN installation guidance prefers a stable hostname over a literal
DHCP address. The listener remains `0.0.0.0` under `direct_https`. ConveneWire
does not reserve a DHCP lease, edit DNS, write a hosts file, install an OS CA or
disable hostname verification.

### Existing IP installation migration

`convenewirectl migrate-private-hostname --data-root <path> --hostname <name>`
is the only supported in-place move from a ready `private_scoped_ca` literal-IP
origin to a non-loopback hostname. It keeps the HTTPS port and preserves:

- installation ID, private CA ID, CA digest and trust epoch;
- database, Owner recovery material and optional legacy Server Token;
- Compose project, release, data schema and host paths; and
- Team, Device, Agent, Runtime and Workspace authority.

The controller rejects legacy, local, public, manual, hostname-source, active
CA-rotation and malformed-target state. It snapshots generated control and
public trust files, renders an isolated candidate, validates Compose, publishes
the same-CA descriptor for the target origin, starts the complete candidate
topology, and requires normal hostname/chain HTTPS plus WebSocket readiness.
Failure restores the old descriptor and control files and converges the old
topology before reporting an error. Only a ready target is committed to the
manifest.

Changing the hostname causes Caddy to issue a new leaf certificate under the
existing private CA. It is not a CA rotation and does not advance the trust
epoch.

### Existing Bridge credential migration

A Bridge with scoped private trust may change its configured Central origin
without re-pairing only when all of the following hold:

1. existing configuration mutation fences show no enrollment, preflight,
   self-test or active Team work;
2. the current credential has no in-progress CA rotation;
3. the target is one exact HTTPS origin and normal configuration trust fields
   remain `system_ca` with no legacy leaf fingerprint;
4. a secret-free bounded bootstrap fetch returns exactly one CA whose canonical
   DER digest equals the already pinned CA digest; and
5. a second request verifies the target hostname, chain, validity and readiness
   with that CA before any Device credential is sent.

After verification, Bridge changes only the credential origin/scoped descriptor
and configuration URL. Device ID, Team ID, Owner member ID, Device token,
expiration, CA, installation ID, trust epoch, Agents and local policy remain
unchanged. Credential and configuration replacement is rollback-safe if either
local write fails. The operation never trusts a different CA, falls back to the
system store, accepts TOFU, follows redirects or disables TLS verification for
normal traffic.

Older Bridges retain the old exact-origin behavior and must be updated before
using this credential-preserving migration. A new unpaired Bridge simply pairs
against the hostname after the Central migration.

## Consequences

- DHCP address changes no longer affect a hostname-based private deployment.
- The one-time move from an existing IP remains explicit and auditable instead
  of silently changing a security origin.
- Name resolution remains an operator/network facility. Failure to resolve the
  selected hostname fails readiness without weakening TLS.
- Public-CA deployments keep their owned public DNS and ACME contract; this ADR
  does not introduce public-origin migration.

## Verification

- Controller tests cover eligible migration, exact preserved fields, same-CA
  descriptor rewrite, target readiness, active-rotation rejection and rollback
  after candidate failure.
- Bridge tests cover same-CA success with unchanged credential authority and
  rejection of a different digest, invalid target, active rotation, local write
  failure and active-work mutation.
- A live private installation moves from its literal IP to a resolvable stable
  hostname, passes `doctor`, and retains the database and installation identity.
- Current Bridge code proves credential-preserving same-CA origin migration in
  deterministic and Windows cross-compile gates. A packaged physical Windows
  reconnect remains separate platform acceptance and is not implied by the
  Central migration result.
