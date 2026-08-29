# ADR-0025: Harden transactional runtime and release boundaries

- Status: Accepted
- Date: 2026-08-29
- Supersedes: none
- Amends: ADR-0002, ADR-0003, ADR-0021, ADR-0023, and ADR-0024

## Context

The post-v0.4.0 audit found no confirmed cross-Team authorization bypass or
known dependency vulnerability, and all existing deterministic gates passed.
It did find failure cuts that happy-path idempotency does not close:

- a Message can commit before its mentioned Runs exist;
- a Run reply can commit before its durable Room Message projection exists;
- a managed cancellation can be lost after a socket write without an
  acknowledgement;
- a paired public-CA Bridge can retain a Device credential while its configured
  Central origin changes;
- multiple Bridge or Central lifecycle owners can mutate the same local state;
- Windows cancellation can leave Runtime descendants alive;
- operator shell variables can override controller-generated Compose state;
- Release jobs do not share one immutable, full-CI-verified commit;
- the Central archive still builds its runtime image on the target host; and
- schema-v4 evidence accepts formatted source and archive identities without
  computing their relationship to the inspected artifacts.

Remote Markdown images and synchronous polling also create avoidable privacy
and scaling exposure. These are not reasons to replace the established module
boundaries. They are reasons to complete the existing transaction, authority,
and evidence contracts at their actual failure cuts.

## Decision

### 1. Persist intent before asynchronous projection

Message routing, reply projection, and managed cancellation use durable,
idempotent intents. A single SQLite transaction records the authoritative
domain mutation and its intent whenever both live in Central. Projection and
delivery may occur after commit, but startup and bounded retry reconciliation
must make progress from the durable intent.

Each intent has a stable operation identity and a database uniqueness fence.
Replaying an intent may observe existing output and mark it complete; it may
not create another Run, another Room Message, or another cancellation outcome.
The Run event sequence remains authoritative and is not replaced by a second
delivery sequence.

### 2. Bind bearer credentials before transport

Every Device credential is bound to the exact HTTPS origin established during
pairing. Normal public-CA certificate renewal does not alter that origin.
Changing a public or legacy-pinned origin requires a new Device pairing; the
only credential-preserving origin change remains the authenticated same-CA
scoped-private migration defined by ADR-0024.

The Bridge checks the credential origin before attaching either the Device
token or an optional Server token. Configuration drift fails locally without
making a credential-bearing request.

### 3. Give local state one owner

All Bridge entrypoints acquire one process-level lock for the resolved data
directory before opening mutable inbox, session, identity, materialization, or
connection-epoch state. Stop, restart, configuration replacement, and process
exit cancel and then wait for the previous worker to drain before a successor
starts.

Windows Runtime execution uses a Job Object or an equivalent verified process-
tree owner so cancellation, timeout, Bridge stop, and application exit cannot
leave descendants running. Atomic local writes sync both file content and the
parent directory where the platform supports that durability primitive.

Central lifecycle mutations similarly acquire one non-blocking lock per data
root and use a manifest generation compare-and-swap before final state commit.

### 4. Make generated deployment state authoritative

The lifecycle controller never forwards ambient `CONVENE_WIRE_*` or
`AGENT_ROOM_*` variables to Compose. It constructs a closed child environment
from the generated installation state plus a minimal operating-system allowlist
and verifies the effective Compose model before mutation.

Compatibility aliases remain accepted when a human invokes raw Compose as
documented, but they cannot override a controller-owned installation.

### 5. Bind Release identity once

The Release workflow resolves the requested tag to one immutable commit before
building. That commit must be reachable from the protected release branch and
have one successful, complete repository CI run. Every job checks out the
resolved commit rather than resolving the tag again.

Central is distributed as a prebuilt multi-architecture OCI image selected by
digest. The Release records the source commit, image digest, SBOM, provenance,
and outer asset checksums. Installation pulls or imports that image and starts
it without rebuilding application source on the target host.

### 6. Compute acceptance identity

