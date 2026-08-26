# Web UI

## Scope

- Prefix: `WEB`
- Planned location: `apps/web/`
- Owns: browser presentation state and user interaction

The browser client is the primary Team conversation surface. It renders
authoritative server state and sends user intents; it does not contain routing,
authorization, or Run state-machine logic.

Presentation is split under `apps/web/src/features/` by product responsibility:
Auth owns the access gate, Team owns member and lifecycle surfaces, Room owns
the timeline and Room settings, Agent owns roster and Device presentation,
Bridge owns enrollment controls, Run owns activity and diagnostic presentation,
Discussion owns Wave status and controls, and Task owns selection, creation, and
clarification surfaces. Shared HTTP behavior lives in `api-client.ts`, while
browser projection types live in `models.ts`. The Room composer owns its draft,
Mention selection, outbox retry, and multi-Agent submission state through
`useRoomComposer`; Discussion selection, goal editing, and lifecycle commands
are isolated in `useDiscussionController`. `App.tsx` remains the page-level
coordinator for authoritative state reconciliation and shell composition;
feature controllers send user intents but do not derive or override
Server-owned state machines independently.

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
- Safe Markdown/GFM narrative rendering for durable and provisional messages,
  including headings, lists, tables, task lists, links, images, and code blocks.
- Unified Room composer for messages, single-Agent Runs, and adaptive
  multi-Agent Discussions.
- Current-Task selector and Task creation flow; routed Messages and Discussions
  always submit the selected Task and terminal Tasks disable new work.
- Task clarification card with bounded choices or a free-form authorized Room
  answer, explicitly distinguished from local Runtime permission approval.
- Selected-Task Artifact snapshot cards and an on-demand pure-text preview for
  verified Patch, Markdown, and JSON bytes, explicitly labeled as semantically
  untrusted evidence.
- Inline `@` suggestions that resolve typed display names to stable Agent IDs.
- Agent roster with presence and capability summaries.
- Run cards with live status, replies, cancellation, and failure details.
- Discussion Wave progress, member Run outcomes, goal adjustment,
  finalization, extension, pause, and stop controls without presenting a soft
  budget as a completion target.
- Dedicated Agent management workspace with roster and availability summaries.
- Managed Bridge approval, MCP setup, Device revocation, and local policy guidance.
- Selected Room participant roster projected from Team members and visible Agents.
- Owner-only Room settings for participant access, multi-Agent Discussion,
  `@all`, Agent-to-Agent handoffs, and maximum handoff depth.
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

For managed Agents that publish streaming capability, the same Team change
channel wakes cursor-based Run-event reads. The browser keeps at most one
provisional output bubble per active Run, applies ordered additions and reset
boundaries, and reconstructs it from sequence zero after a reload. A final
`run.reply` removes that projection and the normal durable Room Message takes
its place, so partial output is never inserted into message history and cannot
appear twice. Final-only Agents retain the existing Run-card behavior.

Reasoning summaries and tool lifecycle use the same event cursor but render as
one compact disclosure inside the owning Agent flow. Active work opens by
default; completed work can collapse. Reasoning uses the existing untrusted
Markdown renderer, while tool rows show only the server-approved name and
phase. The UI never labels this as hidden chain-of-thought and never receives
structured commands, arguments, tool input/output, or approvals as activity.

Team change notifications carry either a full-Team hint or changed Room IDs.
Run-output/activity hints fetch only the selected Room's current Runs plus
unseen events. Other selected-Room hints add messages and Discussions. Agents,
members, Devices, and Room settings are reloaded only for full, legacy, reset,
or reconnect reconciliation; unrelated Room hints do not trigger selected-Room
reads.

The UI uses schemas and generated types from `packages/contracts/`. Capability
flags control whether start, resume, interrupt, handoff, or managed execution
controls are shown.

The selected Task loads its clarification records independently of message and
Run projections. Each waiting question appears in normal dock layout above the
composer, names the requesting Agent, and explains that the answer becomes a
Room Message and same-Task continuation rather than a local permission grant.
Submitting an answer is single-flight, replaces the waiting record with the
Server result, and reconciles the Room so the new bounded Run and Messages are
visible.
The clarification read reconciles deadline and scope before rendering, so a
canceled or expired record disappears from the answer surface and retains its
durable resolution reason for history.

