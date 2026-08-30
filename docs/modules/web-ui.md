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

## Product Entry and Recovery

[ADR-0027](../adr/0027-close-product-entry-and-recovery-flows.md) defines
Central/local/demo setup choices, current-Room readiness and a first-reply
destination. Hosted setup validates during creation, explains safe failures and
Room access, and keeps credentials transient. Member access recovery is an
explicit Owner-issued short-lived code, not a new invitation or password store.

Work creation may add canonical acceptance criteria through simple templates.
Run ambiguity is read from the exact Run record; acknowledgement and retry stay
separate authorized actions. Evidence review reuses the verified Artifact preview.
Workbench filters/cursors and backward Room history remain Server-authorized;
history loading neither advances live sync nor replaces a newer navigation.
Loaded Room pages remain available until leaving that Room; refreshing Work
preserves the loaded page window and waits for an in-flight load-more request.
Protected response generation checks reject stale successes as well as 401s,
so switching identities cannot restore an old Team or credential output.
Derived Run recovery refreshes also require the originating session and detail
to remain current. A protected 401 during initial activation returns directly
to the correct trusted/local entry gate, even before React effects reattach.
Reconciliation after a failed initial Room read restores backward pagination;
normal live refresh does not reset an already loaded history window.
Uncertain Run recovery commands keep exact identity-bound receipts in this
tab's session storage across detail navigation/reload. Storage failure blocks
new submission; receipts never replace server authorization or revision checks.
Attempt changes synchronously hide old evidence and disable recovery until the
selected attempt's evidence loads. Task creation supports optional criteria,
bounded dialog scrolling, contained Tab navigation and Escape/focus restoration.

## Primary Surfaces

[ADR-0028](../adr/0028-preserve-continuous-web-work.md) adds Work creation and
navigation-only next-action shortcuts, allowlisted authorized URL restoration,
bounded Server Task search and identity/context-scoped tab-local draft/outbox
recovery. Session invalidation clears saved unsent work; storage failure is
visible and never causes automatic replay. Shared session and Room controllers
own lifecycle fences and synchronization, not Server domain decisions.

- Authenticated Team and Room shell.
- Default Team Workbench with Mine/Team scope, authorized Task grouping, every
  attention reason, criteria coverage, budget/telemetry, latest Run/Result, and
  exact next-action projection.
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
- Agent cards show the authenticated managed Runtime's bounded file-access
  summary as read-only, Workspace write, local policy, or not reported. This
  surface never receives or renders Workspace paths, commands, tools,
  environment variables, Provider details, accounts, or credentials.
- Run cards with live status, replies, cancellation, and failure details.
- Discussion Wave progress, member Run outcomes, goal adjustment,
  finalization, extension, pause, and stop controls without presenting a soft
  budget as a completion target.
- Dedicated Agent management workspace with roster and availability summaries.
- Managed Bridge approval, MCP setup, Device revocation, and local policy guidance.
- Owner-only Device pairing with a browser-local one-time claim proof, locally
  encoded QR, manual short code, exact verification phrase, explicit
  approve/reject/cancel controls, and recoverable terminal-state projection.
- Target pairing trust presentation that omits overrides for public CA and
  carries one closed exact-origin private descriptor in local link/QR fragments
  without implying that Bridge trust changes browser or OS trust.
- Same-owner central Agent creation from an online Bridge template, with a
  transient management-code input and durable pending, rejected, or ready
  status but no local Runtime configuration or saved-code projection.
- Owner-only Central Hosted Agent setup after Server startup: supported
  provider/model selection, write-only API-key input, content-free connection
  test, explicit initial Rooms, create, replace/revoke credential, and
  disable/re-enable controls without deployment configuration.
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

## Target Work Information Architecture

[ADR-0022](../adr/0022-make-task-run-and-result-the-primary-work-model.md)
changes the default authenticated destination to **Work** while retaining Chat,
Agents, and Devices as first-class destinations. `WEB-046` provides the default
Team Workbench and `WEB-047` provides its Task, Run, Result, Artifact,
Discussion, and bounded Audit detail views. These remain first-class Work
surfaces rather than chat disclosures.

