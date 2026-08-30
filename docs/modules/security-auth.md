# Security and Authorization

## Scope

- Prefix: `SEC`
- Planned location: central server and `bridge/`
- Owns: identity, credentials, authorization, revocation, secret boundaries

Security is a cross-cutting server and Bridge module. It owns web identity,
Team membership, MCP authentication, device pairing, and policy requirements.

## Identity Model

The managed binding is `Member -> Device -> Agent -> Runtime`. A Member may own
several Devices; a Device publishes signed Agent identities; a Runtime Session
acts only through the Agent selected for a Run. ADR-0026 adds the separate
`Team Owner -> Hosted Agent -> Central Runtime Profile` binding with no Device
or local Runtime authority. IDs are immutable and display names are never
authorization inputs.

The central server is the MVP Team and Device trust authority. The implemented
primary flow is an Owner-created, short-lived pairing session consumed by
Bridge through a deep link, QR, or bounded short-code recovery path. The older
Bridge-created join request remains compatibility behavior. In either flow the
Bridge uses a separate high-entropy poll proof, verifies the server before
sending a secret, and stores the resulting identity locally. Current builds use
normal system-CA trust or an explicit legacy leaf-certificate SHA-256 pin;
ADR-0023 adds exact-origin private CA trust without changing Team authority.
Discovery, link parsing and join creation alone never grant trust.

Web sessions and device credentials use random bearer secrets whose SHA-256
hashes are persisted; plaintext secrets are returned only when issued. Session
expiry, credential rotation, and revocation are checked before resolving the
principal. Successful Web, Device, and MCP authentication coalesces its
non-authoritative activity timestamp to at most one write per credential every
five minutes; expiry and revocation are still read and enforced on every
request. The initial local Web bootstrap may issue a session directly, but all
domain services still authorize through stable User and Member IDs.

The local bootstrap exists only in `local` auth mode, whose process must bind
to loopback. `trusted-team` mode disables `/api/bootstrap` and requires an
HTTPS public origin plus an Owner recovery secret read from a
permission-restricted file. The secret is at least 32 bytes, never appears in a
URL, response, database, browser storage, or log, and is used only for initial
setup, explicit Owner recovery, or domain-separated wrapping of ADR-0026 Hosted
provider credentials without persisting the recovery secret itself.

Trusted Web sessions use a `Secure`, `HttpOnly`, `SameSite=Strict`, host-only
Cookie, and trusted Web APIs reject legacy Web Bearer sessions. Mutations must
carry the configured same-origin `Origin`; Bridge and MCP Bearer authentication
remains unchanged. Initial setup creates an Owner or safely adopts the single
existing local Owner/bootstrap User, while ambiguous legacy identities fail
closed. A Team Owner may issue a short-lived one-time member invitation. Only
its SHA-256 hash is stored, and claiming it atomically creates the User, binds
the Member, consumes the invitation, and issues a Web session. Invitation
tokens travel in a URL fragment so reverse proxies do not receive them in
request logs.

Join requests expire after ten minutes. The database stores only hashes of the
short code and poll token; the poll token is promoted to the Device credential
only after owner approval. Claim retries return the same Device and do not
create duplicate identities. Legacy Bridge invitations also expire after ten
minutes, bind the expected Device name, Team, and Member, and are single-use.

A deployment may require a central Server Token on legacy anonymous Bridge
join/pair bootstrap routes. A legacy Bridge passes this opaque value in
`X-AgentRoom-Server-Token`; the Server compares it without logging or
persisting it. This is a simple deployment access parameter, not cryptographic
Server identity. Once any flow has issued a Device credential, authenticated
Bridge HTTP and WebSocket transport uses that Device bearer alone; presenting,
omitting, or mistyping the legacy Token cannot upgrade or downgrade the Device
principal. Team ownership, revocation, and connection epochs remain mandatory
and unchanged.

### Unified Device onboarding target

[ADR-0021](../adr/0021-unify-central-installation-and-device-onboarding.md)
adds a Hub-created pairing-session path without changing the current Device,
credential, or Agent authority. One pairing trusts one Device; local Agent and
Runtime configuration remains subordinate to that Device and never becomes an
independent pairing credential.

