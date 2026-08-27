# ADR-0023: Default to public CA and scope private Bridge trust

- Status: Accepted
- Date: 2026-08-28
- Supersedes: none
- Amends: ADR-0021 network trust bootstrap and physical TLS acceptance

## Context

ADR-0021 made `direct_https` the network path for a second physical Device, but
allowed either a public ACME certificate or a private-LAN certificate whose CA
was distributed independently. The current controller lets Caddy select its
local CA for an IP origin, the current Bridge supports operating-system trust or
a manually supplied leaf-certificate SHA-256 pin, and the current pairing link
does not carry TLS trust bootstrap data.

That leaves the ordinary private-LAN journey dependent on importing a Caddy
root into every client operating system. It is both high-friction and wider in
scope than AgentRoom needs: installing a root changes trust for the whole user
or machine, while the Bridge needs to trust only one exact Central origin.
Leaf-certificate pinning avoids an operating-system change but breaks on leaf
renewal and has no safe pairing or rotation contract.

An account password, Owner Cookie, pairing secret, Device credential, or
verification phrase cannot replace TLS server authentication. All of those
values are sent or interpreted only after the client has selected the intended
server identity.

## Decision

### Current and target state

| Concern | Current implementation | Accepted target |
| --- | --- | --- |
| External topology | `direct_https` with Caddy | unchanged |
| New-install TLS choice | implicit Caddy behavior; an IP receives a local-CA certificate | explicit TLS profile; `public_ca` is the default and never silently falls back |
| Public certificate | Bridge `system_ca` | normal product path; no pairing trust override |
| Private certificate | operating-system CA import or manual leaf pin | pairing-scoped private CA trust for the exact Central origin |
| Pairing link | origin, session, expiry, fragment claim secret | additive origin-bound trust descriptor for private-scoped mode |
| CA installation | documented private-LAN procedure | advanced operator-selected compatibility mode only |
| Rotation | public CA renews; leaf pin changes | public renewal remains automatic; private CA uses monotonic trust epochs and overlap |

This ADR is an implementation target. Until `CON-014`, `OPS-009`, `SEC-009`,
`BRG-045`, and `WEB-048` are complete, a current private-LAN build still lacks
the scoped bootstrap and must not be presented as the no-manual-CA flow.

### TLS profiles

`direct_https` gains one explicit `--tls-profile` installation option:

| Profile | Selection | Server identity proof | Product status |
| --- | --- | --- | --- |
| `public_ca` | default | normal system trust, exact hostname, validity and chain verification | recommended |
| `private_scoped_ca` | explicit private-network choice | CA certificate pinned to one exact origin inside Bridge state | supported no-manual-CA alternative |
| `manual_ca` | explicit advanced choice | operator-managed OS or enterprise trust store | advanced compatibility only |

`local` remains loopback-only development/recovery behavior and is not a remote
Device onboarding mode. The legacy Bridge `pinned_sha256` leaf fingerprint
remains readable for compatibility, but is an advanced manual mode and is not
selected by new pairing.

For a new `direct_https` installation, omitting the TLS profile means
`public_ca`. DNS, ACME, hostname, or public-chain failure stops installation
with a bounded remediation message. The controller never silently substitutes
Caddy's local CA, disables verification, or changes to `manual_ca`.

The stable command shape is therefore `agentroomctl install --mode
direct_https` for public default and `agentroomctl install --mode direct_https
--tls-profile private_scoped_ca` for the explicit private alternative.
`--tls-profile manual_ca` is accepted only behind advanced guidance. Supplying
a TLS profile with `--mode local` is invalid.

### Origin-scoped private trust bootstrap

`private_scoped_ca` keeps Caddy as certificate authority and HTTPS terminator.
`agentroomctl` records a stable non-secret installation ID, the exact HTTPS
origin, a monotonic trust epoch, and SHA-256 of the canonical DER-encoded public
root certificate. Caddy private keys never enter the installation manifest,
Server, Web response, pairing link, Bridge diagnostics, or evidence record.

