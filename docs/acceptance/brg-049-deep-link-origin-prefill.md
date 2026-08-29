# BRG-049 Device Pairing Deep-Link Origin Prefill

## Observed defect

Physical Windows setup with the stable `v0.4.0` installer exposed a split
deep-link projection. The registered `convenewire://` launch reached the
Desktop owner and the nested pairing link populated the Device-pairing field,
but the first-configuration `server-url` field remained empty. The explicit
pairing action calls the form's native validity check before posting, so the
required empty Central address stopped the request. Manually repeating
`https://chenzhirong.local:40000` made the same link proceed.

The link was not missing this information. Its query already contained the
exact encoded `origin`; only the local form projection ignored it. This is an
implementation defect rather than an operator, DNS, private-CA or Windows
protocol-registration failure.

## Repair boundary

The embedded UI now parses only the canonical `convenewire://pair-device` and
released `agentroom://pair-device` compatibility shapes. It requires exactly
one `origin`, pairing-session identity and expiry, accepts an exact HTTPS
origin or loopback HTTP development origin, and rejects unexpected or duplicate
query keys, credentials, paths, queries and fragments inside the origin. A
valid installed launch immediately fills both the pairing-link and Central
address fields. Pasting a valid link into the field applies the same projection.

The UI is convenience, not authority. Before building a first configuration,
the authenticated Console endpoint parses the complete link again through
`pairing.ParseSessionLink` and derives `ServerURL` from that validated result.
A blank or stale form address therefore cannot select another claim endpoint.
The existing pairing client still verifies equality with the link, stages
scoped private trust before sending claim proof, and restricts authenticated
traffic to that exact origin. Short-code recovery remains unchanged and still
needs an independently configured Central because a short code carries no
origin or private trust descriptor.

The change does not install an OS CA, accept a leaf fingerprint, disable TLS,
move the fragment secret into query or Console state, copy a Server Token, or
change Runtime and Workspace authority.

## Verification

Focused JavaScript tests prove:

- current and released compatibility schemes project the same exact HTTPS
  origin;
- loopback HTTP remains available only for local development; and
- malformed, non-loopback HTTP, credential-bearing, path-bearing, duplicate
  origin and unexpected-key links do not populate the form.

Focused Go tests prove a Device pairing request with an empty form `ServerURL`
derives the exact origin from its validated link, preserves two local Agent
profiles, projects only the approval phrase, persists the promoted credential,
starts the Bridge after consumption and retains cancellation fencing. The
embedded-asset regression requires both installed-launch and manual-paste
prefill hooks.

`BRG-049` closes the deterministic implementation defect. It is not present in
stable `v0.4.0`; a new packaged Windows build and a fresh schema-v4 physical
record are still required before `QA-002`, `QA-028` or `QA-030` can close.