The pairing session is Team- and Owner-scoped and expires after ten minutes. The
Owner client generates and resends the same claim secret under one create
operation identity; the Bridge generates the poll secret. The Server stores only
their hashes and never echoes either secret. The first valid claim binds one
stable attempt and produces the same verification phrase on the authenticated
Owner surface and Bridge. Approval atomically creates one Device and promotes
the already-local poll secret to the Device Bearer credential. Claim or approval
response loss therefore returns the same Device and terminal state without
storing or reissuing credential plaintext.

The new Device claim and poll routes use the exact session proofs, expiry, rate
limit, and transcript binding instead of the long-lived central Server Token.
After approval, the exact Device credential is sufficient for authenticated
Bridge HTTP and WebSocket operations. Legacy join, pair, and deployment Token
behavior remains compatible, but a zero-copy pairing flow must not require a
Token it never delivered.

Pairing links use a URL fragment for the high-entropy claim secret. They never
contain a Device credential, Owner recovery secret, Server Token, Runtime
credential, or Team-history authority. Runtime kinds, commands, environments,
provider accounts, and Workspace metadata are unnecessary before approval and
do not enter the pairing request.

### TLS identity target

[ADR-0023](../adr/0023-default-public-ca-and-scope-private-bridge-trust.md)
makes public CA plus normal system validation the default. An account password,
Owner Cookie, pairing secret, Device credential, or matching phrase
authenticates neither the TLS endpoint nor a CA and cannot authorize a
verification bypass.

An explicitly private-scoped installation gives the authenticated Owner
projection a closed public descriptor binding the exact HTTPS origin, stable
installation ID, monotonic trust epoch and canonical public CA certificate
digest. Web carries that object only in the local pairing fragment. The Bridge
must verify the public certificate and establish an exact-origin private trust
pool before sending the claim or poll secret. Its claim echoes the public
descriptor, the Server requires an exact installation-state match, and the
phrase transcript includes it while remaining only an association check.

`SEC-009` owns Server validation and projection of this public deployment state
and authenticated next-epoch rotation offers. It cannot select a TLS profile,
read a Caddy private key, install OS trust, make a browser trust a private CA,
or override the Bridge's final TLS decision. A manual short code cannot
bootstrap private trust unless the Bridge already has valid trust for that
origin. Public sessions omit the descriptor, and absence never enables TOFU or
verification-disabled TLS.

## Authorization Rules

- Team membership gates Team-level Member and Agent administration.
- Explicit human Room participation gates Room discovery, history, messages,
  Runs, and replies; a Team role alone does not grant Room access.
- Explicit ConveneWire participation gates mentions, Discussions, and handoffs.
- Only a Team Owner may replace a Room roster, and every Team Owner remains in
  every Room roster to preserve an administration path.
- Agent ownership and capability gate managed execution.
- Only the orchestrator may create a delivery after authorization.
- Revocation blocks new sessions immediately and invalidates active epochs.

ADR-0022 adds a human Task Owner without creating a new global role. Task reads
and commands still require Room membership. The Task Owner or Team Owner may
edit canonical goal/criteria, reassign ownership, replace Agent assignments,
change scheduling/budget, review Results, and complete or cancel; assigned
Agents may propose Results only from their own Runs, and a Discussion
Orchestrator only from its owned aggregate. Agent prose, display numbers,
attention, next-action projection, or cached Workbench rows never grant
authority.

Result submission validates every source, criterion and evidence edge in the
same Task and Room. Completion acceptance validates the current definition,
criteria, and Task revisions and one eligible human reviewer. An accepted Result
cannot authorize a filesystem operation, Runtime permission, Agent assignment,
or Room access.

A manual-Agent MCP credential may propose only for that Agent and one of its
assigned Runs. A Device credential may propose only for an Agent currently
published by that Device and an exact Run assigned to both. Neither credential
can impersonate the owning Member, review a Result, acknowledge ambiguity, or
complete a Task. Server-side authorization is repeated even when Bridge or MCP
validated the payload locally.

The policy matrix is documented and tested alongside each protected endpoint.
Default behavior is deny when an identity, scope, or capability is missing.

## Local Execution Controls

The Bridge starts only owner-published Runtime configurations. Existing Runtime
command, file, network, and approval controls remain authoritative, and neither
the server nor Bridge may bypass them. Login state and Runtime credentials stay
on the owner machine.

### Central Agent provisioning