Caddy exposes the public root certificate at the fixed
`/.well-known/agentroom/bridge-ca.pem` path. The endpoint returns one bounded
PEM CA certificate, does not redirect, is cache-policy explicit, and exposes no
other Caddy state. The authenticated pairing-session projection gives Web a
closed public trust descriptor containing only:

```text
mode = private_scoped_ca
origin = exact HTTPS origin
installationId = stable non-secret installation identity
trustEpoch = monotonic positive integer
caCertificateSha256 = SHA-256 of canonical certificate DER
```

Web places the descriptor in the locally generated pairing-link fragment with
the existing claim secret. It sends neither value to a third-party QR service.
The digest and certificate are public material, but fragment placement prevents
unnecessary proxy and browser-history disclosure and binds one rendered link to
one local bootstrap transcript.

Before sending the claim secret, poll secret, Device metadata, credential, or
any authenticated request, Bridge:

1. parses and validates the exact HTTPS origin and closed trust descriptor;
2. retrieves only the fixed well-known certificate path with a bootstrap-only
   client that sends no AgentRoom secret, accepts no redirect, and has strict
   size, time, media-type, and certificate-count limits;
3. parses one CA certificate, verifies CA constraints and validity, hashes its
   canonical DER, and compares the digest in constant time;
4. builds a private certificate pool for that exact origin and retries HTTPS
   with normal hostname, chain, validity, and EKU verification; and
5. echoes the exact public descriptor in the claim so the Server can reject a
   descriptor mismatch and bind the phrase transcript; and
6. persists the origin, installation ID, epoch, certificate, and digest in
   owner-only Bridge state only after the pairing transaction is consumable.

TLS verification is never disabled on the claim, poll, WebSocket, Device HTTP,
Runtime, or evidence path. The narrowly unverified bootstrap fetch is safe only
because no secret is sent and its returned public certificate is accepted
solely after matching the out-of-band pairing-link digest. It must use a
separate client so a permissive transport cannot leak into normal requests.

The resulting private CA is scoped to the exact scheme, hostname, and port. It
is not added to the operating-system store, is not trusted for another Central,
does not weaken Web browser validation, and cannot authorize Team, Device,
Agent, Runtime, or Workspace operations.

### Pairing and browser boundaries

Public-CA pairing carries no trust descriptor and Bridge uses `system_ca`.
Private-scoped first pairing requires the canonical deep link or QR containing
the descriptor. A human short code may locate a session only when Bridge already
has valid trust for the exact origin; the short code alone is not a server
identity proof.

The transcript used for the Owner/Bridge verification phrase includes the
origin, installation ID, trust epoch, and CA digest. The phrase remains an
association check and does not replace certificate verification.

Origin-scoped pinning applies only to Bridge. It cannot make an arbitrary
browser trust a private CA. Cross-machine Web access without manual trust must
use `public_ca` or an operator-managed enterprise trust channel. A private
deployment may keep Owner Web on the Central host or an already managed browser
while pairing a remote Bridge without changing machine B's trust store. Product
copy must not instruct a user to bypass a browser certificate warning.

### Rotation and recovery

Public-CA leaf renewal remains transparent under system trust. Private-CA
rotation uses a strictly increasing trust epoch and a maximum two-certificate
overlap. While the old pinned chain is still valid, the authenticated Server may
offer the next public CA certificate and digest to the exact Device; Bridge
validates the origin, installation ID, increasing epoch, CA constraints, and
digest before staging it. After Caddy switches and the new chain succeeds, the
old trust entry may be retired after the declared overlap.

Epoch downgrade, origin or installation mismatch, unexpected extra
certificates, expired CA, digest mismatch, or loss of overlap fails closed. If
continuity is already lost, recovery is an explicit local re-pair or advanced
operator trust reset. Bridge never falls back to trust on first use, the system
store, a leaf pin, `manual_ca`, or verification-disabled TLS without an explicit
local decision.

## Ownership

