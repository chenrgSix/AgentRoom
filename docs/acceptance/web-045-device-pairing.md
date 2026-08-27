# WEB-045: Owner-guided Device pairing

Date: 2026-08-28.

## Accepted behavior

The Agent management workspace now gives a Team Owner one guided Device
pairing panel. The Owner can create one expiring session, scan a locally
generated QR or copy its registered custom link, use the manual short code,
inspect the claiming Device's safe display name/platform/Bridge version,
compare the verification phrase, and explicitly approve, reject or cancel.
Issued, claimed, approved, consumed, rejected, canceled and expired states have
visible localized projections. Non-Owners do not receive the presentation
controls; the Server remains the authorization and transition boundary.

Approval stays disabled until the Owner confirms that both displayed phrases
match. The link and QR disappear as soon as a Device has claimed the session.
A terminal state clears the one-time proof from browser storage and component
memory before the Owner can start another pairing.

## Proof and recovery boundary

The browser generates a 32-byte base64url `claimSecret` and stable operation
IDs. The custom URI contains Server origin, pairing-session identity and expiry
in the query, with `claimSecret` only in the fragment. QR SVG is encoded in a
lazy local browser chunk; the link is not submitted to an external image or QR
service.

Only an unfinished attempt is stored, under a Team-and-Member-scoped
`sessionStorage` key. A create response loss, component unmount or same-tab reload retains and
reuses the exact create `operationId` and `claimSecret`. An ambiguous Owner
decision is first reconciled through the authenticated Owner projection. If
the command has not reached its result, the explicit retry sends the same
decision operation ID and expected state. A terminal projection removes the
stored and in-memory proof instead of retaining it as history.

Create sends exactly `operationId` and `claimSecret`. Owner decisions send
only `operationId`, `expectedState`, and an optional rejection/cancel reason.
The Web projection does not receive or render Server Token, Device credential,
poll secret, Runtime configuration, command, environment, tool, permission or
Workspace detail.

## Automated evidence

`apps/web/test/device-pairing-panel.test.tsx` contains eight focused checks:

- the canonical link keeps the claim proof in its fragment;
- a non-Owner sees no pairing panel and causes no request;
- create, local QR, short code, claim inspection, phrase confirmation,
  approval and consumption use the closed payloads and clear the proof;
- an ambiguous create survives component remount and retries the identical
  browser proof;
- a late create response cannot cross a Team scope change;
- an ambiguous approval reconciles the claimed state and retries one stable
  decision;
- issued cancellation carries `expectedState: issued`; and
- claimed rejection carries `expectedState: claimed` and no local detail.

The focused checks pass. The complete Web suite passes 53 tests, including the
existing full-application onboarding flow, and TypeScript strict checking.
The production Web build passes with QR encoding split into a lazy chunk.
The full repository gate passes 139 Server, 53 Web, four Contracts and 26
embedded Bridge UI tests (222 JavaScript/TypeScript tests), plus generated Go
contract checks. All workspace production builds pass; contract validation
accepts eight schemas and 81 positive/negative fixtures. Documentation lint and
`git diff --check` also pass.

## Scope limit

This accepts the central Web half of Device pairing. It does not claim the
unified release/install path in `OPS-008`, physical two-machine operation in
`QA-028`, a signed/notarized package, or production admission. The paired
Bridge client behavior is separately evidenced by `BRG-043`.
