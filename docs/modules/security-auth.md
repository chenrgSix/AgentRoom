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

The policy matrix is documented and tested alongside each protected endpoint.
Default behavior is deny when an identity, scope, or capability is missing.

## Local Execution Controls

The Bridge starts only owner-published Runtime configurations. Existing Runtime
command, file, network, and approval controls remain authoritative, and neither
the server nor Bridge may bypass them. Login state and Runtime credentials stay
on the owner machine.

## Data Protection

Room context, replies, handoff summaries, and logs may leave the owner machine
only after scope checks and filtering of tokens, credentials, and obvious
sensitive local paths. Audit events record decisions and identifiers without
credentials or full sensitive payloads.

## Verification and Tasks

Negative tests cover replay, forged poll tokens, non-owner approval, cross-Team access, expired code,
recovery-secret failure, invitation replay/expiry, cross-origin Cookie writes,
revocation, unpublished Runtime launch, credential leakage, and attempts to
bypass local policy. Work is tracked by `SEC-001` through `SEC-005`, with pairing
transport under `BRG-002`, in `docs/TASKS.md`.

Revoking a Device atomically marks it revoked, revokes all of its credentials,
disables its managed Agents, and projects them offline. The active Bridge socket
is closed immediately, and later reconnects fail authentication.

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
