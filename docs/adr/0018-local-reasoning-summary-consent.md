# ADR-0018: Require local consent for reasoning-summary sharing

- Status: Accepted
- Date: 2026-08-26
- Supersedes: none

## Context

Safe Runtime activity already distinguishes public reasoning summaries from
private provider protocol. Redaction is not consent: the local owner also
needs to decide whether the configured central service may receive summaries.
A broad "fully trusted" flag could wrongly imply remote filesystem, command,
or Runtime approval authority.

## Decision

Add the local `shareReasoningSummaries` boolean, defaulting to false for new
and existing configurations. Console setup and connection settings describe
the exact permission: trust this central service with Runtime-provided public
reasoning summaries. This is independent of HTTPS certificate verification.
It never enables raw hidden reasoning, tool arguments/results, credentials,
local paths, arbitrary commands, or additional sandbox permissions. Replies,
Run status, and existing allowlisted tool-name lifecycle remain available.

The executor drops unconsented reasoning activity before allocating a sequence
or persisting an outbound event. Consent is applied in the shared Bridge core,
so CLI and desktop behavior agree. A changed permission requires a stopped and
fully drained Bridge, with no active work or probe. Only an authenticated local
configuration operation can change it; a central Run cannot grant consent.

Changing the outbound URL clears consent unless the local request explicitly
grants it again. Unrelated edits preserve consent. The GUI clears its checkbox
when the address is edited and never enables it automatically.

Recovery applies the current permission to previously persisted activity.
When disabled, old reasoning envelopes retain their sequence and message
identity but expose only a fixed privacy label, sequence-derived activity ID,
and original lifecycle phase, with no summary or reset payload. Dropping those
envelopes would break the existing contiguous Run sequence contract. The local
record is retained; already uploaded information cannot be recalled by this
setting. Re-enabling permits replay of previously consented local records.

## Compatibility and Verification

This adds one optional local config field, not a central wire field or schema
migration. Older binaries that reject unknown local fields must not be used to
edit an opted-in configuration. Missing consent is always disabled.

Tests cover absent/false/true consent, unchanged ordinary output and tool
activity, contiguous sequences, replay and restart with consent withdrawn,
credential redaction when enabled, local authorization and execution fencing,
save failure, endpoint change, and preservation across other configuration
operations. Browser acceptance checks the default-off checkbox and guidance.