Work consumes a Team-scoped, Room-authorized read model and groups Tasks that
need human action, are executing, await review, are blocked, or recently
completed. It never loops over every Room in the browser, stores independent
dashboard counters, invents a percentage, treats unknown telemetry as zero, or
uses a display number as an API identity. Cursor, filters, all attention reasons,
primary badge, latest Run/Result, criteria coverage, budget usage, and next
action come from the Server projection.

The browser performs one `/api/teams/:teamId/work-items` read for the selected
scope and refreshes it from the authenticated Team change cursor. It never
enumerates Room Task endpoints to assemble Work. Card labels use `TASK-n` only
for presentation; opening a card carries the opaque Task and Room identities.
The Mine scope includes Tasks owned by the Member plus Tasks assigned to an
Agent owned by that Member, still bounded to Rooms the Member can access.

Task detail opens Overview with goal, canonical criteria, human Owner, explicit
Agent assignments, lifecycle/scheduling state, attention, current execution,
latest Result, open questions, budget, and next action. Runs, Results, Artifacts,
Discussion, and Audit are separate views. Result review controls appear only to
the Task Owner or Team Owner and never infer permission from the projected next
action.

The detail controller reads one authorized Task and then its Task-scoped Runs,
Results, Artifacts, and Room Discussion projection. `GET /api/tasks/:taskId/runs`
and `GET /api/runs/:runId` authorize against the Run's current Room before
returning immutable identity and state; existing event and Context Manifest
routes remain the detailed evidence sources. Refresh races are last-request-wins
and a Workbench wakeup refreshes data without resetting the selected tab.

Run detail shows the authoritative state plus optional durable diagnostic phase,
execution identity, trigger, redacted frozen Context Manifest, closed permission
summary, ordered events, provisional output, terminal outcome, and linked Result.
Connection loss remains metadata and `outcome_unknown` remains visible. A retry
creates a new attempt; retry after ambiguity requires a separate explicit human
acknowledgement. Generic Run pause is not shown.

Result detail renders immutable submission version, exact source, definition,
and criteria revisions, criterion claims, existing evidence links, risks,
questions, next actions, and append-only review decision. Correction creates a
new version; accept/reject never edits Agent-authored content. An authorized
Member may turn one keyed next action into an idempotently linked same-Room child
Task without copying evidence or acceptance. Accepted Result and Task
completion may be one revisioned command, and a stale Result or partial Result
with an unresolved required criterion cannot masquerade as completion.

Room Chat remains the ordered discussion surface. New UI requires an explicit
runnable Task or visible quick-work default before sending an Agent Mention.
No-Mention messages remain ordinary conversation. Run and Result lifecycle adds
only bounded linked summaries to the Room rather than copying output streams,
Result bodies, review controls, or evidence.

Result proposal and review append idempotent system summaries containing only
the Team-local Task label, Result version/state, optional completion fact, and
an opaque same-origin Work link. The Room renderer accepts that navigation only
for closed Team, Room, and Task identity shapes. It does not copy Result prose,
review reasons, evidence, local paths, or execution logs into Chat.

Work tabs implement roving focus with Arrow Left/Right, Home, End, Enter, and
Space behavior. Untrusted Task, Run, Result, Artifact, and Discussion text is
rendered as text rather than executable markup. At the narrow breakpoint the
content grids become one column while the tab list owns its bounded horizontal
scroll, preventing page-level overflow.

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

Device pairing is a separate Owner-only presentation controller. It generates
`claimSecret` and create/decision operation identities in the browser, stores
the in-progress proof only in Team-and-Member-scoped `sessionStorage`, and sends the exact
contract body to the Server. A lost create response is retried with the same
`claimSecret` and operation ID, including after a component remount. A lost
decision response is reconciled through the authenticated Owner projection;
the same decision operation ID is retried only while the authoritative state
still permits it. Active sessions poll at a bounded interval and also expose a
manual refresh. Terminal state removes the secret from storage and React
state before offering another pairing.

