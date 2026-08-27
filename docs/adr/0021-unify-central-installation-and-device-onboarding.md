# ADR-0021: Unify central installation and Device onboarding

- Status: Accepted
- Date: 2026-08-28
- Supersedes: none

## Context

AgentRoom already has a deployable Server and Caddy Compose profile, trusted-Team
Owner recovery, client-initiated Bridge enrollment, one Device credential per
Bridge, multiple locally configured Agents, bounded Runtime discovery, Runtime
self-test, credential rotation, and Device revocation. The current production
journey still exposes several operator steps: preparing an environment file,
generating secrets, validating Compose, starting services, checking readiness,
and separately teaching a new Bridge the deployment-level Server Token when that
gate is enabled.

The desired product outcome is one deployment operation and one Device pairing.
It does not mean one process, one Agent per Device, automatic filesystem access,
or central ownership of local Runtime configuration. It also must not weaken the
existing recovery and ambiguity rules merely to remove visible setup steps.

The current Bridge join and claim endpoints may require the long-lived central
Server Token. A flow that neither copies that Token nor places it in a pairing
link therefore needs a separate, narrowly authorized pairing-session proof. The
same design must survive approval-response loss without storing a retrievable
plaintext Device credential on the Server.

## Decision

### Product definitions

**One deployment** means that an operator invokes one installation controller
which prepares and verifies the existing multi-process deployment. The Server,
Caddy, SQLite, migration, secret, backup, and certificate boundaries remain
separate.

**One pairing** means that a Team trusts one Bridge Device once. The paired
Device may publish several Agent identities backed by locally configured Runtime
installations. Adding, editing, disabling, or removing a local Agent does not
create another Device or require another Device pairing.

Pairing grants no Workspace, Runtime, shell, network, provider-account, or Team
history access. Those authorities remain independently scoped.

### Current and target state

| Concern | Current implementation | Target extension |
| --- | --- | --- |
| Central deployment | documented Compose, Caddy, recovery file, backup and restore | reentrant `agentroomctl` lifecycle wrapper |
| Owner setup | local bootstrap or trusted-Team recovery-secret setup | guided unclaimed setup without a secret in a URL |
| Device enrollment | Bridge-created join request, Owner short-code approval, poll-token claim | Hub-created Device pairing session plus retained Bridge-created compatibility flow |
| Device authentication | random Bearer credential stored by the Bridge and hashed by the Server | unchanged for this milestone |
| Local Agents | several Codex or Pi Agent configurations on one paired Bridge | presented explicitly as Device children |
| Runtime discovery | explicit bounded local discovery | reused; no scan or probe during central approval |
| Workspace authority | local path and policy on Bridge, opaque reference and leases centrally | unchanged and made explicit in onboarding |
| Relay/Tunnel | not implemented | optional future trust boundary, not part of the first installation milestone |

Asymmetric Device proof-of-possession and operating-system credential vaults are
valid future hardening, but they require a separate authentication and migration
ADR. A public key field that is not enforced on every authenticated operation
must not be described as credential binding.

### Ownership

| State or operation | Authority |
| --- | --- |
| Installation manifest, selected network mode, generated file locations | `agentroomctl` on the central host |
| Team, Owner, pairing session, Device identity, credential hash, revocation | central Server |
| Device credential plaintext, Runtime configuration, Agent configuration | Bridge owner machine |
| Absolute Workspace path, canonicalization, local permissions, final file operation | Bridge |
| Opaque Workspace identity, generation and coordination lease | central Server |
| Certificate issuance and HTTPS termination | existing Caddy/deployment boundary |
| Optional Relay transport | future separately accepted component; never Team or credential authority |

### Installation controller

The first supported controller is a small Go CLI named `agentroomctl`. It owns no
Team business logic and does not become a second migration, backup, or recovery
implementation. It invokes the repository-owned Compose, migration, health,
backup, and restore paths and reports their exact outcomes.

The supported commands are:

```text
agentroomctl install
agentroomctl status
agentroomctl doctor
agentroomctl backup
agentroomctl restore <absolute-backup-path>
agentroomctl upgrade
agentroomctl uninstall
```

`install` performs these recoverable steps:

