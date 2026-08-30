# BRG-053 Configured Pairing Link Entry

Date: 2026-08-30

## Problem

`BRG-050` safely reused installed `convenewire://` links after Bridge setup, but
the configured UI hid the first-run pairing-link field. If Windows protocol
activation did not reach the running single instance, the only visible action
was the legacy Bridge-created approval-code flow. Asking an operator to use
`Win + R` was therefore a transport workaround, not an acceptable primary
product flow, and the legacy code could not replace the canonical private-CA
link required by schema-v4 physical acceptance.

## Delivered boundary

- **Settings → Pairing and recovery** now exposes **Use pairing link** for an
  already configured client.
- The local dialog accepts only one complete `convenewire://` or supported
  legacy-scheme Device-pairing link. It parses only the origin for immediate
  presentation checks and never displays the fragment proof outside the input.
- Empty, malformed, ambiguous and different-Central links cannot continue. An
  active pairing attempt disables the entry.
- A valid same-Central link enters the existing `BRG-050` confirmation. A
  running idle Bridge must be stopped explicitly, active Runs remain fenced,
  and the old Device credential and all local Agent settings remain active until
  the Owner approves and the replacement transaction commits atomically.
- The authenticated Go handler still performs the authoritative complete-link
  validation. The UI does not import a CA, weaken TLS, expose a Server Token or
  Device credential, or create another pairing authority.
- Closing the entry or replacement dialog clears the pasted proof from local
  form state. Installed protocol activation remains supported as a convenience,
  but it is no longer required for the normal configured-client path.

## Verification

- `npm run test:bridge-ui` — 37 checks passed, including same-Central entry,
  malformed/cross-Central rejection and the existing stopped/drained launch
  projection.
- `go test ./internal/console` — passed with a task-scoped Go cache; embedded UI
  coverage requires the entry, modal, input, continue action and shared pairing
  projection.
- The isolated paired browser fixture showed the visible Settings action,
  disabled continuation plus a local error for an invalid link, and the exact
  existing **Use link to pair again** confirmation for a valid link. While the
  fixture Bridge was running, that confirmation exposed **Stop Bridge and
  continue** and kept **Confirm new identity** disabled.
- Full Bridge Go, race, vet, desktop-tag and Windows amd64 cross-compilation
  gates pass from the same source change.

The checked-in behavior is complete. It does not retrofit immutable
`v0.4.1-qa034.4` assets. The later exact `v0.4.1-qa035.1` Windows package and
[schema-v4 two-physical-machine record](evidence/qa-002-20260830-schema-v4.md)
supply the distinct release and acceptance evidence owned by `QA-002`,
`QA-035` and `QA-036`.
