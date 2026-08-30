# Team and Room Module

- Prefix: `ROOM`
- Planned location: `apps/server/`
- Owns: Team, Room, Message, membership-scoped Room history

## Purpose

This module is the central collaboration model and the only authority for Team
and Room conversation history. Every human or Agent contribution becomes a
persisted Message before routing or realtime broadcast.

Persistence is split by aggregate: `team-room-repository.ts` owns Team, Member,
Room, settings, and participants; `message-repository.ts` owns Message sequence,
Task binding, Mention validation, and history queries. Existing services consume
the stable `CoreRepository` facade, whose delegates share one explicit SQLite
transaction boundary with Agent/Device persistence.

## Responsibilities

- Create and read Teams and Rooms.
- Resolve authenticated users to Team Members.
- Persist and replace each Room's human and Agent participant roster.
- Persist each Room's Agent collaboration policy.
- Persist Room Messages and structured Mention references.
- Provide cursor-based history pagination.
- Broadcast committed Room changes to authorized Web clients.
- Expose read/write services to Run Orchestration and MCP.

## Exclusions

- Device, Agent, and Presence lifecycle belongs to Registry.
- Mention delivery and Agent execution belong to Run Orchestration.
- Browser presentation belongs to Web UI.
- Runtime context construction beyond selecting Room messages belongs to the
  caller, subject to Room access policy.
- Long-lived Task identity, summaries, and result evidence belong to Task
  Collaboration; Room history remains their authoritative source.

## Core State

| Entity | Required State |
| --- | --- |
| Team | teamId, name, createdAt, archivedAt |
| Room | roomId, teamId, name, collaborationPolicy, createdAt, archivedAt |
| Room human participant | roomId, memberId, addedAt |
| Room Agent participant | roomId, agentId, addedAt |
| Member | referenced by Registry and Security |
| Message | messageId, roomId, taskId, senderRef, content, mentions, parentId, createdAt |
| Mention | type, targetId, displayLabel |

Message content is immutable in MVP. Deletion, editing, reactions, attachments,
and full-text search are deferred.

Team and Room lifecycle is recoverable. Owners may rename or archive and
restore them, but the Server never physically deletes their Messages, Runs,
Discussions, membership, or stable IDs. Archived resources are excluded from
ordinary navigation and reject new work. Explicit lifecycle views may request
them for restoration. Archiving is fenced while active Runs or Discussions
could otherwise continue producing new history.

The Web API uses `PATCH /api/teams/:teamId` and `PATCH /api/rooms/:roomId`
for lifecycle updates. Ordinary list reads exclude archived records;
`includeArchived=true` is reserved for explicit recovery surfaces.

Room participation is explicit. Existing Rooms are migrated with every current
Team Member and enabled Agent, and newly created Rooms inherit the same current
Team roster. Newly registered Members and Agents are assigned to existing Rooms
once by default; a later Owner removal is authoritative and is not reversed by
ordinary reads or Agent republication. Every Team Owner must remain a human
participant so a Room cannot become unmanageable. Roster removal affects new
access and routing while preserving Messages, Runs, and Discussion history.

Each Room owns one Server-enforced collaboration policy with four settings:
`allowDiscussion`, `allowAll`, `allowAgentMentions`, and
`maxAgentMentionDepth`. Existing and new Rooms default to all three capabilities
enabled with depth 4. The Owner-only
`PUT /api/rooms/:roomId/settings` operation replaces the policy and participant
roster atomically, so the browser never observes a policy for a different Agent
roster. Every settings response carries `settingsRevision`; writes must echo the
revision they edited and receive `409 CONFLICT` after another participant or
policy update. Team-change reconciliation and the settings dialog read the
combined settings resource, so one client cannot silently overwrite another
client's newer roster or policy. Depth is always persisted in the range 1
through 4, including while Agent handoffs are disabled, so re-enabling the
capability restores the chosen bound.

## Historical Message Reads

