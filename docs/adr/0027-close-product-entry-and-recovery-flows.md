# ADR-0027: Close product entry and recovery flows

- Status: Accepted
- Date: 2026-08-31
- Supersedes: none
- Amends: ADR-0022 and ADR-0026

## Context

The product has governed Runs, Results, Device pairing and optional Hosted
execution, but users must still connect several technical surfaces themselves.
Ordinary members cannot resume their identity after losing a Web session, Run
ambiguity has no complete Web action path, and older work is difficult to reach.
The requested iteration improves these flows before publishing a product website.

## Decision

### Entry and work presentation

Offer distinct Central Agent, local Agent and demonstration entry paths. A
Central Agent uses the existing optional HTTPS adapter, not another service or
an installed Pi/Codex. Room grants remain explicit and Owner-only. Registration
alone is not first-use completion: show current-Room availability and guide the
user to an actual reply, while clearly distinguishing demonstration replies.

Keep provider credentials transient and write-only. Make validation plus
creation the primary operation; standalone testing is optional. Display safe
failure guidance and granted Room names, never raw provider error bodies.

Optional task templates produce the existing canonical criteria input. Existing
Result review and completion policies remain authoritative. Artifact inspection
reuses the authorized digest-verified text preview and never executes content.
An additive authorized Run ambiguity read returns the exact durable
acknowledgement or null. Explicit human acknowledgement and a new retry attempt
remain separate revisioned/idempotent commands; no automatic retry is added.
Before submitting either command, the Web records and verifies its exact
operation identity and payload in this tab's session storage, bound to the
Member, Team, Task and Run. Uncertain responses retain the receipt across detail
navigation and reload; unavailable or corrupted storage blocks submission.
Receipts are not credentials and do not grant authority. Closing the tab or
clearing browser data is not a supported cross-browser recovery mechanism.
Switching Runs immediately hides previous evidence, and recovery commands stay
disabled until the selected attempt's own evidence is successfully loaded.

### Existing-member recovery

Add a dedicated expiring recovery capability, distinct from new-member invites.
A current Team Owner may issue a 32-byte random, one-time code for an existing
ordinary member of that Team. This first version only permits a User with exactly
that one Team membership and excludes every Owner identity, including the
installation Owner: a Team Owner must not gain another Team's or Owner's Web
authority through recovery. Revalidate these conditions when consuming the code,
including the issuing Owner and non-archived Team.

The code expires after 15 minutes. Store only its SHA-256 hash in an additive
SQLite table. A replacement invalidates prior unused codes for the member, and
an authorized Owner may revoke an unused code. Show plaintext only at issuance;
the recipient pastes it into the sign-in page. Never put it in a URL, browser
storage, log, audit body, or ordinary member projection.

Claiming atomically consumes the code, revokes the target User's old Web sessions
and issues a new trusted Cookie for the same User and Member. It preserves Room
membership, Tasks, Devices and historical attribution. Anonymous claims require
the configured Origin and existing rate limiting. Replay/expiry/revocation and
out-of-scope targets fail closed. Lost claim responses require a fresh
Owner-issued code; the Server never replays stored session plaintext.

### Read-only history

Extend Room message listing with an exclusive backward cursor and an additive
older-page cursor. Cursors remain opaque and Room-bound; invalid combinations
with forward sync or tail mode are rejected. Historical pages do not move the
live synchronization checkpoint. Existing forward cursor and tail clients remain
compatible. Web merges by immutable Message identity, preserves the reader's
scroll position and drops responses from previous Room/session contexts.
The current Room's explicitly loaded window is preserved until navigation;
each backward request is bounded to 100 entries. Silent client-side trimming
must not separate the visible first entry from the opaque older-page cursor.
Every protected HTTP response, including a successful response, is fenced by
the current Web session generation before it can update browser state.

Workbench paging and filters consume the existing authorized Server projection.
They do not fabricate counters, search hidden Rooms or assemble a parallel Task
authority in the browser. Refreshes and navigation must not append stale pages
from a different Team, scope or filter.

### Website and release boundary

After product regression and browser checks, add an independently built static
product website under `site/`, published to the existing public repository's
GitHub Pages. It has no application session, database, model API, analytics,
form submission or runtime service. Download and documentation links point to
the canonical repository; an existing downloadable Release is not represented
as containing unreleased changes. Public website publication is separate from
application Release publication and physical/provider acceptance.

## Alternatives

- Add SSO, account passwords, membership transfer and global administration:
  deferred; bounded Owner-approved recovery closes the immediate identity gap.
- Treat unknown outcomes as ordinary failures and retry them automatically:
  rejected because external effects and provider acceptance can be ambiguous.
- Add another Agent service or deployment option: rejected by the product goal.
- Publish marketing before verification: rejected; capability claims follow
  the implemented and tested product rather than a speculative roadmap.

## Compatibility and Security

Bridge executables, protocol, credentials, Workspace authority and deployment
topology are unchanged. Additive HTTP read/recovery APIs stay behind the existing
Server service and authentication boundaries. Applied migrations are immutable.
No new provider, paid call, signature credential or installation is required.

## Verification

Tests cover recovery identity preservation, wrong Origin, expiry, replay,
revocation, cross-Team and Owner denial; exact ambiguity authorization; criteria
and evidence actions; backward/forward message coexistence and paging races;
first-use Room privacy and secret clearing. Production-browser evidence covers
the primary flows and narrow layouts. Static checks and exact Pages deployment
plus public HTTP checks cover the website. Full product, paid-provider and
physical-platform admission are never inferred solely from a website deployment.
