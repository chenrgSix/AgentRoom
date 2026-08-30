# ADR-0029: Preserve Bridge results, configuration and instance ownership

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none
- Amends: ADR-0021 and ADR-0025

## Context

The Bridge audit found three independent regressions: a terminal event's send
failure overwrites its durable outcome, ordinary Generic CLI editing rebuilds a
Codex preset, and the desktop acquires Console state ownership before deciding
whether it is a secondary launch. The last ordering prevents an already running
window from receiving a pairing link or wake request.

## Decision

### Durable outcome is distinct from delivery

After an Adapter error, read the durable inbox before inferring uncertainty.
If a terminal result or recoverable `input_required` boundary already exists,
preserve its sequence, events and observation and return the delivery failure.
Reconnect and duplicate delivery replay that record without another Runtime
invocation. Only unfinished execution retains the existing unknown-outcome
recovery rule. Do not clear a cancellation fence before successful delivery.

### Editing is not Runtime conversion

Ordinary Agent editing is bound to the saved Runtime kind and stable Agent ID.
For a Generic CLI profile, copy its complete saved local configuration and
change only supported metadata and local Workspace/privacy settings. Preserve
the command, arguments, environment policy, output protocol and other Runtime
fields. Runtime discovery and preset probes cannot rewrite a Generic profile.
Reject attempts to switch Runtime kind through an ordinary edit. Creation may
still select Codex or Pi; a future conversion feature needs a separate explicit
operation and is not added here.

### Desktop arbitration precedes state ownership

Decide primary versus secondary desktop launch before constructing the Console,
opening mutable Bridge state or starting a worker. Forward secondary activation
only to the existing desktop instance, without weakening the data-root lock.
Retain a bounded pending activation accepted by the local transport until the
window is ready. Windows waits a bounded time for the primary window and
requires acknowledgement instead of silently succeeding on a lost send.
Pairing input remains validated and is
carried only through the existing local activation/WebView-fragment boundary,
never logged or persisted as a desktop rendezvous credential.

The Console remains the single Bridge lifecycle owner. Platform-specific
activation plumbing is not another worker state machine. Keep the stable
desktop application identity and CLI exclusive-lock behavior.

Non-Windows platforms retain the pinned Wails transport. On macOS, Wails takes
its instance lock in `application.New` but registers its native notification
listener during `Run`; a notification in that intervening startup window has
no acknowledgement. The application queue protects events delivered by Wails,
not notifications Wails never received. Replacing that native transport is
outside this repair; do not claim cross-platform simultaneous-start delivery.
The subsequently accepted ADR-0030 implements the requested macOS follow-up
with an early acknowledged transport, replacing this deferral.

## Compatibility and limits

No Server, wire schema, database migration, deployment service, provider call,
Release publication or broad Console decomposition is required. Existing
Generic profiles need no migration. The editor no longer implicitly converts
between Runtime kinds; users can create a separate supported profile. Native
Windows execution and packaged protocol activation are distinct from local
tests and cross-compilation and must be reported separately.

## Verification

Add terminal-send-failure, restart/replay, duplicate and unfinished-execution
regressions; Generic metadata-edit preservation and cross-kind negative tests;
and desktop activation ordering, early-launch and ownership tests. Run relevant
Go, race, vet, desktop-build, embedded UI and deterministic integration gates.
Delivery state and evidence live only in the task register.