[ADR-0020](../adr/0020-authorize-central-agent-provisioning-locally.md) permits
an authenticated Web User to request a sibling Agent only on an active Device
owned by that User's exact Team Member. Team Owner role never substitutes for
Device ownership. The Server persists request metadata but never the submitted
management code and sends the request only over the Device-authenticated
outbound Bridge connection.

The Bridge locally owns `disabled`, reusable eight-digit `fixed`, and
five-minute six-digit `rotating` modes. It validates the code and exact request
under its existing configuration mutation fence. Central success means only
that the request was accepted; the normal Device-authenticated publication is
still required before the Agent becomes ready. Management codes do not grant
Room access, Run authority, filesystem access, Runtime permission, or account
recovery.

Capability negotiation is fail-closed for an active connection: an online
Bridge must advertise central provisioning support before the Server persists
or sends a request. An exact reserved-Agent publication from the exact Device
may recover a lost acceptance result because possession of that Device
credential already authorizes managed Agent publication; a Web session alone
cannot produce that proof.

### Central Hosted Agent authority

[ADR-0026](../adr/0026-add-optional-central-hosted-agents.md) permits only a
Team Owner to create, configure, test, rotate, revoke, disable, or re-enable a
Central Hosted Agent and its Runtime Profile. This is Central provider authority,
not authority over a member Device. It does not use central Agent provisioning,
a management code, Bridge pairing, MCP credentials, or a Device credential.

The Owner explicitly selects initial Room access. Every provider test and Run
revalidates Team, Agent, profile and credential revisions; normal Room/Task
membership and orchestration rules independently gate the context that may
leave Central. A fixed connection probe contains no Room, Message, Task, Agent,
or user content. Provider failure cannot weaken authorization or Central
readiness.

All configuration probes share a Server-local limit of two in-flight provider
requests and a 15-second deadline including queue time. Client disconnect and
Server shutdown abort their transport. A transport that ignores cancellation
keeps its capacity slot until settlement; timed-out callers cannot accumulate
unbounded replacement calls. These bounds are built in, not deployment inputs.
Profile mutation rejects a stale revision before probing and rechecks revision,
active work and credential revocation inside the final SQLite transaction.
Late configured-test results cannot overwrite a newer profile or a busy Agent.

Provider credentials are accepted only on write-only mutation requests and
are encrypted before SQLite persistence. Authenticated reads return provider,
model, revision, configured/revoked state, and safe test observation but never
plaintext, ciphertext, nonce/tag, wrapping metadata, or a reversible mask.
Trusted-team mode derives wrapping authority from the already loaded Owner
recovery material using a Hosted-specific domain separator. Local loopback mode
may keep database-scoped wrapping material in SQLite for restart portability;
that protects ordinary projections from plaintext but is not represented as
protection against full database theft. Neither mode adds a Hosted-specific key
file, environment variable, Docker secret, or startup argument.

Only code-defined provider presets with fixed HTTPS origins are valid in the
first version. Arbitrary URLs, cross-origin redirects, URL credentials,
plaintext HTTP, provider proxies, and tool endpoints are rejected before a
credential-bearing request. Credential values, Authorization headers, prompts,
response bodies, account/quota detail, and provider request IDs are excluded
from logs, safe errors, audit detail, diagnostics, metrics, Web state, and
backup reports.

The Hosted Adapter receives no shell, filesystem, Workspace, Docker, desktop,
local Runtime, or generic network port. Provider tool/approval requests fail
closed. A Hosted Agent may author only the ordinary output/reply of its exact
Run and handoff-shaped text subject to Server routing. The first version has no
principal capable of proposing/reviewing a formal Result, completing a Task,
acknowledging ambiguity, changing access, or calling Member-, Device-, or
MCP-owned commands.

## Data Protection

Room context, replies, handoff summaries, and logs may leave the owner machine
only after scope checks and filtering of tokens, credentials, and obvious
sensitive local paths. Audit events record decisions and identifiers without
credentials or full sensitive payloads. Hosted provider prompts and replies
are subject to the same scope and redaction boundary; the profile's explicit
Room assignments are the privacy admission fence.

## Verification and Tasks

Negative tests cover replay, forged poll tokens, non-owner approval, cross-Team access, expired code,
recovery-secret failure, invitation replay/expiry, cross-origin Cookie writes,
revocation, unpublished Runtime launch, credential leakage, and attempts to
bypass local policy. Work is tracked by `SEC-001` through `SEC-010`, with pairing
transport under `BRG-002` and central Token transport under `BRG-025`, in
`docs/TASKS.md`.

