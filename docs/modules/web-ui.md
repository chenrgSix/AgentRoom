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
- Unified Room composer for messages, single-Agent Runs, and adaptive
  multi-Agent Discussions.
- Inline `@` suggestions that resolve typed display names to stable Agent IDs.
- Agent roster with presence and capability summaries.
- Run cards with live status, replies, cancellation, and failure details.
- Discussion Wave progress, member Run outcomes, goal adjustment,
  finalization, extension, pause, and stop controls without presenting a soft
  budget as a completion target.
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

HTTP reads establish a snapshot and an authenticated Team change channel wakes
reconciliation. Every notification has a monotonic cursor; gaps, server restart,
tab visibility changes, and reconnects trigger bounded HTTP reconciliation.
Healthy event delivery replaces broad two-second polling, while a slower
fallback remains available after channel failure. Optimistic messages carry a
client-generated idempotency identity, remain visibly pending until
acknowledged, and expose an explicit retry after failure without duplicating the
server Message or its Runs.

The UI uses schemas and generated types from `packages/contracts/`. Capability
flags control whether start, resume, interrupt, handoff, or managed execution
controls are shown.

Discussion views render the central ProgressSnapshot, Wave, member Turns, and
OrchestrationDecision; they do not derive completion from Agent prose. The
timeline shows one logical round without a hard-limit denominator. While its
all-settled barrier is open, the status shows progress such as `1/2 已结束`
and one state chip per Agent Run. Replies appear as they arrive, but the UI does
not imply that policy advanced before the barrier closed. The Room timeline
retains durable arrival order. Participant-order normalization belongs to the
server's progress aggregate and next-Wave bounded instruction; the Web client
does not reorder or duplicate Agent Messages.

Member jobs in one Wave are never presented as separate rounds. A `partial`
Wave keeps successful replies visible and identifies failed members; an
all-failed Wave explains why human action is required. The single-Agent
finalization Wave has an explicit conclusion-generating state. When a
Discussion is waiting, paused, or terminal, its status keeps the current or most
recent closed Wave visible, including each member's terminal reason. At a soft
boundary the UI offers continue solving, adjust goal, or finish with a
conclusion rather than exposing internal Wave allocation.

The Room composer classifies one submission by its distinct structured Agent
identities. No Mention stores a Room message, one Mention creates a normal Run,
and two to five Mentions create an adaptive Discussion whose goal is the message
body. Free-form `@text` is not routing metadata. Selecting and removing chips
keeps the visible tokens and stable IDs synchronized; the Server revalidates
Room membership, Agent availability, Discussion participant policy, and the
single-open-Discussion Room invariant.

Timeline messages resolve their visible author from the stable `senderId` and
the current Team roster. Registered Agent and member names are shown directly;
the generic localized Agent label is reserved for missing historical identities.

The current MVP separates Team conversation from the Agent control plane. The
Room view owns messages, mentions, and Runs. The Agents view owns runtime
roster, status, managed enrollment approval, MCP credentials, demo runtimes,
and trusted Devices. Fake Agents are explicitly labeled as simulations and are
not presented as production connections. Secrets are shown only in the
immediate setup result and are never returned by list APIs.

The Room timeline is the only vertically scrolling conversation surface. Its
Discussion status and composer are docked after the timeline in normal layout
flow, so their dynamic height never covers Message content. The Discussion
surface may scroll within a bounded height while the composer remains visible;
Mention suggestions may overlay the dock but never the persisted timeline.

The desktop context sidebar contains only the Team identity and selected Room
participants. The participant roster fills the column below the Team identity,
uses the sidebar itself as its surface, and scrolls only when the member list
exceeds the available height. Room switching, Room creation, locale selection,
and return to Chat are compact workspace-header actions. Agent management
remains a separate global rail destination, so configuration is not stacked
below Room members.

The roster and Mention suggestions are scoped to the selected Room rather than
the whole Team. A Team Owner can open the participant control beside the roster
count and independently include or exclude Team Members and enabled Agents in
an accessible modal. Every Team Owner remains selected and cannot be removed;
non-Owners never receive the control.

An empty installation presents a three-step Team, Room, and Agent onboarding
flow in the main workspace. Required fields use native browser validation;
actions remain visibly available unless a request is already in progress.
After onboarding, an always-visible action in the desktop Team rail and mobile
navigation opens the same accessible Team creation dialog. Successful creation
selects the new Team immediately; creating a second Team never requires leaving
or deleting the current Team.

Team Owners have a persistent resource-lifecycle control in the desktop rail.
Its accessible modal lists active and archived Teams and Rooms, supports inline
rename plus archive/restore, explains history retention, and keeps recovery
available after ordinary navigation hides an archived resource. Agent cards
independently expose disable/enable actions and visibly distinguish disabled
Agents. Server fences remain authoritative when active work blocks an action.

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
- Mention identities are ordered and unique. Removing a selected token removes
  its stable identity; complete-token matching prevents one Agent name from
  matching another name's prefix. Same-name chips retain their role labels for
  disambiguation. Five participants is the Web submission maximum.
- The composer has one Send action and no separate Discussion tab. Existing
  Discussion goal adjustment reuses its status panel without changing a Room
  message draft.
- Cancellation actions show their current authoritative outcome.
- **Finish and generate conclusion** is the primary Discussion stop action;
  stop-after-round, pause, and resume are applied at the Wave boundary, while
  immediate cancellation explicitly targets every active member Run.
- Bodyless HTTP requests do not declare a JSON content type.
- Render messages, Runtime output, and failure details as untrusted content.
- Never expose device secrets or raw Runtime environment values.
- Meet keyboard navigation and visible focus requirements for core workflows.

## Verification and Tasks

Component tests cover onboarding state transitions, Chinese-default locale,
Agent management, enrollment approval, the unified no-Mention, one-Mention,
and multi-Mention paths, Room-scoped participant editing and Mention filtering,
resource rename/archive/restore, Agent disable/enable, participant identity,
Wave barrier progress, member failure, finalization, and finish controls. They
also assert that no separate
Discussion entry remains and no duplicate Agent reply is rendered. Existing
browser acceptance covers message, Mention, reconnect, Run progress, reply, and
cancellation. A public end-to-end two-Agent parallel Discussion persists its
conclusion in `QA-010`. Existing UI work is tracked through `WEB-019`; Wave
presentation and acceptance are completed by `WEB-020` and `QA-010`.

`WEB-021` replaces first-page polling with a newest-100 snapshot, resumable
cursor deltas, duplicate suppression, and a 500-message browser history bound.
Refresh is single-flight and only merges messages, so a slow response cannot
overwrite a newer Room projection. `WEB-022` reads the existing authorized
Run-event API once for each terminal failure and renders only the error code,
allowlisted category, exit code, and localized recovery guidance. Raw Runtime
stderr, paths, messages, and unknown detail keys never enter the view model.

`WEB-027` clears an ordinary zero/one-Mention draft into a visible optimistic
row with one client Message ID. A failed row remains in the Room with an
explicit retry action that reuses the same identity; a successful response
merges immediately and then reconciles authoritative history. Composer, Team,
participant, and lifecycle mutations use independent pending state, so an
unrelated control no longer freezes message entry or recovery.

## Dependencies

Team/Room, Registry, Run Orchestration, Bridge pairing APIs, and Security.
