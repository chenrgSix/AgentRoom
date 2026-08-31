# ADR-0033: Explicit client Central switching through Device pairing

- Status: Accepted
- Date: 2026-08-31
- Extends: ADR-0017

## Context

Configured clients currently reject every pairing link whose origin differs
from the saved Central. This prevents an Owner from switching servers, including
moving from an IP address to a domain through fresh pairing.

## Decision

Allow a complete Device pairing link to select another Central only after a
local confirmation showing both origins. The authenticated Console request must
explicitly confirm the switch and name the expected old origin, plus the expected
Device ID and new-identity confirmation when paired. Merely opening or pasting a
link never changes configuration. Existing stop, drain, active-Run, Runtime-test
and concurrent-enrollment fences remain mandatory.

Pair against an in-memory candidate, with no old Server Token, certificate pin,
Device credential, private CA, reasoning-sharing consent or remote Agent
provisioning code. Use system trust or the new link's independently verified
scoped private CA. Preserve local Device name and complete Agent/Runtime/Workspace
profiles. No existing Runtime session, inbox or connection epoch is transferred.

Only after Owner approval, stage fresh credentials and Agent identities in an
owner-only sibling directory, back up the previous configuration, check unchanged
old configuration/credentials, then atomically select the candidate. This also
applies to configured clients without credentials. Cancellation, failed approval,
stale local state and failed persistence leave the previous selection intact.
Show the target origin while awaiting approval without exposing link proof.

## Compatibility and Consequences

This adds local Console confirmation fields, not a Central wire-protocol change.
Same-Central re-pairing retains its existing settings and behavior. Cross-Central
Device IDs are namespaced by origin and may coincide. Switching creates a new
binding; it neither migrates Team history nor revokes the previous remote Device.
The previous data and configuration backup remain available for recovery. This
does not replace the distinct same-installation private-hostname migration path.

## Verification

Cover explicit and stale confirmation, stopped/drained fences, both paired and
configured-unpaired clients, candidate credential isolation, approval, cancellation,
late completion, persistence failure and recovery, plus the actual embedded page's
confirmation payload and visible old/new addresses.