The selected Task also loads its canonical Artifact page. Only
`snapshot_blob` records offer preview. An on-demand Member-authorized endpoint
re-resolves the canonical content identity, checks Team scope and the sealed
size/SHA-256, requires valid UTF-8, and returns at most 200,000 characters with
an explicit truncation bit. Its JSON response is `no-store` and `nosniff` and
contains no Workspace path, Blob storage key, or source filename. The browser
renders Patch, Markdown, and JSON bodies inside one escaped `<pre>` boundary;
it never parses HTML or uses the normal Markdown renderer. The visible label
keeps byte integrity distinct from trust in the Agent-authored meaning.

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
recent closed Wave available, including each member's terminal reason. The
docked surface defaults to a single compact summary row containing authoritative
Discussion state, truncated goal, and member progress. Expanding that row reveals
Wave details and controls; a transition to a terminal state collapses it again so
completed work does not permanently consume conversation space. At a soft
boundary the expanded UI offers continue solving, adjust goal, or finish with a
conclusion rather than exposing internal Wave allocation.

The Room composer classifies one submission by its distinct structured Agent
identities and the current Server-owned Room policy. No Mention stores a Room
message and one Mention creates a normal Run. Two to five Mentions create an
adaptive Discussion whose goal is the message body when Discussions are
enabled; when they are disabled, the same submission creates one Message and
parallel one-shot Runs so each selected Agent replies once. The Web resolves a
complete `@Agent name` only when it exactly matches one current-Room identity;
the reserved exact command `@all` expands to the full current-Room Agent roster
only when allowed. Prefix, substring, and role matches never route, and
same-name commands remain ambiguous until the user selects a specific identity.
Selecting and removing chips keeps the visible tokens and stable IDs
synchronized; the Server revalidates Room membership, Agent availability,
Discussion participant policy, and the single-open-Discussion Room invariant.
The composer previews exact matches before submission. Browser acceptance types
an exact full name, a non-matching prefix, and `@all` without sending a Message;
component coverage verifies the resulting single-Run and Discussion payloads.

The composer offers a default-off **Keep last @ mentions** switch. Only its
boolean preference is persisted in browser-local storage; Agent identities and
message drafts are not. When enabled, an ordinary submission pre-fills the next
draft with the resolved Agent names and stable-ID chips. Successful Discussion
creation does the same, but a late response cannot overwrite a newer draft or
another Room/Task. The retained tokens remain visible, editable, and removable;
turning the switch off removes automatically retained tokens without deleting
the user's new message text. A draft containing only retained tokens cannot
accidentally submit another Run. An exact `@all` retains its concrete recipients,
not a dynamic expansion to future roster members. Existing multi-Agent policy,
five-Agent limits, and active-Discussion guards still apply.

Changing Room, Task, or signed-in identity clears the composer draft and its
targets. Removed, disabled, or renamed retained Agents lose their old tokens
rather than resolving them to a different identity. Presence alone does not
clear a target: offline delivery keeps the existing queue semantics. Failed
ordinary messages retain the original outbox payload and client Message ID;
retry never reads or overwrites the current draft's recipients. These are Web
presentation preferences only, not a Server routing fallback or session policy.

Timeline messages resolve their visible author from the stable `senderId` and
the current Team roster. Registered Agent and member names are shown directly;
the generic localized Agent label is reserved for missing historical identities.
Durable and provisional content use the same React-native Markdown renderer.
Raw HTML is ignored, protocol URLs retain the renderer's safe URL transform,
cross-origin HTTP(S) links open with `noopener noreferrer`, and remote images
load lazily without a referrer. The Web does not import Agentdown directly:
Agentdown is currently a Vue 3 Runtime, while this application is React 19;
shipping both UI runtimes would duplicate message and Run ownership. The Web
instead follows the same block-safety principles at its existing projection
boundary.

The current MVP separates Team conversation from the Agent control plane. The
Room view owns messages, mentions, and Runs. The Agents view owns runtime
roster, status, managed enrollment approval, MCP credentials, demo runtimes,
and trusted Devices. Fake Agents are explicitly labeled as simulations and are
not presented as production connections. Secrets are shown only in the
immediate setup result and are never returned by list APIs.

The Room timeline is the only vertically scrolling conversation surface. Its
Discussion status and composer are docked after the timeline in normal layout
flow, so their dynamic height never covers Message content. Discussion status
uses a compact, keyboard-accessible disclosure row by default; its detailed
Wave surface may scroll within a bounded height while the composer remains
visible. Mention suggestions may overlay the dock but never the persisted
timeline. Request errors participate in workspace layout above the timeline
and clear when the user edits the draft, so an error cannot cover the Send
action or stale-block a corrected command.

The desktop context sidebar contains only the Team identity and selected Room
participants. The participant roster fills the column below the Team identity,
uses the sidebar itself as its surface, and scrolls only when the member list
exceeds the available height. Room switching, Room creation, locale selection,
and return to Chat are compact workspace-header actions. Agent management
remains a separate global rail destination, so configuration is not stacked
below Room members.

