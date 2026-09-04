# BRG-074 Private Browser Trust Settings Goal

Date: 2026-09-04

Status: active. Delivery state lives only in `docs/TASKS.md`.

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