The pairing link uses the registered `convenewire://pair-device` scheme with
Server origin, session identity and expiry in its query and `claimSecret` in
the URI fragment. QR encoding runs locally in a lazy browser chunk; no link or
proof is sent to a third-party QR service. Once a Device claims the session,
the Web hides the link and renders only the closed safe Device summary,
verification phrase and Owner decisions. It never receives or renders a
Server Token, Device credential, poll secret, Runtime configuration, command,
environment value, tool setting, permission detail or Workspace path. Server
authorization and pairing transitions remain authoritative; hiding the panel
from non-Owners is presentation, not the security boundary.

`WEB-048` implements the ADR-0023 projection. For a public-CA session the Owner
projection and generated link omit all trust override fields. For an explicitly
private-scoped installation, the authenticated projection supplies one closed
public descriptor containing the exact origin, stable installation ID,
monotonic trust epoch and canonical CA DER digest. Web validates and copies that
exact object into the locally generated link/QR fragment beside the claim
secret; status refresh must preserve the same descriptor and a claimed private
Bridge must report the scoped-trust capability. Web never fetches a CA private
key, chooses a digest, or infers trust from browser state. Server owns inclusion
of that immutable session descriptor in the verification-phrase transcript.

Private-scoped first pairing does not render the short code because a short code
is not a Server identity proof. Terminal clearing removes both claim proof and
trust descriptor from React, the DOM and `sessionStorage`. Copy states explicitly
that scoped trust applies only to Bridge, requires no Windows or macOS CA
installation, and cannot make another browser trust a private certificate; the
UI never asks a user to click through a certificate warning or install a root as
the normal path.

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
cross-origin HTTP(S) links open with `noopener noreferrer`, and cross-origin
images render as an explicit external link instead of issuing an implicit
request. Same-origin and relative images may load lazily without a referrer.
Central's Content Security Policy independently restricts image requests to
same-origin and `data:` resources. The Web does not import Agentdown directly:
Agentdown is currently a Vue 3 Runtime, while this application is React 19;
shipping both UI runtimes would duplicate message and Run ownership. The Web
instead follows the same block-safety principles at its existing projection
boundary.

The current MVP separates Team conversation from the Agent control plane. The
Room view owns messages, mentions, and Runs. The Agents view owns runtime
roster, status, managed enrollment approval, MCP credentials, demo runtimes,
Central Hosted profiles, and trusted Devices. Fake Agents are explicitly
labeled as simulations and are not presented as production connections.
Secrets are shown only in the immediate setup result and are never returned by
list APIs.

ADR-0026 makes Hosted setup optional. An unconfigured installation shows one
non-blocking Owner action and otherwise preserves the existing Agent, Room, and
readiness experience. The form explains that Hosted Agents send authorized
Room context to the selected external provider and have no computer, shell,
filesystem, Workspace, or Bridge capability. Initial Room selection is
explicit and never defaults to every Room.

The API-key control is write-only and cleared after every settled create,
replace, revoke, or failed transport attempt. A configured card receives only
provider/model labels, profile revision, configured/revoked state, safe latest
test observation, derived Presence, and active-work fence. It never receives
plaintext, ciphertext, nonce/tag, Authorization headers, provider response
bodies, account/quota detail, or a reversible mask. A Hosted badge is distinct
from managed, manual, and Fake and does not claim local Runtime availability.

The setup state machine renders `unconfigured`, `testing`, `ready`, `degraded`,
`revoked`, and `disabled` without converting provider reachability into Central
health. Configuration and credential mutations remain revision-fenced and
surface stale-state recovery. The explicit Server `configurationLocked` and
`hasActiveWork` projection includes queued as well as executing work; Web does
not infer this fence from Presence. Agent snapshot changes refresh the lock
without discarding an unsaved model draft.
Hosted Runs reuse normal Run cards, streaming output, terminal replies,
handoffs, and Discussion progress. The first version renders no Hosted Result
proposal, review, Task-completion, or ambiguity-acknowledgement control.

