# ADR-0017: Isolate explicit Bridge re-enrollment

- Status: Accepted
- Date: 2026-08-26
- Supersedes: none

## Context

The desktop shell and local Console hide the approval code once enrollment
finishes. A stored Device credential is not proof of a live connection, and
an online Bridge does not imply that the current Web user belongs to its Team.
Reusing an old approval code or deleting the credential is not a recovery flow.

## Decision

Keep a pairing and recovery panel visible after setup. Show the current Team
and Device binding, connection-specific guidance, and the current short code
with its deadline only while an enrollment attempt is live. Consumed, canceled,
or expired codes must not be offered for copying. Code generation is explicit;
polling the Console state never creates a join request.

Separate reconnecting the existing Device from requesting a new Device.
Re-enrollment requires the local Console bearer token, explicit confirmation
of new identities, and the expected current Device ID. The Bridge must be
stopped, all connection workers drained, and Runtime tests and work idle.
Starting the Bridge or changing configuration during enrollment is rejected.
Canceled or superseded enrollment callbacks cannot publish state or save files.

Use the existing central join/claim protocol without granting local authority
over central Team membership. Approval creates a new Device and new Agent IDs,
even when approved into the same Team. Old central identities are not revoked
or migrated automatically. Wrong-Web-user visibility is resolved through Team
access, not re-enrollment.

After claim, stage the new credential, Agent identity map, and an owner-only
copy of the previous configuration in a fresh sibling data directory. Preserve
all Runtime settings. Atomically replace the active configuration only after
staging succeeds; its `dataDir` selects the complete new identity. Never copy
old inbox records, session bindings, connection epochs, or Artifact state into
the new identity. Previous data is retained, not cleared. A process crash
before the configuration switch leaves the old binding active; after the
switch startup loads the new binding. Failed staging is retained for inspection.

## Alternatives

- Overwrite only `device-credential.json`: rejected because Agent IDs, inbox
  records, and Runtime session bindings would still belong to the old Device.
- Clear all local state before approval: rejected because cancellation or a
  failed request would destroy the working binding and recovery evidence.
- Treat every connection failure as revoked credentials: rejected because
  network, TLS, Server Token, protocol, and Web membership failures differ.

## Consequences

Re-enrollment is a deliberate new binding, not an invisible repair. Users may
need to revoke obsolete Devices centrally and retain the previous data directory
until they no longer need recovery. Pending codes are memory-only; after app
restart the user requests a new code. A canceled local request may remain pending
centrally until expiry, but its late result cannot replace the local binding.
If central approval succeeded before a local failure, the Owner may need to
inspect that newly created central Device; no automatic second claim is guessed.

## Compatibility and Security

No central wire schema or database migration changes. CLI first-time enrollment
keeps its no-clobber behavior. The new API is local and bearer-authenticated.
Neither Device tokens, central Server Tokens, nor claim poll tokens appear in
state or diagnostics. Directory permissions are owner-only. The configuration
rename is the process-crash switch point; this does not add a new whole-filesystem
power-loss durability guarantee to existing config storage.

## Verification

Focused tests cover confirmation and token rejection, running/draining work,
concurrent probes, late callbacks after cancellation, expiry, failed staging,
changed on-disk configuration, successful new identities, and reopening either
configuration. Browser acceptance covers paired, waiting, expired, and error
states without changing a user's real pairing.