| State or operation | Authority |
| --- | --- |
| TLS profile, installation ID, exact origin, trust epoch and public CA digest | `agentroomctl` installation manifest |
| Certificate issuance, leaf renewal, CA private key and HTTPS termination | Caddy |
| Closed public pairing trust projection and authenticated rotation offer | Server/Security |
| Link and QR presentation without authority inference | Web |
| Bootstrap validation, exact-origin trust store and final connection decision | Bridge |
| OS or enterprise trust-store changes | operator; never automatic AgentRoom behavior |
| Device, Agent, Runtime and Workspace authority | unchanged owning modules |

## Alternatives

- Require manual root-CA installation for every private client: retained only
  as advanced compatibility because it widens trust and is too cumbersome for
  ordinary Device onboarding.
- Keep manual leaf-certificate SHA-256 pins: retained for compatibility, but
  rejected for new pairing because leaf renewal changes the certificate.
- Use trust on first use: rejected because the first network peer could become
  the permanent authority without Owner-authenticated evidence.
- Put the private CA certificate itself in the link: not selected for the first
  contract because a fixed bounded fetch plus digest keeps links smaller while
  preserving cryptographic binding.
- Treat account login or the matching phrase as server authentication: rejected
  because both occur after or through the TLS channel they would be expected to
  authenticate.
- Automatically install or remove OS roots: rejected because AgentRoom does not
  own machine-wide trust policy or elevation.

## Consequences

- The recommended internet/reachable-domain path becomes ordinary public HTTPS
  with no AgentRoom-specific certificate ceremony.
- A private-LAN Bridge can pair without changing Windows, macOS, or Linux system
  trust, while its additional trust remains limited to one Central origin.
- Private browser access still needs public or operator-managed browser trust;
  Bridge pinning is not misrepresented as a general browser solution.
- Deployment, contract, Security, Web, Bridge, rotation, evidence, and release
  work is required before the target can close physical onboarding.
- Existing installations and Bridge configs remain loadable, but are classified
  honestly as public, legacy manual-CA, or legacy leaf-pin behavior.

## Compatibility and Security

The pairing trust descriptor is additive. Its absence means `system_ca` for a
new public-CA flow or the exact previously persisted trust mode for an existing
Bridge; absence never enables private TOFU. Older Bridges cannot consume a new
private-scoped link and receive a closed upgrade-required error before any claim
secret is sent. New Bridges continue to load legacy `system_ca` and
`pinned_sha256` configurations without silently rewriting them.

An existing `direct_https` manifest without a TLS profile is inspected during
upgrade. A publicly trusted exact origin migrates to `public_ca`. A Caddy-local
or otherwise private chain remains an explicitly reported legacy/manual state
until the operator chooses and completes scoped migration; upgrade does not
alter the OS trust store, Bridge state, origin, or CA automatically.

Trust descriptors and public certificates contain no credential, but logs,
analytics, diagnostics, and committed QA evidence retain only the profile,
epoch and redacted digest prefix when needed. Claim secrets, full Device
credentials, CA private keys and full local paths remain forbidden.

## Verification

- A new `direct_https` install defaults to `public_ca`, passes public chain and
  hostname verification, and fails without silent fallback when issuance or
  trust is unavailable.
- Explicit `private_scoped_ca` installation publishes exactly one bounded public
  root and closed descriptor without exposing a CA private key.
- Link and QR pairing on a clean physical Bridge complete without OS CA import,
  leaf pin entry, verification bypass, or copied long-lived credential.
- The bootstrap client sends no secret, rejects redirects/oversize/multiple or
  non-CA certificates/digest mismatch, and cannot be reused for normal traffic.
- Every post-bootstrap HTTP and WebSocket request validates the exact origin
  through the scoped pool; another origin signed by that CA is rejected by
  scope even if its hostname certificate is otherwise valid.
- Public pairing omits the descriptor and preserves normal system validation.
- Short-code-only private bootstrap, epoch rollback, lost-overlap rotation,
  legacy-client private links, and silent trust-mode fallback fail closed.
- Existing public, manual-CA and leaf-pin configurations retain explicit
  compatibility behavior without being relabeled as the recommended path.
- `QA-030` proves deterministic trust behavior; `QA-002` and `QA-028` then rerun
  on two physical machines with either `public_ca` or `private_scoped_ca` and
  record that no manual CA was installed.
