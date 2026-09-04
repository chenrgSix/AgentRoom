# BRG-074 Private Browser Trust Settings Goal

Date: 2026-09-04

Status: accepted on 2026-09-04. Delivery state lives only in
`docs/TASKS.md`.

## Goal

Move the optional **advanced private HTTPS browser trust** entry from the
Bridge overview into Bridge settings. The overview is the daily collaboration
surface and must present only ordinary Team and Room entry. Private-CA browser
preparation is a low-frequency deployment and security operation, not a
prerequisite for ordinary LAN HTTP or public-CA access.

## Required Product Behavior

- The overview's Team collaboration card contains only Team entry, Room
  selection and their current status.
- Settings exposes one clearly named advanced browser-trust disclosure near
  Central connection configuration.
- The disclosure says ordinary LAN HTTP needs no CA installation and that the
  tool applies only when a private-HTTPS Central is intentionally used.
- The trust control and its containing settings disclosure are unavailable
  when the exact current validated private-CA projection is unavailable or
  enrollment is active.
- Opening, platform selection, copying, failure reporting and scope/CA-change
  clearing retain the accepted BRG-072/BRG-073 behavior.

## Authority And Compatibility Boundary

This is an information-architecture change only. It creates no Central
request, client-entry ticket, trust-store mutation, credential access or new
certificate authority. Bridge continues to produce commands solely from its
current validated public CA certificate; a human must deliberately copy and
run the selected command on the target computer. Existing configuration,
pairing, Runtime and repository behavior are unchanged.

## Acceptance

- structural UI tests prove the unique trust action is located inside Settings
  and absent from the overview collaboration card;
- controller tests prove both the action and its settings disclosure fail
  closed together while existing copy and invalidation behavior remains;
- the embedded UI suite, focused Console tests, desktop compilation, docs lint
  and whitespace checks pass;
- a freshly started current-source macOS Desktop shows the uncluttered overview
  and the settings disclosure without clipping or browser diagnostics.

No transition release may be published by this task. Release admission remains
a separate explicit user decision after visual review.

## Implemented Result And Evidence

Implementation commit `6be3ebf` removes the private-HTTPS action from the
overview collaboration card and places its unique control inside a collapsed
**Advanced browser trust** disclosure immediately after Central connection
settings. The disclosure is available only with a valid current private-CA
projection and says that ordinary LAN HTTP needs no CA while public-CA HTTPS is
already covered by system trust. Existing Windows/macOS command generation,
platform selection, copy handling, invalidation and Linux guidance are
unchanged.

The following gates passed through owned test roots, each of which reported its
physical cleanup:

```text
npm run test:bridge-ui
# 61 passed

node scripts/test/run-with-temp-root.mjs --cwd bridge -- go test ./internal/console
# passed

node scripts/test/run-with-temp-root.mjs --cwd bridge -- \
  go test -tags desktop ./cmd/convenewire-bridge-desktop
# passed

node scripts/test/run-with-temp-root.mjs --cwd bridge -- \
  go build -tags desktop ./cmd/convenewire-bridge-desktop
# passed; the explicit build output was removed after inspection
```

Structural regressions prove that the unique trust action occurs after the
Settings page begins and not between the overview and Settings pages.
Controller regressions prove that invalid trust or active enrollment hides both
the disclosure and action. A freshly compiled current-source macOS Desktop was
started with the Owner's existing local state; the Owner then explicitly
requested transition-release publication after the preview. No command was run
against an operating-system trust store, and release admission is tracked
separately by `QA-062`.