`GET /api/rooms/:roomId/messages` retains its forward `cursor` and `tail=true`
semantics. An additive `beforeCursor` returns up to 100 earlier Messages in
ascending sequence order, excluding the cursor boundary. Tail and backward
pages expose `olderCursor` only when earlier rows remain. The cursor is opaque,
Room-bound and mutually exclusive with forward/tail modes. Current Room
membership is checked on every page. A historical page never changes the Web's
separate live `syncCursor`; the browser merges immutable IDs and preserves the
reader's scroll anchor.

## Message Write Flow

1. Authenticate the actor and authorize Room membership.
2. Validate content size, the maximum five structured Mention IDs, and the
   Room's `@all` policy when the exact reserved command is present.
3. Resolve an explicit Task or the Room's default Task and reject cross-Room or
   terminal Task routing.
4. Verify every Agent Mention is visible to the actor in the Room.
5. For a browser Member write, persist the Message, Task identity, Mentions and
   complete mentioned-Run batch in one immediate transaction.
6. Commit before dispatching managed Delivery or emitting `message.created`.
7. A retry returns the same Message and Runs; it may also finish the missing Run
   batch for a historical pre-`RUN-014` Message inside the same transaction.

Browser member writes include a stable `clientMessageId`. Migration 0018
enforces uniqueness per Room and sender, so an ambiguous retry returns the
original Message and existing Runs without creating another sequence or
re-executing completed work.

Display labels in a Member Message never participate in Server target
selection. The Web may resolve an exact current-Room `@Agent name` or reserved
`@all` command before submission, but it sends stable structured Mention IDs.
A quoted or plain-text `@Bob/Backend` received from a Member without a
structured Mention does not create a Run. After an ordinary Run reply is
persisted, Run Orchestration may separately parse exact full Agent names from
that Agent-authored content for a policy-bounded handoff; this never changes
the persisted Message write contract. Exact-name parsing chooses the longest
known Agent name at each `@` position before applying Room eligibility, so a
spaced name cannot also trigger its shorter prefix.

Each accepted reply creates the redacted `run_events` row, one Agent-authored
Room Message, an exact `(runId, replySequence) → messageId` projection and the
existing routing intent in one transaction. Handoff resolution reads only that
persisted safe content. Child Run creation and managed Delivery establishment
are idempotent; the intent is completed afterward and pending intents are
replayed at startup. This closes the reply-before-Message cut as well as the
cuts before routing and between sibling child Runs without reintroducing
unredacted Bridge content.

## History and Ordering

- The database assigns a monotonic Room sequence at commit.
- Pagination uses an opaque cursor derived from Room ID and sequence.
- Equal client timestamps do not affect ordering.
- Realtime clients deduplicate by Message ID and reconcile from HTTP history
  after reconnect.

## Failure and Security

- A message either commits with all Mention references or not at all.
- A mentioned browser Message either commits with its complete Run batch or not
  at all; no managed execution begins before commit.
- A reply event either commits with its exact Room Message projection or not at
  all. Historical ambiguity is persisted as an unreconciled failure and never
  resolved by timestamp/content guesswork.
- Unauthorized Room existence is not disclosed through distinct errors.
- Content is size-limited and treated as untrusted before rendering or prompt
  construction.
- Redaction occurs before persistence when Security policy identifies a secret.

## Verification

- Concurrent writes have stable order and no duplicate sequence.
- Restart preserves pagination and parent-message references.
- Cross-Team access and forged Agent IDs are rejected.
- Unassigned humans cannot discover or use a Room, and unassigned Agents cannot
  be mentioned, selected for a Discussion, or targeted by a handoff.
- Non-Owners cannot replace Room settings, and rejected settings never partly
  change the participant roster.
- Disabled Discussions, disabled `@all`, disabled Agent handoffs, and the
  configured handoff depth are enforced on the Server rather than trusted to
  browser presentation.
- Member plain-text mentions never trigger work.
- Realtime reconnect converges to persisted history.

## Task Mapping

`ROOM-001` through `ROOM-007`, with Web delivery in `WEB-002`, `WEB-003`,
`WEB-025`, and the Room settings surface completed with `ROOM-007`.

## Dependencies

Contracts, Persistence, Security, and Registry Agent lookup.