Each Agent card presents the Server-owned `runtimePolicy.filesystemAccess`
projection without interpreting missing data. `read-only` means the managed
Runtime cannot write to its Workspace; `workspace-write` means it can write
within local Workspace limits; `local-policy` means the concrete rule remains
on the Device. A missing projection is labeled **not reported**, rather than
being guessed from presence, role, Runtime name, or integration mode. The badge
title explains these semantics in the selected locale while keeping local
configuration out of the browser payload and DOM.

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
- Agent provisioning selectors show only active Devices whose current Bridge
  connection advertises provisioning support and online managed templates owned
  by the current Member. This is presentation filtering, not authority: the
  Server and Bridge independently revalidate every identity and capability.
- Keep a management code only in the controlled input until one submission
  settles. Clear it after success, rejection, or transport failure; never put
  it in request history, browser storage, URLs, logs, or status projection.
- Keep a Hosted provider key only in its controlled write-only input until one
  submission settles. Clear it on every outcome; never copy it into query
  state, local/session storage, URLs, errors, analytics, DOM status text, or a
  retry object.
- Show Hosted setup/mutation actions only to Team Owners and exact configured
  profile state only inside its Team. Browser filtering never replaces Server
  authorization, fixed provider-origin validation, or Room scope checks.
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

`WEB-044` adds same-owner creation from an online managed Agent template. The
form sends only request, Device, template, new-Agent name/role, and transient
management-code fields. Pending, ambiguously delivered, and
`configuration_failed` requests are reselected with the same request ID after a
new code is entered; other rejected requests receive a new identity. Focused component
coverage exercises both 6- and 8-digit inputs, ownership filtering, all request
states, every closed rejection reason, retry identity, and code clearing. The
full-App browser-DOM flow proves the same behavior through the production page
coordinator. Exact evidence and the live-browser limitation are recorded in
[the local acceptance](../acceptance/web-044-agent-provisioning.md).

`WEB-050` adds the ADR-0026 Hosted setup and lifecycle surface. Focused
component tests cover Owner/non-Owner visibility, unconfigured startup,
provider/model validation, fixed connection-test projection, explicit Room
selection, create, stale revision, key clearing, replacement, revocation,
disable/re-enable, active-work fences, ready/busy/degraded rendering, and the
absence of local-computer and formal-Result controls. Production browser
acceptance covers Chinese/English, light/dark, keyboard operation, zero console
secret/error leakage, and zero horizontal overflow at desktop, 720 px, and
390 px widths.

`WEB-045` adds the Owner-guided Device pairing panel. Focused component
coverage proves locally encoded QR/link and manual short-code presentation,
closed safe Device projection, explicit phrase confirmation, every Owner
decision, same-proof create recovery across remount, same-operation decision
recovery, terminal proof clearing, and non-Owner absence. Exact evidence and
the boundary to installer and physical-host acceptance are recorded in
[the local acceptance](../acceptance/web-045-device-pairing.md).

`WEB-048` closes the public-versus-private-scoped projection described above.
Focused component coverage proves public omission, exact descriptor
preservation, fragment-only placement, terminal clearing, scoped-capability and
private-short-code fencing, non-Owner absence, local QR generation, and bounded
copy without credentials, private keys, local paths or browser-verification
bypass instructions. Server regressions separately prove phrase binding and
legacy-client rejection.

`WEB-021` replaces first-page polling with a newest-100 snapshot, resumable
cursor deltas, duplicate suppression, and a 500-message browser history bound.
Refresh is single-flight and only merges messages, so a slow response cannot
overwrite a newer Room projection. `WEB-022` reads the existing authorized
Run-event API once for each terminal failure and renders only the error code,
retryable flag, allowlisted category, exit code, and localized recovery
guidance. `WEB-042` adds code-owned guidance for `CODEX_SESSION_IN_USE` and
`CODEX_SESSION_RESUME_FAILED`: it tells the owner to release other local Codex
clients and retry while confirming that the original binding was preserved and
no replacement Thread was created. Raw Runtime stderr, paths, messages, and
unknown detail keys never enter the view model.

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

Team/Room, Task Collaboration, Registry, Run Orchestration, Runtime Adapters,
Bridge pairing APIs, and Security.