1. Validate the supported host, Docker/Compose version, ports, storage, and
   selected network mode.
2. Resolve an exact AgentRoom release and verify its published checksums before
   execution.
3. Create an owner-selected data root with restrictive permissions.
4. Generate the Owner recovery secret and optional legacy Server Token into
   permission-restricted files; never print their plaintext.
5. Render internal configuration atomically and validate the complete Compose
   model.
6. Start the existing Server and Caddy topology, run forward migrations, and
   wait for bounded readiness.
7. Run a non-mutating doctor check and report the public origin, recovery-file
   path and fingerprint, exact release, data root, and next action.

An installation manifest records only non-secret operator choices, generated
file paths, exact release, schema version, and the last successful step. An
exact retry resumes or confirms the same installation; it does not generate a
second authority secret, select a different data root, overwrite an existing
database, or create another Owner.

`backup` and `restore` delegate to the existing SQLite backup and staged restore
contracts. `upgrade` requires a verified backup, validates release and schema
compatibility before changing the running revision, and retains the documented
forward-only rollback boundary. A failed upgrade reports which revision remains
active.

`uninstall` stops and removes program-owned processes and configuration while
preserving the data root, recovery material, backups, and certificate state by
default. Data destruction requires a separate explicit purge operation naming
the resolved data root and is outside this milestone.

### Network modes

The controller exposes two initial modes and one reserved future mode:

| Mode | Initial support | Contract |
| --- | --- | --- |
| `local` | required | bind the application to loopback; no remote Device claim |
| `direct_https` | required | use the existing trusted-LAN or owned-domain Caddy topology and exact public origin |
| `relay_tunnel` | deferred | outbound transport only; requires a separate privacy, availability, address-ownership, and credential-isolation decision |

`direct_https` may use a public domain with ACME or a stable private-LAN origin
with an independently distributed local CA. The installer checks origin
agreement, port ownership, certificate readiness, WebSocket upgrade, and public
readiness. It reports a bounded actionable reason for DNS, port, ACME, trust,
origin, or WebSocket failure.

### Owner bootstrap

Installer process state and Hub identity state are separate. The Server does not
serve application traffic while database initialization or migration is
incomplete. Once ready, the externally meaningful Hub states are:

```text
unclaimed -> operational
```

`unclaimed` exposes only liveness/readiness, bounded setup status, and the
trusted Owner claim operation. The Owner recovery secret is read from its
permission-restricted file and submitted in an HTTPS request body; it never
appears in a URL, fragment, response, log, database, or browser storage. The
claim transaction creates or safely adopts exactly one Owner identity and then
becomes `operational`. Response loss is reconciled by reading setup status and
using the existing recovery operation; it never creates a second Owner.

Creating the first Team is the next authenticated product step, not part of the
security claim transaction. An operational Hub with no Team is a valid,
recoverable onboarding state.

Local authentication retains its loopback-only development bootstrap. The new
trusted claim path does not re-enable that route in trusted-Team mode.

### Hub-created Device pairing session

The recommended flow starts when a Team Owner chooses **Add Device**. The Server
creates a ten-minute `pairingSession` scoped to that Team and Owner. The setup
surface may show a fragment-based deep link, QR code, or human short code. The
fragment contains the high-entropy one-time claim secret and is removed before
any network request. It contains no Server Token, Device credential, Owner
secret, Runtime credential, or Team history authority.

The Bridge validates the HTTPS origin using normal system-CA trust or the
existing explicit private-deployment pin. It then creates a stable
`pairingAttemptId` and a high-entropy local poll secret. The claim request sends:

```text
pairingSessionId
claimSecret
pairingAttemptId
pollSecret
Device display name
platform and Bridge version
```

The Server stores hashes of both secrets and binds the first valid attempt to
the session. It does not receive an absolute path, Runtime command, environment,
provider account, conversation, Workspace content, or Runtime credential.
Runtime kinds are not needed to approve Device trust and are published only
after approval and authenticated connection.

After claim, both Owner and Bridge display the same bounded verification phrase
derived by the Server from the complete pairing transcript. The phrase detects
session misassociation; TLS or an explicit deployment pin remains the Server
identity proof. A phrase shown through the same compromised channel is not an
independent cryptographic identity check.

