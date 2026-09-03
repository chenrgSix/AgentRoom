# QA-059 Hosted Probe Cancellation Budget

Status: accepted on 2026-09-03. Delivery state lives only in
`docs/TASKS.md`.

## Goal

Keep Hosted provider cancellation a deterministic Release gate without using
one performance-sensitive deadline for both fixture/bootstrap setup and the
actual cancellation behavior.

## Failure Evidence

Exact-source main CI run
[33752581392](https://github.com/chenrgSix/ConveneWire/actions/runs/33752581392)
passed all four jobs for
`1f519bddca81c9931e5354cae81a7b7476f02d51`. Protected Release run
[33753323037](https://github.com/chenrgSix/ConveneWire/actions/runs/33753323037)
ran the same source, but its Repository gate reported 593 passes, zero ordinary
failures and one canceled Server test after the five-second whole-test timeout.
The affected test was `Hosted configuration probes abort HTTPS on client
disconnect`; every asset-producing job was skipped and the Draft retained zero
assets.

The old deadline covered temporary SQLite creation, application startup,
trusted-Team bootstrap, loopback listener creation, provider dispatch,
cancellation propagation, HTTP settlement and shutdown. It therefore measured
runner contention in addition to the security behavior.

## Bounded Correction

The test keeps a five-second bound from actual client disconnect or Server
shutdown to provider-signal abortion, plus separate five-second bounds for HTTP
settlement and Server closure. A 15-second provider-start diagnostic and
30-second outer test envelope allow bounded fixture/bootstrap setup without
turning the provider's own 15-second timeout into a false cancellation pass.

Acceptance requires focused repeated cancellation tests, the full Server suite,
the repository build/docs/whitespace gates and exact-source main CI. Failed RC
tags and their zero-asset Drafts remain immutable and unpublished.

## Acceptance Evidence

Three focused rounds ran concurrently in independent owned temporary roots.
Each round passed both client-disconnect and Server-shutdown cases, and every
root was physically removed. The full Server suite then passed all 594 tests
with zero failed, canceled or skipped tests and removed its owned root. The
Server TypeScript build, 356-file documentation lint and whitespace check pass.
Exact-source hosted CI remains a publication gate for the next candidate.
