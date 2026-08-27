# Security and Authorization

## Scope

- Prefix: `SEC`
- Planned location: central server and `bridge/`
- Owns: identity, credentials, authorization, revocation, secret boundaries

Security is a cross-cutting server and Bridge module. It owns web identity,
Team membership, MCP authentication, device pairing, and policy requirements.

## Identity Model

The binding is `Member -> Device -> Agent -> Runtime`. A Member may own several
Devices; a Device publishes signed Agent identities; a Runtime Session acts only
through the Agent selected for a Run. IDs are immutable and display names are
never authorization inputs.

The central server is the MVP trust authority. In the primary flow, a Bridge
creates an unauthenticated, short-lived join request and shows its short code
locally. Only a Team owner may approve that code in an authenticated Web
session. The same Bridge then claims the approval using a separate high-entropy
poll token over TLS, verifies the server through normal system-CA trust or an
explicit legacy SHA-256 pin, and stores the resulting identity locally.
Discovery and join creation alone never grant trust.

Web sessions and device credentials use random bearer secrets whose SHA-256
hashes are persisted; plaintext secrets are returned only when issued. Session
expiry, credential rotation, and revocation are checked before resolving the
principal. The initial local Web bootstrap may issue a session directly, but
all domain services still authorize through stable User and Member IDs.

The local bootstrap exists only in `local` auth mode, whose process must bind
to loopback. `trusted-team` mode disables `/api/bootstrap` and requires an
HTTPS public origin plus an Owner recovery secret read from a
permission-restricted file. The secret is at least 32 bytes, never appears in a
URL, response, database, browser storage, or log, and is used only for initial
setup or explicit Owner recovery.

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

A deployment may require a central Server Token on Bridge bootstrap and
transport endpoints. The Bridge passes this opaque value in
`X-AgentRoom-Server-Token`; the Server compares it without logging or
persisting it. This is a simple deployment access parameter, not cryptographic
Server identity. Device bearer authentication, Team ownership, revocation, and
connection epochs remain mandatory and unchanged.

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

## Authorization Rules

- Team membership gates Team-level Member and Agent administration.
- Explicit human Room participation gates Room discovery, history, messages,
  Runs, and replies; a Team role alone does not grant Room access.
- Explicit Agent Room participation gates mentions, Discussions, and handoffs.
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

## Data Protection

Room context, replies, handoff summaries, and logs may leave the owner machine
only after scope checks and filtering of tokens, credentials, and obvious
sensitive local paths. Audit events record decisions and identifiers without
credentials or full sensitive payloads.

## Verification and Tasks

Negative tests cover replay, forged poll tokens, non-owner approval, cross-Team access, expired code,
recovery-secret failure, invitation replay/expiry, cross-origin Cookie writes,
revocation, unpublished Runtime launch, credential leakage, and attempts to
bypass local policy. Work is tracked by `SEC-001` through `SEC-007`, with pairing
transport under `BRG-002` and central Token transport under `BRG-025`, in
`docs/TASKS.md`.

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

`CON-013`, `TASK-012`, and `TASK-013` track the ADR-0022 Task/Result authority.
Negative tests cover stale revisions, foreign Room/Task sources, Agent/Run
mismatch or lost current Room access, Orchestrator scope, non-Owner
review/completion, display-ID confusion, evidence-free required criteria,
active-work fences, and Result body or Context Manifest disclosure.

Revoking a Device atomically marks it revoked, revokes all of its credentials,
disables its managed Agents, and projects them offline. The active Bridge socket
is closed immediately, and later reconnects fail authentication.

Under the ADR-0021 target, revocation also prevents new deliveries and Workspace
leases. A queued Run not yet accepted by the Bridge closes with a bounded
Device-revoked reason. An already accepted Run is not falsely reported as
canceled merely because the socket closed: cancellation is best effort and an
unrecoverable execution outcome follows the existing `outcome_unknown` rule.

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