`SEC-010` adds authenticated-encryption tamper/wrong-authority/rotation tests,
Owner-only and cross-Team negatives, fixed-origin/redirect/SSRF rejection, and
plaintext searches across API responses, browser projections, logs, errors,
diagnostics, metrics, audits, and backups. It also proves the Hosted identity
cannot enter Result, Task-completion, ambiguity-acknowledgement, Member, Device,
or MCP authority paths.

`CON-012` defines the additive ADR-0021 pairing-session contract. `SEC-008`
implements its state machine in migration 0041 and the dedicated pairing
service and HTTP routes. Focused tests prove exact create, claim, decision and
poll recovery across a Server restart, first-attempt binding, matching Owner and
Bridge phrases, hash-only secret persistence, atomic poll-secret credential
promotion, manual-code rate limiting, non-enumerating replay, expiry,
cross-Team and non-Owner rejection, cancellation, and unchanged legacy
join/pair plus central-Token behavior. Bridge and Web presentation remain owned
by `BRG-043` and `WEB-045`; this Server completion does not claim those product
surfaces.

`CON-014` and `SEC-009` extend that pairing boundary with public
deployment trust metadata. Migration 0046 snapshots the exact descriptor and
Bridge capability with the session. Server reads the bounded controller file
lazily so Caddy can establish its CA first, requires its exact origin to equal
the trusted-team Server origin, projects the snapshot only to the authenticated
Owner, and binds it into the matching phrase. The direct claim must echo the
exact descriptor and advertise scoped-trust support; public sessions reject an
unsolicited override, while private short-code and legacy-client bootstrap fail
closed. Strict parsing rejects extra fields, origin/install/epoch/digest
mutation and private-key material without returning file contents or paths.

Migration 0047 and the Device-authenticated rotation routes add one strict
current-to-next epoch offer and one idempotent acknowledgement per installation,
Device and next epoch. Only Devices with an eligible private pairing lineage may
read or acknowledge the offer; each subsequent rotation requires prior-epoch
continuity. The Server rejects descriptor drift, changed acknowledgement proof,
expired overlap, downgrade, malformed CA material, digest mismatch, and public
or foreign Devices without projecting file paths, private keys, or other Device
state. `OPS-009`, `BRG-045`, and `WEB-048` remain the owners of installation
state, local TLS enforcement, and presentation respectively.

`CON-013`, `TASK-012`, and `TASK-013` implement the central ADR-0022 Task/Result
authority. `BRG-044` implements the Device-bound managed Agent transport, and
`MCP-006` implements the credential-bound manual Agent transport without human
review or Task mutation authority.
Negative tests cover stale revisions, foreign Room/Task sources, Agent/Run
mismatch or lost current Room access, Orchestrator scope, non-Owner
review/completion, display-ID confusion, evidence-free required criteria,
active-work fences, and Result body or Context Manifest disclosure.

Revoking a Device atomically marks it revoked, revokes all of its credentials,
disables its managed Agents, and projects them offline. The active Bridge socket
is closed immediately, and later reconnects fail authentication.

Device revocation also prevents new deliveries and Workspace leases. The
security mutation is durable before Run reconciliation: a queued Run not yet
accepted by the Bridge closes with bounded `RUN_DEVICE_REVOKED`, while an
already accepted Run closes with `RUN_DEVICE_REVOKED_OUTCOME_UNKNOWN` and is
not falsely reported as canceled. Cancellation is best effort before socket
closure for an interruptible Agent. Server startup idempotently repairs the
crash window between durable Device revocation and Run reconciliation.

Run acceptance, status, and replies require an exact Team, Device owner, and
target Agent binding. Cross-Team and same-Team cross-owner events are rejected
before they can advance sequence state or append a Room reply.

Runtime and MCP Agent replies are filtered for common bearer, API-key, access
key, password, secret, and token patterns before durable event or Message
persistence. Adapter failures publish fixed safe summaries rather than raw
stderr. This filter is defense in depth, not a substitute for credential
isolation and owner-controlled environment allowlists.

## Dependencies

Contracts. Every transport and domain service depends on Security decisions.
