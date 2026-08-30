# ADR-0031: Preserve cross-layer Bridge recovery

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none
- Amends: ADR-0029 and ADR-0030

## Context

The strict follow-up audit found nine gaps across ordinary configuration edits,
historical result replay, desktop activation and native packaging. Local unit
tests passed without exercising these cross-layer transitions.

## Decision

Central validates a managed Run's reported Runtime scope against its immutable
Delivery snapshot, not the Agent's latest publication. Ownership, trace,
sequence, cancellation and evidence-page checks remain enforced, including for
duplicate events. Missing scoped Delivery evidence fails closed. Legacy events
without evidence/scope fields retain their existing compatibility behavior.
No inbox result is discarded to make reconnection succeed.

Creating an Agent is distinct from recovering an existing configured identity.
A historical display-name alias cannot become a second active configuration
with the same ID. Allocate a separate ID for that explicit creation; retain the
existing Agent's identity. Ambiguous already-duplicated configurations fail
closed instead of guessing which Runtime owns historical work. Reservation
before configuration replacement remains retryable without rotating an active
identity or discarding history.

All ordinary Runtime edits copy the saved profile and apply only supported
explicit changes. Metadata-only edits preserve commands, environment policy,
output protocol, preset version and Runtime scope. Changing the Pi credential
variable replaces that selected variable only; it does not reset other owner
environment entries. Runtime-kind conversion remains unsupported.

Desktop transport admission and UI delivery are separate boundaries. Keep the
existing activation queue and Console lifecycle owner; release pending intent
only after the first actual WebView page load, never merely ApplicationStarted.
Go and the final page accept the same supported pairing URL forms and bounded
encoded payloads. Validation failures do not persist or log claim secrets.

Every native test command must propagate failure to CI and Release. Silent
installation must not wait for prerequisite dialogs. Packaging resolves output
paths before changing directories. macOS bundle metadata, compiler deployment
target and artifact checks share a minimum version consistent with Go 1.26.
No installer gains automatic dependency installation or user-data ownership.

## Compatibility and security

No new service, provider access, wire schema or database migration is required.
Existing immutable Delivery payloads contain the Runtime scope. Do not weaken
authentication or substitute the current scope for a different historical
scope. Existing name/identity files remain readable. Native Windows execution,
minimum-version macOS execution and release publication are separate evidence
gates; local compilation must not be reported as satisfying them.

## Verification

Cover changed-scope replay before and after terminal delivery, repeated
reconnect, forged scope and ordinary subsequent work; rename then old-name
creation, reload, failed save and ambiguous identity rejection; complete preset
metadata preservation and explicit policy edits; early desktop activation and
final-page URL consumption; native command failure propagation, missing
WebView2, relative output paths and deployment-target checks. Run relevant
Server, Bridge, embedded UI, packaging, race, vet, schema and integration gates.
The task register is the only delivery checklist.
