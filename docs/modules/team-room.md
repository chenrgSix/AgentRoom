# Team and Room Module

- Prefix: `ROOM`
- Planned location: `apps/server/`
- Owns: Team, Room, Message, membership-scoped Room history

## Purpose

This module is the central collaboration model and the only authority for Team
and Room conversation history. Every human or Agent contribution becomes a
persisted Message before routing or realtime broadcast.

## Responsibilities

- Create and read Teams and Rooms.
- Resolve authenticated users to Team Members.
- Persist and replace each Room's human and Agent participant roster.
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

## Core State

| Entity | Required State |
| --- | --- |
| Team | teamId, name, createdAt, archivedAt |
| Room | roomId, teamId, name, policy, createdAt, archivedAt |
| Room human participant | roomId, memberId, addedAt |
| Room Agent participant | roomId, agentId, addedAt |
| Member | referenced by Registry and Security |
| Message | messageId, roomId, senderRef, content, mentions, parentId, createdAt |
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

## Message Write Flow

1. Authenticate the actor and authorize Room membership.
2. Validate content size and structured Mention IDs.
3. Verify every Agent Mention is visible to the actor in the Room.
4. Persist Message and Mentions in one transaction.
5. Commit before emitting `message.created`.
6. Let Run Orchestration consume the committed event.

Display labels never participate in routing. A quoted or plain-text
`@Bob/Backend` without a structured Mention does not create a Run.

## History and Ordering

- The database assigns a monotonic Room sequence at commit.
- Pagination uses an opaque cursor derived from Room ID and sequence.
- Equal client timestamps do not affect ordering.
- Realtime clients deduplicate by Message ID and reconcile from HTTP history
  after reconnect.

## Failure and Security

- A message either commits with all Mention references or not at all.
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
- Plain-text mentions never trigger work.
- Realtime reconnect converges to persisted history.

## Task Mapping

`ROOM-001` through `ROOM-004`, with Web delivery in `WEB-002`, `WEB-003`,
and `WEB-025`.

## Dependencies

Contracts, Persistence, Security, and Registry Agent lookup.
