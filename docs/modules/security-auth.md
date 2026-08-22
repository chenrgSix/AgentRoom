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

The central server is the MVP trust authority. Pairing uses an authenticated web
session to issue a short-lived, single-use code. The Bridge exchanges it for a
device credential over TLS, verifies the server fingerprint, and stores the
credential locally. Discovery alone never grants trust.

Web sessions and device credentials use random bearer secrets whose SHA-256
hashes are persisted; plaintext secrets are returned only when issued. Session
expiry, credential rotation, and revocation are checked before resolving the
principal. The initial local Web bootstrap may issue a session directly, but
all domain services still authorize through stable User and Member IDs.

Bridge invitations expire after ten minutes and bind the expected Device name,
Team, and Member. Exchanging one invitation atomically consumes it, creates the
Device, and stores only the SHA-256 hash of the new Device credential.

## Authorization Rules

- Team membership gates Room and Agent visibility.
- Room policy gates messages, mentions, Runs, and replies.
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

Negative tests cover replay, forged identity, cross-Team access, expired code,
revocation, unpublished Runtime launch, credential leakage, and attempts to
bypass local policy. Work is tracked by `SEC-001` through `SEC-004`, with pairing
transport under `BRG-002`, in `docs/TASKS.md`.

Revoking a Device atomically marks it revoked, revokes all of its credentials,
disables its managed Agents, and projects them offline. The active Bridge socket
is closed immediately, and later reconnects fail authentication.

Run acceptance, status, and replies require an exact Team, Device owner, and
target Agent binding. Cross-Team and same-Team cross-owner events are rejected
before they can advance sequence state or append a Room reply.

## Dependencies

Contracts. Every transport and domain service depends on Security decisions.