The Owner sees safe Device metadata and chooses approve or reject. Approval
atomically creates one Device, promotes the Bridge-generated poll secret to that
Device's Bearer credential, records its hash, and terminates the pairing
session. Because the Bridge generated and already holds the promoted secret,
approval-response loss is recoverable without the Server retaining or returning
credential plaintext. An exact poll retry returns the same Device identity and
terminal status.

The state machine is:

```text
issued
  -> claimed
      -> approved -> consumed
      -> rejected
  -> canceled
  -> expired
```

Only `issued -> claimed` binds an attempt. Only the creating Team Owner or
another current Team Owner may approve, reject, or cancel. `approved` creates
the Device and credential exactly once; `consumed` records that the Bridge
observed the result. Repeated create, claim, approval, and poll requests with the
same idempotency identity return the same state. A different attempt, expired
secret, reused short code, or cross-Team approval fails without revealing the
bound Device.

The existing Bridge-created join request remains a compatibility flow. Both
flows converge on the same Device, credential, revocation, Agent publication,
and audit models.

### Server Token boundary

The central Server Token remains an optional coarse deployment gate for legacy
anonymous join/pair routes. It is not Server identity, Team authority, or a
replacement for Device authentication.

The new pairing-session create and Owner-decision routes require an authenticated
Web Owner. Its Device claim and poll routes require the exact one-time session
and poll proofs, rate limiting, expiry, and transcript binding instead of the
long-lived Server Token. After approval, an exact Device credential is sufficient
for authenticated Bridge HTTP and WebSocket operations. A deployment must not
secretly require a Server Token that the successful zero-copy pairing flow never
delivered.

### Post-pairing local setup

Pairing establishes Device trust only. The paired Bridge then:

1. Performs bounded, non-executing Runtime discovery only on explicit local
   refresh.
2. Lets the local owner create or edit Agent profiles from detected candidates.
3. Lets the local owner bind each Agent to a local Workspace and policy.
4. Publishes only authenticated Agent identity, bounded capabilities, opaque
   Workspace identity, and the existing safe Runtime policy summary.
5. Runs a Runtime preflight or self-test only after explicit local action.

A local Workspace binding contains the display alias, absolute path, permitted
Agent identities, and local filesystem/network policy. Only its opaque
`workspaceRef`, alias when locally allowed, generation, capability flags, and
closed policy summary may cross the Device boundary. The Team Owner cannot use
pairing or a central control to grant broader local access.

Self-test may incur provider cost or reveal login state, so it is not an
automatic consequence of approval. It uses an isolated bounded prompt, disables
local permissions where the adapter supports that contract, exposes only a
closed safe outcome, and does not make Device connectivity depend on Runtime
readiness.

Device state, Agent presence, Runtime discovery, Runtime health, and active Run
state remain distinct projections. A single `online` or `ready` flag must not
stand in for all of them.

### Revocation and in-flight work

Device revocation immediately rejects new authentication, closes the current
connection epoch, revokes all Device credentials, disables its managed Agents,
and prevents new deliveries and Workspace leases. Queued Runs that have not
been accepted by the Bridge terminate with a bounded Device-revoked reason.

For a Run already accepted by the Bridge, socket closure cannot prove that the
Runtime stopped. The Server sends a best-effort cancel before closing when
possible, then applies the existing terminal-race rules. If a trustworthy
terminal outcome cannot be recovered, the Run becomes `outcome_unknown`; it is
never silently reported as canceled or automatically retried.

### Target HTTP surface

The target resource-oriented surface is:

```text
GET  /api/setup/status
POST /api/setup/claim

POST /api/teams/:teamId/device-pairing-sessions
GET  /api/teams/:teamId/device-pairing-sessions/:pairingSessionId
POST /api/device-pairing-sessions/:pairingSessionId/claim
POST /api/device-pairing-sessions/:pairingSessionId/poll
POST /api/teams/:teamId/device-pairing-sessions/:pairingSessionId/approve
POST /api/teams/:teamId/device-pairing-sessions/:pairingSessionId/reject
POST /api/teams/:teamId/device-pairing-sessions/:pairingSessionId/cancel
```