The schema-v4 verifier computes the supplied Bridge archive SHA-256, validates
it against the selected Release metadata, and compares the running Central's
reported source identity with the same immutable Release commit. Human review
continues to own physical observations such as visible windows and OS trust-
store state; automatable identities are not accepted as attestations.

Windows installer upgrade acceptance starts with the previous stable installer
and real owner-state fixtures before installing the candidate.

### 7. Fail closed at browser and schema boundaries

Agent-authored Markdown never initiates an arbitrary cross-origin image request
without explicit user action. The response CSP enforces the same rule.

The Server validates Bridge envelopes against the authoritative generated
contract at ingress. Server, Bridge, and Schema share the same bounds. Read-
path activity timestamps are conditionally coalesced, and wait implementations
use notification rather than fixed high-frequency synchronous SQLite polling.

## Alternatives

- Rely on client retry after each failure cut: rejected because several current
  retries observe the first durable row and skip the missing projection.
- Keep Device credentials while editing any publicly trusted URL: rejected
  because public PKI authenticates the new hostname, not continuity with the
  Central that issued the bearer credential.
- Treat desktop single-instance behavior as the Bridge state lock: rejected
  because CLI and service entrypoints share the same mutable data directory.
- Document a clean operator shell instead of sanitizing it: rejected because
  controller-owned state must not depend on unrelated parent-process history.
- Continue source-only Central releases: rejected because Release checksums do
  not identify packages and images resolved later on the target host.
- Keep source commit and archive digest as human review fields: rejected because
  both are deterministic and cheap to verify mechanically.

## Consequences

- More state machines gain explicit pending/completed intent rows and bounded
  reconcilers, increasing migration and fault-injection test surface.
- Origin changes become deliberately stricter for already paired public-CA
  Bridges; users re-pair instead of silently moving a credential.
- A second Bridge or lifecycle mutation receives an actionable busy error
  instead of racing the current owner.
- Stop and restart can take slightly longer because they wait for bounded
  worker and process-tree shutdown.
- Central installation no longer requires a target-host Node build, but Release
  publication must own an OCI registry/import path, signatures and provenance.
- Remote images require an explicit click or controlled proxy.
- Historical releases and acceptance records remain unchanged. A new release
  and fresh physical schema-v4 evidence require separate owner authorization.

## Compatibility and Security

The durable cancellation acknowledgement is additive within protocol 1.0;
older Bridges retain the current bounded fallback and never receive a field
they cannot ignore. Database migrations preserve existing Messages, Runs,
events, credentials, installations and task history.

Existing correctly matched Bridge configuration and credential origins continue
without action. A mismatched public-CA or legacy-pin configuration stops before
sending secrets and provides re-pairing guidance. Scoped-private same-CA
migration remains compatible.

Controller environment sanitization preserves operating-system variables needed
to locate Docker and credential helpers while excluding product configuration.
Manifest CAS and process locks add rejection, not silent state rewriting.

No task in this ADR authorizes publishing a Release, moving repositories,
changing external DNS, installing a system CA, or declaring physical acceptance.

## Verification

- fault injection after each Message, Run, reply, projection, cancellation, and
  acknowledgement durable step;
- reopened-SQLite reconciliation and duplicate-operation tests;
- real TLS tests proving zero credential-bearing requests to a changed origin;
- CLI/Desktop same-data-directory contention and stop/restart race tests;
- native Windows parent/child/grandchild termination coverage;
- file and directory durability helper tests on supported platforms;
- real Compose environment-precedence and concurrent controller tests;
- synthetic Draft workflow validation with a moved-tag negative case and one
  frozen successful-CI SHA;
- clean-cache OCI import/start plus digest, SBOM and provenance verification;
- archive hashing, runtime source-identity mismatch, and prior-stable Windows
  upgrade negative tests;
- Markdown image/CSP, Schema boundary, WAL-write and wait query-count tests; and
- the full contract, build, unit, race, deterministic E2E and documentation
  gates before `QA-036` can become `DONE`.
