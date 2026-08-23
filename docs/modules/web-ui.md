# Web UI

## Scope

- Prefix: `WEB`
- Planned location: `apps/web/`
- Owns: browser presentation state and user interaction

The browser client is the primary Team conversation surface. It renders
authoritative server state and sends user intents; it does not contain routing,
authorization, or Run state-machine logic.

Simplified Chinese is the default presentation language. English remains
available through an in-product switch, and the selected locale is persisted
only in browser-local preferences. Protocol identifiers, commands, user data,
and server-owned payloads are never translated.

Dark is the default presentation theme. Users can switch to a light theme from
desktop or narrow-screen navigation, and the choice is persisted locally
without changing server-owned state.

## Primary Surfaces

- Authenticated Team and Room shell.
- Trusted-team Owner setup/recovery, member invitation claim, session restore,
  logout, and Owner invitation controls without exposing session credentials to
  JavaScript.
- Ordered message timeline and thread view.
- Structured Agent mention and handoff composer.
- Inline `@` suggestions that resolve typed display names to stable Agent IDs.
- Agent roster with presence and capability summaries.
- Run cards with live status, replies, cancellation, and failure details.
- Discussion composer, progress explanation, finalization, extension, pause,
  and stop controls without presenting a soft budget as a completion target.
- Dedicated Agent management workspace with roster and availability summaries.
- Managed Bridge approval, MCP setup, Device revocation, and local policy guidance.
- Selected Room participant roster projected from Team members and visible Agents.
- Context sidebar ending at the selected Room participant roster, without
  workspace, configuration, or account modules beneath it.
- Full-height participant column without a nested card or fixed-height roster.
- Narrow-screen navigation for Chat, Agent management, and locale selection.
- Persistent light and dark presentation themes for desktop and narrow screens.

There is no native desktop GUI in the MVP. Runtime access is provided by the
optional headless Bridge, keeping existing agent clients unchanged.

## Data Flow

HTTP reads establish a snapshot and WebSocket events advance it. Every stream
event has a cursor; gaps or reconnects trigger server reconciliation. Optimistic
messages remain visibly pending until acknowledged and are replaced by their
server-assigned identity.

The UI uses schemas and generated types from `packages/contracts/`. Capability
flags control whether start, resume, interrupt, handoff, or managed execution
controls are shown.

Discussion views render the central ProgressSnapshot and OrchestrationDecision;
they do not derive completion from Agent prose. The timeline shows the current
turn ordinal without a denominator. At a soft boundary it explains resolved and
unresolved goals and offers semantic actions such as continue solving, adjust
goal, or finish with a conclusion rather than requiring users to choose an
internal turn allocation.

Timeline messages resolve their visible author from the stable `senderId` and
the current Team roster. Registered Agent and member names are shown directly;
the generic localized Agent label is reserved for missing historical identities.

The current MVP separates Team conversation from the Agent control plane. The
Room view owns messages, mentions, and Runs. The Agents view owns runtime
roster, status, managed enrollment approval, MCP credentials, demo runtimes,
and trusted Devices. Fake Agents are explicitly labeled as simulations and are
not presented as production connections. Secrets are shown only in the
immediate setup result and are never returned by list APIs.

The desktop context sidebar contains only the Team identity and selected Room
participants. The participant roster fills the column below the Team identity,
uses the sidebar itself as its surface, and scrolls only when the member list
exceeds the available height. Room switching, Room creation, locale selection,
and return to Chat are compact workspace-header actions. Agent management
remains a separate global rail destination, so configuration is not stacked
below Room members.

An empty installation presents a three-step Team, Room, and Agent onboarding
flow in the main workspace. Required fields use native browser validation;
actions remain visibly available unless a request is already in progress.

In trusted-team mode, an unauthenticated browser never calls the local
bootstrap route. It renders setup only when the Server reports an empty
installation, accepts an Owner recovery secret only in component memory, and
clears it immediately after the request. Member invitation tokens are read
from the URL fragment, removed before network activity, and exchanged for an
HttpOnly session Cookie. The UI never reads or stores the Cookie value.

## Interaction and Security Rules

- Mentions select a registered Agent identity, not free-form `@text` parsing.
- Typing `@` opens the visible Agent suggestion list; selecting a result inserts
  its display name while retaining its stable identity for submission.
- Cancellation actions show their current authoritative outcome.
- **Finish and generate conclusion** is the primary Discussion stop action;
  stop-after-turn, pause, resume, and immediate cancellation remain explicit.
- Bodyless HTTP requests do not declare a JSON content type.
- Render messages, Runtime output, and failure details as untrusted content.
- Never expose device secrets or raw Runtime environment values.
- Meet keyboard navigation and visible focus requirements for core workflows.

## Verification and Tasks

Component tests cover onboarding state transitions, Chinese-default locale
persistence, Agent management navigation, enrollment approval, capability
gating, Discussion creation, participant identity, and finish controls.
Browser acceptance covers message, mention, reconnect, Run progress, reply,
cancellation, and a two-Agent adaptive Discussion that reaches a persisted
final conclusion. Work is tracked by `WEB-001` through `WEB-018` in
`docs/TASKS.md`.

## Dependencies

Team/Room, Registry, Run Orchestration, Bridge pairing APIs, and Security.