The roster and Mention suggestions are scoped to the selected Room rather than
the whole Team. A Team Owner can open Room settings beside the roster count or
from the compact composer policy summary. The same accessible modal
independently includes or excludes Team Members and enabled Agents and configures
Discussion, `@all`, Agent handoff, and depth policy. Every Team Owner remains
selected and cannot be removed; non-Owners never receive the control. The
composer summary exposes the effective mode without turning Discussion into a
separate Send action.

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
Agents. The current Room heading also exposes an Owner-only action menu with a
recoverable archive shortcut and an explicit confirmation dialog. The shortcut
disappears with the archived Room, while restoration remains centralized in the
resource-lifecycle surface. Active Runs or Discussions disable the menu action
with a visible reason; Server fences remain authoritative if state changes
during confirmation.

In trusted-team mode, an unauthenticated browser never calls the local
bootstrap route. It renders setup only when the Server reports an empty
installation, accepts an Owner recovery secret only in component memory, and
clears it immediately after the request. Member invitation tokens are read
from the URL fragment, removed before network activity, and exchanged for an
HttpOnly session Cookie. The UI never reads or stores the Cookie value.

## Interaction and Security Rules

- Exact Mention commands resolve only against registered current-Room Agent
  names; `@all` is the only reserved expansion command.
- Typing `@` opens the visible Agent suggestion list; selecting a result inserts
  its display name while retaining its stable identity for submission.
- Mention identities are ordered and unique. Removing a selected token removes
  its stable identity; complete-token matching prevents one Agent name from
  matching another name's prefix. Same-name chips retain their role labels for
  disambiguation. Five participants is the Web submission maximum.
- The composer has one Send action and no separate Discussion tab. Existing
  Discussion goal adjustment reuses its status panel without changing a Room
  message draft.
- The docked Discussion summary remains one row until explicitly expanded;
  terminal transitions restore the compact state while preserving on-demand
  access to final Wave details and failure reasons.
- Cancellation actions show their current authoritative outcome.
- **Finish and generate conclusion** is the primary Discussion stop action;
  stop-after-round, pause, and resume are applied at the Wave boundary, while
  immediate cancellation explicitly targets every active member Run.
- Bodyless HTTP requests do not declare a JSON content type.
- Render messages, Runtime output, and failure details as untrusted content.
- Render Artifact snapshot previews only as escaped plain text; a verified
  digest does not make the content trusted or executable.
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
Composer and Discussion controller extraction is tracked by `WEB-038`.

`WEB-041` adds the browser-local Mention retention preference. Focused hook
regressions and the full-App integration cover continuation, stable identity,
scope/roster changes, outbox retry, and stale completions; isolated production
browser screenshots and limits are recorded in
[the local acceptance](../acceptance/web-041-mention-retention.md).

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

`WEB-029` projects authenticated `run.output_delta` events into an untrusted,
plain-text generating bubble. It preserves one cursor per Run, ignores stale
duplicates, clears on reset or final reply, and discards previews for Runs that
become terminal without a reply. Reload and Team-change reconciliation use the
same reducer, so the live and recovery paths cannot diverge.

`WEB-030` keeps the timeline as the only scrolling conversation surface while
giving it a bounded reading measure, distinct Member and Agent message shells,
larger narrative typography, responsive code/table overflow, and a visually
anchored dock. Streaming and final replies share Markdown rendering so the
authoritative replacement changes state rather than presentation semantics.
Isolated real-browser acceptance covers desktop light/dark themes plus 720 px
and 390 px widths; both narrow layouts retain zero horizontal page overflow and
place the dock immediately after the timeline rather than over its content.

`WEB-031` removes duplicated routing metadata once authoritative Runs exist.
Agent replies use an open narrative row, Member prompts use one restrained
right-aligned bubble, and each triggered Run becomes one compact status panel.
Failure guidance stays attached to its owning Run without stretching sibling
targets or turning Mention labels into empty oversized pills. A component
regression covers the Mention-to-Run replacement, and light/dark real-browser
acceptance confirms the production shell has no horizontal overflow.

`ROOM-007` adds the Owner-only Room collaboration settings surface and compact
composer summary. Component coverage proves atomic policy/participant writes,
disabled `@all`, one-shot multi-Agent submission, and retained multi-target
outbox retries. Settings open and Team-change reconciliation load the combined
Room settings resource, while revision-fenced writes reload newer state instead
of overwriting another client. Direct Mention parsing uses the longest known
exact Agent name before current-Room eligibility. Isolated real-browser
acceptance proves two fake Agents each reply once without creating a Discussion,
while light theme and 760 px and 390 px settings layouts retain zero horizontal
overflow.

`WEB-035` adds the inline activity disclosure and `WEB-036` scopes healthy
live reconciliation to the changed Room. Reducer tests cover ordered reasoning
and tool lifecycle, while Team-change tests cover aggregated Room hints and the
full-refresh compatibility fallback.

## Dependencies

Team/Room, Registry, Run Orchestration, Bridge pairing APIs, and Security.