Every mutation carries a bounded idempotency identity. Owner reads and decisions
require Team authorization. Device claim and poll responses are `no-store`,
contain only the pairing projection needed by the Bridge, and do not permit
session enumeration.

## Alternatives

- Keep the current manual Compose and Server Token flow: rejected as the primary
  product journey because deployment details and a long-lived shared secret leak
  into ordinary onboarding.
- Pair each Agent or Runtime separately: rejected because Device trust and local
  Runtime configuration have different lifecycles.
- Store Workspace paths and permissions centrally: rejected because the Server
  cannot grant local operating-system authority and must not receive paths.
- Require asymmetric proof-of-possession in this milestone: deferred because a
  complete request-signing, key-vault, rotation, and recovery contract is needed;
  a decorative public key would add no security.
- Make a managed Relay mandatory: rejected because it creates a new data-path,
  privacy, availability, and address-ownership authority unrelated to local or
  direct-HTTPS deployment.
- Automatically probe every detected Runtime after pairing: rejected because
  probing may execute a provider, consume quota, reveal account state, or race
  active local work.

## Consequences

- The shortest supported journey no longer copies a long-lived Server Token or
  edits an environment file.
- Existing Compose, backup, restore, Caddy, Device credential, Agent publication,
  and local policy implementations remain authoritative and reusable.
- A new pairing-session protocol and Hub/Bridge presentation are required.
- Pairing-session endpoints become a narrow public attack surface and require
  strict expiry, rate limiting, non-enumerability, and negative tests.
- The first milestone supports local and direct HTTPS operation; a convenient
  public Tunnel remains visible but intentionally separate work.
- Credential proof-of-possession remains a future security improvement rather
  than an unverified claim in the onboarding release.

## Compatibility and Security

The new session flow is additive. Older Bridges continue using the existing
join-request or invitation route, including its configured Server Token. A new
Bridge may fall back only after clearly telling the local owner that the legacy
flow requires deployment configuration; it never places the Token into a URL or
diagnostic bundle.

Pairing secrets use at least 128 bits of entropy, expire after ten minutes, are
stored only as hashes, and are accepted only over HTTPS. Short codes are
rate-limited locators plus Owner confirmation, not sufficient trust proofs.
Fragment secrets are removed before network activity. Pairing, approval,
rejection, expiry, credential issuance, consumption, rotation, and revocation
produce content-free audit events.

Installation logs, manifests, doctor output, Web responses, Bridge state,
diagnostics, and analytics exclude credential plaintext, recovery secret,
absolute Workspace paths, commands, environments, provider identities, prompts,
and Workspace content. Product funnel metrics count only coarse state transitions
and duration unless an operator explicitly enables a separately documented
telemetry sink.

## Verification

- A clean supported host reaches ready `local` and `direct_https` deployments
  through one `install` invocation without editing `.env` or running OpenSSL.
- Repeating `install` after success or at every recorded crash cut preserves the
  same data root, secrets, database, public origin, and Owner authority.
- Checksum, port, DNS, ACME, origin, migration, readiness, and WebSocket failures
  produce distinct actionable outcomes without exposing secrets.
- Backup, staged restore, upgrade failure, and ordinary uninstall retain the
  existing no-overwrite and data-preservation guarantees.
- A Hub-created session completes through link, QR, and manual-code paths without
  a copied Server Token or Device credential.
- Claim, approval, and poll response loss converge on one Device and credential;
  replay, expiry, cross-Team approval, secret mismatch, competing attempts, and
  code enumeration fail.
- A paired Device publishes several Agents without another Device pairing, and a
  new Agent receives no Room or Workspace authority by implication.
- Runtime discovery and self-test remain explicit, bounded, non-persistent until
  save, and independent of Device connectivity.
- No Server row, wire payload, Web projection, audit event, diagnostic bundle, or
  log contains a local path or credential plaintext.
- Revocation stops new work immediately while accepted ambiguous execution
  converges to `outcome_unknown` instead of a false cancellation or retry.
- Deterministic Server/Bridge E2E proves exact recovery; separate physical-host
  acceptance proves TLS trust, desktop deep-link handling, and a real reconnect.
