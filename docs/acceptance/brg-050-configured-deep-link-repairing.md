# BRG-050 Configured Bridge Deep-Link Re-pairing

## Observed defect

The `BRG-049` repair made a first-configuration launch project the Device
pairing link and its Central origin correctly. A physical follow-up exposed a
separate lifecycle gap: once a Bridge had saved configuration, the desktop
still delivered a later `convenewire://pair-device` launch and refreshed the
existing single-instance WebView, but the configured-state renderer hid the
entire enrollment form. The ordinary Device-pairing endpoint also correctly
rejected an existing Device credential. No configured deep-link route joined
those two boundaries, so the operator could not act on the received link.

This was not a Windows protocol-registration, URL-parameter, DNS or TLS
failure. It was a missing explicit re-pairing transition after initialization.

## Repair boundary

The embedded Console now recognizes a valid pending link after authenticated
state has loaded:

- a configured but unpaired Bridge offers to finish pairing with its existing
  local Runtime, Workspace and privacy configuration;
- an already paired Bridge displays a new-identity confirmation bound to its
  current Device ID;
- an idle running Bridge exposes an explicit stop action, while active Runs
  suppress that action; confirmation stays disabled until all work and workers
  have drained; and
- closing the prompt clears the pending link from the input and in-memory
  pending value.

The UI never performs identity replacement on launch alone. For a paired
Bridge it calls the dedicated authenticated
`POST /api/device-pairing/restart` endpoint with `confirmNewDevice: true`, the
displayed `expectedDeviceId` and the canonical link. The backend independently
parses the link, requires its origin to equal the current configured Central,
rechecks the on-disk configuration and Device credential, and applies the
existing enrollment/runtime mutation fences.

After the Owner approves the matching phrase, the existing isolated recovery
transaction writes the new credential and Agent identities into an owner-only
sibling data directory, retains `previous-bridge.json`, and atomically selects
the new configuration. Before that point, and on rejection, cancellation or
failure, the old Device identity, credential, data and local Agent profiles
remain unchanged.

The route intentionally does not switch Central. A cross-Central link is
disabled by the UI and rejected again by the backend, preventing a deep link
from silently rewriting the connection or carrying an old Server Token to
another origin. Central migration remains a separate explicit operation.

## Verification

Six JavaScript projections cover first launch, configured-unpaired
continuation, configured-paired replacement, running-stop guidance, active
attempt suppression and cross-Central rejection. Embedded-asset coverage
requires both initial and replacement endpoints plus the configured-launch
renderer.

Authenticated Go regressions prove that deep-link replacement requires
explicit confirmation and the current Device ID, rejects ordinary implicit
replacement and a different Central, projects only the verification phrase,
leaves the old identity selected while approval is pending, preserves local
Agent configuration, switches to a fresh data directory only after approval,
and never projects the fragment claim proof.

The focused UI, Console and Console race suites pass. Full Bridge Go and race
suites, Go vet, desktop-tag testing and Windows/amd64 compilation pass. The
workspace tests, 9-schema/116-fixture validation, production builds, docs lint
and five deterministic cross-process E2E scenarios also pass; the opt-in live
Codex/Pi scenario remains intentionally skipped by the deterministic command.

`BRG-050` closes deterministic implementation behavior only. Stable `v0.4.0`
does not contain `BRG-049` or this follow-up; a new packaged Windows candidate
and a fresh schema-v4 two-machine record remain required before `QA-002`,
`QA-028` or `QA-030` can close.
